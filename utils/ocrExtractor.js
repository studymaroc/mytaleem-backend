const { generateChatResponse } = require("./aiRouter");

const MAX_IMAGES_PER_REQUEST = 6;
const OCR_TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS || 60000);

/**
 * Extracts text from base64-encoded PNG images using the AI provider as an OCR
 * engine. The AI model receives the images and is asked to extract all visible
 * text accurately, preserving Arabic, French, and English.
 *
 * This replaces the old Tesseract-based OCR and provides significantly better
 * Arabic script recognition.
 */
async function extractTextFromImages(images, opts = {}) {
  const { moduleName = "", lessonTitle = "" } = opts;

  if (!Array.isArray(images) || images.length === 0) {
    throw new Error("No images provided for OCR.");
  }

  const validImages = images
    .filter(
      (img) =>
        img &&
        typeof img.base64Png === "string" &&
        img.base64Png.length > 100 &&
        typeof img.pageNumber === "number"
    )
    .slice(0, MAX_IMAGES_PER_REQUEST);

  if (validImages.length === 0) {
    throw new Error("No valid images provided for OCR.");
  }

  const results = [];

  // Process images one at a time for reliability (some providers have
  // limited vision support). We could batch later if the provider supports it.
  for (const img of validImages) {
    try {
      const extractedText = await extractSinglePageText(
        img.base64Png,
        img.pageNumber,
        { moduleName, lessonTitle }
      );

      results.push({
        pageNumber: img.pageNumber,
        text: extractedText,
        confidence: estimateConfidence(extractedText),
      });
    } catch (e) {
      console.error(
        `OCR failed for page ${img.pageNumber}:`,
        e.message || e
      );
      results.push({
        pageNumber: img.pageNumber,
        text: "",
        confidence: 0,
        error: e.message || "Unknown OCR error.",
      });
    }
  }

  return {
    pages: results,
    extractionMeta: {
      source: "ai_vision_ocr",
      pageCount: results.filter((r) => r.text).length,
      totalPages: validImages.length,
    },
  };
}

/**
 * Sends a single page image to the AI provider and asks it to extract text.
 * Uses a carefully crafted prompt to maximize Arabic text accuracy.
 */
async function extractSinglePageText(base64Png, pageNumber, opts = {}) {
  const { moduleName, lessonTitle } = opts;

  const contextHints = [
    moduleName ? `Subject: ${moduleName}` : "",
    lessonTitle ? `Lesson: ${lessonTitle}` : "",
  ]
    .filter(Boolean)
    .join(". ");

  const systemPrompt = [
    "You are an expert OCR engine specialized in Arabic, French, and English document text extraction.",
    "Your task is to extract ALL visible text from the provided page image as accurately as possible.",
    "",
    "CRITICAL RULES:",
    "1. Extract EVERY word exactly as it appears — do NOT summarize, paraphrase, or skip any text.",
    "2. Preserve the original language (Arabic, French, English, or mixed).",
    "3. Maintain logical reading order: for Arabic text, right-to-left; for Latin text, left-to-right.",
    "4. Preserve paragraph breaks with blank lines.",
    "5. Preserve headings, bullet points, and numbered lists.",
    "6. For Arabic text, ensure proper letter joining and diacritical marks are preserved.",
    "7. Skip headers/footers that are repeated page decorations (page number, document title in footer).",
    "8. Output ONLY the extracted text — no commentary, no explanations, no formatting markers.",
    "",
    contextHints ? `Document context: ${contextHints}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  // Build the message with the image (using the standard OpenAI vision format
  // which is also supported by Groq, OpenRouter, and Mistral)
  const userMessage = {
    role: "user",
    content: [
      {
        type: "image_url",
        image_url: {
          url: `data:image/png;base64,${base64Png}`,
          detail: "high",
        },
      },
      {
        type: "text",
        text: `Extract all text from this page image (page ${pageNumber}). Output only the extracted text, nothing else.`,
      },
    ],
  };

  const responseText = await generateChatResponse(
    [userMessage],
    systemPrompt,
    null,
    { totalTimeoutMs: OCR_TIMEOUT_MS, providerTimeoutMs: OCR_TIMEOUT_MS }
  );

  return cleanOcrOutput(responseText);
}

/**
 * Cleans the AI output to remove any commentary the model might have added.
 */
function cleanOcrOutput(text) {
  if (!text || typeof text !== "string") {
    return "";
  }

  let cleaned = text.trim();

  // Remove markdown code block wrappers if the model added them
  if (cleaned.startsWith("```")) {
    cleaned = cleaned
      .replace(/^```[a-z]*\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
  }

  // Remove common AI prefixes
  const prefixPatterns = [
    /^(here'?s?\s+(is\s+)?the\s+(extracted\s+)?text[:\s]*)/i,
    /^(text\s+extracted\s+(from\s+)?[:\s]*)/i,
    /^(the\s+text\s+in\s+the\s+image[:\s]*)/i,
    /^(extracted\s+text[:\s]*)/i,
    /^(page\s+\d+\s*[:\-]\s*)/i,
    /^(النص المستخرج[:\s]*)/u,
  ];

  for (const pattern of prefixPatterns) {
    cleaned = cleaned.replace(pattern, "").trim();
  }

  // Normalize whitespace
  cleaned = cleaned
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return cleaned;
}

/**
 * Rough confidence estimate based on extracted text properties.
 */
function estimateConfidence(text) {
  if (!text || typeof text !== "string") {
    return 0;
  }

  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 3) {
    return 0.2;
  }

  const avgWordLength =
    words.reduce((sum, w) => sum + [...w].length, 0) / words.length;

  let confidence = 0.7;

  if (words.length > 20) confidence += 0.1;
  if (words.length > 50) confidence += 0.05;
  if (avgWordLength > 3) confidence += 0.1;
  if (avgWordLength < 2) confidence -= 0.2;

  return Math.min(1.0, Math.max(0.1, confidence));
}

module.exports = { extractTextFromImages };
