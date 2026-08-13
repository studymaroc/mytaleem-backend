const Groq = require("groq-sdk");
const axios = require("axios");
const AIProvider = require("../models/aiProvider");
const {
  getAiProviderDefinition,
  getDefaultMaxInputCharsFor,
  AI_PROVIDER_MIN_INPUT_CHARS,
  normalizeAiProviderKey,
} = require("./aiProviderCatalog");

const DEFAULT_PROVIDER_TIMEOUT_MS =
  Number(process.env.AI_PROVIDER_TIMEOUT_MS) || 60000;
const DEFAULT_TOTAL_TIMEOUT_MS =
  Number(process.env.AI_TOTAL_TIMEOUT_MS) || 120000;
const DEFAULT_MAX_HISTORY_MESSAGES = Number(
  process.env.AI_HISTORY_MESSAGE_LIMIT || 10
);
const DEFAULT_MAX_MESSAGE_CHARS = Number(
  process.env.AI_MESSAGE_CHAR_LIMIT || 1800
);
const DEFAULT_PROVIDER_RETRY_COUNT = 1;
const TRANSIENT_PROVIDER_STATUS_CODES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function normalizeMessageContent(content) {
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part.trim();
        }
        if (part && typeof part === "object") {
          if (typeof part.text === "string") {
            return part.text.trim();
          }
          if (typeof part.content === "string") {
            return part.content.trim();
          }
        }
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  if (content && typeof content === "object" && typeof content.text === "string") {
    return content.text.trim();
  }

  return "";
}

function getNonEmptyContent(content, providerName) {
  const text = normalizeMessageContent(content);
  if (!text) {
    throw new Error(`${providerName} returned an empty response payload.`);
  }
  return text;
}

function normalizeWhitespace(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function trimTextToLength(value, maxChars) {
  const normalized = normalizeWhitespace(value);
  if (!normalized || !Number.isFinite(maxChars) || maxChars < 1) {
    return normalized;
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars).trim()}\n...`;
}

function sanitizeOutboundMessages(messages, config = {}) {
  if (!Array.isArray(messages)) {
    return [];
  }

  const maxMessages = Math.max(
    1,
    Number(config.maxHistoryMessages || DEFAULT_MAX_HISTORY_MESSAGES)
  );
  const maxCharsPerMessage = Math.max(
    200,
    Number(config.maxMessageChars || DEFAULT_MAX_MESSAGE_CHARS)
  );

  return messages
    .filter((message) => message && typeof message === "object")
    .slice(-maxMessages)
    .map((message) => {
      const role = ["system", "user", "assistant"].includes(message.role)
        ? message.role
        : "user";
      const content = Array.isArray(message.content)
        ? message.content
        : trimTextToLength(message.content, maxCharsPerMessage);
      return { role, content };
    })
    .filter((message) => {
      if (Array.isArray(message.content)) {
        return message.content.length > 0;
      }
      return typeof message.content === "string" && message.content.length > 0;
    });
}

function messageContentLength(content) {
  if (typeof content === "string") {
    return content.length;
  }
  if (Array.isArray(content)) {
    return content.reduce(
      (total, part) => total + messageContentLength(part),
      0
    );
  }
  if (content && typeof content === "object" && typeof content.text === "string") {
    return content.text.length;
  }
  return 0;
}

function totalMessagesCharCount(messages) {
  if (!Array.isArray(messages)) return 0;
  return messages.reduce(
    (total, message) => total + messageContentLength(message?.content),
    0
  );
}

function createInputBudgetError(actualChars, allowedChars) {
  const error = new Error(
    `Input exceeds the provider's allowed character budget (${actualChars}/${allowedChars}).`
  );
  error.name = "AiInputBudgetExceededError";
  error.code = "AI_INPUT_BUDGET_EXCEEDED";
  error.actualChars = actualChars;
  error.allowedChars = allowedChars;
  error.statusCode = 413;
  error.publicMessage =
    "حجم النص المرسل تجاوز الحد المسموح به للمزود الحالي. الرجاء تقليل حجم السياق أو الرسالة والمحاولة من جديد.";
  return error;
}

