import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { assertFails, assertSucceeds, initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc } from "firebase/firestore";

const rules = await readFile(new URL("../../firestore.rules", import.meta.url), "utf8");
const environment = await initializeTestEnvironment({
  projectId: "tableserve-rules-test",
  firestore: { rules },
});

after(() => environment.cleanup());
beforeEach(async () => {
  await environment.clearFirestore();
  await environment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await Promise.all([
      setDoc(doc(db, "restaurants/shop-a"), { name: "Tenant A" }),
      setDoc(doc(db, "restaurants/shop-a/staff/manager-a"), { role: "manager", isActive: true }),
      setDoc(doc(db, "users/manager-a/memberships/shop-a"), { role: "manager", isActive: true }),
      setDoc(doc(db, "restaurants/shop-a/staff/waiter-a"), { role: "waiter", isActive: true }),
      setDoc(doc(db, "users/waiter-a/memberships/shop-a"), { role: "waiter", isActive: true }),
      setDoc(doc(db, "restaurants/shop-a/orders/order-a"), { status: "queued" }),
      setDoc(doc(db, "restaurants/shop-a/assignedOrders/order-a"), { assignedStaffUid: "waiter-a" }),
      setDoc(doc(db, "restaurants/shop-a/assignedOrders/order-b"), { assignedStaffUid: "waiter-b" }),
      setDoc(doc(db, "restaurants/shop-a/kitchenOrders/order-a"), { status: "queued" }),
      setDoc(doc(db, "restaurants/shop-a/publicTracking/opaque-ticket"), { status: "queued" }),
    ]);
  });
});

test("active managers can read their tenant orders but cannot write operational records", async () => {
  const db = environment.authenticatedContext("manager-a", { email_verified: true }).firestore();
  await assertSucceeds(getDoc(doc(db, "restaurants/shop-a")));
  await assertSucceeds(getDoc(doc(db, "restaurants/shop-a/orders/order-a")));
  await assertFails(getDoc(doc(db, "restaurants/shop-b/orders/order-a")));
  await assertFails(setDoc(doc(db, "restaurants/shop-a/orders/fake-order"), { status: "queued" }));
});

test("waiters can read only their assigned ticket view, not the restaurant order collection", async () => {
  const db = environment.authenticatedContext("waiter-a", { email_verified: true }).firestore();
  await assertSucceeds(getDoc(doc(db, "restaurants/shop-a/assignedOrders/order-a")));
  await assertFails(getDoc(doc(db, "restaurants/shop-a/assignedOrders/order-b")));
  await assertFails(getDoc(doc(db, "restaurants/shop-a/orders/order-a")));
  await assertFails(getDoc(doc(db, "restaurants/shop-b/assignedOrders/order-a")));
});

test("public tracking is readable without authentication while tenant data stays private", async () => {
  const db = environment.unauthenticatedContext().firestore();
  await assertSucceeds(getDoc(doc(db, "restaurants/shop-a/publicTracking/opaque-ticket")));
  await assertFails(getDoc(doc(db, "restaurants/shop-a")));
  await assertFails(getDoc(doc(db, "restaurants/shop-a/orders/order-a")));
});
