const User = require("../models/user");
const GamificationConfig = require("../models/gamificationConfig");

const XP = Object.freeze({
  checkIn: 5,
  lessonCompleted: 20,
  examSolved: 40,
  aiUsed: 10,
  commentPosted: 10,
  badgeUnlocked: 50,
});

const defaultBadgeDefinitions = Object.freeze([
  {
    key: "first_step",
    title: "بداية الرحلة",
    description: "افتح التطبيق وأكمل أول درس.",
    icon: "flag",
    colorHex: "#4F46E5",
    requirements: { activeDays: 1, completedLessons: 1 },
  },
  {
    key: "active_reader",
    title: "القارئ النشيط",
    description: "أكمل 5 دروس وحافظ على 3 أيام متتالية.",
    icon: "menu_book",
    colorHex: "#0891B2",
    requirements: { completedLessons: 5, streak: 3 },
  },
  {
    key: "persistent_student",
    title: "الطالب المثابر",
    description: "أكمل 10 دروس، حل امتحانين، وحافظ على 5 أيام متتالية.",
    icon: "local_fire_department",
    colorHex: "#EA580C",
    requirements: { completedLessons: 10, solvedExams: 2, streak: 5 },
  },
  {
    key: "exam_ready",
    title: "جاهز للامتحان",
    description: "أكمل 20 درسًا، حل 5 امتحانات، واستخدم الذكاء 5 مرات.",
    icon: "fact_check",
    colorHex: "#16A34A",
    requirements: { completedLessons: 20, solvedExams: 5, aiUsed: 5 },
  },
  {
    key: "study_legend",
    title: "أسطورة الدراسة",
    description: "أكمل 35 درسًا، حل 10 امتحانات، واصل 14 يومًا، وشارك 3 تعليقات.",
    icon: "workspace_premium",
    colorHex: "#C026D3",
    requirements: {
      completedLessons: 35,
      solvedExams: 10,
      streak: 14,
      comments: 3,
    },
  },
]);

// ---------------------------------------------------------------- الإعدادات

const defaultMissionDefinitions = Object.freeze([
  { key: "check_in", title: "افتح التطبيق اليوم", xp: XP.checkIn, order: 1, isActive: true },
  { key: "lesson_completed", title: "أكمل درسًا واحدًا", xp: XP.lessonCompleted, order: 2, isActive: true },
  { key: "exam_solved", title: "حل امتحانًا واحدًا", xp: XP.examSolved, order: 3, isActive: true },
  { key: "ai_used", title: "اسأل الذكاء الاصطناعي مرة", xp: XP.aiUsed, order: 4, isActive: true },
  { key: "comment_posted", title: "شارك تعليقًا مفيدًا", xp: XP.commentPosted, order: 5, isActive: true },
]);

// كاش في الذاكرة عشان مانضربش القاعدة مع كل طلب
let cachedConfig = null;

/** بيحمّل الإعدادات من القاعدة، وبيزرع الافتراضي أول مرة. */
async function loadGamificationConfig({ force = false } = {}) {
  if (cachedConfig && !force) return cachedConfig;

  let config = await GamificationConfig.findOne();
  if (!config) {
    config = await GamificationConfig.create({
      badges: defaultBadgeDefinitions.map((badge, index) => ({
        ...badge,
        order: index + 1,
        isActive: true,
      })),
      missions: defaultMissionDefinitions.map((m) => ({ ...m })),
      seeded: true,
    });
    console.log("Gamification config seeded with defaults");
  }

  cachedConfig = config;
  return config;
}

/** بيفضّي الكاش بعد أي تعديل من لوحة الإدارة. */
function invalidateGamificationConfig() {
  cachedConfig = null;
}

/** الشارات المفعّلة مرتبة — بترجع الافتراضي لو الإعدادات لسه ماتحمّلتش. */
function activeBadges() {
  if (!cachedConfig || !Array.isArray(cachedConfig.badges) || cachedConfig.badges.length === 0) {
    return defaultBadgeDefinitions;
  }
  return cachedConfig.badges
    .filter((badge) => badge.isActive !== false)
    .sort((a, b) => (a.order || 0) - (b.order || 0));
}

/** المهام المفعّلة مرتبة. */
function activeMissions() {
  if (!cachedConfig || !Array.isArray(cachedConfig.missions) || cachedConfig.missions.length === 0) {
    return defaultMissionDefinitions;
  }
  return cachedConfig.missions
    .filter((mission) => mission.isActive !== false)
    .sort((a, b) => (a.order || 0) - (b.order || 0));
}

function todayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function addDays(dateKey, amount) {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return todayKey(date);
}

function eventKey(type, target = "") {
  return target ? `${type}:${target}` : type;
}

function dailyEventKey(type, dateKey, target = "") {
  return target ? `${type}_daily:${dateKey}:${target}` : `${type}:${dateKey}`;
}

