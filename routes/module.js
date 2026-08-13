const express = require("express");
const moduleRouter = express.Router();
const mongoose = require("mongoose");
const Subject = require("../models/module");
const ExamSection = require("../models/examSection");
const adminAuth = require("../middlewares/adminAuth");

const SOURCE_MODE_UPLOAD = "upload";
const SOURCE_MODE_DIRECT = "direct_link";
const CONTENT_TYPE_PDF = "pdf";
const CONTENT_TYPE_VIDEO = "video";
const EXAM_TYPE_NATIONAL = "national";
const EXAM_TYPE_REGIONAL = "regional";
const EXAM_TYPE_PREP = "prep";
const EXAM_TYPE_LEGACY_CUSTOM = "custom";
const EXAM_LEVEL_FIRST = "first_bac";
const EXAM_LEVEL_SECOND = "second_bac";

function normalizeSourceMode(mode) {
  if (mode === SOURCE_MODE_DIRECT) return SOURCE_MODE_DIRECT;
  if (mode === SOURCE_MODE_UPLOAD) return SOURCE_MODE_UPLOAD;
  return null;
}

// نوع محتوى الدرس. أي قيمة غير معروفة بترجع pdf عشان السلوك القديم ما يتغيرش.
function normalizeContentType(value) {
  const clean = String(value || "").trim().toLowerCase();
  return clean === CONTENT_TYPE_VIDEO ? CONTENT_TYPE_VIDEO : CONTENT_TYPE_PDF;
}

function normalizeSemester(value) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  if (Number.isNaN(parsed) || parsed < 1 || parsed > 2) return 0;
  return parsed;
}

function normalizeOrder(value) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  if (Number.isNaN(parsed) || parsed < 0) return 0;
  return parsed;
}

// ترتيب الدروس: نحافظ على ترتيب المجموعات (العناوين) زي ما هي،
// وجوّه كل مجموعة نرتب بالـ order لو متحدد.
function sortCoursesWithinGroups(courses) {
  const grouped = sortCoursesByDomain(courses);
  const byTitle = new Map();

  grouped.forEach((course) => {
    const key = (course && course.title) ? course.title.trim() : "الدروس";
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(course);
  });

  const result = [];
  byTitle.forEach((list) => {
    const hasOrder = list.some((c) => Number(c.order) > 0);
    if (hasOrder) {
      list.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
    }
    result.push(...list);
  });

  return result;
}

