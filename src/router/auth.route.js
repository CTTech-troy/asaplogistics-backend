import express from "express";
import {
  signup,
  login,
  verifyOtp,
  verifyOtpOrCode,
  signupBulk,
} from "../controller/auth.controller.js";

const router = express.Router();

router.post("/signup", signup);
router.post("/login", login);
router.post("/verify-otp", verifyOtp);
router.post("/verify-otp-or-code", verifyOtpOrCode);
router.post("/signup-bulk", signupBulk);

export default router;
