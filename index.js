const express = require("express");
const http = require("http");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const cors = require("cors"); // CORS: added
const app = express();
const server = http.createServer(app);

// CORS: allowed web origins (Firebase Hosting + GitHub Pages domains)
const allowedOrigins = [
  /^https:\/\/[a-z0-9-]+\.web\.app$/,
  /^https:\/\/[a-z0-9-]+\.firebaseapp\.com$/,
  /^https:\/\/[a-z0-9-]+\.github\.io$/,
];

const io = require("socket.io")(server, {
  // CORS: added for Socket.IO
  cors: { origin: allowedOrigins },
});
const authRouter = require("./routes/auth");
const moduleRouter = require("./routes/module");
const notifiRouter = require("./routes/notifi");
const profileRouter = require("./routes/profile");
const adminRouter = require("./routes/admin");
const aiRouter = require("./routes/ai");
const gamificationRouter = require("./routes/gamification");
const gamificationAdminRouter = require("./routes/gamificationAdmin");
const commentsRouter = require("./routes/comments");
const examsHubRouter = require("./routes/examsHub");
const examSectionsRouter = require("./routes/examSections");
const quizRouter = require("./routes/quiz");
const appSettingsRouter = require("./routes/appSettings");
const pdfProxyRouter = require("./routes/pdfProxy");
const { migrateExamSections } = require("./utils/migrateExamSections");
const { loadGamificationConfig } = require("./utils/gamification");
const AppConfig = require("./models/appConfig");
const Notifi = require("./models/notification");
const User = require("./models/user");
const { JWT_SECRET } = require("./utils/security");
const { ensureUserAvatarKey } = require("./utils/avatarCatalog");

const port = process.env.PORT || 3000;
const DB = process.env.MONGODB_URI;

if (!DB) {
  console.error("MONGODB_URI is required. Set it in the environment.");
  process.exit(1);
}

async function runAvatarAdsDefaultRollout() {
  let config = await AppConfig.findOne();
  if (!config) {
    config = new AppConfig();
  }

  if (config.adsDefaultRolloutApplied) {
    return;
  }

  const users = await User.find({});

  for (const user of users) {
    const previousAvatarKey = user.avatarKey;
    ensureUserAvatarKey(user);

    const hasChangedAvatar = user.avatarKey !== previousAvatarKey;
    const hasPremiumEnabled = user.isPremium === true;

    if (!hasChangedAvatar && !hasPremiumEnabled) {
      continue;
    }

    if (hasPremiumEnabled) {
      user.isPremium = false;
    }

    await user.save();
  }

  config.adsDefaultRolloutApplied = true;
  await config.save();
  console.log("Avatar and ads-default rollout applied successfully");
}

mongoose
  .connect(DB)
  .then(async () => {
    console.log("Connected to MongoDB");
    await runAvatarAdsDefaultRollout();
    await migrateExamSections();
    await loadGamificationConfig();
  })
  .catch((e) => console.error("MongoDB connection error:", e));

// CORS: must stay BEFORE express.json() and all routers
app.use(
  cors({
    origin: (origin, cb) => {
      // Mobile apps send no Origin header, so they are allowed through
      if (!origin || allowedOrigins.some((r) => r.test(origin))) {
        return cb(null, true);
      }
      return cb(null, false);
    },
  })
);

app.use(
  express.json({
    limit: process.env.REQUEST_JSON_LIMIT || "10mb",
  })
);
app.use(pdfProxyRouter);
app.use(authRouter);
app.use(moduleRouter);
app.use(notifiRouter);
app.use(profileRouter);
app.use(adminRouter);
app.use(aiRouter);
app.use(gamificationRouter);
app.use(gamificationAdminRouter);
app.use(commentsRouter);
app.use(examsHubRouter);
app.use(examSectionsRouter);
app.use(quizRouter);
app.use(appSettingsRouter);

app.get("/", (req, res) => {
  console.log("Request at /");
  res.send("Hello, world!");
});

// Socket.IO events
io.on("connection", (socket) => {
  console.log("A user connected");

  function getSocketToken(payload = {}) {
    return payload["x-auth-token"] || payload.token || payload.authToken || null;
  }

  async function getSocketUser(payload = {}) {
    const token = getSocketToken(payload);
    if (!token) return null;

    try {
      const verified = jwt.verify(token, JWT_SECRET);
      const user = await User.findById(verified.id).select("_id type");
      return user || null;
    } catch (error) {
      return null;
    }
  }

  socket.on("sent_notification", async (payload = {}) => {
    try {
      const { title, body, type, link, Qanswer } = payload;
      const user = await getSocketUser(payload);
      if (!user) {
        throw new Error("Unauthorized");
      }

      const isQuestion = type === "question";
      if (!isQuestion && user.type !== "admin") {
        throw new Error("Forbidden");
      }

      const notifi = new Notifi({
        title,
        body,
        type,
        link,
        Qanswer,
        userId: user._id,
      });
      await notifi.save();
      console.log("Notification saved");
      io.emit("new_notification", notifi);
    } catch (error) {
      console.error("Error in sent_notification:", error.message);
      socket.emit("error", { message: error.message });
    }
  });

  socket.on("edit_notification", async (payload = {}) => {
    try {
      const { _id, body, Qanswer } = payload;
      if (!_id) throw new Error("Notification ID is required");

      const user = await getSocketUser(payload);
      if (!user) {
        throw new Error("Unauthorized");
      }

      const notifi = await Notifi.findById(_id);
      if (!notifi) throw new Error("Notification not found");

      const isOwner = notifi.userId && String(notifi.userId) === String(user._id);
      if (user.type !== "admin" && !isOwner) {
        throw new Error("Forbidden");
      }

      if (body) notifi.body = body;
      if (Qanswer) notifi.Qanswer = Qanswer;
      await notifi.save();
      console.log("Notification updated");
      io.emit("new_notification", notifi);
    } catch (error) {
      console.error("Error in edit_notification:", error.message);
      socket.emit("error", { message: error.message });
    }
  });

  socket.on("remove_notification", async (payload = {}) => {
    try {
      const { _id } = payload;
      if (!_id) throw new Error("Notification ID is required");

      const user = await getSocketUser(payload);
      if (!user) {
        throw new Error("Unauthorized");
      }

      const notifi = await Notifi.findById(_id).select("_id userId");
      if (!notifi) throw new Error("Notification not found");

      const isOwner = notifi.userId && String(notifi.userId) === String(user._id);
      if (user.type !== "admin" && !isOwner) {
        throw new Error("Forbidden");
      }

      const result = await Notifi.deleteOne({ _id: notifi._id });
      if (result.deletedCount === 0) throw new Error("Notification not found");
      console.log("Notification removed");
      io.emit("remove_notification_success", _id);
    } catch (error) {
      console.error("Error in remove_notification:", error.message);
      socket.emit("error", { message: error.message });
    }
  });

  socket.on("disconnect", () => {
    console.log("User disconnected");
  });
});

// Handle uncaught routes
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

app.use((err, req, res, next) => {
  if (err?.type === "entity.too.large") {
    return res.status(413).json({
      error: "حجم الطلب كبير جداً. تم تقليص السياق المرسل، حاول مرة أخرى.",
    });
  }

  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    return res.status(400).json({
      error: "تعذر قراءة بيانات الطلب المرسلة إلى الخادم.",
    });
  }

  return next(err);
});

server.listen(port, () => {
  console.log(`Server running on port ${port}`);
});