function userMetric(user, key) {
  switch (key) {
    case "activeDays":
      return (user.activeDates || []).length;
    case "completedLessons":
      return user.completedLessonsCount || (user.completedLessons || []).length || 0;
    case "solvedExams":
      return user.solvedExamsCount || (user.solvedExams || []).length || 0;
    case "streak":
      return user.streakCount || 0;
    case "aiUsed":
      return user.aiUsageCount || 0;
    case "comments":
      return user.commentsCount || 0;
    default:
      return 0;
  }
}

function buildBadgeProgress(user) {
  const earned = new Set(user.earnedBadges || []);
  return activeBadges().map((badge) => {
    const requirements = Object.entries(badge.requirements).map(([key, target]) => {
      const value = userMetric(user, key);
      return {
        key,
        target,
        value,
        completed: value >= target,
      };
    });
    const completedRequirements = requirements.filter((item) => item.completed).length;
    const totalRequirements = requirements.length;
    return {
      ...badge,
      unlocked: earned.has(badge.key),
      progress: totalRequirements === 0 ? 1 : completedRequirements / totalRequirements,
      requirements,
    };
  });
}

function getFeaturedBadgeKey(user) {
  const earned = new Set(user.earnedBadges || []);
  const badges = activeBadges();
  for (let index = badges.length - 1; index >= 0; index -= 1) {
    if (earned.has(badges[index].key)) {
      return badges[index].key;
    }
  }
  return "";
}

function getBadgeSummary(user = {}) {
  const featuredBadgeKey = user.featuredBadgeKey || getFeaturedBadgeKey(user);
  const featuredBadge = activeBadges().find((badge) => badge.key === featuredBadgeKey) || null;
  return {
    xp: user.xp || 0,
    streakCount: user.streakCount || 0,
    earnedBadges: user.earnedBadges || [],
    featuredBadgeKey,
    featuredBadge,
  };
}

function getMissionState(user, dateKey = todayKey()) {
  const events = user.gamificationEvents || [];
  const hasDailyPrefix = (prefix) =>
    events.some((key) => key.startsWith(`${prefix}_daily:${dateKey}:`));

  // المهام دي بتتحسب من حدث "مرة واحدة في اليوم"، والباقي من أحداث مرتبطة بعنصر
  const singleShotKeys = new Set(["check_in", "ai_used"]);

  return activeMissions().map((mission) => ({
    key: mission.key,
    title: mission.title,
    xp: mission.xp,
    completed: singleShotKeys.has(mission.key)
      ? events.includes(dailyEventKey(mission.key, dateKey))
      : hasDailyPrefix(mission.key),
  }));
}

function syncCounters(user) {
  user.activeDates = Array.isArray(user.activeDates) ? user.activeDates : [];
  user.completedLessons = Array.isArray(user.completedLessons) ? user.completedLessons : [];
  user.solvedExams = Array.isArray(user.solvedExams) ? user.solvedExams : [];
  user.earnedBadges = Array.isArray(user.earnedBadges) ? user.earnedBadges : [];
  user.gamificationEvents = Array.isArray(user.gamificationEvents)
    ? user.gamificationEvents
    : [];
  user.completedLessonsCount = (user.completedLessons || []).length;
  user.solvedExamsCount = (user.solvedExams || []).length;
  user.aiUsageCount = user.aiUsageCount || 0;
  user.commentsCount = user.commentsCount || 0;
  user.xp = user.xp || 0;
  user.streakCount = user.streakCount || 0;
  user.longestStreak = Math.max(user.longestStreak || 0, user.streakCount || 0);
}

function recalculateBadges(user) {
  syncCounters(user);
  const currentEarned = new Set(user.earnedBadges || []);
  const nextEarned = [];
  let newlyUnlocked = 0;

  for (const badge of activeBadges()) {
    const isUnlocked = Object.entries(badge.requirements).every(
      ([key, target]) => userMetric(user, key) >= target
    );
    if (!isUnlocked) break;
    nextEarned.push(badge.key);
    if (!currentEarned.has(badge.key)) {
      newlyUnlocked += 1;
    }
  }

  if (newlyUnlocked > 0) {
    user.xp = (user.xp || 0) + newlyUnlocked * XP.badgeUnlocked;
  }
  user.earnedBadges = nextEarned;
  user.featuredBadgeKey = getFeaturedBadgeKey(user);
}

function addEvent(user, key, xp) {
  if (!Array.isArray(user.gamificationEvents)) user.gamificationEvents = [];
  if (user.gamificationEvents.includes(key)) {
    return false;
  }
  user.gamificationEvents.push(key);
  user.xp = (user.xp || 0) + xp;
  return true;
}

