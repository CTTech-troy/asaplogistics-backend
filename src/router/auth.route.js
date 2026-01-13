import express from "express";
import {
  signup,
  login,
  loginWithPassword,
  verifyOtp,
  verifyOtpOrCode,
  signupBulk,
  adminLogin,
  getAppSettings,
  updateAppSettings,
  seedAdmin,
} from "../controller/auth.controller.js";

const router = express.Router();

router.post("/signup", signup);
router.post("/login", login);
router.post("/login-password", loginWithPassword);
router.post("/verify-otp", verifyOtp);
router.post("/verify-otp-or-code", verifyOtpOrCode);
router.post("/signup-bulk", signupBulk);
router.post("/admin-login", adminLogin);

// Settings routes
router.get("/settings", getAppSettings);
router.patch("/settings", updateAppSettings);

// Seed endpoint (dev only)
router.post("/seed-admin", seedAdmin);
export default router;