// Enforce the provider's combined-input character budget. Trims oldest history
// turns first; if still over budget, truncates the longest non-system message.
// Throws AiInputBudgetExceededError when the input cannot be made to fit.
function enforceInputBudget(messages, providerMaxChars) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return messages;
  }
  const allowed = Math.max(
    AI_PROVIDER_MIN_INPUT_CHARS,
    Number(providerMaxChars) || 0
  );

  let working = [...messages];
  let total = totalMessagesCharCount(working);
  if (total <= allowed) {
    return working;
  }

  // Step 1: drop oldest non-system, non-last messages until we fit.
  const isProtected = (idx, arr) => {
    const msg = arr[idx];
    return msg?.role === "system" || idx === arr.length - 1;
  };

  let i = 0;
  while (i < working.length && total > allowed) {
    if (isProtected(i, working)) {
      i += 1;
      continue;
    }
    const removed = working.splice(i, 1)[0];
    total -= messageContentLength(removed?.content);
  }

  if (total <= allowed) {
    return working;
  }

  // Step 2: truncate the longest non-system string-content message.
  const overflow = total - allowed;
  let targetIndex = -1;
  let targetLength = 0;
  for (let j = 0; j < working.length; j += 1) {
    const msg = working[j];
    if (typeof msg?.content !== "string") continue;
    if (msg.role === "system") continue;
    if (msg.content.length > targetLength) {
      targetLength = msg.content.length;
      targetIndex = j;
    }
  }
  if (targetIndex >= 0 && targetLength > overflow + 64) {
    const original = working[targetIndex].content;
    const keep = Math.max(200, original.length - overflow - 32);
    working[targetIndex] = {
      ...working[targetIndex],
      content: `${original.slice(0, keep).trim()}\n…[تم اختصار النص ليتناسب مع حدود المزود]`,
    };
    total = totalMessagesCharCount(working);
  }

  if (total > allowed) {
    throw createInputBudgetError(total, allowed);
  }

  return working;
}

function extractProviderErrorMessage(error) {
  const status = error?.response?.status;
  const data = error?.response?.data;

  if (typeof data === "string" && data.trim()) {
    return status ? `HTTP ${status}: ${data.trim()}` : data.trim();
  }

  if (data && typeof data === "object") {
    const nestedMessage =
      (typeof data.message === "string" && data.message.trim()) ||
      (typeof data.error === "string" && data.error.trim()) ||
      (typeof data.error?.message === "string" && data.error.message.trim()) ||
      (typeof data.detail === "string" && data.detail.trim());

    if (nestedMessage) {
      return status ? `HTTP ${status}: ${nestedMessage}` : nestedMessage;
    }
  }

  if (typeof error?.message === "string" && error.message.trim()) {
    return status ? `HTTP ${status}: ${error.message.trim()}` : error.message.trim();
  }

  return status ? `HTTP ${status}: Unknown provider error.` : "Unknown provider error.";
}

