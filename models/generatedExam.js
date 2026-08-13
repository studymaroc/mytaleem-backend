const mongoose = require("mongoose");

const generatedExamSchema = new mongoose.Schema({
  subject: {
    type: String,
    required: true,
  },
  level: {
    type: String,
    required: true,
  },
  difficulty: {
    type: String,
    required: true,
  },
  questions: {
    type: Array,
    required: true, // Will contain an array of objects
  },
}, { timestamps: true });

generatedExamSchema.index({ subject: 1, level: 1, difficulty: 1 });

const GeneratedExam = mongoose.model("GeneratedExam", generatedExamSchema);
module.exports = GeneratedExam;
