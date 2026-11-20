import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const [restaurantId, ...nameParts] = process.argv.slice(2);
const name = nameParts.join(" ").trim();
if (!restaurantId || !name || !/^[A-Za-z0-9_-]{3,80}$/.test(restaurantId)) {
  console.error("Usage: node scripts/init-restaurant.mjs <restaurant-id> <restaurant-name>");
  process.exit(1);
}

initializeApp({ credential: applicationDefault(), projectId: process.env.GOOGLE_CLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID });
const db = getFirestore();
const ref = db.doc(`restaurants/${restaurantId}`);
await ref.create({ name, taxRateBps: 0, serviceFeePaise: 0, isAcceptingOrders: false, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
console.log(`Initialized restaurant ${restaurantId}. Ordering is paused until an owner enables it in Restaurant Settings.`);
