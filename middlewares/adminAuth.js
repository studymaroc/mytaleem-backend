const jwt = require("jsonwebtoken");
const User = require("../models/user");
const { JWT_SECRET } = require("../utils/security");

const adminAuth = async (req, res, next) => {
  try {
    const token = req.header("x-auth-token");
    if (!token) {
      return res.status(401).json({ msg: "الوصول مرفوض، توكن غير موجود" });
    }
    const verified = jwt.verify(token, JWT_SECRET);
    if (!verified) {
      return res.status(401).json({ msg: "فشل التحقق من التوكن" });
    }

    const user = await User.findById(verified.id);
    if (!user) {
      return res.status(401).json({ msg: "المستخدم غير موجود" });
    }
    if (user.type !== "admin") {
      return res.status(403).json({ msg: "الوصول مرفوض، صلاحيات المسؤول مطلوبة" });
    }

    req.user = verified.id;
    req.token = token;
    next();
  } catch (error) {
    console.error("Admin auth middleware error:", error.message);
    res.status(500).json({ error: "خطأ في التحقق من صلاحيات المسؤول" });
  }
};

module.exports = adminAuth;
