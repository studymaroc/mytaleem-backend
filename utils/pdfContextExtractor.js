const axios = require("axios");

const EXTRACTOR_VERSION = "pdfjs_rtl_v2";
const MAX_RANGE_PAGES = 10;
const PAGE_EXTRACTION_CONCURRENCY = 3;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_SIZE = 180;

const ARABIC_CHAR_REGEX =
  /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/u;
const ARABIC_JOIN_SPACE_REGEX =
  /(?<=[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF])\s+(?=[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF])/gu;
const STANDALONE_DIACRITICS_REGEX =
  /^[\u064B-\u065F\u0670\u06D6-\u06ED]+$/u;
const DECORATION_ONLY_REGEX = /^[]+$/u;
const ARABIC_SINGLE_TOKEN_REGEX = /^[\u0600-\u06FF]$/u;

const pdfBufferCache = new Map();
const pdfPageSnapshotCache = new Map();
let pdfjsModulePromise = null;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizeSelectionMode(value) {
  switch (String(value || "").trim()) {
    case "page_range":
      return "page_range";
    case "whole_document":
      return "whole_document";
    case "current_page":
    default:
      return "current_page";
  }
}

function countMatches(value, pattern) {
  return (value.match(pattern) || []).length;
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g,
      ""
    )
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripEdgePunctuation(value) {
  return String(value || "").replace(
    /^[^\w\u0600-\u06FF]+|[^\w\u0600-\u06FF]+$/gu,
    ""
  );
}

function isArabicHeavy(value) {
  return (
    countMatches(value, /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/gu) >
    countMatches(value, /[A-Za-z]/g)
  );
}

function reverseString(value) {
  return [...value].reverse().join("");
}

function applyHighConfidenceReplacements(value) {
  return String(value || "")
    .replace(/الله(?:لله)+/gu, "الله")
    .replace(/صلى ا عليه وسلم/gu, "صلى الله عليه وسلم")
    .replace(/رسول ا صلى/gu, "رسول الله صلى")
    .replace(/يا رسول ا/gu, "يا رسول الله")
    .replace(/رضي ا عنه/gu, "رضي الله عنه")
    .replace(/قال ا تبارك/gu, "قال الله تبارك")
    .replace(/قال ا تعالى/gu, "قال الله تعالى")
    .replace(/قَال ا تَبَارَك وَتَعَالَى:/gu, "قال الله تبارك وتعالى:")
    .replace(/إلى\s*(\d+)/gu, "إلى $1")
    .replace(
      /من\s+الآية\s+(\d+)\s+إلى\s+الآية\s+(\d+)/gu,
      "من الآية $1 إلى الآية $2"
    );
}

