const express = require("express");
const adminRouter = express.Router();
const User = require("../models/user");
const AppConfig = require("../models/appConfig");
const adminAuth = require("../middlewares/adminAuth");
const { withResolvedAvatar } = require("../utils/avatarCatalog");

// Get all users (paginated)
adminRouter.get("/api/admin/users", adminAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const search = req.query.search || "";
    const skip = (page - 1) * limit;

    const query = search
      ? {
          $or: [
            { name: { $regex: search, $options: "i" } },
            { email: { $regex: search, $options: "i" } },
          ],
        }
      : {};

    const users = await User.find(query)
      .select("name email profilePic avatarKey isPremium type studyYear")
      .skip(skip)
      .limit(limit)
      .sort({ name: 1 });

    const total = await User.countDocuments(query);

    res.json({
      users: users.map((user) => withResolvedAvatar(user)),
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (error) {
    console.error("Get users error:", error.message);
    res.status(500).json({ error: "خطأ في جلب قائمة المستخدمين" });
  }
});

// Toggle premium status
adminRouter.post("/api/admin/toggle_premium", adminAuth, async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ msg: "معرف المستخدم مطلوب" });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ msg: "المستخدم غير موجود" });
    }

    user.isPremium = !user.isPremium;
    await user.save();

    res.json({
      msg: user.isPremium
        ? "تم إيقاف الإعلانات لهذا المستخدم"
        : "تم إعادة تفعيل الإعلانات لهذا المستخدم",
      isPremium: user.isPremium,
      userId: user._id,
    });
  } catch (error) {
    console.error("Toggle premium error:", error.message);
    res.status(500).json({ error: "خطأ في تغيير حالة الإعلانات" });
  }
});

// Get app config
adminRouter.get("/api/admin/config", adminAuth, async (req, res) => {
  try {
    let config = await AppConfig.findOne();
    if (!config) {
      config = new AppConfig();
      await config.save();
    }
    res.json(config);
  } catch (error) {
    console.error("Get config error:", error.message);
    res.status(500).json({ error: "خطأ في جلب إعدادات التطبيق" });
  }
});

// Update app config
adminRouter.post("/api/admin/update_config", adminAuth, async (req, res) => {
  try {
    const { subscriptionPrice, currency } = req.body;

    let config = await AppConfig.findOne();
    if (!config) {
      config = new AppConfig();
    }

    if (subscriptionPrice !== undefined) {
      if (typeof subscriptionPrice !== "number" || subscriptionPrice < 0) {
        return res.status(400).json({ msg: "سعر الاشتراك غير صالح" });
      }
      config.subscriptionPrice = subscriptionPrice;
    }
    if (currency !== undefined) config.currency = currency;

    await config.save();
    res.json({ msg: "تم تحديث الإعدادات بنجاح", config });
  } catch (error) {
    console.error("Update config error:", error.message);
    res.status(500).json({ error: "خطأ في تحديث الإعدادات" });
  }
});

module.exports = adminRouter;
