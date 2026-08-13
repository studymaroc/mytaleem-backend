const express = require("express");
const commentsRouter = express.Router();
const Comment = require("../models/comment");
const auth = require("../middlewares/auth");
const { withResolvedAvatar } = require("../utils/avatarCatalog");
const { getBadgeSummary, recordCommentPosted } = require("../utils/gamification");

commentsRouter.get("/api/comments/:examId", auth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const skip = (page - 1) * limit;

    const comments = await Comment.find({ examId: req.params.examId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("userId", "name profilePic avatarKey xp streakCount earnedBadges featuredBadgeKey")
      .lean();

    res.json(
      comments.map((comment) => ({
        ...comment,
        userId: {
          ...withResolvedAvatar(comment.userId),
          ...getBadgeSummary(comment.userId || {}),
        },
      }))
    );
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

commentsRouter.post("/api/comments", auth, async (req, res) => {
  try {
    const { examId, text } = req.body;

    if (!examId || typeof examId !== "string" || !text || typeof text !== "string") {
      return res.status(400).json({ error: "examId and text are required." });
    }

    let comment = new Comment({
      examId,
      userId: req.user,
      text: text.trim(),
    });
    comment = await comment.save();
    await recordCommentPosted(req.user, comment._id);

    // Populate for immediate return
    comment = await comment.populate(
      "userId",
      "name profilePic avatarKey xp streakCount earnedBadges featuredBadgeKey"
    );

    res.json({
      ...comment.toObject(),
      userId: {
        ...withResolvedAvatar(comment.userId),
        ...getBadgeSummary(comment.userId || {}),
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = commentsRouter;
