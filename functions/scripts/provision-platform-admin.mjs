import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const allowedEmail = "rahulbhardwajthestar58@gmail.com";
const args = process.argv.slice(2);
const projectIndex = args.indexOf("--project");
const useEmulators = args.includes("--emulator");
const localEnvPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../.env.local");
const localEnv = existsSync(localEnvPath) ? readFileSync(localEnvPath, "utf8") : "";
const configuredProjectId = localEnv.match(/^\s*NEXT_PUBLIC_FIREBASE_PROJECT_ID\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))/m);
const envProjectId = configuredProjectId?.[1] ?? configuredProjectId?.[2] ?? configuredProjectId?.[3];
const projectId = projectIndex >= 0 ? args[projectIndex + 1] : useEmulators ? envProjectId : process.env.GCLOUD_PROJECT;
const emailIndex = args.indexOf("--email");
const email = (emailIndex >= 0 ? args[emailIndex + 1] : allowedEmail)?.trim().toLowerCase();
if (!args.includes("--apply") || !projectId || email !== allowedEmail) {
  console.error(`Usage: node scripts/provision-platform-admin.mjs --project <firebase-project-id> --email ${allowedEmail} --apply [--emulator]`);
  process.exit(2);
}

if (useEmulators) {
  process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";
  process.env.FIREBASE_AUTH_EMULATOR_HOST ??= "127.0.0.1:9099";
}
initializeApp({ projectId, ...(useEmulators ? {} : { credential: applicationDefault() }) });
const auth = getAuth();
const db = getFirestore();
const user = await auth.getUserByEmail(email);
if (!user.emailVerified) {
  console.error(`The Firebase Auth account ${email} must exist and have a verified email before provisioning.`);
  process.exit(2);
}
const claims = { ...(user.customClaims ?? {}) };
delete claims.shopId;
delete claims.restaurantId;
delete claims.role;
delete claims.active;
delete claims.platformAdmin;
await auth.setCustomUserClaims(user.uid, claims);
await db.doc(`masterAdmins/${user.uid}`).set({ uid: user.uid, email, active: true, role: "MasterAdmin", provisionedAt: FieldValue.serverTimestamp(), projectId }, { merge: true });
await db.collection("platformAuditLogs").add({ action: "platform_admin.provisioned", actorUid: "bootstrap-script", targetId: user.uid, details: { email }, createdAt: FieldValue.serverTimestamp() });
console.log(`Provisioned platform admin ${email} in ${projectId}${useEmulators ? " (local emulators)" : ""}. No password was read or changed; the account uses Firebase Email/Password authentication.`);
