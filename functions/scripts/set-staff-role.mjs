import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

const [restaurantId, email, role = "owner"] = process.argv.slice(2);
if (!restaurantId || !email || !["owner", "manager", "kitchen"].includes(role)) {
  console.error("Usage: node scripts/set-staff-role.mjs <restaurant-id> <email> [owner|manager|kitchen]");
  process.exit(1);
}

initializeApp({ credential: applicationDefault(), projectId: process.env.GOOGLE_CLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID });
const auth = getAuth();
const db = getFirestore();
const user = await auth.getUserByEmail(email);
const active = true;
await auth.setCustomUserClaims(user.uid, { ...(user.customClaims ?? {}), restaurantId, role, active });
await db.doc(`restaurants/${restaurantId}/staff/${user.uid}`).set({ email: user.email ?? email, displayName: user.displayName ?? "", role, isActive: active, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
console.log(`Assigned ${role} access for ${email} at ${restaurantId}. Have the user sign out and back in to refresh role claims.`);
