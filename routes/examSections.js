const express = require("express");
const mongoose = require("mongoose");
const ExamSection = require("../models/examSection");
const Subject = require("../models/module");
const User = require("../models/user");
const auth = require("../middlewares/auth");
const adminAuth = require("../middlewares/adminAuth");

const examSectionsRouter = express.Router();

function getTrimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

function resolveExamPdfUrl(exam) {
  return getTrimmed(exam.examPdfUrl) || getTrimmed(exam.link);
}

function resolveSolutionPdfUrl(exam) {
  return getTrimmed(exam.solutionPdfUrl) || getTrimmed(exam.solutionLink);
}

function toExamPayload(exam, module, solvedSet) {
  const id = String(exam._id);
  return {
    id,
    name: exam.name || "",
    title: exam.title || "",
    examType: exam.examType || "",
    level: exam.level || "",
    examYear:
      exam.examYear === null || typeof exam.examYear === "undefined"
        ? null
        : Number(exam.examYear),
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

async function countExamsBySectionId(sectionId) {
  const result = await Subject.aggregate([
    { $unwind: "$exames" },
    { $match: { "exames.sectionId": new mongoose.Types.ObjectId(sectionId) } },
    { $count: "n" },
  ]);
  return result[0]?.n || 0;
}

// Public list (active only). Optional ?includeInactive=true for admins.
examSectionsRouter.get("/api/exam-sections", auth, async (req, res) => {
  try {
    const includeInactive = String(req.query.includeInactive || "") === "true";
    let isAdmin = false;
    if (includeInactive) {
      const user = await User.findById(req.user).select("type").lean();
      isAdmin = user?.type === "admin";
    }
    const filter = includeInactive && isAdmin ? {} : { isActive: true };
    const sections = await ExamSection.find(filter).sort({ order: 1, createdAt: 1 }).lean();

    // Aggregate counts per section in one pass
    const counts = await Subject.aggregate([
      { $unwind: "$exames" },
      { $match: { "exames.sectionId": { $ne: null } } },
      { $group: { _id: "$exames.sectionId", n: { $sum: 1 } } },
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
        isActive: s.isActive !== false,
        totalExams: countMap.get(String(s._id)) || 0,
      })),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Flat list of exams in a section
examSectionsRouter.get("/api/exam-sections/:id/exams", auth, async (req, res) => {
  try {
    const sectionId = getTrimmed(req.params.id);
    if (!mongoose.Types.ObjectId.isValid(sectionId)) {
      return res.status(400).json({ msg: "sectionId is invalid." });
    }

    const [section, modules, user] = await Promise.all([
      ExamSection.findById(sectionId).lean(),
      Subject.find({ "exames.sectionId": sectionId }, "name speciality year exames").lean(),
      User.findById(req.user).select("solvedExams").lean(),
    ]);

    if (!section) {
      return res.status(404).json({ msg: "Section not found." });
    }

    const solvedSet = new Set((user?.solvedExams || []).map((id) => String(id)));
    const items = [];
    for (const module of modules) {
      const exams = Array.isArray(module.exames) ? module.exames : [];
      for (const exam of exams) {
        if (!exam.sectionId || String(exam.sectionId) !== sectionId) continue;
        items.push(toExamPayload(exam, module, solvedSet));
      }
    }

    items.sort((a, b) => {
      const byYear = (b.examYear || 0) - (a.examYear || 0);
      if (byYear !== 0) return byYear;
      return a.name.localeCompare(b.name);
    });

    res.json({
      section: {
        id: String(section._id),
        title: section.title,
        description: section.description || "",
        icon: section.icon || "assignment",
        colorHex: section.colorHex || "#7C4DFF",
      },
      items,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin CRUD
examSectionsRouter.post("/api/exam-sections", adminAuth, async (req, res) => {
  try {
    const title = getTrimmed(req.body.title);
    if (!title) return res.status(400).json({ msg: "العنوان مطلوب" });

    const exists = await ExamSection.findOne({ title });
    if (exists) return res.status(409).json({ msg: "اسم القسم مستخدم بالفعل" });

    const lastOrder = await ExamSection.findOne().sort({ order: -1 }).select("order").lean();
    const section = await ExamSection.create({
      title,
      description: getTrimmed(req.body.description),
      icon: getTrimmed(req.body.icon) || "assignment",
      colorHex: getTrimmed(req.body.colorHex) || "#7C4DFF",
      order:
        typeof req.body.order === "number"
          ? req.body.order
          : (lastOrder?.order || 0) + 1,
      isActive: req.body.isActive !== false,
    });
    res.status(201).json(section);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

examSectionsRouter.patch("/api/exam-sections/:id", adminAuth, async (req, res) => {
  try {
    const id = getTrimmed(req.params.id);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ msg: "sectionId غير صحيح" });
    }
    const update = {};
    if (typeof req.body.title === "string") {
      const t = getTrimmed(req.body.title);
      if (!t) return res.status(400).json({ msg: "العنوان مطلوب" });
      update.title = t;
    }
    if (typeof req.body.description === "string") update.description = getTrimmed(req.body.description);
    if (typeof req.body.icon === "string") update.icon = getTrimmed(req.body.icon) || "assignment";
    if (typeof req.body.colorHex === "string") update.colorHex = getTrimmed(req.body.colorHex) || "#7C4DFF";
    if (typeof req.body.order === "number") update.order = req.body.order;
    if (typeof req.body.isActive === "boolean") update.isActive = req.body.isActive;

    const section = await ExamSection.findByIdAndUpdate(id, update, { new: true });
    if (!section) return res.status(404).json({ msg: "القسم غير موجود" });
    res.json(section);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ msg: "اسم القسم مستخدم بالفعل" });
    }
    res.status(500).json({ error: error.message });
  }
});

// Soft delete (deactivate). Refuses if exams still reference it.
examSectionsRouter.delete("/api/exam-sections/:id", adminAuth, async (req, res) => {
  try {
    const id = getTrimmed(req.params.id);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ msg: "sectionId غير صحيح" });
    }
    const examCount = await countExamsBySectionId(id);
    const hardDelete = String(req.query.hard || "") === "true";
    if (hardDelete && examCount > 0) {
      return res.status(409).json({ msg: "لا يمكن حذف قسم يحتوي على امتحانات" });
    }
    if (hardDelete) {
      const removed = await ExamSection.findByIdAndDelete(id);
      if (!removed) return res.status(404).json({ msg: "القسم غير موجود" });
      return res.json({ deleted: true });
    }
    const section = await ExamSection.findByIdAndUpdate(id, { isActive: false }, { new: true });
    if (!section) return res.status(404).json({ msg: "القسم غير موجود" });
    res.json({ deactivated: true, section });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

examSectionsRouter.post("/api/exam-sections/reorder", adminAuth, async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    if (!ids.length) return res.status(400).json({ msg: "ids مطلوبة" });
    const ops = ids.map((id, index) => ({
      updateOne: {
        filter: { _id: id },
        update: { order: index },
      },
    }));
    await ExamSection.bulkWrite(ops);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = examSectionsRouter;
