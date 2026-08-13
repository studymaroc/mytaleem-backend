const express = require("express");
const aiRouter = express.Router();
const { generateChatResponse } = require("../utils/aiRouter");
const { extractPdfAiContext } = require("../utils/pdfContextExtractor");
const { extractTextFromImages } = require("../utils/ocrExtractor");
const {
  AI_PROVIDER_CATALOG,
  AI_PROVIDER_MIN_INPUT_CHARS,
  AI_PROVIDER_MAX_INPUT_CHARS_HARD_LIMIT,
  getAiProviderDefinition,
  getDefaultMaxInputCharsFor,
  normalizeAiProviderKey,
} = require("../utils/aiProviderCatalog");
const GeneratedExam = require("../models/generatedExam");
const AIProvider = require("../models/aiProvider");
const auth = require("../middlewares/auth");
const adminAuth = require("../middlewares/adminAuth");

const AI_REQUEST_TIMEOUT_MS = 45000;
const MAX_DIRECT_CONTEXT_CHARS = Number(
  process.env.AI_DIRECT_CONTEXT_CHAR_LIMIT || 4200
);
const MAX_CHAT_MESSAGE_CHARS = Number(
  process.env.AI_CHAT_MESSAGE_CHAR_LIMIT || 2200
);
const QUIZ_MIN_QUESTION_COUNT = 1;
const QUIZ_MAX_QUESTION_COUNT = 20;
const QUIZ_ALLOWED_TYPES = new Set(["tf", "mcq", "open"]);
const QUIZ_EXTRA_INSTRUCTIONS_MAX_CHARS = 600;

function isInputBudgetError(err) {
  return err && err.code === "AI_INPUT_BUDGET_EXCEEDED";
}

function respondAiError(res, e) {
  if (isInputBudgetError(e)) {
    return res.status(413).json({
      error: e.publicMessage || e.message,
      code: e.code,
      actualChars: e.actualChars,
      allowedChars: e.allowedChars,
    });
  }
  return res.status(500).json({ error: e.message });
}

