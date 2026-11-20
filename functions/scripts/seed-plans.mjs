import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const args = process.argv.slice(2);
const projectIndex = args.indexOf("--project");
const projectId = projectIndex >= 0 ? args[projectIndex + 1] : process.env.GCLOUD_PROJECT;
const emulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
if (!args.includes("--apply") || !projectId) {
  console.error("Usage: node scripts/seed-plans.mjs --project <firebase-project-id> --apply");
  process.exit(2);
}
if (!emulator && !args.includes("--confirm-production-catalog")) {
  console.error("Production project detected. Re-run with --confirm-production-catalog after verifying the project ID.");
  process.exit(2);
}

initializeApp({ projectId, ...(emulator ? {} : { credential: applicationDefault() }) });
const db = getFirestore();
const plans = [
  { id: "starter", name: "Starter", pricePaise: 89900, orderLimit: 1500, isCustom: false, sortOrder: 1, description: "The full restaurant workflow with a 1,500 accepted-order monthly limit.", features: ["QR menu and table ordering", "Live order and kitchen workflow", "Staff roles and waiter assignments"] },
  { id: "growth", name: "Growth", pricePaise: 199900, orderLimit: 4000, isCustom: false, sortOrder: 2, description: "The same restaurant workflow with a 4,000 accepted-order monthly limit.", features: ["QR menu and table ordering", "Live order and kitchen workflow", "Staff roles and waiter assignments"] },
  { id: "unlimited", name: "Unlimited", pricePaise: 999900, orderLimit: null, isCustom: false, sortOrder: 3, description: "The same restaurant workflow with no fixed monthly order cap.", features: ["QR menu and table ordering", "Live order and kitchen workflow", "Staff roles and waiter assignments"] },
  { id: "test-100", name: "Sandbox Test", pricePaise: 100, orderLimit: 100, isCustom: false, isTestOnly: true, sortOrder: 4, description: "Razorpay Test Mode only. ₹1 per month for up to 100 accepted customer orders per cycle.", features: ["Razorpay test-mode subscription checkout", "Up to 100 accepted customer orders per cycle", "No real payment in Razorpay Test Mode"] },
  { id: "custom", name: "Custom / Enterprise", pricePaise: 0, orderLimit: null, isCustom: true, sortOrder: 5, description: "Monthly price and accepted-order quota assigned per restaurant by platform support.", features: ["Monthly Razorpay subscription", "Accepted-order quota set in the contract"] },
];

const batch = db.batch();
for (const { id, ...plan } of plans) {
  batch.set(db.doc(`plans/${id}`), { ...plan, isTestOnly: plan.isTestOnly === true, currency: "INR", interval: "monthly", isActive: true, usagePolicy: "Unique production orders increment once when accepted; eligible cancellation before preparation reverses once.", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
}
await batch.commit();
console.log(`Seeded ${plans.length} plan catalog records into ${projectId}${emulator ? " (emulator)" : ""}.`);
