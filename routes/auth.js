const express = require("express");
const authRouter = express.Router();
const bcryptjs = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/user");
const auth = require("../middlewares/auth");
const { JWT_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD } = require("../utils/security");
const {
  ensureUserAvatarKey,
  withResolvedAvatar,
} = require("../utils/avatarCatalog");
const { getBadgeSummary } = require("../utils/gamification");

authRouter.post("/api/signup", async (req, res) => {
  try {
    console.log("req to sign up");
    const { name, email, password, tokenNt } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ msg: "جميع الحقول مطلوبة" });
    }
    const existUser = await User.findOne({ email });
    if (existUser) {
      return res.status(400).json({ msg: "يوجد حساب بنفس البريد الإلكتروني" });
    }
    const hashPassword = await bcryptjs.hash(password, 8);
    const user = new User({ name, email, password: hashPassword, tokenNt });
    ensureUserAvatarKey(user);
    await user.save();
    // Auto-login the user right after signup so the client can take them
    // straight to the profile-setup step.
    const token = jwt.sign({ id: user._id }, JWT_SECRET);
    res.json({
      msg: "تم التسجيل بنجاح",
      token,
      isNewUser: true,
      ...withResolvedAvatar(user),
      ...getBadgeSummary(user),
    });
  } catch (error) {
    console.error("Signup error:", error.message);
    res.status(500).json({ error: "خطأ في الخادم، حاول لاحقًا" });
  }
});

authRouter.post("/api/google-signin", async (req, res) => {
  try {
    console.log("req to google sign in");
    const { name, email, googleId, profilePic, tokenNt, firebaseIdToken } = req.body;
    
    let verifiedEmail = email;
    let verifiedName = name;
    let verifiedPic = profilePic;
    let verifiedGoogleId = googleId;

    // If Firebase ID token is provided, verify it server-side
    if (firebaseIdToken) {
      try {
        const admin = require("firebase-admin");
        const decodedToken = await admin.auth().verifyIdToken(firebaseIdToken);
        verifiedEmail = decodedToken.email || email;
        verifiedName = decodedToken.name || name;
        verifiedPic = decodedToken.picture || profilePic;
        verifiedGoogleId = decodedToken.uid || googleId;
      } catch (tokenError) {
        console.error("Firebase token verification failed:", tokenError.message);
        return res.status(401).json({ msg: "فشل التحقق من رمز جوجل" });
      }
    } else if (!email || !googleId) {
      return res.status(400).json({ msg: "معلومات حساب جوجل غير مكتملة" });
    }

    let user = await User.findOne({ email: verifiedEmail });
    let isNewUser = false;
    
    if (user) {
      // Update existing user with google details if they signed up natively first
      user.googleId = verifiedGoogleId;
      user.profilePic = verifiedPic || user.profilePic;
      user.tokenNt = tokenNt || user.tokenNt;
      ensureUserAvatarKey(user);
      await user.save();
    } else {
      // Create new user, auto-generating a strong dummy password since they use Google Auth
      const dummyPassword = Math.random().toString(36).slice(-10) + "G@";
      const hashPassword = await bcryptjs.hash(dummyPassword, 8);
      user = new User({ 
        name: verifiedName || "طالب جوجل", 
        email: verifiedEmail, 
        password: hashPassword, 
        tokenNt: tokenNt || "void",
        googleId: verifiedGoogleId,
        profilePic: verifiedPic || ""
      });
      ensureUserAvatarKey(user);
      await user.save();
      isNewUser = true;
    }
    
    const token = jwt.sign({ id: user._id }, JWT_SECRET);
    res.json({ token, isNewUser, ...withResolvedAvatar(user), ...getBadgeSummary(user) });
  } catch (error) {
    console.error("Google Signin error:", error.message);
    res.status(500).json({ error: "خطأ في تسجيل دخول جوجل" });
  }
});