function isRetriableProviderError(error) {
  const status = Number(error?.response?.status || 0);
  if (TRANSIENT_PROVIDER_STATUS_CODES.has(status)) {
    return true;
  }

  const code = String(error?.code || "").toUpperCase();
  return code === "ECONNABORTED" || code === "ETIMEDOUT" || code === "ERR_CANCELED";
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createProviderTimeoutError(timeoutMs) {
  const error = new Error(`Provider request timed out after ${timeoutMs}ms.`);
  error.name = "ProviderTimeoutError";
  error.code = "ETIMEDOUT";
  return error;
}

async function withTimeout(promise, timeoutMs, onTimeout) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      if (typeof onTimeout === "function") {
        try {
          onTimeout();
        } catch (_) {
          // No-op: cancellation is best-effort.
        }
      }
      reject(createProviderTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function callGroqProvider(provider, options, timeoutMs) {
  const groq = new Groq({
    apiKey: provider.apiKey,
    timeout: timeoutMs,
    maxRetries: 0,
  });

  const completion = await withTimeout(
    groq.chat.completions.create(options),
    timeoutMs
  );

  return getNonEmptyContent(
    completion?.choices?.[0]?.message?.content,
    provider.providerName
  );
}

function buildProviderHeaders(providerKey, provider) {
  const headers = {
    Authorization: `Bearer ${provider.apiKey}`,
    "Content-Type": "application/json",
  };

  if (providerKey === "openrouter") {
    headers["X-OpenRouter-Title"] =
      process.env.OPENROUTER_APP_NAME || "StudyApp";
    if (process.env.OPENROUTER_SITE_URL) {
      headers["HTTP-Referer"] = process.env.OPENROUTER_SITE_URL;
    }
  }

  return headers;
}

async function callAxiosProvider(providerKey, url, provider, options, timeoutMs) {
  const controller = new AbortController();
  const response = await withTimeout(
    axios.post(url, options, {
      headers: buildProviderHeaders(providerKey, provider),
      timeout: timeoutMs,
      signal: controller.signal,
    }),
    timeoutMs,
    () => controller.abort()
  );

  return getNonEmptyContent(
    response?.data?.choices?.[0]?.message?.content,
    provider.providerName
  );
}

async function generateChatResponse(
  messages,
  systemPrompt = "",
  responseFormat = null,
  config = {}
) {
  messages = sanitizeOutboundMessages(messages, config);

  if (systemPrompt) {
    messages = [{ role: "system", content: systemPrompt }, ...messages];
  }

  const providers = await AIProvider.find({ isActive: true })
    .sort({ priority: 1 })
    .lean();

  if (!providers || providers.length === 0) {
    throw new Error("No active AI providers found.");
  }

  const totalTimeoutMs = Math.max(
    1000,
    Number(config.totalTimeoutMs || DEFAULT_TOTAL_TIMEOUT_MS)
  );
  const parsedProviderTimeoutMs = Number(config.providerTimeoutMs);
  const hasCustomProviderTimeout =
    Number.isFinite(parsedProviderTimeoutMs) && parsedProviderTimeoutMs > 0;
  const providerTimeoutMs = Math.max(
    1000,
    hasCustomProviderTimeout
      ? parsedProviderTimeoutMs
      : DEFAULT_PROVIDER_TIMEOUT_MS
  );

  let lastError = null;
  const startedAt = Date.now();

  for (let providerIndex = 0; providerIndex < providers.length; providerIndex += 1) {
    const provider = providers[providerIndex];
    const providersRemaining = providers.length - providerIndex;
    const providerKey = normalizeAiProviderKey(provider.providerName);
    const providerDefinition = getAiProviderDefinition(providerKey);
    const providerMaxInputChars =
      Number.isFinite(provider.maxInputChars) && provider.maxInputChars > 0
        ? provider.maxInputChars
        : getDefaultMaxInputCharsFor(providerKey);

    let providerMessages;
    try {
      providerMessages = enforceInputBudget(messages, providerMaxInputChars);
    } catch (budgetError) {
      console.error(
        `AI Provider ${provider.providerName} skipped: ${budgetError.message}`
      );
      lastError = budgetError;
      continue;
    }
    const options = {
      messages: providerMessages,
      model: provider.modelName,
    };
    if (responseFormat) {
      options.response_format = responseFormat;
    }

    try {
      if (!providerDefinition) {
        throw new Error(`Unsupported AI provider: ${provider.providerName}`);
      }
      let lastAttemptError = null;
      const maxAttempts = DEFAULT_PROVIDER_RETRY_COUNT + 1;

      for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
        const elapsedMs = Date.now() - startedAt;
        const remainingMs = totalTimeoutMs - elapsedMs;
        if (remainingMs <= 0) {
          throw new Error(`AI routing timed out after ${totalTimeoutMs}ms.`);
        }

        const fairShareTimeoutMs = Math.max(
          1000,
          Math.floor(remainingMs / Math.max(1, providersRemaining))
        );
        const dynamicProviderTimeoutMs = hasCustomProviderTimeout
          ? providerTimeoutMs
          : Math.max(providerTimeoutMs, fairShareTimeoutMs);
        const attemptTimeoutMs = Math.min(dynamicProviderTimeoutMs, remainingMs);

        try {
          if (providerKey === "groq") {
            return await callGroqProvider(provider, options, attemptTimeoutMs);
          }

          if (providerKey === "openrouter" || providerKey === "mistral") {
            return await callAxiosProvider(
              providerKey,
              providerDefinition.chatCompletionsUrl,
              provider,
              options,
              attemptTimeoutMs
            );
          }

          throw new Error(`Unsupported AI provider: ${provider.providerName}`);
        } catch (attemptError) {
          lastAttemptError = attemptError;
          const hasRetryLeft = attemptIndex + 1 < maxAttempts;
          if (!hasRetryLeft || !isRetriableProviderError(attemptError)) {
            throw attemptError;
          }

          const retryDelayMs = Math.min(1200, 300 * (attemptIndex + 1));
          const retryRemainingMs = totalTimeoutMs - (Date.now() - startedAt);
          if (retryRemainingMs <= 0) {
            throw attemptError;
          }
          await wait(Math.min(retryDelayMs, retryRemainingMs));
        }
      }

      if (lastAttemptError) {
        throw lastAttemptError;
      }
    } catch (e) {
      const errMsg = extractProviderErrorMessage(e);
      console.error(`AI Provider ${provider.providerName} failed: ${errMsg}`);
      lastError = e;
      // Continue to next provider in the fallback chain.
    }
  }

  throw new Error(
    `All AI providers failed. Last error: ${
      lastError ? extractProviderErrorMessage(lastError) : "Unknown"
    }`
  );
}

module.exports = { generateChatResponse, enforceInputBudget };
