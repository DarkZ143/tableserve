import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

const args = process.argv.slice(2);
const projectIndex = args.indexOf("--project");
const projectId = projectIndex >= 0 ? args[projectIndex + 1] : process.env.GCLOUD_PROJECT;
const emulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
if (!args.includes("--apply") || !projectId) {
  console.error("Usage: node scripts/migrate-v1-to-v2.mjs --project <firebase-project-id> --apply");
  process.exit(2);
}
if (!emulator && !args.includes("--confirm-production-migration")) {
  console.error("Production project detected. Re-run with --confirm-production-migration after checking the project ID and backup.");
  process.exit(2);
}

initializeApp({ projectId, ...(emulator ? {} : { credential: applicationDefault() }) });
const db = getFirestore();
const auth = getAuth();
const pageSize = 50;
let cursor;
let migratedShops = 0;
let memberships = 0;

while (true) {
  let query = db.collection("restaurants").orderBy("__name__").limit(pageSize);
  if (cursor) query = query.startAfter(cursor);
  const page = await query.get();
  if (page.empty) break;
  for (const restaurant of page.docs) {
    const shopId = restaurant.id;
    const profile = restaurant.data();
    let orderCursor;
    let acceptedOrders = 0;
    while (true) {
      let ordersQuery = restaurant.ref.collection("orders").orderBy("__name__").limit(500);
      if (orderCursor) ordersQuery = ordersQuery.startAfter(orderCursor);
      const orders = await ordersQuery.get();
      if (orders.empty) break;
      for (const orderDoc of orders.docs) {
        const order = orderDoc.data();
        const events = Array.isArray(order.statusEvents) ? order.statusEvents.map((entry) => entry?.status) : [];
        const reachedPreparation = events.includes("preparing") || ["preparing", "ready", "served"].includes(String(order.status));
        const accepted = events.includes("accepted") || ["accepted", "preparing", "ready", "served", "cancelled"].includes(String(order.status));
        if (accepted && (order.status !== "cancelled" || reachedPreparation)) acceptedOrders += 1;
      }
      orderCursor = orders.docs.at(-1);
      if (orders.size < 500) break;
    }

    const staff = await restaurant.ref.collection("staff").get();
    const batch = db.batch();
    for (const memberDoc of staff.docs) {
      const member = memberDoc.data();
      if (member.isActive !== true || !["owner", "manager", "kitchen", "waiter"].includes(member.role)) continue;
      try {
        const user = await auth.getUser(memberDoc.id);
        if (!user.emailVerified) continue;
        batch.set(db.doc(`users/${memberDoc.id}/memberships/${shopId}`), {
          shopId, shopName: String(profile.name ?? "Restaurant"), role: member.role, isActive: true,
          createdAt: member.createdAt ?? FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        memberships += 1;
      } catch {
        // Keep orphaned staff records for review; they do not receive access in v2.
      }
    }
    await batch.commit();

    const subscriptionRef = db.doc(`subscriptions/${shopId}`);
    const metricsRef = db.doc("platformMetrics/current");
    await db.runTransaction(async (tx) => {
      const [subscription, migrationMarker] = await Promise.all([
        tx.get(subscriptionRef), tx.get(db.doc(`migrations/v2/shops/${shopId}`)),
      ]);
      const now = FieldValue.serverTimestamp();
      tx.set(restaurant.ref, {
        schemaVersion: 2,
        shopId,
        nameKey: String(profile.name ?? "").toLocaleLowerCase("en-US"),
        platformStatus: profile.platformStatus ?? "active",
        subscriptionStatus: subscription.exists ? subscription.data()?.status ?? "pending_payment" : "pending_payment",
        planId: profile.planId ?? (subscription.exists ? subscription.data()?.planId ?? "starter" : "starter"),
        lifetimeAcceptedOrders: acceptedOrders,
        updatedAt: now,
      }, { merge: true });
      if (!subscription.exists) {
        tx.create(subscriptionRef, {
          shopId, planId: "starter", planName: "Starter", amountPaise: 89900, orderLimit: 1500,
          status: "pending_payment", provider: "razorpay", currency: "INR", currentUsage: 0,
          currentPeriodStart: null, currentPeriodEnd: null, createdAt: now, updatedAt: now,
        });
        tx.set(metricsRef, { tenantTotal: FieldValue.increment(1), tenantPendingPayment: FieldValue.increment(1), updatedAt: now }, { merge: true });
      }
      if (!migrationMarker.exists) {
        tx.create(db.doc(`migrations/v2/shops/${shopId}`), { version: 2, migratedAt: now, legacyAcceptedOrderBaseline: acceptedOrders });
        tx.set(metricsRef, { totalAcceptedOrders: FieldValue.increment(acceptedOrders), updatedAt: now }, { merge: true });
        tx.create(restaurant.ref.collection("auditLogs").doc(), {
          action: "tenant.migrated_v2", targetType: "restaurant", targetId: shopId, actorUid: "migration-script", actorRole: "system",
          details: { version: 2, acceptedOrderBaseline: acceptedOrders }, createdAt: now,
        });
      }
    });
    migratedShops += 1;
  }
  cursor = page.docs.at(-1);
  if (page.size < pageSize) break;
}

console.log(`Migrated ${migratedShops} restaurant records and synchronized ${memberships} verified staff memberships in ${projectId}${emulator ? " (emulator)" : ""}. Existing workspaces remain pending payment until a provider webhook confirms a subscription.`);