function cleanLineText(value) {
  return applyHighConfidenceReplacements(normalizeText(value))
    .replace(/\s+([،؛,.!?:٪%»\]\)])/gu, "$1")
    .replace(/([«\[\(])\s+/gu, "$1")
    .replace(/﴿\s+/gu, "﴿")
    .replace(/\s+﴾/gu, "﴾")
    .replace(/﴾(?=\S)/gu, "﴾ ")
    .replace(/\)\s+(\d+)/gu, "$1)")
    .replace(/\[\s+(\d+)/gu, "[$1")
    .replace(/([0-9\u0660-\u0669])\)\s*([^()\n]{4,90})\(/gu, "$1 ($2)")
    .trim();
}

function truncateText(value, maxChars) {
  const text = cleanLineText(value);
  if (!text || text.length <= maxChars) {
    return text;
  }

  const truncated = text.slice(0, maxChars);
  const lastBreak = Math.max(truncated.lastIndexOf("\n"), truncated.lastIndexOf(" "));
  const safeBreak = lastBreak > maxChars * 0.6 ? lastBreak : maxChars;
  return `${truncated.slice(0, safeBreak).trim()}\n...`;
}

function normalizeItemText(rawValue) {
  const raw = String(rawValue || "");
  const hadNull = raw.includes("\u0000");
  let text = raw
    .normalize("NFKC")
    .replace(/\u0000/g, "")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .trim();

  if (!text) {
    return "";
  }

  if (STANDALONE_DIACRITICS_REGEX.test(text) || DECORATION_ONLY_REGEX.test(text)) {
    return "";
  }

  if (hadNull) {
    text = text.replace(ARABIC_JOIN_SPACE_REGEX, "");
  } else if (isArabicHeavy(text) && /\s/.test(text) && !/[0-9A-Za-z]/.test(text)) {
    text = reverseString(text);
  }

  return cleanLineText(text);
}

function needsSpaceBetween(currentText, nextText, gap) {
  if (!currentText || !nextText) {
    return false;
  }
  if (/^[،؛,.!?:٪%»\]\)]+$/u.test(nextText)) {
    return false;
  }
  if (/^[«\[\(]+$/u.test(currentText)) {
    return false;
  }
  if (/^[\-_\/]+$/.test(currentText) || /^[\-_\/]+$/.test(nextText)) {
    return true;
  }
  if (gap > 1.5) {
    return true;
  }
  return /[\u0600-\u06FFA-Za-z0-9]$/u.test(currentText) &&
    /^[\u0600-\u06FFA-Za-z0-9]/u.test(nextText);
}

function groupItemsIntoLines(items) {
  const sortedItems = [...items].sort((a, b) => {
    const verticalDiff = Math.abs(b.y - a.y);
    if (verticalDiff > 2) {
      return b.y - a.y;
    }
    return a.x - b.x;
  });

  const lines = [];
  for (const item of sortedItems) {
    let line = null;
    for (const candidate of lines) {
      const tolerance = Math.max(2, item.height * 0.45);
      if (Math.abs(candidate.y - item.y) <= tolerance) {
        line = candidate;
        break;
      }
    }

    if (!line) {
      lines.push({
        y: item.y,
        items: [item],
      });
      continue;
    }

    line.items.push(item);
    line.y = (line.y * (line.items.length - 1) + item.y) / line.items.length;
  }

  return lines.sort((a, b) => b.y - a.y);
}

function getRepeatedLineKey(text) {
  const normalized = cleanLineText(text)
    .replace(/[0-9\u0660-\u0669]+/gu, "#")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized || normalized.length < 10 || normalized.length > 160) {
    return "";
  }

  return normalized;
}

function dedupeLikelyRepeatedLines(lines) {
  const seenKeys = new Set();
  const result = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const key = getRepeatedLineKey(line.text);
    if (key && index < 6 && seenKeys.has(key)) {
      continue;
    }

    if (key) {
      seenKeys.add(key);
    }
    result.push(line);
  }

  return result;
}

function buildLineText(line) {
  const rtlCount = line.items.filter(
    (item) => item.dir === "rtl" || isArabicHeavy(item.text)
  ).length;
  const rtlPreferred = rtlCount >= line.items.length - rtlCount;

  const orderedItems = [...line.items].sort((a, b) =>
    rtlPreferred ? b.x - a.x : a.x - b.x
  );

  let result = "";
  for (let index = 0; index < orderedItems.length; index += 1) {
    const current = orderedItems[index];
    const next = orderedItems[index + 1];
    result += current.text;

    if (!next) {
      continue;
    }

    const gap = rtlPreferred
      ? current.x - (next.x + next.width)
      : next.x - (current.x + current.width);

    if (needsSpaceBetween(current.text, next.text, gap)) {
      result += " ";
    }
  }

  return cleanLineText(result);
}

function looksLikeHeading(value) {
  const text = cleanLineText(value);
  if (text.length < 4 || text.length > 120) {
    return false;
  }

  const words = text.split(/\s+/).filter(Boolean);
  if (words.length > 14) {
    return false;
  }

  if (/^[0-9\u0660-\u0669\s().,:;_\-]+$/u.test(text)) {
    return false;
  }

  const letterCount = countMatches(text, /[A-Za-z\u0600-\u06FF]/gu);
  if (letterCount < Math.max(3, Math.floor(text.length / 4))) {
    return false;
  }

  return countMatches(text, /[،؛,.:!?()\[\]{}_\-]/g) < text.length / 3;
}

