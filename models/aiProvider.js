const mongoose = require("mongoose");
const {
  AI_PROVIDER_CATALOG,
  AI_PROVIDER_MIN_INPUT_CHARS,
  AI_PROVIDER_MAX_INPUT_CHARS_HARD_LIMIT,
  getDefaultMaxInputCharsFor,
  normalizeAiProviderKey,
} = require("../utils/aiProviderCatalog");

const aiProviderSchema = new mongoose.Schema({
  providerName: {
    type: String,
    required: true,
    enum: AI_PROVIDER_CATALOG.map((provider) => provider.key),
    set: normalizeAiProviderKey,
    trim: true,
  },
  modelName: {
    type: String,
    required: true,
    trim: true,
  },
  apiKey: {
    type: String,
    required: true,
    trim: true,
  },
  priority: {
    type: Number,
    required: true,
    default: 1, // 1 is highest priority
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  // Soft cap on the combined input character count (system + history +
  // context + user message). Used to keep prompts safely below the provider
  // model's token window. Defaults are computed per-provider when missing.
  maxInputChars: {
    type: Number,
    min: AI_PROVIDER_MIN_INPUT_CHARS,
    max: AI_PROVIDER_MAX_INPUT_CHARS_HARD_LIMIT,
  },
});

aiProviderSchema.pre("validate", function applyMaxInputCharsDefault(next) {
  if (
    this.maxInputChars === undefined ||
    this.maxInputChars === null ||
    !Number.isFinite(this.maxInputChars)
  ) {
    this.maxInputChars = getDefaultMaxInputCharsFor(this.providerName);
  }
  next();
});

aiProviderSchema.index({ isActive: 1, priority: 1 });

const AIProvider = mongoose.model("AIProvider", aiProviderSchema);
module.exports = AIProvider;
