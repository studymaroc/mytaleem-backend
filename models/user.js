const mongoose = require("mongoose");
const { avatarKeys, ensureUserAvatarKey } = require("../utils/avatarCatalog");

const userSchema = mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  email: {
    type: String,
    required: true,
    trim: true,
    validate: {
      validator: (value) => {
        const re =
          /^(([^<>()[\]\.,;:\s@\"]+(\.[^<>()[\]\.,;:\s@\"]+)*)|(\".+\"))@(([^<>()[\]\.,;:\s@\"]+\.)+[^<>()[\]\.,;:\s@\"]{2,})$/i;
        return value.match(re);
      },
      message: "Please enter a valid email address",
    },
  },
  password: {
    type: String,
    required: true,
    trim: true,
    validate: {
      validator: (value) => {
        return value.length > 6;
      },
      message: "password must be more then 6 chars",
    },
  },
  address: {
    type: String,
    default: "",
  },
  tokenNt: {
    type: String,
    required: true,
    trim: true,
  },
  type: {
    type: String,
    trim: true,
    default: "user",
  },
  profilePic: {
    type: String,
    default: "",
  },
  avatarKey: {
    type: String,
    enum: avatarKeys,
    default: avatarKeys[0],
  },
  googleId: {
    type: String,
    default: "",
  },
  bio: {
    type: String,
    default: "",
    maxlength: 300,
  },
  phone: {
    type: String,
    default: "",
  },
  studyYear: {
    type: String,
    default: "",
  },
  isPremium: {
    type: Boolean,
    default: false,
  },
  completedLessons: {
    type: [String],
    default: [],
  },
  solvedExams: {
    type: [String],
    default: [],
  },
  completedLessonsCount: {
    type: Number,
    default: 0,
  },
  solvedExamsCount: {
    type: Number,
    default: 0,
  },
  xp: {
    type: Number,
    default: 0,
  },
  streakCount: {
    type: Number,
    default: 0,
  },
  longestStreak: {
    type: Number,
    default: 0,
  },
  lastActiveDate: {
    type: String,
    default: "",
  },
  activeDates: {
    type: [String],
    default: [],
  },
  aiUsageCount: {
    type: Number,
    default: 0,
  },
  commentsCount: {
    type: Number,
    default: 0,
  },
  earnedBadges: {
    type: [String],
    default: [],
  },
  featuredBadgeKey: {
    type: String,
    default: "",
  },
  gamificationEvents: {
    type: [String],
    default: [],
  },
});

userSchema.pre("validate", function assignAvatarKey(next) {
  ensureUserAvatarKey(this);
  next();
});

userSchema.index({ email: 1 });
userSchema.index({ googleId: 1 });
userSchema.index({ tokenNt: 1 });
userSchema.index({ completedLessonsCount: -1 });
userSchema.index({ solvedExamsCount: -1 });
userSchema.index({ xp: -1 });

const User = mongoose.model("User", userSchema);
module.exports = User;