function extractHeadingCandidates(lines, pageText) {
  const fontSizes = lines
    .map((line) => line.maxHeight)
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  const medianFontSize = fontSizes.length
    ? fontSizes[Math.floor(fontSizes.length / 2)]
    : 0;

  const candidates = [];
  for (const line of lines) {
    const text = cleanLineText(line.text);
    if (!looksLikeHeading(text)) {
      continue;
    }

    let score = line.maxHeight;
    if (line.maxHeight >= medianFontSize + 0.5) {
      score += 6;
    }
    if (line.y >= 520) {
      score += 4;
    }
    if (text.length <= 60) {
      score += 2;
    }
    if (isArabicHeavy(text) || /[A-Za-z]/.test(text)) {
      score += 1;
    }

    candidates.push({ text, score, y: line.y });
  }

  if (!candidates.length) {
    for (const line of lines.slice(0, 5)) {
      const text = cleanLineText(line.text);
      if (looksLikeHeading(text)) {
        candidates.push({ text, score: 1, y: line.y });
      }
    }
  }

  if (!candidates.length) {
    return pageText
      .split("\n")
      .map(cleanLineText)
      .filter(looksLikeHeading)
      .slice(0, 2);
  }

  candidates.sort((a, b) => {
    const scoreDiff = b.score - a.score;
    if (scoreDiff !== 0) {
      return scoreDiff;
    }
    return b.y - a.y;
  });

  const result = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const key = candidate.text.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(candidate.text);
    if (result.length === 4) {
      break;
    }
  }
  return result;
}

function assessTextQuality({ text, headingCount = 0, pageCount = 1 }) {
  const normalized = cleanLineText(text);
  if (!normalized) {
    return {
      qualityScore: 0,
      qualityFlags: ["no_text"],
      needsOcrFallback: true,
    };
  }

  const lines = normalized.split("\n").map(cleanLineText).filter(Boolean);
  const rawWords = normalized.split(/\s+/).filter(Boolean);
  const words = rawWords.map(stripEdgePunctuation).filter(Boolean);

  const tokenCount = words.length;
  const singleCharTokens = words.filter((word) => [...word].length <= 1).length;
  const isolatedArabicTokens = words.filter((word) =>
    ARABIC_SINGLE_TOKEN_REGEX.test(word)
  ).length;
  const shortLines = lines.filter((line) => stripEdgePunctuation(line).length <= 8).length;
  const strongLines = lines.filter((line) => stripEdgePunctuation(line).length >= 24).length;
  const repeatedLines = new Set(lines.map(getRepeatedLineKey).filter(Boolean)).size;
  const uniqueLineRatio = lines.length ? repeatedLines / lines.length : 0;
  const averageWordLength = words.length
    ? words.reduce((sum, word) => sum + [...word].length, 0) / words.length
    : 0;
  const isolatedTokenRatio = tokenCount ? singleCharTokens / tokenCount : 1;
  const isolatedArabicRatio = tokenCount ? isolatedArabicTokens / tokenCount : 1;
  const fragmentedLineRatio = lines.length ? shortLines / lines.length : 1;
  const strongLineRatio = lines.length ? strongLines / lines.length : 0;

  const flags = [];
  let score = 100;

  if (tokenCount < 12) {
    score -= 38;
    flags.push("too_little_text");
  }
  if (isolatedTokenRatio > 0.28) {
    score -= 34;
    flags.push("isolated_tokens");
  } else if (isolatedTokenRatio > 0.18) {
    score -= 18;
    flags.push("many_short_tokens");
  }
  if (isolatedArabicRatio > 0.12) {
    score -= 26;
    flags.push("isolated_arabic_letters");
  }
  if (averageWordLength < 2.6) {
    score -= 18;
    flags.push("low_word_coherence");
  }
  if (fragmentedLineRatio > 0.45) {
    score -= 20;
    flags.push("fragmented_lines");
  }
  if (strongLineRatio < 0.22) {
    score -= 10;
    flags.push("weak_line_structure");
  }
  if (lines.length > 8 && headingCount === 0) {
    score -= 6;
    flags.push("no_headings");
  }
  if (lines.length >= 6 && uniqueLineRatio < 0.7) {
    score -= 12;
    flags.push("repeated_layout_noise");
  }
  if (pageCount > 1 && tokenCount / Math.max(pageCount, 1) < 30) {
    score -= 10;
    flags.push("sparse_multi_page_text");
  }

  const qualityScore = clamp(Math.round(score), 0, 100);
  const criticalFlags = new Set([
    "no_text",
    "isolated_tokens",
    "isolated_arabic_letters",
    "fragmented_lines",
    "low_word_coherence",
  ]);
  const needsOcrFallback =
    qualityScore < 58 || flags.some((flag) => criticalFlags.has(flag));

  return {
    qualityScore,
    qualityFlags: [...new Set(flags)],
    needsOcrFallback,
  };
}

