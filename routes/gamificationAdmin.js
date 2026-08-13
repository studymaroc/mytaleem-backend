const express = require("express");
const adminAuth = require("../middlewares/adminAuth");
const GamificationConfig = require("../models/gamificationConfig");
const {
  loadGamificationConfig,
  invalidateGamificationConfig,
  defaultBadgeDefinitions,
  defaultMissionDefinitions,
} = require("../utils/gamification");

const gamificationAdminRouter = express.Router();

/// أنواع المهام المسموح بيها — كل نوع مربوط بحدث التطبيق بيرصده فعلاً.
const ALLOWED_MISSION_KEYS = [
  "check_in",
  "lesson_completed",
  "exam_solved",
  "ai_used",
  "comment_posted",
  "video_watched",
];

const MISSION_KEY_LABELS = {
  check_in: "فتح التطبيق",
  lesson_completed: "إكمال درس",
  exam_solved: "حل امتحان",
  ai_used: "استخدام الذكاء الاصطناعي",
  comment_posted: "نشر تعليق",
  video_watched: "مشاهدة فيديو",
};

function clampInt(value, min, max, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function getTrimmed(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizeBadge(raw, index) {
  const key = getTrimmed(raw.key, 60)
    .replace(/\s+/g, "_")
    .toLowerCase();
  if (!key) return null;

  const title = getTrimmed(raw.title, 120);
  if (!title) return null;

  const requirements = raw.requirements || {};

  return {
    key,
    title,
    description: getTrimmed(raw.description, 400),
    icon: getTrimmed(raw.icon, 60) || "star",
    colorHex: getTrimmed(raw.colorHex, 12) || "#4F46E5",
    order: clampInt(raw.order, 0, 999, index + 1),
    isActive: raw.isActive !== false,
    requirements: {
      activeDays: clampInt(requirements.activeDays, 0, 10000, 0),
      completedLessons: clampInt(requirements.completedLessons, 0, 10000, 0),
      solvedExams: clampInt(requirements.solvedExams, 0, 10000, 0),
      aiUsed: clampInt(requirements.aiUsed, 0, 10000, 0),
      comments: clampInt(requirements.comments, 0, 10000, 0),
      streak: clampInt(requirements.streak, 0, 10000, 0),
    },
  };
}

function normalizeMission(raw, index) {
  const key = getTrimmed(raw.key, 40);
  if (!ALLOWED_MISSION_KEYS.includes(key)) return null;

  const title = getTrimmed(raw.title, 120);
  if (!title) return null;

  return {
    key,
    title,
    xp: clampInt(raw.xp, 0, 500, 10),
    order: clampInt(raw.order, 0, 999, index + 1),
    isActive: raw.isActive !== false,
  };
}

/** الإعدادات الحالية + أنواع المهام المتاحة (للوحة الإدارة). */
gamificationAdminRouter.get(
  "/api/admin/gamification/config",
  adminAuth,
  async (req, res) => {
    try {
      const config = await loadGamificationConfig({ force: true });
      res.json({
        badges: config.badges,
        missions: config.missions,
        availableMissionKeys: ALLOWED_MISSION_KEYS.map((key) => ({
          key,
          label: MISSION_KEY_LABELS[key],
        })),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

/** حفظ الشارات (إضافة/تعديل/حذف — القائمة المرسلة بتحل محل القديمة). */
gamificationAdminRouter.post(
  "/api/admin/gamification/badges",
  adminAuth,
  async (req, res) => {
    try {
      const incoming = Array.isArray(req.body && req.body.badges)
        ? req.body.badges
        : null;
      if (!incoming) {
        return res.status(400).json({ error: "قائمة الشارات مطلوبة" });
      }
      if (incoming.length > 50) {
        return res.status(400).json({ error: "الحد الأقصى 50 شارة" });
      }

      const badges = incoming
        .map(normalizeBadge)
        .filter(Boolean);

      // منع تكرار المفتاح
      const seen = new Set();
      const unique = badges.filter((badge) => {
        if (seen.has(badge.key)) return false;
        seen.add(badge.key);
        return true;
      });

      const config = await loadGamificationConfig({ force: true });
      config.badges = unique;
      await config.save();
      invalidateGamificationConfig();

      res.json({ badges: config.badges });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

/** حفظ المهام اليومية. */
gamificationAdminRouter.post(
  "/api/admin/gamification/missions",
  adminAuth,
  async (req, res) => {
    try {
      const incoming = Array.isArray(req.body && req.body.missions)
        ? req.body.missions
        : null;
      if (!incoming) {
        return res.status(400).json({ error: "قائمة المهام مطلوبة" });
      }

      const missions = incoming.map(normalizeMission).filter(Boolean);

      const seen = new Set();
      const unique = missions.filter((mission) => {
        if (seen.has(mission.key)) return false;
        seen.add(mission.key);
        return true;
      });

      const config = await loadGamificationConfig({ force: true });
      config.missions = unique;
      await config.save();
      invalidateGamificationConfig();

      res.json({ missions: config.missions });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

/** استرجاع الإعدادات الافتراضية. */
gamificationAdminRouter.post(
  "/api/admin/gamification/reset",
  adminAuth,
  async (req, res) => {
    try {
      await GamificationConfig.deleteMany({});
      invalidateGamificationConfig();
      const config = await loadGamificationConfig({ force: true });
      res.json({ badges: config.badges, missions: config.missions });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

module.exports = gamificationAdminRouter;
module.exports.ALLOWED_MISSION_KEYS = ALLOWED_MISSION_KEYS;
module.exports.defaults = { defaultBadgeDefinitions, defaultMissionDefinitions };
