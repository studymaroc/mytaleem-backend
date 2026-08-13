const express = require("express");
const gamificationRouter = express.Router();
const User = require("../models/user");
const auth = require("../middlewares/auth");
const { withResolvedAvatar } = require("../utils/avatarCatalog");
const {
  badgeDefinitions,
  getBadgeSummary,
  getJourneyPayload,
  applyCheckIn,
  recordLessonCompleted,
  recordAiUsed,
} = require("../utils/gamification");

gamificationRouter.post("/api/user/complete-lesson", auth, async (req, res) => {
  try {
    const { lessonId } = req.body;

    if (!lessonId || typeof lessonId !== "string") {
      return res.status(400).json({ msg: "lessonId is required." });
    }

    const journey = await recordLessonCompleted(req.user, lessonId);
    if (!journey) {
      return res.status(404).json({ msg: "User not found!" });
    }

    res.json(journey);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

gamificationRouter.post("/api/gamification/check-in", auth, async (req, res) => {
  try {
    const journey = await applyCheckIn(req.user);
    if (!journey) {
      return res.status(404).json({ msg: "User not found!" });
    }
    res.json(journey);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

gamificationRouter.get("/api/gamification/journey", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user);
    if (!user) {
      return res.status(404).json({ msg: "User not found!" });
    }
    const payload = getJourneyPayload(user);
    await user.save();
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

gamificationRouter.get("/api/gamification/badges", auth, async (req, res) => {
  res.json({ badges: badgeDefinitions });
});

gamificationRouter.post("/api/gamification/events", auth, async (req, res) => {
  try {
    const { type, targetId } = req.body;
    let journey = null;

    if (type === "lesson_completed") {
      if (!targetId || typeof targetId !== "string") {
        return res.status(400).json({ msg: "targetId is required." });
      }
      journey = await recordLessonCompleted(req.user, targetId);
    } else if (type === "ai_used") {
      journey = await recordAiUsed(req.user);
    } else {
      return res.status(400).json({ msg: "Unsupported gamification event." });
    }

    if (!journey) {
      return res.status(404).json({ msg: "User not found!" });
    }

    res.json(journey);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

gamificationRouter.get("/api/leaderboard", auth, async (req, res) => {
  try {
    const topUsers = await User.find(
      {},
      "name profilePic avatarKey completedLessonsCount solvedExamsCount xp streakCount earnedBadges featuredBadgeKey"
    )
      .sort({ xp: -1, solvedExamsCount: -1, completedLessonsCount: -1, _id: 1 })
      .limit(20)
      .lean();

    const payload = topUsers.map((user) => ({
      ...withResolvedAvatar(user),
      ...getBadgeSummary(user),
      solvedExamsCount: user.solvedExamsCount || 0,
      totalProgressCount: (user.completedLessonsCount || 0) + (user.solvedExamsCount || 0),
    }));

    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = gamificationRouter;
