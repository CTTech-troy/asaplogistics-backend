import express from "express";
import {
  signup,
  login,
  loginWithPassword,
  verifyOtp,
  verifyOtpOrCode,
  signupBulk,
  adminLogin,
  getCurrentUser,
  getAppSettings,
  updateAppSettings,
  seedAdmin,
} from "../controller/auth.controller.js";
import { verifyToken } from "../middleware/auth.middleware.js";

const router = express.Router();

router.post("/signup", signup);
router.post("/login", login);
router.post("/login-password", loginWithPassword);
router.post("/verify-otp", verifyOtp);
router.post("/verify-otp-or-code", verifyOtpOrCode);
router.post("/signup-bulk", signupBulk);
router.post("/admin-login", adminLogin);
router.get("/me", verifyToken, getCurrentUser);

// Settings routes
router.get("/settings", getAppSettings);
router.patch("/settings", updateAppSettings);

// Seed endpoint (dev only)
router.post("/seed-admin", seedAdmin);
export default router;