async function withRouteTimeout(promise, timeoutMs, timeoutMessage) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function cleanContextText(value, maxChars = 4000) {
  const text = typeof value === "string" ? value : "";
  const normalized = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!normalized) {
    return "";
  }

  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, maxChars).trim()}\n...`;
}

function normalizeHeadingList(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const uniqueHeadings = new Set();
  for (const item of value) {
    const heading = typeof item === "string" ? item.trim() : "";
    if (heading) {
      uniqueHeadings.add(heading);
    }
    if (uniqueHeadings.size === 3) {
      break;
    }
  }

  return [...uniqueHeadings];
}

function buildStructuredContext(contextData) {
  if (!contextData || typeof contextData !== "object") {
    return "";
  }

  const moduleName = cleanContextText(contextData.moduleName, 160);
  const lessonTitle = cleanContextText(contextData.lessonTitle, 160);
  const sectionName = cleanContextText(contextData.sectionName, 160);
  const documentTitle = cleanContextText(contextData.documentTitle, 160);
  const currentPageText = cleanContextText(contextData.currentPageText, 2200);
  const previousPageText = cleanContextText(contextData.previousPageText, 900);
  const nextPageText = cleanContextText(contextData.nextPageText, 900);
  const headings = normalizeHeadingList(contextData.headingCandidates);
  const currentPage = Number(contextData.currentPage || 1);
  const totalPages = Number(contextData.totalPages || 1);

  const parts = [
    "Source type: PDF lesson",
    moduleName ? `Subject/module: ${moduleName}` : "",
    lessonTitle ? `Lesson title: ${lessonTitle}` : "",
    sectionName ? `Section/file: ${sectionName}` : "",
    documentTitle ? `Document title: ${documentTitle}` : "",
    Number.isFinite(currentPage) && Number.isFinite(totalPages)
      ? `Current page: ${currentPage} of ${totalPages}`
      : "",
    headings.length ? `Visible headings: ${headings.join(" | ")}` : "",
    previousPageText ? `Previous page context:\n${previousPageText}` : "",
    currentPageText ? `Current page text:\n${currentPageText}` : "",
    nextPageText ? `Next page context:\n${nextPageText}` : "",
  ].filter(Boolean);

  if (!parts.length) {
    return "";
  }

  return parts.join("\n\n");
}

function resolveStructuredContext(contextText, contextData) {
  const directContext = cleanContextText(contextText, MAX_DIRECT_CONTEXT_CHARS);
  if (directContext) {
    return directContext;
  }

  if (contextData && typeof contextData === "object") {
    const structuredContext = buildStructuredContext(contextData);
    if (structuredContext) {
      return structuredContext;
    }
  }

  return "";
}

function sanitizeAiProviderPayload(body = {}) {
  const providerName = normalizeAiProviderKey(body.providerName);
  const providerDefinition = getAiProviderDefinition(providerName);
  const modelName = String(body.modelName || "").trim();
  const apiKey = String(body.apiKey || "").trim();
  const priority = Number(body.priority);
  const isActive =
    typeof body.isActive === "boolean" ? body.isActive : body.isActive !== false;

  if (!providerDefinition) {
    return {
      error: "نوع مزود الذكاء الاصطناعي غير مدعوم.",
    };
  }

  if (!modelName) {
    return {
      error: "اسم النموذج مطلوب.",
    };
  }

  if (!apiKey) {
    return {
      error: "مفتاح API مطلوب.",
    };
  }

  if (!Number.isFinite(priority) || priority < 1) {
    return {
      error: "الأولوية يجب أن تكون رقماً صحيحاً أكبر من أو يساوي 1.",
    };
  }

  let maxInputChars;
  if (
    body.maxInputChars !== undefined &&
    body.maxInputChars !== null &&
    body.maxInputChars !== ""
  ) {
    const parsedMaxInputChars = Number(body.maxInputChars);
    if (
      !Number.isFinite(parsedMaxInputChars) ||
      parsedMaxInputChars < AI_PROVIDER_MIN_INPUT_CHARS ||
      parsedMaxInputChars > AI_PROVIDER_MAX_INPUT_CHARS_HARD_LIMIT
    ) {
      return {
        error: `حد عدد الأحرف يجب أن يكون رقماً بين ${AI_PROVIDER_MIN_INPUT_CHARS} و ${AI_PROVIDER_MAX_INPUT_CHARS_HARD_LIMIT}.`,
      };
    }
    maxInputChars = Math.trunc(parsedMaxInputChars);
  } else {
    maxInputChars = getDefaultMaxInputCharsFor(providerName);
  }

  return {
    value: {
      providerName,
      modelName,
      apiKey,
      priority: Math.trunc(priority),
      isActive,
      maxInputChars,
    },
  };
}

// ======================
// Admin Routes (Manage AI Providers)
// ======================

aiRouter.get("/api/admin/ai-provider-options", adminAuth, async (req, res) => {
  res.json(
    AI_PROVIDER_CATALOG.map((provider) => ({
      key: provider.key,
      label: provider.label,
      modelPlaceholder: provider.modelPlaceholder,
      docsUrl: provider.docsUrl,
      defaultMaxInputChars: provider.defaultMaxInputChars,
    }))
  );
});

aiRouter.get("/api/admin/ai-providers", adminAuth, async (req, res) => {
  try {
    const providers = await AIProvider.find({}).sort({ priority: 1 });
    res.json(providers);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

aiRouter.post("/api/admin/ai-providers", adminAuth, async (req, res) => {
  try {
    const sanitized = sanitizeAiProviderPayload(req.body || {});
    if (sanitized.error) {
      return res.status(400).json({ error: sanitized.error });
    }

    let provider = new AIProvider(sanitized.value);
    provider = await provider.save();
    res.json(provider);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

aiRouter.put("/api/admin/ai-providers/:id", adminAuth, async (req, res) => {
  try {
    const sanitized = sanitizeAiProviderPayload(req.body || {});
    if (sanitized.error) {
      return res.status(400).json({ error: sanitized.error });
    }

    const provider = await AIProvider.findByIdAndUpdate(req.params.id, {
      ...sanitized.value,
    }, { new: true, runValidators: true });
    if (!provider) {
      return res.status(404).json({ error: "AI provider not found." });
    }
    res.json(provider);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

aiRouter.delete("/api/admin/ai-providers/:id", adminAuth, async (req, res) => {
  try {
    await AIProvider.findByIdAndDelete(req.params.id);
    res.json({ msg: "Provider deleted successfully" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ======================
// App Routes (Chat & Gen)
// ======================

aiRouter.post("/api/ai/pdf-context", auth, async (req, res) => {
  try {
    const {
      pdfUrl,
      moduleName,
      lessonTitle,
      sectionName,
      documentTitle,
      selectionMode,
      currentPage,
      startPage,
      endPage,
    } = req.body || {};

    const extractedContext = await withRouteTimeout(
      extractPdfAiContext({
        pdfUrl,
        moduleName,
        lessonTitle,
        sectionName,
        documentTitle,
        selectionMode,
        currentPage,
        startPage,
        endPage,
      }),
      AI_REQUEST_TIMEOUT_MS + 5000,
      "PDF context extraction timed out."
    );

    res.json(extractedContext);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

aiRouter.post("/api/ai/ocr-extract", auth, async (req, res) => {
  try {
    const { images, moduleName, lessonTitle } = req.body || {};

    if (!Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: "No images provided for OCR." });
    }

    const result = await withRouteTimeout(
      extractTextFromImages(images, { moduleName, lessonTitle }),
      AI_REQUEST_TIMEOUT_MS + 30000,
      "OCR extraction timed out."
    );

    res.json(result);
  } catch (e) {
    console.error("OCR extraction error:", e.message || e);
    res.status(500).json({ error: e.message });
  }
});

aiRouter.post("/api/ai/chat", auth, async (req, res) => {
  try {
    const { message, history, contextText, contextData } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "A valid message is required." });
    }

    const normalizedMessage = cleanContextText(message, MAX_CHAT_MESSAGE_CHARS);
    if (!normalizedMessage) {
      return res.status(400).json({ error: "A valid message is required." });
    }

    const messages = Array.isArray(history) ? [...history] : [];
    messages.push({ role: "user", content: normalizedMessage });

    let systemPrompt =
      "You are an expert AI Tutor. Answer the user's questions clearly in Arabic. Keep the answer concise, educational, and grounded in the provided material. When the user asks a vague request like 'اشرح ببساطة' or 'لخص', assume they mean the currently provided lesson/page context and explain that material directly instead of replying with a generic help message. Format the answer in clean Markdown suitable for mobile screens: use short headings only when helpful, bullet points for steps or lists, and **bold** only for key ideas. Avoid large tables, avoid code blocks unless the user asks, and do not over-format short answers. If the provided page context is incomplete, say that briefly instead of inventing details.";
    const structuredContext = resolveStructuredContext(contextText, contextData);
    if (structuredContext) {
      systemPrompt += `\n\nThe user is currently reading this study material. Use it when relevant:\n${structuredContext}`;
    }

    const responseText = await withRouteTimeout(
      generateChatResponse(messages, systemPrompt, null, {
        totalTimeoutMs: AI_REQUEST_TIMEOUT_MS,
      }),
      AI_REQUEST_TIMEOUT_MS + 1000,
      "AI chat request timed out."
    );

    res.json({ response: responseText });
  } catch (e) {
    respondAiError(res, e);
  }
});

aiRouter.post("/api/ai/generate-exam", auth, async (req, res) => {
  try {
    const { subject, level, difficulty } = req.body;

    if (!subject || !level || !difficulty) {
      return res.status(400).json({ error: "subject, level, and difficulty are required." });
    }
    
    // Check Cache first
    const existingExam = await GeneratedExam.findOne({ subject, level, difficulty }).lean();
    if (existingExam) {
      return res.json({ cached: true, questions: existingExam.questions });
    }
    
    // Generate new exam
    const systemPrompt = `You are an expert AI Examiner. Create a 10-question multiple-choice exam for subject: "${subject}", level: "${level}", difficulty: "${difficulty}". 
