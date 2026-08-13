
const mongoose = require('mongoose');

const EXAM_TYPES = ["national", "regional", "prep"];
const EXAM_LEVELS = ["first_bac", "second_bac"];

const exame = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },
    title: {
        type: String,
        required: false
    },
    examType: {
        type: String,
        enum: EXAM_TYPES,
        default: "prep",
        required: false,
    },
    level: {
        type: String,
        enum: EXAM_LEVELS,
        default: "second_bac",
        required: false,
    },
    examYear: {
        type: Number,
        required: false,
    },
    examPdfUrl: {
        type: String,
        required: false,
        default: "",
        trim: true,
    },
    solutionPdfUrl: {
        type: String,
        required: false,
        default: "",
        trim: true,
    },
    link: {
        type:String,
        required: false,
        default: "",
        trim: true,
    },
    solutionLink: {
        type:String,
        required: false,
        default: "",
        trim: true,
    },
    sourceMode: {
        type: String,
        enum: ["upload", "direct_link"],
        default: "upload"
    },
    sectionId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "ExamSection",
        required: false,
        index: true,
    },
});

module.exports = exame; // this to make the player schema available to other files