authRouter.post("/api/signin", async (req, res) => {
  try {
    console.log("req to sign in");
    const { email, password, tokenNt } = req.body;
    if (!email || !password) {
      return res.status(400).json({ msg: "البريد وكلمة المرور مطلوبان" });
    }

    const normalizedEmail = String(email).trim().toLowerCase();

    // Ensure these fixed credentials always login with admin role.
    if (normalizedEmail === ADMIN_EMAIL.toLowerCase() && password === ADMIN_PASSWORD) {
      let adminUser = await User.findOne({ email: ADMIN_EMAIL });

      if (!adminUser) {
        const hashPassword = await bcryptjs.hash(ADMIN_PASSWORD, 8);
        adminUser = new User({
          name: "Admin",
          email: ADMIN_EMAIL,
          password: hashPassword,
          tokenNt: tokenNt || "void",
          type: "admin",
        });
      } else {
        const shouldUpdatePassword = !(await bcryptjs.compare(
          ADMIN_PASSWORD,
          adminUser.password
        ));

        if (adminUser.type !== "admin") {
          adminUser.type = "admin";
        }

        if (shouldUpdatePassword) {
          adminUser.password = await bcryptjs.hash(ADMIN_PASSWORD, 8);
        }
      }

      if (tokenNt) {
        adminUser.tokenNt = tokenNt;
      }
      ensureUserAvatarKey(adminUser);
      await adminUser.save();
      const token = jwt.sign({ id: adminUser._id }, JWT_SECRET);
      return res.json({
        token,
        ...withResolvedAvatar(adminUser),
        ...getBadgeSummary(adminUser),
      });
    }

    const user =
      (await User.findOne({ email })) ||
      (await User.findOne({ email: normalizedEmail }));
    if (!user) {
      return res.status(400).json({ msg: "الحساب غير موجود" });
    }
    const isMatch = await bcryptjs.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ msg: "كلمة المرور غير صحيحة" });
    }
    if (tokenNt) {
      user.tokenNt = tokenNt;
      await user.save();
    }
    const token = jwt.sign({ id: user._id }, JWT_SECRET);
    res.json({ token, ...withResolvedAvatar(user), ...getBadgeSummary(user) });
  } catch (error) {
    console.error("Signin error:", error.message);
    res.status(500).json({ error: "خطأ في الخادم، حاول لاحقًا" });
  }
});

authRouter.post("/token-is-valid", async (req, res) => {
  try {
    const token = req.header("x-auth-token");
    if (!token) return res.json(false);
    const verified = jwt.verify(token, JWT_SECRET);
    if (!verified) return res.json(false);
    const user = await User.findById(verified.id);
    if (!user) return res.json(false);
    const tokenNt = req.header("tokenNt");
    if (tokenNt) {
      user.tokenNt = tokenNt;
      await user.save();
    }
    res.json(true);
  } catch (error) {
    console.error("Token validation error:", error.message);
    res.status(500).json({ error: "خطأ في التحقق من التوكن" });
  }
});

authRouter.get("/", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user);
    res.json({ ...withResolvedAvatar(user), ...getBadgeSummary(user), token: req.token });
  } catch (error) {
    console.error("User fetch error:", error.message);
    res.status(500).json({ error: "خطأ في جلب بيانات المستخدم" });
  }
});

authRouter.post("/api/change_password", auth, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) {
      return res.status(400).json({ msg: "كلمة المرور مطلوبة" });
    }
    const user = await User.findById(req.user);
    if (!user) {
      return res.status(400).json({ msg: "المستخدم غير موجود" });
    }
    user.password = await bcryptjs.hash(password, 8);
    await user.save();
    res.send("تم تغيير كلمة المرور بنجاح");
  } catch (error) {
    console.error("Change password error:", error.message);
    res.status(500).json({ error: "خطأ في تغيير كلمة المرور" });
  }
});

authRouter.post("/api/change_name", auth, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ msg: "الاسم الجديد مطلوب" });
    }
    const user = await User.findById(req.user);
    if (!user) {
      return res.status(400).json({ msg: "المستخدم غير موجود" });
    }
    user.name = name;
    ensureUserAvatarKey(user);
    await user.save();
    res.json({
      msg: "تم تغيير الاسم بنجاح",
      user: { ...withResolvedAvatar(user), ...getBadgeSummary(user), token: req.token },
    });
  } catch (error) {
    console.error("Change name error:", error.message);
    res.status(500).json({ error: "خطأ في تغيير الاسم" });
  }
});

module.exports = authRouter;
