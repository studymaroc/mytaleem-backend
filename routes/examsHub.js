const express = require("express");
const mongoose = require("mongoose");
const Subject = require("../models/module");
const User = require("../models/user");
const ExamSection = require("../models/examSection");
const auth = require("../middlewares/auth");
const { recordExamSolved } = require("../utils/gamification");

const examsHubRouter = express.Router();

const EXAM_TYPE_NATIONAL = "national";
const EXAM_TYPE_REGIONAL = "regional";
const EXAM_TYPE_PREP = "prep";
const EXAM_LEVEL_FIRST = "first_bac";
const EXAM_LEVEL_SECOND = "second_bac";

function getTrimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeExamType(value) {
  if (typeof value !== "string") return null;
  const clean = value.trim().toLowerCase();
  if (
    clean !== EXAM_TYPE_NATIONAL &&
    clean !== EXAM_TYPE_REGIONAL &&
    clean !== EXAM_TYPE_PREP
  ) {
    return null;
  }
  return clean;
}

function normalizeExamLevel(value) {
  if (typeof value !== "string") return null;
  const clean = value.trim().toLowerCase();
  if (clean !== EXAM_LEVEL_FIRST && clean !== EXAM_LEVEL_SECOND) {
    return null;
  }
  return clean;
}

function normalizeExamYear(value) {
  if (value === null || typeof value === "undefined" || value === "") {
    return null;
  }
  const parsed = Number.parseInt(String(value).trim(), 10);
  if (Number.isNaN(parsed) || parsed < 1900 || parsed > 2200) {
    return null;
  }
  return parsed;
}

function inferLevelFromStudyYear(value) {
  const clean = String(value || "").trim().toLowerCase();
  if (
    clean.includes("الاولى") ||
    clean.includes("الأولى") ||
    clean.includes("first") ||
    clean.includes("1st")
  ) {
    return EXAM_LEVEL_FIRST;
  }
  if (
    clean.includes("الثانية") ||
    clean.includes("second") ||
    clean.includes("2nd")
  ) {
    return EXAM_LEVEL_SECOND;
  }
  return null;
}

function resolveExamType(exam) {
  return normalizeExamType(exam.examType) || EXAM_TYPE_PREP;
}

function resolveExamLevel(exam, moduleYear) {
  const explicitLevel = normalizeExamLevel(exam.level);
  if (explicitLevel) return explicitLevel;

  const inferredLevel = inferLevelFromStudyYear(moduleYear);
  if (inferredLevel) return inferredLevel;

  const type = resolveExamType(exam);
  if (type === EXAM_TYPE_NATIONAL) return EXAM_LEVEL_SECOND;
  if (type === EXAM_TYPE_REGIONAL) return EXAM_LEVEL_FIRST;

  return EXAM_LEVEL_SECOND;
}

function isTypeLevelCompatible(type, level) {
  if (type === EXAM_TYPE_NATIONAL) return level === EXAM_LEVEL_SECOND;
  if (type === EXAM_TYPE_REGIONAL) return level === EXAM_LEVEL_FIRST;
  return true;
}

function resolveExamPdfUrl(exam) {
  return getTrimmed(exam.examPdfUrl) || getTrimmed(exam.link);
}

function resolveSolutionPdfUrl(exam) {
  return getTrimmed(exam.solutionPdfUrl) || getTrimmed(exam.solutionLink);
}

function toExamPayload(exam, module, solvedSet) {
  const id = String(exam._id);
  const examType = resolveExamType(exam);
  const level = resolveExamLevel(exam, module.year);

  return {
    id,
    name: exam.name || "",
    title: exam.title || "",
    examType,
    level,
    examYear: normalizeExamYear(exam.examYear),
    examPdfUrl: resolveExamPdfUrl(exam),
    solutionPdfUrl: resolveSolutionPdfUrl(exam),
    sourceMode: exam.sourceMode || "upload",
    sectionId: exam.sectionId ? String(exam.sectionId) : null,
    moduleName: module.name,
    speciality: module.speciality,
    studyYear: module.year,
    isSolved: solvedSet.has(id),
  };
}