function pickBestText(primary, secondary, maxChars) {
  const primaryScore = assessTextQuality({ text: primary }).qualityScore;
  const secondaryScore = assessTextQuality({ text: secondary }).qualityScore;
  const bestText = secondaryScore > primaryScore ? secondary : primary;
  return truncateText(bestText, maxChars);
}

async function getPdfJsModule() {
  if (!pdfjsModulePromise) {
    pdfjsModulePromise = import("pdfjs-dist/legacy/build/pdf.mjs");
  }
  return pdfjsModulePromise;
}

function readCache(cache, cacheKey) {
  const cached = cache.get(cacheKey);
  if (!cached) {
    return null;
  }

  if (Date.now() - cached.createdAt > CACHE_TTL_MS) {
    cache.delete(cacheKey);
    return null;
  }

  return cached.value;
}

function writeCache(cache, cacheKey, value) {
  cache.set(cacheKey, {
    createdAt: Date.now(),
    value,
  });

  if (cache.size <= MAX_CACHE_SIZE) {
    return;
  }

  const entries = [...cache.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
  while (entries.length && cache.size > MAX_CACHE_SIZE) {
    const [oldestKey] = entries.shift();
    cache.delete(oldestKey);
  }
}

async function fetchPdfBuffer(pdfUrl) {
  const cacheKey = JSON.stringify({ version: EXTRACTOR_VERSION, pdfUrl });
  const cachedBuffer = readCache(pdfBufferCache, cacheKey);
  if (cachedBuffer) {
    return {
      bytes: cachedBuffer,
      cacheHit: true,
    };
  }

  const response = await axios.get(pdfUrl, {
    responseType: "arraybuffer",
    timeout: 30000,
    maxRedirects: 5,
    headers: {
      Accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.8",
      "User-Agent": "StudyApp-AIContext/1.0",
    },
  });

  if (!response.data || !response.data.byteLength) {
    throw new Error("PDF file is empty.");
  }

  const bytes = new Uint8Array(response.data);
  writeCache(pdfBufferCache, cacheKey, bytes);
  return {
    bytes,
    cacheHit: false,
  };
}

async function extractRawPageLines(page, disableCombineTextItems) {
  const content = await page.getTextContent({
    disableCombineTextItems,
    includeMarkedContent: false,
  });

  const items = content.items
    .map((item) => ({
      text: normalizeItemText(item.str),
      x: Number(item.transform?.[4] || 0),
      y: Number(item.transform?.[5] || 0),
      width: Math.abs(Number(item.width || 0)),
      height: Math.abs(Number(item.height || item.transform?.[0] || 0)),
      dir: item.dir || "ltr",
    }))
    .filter((item) => item.text);

  const lines = dedupeLikelyRepeatedLines(
    groupItemsIntoLines(items)
      .map((line) => ({
        text: buildLineText(line),
        y: line.y,
        maxHeight: line.items.reduce(
          (largest, item) => Math.max(largest, item.height || 0),
          0
        ),
      }))
      .filter((line) => line.text)
  );

  const joinedText = lines.map((line) => line.text).join("\n");
  return {
    lines,
    text: joinedText,
  };
}

async function extractPageSnapshotFromDocument(doc, pageNumber) {
  const page = await doc.getPage(pageNumber);

  try {
    const primary = await extractRawPageLines(page, true);
    const secondary = await extractRawPageLines(page, false);
    const primaryQuality = assessTextQuality({
      text: primary.text,
      headingCount: primary.lines.length,
    });
    const secondaryQuality = assessTextQuality({
      text: secondary.text,
      headingCount: secondary.lines.length,
    });
    const best = secondaryQuality.qualityScore > primaryQuality.qualityScore
      ? secondary
      : primary;

    const pageText = cleanLineText(best.text);
    const headings = extractHeadingCandidates(best.lines, pageText);
    const quality = assessTextQuality({
      text: pageText,
      headingCount: headings.length,
      pageCount: 1,
    });

    return {
      pageNumber,
      text: pageText,
      headings,
      qualityScore: quality.qualityScore,
      qualityFlags: quality.qualityFlags,
    };
  } finally {
    page.cleanup();
  }
}

async function getPageSnapshot({ doc, pdfUrl, pageNumber }) {
  const cacheKey = JSON.stringify({
    version: EXTRACTOR_VERSION,
    pdfUrl,
    pageNumber,
  });
  const cachedSnapshot = readCache(pdfPageSnapshotCache, cacheKey);
  if (cachedSnapshot) {
    return {
      snapshot: cachedSnapshot,
      cacheHit: true,
    };
  }

  const snapshot = await extractPageSnapshotFromDocument(doc, pageNumber);
  writeCache(pdfPageSnapshotCache, cacheKey, snapshot);
  return {
    snapshot,
    cacheHit: false,
  };
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runWorker() {
    while (true) {
      const currentIndex = cursor;
      cursor += 1;
      if (currentIndex >= items.length) {
        return;
      }
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

function looksLikeBoundaryNoise(text) {
  const normalized = cleanLineText(text);
  if (!normalized || normalized.length < 8 || normalized.length > 180) {
    return false;
  }

  return (
    looksLikeHeading(normalized) ||
    /سورة|الآية|فضاء|التربية|إعدادي|cours|lesson|document|page|الصفحة/iu.test(
      normalized
    )
  );
}

function removeRepeatedBoundaryNoise(snapshots) {
  if (snapshots.length < 2) {
    return snapshots;
  }

  const topFrequency = new Map();
  const bottomFrequency = new Map();

  for (const snapshot of snapshots) {
    const lines = snapshot.text.split("\n").map(cleanLineText).filter(Boolean);
    for (const line of lines.slice(0, 2)) {
      const key = getRepeatedLineKey(line);
      if (key && looksLikeBoundaryNoise(line)) {
        topFrequency.set(key, (topFrequency.get(key) || 0) + 1);
      }
    }
    for (const line of lines.slice(-2)) {
      const key = getRepeatedLineKey(line);
      if (key && looksLikeBoundaryNoise(line)) {
        bottomFrequency.set(key, (bottomFrequency.get(key) || 0) + 1);
      }
    }
  }

  const threshold = Math.max(2, Math.ceil(snapshots.length * 0.6));
  const repeatedTop = new Set(
    [...topFrequency.entries()]
      .filter((entry) => entry[1] >= threshold)
      .map((entry) => entry[0])
  );
  const repeatedBottom = new Set(
    [...bottomFrequency.entries()]
      .filter((entry) => entry[1] >= threshold)
      .map((entry) => entry[0])
  );

  if (!repeatedTop.size && !repeatedBottom.size) {
    return snapshots;
  }

  return snapshots.map((snapshot) => {
    const lines = snapshot.text.split("\n").map(cleanLineText).filter(Boolean);
    while (lines.length && repeatedTop.has(getRepeatedLineKey(lines[0]))) {
      lines.shift();
    }
    while (
      lines.length &&
      repeatedBottom.has(getRepeatedLineKey(lines[lines.length - 1]))
    ) {
      lines.pop();
    }

    return {
      ...snapshot,
      text: cleanLineText(lines.join("\n")),
    };
  });
}

function collectHeadingCandidates(snapshots) {
  const headings = [];
  const seen = new Set();

  for (const snapshot of snapshots) {
    for (const heading of snapshot.headings || []) {
      const normalized = cleanLineText(heading);
      if (!normalized) {
        continue;
      }
      const key = normalized.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      headings.push(normalized);
      if (headings.length === 6) {
        return headings;
      }
    }
  }

  return headings;
}

function composeSelectionText(snapshots, maxTotalChars) {
  if (!snapshots.length) {
    return "";
  }

  const pageBudget = Math.max(220, Math.floor(maxTotalChars / snapshots.length) - 32);
  let result = "";
  let truncated = false;

  for (const snapshot of snapshots) {
    const pageText = truncateText(snapshot.text, pageBudget);
    const pageBlock = `الصفحة ${snapshot.pageNumber}:\n${pageText}`;
    const prefix = result ? "\n\n" : "";

    if (result.length + prefix.length + pageBlock.length > maxTotalChars) {
      const remainingChars = maxTotalChars - result.length - prefix.length - 16;
      if (remainingChars > 80) {
        result += `${prefix}الصفحة ${snapshot.pageNumber}:\n${truncateText(
          snapshot.text,
          remainingChars
        )}`;
      }
      truncated = true;
      break;
    }

    result += `${prefix}${pageBlock}`;
  }

  if (truncated && result.length < maxTotalChars - 40) {
    result += "\n\n...";
  }

  return cleanLineText(result);
}

function resolvePageRange({
  totalPages,
  focusPage,
  requestedStartPage,
  requestedEndPage,
  selectionMode,
}) {
  if (selectionMode === "whole_document" && totalPages <= MAX_RANGE_PAGES) {
    return { startPage: 1, endPage: totalPages };
  }

  if (selectionMode === "current_page") {
    return { startPage: focusPage, endPage: focusPage };
  }

  let startPage = clamp(requestedStartPage || focusPage, 1, totalPages);
  let endPage = clamp(requestedEndPage || startPage, 1, totalPages);

  if (endPage < startPage) {
    [startPage, endPage] = [endPage, startPage];
  }
  if (endPage - startPage + 1 > MAX_RANGE_PAGES) {
    endPage = Math.min(totalPages, startPage + MAX_RANGE_PAGES - 1);
  }

  return { startPage, endPage };
}

function buildPromptContext(contextData) {
  const headingCandidates = Array.isArray(contextData.headingCandidates)
    ? contextData.headingCandidates
    : [];
  const isWholeDocument = contextData.selectionMode === "whole_document";
  const isPageRange = contextData.selectionMode === "page_range";

  const selectionSummary = isWholeDocument
    ? `كامل الملف (${contextData.totalPages} صفحات)`
    : isPageRange
      ? contextData.startPage === contextData.endPage
        ? `الصفحة ${contextData.startPage} من ${contextData.totalPages}`
        : `من الصفحة ${contextData.startPage} إلى الصفحة ${contextData.endPage} من ${contextData.totalPages}`
      : `الصفحة الحالية: ${contextData.currentPage} من ${contextData.totalPages}`;

  const headingLabel = isPageRange || isWholeDocument
    ? "العناوين البارزة في النطاق المختار"
    : "العناوين الظاهرة في الصفحة";

  const primaryTextLabel = isWholeDocument
    ? "النص المستخرج من الملف كاملًا"
    : isPageRange
      ? "النص المستخرج من الصفحات المختارة"
      : "نص الصفحة الحالية";

  return [
    "نوع المصدر: PDF",
    `نطاق السياق: ${selectionSummary}`,
    contextData.moduleName ? `المادة أو الوحدة: ${contextData.moduleName}` : "",
    contextData.lessonTitle ? `عنوان الدرس: ${contextData.lessonTitle}` : "",
    contextData.sectionName ? `اسم القسم أو الملف: ${contextData.sectionName}` : "",
    contextData.documentTitle ? `عنوان المستند: ${contextData.documentTitle}` : "",
    headingCandidates.length
      ? `${headingLabel}: ${headingCandidates.join(" | ")}`
      : "",
    contextData.previousPageText
      ? `سياق من الصفحة السابقة:\n${contextData.previousPageText}`
      : "",
    contextData.currentPageText
      ? `${primaryTextLabel}:\n${contextData.currentPageText}`
      : "",
    contextData.nextPageText
      ? `سياق من الصفحة التالية:\n${contextData.nextPageText}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function ensureHttpUrl(value) {
  const candidate = String(value || "").trim();
  if (!candidate) {
    throw new Error("PDF URL is required.");
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch (_) {
    throw new Error("PDF URL is invalid.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("PDF URL must use http or https.");
  }

  return parsed.toString();
}

async function buildCurrentPageContext({
  doc,
  pdfUrl,
  focusPage,
  totalPages,
  moduleName,
  lessonTitle,
  sectionName,
  documentTitle,
}) {
  const targets = [focusPage];
  if (focusPage > 1) {
    targets.push(focusPage - 1);
  }
  if (focusPage < totalPages) {
    targets.push(focusPage + 1);
  }

  const pageResults = await Promise.all(
    targets.map((pageNumber) => getPageSnapshot({ doc, pdfUrl, pageNumber }))
  );
  const byPage = new Map(
    pageResults.map((result) => [result.snapshot.pageNumber, result])
  );

  const currentSnapshot = byPage.get(focusPage)?.snapshot;
  const previousSnapshot = byPage.get(focusPage - 1)?.snapshot || null;
  const nextSnapshot = byPage.get(focusPage + 1)?.snapshot || null;

  const contextData = {
    sourceType: "pdf",
    moduleName,
    lessonTitle,
    sectionName,
    documentTitle,
    selectionMode: "current_page",
    currentPage: focusPage,
    startPage: focusPage,
    endPage: focusPage,
    totalPages,
    headingCandidates: currentSnapshot?.headings || [],
    previousPageText: truncateText(previousSnapshot?.text || "", 900),
    currentPageText: truncateText(currentSnapshot?.text || "", 2600),
    nextPageText: truncateText(nextSnapshot?.text || "", 900),
  };

  const quality = assessTextQuality({
    text: contextData.currentPageText,
    headingCount: contextData.headingCandidates.length,
    pageCount: 1,
  });

  const cacheHit = [...byPage.values()].every((entry) => entry.cacheHit);
  return {
    contextData,
    extractionMeta: {
      source: EXTRACTOR_VERSION,
      qualityScore: quality.qualityScore,
      qualityFlags: quality.qualityFlags,
      needsOcrFallback: quality.needsOcrFallback,
      cacheHit,
      pageCount: 1,
    },
  };
}

async function buildMultiPageContext({
  doc,
  pdfUrl,
  selectionMode,
  focusPage,
  startPage,
  endPage,
  totalPages,
  moduleName,
  lessonTitle,
  sectionName,
  documentTitle,
}) {
  const pageCount = endPage - startPage + 1;
  const maxTotalChars =
    selectionMode === "whole_document"
      ? 14000
      : Math.min(12000, Math.max(3200, pageCount * 1100));

  const pageNumbers = [];
  for (let pageNumber = startPage; pageNumber <= endPage; pageNumber += 1) {
    pageNumbers.push(pageNumber);
  }

  const pageResults = await mapWithConcurrency(
    pageNumbers,
    PAGE_EXTRACTION_CONCURRENCY,
    async (pageNumber) => getPageSnapshot({ doc, pdfUrl, pageNumber })
  );
  const snapshots = removeRepeatedBoundaryNoise(
    pageResults
      .map((result) => result.snapshot)
      .filter((snapshot) => snapshot.text)
      .sort((a, b) => a.pageNumber - b.pageNumber)
  );

  const headingCandidates = collectHeadingCandidates(snapshots);
  const currentPageText = composeSelectionText(snapshots, maxTotalChars);
  const quality = assessTextQuality({
    text: currentPageText,
    headingCount: headingCandidates.length,
    pageCount,
  });

  return {
    contextData: {
      sourceType: "pdf",
      moduleName,
      lessonTitle,
      sectionName,
      documentTitle,
      selectionMode,
      currentPage: focusPage,
      startPage,
      endPage,
      totalPages,
      headingCandidates,
      previousPageText: "",
      currentPageText,
      nextPageText: "",
    },
    extractionMeta: {
      source: EXTRACTOR_VERSION,
      qualityScore: quality.qualityScore,
      qualityFlags: quality.qualityFlags,
      needsOcrFallback: quality.needsOcrFallback,
      cacheHit: pageResults.every((result) => result.cacheHit),
      pageCount,
    },
  };
}

async function extractPdfAiContext(payload = {}) {
  const startedAt = Date.now();
  const pdfUrl = ensureHttpUrl(payload.pdfUrl);
  const moduleName = normalizeText(payload.moduleName).slice(0, 200);
  const lessonTitle = normalizeText(payload.lessonTitle).slice(0, 200);
  const sectionName = normalizeText(payload.sectionName).slice(0, 200);
  const documentTitle = normalizeText(payload.documentTitle).slice(0, 200);
  const requestedSelectionMode = normalizeSelectionMode(payload.selectionMode);
  const requestedCurrentPage = Number(payload.currentPage || 1);
  const requestedStartPage = Number(payload.startPage || requestedCurrentPage || 1);
  const requestedEndPage = Number(payload.endPage || requestedStartPage || 1);

  const pdfjs = await getPdfJsModule();
  const pdfBuffer = await fetchPdfBuffer(pdfUrl);
  const loadingTask = pdfjs.getDocument({
    data: pdfBuffer.bytes,
    useWorkerFetch: false,
    isEvalSupported: false,
  });
  const doc = await loadingTask.promise;

  try {
    const totalPages = Number(doc.numPages || 0);
    if (totalPages <= 0) {
      throw new Error("PDF has no pages.");
    }

    const currentPage = clamp(requestedCurrentPage || 1, 1, totalPages);
    const selectionMode =
      requestedSelectionMode === "whole_document" && totalPages > MAX_RANGE_PAGES
        ? "page_range"
        : requestedSelectionMode;
    const range = resolvePageRange({
      totalPages,
      focusPage: currentPage,
      requestedStartPage,
      requestedEndPage,
      selectionMode,
    });

    const extracted =
      selectionMode === "current_page"
        ? await buildCurrentPageContext({
            doc,
            pdfUrl,
            focusPage: currentPage,
            totalPages,
            moduleName,
            lessonTitle,
            sectionName,
            documentTitle,
          })
        : await buildMultiPageContext({
            doc,
            pdfUrl,
            selectionMode,
            focusPage: currentPage,
            startPage: range.startPage,
            endPage: range.endPage,
            totalPages,
            moduleName,
            lessonTitle,
            sectionName,
            documentTitle,
          });

    const promptContext = buildPromptContext(extracted.contextData);
    const quality = assessTextQuality({
      text: extracted.contextData.currentPageText,
      headingCount: extracted.contextData.headingCandidates.length,
      pageCount: extracted.extractionMeta.pageCount,
    });
    const qualityFlags = [...new Set([...extracted.extractionMeta.qualityFlags, ...quality.qualityFlags])];

    return {
      contextData: extracted.contextData,
      promptContext,
      extractionMeta: {
        source: EXTRACTOR_VERSION,
        qualityScore: quality.qualityScore,
        qualityFlags,
        needsOcrFallback:
          quality.needsOcrFallback || !extracted.contextData.currentPageText,
        cacheHit: Boolean(extracted.extractionMeta.cacheHit),
        pageCount: extracted.extractionMeta.pageCount,
        durationMs: Date.now() - startedAt,
      },
    };
  } finally {
    await loadingTask.destroy();
  }
}

module.exports = {
  extractPdfAiContext,
};
