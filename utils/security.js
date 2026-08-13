/**
 * أسرار التطبيق — كلها من متغيرات البيئة، مفيش أي قيمة مكتوبة في الكود.
 *
 * السيرفر بيقف فوراً لو أي سر ناقص، أحسن من إنه يشتغل بقيمة افتراضية
 * معروفة تخلي أي حد يقدر يزوّر توكن أو يوصل لحساب المسؤول.
 */

function required(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

const JWT_SECRET = required("JWT_SECRET");
const ADMIN_EMAIL = required("ADMIN_EMAIL");
const ADMIN_PASSWORD = required("ADMIN_PASSWORD");

module.exports = {
  JWT_SECRET,
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
};