examsHubRouter.get("/api/exams/hub", auth, async (req, res) => {
  try {
    const [sections, counts] = await Promise.all([
      ExamSection.find({ isActive: true }).sort({ order: 1, createdAt: 1 }).lean(),
      Subject.aggregate([
        { $unwind: "$exames" },
        { $match: { "exames.sectionId": { $ne: null } } },
        { $group: { _id: "$exames.sectionId", n: { $sum: 1 } } },
      ]),
    ]);
    const countMap = new Map(counts.map((c) => [String(c._id), c.n]));

    res.json({
      sections: sections.map((s) => ({
        id: String(s._id),
        title: s.title,
        description: s.description || "",
        icon: s.icon || "assignment",
        colorHex: s.colorHex || "#7C4DFF",
        order: s.order || 0,
        totalExams: countMap.get(String(s._id)) || 0,
      })),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

examsHubRouter.get("/api/exams/list", auth, async (req, res) => {
  try {
    const requestedSectionId = getTrimmed(req.query.sectionId);
    const requestedType = normalizeExamType(req.query.type);
    const requestedLevel = normalizeExamLevel(req.query.level);
    const cleanSubject = getTrimmed(req.query.subject);
    const cleanSpeciality = getTrimmed(req.query.speciality);
    const cleanStudyYear = getTrimmed(req.query.studyYear);

    if (
      requestedSectionId &&
      !mongoose.Types.ObjectId.isValid(requestedSectionId)
    ) {
      return res.status(400).json({ msg: "sectionId is invalid." });
    }

    if (!requestedSectionId && !requestedType) {
      return res
        .status(400)
        .json({ msg: "sectionId or type is required." });
    }

    if (!requestedSectionId && !cleanSubject) {
      return res.status(400).json({ msg: "subject is required." });
    }

    const hasExamYearFilter = Object.prototype.hasOwnProperty.call(req.query, "examYear");
    const requestedExamYear = hasExamYearFilter ? normalizeExamYear(req.query.examYear) : null;

    if (hasExamYearFilter && requestedExamYear === null) {
      return res.status(400).json({ msg: "examYear is invalid." });
    }

    const query = {};
    if (requestedSectionId) {
      query["exames.sectionId"] = new mongoose.Types.ObjectId(requestedSectionId);
    }
    if (cleanSubject) query.name = cleanSubject;
    if (cleanSpeciality) query.speciality = cleanSpeciality;
    if (cleanStudyYear) query.year = cleanStudyYear;

    const [modules, user] = await Promise.all([
      Subject.find(query, "name speciality year exames").lean(),
      User.findById(req.user).select("solvedExams").lean(),
    ]);

    const solvedSet = new Set((user?.solvedExams || []).map((id) => String(id)));
    const items = [];

    for (const module of modules) {
      const exams = Array.isArray(module.exames) ? module.exames : [];
      for (const exam of exams) {
        const payload = toExamPayload(exam, module, solvedSet);
        if (
          requestedSectionId &&
          payload.sectionId !== requestedSectionId
        ) {
          continue;
        }
        if (!requestedSectionId && payload.examType !== requestedType) continue;
        if (requestedLevel && payload.level !== requestedLevel) continue;
        if (requestedExamYear !== null && payload.examYear !== requestedExamYear) continue;
        items.push(payload);
      }
    }

    items.sort((a, b) => {
      const byYear = (b.examYear || 0) - (a.examYear || 0);
      if (byYear !== 0) return byYear;
      return a.name.localeCompare(b.name);
    });

    res.json({ items });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

examsHubRouter.get("/api/exams/:examId", auth, async (req, res) => {
  try {
    const examId = getTrimmed(req.params.examId);
    if (!mongoose.Types.ObjectId.isValid(examId)) {
      return res.status(400).json({ msg: "examId is invalid." });
    }

    const [module, user] = await Promise.all([
      Subject.findOne({ "exames._id": examId }),
      User.findById(req.user).select("solvedExams").lean(),
    ]);

    if (!module) {
      return res.status(404).json({ msg: "Exam not found." });
    }

    const exam = module.exames.id(examId);
    if (!exam) {
      return res.status(404).json({ msg: "Exam not found." });
    }

    const solvedSet = new Set((user?.solvedExams || []).map((id) => String(id)));
    res.json(toExamPayload(exam, module, solvedSet));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

examsHubRouter.post("/api/exams/:examId/solve", auth, async (req, res) => {
  try {
    const examId = getTrimmed(req.params.examId);
    if (!mongoose.Types.ObjectId.isValid(examId)) {
      return res.status(400).json({ msg: "examId is invalid." });
    }

    const examExists = await Subject.exists({ "exames._id": examId });
    if (!examExists) {
      return res.status(404).json({ msg: "Exam not found." });
    }

    const journey = await recordExamSolved(req.user, examId);
    const user = await User.findById(req.user).select(
      "solvedExams solvedExamsCount completedLessonsCount xp streakCount earnedBadges featuredBadgeKey"
    );

    if (!user) {
      return res.status(404).json({ msg: "User not found." });
    }

    const solvedExams = (user.solvedExams || []).map((id) => String(id));
    const completedLessonsCount = user.completedLessonsCount || 0;
    const solvedExamsCount = user.solvedExamsCount || 0;

    res.json({
      examId,
      solved: solvedExams.includes(examId),
      solvedExams,
      solvedExamsCount,
      completedLessonsCount,
      totalProgressCount: completedLessonsCount + solvedExamsCount,
      journey,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = examsHubRouter;
