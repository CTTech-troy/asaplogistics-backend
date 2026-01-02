import admin from "firebase-admin";
import dotenv from "dotenv";

dotenv.config();

// Parse service account JSON from env
const serviceAccount = JSON.parse(process.env.FIRBASE_API_KEY);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  console.log("Firebase admin initialized!");
}

export default admin;
