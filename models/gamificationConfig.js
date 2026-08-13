const mongoose = require("mongoose");

/**
 * إعدادات رحلة الإنجاز القابلة للتحكم من لوحة الإدارة.
 *
 * سجل واحد بس في المجموعة (singleton). لو مش موجود، بيتعمل تلقائياً
 * من التعريفات الافتراضية الموجودة في utils/gamification.js.
 *
 * ملاحظة مهمة عن المهام:
 * نوع المهمة (key) مربوط بحدث حقيقي التطبيق بيرصده، فمينفعش يتخلق نوع
 * جديد من لوحة الإدارة. المتاح: تشغيل/إيقاف، تغيير العنوان، النقاط، الترتيب.
 * أما الشارات فقابلة للإضافة والحذف بالكامل لأن شروطها مبنية على عدادات موجودة.
 */

const badgeSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, default: "", trim: true, maxlength: 400 },
    icon: { type: String, default: "star", trim: true },
    colorHex: { type: String, default: "#4F46E5", trim: true },
    order: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    requirements: {
      activeDays: { type: Number, default: 0, min: 0 },
      completedLessons: { type: Number, default: 0, min: 0 },
      solvedExams: { type: Number, default: 0, min: 0 },
      aiUsed: { type: Number, default: 0, min: 0 },
      comments: { type: Number, default: 0, min: 0 },
      streak: { type: Number, default: 0, min: 0 },
    },
  },
  { _id: false }
);

const missionSchema = new mongoose.Schema(
  {
    // النوع مربوط بحدث في التطبيق — متغيّرهوش
    key: {
      type: String,
      required: true,
      enum: [
        "check_in",
        "lesson_completed",
        "exam_solved",
        "ai_used",
        "comment_posted",
        "video_watched",
      ],
    },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    xp: { type: Number, default: 10, min: 0, max: 500 },
    order: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { _id: false }
);

const gamificationConfigSchema = new mongoose.Schema(
  {
    badges: { type: [badgeSchema], default: [] },
    missions: { type: [missionSchema], default: [] },
    seeded: { type: Boolean, default: false },
  },
  { timestamps: true }
);

const GamificationConfig = mongoose.model(
  "GamificationConfig",
  gamificationConfigSchema
);

module.exports = GamificationConfig;