async function applyCheckIn(userId, dateKey = todayKey()) {
  const user = await User.findById(userId);
  if (!user) return null;
  syncCounters(user);

  const wasNewDay = addEvent(user, dailyEventKey("check_in", dateKey), XP.checkIn);
  if (wasNewDay) {
    if (!user.activeDates.includes(dateKey)) {
      user.activeDates.push(dateKey);
    }

    if (user.lastActiveDate === addDays(dateKey, -1)) {
      user.streakCount = (user.streakCount || 0) + 1;
    } else if (user.lastActiveDate !== dateKey) {
      user.streakCount = 1;
    }

    user.longestStreak = Math.max(user.longestStreak || 0, user.streakCount || 0);
    user.lastActiveDate = dateKey;
  }

  recalculateBadges(user);
  await user.save();
  return getJourneyPayload(user, dateKey);
}

async function recordLessonCompleted(userId, lessonId, dateKey = todayKey()) {
  const cleanLessonId = String(lessonId || "").trim();
  if (!cleanLessonId) return null;

  const user = await User.findById(userId);
  if (!user) return null;
  syncCounters(user);

  const alreadyCompleted = (user.completedLessons || []).includes(cleanLessonId);
  if (!alreadyCompleted) {
    user.completedLessons.push(cleanLessonId);
    addEvent(user, eventKey("lesson_completed", cleanLessonId), XP.lessonCompleted);
  }
  if (!user.gamificationEvents.includes(dailyEventKey("lesson_completed", dateKey, cleanLessonId))) {
    user.gamificationEvents.push(dailyEventKey("lesson_completed", dateKey, cleanLessonId));
  }

  recalculateBadges(user);
  await user.save();
  return getJourneyPayload(user, dateKey);
}

async function recordExamSolved(userId, examId, dateKey = todayKey()) {
  const cleanExamId = String(examId || "").trim();
  if (!cleanExamId) return null;

  const user = await User.findById(userId);
  if (!user) return null;
  syncCounters(user);

  const alreadySolved = (user.solvedExams || []).map(String).includes(cleanExamId);
  if (!alreadySolved) {
    user.solvedExams.push(cleanExamId);
    addEvent(user, eventKey("exam_solved", cleanExamId), XP.examSolved);
  }
  if (!user.gamificationEvents.includes(dailyEventKey("exam_solved", dateKey, cleanExamId))) {
    user.gamificationEvents.push(dailyEventKey("exam_solved", dateKey, cleanExamId));
  }

  recalculateBadges(user);
  await user.save();
  return getJourneyPayload(user, dateKey);
}

async function recordAiUsed(userId, dateKey = todayKey()) {
  const user = await User.findById(userId);
  if (!user) return null;
  syncCounters(user);

  if (addEvent(user, dailyEventKey("ai_used", dateKey), XP.aiUsed)) {
    user.aiUsageCount = (user.aiUsageCount || 0) + 1;
  }

  recalculateBadges(user);
  await user.save();
  return getJourneyPayload(user, dateKey);
}

async function recordCommentPosted(userId, commentId, dateKey = todayKey()) {
  const cleanCommentId = String(commentId || "").trim();
  if (!cleanCommentId) return null;

  const user = await User.findById(userId);
  if (!user) return null;
  syncCounters(user);

  if (addEvent(user, eventKey("comment_posted", cleanCommentId), XP.commentPosted)) {
    user.commentsCount = (user.commentsCount || 0) + 1;
  }
  if (!user.gamificationEvents.includes(dailyEventKey("comment_posted", dateKey, cleanCommentId))) {
    user.gamificationEvents.push(dailyEventKey("comment_posted", dateKey, cleanCommentId));
  }

  recalculateBadges(user);
  await user.save();
  return getJourneyPayload(user, dateKey);
}

function getJourneyPayload(user, dateKey = todayKey()) {
  recalculateBadges(user);
  const badges = buildBadgeProgress(user);
  const nextBadge = badges.find((badge) => !badge.unlocked) || null;
  return {
    xp: user.xp || 0,
    streakCount: user.streakCount || 0,
    longestStreak: user.longestStreak || 0,
    lastActiveDate: user.lastActiveDate || "",
    activeDates: user.activeDates || [],
    completedLessons: user.completedLessons || [],
    completedLessonsCount: user.completedLessonsCount || 0,
    solvedExams: user.solvedExams || [],
    solvedExamsCount: user.solvedExamsCount || 0,
    aiUsageCount: user.aiUsageCount || 0,
    commentsCount: user.commentsCount || 0,
    earnedBadges: user.earnedBadges || [],
    featuredBadgeKey: user.featuredBadgeKey || "",
    featuredBadge:
      activeBadges().find((badge) => badge.key === user.featuredBadgeKey) || null,
    badges,
    nextBadge,
    dailyMissions: getMissionState(user, dateKey),
  };
}

module.exports = {
  XP,
  badgeDefinitions: defaultBadgeDefinitions,
  defaultBadgeDefinitions,
  defaultMissionDefinitions,
  loadGamificationConfig,
  invalidateGamificationConfig,
  activeBadges,
  activeMissions,
  todayKey,
  getBadgeSummary,
  getJourneyPayload,
  applyCheckIn,
  recordLessonCompleted,
  recordExamSolved,
  recordAiUsed,
  recordCommentPosted,
};
