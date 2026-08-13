const express = require("express");
const profileRouter = express.Router();
const User = require("../models/user");
const auth = require("../middlewares/auth");
const {
  normalizeAvatarKey,
  ensureUserAvatarKey,
  withResolvedAvatar,
} = require("../utils/avatarCatalog");
const { getBadgeSummary } = require("../utils/gamification");

// Update profile
profileRouter.post("/api/update_profile", auth, async (req, res) => {
  try {
    const { name, bio, phone, studyYear, avatarKey } = req.body;
    const user = await User.findById(req.user);
    if (!user) {
      return res.status(404).json({ msg: "المستخدم غير موجود" });
    }

    if (name !== undefined) user.name = name;
    if (bio !== undefined) user.bio = bio;
    if (phone !== undefined) user.phone = phone;
    if (studyYear !== undefined) user.studyYear = studyYear;
    if (avatarKey !== undefined) {
      const normalizedAvatarKey = normalizeAvatarKey(avatarKey);
      if (!normalizedAvatarKey) {
        return res.status(400).json({ msg: "الصورة الرمزية غير صالحة" });
      }
      user.avatarKey = normalizedAvatarKey;
    }

    ensureUserAvatarKey(user);
    await user.save();
    res.json({
      msg: "تم تحديث البيانات بنجاح",
      user: { ...withResolvedAvatar(user), ...getBadgeSummary(user) },
    });
  } catch (error) {
    console.error("Update profile error:", error.message);
    res.status(500).json({ error: "خطأ في تحديث البيانات الشخصية" });
  }
});

// Update profile picture
profileRouter.post("/api/update_profile_pic", auth, async (req, res) => {
  try {
    const { profilePic } = req.body;
    if (!profilePic) {
      return res.status(400).json({ msg: "رابط الصورة مطلوب" });
    }
    const user = await User.findById(req.user);
    if (!user) {
      return res.status(404).json({ msg: "المستخدم غير موجود" });
    }

    user.profilePic = profilePic;
    ensureUserAvatarKey(user);
    await user.save();
    res.json({
      msg: "تم تحديث الصورة الشخصية بنجاح",
      user: { ...withResolvedAvatar(user), ...getBadgeSummary(user) },
    });
  } catch (error) {
    console.error("Update profile pic error:", error.message);
    res.status(500).json({ error: "خطأ في تحديث الصورة الشخصية" });
  }
});

// Get user profile by ID
profileRouter.get("/api/profile/:userId", auth, async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).select(
      "name email profilePic avatarKey bio phone studyYear isPremium type xp streakCount earnedBadges featuredBadgeKey"
    );
    if (!user) {
      return res.status(404).json({ msg: "المستخدم غير موجود" });
    }
    res.json({ ...withResolvedAvatar(user), ...getBadgeSummary(user) });
  } catch (error) {
    console.error("Get profile error:", error.message);
    res.status(500).json({ error: "خطأ في جلب البيانات الشخصية" });
  }
});

module.exports = profileRouter;
