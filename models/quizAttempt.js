const mongoose = require("mongoose");

// Lightweight per-attempt summary. The full quiz body lives only on the
// client (sqflite). We store enough to power per-user history and analytics
// without keeping the AI-generated questions on the server.
const quizAttemptSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    quizTitle: {
      type: String,
      default: "اختبار",
      trim: true,
      maxlength: 200,
    },
    questionCount: {
      type: Number,
      required: true,
      min: 1,
      max: 50,
    },
    types: {
      type: [String],
      enum: ["tf", "mcq", "open"],
      default: [],
    },
    autoCorrect: { type: Number, default: 0, min: 0 },
    autoTotal: { type: Number, default: 0, min: 0 },
    selfCorrect: { type: Number, default: 0, min: 0 },
    selfTotal: { type: Number, default: 0, min: 0 },
    totalScorePercent: { type: Number, default: 0, min: 0, max: 100 },
    durationSec: { type: Number, default: 0, min: 0 },
    hasContext: { type: Boolean, default: false },
    contextSummary: { type: String, default: "", trim: true, maxlength: 240 },
    // نطاق الاختبار لما يكون على مادة كاملة (مش على ملف مفتوح)
    subject: { type: String, default: "", trim: true, maxlength: 120, index: true },
    year: { type: String, default: "", trim: true, maxlength: 120 },
    speciality: { type: String, default: "", trim: true, maxlength: 160 },
  },
  { timestamps: true }
);

quizAttemptSchema.index({ userId: 1, createdAt: -1 });

const QuizAttempt = mongoose.model("QuizAttempt", quizAttemptSchema);
module.exports = QuizAttempt;
