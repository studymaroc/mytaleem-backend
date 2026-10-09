const express = require("express");
const appSettingsRouter = express.Router();
const AppConfig = require("../models/appConfig");
const adminAuth = require("../middlewares/adminAuth");

// GET /api/app-settings/config (أو الإعدادات العامة للتطبيق)
appSettingsRouter.get("/api/app-settings", async (req, res) => {
  try {
    let config = await AppConfig.findOne();
    if (!config) {
      config = new AppConfig();
      await config.save();
    }
    res.json(config);
  } catch (error) {
    console.error("Get app settings error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/app-settings/update (تحديث إعدادات التطبيق للأدمن)
appSettingsRouter.post("/api/app-settings/update", adminAuth, async (req, res) => {
  try {
    const { subscriptionPrice, currency, adsDefaultRolloutApplied } = req.body;
    let config = await AppConfig.findOne();
    if (!config) {
      config = new AppConfig();
    }
    if (subscriptionPrice !== undefined) {
      config.subscriptionPrice = subscriptionPrice;
    }
    if (currency !== undefined) {
      config.currency = currency;
    }
    if (adsDefaultRolloutApplied !== undefined) {
      config.adsDefaultRolloutApplied = adsDefaultRolloutApplied;
    }
    await config.save();
    res.json({ msg: "تم تحديث إعدادات التطبيق بنجاح", config });
  } catch (error) {
    console.error("Update app settings error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = appSettingsRouter;
