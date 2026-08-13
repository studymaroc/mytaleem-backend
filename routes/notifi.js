const express = require("express");
const notifiRouter = express.Router();
const Notifi = require("../models/notification");
const adminAuth = require("../middlewares/adminAuth");
const admin = require("firebase-admin");
const User = require("../models/user");

const NOTIFICATION_BATCH_SIZE = Number(process.env.NOTIFICATION_BATCH_SIZE || 100);

let serviceAccount = null;
if (process.env.FIREBASE_ADMIN_JSON) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_JSON);
  } catch (error) {
    console.error("Invalid FIREBASE_ADMIN_JSON:", error.message);
  }
} else {
  try {
    serviceAccount = require("../firebase-admin.json");
  } catch (_) {
    serviceAccount = null;
  }
}

if (serviceAccount && !admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL:
      process.env.FIREBASE_DATABASE_URL ||
      "https://studyapp-morocco-2026-default-rtdb.firebaseio.com",
  });
} else if (!serviceAccount) {
  console.warn("Firebase Admin credentials not found. Notifications will be skipped.");
}
async function getFCMTokens() {
  try {
    const users = await User.find({ tokenNt: { $exists: true, $nin: ["", null] } })
      .select("tokenNt -_id")
      .lean();

    if (!users.length) throw new Error("No users found");
    const fcmTokens = users.map(user => user.tokenNt).filter(token => token);
    return [...new Set(fcmTokens)]; // Remove duplicates
  } catch (error) {
    console.error("Error fetching FCM tokens:", error.message);
    throw error;
  }
}

async function sendNotification(fcmToken, title, body, data) {
  if (!admin.apps.length) return;

  const message = {
    token: fcmToken,
    notification: { title, body },
    data,
  };
  try {
    const response = await admin.messaging().send(message);
    console.log("Notification sent:", response);
  } catch (error) {
    if (error.code === "messaging/registration-token-not-registered") {
      await User.updateMany({ tokenNt: fcmToken }, { $unset: { tokenNt: 1 } });
      console.log("Removed invalid token:", fcmToken);
    } else {
      console.error("Error sending notification:", error.message);
    }
  }
}

async function sendNotificationsInBatches(fcmTokens, title, body, data) {
  for (let i = 0; i < fcmTokens.length; i += NOTIFICATION_BATCH_SIZE) {
    const batch = fcmTokens.slice(i, i + NOTIFICATION_BATCH_SIZE);
    await Promise.allSettled(
      batch.map((token) => sendNotification(token, title, body, data))
    );
  }
}

notifiRouter.post("/sent_notification", adminAuth, async (req, res) => {
  try {
    const { title, body, type, link } = req.body;
    if (!title || !body || !type || !link || typeof title !== "string" || typeof body !== "string" || typeof type !== "string" || typeof link !== "string") {
      return res.status(400).json({ msg: "معلومات غير صحيحة" });
    }
    const fcmTokens = await getFCMTokens();
    if (fcmTokens.length) {
      await sendNotificationsInBatches(fcmTokens, title, body, { type, link });
    }

    const notifi = new Notifi({ title, body, type, link });
    await notifi.save();
    res.status(200).json({ ...notifi._doc, msg: "تم إرسال الإشعار بنجاح" });
  } catch (error) {
    console.error("Send notification error:", error.message);
    res.status(500).json({ error: "خطأ في إرسال الإشعار" });
  }
});

notifiRouter.get("/get_notifications", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const skip = (page - 1) * limit;

    const notifications = await Notifi.find({})
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    if (!notifications.length && page === 1) {
      return res.status(404).json({ msg: "لا توجد إشعارات" });
    }
    res.status(200).json({ notifications, page, limit });
  } catch (error) {
    console.error("Get notifications error:", error.message);
    res.status(500).json({ error: "خطأ في جلب الإشعارات" });
  }
});

module.exports = notifiRouter;