const mongoose = require("mongoose");

const appConfigSchema = mongoose.Schema({
  subscriptionPrice: {
    type: Number,
    default: 9.9,
  },
  currency: {
    type: String,
    default: "USD",
  },
  adsDefaultRolloutApplied: {
    type: Boolean,
    default: false,
  },
});

const AppConfig = mongoose.model("AppConfig", appConfigSchema);
module.exports = AppConfig;