function isHttpUrl(value = "") {
  try {
    const parsed = new URL(String(value).trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (_) {
    return false;
  }
}

function getTrimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sortCoursesByDomain(courses) {
  if (!Array.isArray(courses) || courses.length === 0) return [];
  const titleOrder = [];
  const titleMap = new Map();

  courses.forEach(course => {
    const t = (course && course.title) ? course.title.trim() : 'الدروس';
    if (!titleMap.has(t)) {
      titleOrder.push(t);
      titleMap.set(t, []);
    }
    titleMap.get(t).push(course);
  });

  const sorted = [];
  titleOrder.forEach(t => {
    sorted.push(...titleMap.get(t));
  });

  return sorted;
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

function inferExamTypeFromSection(section) {
  const title = getTrimmed(section?.title);
  if (title.includes("وطن")) return EXAM_TYPE_NATIONAL;
  if (title.includes("جهو")) return EXAM_TYPE_REGIONAL;
  return EXAM_TYPE_PREP;
}

function normalizeExamTypeForSection(value, section) {
  const normalized = normalizeExamType(value);
  if (normalized) return normalized;

  const clean = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (clean === EXAM_TYPE_LEGACY_CUSTOM) {
    return inferExamTypeFromSection(section);
  }

  return null;
}

function normalizeExamLevel(value) {
  if (typeof value !== "string") return null;
  const clean = value.trim().toLowerCase();
  if (clean !== EXAM_LEVEL_FIRST && clean !== EXAM_LEVEL_SECOND) {
    return null;
  }
  return clean;
}

function normalizeExamLevelWithLegacy(value) {
  return normalizeExamLevel(value) || inferLevelFromStudyYear(value);
}

function defaultLevelForExamType(type) {
  if (type === EXAM_TYPE_REGIONAL) return EXAM_LEVEL_FIRST;
  return EXAM_LEVEL_SECOND;
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

function isTypeLevelCompatible(type, level) {
  if (!type || !level) return true;
  if (type === EXAM_TYPE_NATIONAL) return level === EXAM_LEVEL_SECOND;
  if (type === EXAM_TYPE_REGIONAL) return level === EXAM_LEVEL_FIRST;
  return true;
}

// --- Existing Endpoints (unchanged) ---

moduleRouter.post("/add_course", adminAuth, async (req, res) => {
  try {
    const { year, name, speciality, courseName, link, title } = req.body;
    const sourceMode = normalizeSourceMode(req.body.sourceMode);
    const cleanYear = getTrimmed(year);
    const cleanName = getTrimmed(name);
    const cleanSpeciality = getTrimmed(speciality);
    const cleanCourseName = getTrimmed(courseName);
    const cleanLink = getTrimmed(link);

    if (!year || !name || !speciality || !courseName || !link) {
      return res.status(400).json({ msg: "جميع الحقول مطلوبة" });
    }

    if (!isHttpUrl(cleanLink)) {
      return res.status(400).json({ msg: "رابط الدرس غير صحيح" });
    }

    const modeToSave = sourceMode || SOURCE_MODE_UPLOAD;

    let existModule = await Subject.findOne({
      name: cleanName,
      speciality: cleanSpeciality,
      year: cleanYear,
    });
    const course = {
      name: cleanCourseName,
      link: cleanLink,
      title: getTrimmed(title),
      sourceMode: modeToSave,
      contentType: normalizeContentType(req.body.contentType),
      semester: normalizeSemester(req.body.semester),
      order: normalizeOrder(req.body.order),
      durationSec: normalizeOrder(req.body.durationSec),
    };

    if (existModule) {
      existModule.courses.push(course);
      await existModule.save();
      return res.status(200).json(existModule);
    }

    const subject = new Subject({
      year: cleanYear,
      name: cleanName,
      speciality: cleanSpeciality,
      courses: [course],
      exames: [],
    });
    await subject.save();
    console.log("New subject created and course added");
    res.status(200).json(subject);
  } catch (error) {
    console.error("Add course error:", error.message);
    res.status(500).json({ error: "خطأ في إضافة الدرس" });
  }
});

moduleRouter.post("/add_exame", adminAuth, async (req, res) => {
  try {
    const {
      year,
      name,
      speciality,
      exameName,
      link,
      solutionLink,
      examPdfUrl,
      solutionPdfUrl,
      title,
      examType,
      level,
      examYear,
      sectionId,
    } = req.body;
    const sourceMode = normalizeSourceMode(req.body.sourceMode);
    const cleanYear = getTrimmed(year);
    const cleanName = getTrimmed(name);
    const cleanSpeciality = getTrimmed(speciality);
    const cleanExameName = getTrimmed(exameName);
    const cleanLink = getTrimmed(link);
    const cleanSolutionLink = getTrimmed(solutionLink);
    const cleanExamPdfUrl = getTrimmed(examPdfUrl);
    const cleanSolutionPdfUrl = getTrimmed(solutionPdfUrl);
    const cleanSectionId = getTrimmed(sectionId);
    const resolvedExamPdfUrl = cleanExamPdfUrl || cleanLink;
    const resolvedSolutionPdfUrl = cleanSolutionPdfUrl || cleanSolutionLink;
    if (!cleanSectionId || !mongoose.Types.ObjectId.isValid(cleanSectionId)) {
      return res.status(400).json({ msg: "قسم الامتحان مطلوب" });
    }

    const section = await ExamSection.findById(cleanSectionId).select("title").lean();
    if (!section) {
      return res.status(404).json({ msg: "قسم الامتحان غير موجود" });
    }

    const hasExamType = Object.prototype.hasOwnProperty.call(req.body, "examType");
    const explicitType = normalizeExamTypeForSection(examType, section);
    const explicitLevel = normalizeExamLevelWithLegacy(level);
    if (hasExamType && !explicitType) {
      return res.status(400).json({ msg: "نوع الامتحان غير صحيح" });
    }

    const normalizedType = explicitType || inferExamTypeFromSection(section);
    const normalizedLevel =
      explicitLevel ||
      inferLevelFromStudyYear(cleanYear) ||
      defaultLevelForExamType(normalizedType);
    const normalizedYear = normalizeExamYear(examYear);

    if (!year || !name || !speciality || !exameName) {
      return res.status(400).json({ msg: "جميع الحقول مطلوبة" });
    }

    if (!resolvedExamPdfUrl || !isHttpUrl(resolvedExamPdfUrl)) {
      return res.status(400).json({ msg: "رابط الموضوع غير صحيح" });
    }

    if (resolvedSolutionPdfUrl && !isHttpUrl(resolvedSolutionPdfUrl)) {
      return res.status(400).json({ msg: "رابط الحل غير صحيح" });
    }

    if (normalizedYear === null) {
      return res.status(400).json({ msg: "سنة الامتحان غير صحيحة" });
    }

    if (!isTypeLevelCompatible(normalizedType, normalizedLevel)) {
      return res.status(400).json({ msg: "نوع الامتحان غير متوافق مع المستوى الدراسي" });
    }

    const modeToSave = sourceMode || SOURCE_MODE_UPLOAD;

    let existModule = await Subject.findOne({
      name: cleanName,
      speciality: cleanSpeciality,
      year: cleanYear,
    });
    const exame = {
      name: cleanExameName,
      examType: normalizedType,
      level: normalizedLevel,
      examYear: normalizedYear,
      examPdfUrl: resolvedExamPdfUrl,
      solutionPdfUrl: resolvedSolutionPdfUrl,
      link: resolvedExamPdfUrl,
      solutionLink: resolvedSolutionPdfUrl,
      title: getTrimmed(title),
      sourceMode: modeToSave,
      sectionId: cleanSectionId,
    };

    if (existModule) {
      existModule.exames.push(exame);
      await existModule.save();
      return res.status(200).json(existModule);
    }

    const subject = new Subject({
      year: cleanYear,
      name: cleanName,
      speciality: cleanSpeciality,
      courses: [],
      exames: [exame],
    });
    await subject.save();
    res.status(200).json(subject);
  } catch (error) {
    console.error("Add exam error:", error.message);
    res.status(500).json({ error: "خطأ في إضافة الامتحان" });
  }
});

moduleRouter.post("/update_course", adminAuth, async (req, res) => {
  try {
    const { courseId, moduleName, year, speciality, courseName, title, link } = req.body;
    const sourceMode = normalizeSourceMode(req.body.sourceMode);
    const cleanCourseId = getTrimmed(courseId);
    const cleanModuleName = getTrimmed(moduleName);
    const cleanYear = getTrimmed(year);
    const cleanSpeciality = getTrimmed(speciality);
    const cleanCourseName = getTrimmed(courseName);
    const cleanTitle = getTrimmed(title);
    const cleanLink = getTrimmed(link);

    if (!courseId || !moduleName || !year || !speciality) {
      return res.status(400).json({ msg: "جميع الحقول المطلوبة للتحديث غير متوفرة" });
    }

    if (!mongoose.Types.ObjectId.isValid(cleanCourseId)) {
      return res.status(400).json({ msg: "معرف الدرس غير صالح" });
    }

    if (cleanLink && !isHttpUrl(cleanLink)) {
      return res.status(400).json({ msg: "رابط الدرس غير صحيح" });
    }

    const module = await Subject.findOne({
      name: cleanModuleName,
      speciality: cleanSpeciality,
      year: cleanYear,
    });
    if (!module) {
      return res.status(404).json({ msg: "المادة غير موجودة." });
    }

    const course = module.courses.id(cleanCourseId);
    if (!course) {
      return res.status(404).json({ msg: "الدرس غير موجود." });
    }

    if (cleanCourseName) {
      course.name = cleanCourseName;
    }
    if (typeof title === "string") {
      course.title = cleanTitle;
    }
    if (cleanLink) {
      course.link = cleanLink;
    }
    if (sourceMode) {
      if (sourceMode === SOURCE_MODE_DIRECT && !course.link) {
        return res.status(400).json({ msg: "رابط الدرس مطلوب في وضع الرابط المباشر" });
      }
      course.sourceMode = sourceMode;
    }
    if (typeof req.body.contentType === "string") {
      course.contentType = normalizeContentType(req.body.contentType);
    }
    if (typeof req.body.semester !== "undefined") {
      course.semester = normalizeSemester(req.body.semester);
    }
    if (typeof req.body.order !== "undefined") {
      course.order = normalizeOrder(req.body.order);
    }
    if (typeof req.body.durationSec !== "undefined") {
      course.durationSec = normalizeOrder(req.body.durationSec);
    }

    await module.save();
    res.status(200).json(module);
  } catch (error) {
    console.error("Update course error:", error.message);
    res.status(500).json({ error: "خطأ في تحديث الدرس" });
  }
});

/**
 * استيراد جماعي للدروس (فيديو أو PDF).
 *
 * بيستقبل مصفوفة عناصر، كل عنصر فيه:
 *   { year, speciality, subject, title, name, link,
 *     contentType, semester, order, durationSec }
 *
 * بيتجاهل أي درس موجود بنفس الرابط في نفس المادة (idempotent)،
 * فتقدر تشغّله أكتر من مرة من غير تكرار.
 */
moduleRouter.post("/import_courses", adminAuth, async (req, res) => {
  try {
    const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
    if (items.length === 0) {
      return res.status(400).json({ msg: "لا توجد دروس للاستيراد" });
    }
    if (items.length > 2000) {
      return res.status(400).json({ msg: "الحد الأقصى 2000 درس في الطلب الواحد" });
    }

    const dryRun = req.body.dryRun === true;
    const report = { created: 0, skipped: 0, modulesTouched: 0, errors: [] };
    const cache = new Map();

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index] || {};
      const year = getTrimmed(item.year);
      const speciality = getTrimmed(item.speciality);
      const subject = getTrimmed(item.subject);
      const name = getTrimmed(item.name);
      const link = getTrimmed(item.link);

      if (!year || !speciality || !subject || !name || !link) {
        report.errors.push({ index, msg: "حقول ناقصة" });
        continue;
      }
      if (!isHttpUrl(link)) {
        report.errors.push({ index, msg: "رابط غير صحيح", link });
        continue;
      }

      const key = `${year}|${speciality}|${subject}`;
      let module = cache.get(key);
      if (!module) {
        module = await Subject.findOne({ name: subject, speciality, year });
        if (!module) {
          module = new Subject({
            year,
            name: subject,
            speciality,
            courses: [],
            exames: [],
          });
        }
        cache.set(key, module);
      }

      const duplicate = module.courses.some(
        (course) => getTrimmed(course.link) === link
      );
      if (duplicate) {
        report.skipped += 1;
        continue;
      }

      module.courses.push({
        name,
        title: getTrimmed(item.title) || "الدروس",
        link,
        sourceMode: SOURCE_MODE_DIRECT,
        contentType: normalizeContentType(item.contentType),
        semester: normalizeSemester(item.semester),
        order: normalizeOrder(item.order),
        durationSec: normalizeOrder(item.durationSec),
      });
      report.created += 1;
    }

    if (!dryRun) {
      for (const module of cache.values()) {
        await module.save();
      }
    }

    report.modulesTouched = cache.size;
    report.dryRun = dryRun;
    res.status(200).json(report);
  } catch (error) {
    console.error("Import courses error:", error.message);
    res.status(500).json({ error: "خطأ في استيراد الدروس" });
  }
});

moduleRouter.post("/update_exame", adminAuth, async (req, res) => {
  try {
    const {
      exameId,
      moduleName,
      year,
      speciality,
      exameName,
      title,
      link,
      solutionLink,
      examPdfUrl,
      solutionPdfUrl,
      examType,
      level,
      examYear,
    } = req.body;
    const sourceMode = normalizeSourceMode(req.body.sourceMode);
    const cleanExameId = getTrimmed(exameId);
    const cleanModuleName = getTrimmed(moduleName);
    const cleanYear = getTrimmed(year);
    const cleanSpeciality = getTrimmed(speciality);
    const cleanExameName = getTrimmed(exameName);
    const cleanTitle = getTrimmed(title);
    const cleanLink = getTrimmed(link);
    const cleanSolutionLink = getTrimmed(solutionLink);
    const cleanExamPdfUrl = getTrimmed(examPdfUrl);
    const cleanSolutionPdfUrl = getTrimmed(solutionPdfUrl);

    if (!exameId || !moduleName || !year || !speciality) {
      return res.status(400).json({ msg: "جميع الحقول المطلوبة للتحديث غير متوفرة" });
    }

    if (!mongoose.Types.ObjectId.isValid(cleanExameId)) {
      return res.status(400).json({ msg: "معرف الموضوع غير صالح" });
    }

    if (cleanLink && !isHttpUrl(cleanLink)) {
      return res.status(400).json({ msg: "رابط الموضوع غير صحيح" });
    }

    if (cleanExamPdfUrl && !isHttpUrl(cleanExamPdfUrl)) {
      return res.status(400).json({ msg: "رابط الموضوع غير صحيح" });
    }

    if (cleanSolutionLink && !isHttpUrl(cleanSolutionLink)) {
      return res.status(400).json({ msg: "رابط الحل غير صحيح" });
    }

    if (cleanSolutionPdfUrl && !isHttpUrl(cleanSolutionPdfUrl)) {
      return res.status(400).json({ msg: "رابط الحل غير صحيح" });
    }

    const module = await Subject.findOne({
      name: cleanModuleName,
      speciality: cleanSpeciality,
      year: cleanYear,
    });
    if (!module) {
      return res.status(404).json({ msg: "المادة غير موجودة." });
    }

    const exame = module.exames.id(cleanExameId);
    if (!exame) {
      return res.status(404).json({ msg: "الامتحان غير موجود." });
    }

    if (cleanExameName) {
      exame.name = cleanExameName;
    }
    if (typeof title === "string") {
      exame.title = cleanTitle;
    }

    if (Object.prototype.hasOwnProperty.call(req.body, "examType")) {
      const section = exame.sectionId
        ? await ExamSection.findById(exame.sectionId).select("title").lean()
        : null;
      const normalizedType = normalizeExamTypeForSection(examType, section);
      if (!normalizedType) {
        return res.status(400).json({ msg: "نوع الامتحان غير صحيح" });
      }
      exame.examType = normalizedType;
    }

    if (Object.prototype.hasOwnProperty.call(req.body, "level")) {
      const normalizedLevel =
        normalizeExamLevelWithLegacy(level) ||
        inferLevelFromStudyYear(cleanYear) ||
        defaultLevelForExamType(exame.examType);
      if (!normalizedLevel) {
        return res.status(400).json({ msg: "المستوى الدراسي غير صحيح" });
      }
      exame.level = normalizedLevel;
    }

    if (Object.prototype.hasOwnProperty.call(req.body, "examYear")) {
      const normalizedYear = normalizeExamYear(examYear);
      if (normalizedYear === null) {
        return res.status(400).json({ msg: "سنة الامتحان غير صحيحة" });
      }
      exame.examYear = normalizedYear;
    }

    const nextExamPdfUrl = cleanExamPdfUrl || cleanLink;
    if (nextExamPdfUrl) {
      exame.examPdfUrl = nextExamPdfUrl;
      exame.link = nextExamPdfUrl;
    }

    const nextSolutionPdfUrl = cleanSolutionPdfUrl || cleanSolutionLink;
    if (nextSolutionPdfUrl) {
      exame.solutionPdfUrl = nextSolutionPdfUrl;
      exame.solutionLink = nextSolutionPdfUrl;
    }

    if (sourceMode) {
      if (sourceMode === SOURCE_MODE_DIRECT) {
        const resolvedExamUrl = getTrimmed(exame.examPdfUrl) || getTrimmed(exame.link);
        const resolvedSolutionUrl =
          getTrimmed(exame.solutionPdfUrl) || getTrimmed(exame.solutionLink);
        if (!resolvedExamUrl) {
          return res.status(400).json({ msg: "رابط الموضوع مطلوب في وضع الرابط المباشر" });
        }
        if (!resolvedSolutionUrl) {
          return res.status(400).json({ msg: "رابط الحل مطلوب في وضع الرابط المباشر" });
        }
      }
      exame.sourceMode = sourceMode;
    }

    const syncedExamPdfUrl = getTrimmed(exame.examPdfUrl) || getTrimmed(exame.link);
    const syncedSolutionPdfUrl =
      getTrimmed(exame.solutionPdfUrl) || getTrimmed(exame.solutionLink);

    if (!isTypeLevelCompatible(exame.examType, exame.level)) {
      return res.status(400).json({ msg: "نوع الامتحان غير متوافق مع المستوى الدراسي" });
    }

    exame.examPdfUrl = syncedExamPdfUrl;
    exame.solutionPdfUrl = syncedSolutionPdfUrl;
    exame.link = syncedExamPdfUrl;
    exame.solutionLink = syncedSolutionPdfUrl;

    await module.save();
    res.status(200).json(module);
  } catch (error) {
    console.error("Update exam error:", error.message);
    res.status(500).json({ error: "خطأ في تحديث الامتحان" });
  }
});

moduleRouter.post("/get_module", async (req, res) => {
  try {
    const { year, name, speciality } = req.body;
    if (!year || !name || !speciality) {
      return res.status(400).json({ msg: "المعلومات غير كاملة" });
    }
    const module = await Subject.findOne({ name, speciality, year }).lean();
    if (!module) {
      return res.status(404).json({ msg: "لا يوجد دروس أو امتحانات حاليًا" });
    }
    if (module.courses && module.courses.length > 0) {
      module.courses = sortCoursesWithinGroups(module.courses);
    }
    res.status(200).json(module);
  } catch (error) {
    console.error("Get module error:", error.message);
    res.status(500).json({ error: "خطأ في جلب المادة" });
  }
});

// --- NEW DELETE ENDPOINTS ---

moduleRouter.post("/delete_course", adminAuth, async (req, res) => {
  try {
    // Assuming 'courseId' is the _id generated by MongoDB for the subdocument
    const { courseId, moduleName, year, speciality } = req.body;
    const cleanCourseId = getTrimmed(courseId);

    if (!courseId || !moduleName || !year || !speciality) {
      return res.status(400).json({ msg: "جميع الحقول المطلوبة للحذف غير متوفرة" });
    }

    if (!mongoose.Types.ObjectId.isValid(cleanCourseId)) {
      return res.status(400).json({ msg: "معرف الدرس غير صالح" });
    }

    // Find the module that contains this course
    const module = await Subject.findOne({ name: moduleName, speciality, year });

    if (!module) {
      return res.status(404).json({ msg: "المادة غير موجودة." });
    }

    // Use Mongoose's .pull() method to remove the subdocument by its _id
    // Make sure your Course schema (if separate) or the subdocument
    // in the Subject schema has an _id field.
    module.courses.pull({ _id: cleanCourseId });

    await module.save(); // Save the updated module document

    console.log(`Course with ID ${cleanCourseId} deleted from module ${moduleName}`);
    // Respond with the updated module data
    res.status(200).json(module);
  } catch (error) {
    console.error("Delete course error:", error.message);
    res.status(500).json({ error: "خطأ في حذف الدرس" });
  }
});

moduleRouter.post("/delete_exame", adminAuth, async (req, res) => {
  try {
    // Assuming 'exameId' is the _id generated by MongoDB for the subdocument
    const { exameId, moduleName, year, speciality } = req.body;
    const cleanExameId = getTrimmed(exameId);

    if (!exameId || !moduleName || !year || !speciality) {
      return res.status(400).json({ msg: "جميع الحقول المطلوبة للحذف غير متوفرة" });
    }

    if (!mongoose.Types.ObjectId.isValid(cleanExameId)) {
      return res.status(400).json({ msg: "معرف الموضوع غير صالح" });
    }

    // Find the module that contains this exam
    const module = await Subject.findOne({ name: moduleName, speciality, year });

    if (!module) {
      return res.status(404).json({ msg: "المادة غير موجودة." });
    }

    // Use Mongoose's .pull() method to remove the subdocument by its _id
    // Make sure your Exam schema (if separate) or the subdocument
    // in the Subject schema has an _id field.
    module.exames.pull({ _id: cleanExameId });

    await module.save(); // Save the updated module document

    console.log(`Exam with ID ${cleanExameId} deleted from module ${moduleName}`);
    // Respond with the updated module data
    res.status(200).json(module);
  } catch (error) {
    console.error("Delete exam error:", error.message);
    res.status(500).json({ error: "خطأ في حذف الامتحان" });
  }
});

module.exports = moduleRouter;
