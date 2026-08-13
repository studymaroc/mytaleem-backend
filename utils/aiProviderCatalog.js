// maxInputChars: conservative character cap on the combined prompt (system +
// history + context + user message) to stay safely below the model's free-tier
// token window (~4 chars per token average across Arabic + English).
//   - groq llama-3.3 / 3.1 free tiers commonly expose 128k token windows.
//   - mistral free tier exposes ~32k tokens.
//   - openrouter free models often cap at 8k tokens; pick a conservative default.
// Admins can override per-record via the AIProvider model.
const AI_PROVIDER_DEFAULT_MAX_INPUT_CHARS_FALLBACK = 24000;

const AI_PROVIDER_CATALOG = [
  {
    key: "groq",
    label: "Groq",
    chatCompletionsUrl: "https://api.groq.com/openai/v1/chat/completions",
    modelPlaceholder: "llama-3.3-70b-versatile",
    docsUrl: "https://console.groq.com/docs/openai",
    defaultMaxInputChars: 400000,
  },
  {
    key: "openrouter",
    label: "OpenRouter",
    chatCompletionsUrl: "https://openrouter.ai/api/v1/chat/completions",
    modelPlaceholder: "openai/gpt-5.2",
    docsUrl: "https://openrouter.ai/docs/api/reference/overview",
    defaultMaxInputChars: 24000,
  },
  {
    key: "mistral",
    label: "Mistral",
    chatCompletionsUrl: "https://api.mistral.ai/v1/chat/completions",
    modelPlaceholder: "mistral-large-latest",
    docsUrl: "https://docs.mistral.ai/api",
    defaultMaxInputChars: 120000,
  },
];

const AI_PROVIDER_MAX_INPUT_CHARS_HARD_LIMIT = 800000;
const AI_PROVIDER_MIN_INPUT_CHARS = 4000;

const AI_PROVIDER_KEY_SET = new Set(AI_PROVIDER_CATALOG.map((item) => item.key));

function normalizeAiProviderKey(value) {
  return String(value || "").trim().toLowerCase();
}

function isSupportedAiProvider(value) {
  return AI_PROVIDER_KEY_SET.has(normalizeAiProviderKey(value));
}

function getAiProviderDefinition(value) {
  const normalized = normalizeAiProviderKey(value);
  return AI_PROVIDER_CATALOG.find((item) => item.key === normalized) || null;
}

function getDefaultMaxInputCharsFor(value) {
  const definition = getAiProviderDefinition(value);
  if (
    definition &&
    Number.isFinite(definition.defaultMaxInputChars) &&
    definition.defaultMaxInputChars >= AI_PROVIDER_MIN_INPUT_CHARS
  ) {
    return definition.defaultMaxInputChars;
  }
  return AI_PROVIDER_DEFAULT_MAX_INPUT_CHARS_FALLBACK;
}

module.exports = {
  AI_PROVIDER_CATALOG,
  AI_PROVIDER_MIN_INPUT_CHARS,
  AI_PROVIDER_MAX_INPUT_CHARS_HARD_LIMIT,
  AI_PROVIDER_DEFAULT_MAX_INPUT_CHARS_FALLBACK,
  getAiProviderDefinition,
  getDefaultMaxInputCharsFor,
  isSupportedAiProvider,
  normalizeAiProviderKey,
};
