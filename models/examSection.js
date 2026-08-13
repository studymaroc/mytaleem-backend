const mongoose = require("mongoose");

const examSectionSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      unique: true,
    },
    description: {
      type: String,
      default: "",
      trim: true,
    },
    icon: {
      type: String,
      default: "assignment",
      trim: true,
    },
    colorHex: {
      type: String,
      default: "#7C4DFF",
      trim: true,
    },
    order: {
      type: Number,
      default: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

examSectionSchema.index({ isActive: 1, order: 1 });

const ExamSection = mongoose.model("ExamSection", examSectionSchema);
module.exports = ExamSection;
