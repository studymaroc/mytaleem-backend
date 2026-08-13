const express = require("express");
const QuizAttempt = require("../models/quizAttempt");
const auth = require("../middlewares/auth");

const quizRouter = express.Router();

const ALLOWED_TYPES = new Set(["tf", "mcq", "open"]);

function clampInt(value, min, max, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function sanitizeAttemptPayload(body = {}) {
  const questionCount = clampInt(body.questionCount, 1, 50, 0);
  if (questionCount === 0) {
    return { error: "عدد الأسئلة مطلوب." };
  }

  const typesInput = Array.isArray(body.types) ? body.types : [];
  const types = [
    ...new Set(
      typesInput
        .map((t) => String(t || "").trim().toLowerCase())
        .filter((t) => ALLOWED_TYPES.has(t))
    ),
  ];

  const autoCorrect = clampInt(body.autoCorrect, 0, questionCount, 0);
  const autoTotal = clampInt(body.autoTotal, 0, questionCount, 0);
  const selfCorrect = clampInt(body.selfCorrect, 0, questionCount, 0);
  const selfTotal = clampInt(body.selfTotal, 0, questionCount, 0);

  const totalAnswered = autoTotal + selfTotal;
  const totalCorrect = autoCorrect + selfCorrect;
  let totalScorePercent = 0;
  if (totalAnswered > 0) {
    totalScorePercent = Math.round((totalCorrect / totalAnswered) * 100);
  }

  const durationSec = clampInt(body.durationSec, 0, 60 * 60 * 6, 0);
  const hasContext = body.hasContext === true || body.hasContext === "true";
  const contextSummary = String(body.contextSummary || "").trim().slice(0, 240);
  const quizTitle = String(body.quizTitle || "اختبار").trim().slice(0, 200) || "اختبار";

  const subject = String(body.subject || "").trim().slice(0, 120);
  const year = String(body.year || "").trim().slice(0, 120);
  const speciality = String(body.speciality || "").trim().slice(0, 160);

  return {
    value: {
      quizTitle,
      subject,
      year,
      speciality,
      questionCount,
      types,
      autoCorrect,
      autoTotal,
      selfCorrect,
      selfTotal,
      totalScorePercent,
      durationSec,
      hasContext,
      contextSummary,
    },
  };
}

quizRouter.post("/api/quiz/attempts", auth, async (req, res) => {
  try {
    const sanitized = sanitizeAttemptPayload(req.body || {});
    if (sanitized.error) {
      return res.status(400).json({ error: sanitized.error });
    }

    const attempt = await QuizAttempt.create({
      ...sanitized.value,
      userId: req.user,
    });

    res.json({ attempt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

quizRouter.get("/api/quiz/attempts", auth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      QuizAttempt.find({ userId: req.user })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      QuizAttempt.countDocuments({ userId: req.user }),
    ]);

    res.json({ items, page, limit, total });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = quizRouter;