Respond ONLY with a valid JSON format:
{
  "questions": [
    {
      "question": "The question string",
      "options": ["A", "B", "C", "D"],
      "answerIndex": 0
    }
  ]
}
No other text. In Arabic language only.`;
    
    let responseText = await withRouteTimeout(
      generateChatResponse(
        [{ role: "user", content: "Generate the exam." }],
        systemPrompt,
        { type: "json_object" },
        { totalTimeoutMs: AI_REQUEST_TIMEOUT_MS }
      ),
      AI_REQUEST_TIMEOUT_MS + 1000,
      "AI exam generation request timed out."
    );
    
    // Clean JSON if needed
    if (typeof responseText === "string" && responseText.trim().startsWith("```")) {
      responseText = responseText
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/```\s*$/i, "")
        .trim();
    }
    
    const parsedData = JSON.parse(responseText);
    if (!Array.isArray(parsedData?.questions) || parsedData.questions.length === 0) {
      throw new Error("AI provider returned an invalid exam payload.");
    }
    
    // Save to cache.
    await GeneratedExam.findOneAndUpdate(
      { subject, level, difficulty },
      { $set: { questions: parsedData.questions } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    
    res.json({ cached: false, questions: parsedData.questions });
  } catch (e) {
    respondAiError(res, e);
  }
});

// ======================
// Quiz generation & limits
// ======================

function normalizeQuizSpec(rawSpec) {
  const spec = rawSpec && typeof rawSpec === "object" ? rawSpec : {};

  let count = Number(spec.count);
  if (!Number.isFinite(count)) count = 5;
  count = Math.max(
    QUIZ_MIN_QUESTION_COUNT,
    Math.min(QUIZ_MAX_QUESTION_COUNT, Math.trunc(count))
  );

  let types = Array.isArray(spec.types) ? spec.types : [];
  types = [
    ...new Set(
      types
        .map((t) => String(t || "").trim().toLowerCase())
        .filter((t) => QUIZ_ALLOWED_TYPES.has(t))
    ),
  ];
  if (types.length === 0) {
    types = ["mcq"];
  }

  const extraInstructions = cleanContextText(
    spec.extraInstructions,
    QUIZ_EXTRA_INSTRUCTIONS_MAX_CHARS
  );

  return { count, types, extraInstructions };
}

/** يبني سطر يوصّف المادة والمستوى والشعبة لو الاختبار مطلوب على مادة كاملة. */
function buildSubjectScopeLine(scope) {
  if (!scope || typeof scope !== "object") return "";
  const subject = String(scope.subject || "").trim();
  const year = String(scope.year || "").trim();
  const speciality = String(scope.speciality || "").trim();
  if (!subject && !year) return "";

  const parts = [];
  if (subject) parts.push(`المادة: ${subject}`);
  if (year) parts.push(`المستوى: ${year}`);
  if (speciality) parts.push(`الشعبة: ${speciality}`);

  return (
    "The quiz MUST cover the following scope from the Moroccan curriculum, " +
    "and questions must be suitable for this exact level:\n" +
    parts.join(" — ")
  );
}

function buildQuizSystemPrompt(quizSpec, structuredContext, subjectScope) {
  const typeLabel = {
    tf: '"tf" for true/false (the "answer" field MUST be a boolean)',
    mcq:
      '"mcq" for multiple-choice with 3 to 5 options ("options" array of strings, "answerIndex" integer pointing at the correct option)',
    open:
      '"open" for open-ended question (no auto-grade; provide "referenceAnswer" string and "keyPoints" array of 2-5 short strings)',
  };
  const allowedTypeDescriptions = quizSpec.types
    .map((t) => `- ${typeLabel[t]}`)
    .join("\n");

  const lines = [
    "You are an expert AI Examiner generating a study quiz in Arabic.",
    `Produce EXACTLY ${quizSpec.count} questions.`,
    `Allowed question types and required field shape:\n${allowedTypeDescriptions}`,
    quizSpec.types.length > 1
      ? "Mix the allowed types reasonably across the questions; do NOT use any type outside the allowed list."
      : "Use ONLY the single allowed type for every question.",
    "Every question must include a short \"explanation\" string (1-2 sentences) clarifying the answer in Arabic. For \"open\" questions \"explanation\" can mirror the reference answer.",
    "Respond ONLY with a valid JSON object matching this schema, with NO markdown fencing and NO extra commentary:",
    "{\n  \"title\": \"...\",\n  \"language\": \"ar\",\n  \"questions\": [\n    { \"type\": \"tf\", \"prompt\": \"...\", \"answer\": true, \"explanation\": \"...\" },\n    { \"type\": \"mcq\", \"prompt\": \"...\", \"options\": [\"...\",\"...\"], \"answerIndex\": 0, \"explanation\": \"...\" },\n    { \"type\": \"open\", \"prompt\": \"...\", \"referenceAnswer\": \"...\", \"keyPoints\": [\"...\",\"...\"], \"explanation\": \"...\" }\n  ]\n}",
    "All natural language fields must be in Arabic.",
  ];

  const scopeLine = buildSubjectScopeLine(subjectScope);
  if (scopeLine) {
    lines.push(scopeLine);
  }

  if (structuredContext) {
    lines.push(
      `Base every question on the following study material. Do NOT invent facts that are not supported by it:\n${structuredContext}`
    );
  } else {
    lines.push(
      "There is no specific study material attached; rely on the official MOROCCAN high-school curriculum (المنهاج الدراسي المغربي) for the subject implied by the user's request."
    );
  }

  if (quizSpec.extraInstructions) {
    lines.push(
      `Additional user instructions (respect them when not in conflict with the rules above):\n${quizSpec.extraInstructions}`
    );
  }

  return lines.join("\n\n");
}

function stripJsonFences(text) {
  if (typeof text !== "string") return text;
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

function validateAndNormalizeQuizPayload(parsed, quizSpec) {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("AI provider returned an invalid quiz payload.");
  }

  const rawQuestions = Array.isArray(parsed.questions) ? parsed.questions : [];
  const allowedTypes = new Set(quizSpec.types);
  const normalized = [];

  for (let i = 0; i < rawQuestions.length; i += 1) {
    const q = rawQuestions[i] || {};
    const type = String(q.type || "").trim().toLowerCase();
    if (!allowedTypes.has(type)) continue;

    const prompt = String(q.prompt || q.question || "").trim();
    const explanation = String(q.explanation || "").trim();
    if (!prompt) continue;

    const id = `q_${i + 1}`;

    if (type === "tf") {
      const answer =
        typeof q.answer === "boolean"
          ? q.answer
          : String(q.answer || "").toLowerCase() === "true";
      normalized.push({ id, type, prompt, answer, explanation });
      continue;
    }

    if (type === "mcq") {
      const options = Array.isArray(q.options)
        ? q.options.map((o) => String(o || "").trim()).filter(Boolean)
        : [];
      if (options.length < 2) continue;
      let answerIndex = Number(q.answerIndex);
      if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex >= options.length) {
        answerIndex = 0;
      }
      normalized.push({ id, type, prompt, options, answerIndex, explanation });
      continue;
    }

    if (type === "open") {
      const referenceAnswer = String(q.referenceAnswer || q.answer || "").trim();
      if (!referenceAnswer) continue;
      const keyPoints = Array.isArray(q.keyPoints)
        ? q.keyPoints.map((k) => String(k || "").trim()).filter(Boolean).slice(0, 6)
        : [];
      normalized.push({ id, type, prompt, referenceAnswer, keyPoints, explanation });
      continue;
    }
  }

  if (normalized.length === 0) {
    throw new Error("AI provider returned no usable questions.");
  }

  // Cap to requested count if the model overshot.
  const trimmed = normalized.slice(0, quizSpec.count);

  const title = String(parsed.title || "اختبار مولد").trim() || "اختبار مولد";
  return { title, language: "ar", questions: trimmed };
}

aiRouter.post("/api/ai/generate-quiz", auth, async (req, res) => {
  try {
    const { message, history, contextText, contextData } = req.body || {};
    const quizSpec = normalizeQuizSpec(req.body && req.body.quizSpec);

    const structuredContext = resolveStructuredContext(contextText, contextData);

    const userIntent =
      cleanContextText(message, MAX_CHAT_MESSAGE_CHARS) ||
      "Generate the quiz based on the rules above.";

    const messages = Array.isArray(history) ? [...history] : [];
    messages.push({ role: "user", content: userIntent });

    const systemPrompt = buildQuizSystemPrompt(
      quizSpec,
      structuredContext,
      req.body && req.body.subjectScope
    );

    let responseText = await withRouteTimeout(
      generateChatResponse(
        messages,
        systemPrompt,
        { type: "json_object" },
        { totalTimeoutMs: AI_REQUEST_TIMEOUT_MS }
      ),
      AI_REQUEST_TIMEOUT_MS + 1000,
      "AI quiz generation request timed out."
    );

    responseText = stripJsonFences(responseText);

    let parsed;
    try {
      parsed = JSON.parse(responseText);
    } catch (parseError) {
      return res.status(502).json({
        error: "تعذّر قراءة استجابة الذكاء الاصطناعي. حاول مرة أخرى.",
        code: "AI_INVALID_JSON",
      });
    }

    const quiz = validateAndNormalizeQuizPayload(parsed, quizSpec);
    res.json({
      quiz: {
        ...quiz,
        spec: quizSpec,
      },
    });
  } catch (e) {
    respondAiError(res, e);
  }
});

aiRouter.get("/api/ai/limits", auth, async (req, res) => {
  try {
    const provider = await AIProvider.findOne({ isActive: true })
      .sort({ priority: 1 })
      .lean();

    if (!provider) {
      return res.json({
        maxInputChars: 0,
        perMessageCap: 0,
        providerName: null,
        hasActiveProvider: false,
      });
    }

    const maxInputChars =
      Number.isFinite(provider.maxInputChars) && provider.maxInputChars > 0
        ? provider.maxInputChars
        : getDefaultMaxInputCharsFor(provider.providerName);

    const perMessageCap = Math.min(
      Math.max(2000, Math.floor(maxInputChars * 0.6)),
      8000
    );

    res.json({
      maxInputChars,
      perMessageCap,
      providerName: provider.providerName,
      hasActiveProvider: true,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = aiRouter;
