import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = resolve(projectRoot, ".env.local");
const envText = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
const fromFile = envText.match(/^\s*NEXT_PUBLIC_FIREBASE_PROJECT_ID\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))/m);
const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || fromFile?.[1] || fromFile?.[2] || fromFile?.[3];
if (!projectId) {
  console.error("Set NEXT_PUBLIC_FIREBASE_PROJECT_ID in .env.local before starting the Firebase emulators.");
  process.exit(1);
}

const firebaseCommand = process.platform === "win32" ? "firebase.cmd" : "firebase";
const child = spawn(firebaseCommand, [
  "emulators:start",
  "--only", "auth,firestore,storage,hosting",
  "--project", projectId,
], {
  cwd: projectRoot,
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, XDG_CONFIG_HOME: resolve(projectRoot, ".firebase-cli-config") },
});

child.once("error", (error) => {
  console.error(`Could not start Firebase CLI: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code) => { process.exitCode = code ?? 1; });
process.once("SIGINT", () => child.kill("SIGINT"));
process.once("SIGTERM", () => child.kill("SIGTERM"));
