
const mongoose = require('mongoose');

// نوع محتوى الدرس: ملف PDF أو درس فيديو.
// الافتراضي pdf عشان كل الدروس القديمة تفضل شغالة زي ما هي من غير ترحيل.
const CONTENT_TYPE_PDF = "pdf";
const CONTENT_TYPE_VIDEO = "video";

const course = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },
    title: {
        type: String,
        required: false
    },
    link: {
        type:String,
        rerquired: true
    },
    sourceMode: {
        type: String,
        enum: ["upload", "direct_link"],
        default: "upload"
    },
    contentType: {
        type: String,
        enum: [CONTENT_TYPE_PDF, CONTENT_TYPE_VIDEO],
        default: CONTENT_TYPE_PDF
    },
    // الدورة الدراسية (1 أو 2). صفر يعني غير محددة.
    semester: {
        type: Number,
        default: 0,
        min: 0,
        max: 2
    },
    // ترتيب الدرس داخل مجموعته. الأقل يظهر أولاً.
    order: {
        type: Number,
        default: 0
    },
    // مدة الفيديو بالثواني (للعرض في القائمة). صفر يعني غير معروفة.
    durationSec: {
        type: Number,
        default: 0,
        min: 0
    }
});

module.exports = course; // this to make the course schema available to other files
module.exports.CONTENT_TYPE_PDF = CONTENT_TYPE_PDF;
module.exports.CONTENT_TYPE_VIDEO = CONTENT_TYPE_VIDEO;
