const ExamSection = require("../models/examSection");
const Subject = require("../models/module");

const DEFAULT_SECTIONS = [
  {
    title: "امتحانات وطنية سابقة",
    description: "مواضيع البكالوريا الوطنية السنوات السابقة",
    icon: "assignment",
    colorHex: "#7C4DFF",
    order: 0,
    legacyType: "national",
  },
  {
    title: "امتحانات جهوية سابقة",
    description: "مواضيع الامتحانات الجهوية السنوات السابقة",
    icon: "menu_book",
    colorHex: "#26A69A",
    order: 1,
    legacyType: "regional",
  },
  {
    title: "فروض للإستعداد",
    description: "فروض ومواضيع للتحضير والاستعداد",
    icon: "edit_note",
    colorHex: "#EF6C00",
    order: 2,
    legacyType: "prep",
  },
];

async function migrateExamSections() {
  try {
    const existingCount = await ExamSection.countDocuments();
    const titleToSection = new Map();

    if (existingCount === 0) {
      const created = await ExamSection.insertMany(
        DEFAULT_SECTIONS.map(({ legacyType, ...rest }) => rest)
      );
      created.forEach((doc, idx) => {
        titleToSection.set(DEFAULT_SECTIONS[idx].legacyType, doc._id);
      });
      console.log("ExamSection: seeded 3 default sections");
    } else {
      // Build legacy-type → sectionId map by matching titles
      for (const def of DEFAULT_SECTIONS) {
        const found = await ExamSection.findOne({ title: def.title });
        if (found) titleToSection.set(def.legacyType, found._id);
      }
    }

    // Backfill embedded exams without sectionId
    const subjects = await Subject.find({ "exames.0": { $exists: true } });
    let updatedExams = 0;
    let touchedSubjects = 0;

    for (const subject of subjects) {
      let dirty = false;
      for (const exam of subject.exames) {
        if (exam.sectionId) continue;
        const legacyType = exam.examType || "prep";
        const targetId = titleToSection.get(legacyType);
        if (targetId) {
          exam.sectionId = targetId;
          dirty = true;
          updatedExams += 1;
        }
      }
      if (dirty) {
        await subject.save();
        touchedSubjects += 1;
      }
    }

    if (updatedExams > 0) {
      console.log(
        `ExamSection: backfilled sectionId on ${updatedExams} exams across ${touchedSubjects} subjects`
      );
    }
  } catch (error) {
    console.error("ExamSection migration error:", error.message);
  }
}

module.exports = { migrateExamSections, DEFAULT_SECTIONS };
