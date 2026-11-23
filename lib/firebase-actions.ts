"use client";

import {
  Timestamp, addDoc, arrayUnion, collection, doc, getAggregateFromServer, getCountFromServer, getDoc, getDocs,
  increment, limit, orderBy, query, runTransaction, serverTimestamp, setDoc,
  startAfter, sum, updateDoc, where, writeBatch,
} from "firebase/firestore";
import { getIdTokenResult } from "firebase/auth";
import { getFirebase } from "./firebase";
import type { MenuImportRow } from "./menu-import";
import type { StaffRole } from "./types";

type Role = StaffRole;
type Status = "queued" | "accepted" | "preparing" | "ready" | "served" | "cancelled";
// Firestore documents are dynamic maps and this layer validates fields at its boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;
const roleNames: Role[] = ["owner", "manager", "kitchen", "waiter"];
const freePlan = {
  id: "free", name: "Free", pricePaise: 0, orderLimit: null, description: "All restaurant tools in one Firebase powered workspace.",
  features: ["Unlimited table QR codes", "Live order and kitchen updates", "Menu and staff management", "No payment setup"],
  isCustom: false, isActive: true, sortOrder: 0,
};

function shopFromPath() {
  if (typeof window === "undefined") return "";
  const match = window.location.pathname.match(/^\/app\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}
function randomHex(bytes: number) {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(value, (part) => part.toString(16).padStart(2, "0")).join("");
}
function newQrToken() {
  const value = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (part) => part.toString(16).padStart(2, "0")).join("");
}
function normalizeTableNumber(value: string) { return value.trim().normalize("NFKC").toLocaleLowerCase("en-US"); }
function toMillis(value: unknown): number | null {
  if (!value || typeof value !== "object" || !("toMillis" in value)) return null;
  const toMillis = (value as { toMillis?: unknown }).toMillis;
  return typeof toMillis === "function" ? toMillis.call(value) as number : null;
}
async function actor(shopId: string, allowed: Role[] = ["owner", "manager"]) {
  const { auth, db } = getFirebase();
  const user = auth.currentUser;
  if (!user) throw new Error("Sign in with a staff account.");
  const claims = await getIdTokenResult(user, true);
  if (!user.emailVerified || claims.claims.email_verified !== true) throw new Error("Verify your account email before accessing restaurant operations.");
  if (!shopId) throw new Error("Select a restaurant workspace first.");
  const [staff, membership] = await Promise.all([
    getDoc(doc(db, "restaurants", shopId, "staff", user.uid)),
    getDoc(doc(db, "users", user.uid, "memberships", shopId)),
  ]);
  const role = staff.data()?.role as Role | undefined;
  if (!staff.exists() || staff.data()?.isActive !== true || !role || !roleNames.includes(role)
    || !membership.exists() || membership.data()?.isActive !== true || membership.data()?.role !== role) {
    throw new Error("This account does not have active access to this restaurant.");
  }
  if (!allowed.includes(role)) throw new Error("Your restaurant role does not allow this action.");
  return { user, role, email: user.email ?? "", shopId, restaurant: doc(db, "restaurants", shopId) };
}

async function platformAdmin() {
  const { auth, db } = getFirebase();
  const user = auth.currentUser;
  if (!user) throw new Error("Sign in with the provisioned platform admin account.");
  const record = await getDoc(doc(db, "masterAdmins", user.uid));
  if (!record.exists() || record.data()?.active !== true || record.data()?.role !== "MasterAdmin") throw new Error("This Master Admin account is inactive or not provisioned.");
  return { user, email: user.email ?? "" };
}

async function audit(shopId: string, action: string, targetType: string, targetId: string, details: AnyRecord = {}) {
  const { auth, db } = getFirebase();
  const user = auth.currentUser;
  const actorRole = await actor(shopId, roleNames);
  await addDoc(collection(db, "restaurants", shopId, "auditLogs"), {
    action, targetType, targetId, actorUid: user?.uid ?? null, actorEmail: user?.email ?? null,
    actorRole: actorRole.role, details, createdAt: serverTimestamp(),
  });
}

async function membershipShops(uid: string) {
  const { db } = getFirebase();
  const snapshot = await getDocs(query(collection(db, "users", uid, "memberships"), where("isActive", "==", true)));
  const shops = snapshot.docs.map((entry) => ({
    shopId: entry.id,
    name: String(entry.data().shopName ?? "Restaurant"),
    role: entry.data().role as Role,
    createdAt: toMillis(entry.data().createdAt) ?? 0,
  }));
  shops.sort((left, right) => right.createdAt - left.createdAt);
  return shops.map((shop) => ({ shopId: shop.shopId, name: shop.name, role: shop.role }));
}

/** Direct Firebase client-side application actions. No HTTPS callable or Cloud Function is used. */
export async function runFirebaseAction<TInput extends object, TOutput>(name: string, input: TInput): Promise<TOutput> {
  const { auth, db } = getFirebase();
  const routedShopId = shopFromPath();
  const args = { ...(input as AnyRecord), ...(routedShopId && !(input as AnyRecord).shopId ? { shopId: routedShopId } : {}) } as AnyRecord;
  const shopId = String(args.shopId ?? "");

  switch (name) {
    case "listPlans": {
      return { plans: [freePlan] } as TOutput;
    }
    case "submitServedFeedback": {
      const ticketId = String(args.ticketId ?? "").trim().toUpperCase();
      const restaurantId = String(args.restaurantId ?? "").trim();
      const response = String(args.response ?? "");
      const details = String(args.details ?? "").trim();
      if (!/^TS-[A-F0-9]{40}$/.test(ticketId) || !restaurantId || !["yes", "no"].includes(response) || details.length > 500 || (response === "yes" && details)) {
        throw new Error("We could not verify this ticket. Please reload the tracking page and try again.");
      }
      const trackingId = await sha256(ticketId);
      const trackingRef = doc(db, "restaurants", restaurantId, "publicTracking", trackingId);
      const tracking = await getDoc(trackingRef);
      if (!tracking.exists() || tracking.data().ticketId !== ticketId || tracking.data().status !== "served") {
        throw new Error("This ticket is not marked served yet. Please wait for the restaurant update.");
      }
      const existing = tracking.data().customerServedResponse;
      if (existing && ["yes", "no"].includes(String(existing.response))) {
        return { response: existing.response } as TOutput;
      }
      const orderId = String(tracking.data().orderId ?? "");
      if (!orderId) throw new Error("We could not find this order. Please contact the restaurant team.");
      const feedback = { response, ...(response === "no" && details ? { details } : {}), createdAt: serverTimestamp() };
      const batch = writeBatch(db);
      batch.update(doc(db, "restaurants", restaurantId, "orders", orderId), { customerServedResponse: feedback });
      batch.update(trackingRef, { customerServedResponse: feedback });
      await batch.commit();
      return { response } as TOutput;
    }
    case "resolveServedIssue": {
      const access = await actor(shopId);
      const orderId = String(args.orderId ?? "").trim();
      if (!orderId) throw new Error("Order not found.");
      const orderRef = doc(db, "restaurants", shopId, "orders", orderId);
      const order = await getDoc(orderRef);
      if (!order.exists() || order.data().status !== "served" || order.data().customerServedResponse?.response !== "no") {
        throw new Error("This guest report is no longer open.");
      }
      if (order.data().serviceIssueResolvedAt) throw new Error("This guest report has already been resolved.");
      await updateDoc(orderRef, {
        serviceIssueResolvedAt: serverTimestamp(),
        serviceIssueResolvedBy: access.user.uid,
        updatedAt: serverTimestamp(),
      });
      await audit(shopId, "order.served_issue_resolved", "order", orderId, { ticketId: order.data().ticketId });
      return { ok: true } as TOutput;
    }
    case "markOrderPaid": {
      const access = await actor(shopId);
      const orderId = String(args.orderId ?? "").trim();
      const method = String(args.method ?? "");
      if (!orderId || !["cash", "upi", "card"].includes(method)) throw new Error("Choose a valid payment method.");
      const orderRef = doc(db, "restaurants", shopId, "orders", orderId);
      const order = await getDoc(orderRef);
      if (!order.exists() || order.data().paymentStatus !== "pending") throw new Error("This order is not awaiting payment confirmation.");
      const orderData = order.data();
      const payAtRestaurant = orderData.paymentTiming === "pay_after_serve" && orderData.status === "served";
      const directUpi = orderData.paymentTiming === "prepaid" && orderData.paymentProvider === "manual" && orderData.paymentMethod === "upi" && method === "upi" && orderData.status !== "cancelled";
      if (!payAtRestaurant && !directUpi) throw new Error("Confirm the payment only after checking the restaurant's payment record.");
      const trackingId = await sha256(String(order.data().ticketId));
      const trackingRef = doc(db, "restaurants", shopId, "publicTracking", trackingId);
      const now = serverTimestamp();
      const patch = { paymentStatus: "paid", paymentProvider: "manual", paymentMethod: method, paymentPaidAt: now, updatedAt: now };
      const batch = writeBatch(db);
      batch.update(orderRef, patch);
      batch.update(trackingRef, patch);
      await batch.commit();
      await audit(shopId, "order.payment_collected", "order", orderId, { ticketId: orderData.ticketId, method, source: directUpi ? "direct_upi" : "pay_at_restaurant" });
      return { ok: true } as TOutput;
    }
    case "createRestaurant": {
      const user = auth.currentUser;
      if (!user) throw new Error("Sign in with your owner account first.");
      await user.reload();
      if (!user.email || !user.emailVerified) throw new Error("Verify your Email/Password account before creating a restaurant.");
      const ownerEmail = user.email.toLowerCase();
      const inputData = args as AnyRecord;
      const chosenPlan = inputData.planId === "free" ? freePlan : null;
      if (!chosenPlan) throw new Error("Choose the Free Firebase plan to create this workspace.");
      const restaurantRef = doc(collection(db, "restaurants"));
      const ownerRef = doc(db, "restaurants", restaurantRef.id, "staff", user.uid);
      const membershipRef = doc(db, "users", user.uid, "memberships", restaurantRef.id);
      const subscriptionRef = doc(db, "subscriptions", restaurantRef.id);
      const now = Timestamp.now();
      const periodEnd = Timestamp.fromMillis(now.toMillis() + 100 * 365.25 * 24 * 60 * 60 * 1000);
      await runTransaction(db, async (tx) => {
        const existing = await tx.get(membershipRef);
        if (existing.exists()) throw new Error("This workspace has already been created.");
        tx.set(restaurantRef, {
          schemaVersion: 2, shopId: restaurantRef.id, name: String(inputData.name).trim(), nameKey: String(inputData.name).trim().toLocaleLowerCase("en-US"),
          ownerUid: user.uid, ownerEmail, ownerName: String(inputData.ownerName).trim(), phone: String(inputData.phone).trim(),
          address: String(inputData.address).trim(), city: String(inputData.city).trim(), state: String(inputData.state).trim(), postalCode: String(inputData.postalCode).trim(),
          cuisine: String(inputData.cuisine ?? "").trim(), timezone: String(inputData.timezone ?? "Asia/Kolkata"), currency: "INR", taxRateBps: 0, serviceFeePaise: 0,
          payAtRestaurantEnabled: true, upiEnabled: false, upiId: "", upiPayeeName: String(inputData.name).trim(),
          isAcceptingOrders: true, platformStatus: "active", subscriptionStatus: "active", planId: "free", lifetimeAcceptedOrders: 0, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
        });
        tx.set(doc(db, "publicRestaurants", restaurantRef.id), { restaurantId: restaurantRef.id, name: String(inputData.name).trim(), taxRateBps: 0, serviceFeePaise: 0, isAcceptingOrders: true, payAtRestaurantEnabled: true, upiEnabled: false, upiId: "", upiPayeeName: String(inputData.name).trim(), platformStatus: "active", subscriptionStatus: "active", currentUsage: 0, orderLimit: null, currentPeriodEnd: periodEnd, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
        tx.set(ownerRef, { uid: user.uid, email: ownerEmail, displayName: user.displayName ?? String(inputData.ownerName).trim(), role: "owner", isActive: true, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
        tx.set(membershipRef, { shopId: restaurantRef.id, shopName: String(inputData.name).trim(), role: "owner", isActive: true, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
        tx.set(subscriptionRef, { shopId: restaurantRef.id, planId: "free", planName: chosenPlan.name, amountPaise: 0, orderLimit: null, status: "active", currency: "INR", provider: "firebase", currentUsage: 0, currentPeriodStart: now, currentPeriodEnd: periodEnd, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      });
      return { shopId: restaurantRef.id, status: "active" } as TOutput;
    }
    case "listMyRestaurants": {
      const user = auth.currentUser;
      if (!user) throw new Error("Sign in first.");
      if (!user.emailVerified) throw new Error("Verify your account email before continuing.");
      return { shops: await membershipShops(user.uid) } as TOutput;
    }
    case "getMyShopAccess": {
      const access = await actor(shopId, roleNames);
      const [membership, restaurantSnapshot, subscriptionSnapshot] = await Promise.all([
        getDoc(doc(db, "users", access.user.uid, "memberships", shopId)), getDoc(access.restaurant), getDoc(doc(db, "subscriptions", shopId)),
      ]);
      const profile = restaurantSnapshot.data();
      if (access.role === "owner" && profile) {
        const tableRows = await getDocs(collection(db, "restaurants", shopId, "tables"));
        const batch = writeBatch(db);
        const orderingMigrationRef = doc(db, "restaurants", shopId, "auditLogs", "guest-ordering-default-v1");
        const orderingMigration = await getDoc(orderingMigrationRef);
        const shouldEnableGuestOrders = !orderingMigration.exists();
        const billing = subscriptionSnapshot.data();
        const needsFirebasePlan = !billing || billing.provider !== "firebase" || billing.planId !== "free" || Number(billing.amountPaise ?? 0) !== 0 || billing.status !== "active";
        const now = Timestamp.now();
        const end = needsFirebasePlan ? Timestamp.fromMillis(now.toMillis() + 100 * 365.25 * 24 * 60 * 60 * 1000) : billing.currentPeriodEnd ?? Timestamp.fromMillis(now.toMillis() + 100 * 365.25 * 24 * 60 * 60 * 1000);
        const acceptsGuestOrders = shouldEnableGuestOrders || profile.isAcceptingOrders === true;
        batch.set(doc(db, "publicRestaurants", shopId), { restaurantId: shopId, name: profile.name ?? "Restaurant", taxRateBps: Number(profile.taxRateBps ?? 0), serviceFeePaise: Number(profile.serviceFeePaise ?? 0), isAcceptingOrders: acceptsGuestOrders, payAtRestaurantEnabled: profile.payAtRestaurantEnabled !== false, upiEnabled: profile.upiEnabled === true, upiId: String(profile.upiId ?? ""), upiPayeeName: String(profile.upiPayeeName ?? profile.name ?? "Restaurant"), platformStatus: profile.platformStatus ?? "active", subscriptionStatus: "active", currentUsage: Number(billing?.currentUsage ?? 0), orderLimit: null, currentPeriodEnd: end, updatedAt: serverTimestamp() }, { merge: true });
        if (shouldEnableGuestOrders) {
          batch.update(access.restaurant, { isAcceptingOrders: true, updatedAt: serverTimestamp() });
          batch.set(orderingMigrationRef, {
            action: "guest_ordering.enabled_by_default",
            targetType: "restaurant",
            targetId: shopId,
            actorUid: access.user.uid,
            actorEmail: access.user.email ?? null,
            actorRole: access.role,
            details: { reason: "One-time default-on rollout for guest ordering." },
            createdAt: serverTimestamp(),
          });
        }
        for (const table of tableRows.docs) {
          const data = table.data();
          batch.set(doc(db, "restaurants", shopId, "publicTables", table.id), { tableNumber: data.tableNumber ?? "", isActive: data.isActive === true, qrTokenHash: data.qrTokenHash ?? null, updatedAt: serverTimestamp() }, { merge: true });
        }
        if (needsFirebasePlan) {
          batch.set(doc(db, "subscriptions", shopId), { shopId, planId: "free", planName: "Free", amountPaise: 0, orderLimit: null, status: "active", provider: "firebase", currentUsage: Number(billing?.currentUsage ?? 0), currentPeriodStart: now, currentPeriodEnd: end, updatedAt: serverTimestamp() }, { merge: true });
          batch.update(access.restaurant, { planId: "free", subscriptionStatus: "active", updatedAt: serverTimestamp() });
        } else if (!subscriptionSnapshot.exists()) {
          batch.set(doc(db, "subscriptions", shopId), { shopId, planId: "free", planName: "Free", amountPaise: 0, orderLimit: null, status: "active", provider: "firebase", currentUsage: 0, currentPeriodStart: now, currentPeriodEnd: end, updatedAt: serverTimestamp() });
        }
        await batch.commit();
      }
      return { shopId, role: access.role, shopName: String(profile?.name ?? membership.data()?.shopName ?? "Restaurant") } as TOutput;
    }
    case "getSubscription": {
      const access = await actor(shopId, roleNames);
      const ref = doc(db, "subscriptions", shopId);
      const snapshot = await getDoc(ref);
      if (!snapshot.exists()) throw new Error("No subscription record exists for this restaurant.");
      const data = snapshot.data();
      if (access.role === "owner" && data.status !== "active") {
        const now = Timestamp.now();
        const periodEnd = Timestamp.fromMillis(now.toMillis() + 100 * 365.25 * 24 * 60 * 60 * 1000);
        await runTransaction(db, async (tx) => {
          const fresh = await tx.get(ref);
          if (!fresh.exists()) throw new Error("Subscription record no longer exists.");
          tx.update(ref, { planId: "free", planName: "Free", amountPaise: 0, orderLimit: null, status: "active", provider: "firebase", currentPeriodStart: now, currentPeriodEnd: periodEnd, updatedAt: serverTimestamp() });
          tx.update(doc(db, "restaurants", shopId), { planId: "free", subscriptionStatus: "active", updatedAt: serverTimestamp() });
        });
        return { shopId, planId: "free", planName: "Free", amountPaise: 0, orderLimit: null, status: "active", currentUsage: Number(data.currentUsage ?? 0), currentPeriodStartMs: now.toMillis(), currentPeriodEndMs: periodEnd.toMillis(), providerMode: null, graceEndsAtMs: null, checkoutUrl: null, providerSubscriptionId: null, providerStatus: null, billingPeriod: "free", cancelAtCycleEnd: false, cancelEffectiveAtMs: null, pendingCustomContract: null, pendingPlanChange: null, payments: [] } as TOutput;
      }
      return { shopId, planId: data.planId ?? "free", planName: data.planName ?? "Free", amountPaise: Number(data.amountPaise ?? 0), orderLimit: data.orderLimit ?? null, status: data.status ?? "active", currentUsage: Number(data.currentUsage ?? 0), currentPeriodStartMs: toMillis(data.currentPeriodStart), currentPeriodEndMs: toMillis(data.currentPeriodEnd), providerMode: null, graceEndsAtMs: null, checkoutUrl: null, providerSubscriptionId: null, providerStatus: null, billingPeriod: "free", cancelAtCycleEnd: false, cancelEffectiveAtMs: null, pendingCustomContract: null, pendingPlanChange: null, payments: [] } as TOutput;
    }
    case "resolveTableQr":
    case "resolveLegacyTableQr": {
      const token = String(args.token ?? "");
      if (token.length < 30) throw new Error("This table QR is invalid or inactive.");
      const hash = await sha256(token);
      const mapSnapshot = await getDoc(doc(db, "qrLookup", hash));
      const map = mapSnapshot.data();
      if (!mapSnapshot.exists() || map?.isActive !== true) throw new Error("This table QR is invalid or inactive.");
      const rid = String(map.restaurantId ?? "");
      if (name === "resolveLegacyTableQr") return { shopId: rid } as TOutput;
      if (rid !== String(args.shopId ?? "")) throw new Error("This QR belongs to a different restaurant.");
      const [tableSnapshot, restaurantSnapshot] = await Promise.all([
        getDoc(doc(db, "restaurants", rid, "publicTables", String(map.tableId))), getDoc(doc(db, "publicRestaurants", rid)),
      ]);
      const table = tableSnapshot.data(); const restaurant = restaurantSnapshot.data();
      if (!tableSnapshot.exists() || !restaurantSnapshot.exists() || table?.isActive !== true || table.qrTokenHash !== hash) throw new Error("This table QR is no longer available.");
      const end = toMillis(restaurant?.currentPeriodEnd);
      const allowedToOrder = restaurant?.isAcceptingOrders === true && restaurant?.platformStatus !== "suspended" && restaurant?.subscriptionStatus === "active" && end !== null && end > Date.now() && (restaurant?.orderLimit == null || Number(restaurant.currentUsage ?? 0) < Number(restaurant.orderLimit));
      return { shopId: rid, restaurantId: rid, restaurantName: String(restaurant?.name ?? "Restaurant"), tableNumber: String(table.tableNumber), taxRateBps: Number(restaurant?.taxRateBps ?? 0), serviceFeePaise: Number(restaurant?.serviceFeePaise ?? 0), payAtRestaurantEnabled: restaurant?.payAtRestaurantEnabled !== false, upiEnabled: restaurant?.upiEnabled === true, upiId: String(restaurant?.upiId ?? ""), upiPayeeName: String(restaurant?.upiPayeeName ?? restaurant?.name ?? "Restaurant"), isAcceptingOrders: allowedToOrder } as TOutput;
    }
    case "listTables": {
      await actor(shopId, ["owner", "manager"]);
      const rows = await getDocs(query(collection(db, "restaurants", shopId, "tables"), orderBy("tableNumber")));
      return { tables: rows.docs.map((entry) => ({ id: entry.id, tableNumber: entry.data().tableNumber, isActive: entry.data().isActive === true, qrToken: entry.data().qrToken ?? "", createdAt: toMillis(entry.data().createdAt) })) } as TOutput;
    }
    case "createTable": {
      await actor(shopId);
      const tableNumber = String(args.tableNumber ?? "").trim();
      if (!tableNumber || tableNumber.length > 24) throw new Error("Enter a table number up to 24 characters.");
      const normalized = normalizeTableNumber(tableNumber);
      const tableRef = doc(collection(db, "restaurants", shopId, "tables"));
      const numberRef = doc(db, "restaurants", shopId, "tableNumbers", await sha256(normalized));
      const token = newQrToken(); const hash = await sha256(token);
      const restaurantRef = doc(db, "restaurants", shopId);
      await runTransaction(db, async (tx) => {
        const [profile, existing] = await Promise.all([tx.get(restaurantRef), tx.get(numberRef)]);
        if (!profile.exists()) throw new Error("Restaurant profile not found.");
        if (existing.exists()) throw new Error("An active table already uses that number.");
        tx.set(tableRef, { restaurantId: shopId, tableNumber, isActive: true, qrToken: token, qrTokenHash: hash, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
        tx.set(doc(db, "restaurants", shopId, "publicTables", tableRef.id), { tableNumber, isActive: true, qrTokenHash: hash, updatedAt: serverTimestamp() });
        tx.set(numberRef, { tableId: tableRef.id, tableNumber, updatedAt: serverTimestamp() });
        tx.set(doc(db, "qrLookup", hash), { restaurantId: shopId, tableId: tableRef.id, isActive: true, createdAt: serverTimestamp() });
      });
      await audit(shopId, "table.created", "table", tableRef.id, { tableNumber });
      return { id: tableRef.id, tableNumber, qrToken: token } as TOutput;
    }
    case "renameTable": {
      await actor(shopId);
      const tableRef = doc(db, "restaurants", shopId, "tables", String(args.tableId));
      const table = await getDoc(tableRef);
      if (!table.exists()) throw new Error("Table not found.");
      const oldData = table.data(); const nextNumber = String(args.tableNumber ?? "").trim();
      if (!nextNumber || nextNumber.length > 24) throw new Error("Enter a valid table number.");
      if (oldData.isActive) {
        const nextRef = doc(db, "restaurants", shopId, "tableNumbers", await sha256(normalizeTableNumber(nextNumber)));
        const oldRef = doc(db, "restaurants", shopId, "tableNumbers", await sha256(normalizeTableNumber(String(oldData.tableNumber))));
        await runTransaction(db, async (tx) => {
          const [current, next] = await Promise.all([tx.get(tableRef), tx.get(nextRef)]);
          if (!current.exists()) throw new Error("Table not found.");
          if (nextRef.id !== oldRef.id && next.exists()) throw new Error("An active table already uses that number.");
          if (nextRef.id !== oldRef.id) { tx.delete(oldRef); tx.set(nextRef, { tableId: tableRef.id, tableNumber: nextNumber, updatedAt: serverTimestamp() }); }
          tx.update(tableRef, { tableNumber: nextNumber, updatedAt: serverTimestamp() });
          tx.set(doc(db, "restaurants", shopId, "publicTables", tableRef.id), { tableNumber: nextNumber, isActive: true, qrTokenHash: current.data().qrTokenHash, updatedAt: serverTimestamp() }, { merge: true });
        });
      } else {
        await updateDoc(tableRef, { tableNumber: nextNumber, updatedAt: serverTimestamp() });
        await setDoc(doc(db, "restaurants", shopId, "publicTables", tableRef.id), { tableNumber: nextNumber, isActive: false, qrTokenHash: null, updatedAt: serverTimestamp() }, { merge: true });
      }
      await audit(shopId, "table.renamed", "table", tableRef.id, { previous: oldData.tableNumber, tableNumber: nextNumber });
      return { ok: true } as TOutput;
    }
    case "regenerateTableQr": {
      await actor(shopId);
      const tableRef = doc(db, "restaurants", shopId, "tables", String(args.tableId));
      const token = newQrToken(); const hash = await sha256(token);
      await runTransaction(db, async (tx) => {
        const table = await tx.get(tableRef);
        if (!table.exists() || table.data().isActive !== true) throw new Error("Activate the table before regenerating its QR.");
        const oldHash = table.data().qrTokenHash;
        if (typeof oldHash === "string") tx.delete(doc(db, "qrLookup", oldHash));
        tx.set(doc(db, "qrLookup", hash), { restaurantId: shopId, tableId: tableRef.id, isActive: true, createdAt: serverTimestamp() });
        tx.update(tableRef, { qrToken: token, qrTokenHash: hash, updatedAt: serverTimestamp() });
        tx.set(doc(db, "restaurants", shopId, "publicTables", tableRef.id), { qrTokenHash: hash, updatedAt: serverTimestamp() }, { merge: true });
      });
      await audit(shopId, "table.qr_regenerated", "table", tableRef.id);
      return { qrToken: token } as TOutput;
    }
    case "setTableActive": {
      await actor(shopId);
      const tableRef = doc(db, "restaurants", shopId, "tables", String(args.tableId));
      const active = args.isActive === true;
      const token = active ? newQrToken() : ""; const hash = active ? await sha256(token) : "";
      await runTransaction(db, async (tx) => {
        const table = await tx.get(tableRef);
        if (!table.exists()) throw new Error("Table not found.");
        if (table.data().isActive === active) return;
        const numberRef = doc(db, "restaurants", shopId, "tableNumbers", await sha256(normalizeTableNumber(String(table.data().tableNumber))));
        const number = await tx.get(numberRef);
        if (active && number.exists()) throw new Error("An active table already uses that number.");
        if (active) {
          tx.set(numberRef, { tableId: tableRef.id, tableNumber: table.data().tableNumber, updatedAt: serverTimestamp() });
          tx.set(doc(db, "qrLookup", hash), { restaurantId: shopId, tableId: tableRef.id, isActive: true, createdAt: serverTimestamp() });
          tx.update(tableRef, { isActive: true, qrToken: token, qrTokenHash: hash, updatedAt: serverTimestamp() });
          tx.set(doc(db, "restaurants", shopId, "publicTables", tableRef.id), { tableNumber: table.data().tableNumber, isActive: true, qrTokenHash: hash, updatedAt: serverTimestamp() });
        } else {
          tx.delete(numberRef);
          if (typeof table.data().qrTokenHash === "string") tx.delete(doc(db, "qrLookup", table.data().qrTokenHash));
          tx.update(tableRef, { isActive: false, qrToken: null, qrTokenHash: null, updatedAt: serverTimestamp() });
          tx.set(doc(db, "restaurants", shopId, "publicTables", tableRef.id), { tableNumber: table.data().tableNumber, isActive: false, qrTokenHash: null, updatedAt: serverTimestamp() });
        }
      });
      await audit(shopId, active ? "table.activated" : "table.deactivated", "table", tableRef.id);
      return { ok: true, ...(active ? { qrToken: token } : {}) } as TOutput;
    }
    case "placeOrder": {
      const inputData = args as AnyRecord;
      const items = Array.isArray(inputData.items) ? inputData.items as AnyRecord[] : [];
      const paymentTiming = String(inputData.paymentTiming ?? "");
      const paymentMethod = String(inputData.paymentMethod ?? "");
      const whatsappBillOptIn = inputData.whatsappBillOptIn === true;
      if (!items.length || items.length > 50) throw new Error("Add at least one menu item.");
      if (!["prepaid", "pay_after_serve"].includes(paymentTiming) || !["upi", "pay_after_serve"].includes(paymentMethod) || (paymentTiming === "prepaid") !== (paymentMethod === "upi")) throw new Error("Choose a valid restaurant payment method.");
      if (typeof inputData.whatsappBillOptIn !== "boolean") throw new Error("Order contact details are incomplete.");
      const customerName = String(inputData.customerName ?? "").trim(); const customerPhone = String(inputData.customerPhone ?? "").trim();
      const customerEmail = String(inputData.customerEmail ?? "").trim().toLowerCase();
      if (customerName.length < 2 || !/^\+?[0-9()\-\s]{8,20}$/.test(customerPhone)) throw new Error("Enter your name and a valid phone number.");
      if (customerEmail.length > 254 || (customerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(customerEmail))) throw new Error("Enter a valid email address.");
      if (paymentMethod === "upi" && inputData.upiPaymentConfirmed !== true) throw new Error("Complete the UPI payment and confirm it before placing your order.");
      const tokenHash = await sha256(String(inputData.qrToken ?? ""));
      const requestHash = await sha256(JSON.stringify({ tokenHash, customerName, customerPhone, customerEmail, paymentTiming, paymentMethod, whatsappBillOptIn, items }));
      const idempotencyRef = doc(db, "idempotencyLookup", await sha256(String(inputData.idempotencyKey ?? "")));
      const mapRef = doc(db, "qrLookup", tokenHash); const mapSnap = await getDoc(mapRef);
      const map = mapSnap.data();
      if (!mapSnap.exists() || map?.isActive !== true || map.restaurantId !== shopId) throw new Error("This table QR is invalid or inactive.");
      const restaurantRef = doc(db, "publicRestaurants", shopId); const tableRef = doc(db, "restaurants", shopId, "publicTables", String(map.tableId));
      const uniqueIds = [...new Set(items.map((line) => String(line.itemId)))];
      const menuRefs = uniqueIds.map((id) => doc(db, "restaurants", shopId, "menuItems", id));
      const orderRef = doc(collection(db, "restaurants", shopId, "orders"));
      const ticketId = `TS-${randomHex(20).toUpperCase()}`; const trackingId = await sha256(ticketId);
      await runTransaction(db, async (tx) => {
        const [prior, restaurant, table, ...menuSnaps] = await Promise.all([
          tx.get(idempotencyRef), tx.get(restaurantRef), tx.get(tableRef), ...menuRefs.map((ref) => tx.get(ref)),
        ]);
        if (prior.exists()) {
          if (prior.data().requestHash !== requestHash) throw new Error("This order request key was already used with different details.");
          return;
        }
        const profile = restaurant.data(); const tableData = table.data();
        const publicRestaurantRef = doc(db, "publicRestaurants", shopId); const publicTableRef = doc(db, "restaurants", shopId, "publicTables", String(map.tableId));
        const [publicProfile, publicTable] = await Promise.all([tx.get(publicRestaurantRef), tx.get(publicTableRef)]);
        const publicData = publicProfile.data(); const publicTableData = publicTable.data();
        const end = toMillis(publicData?.currentPeriodEnd);
        if (!restaurant.exists() || !table.exists() || !publicProfile.exists() || !publicTable.exists() || tableData?.isActive !== true || tableData?.qrTokenHash !== tokenHash || publicTableData?.qrTokenHash !== tokenHash) throw new Error("This restaurant table is unavailable.");
        if (publicData?.isAcceptingOrders !== true || publicData?.platformStatus === "suspended" || publicData?.subscriptionStatus !== "active" || end === null || end <= Date.now()) throw new Error("Online ordering is temporarily unavailable; please contact staff.");
        if (publicData?.orderLimit != null && Number(publicData.currentUsage ?? 0) >= Number(publicData.orderLimit)) throw new Error("This restaurant has reached its online order limit. Please contact staff.");
        if (paymentMethod === "upi" && (publicData?.upiEnabled !== true || !/^[A-Za-z0-9._-]{2,100}@[A-Za-z0-9.-]{2,64}$/.test(String(publicData.upiId ?? "")))) throw new Error("This restaurant's UPI payment is unavailable. Choose pay at restaurant or contact staff.");
        if (paymentMethod === "pay_after_serve" && publicData?.payAtRestaurantEnabled === false) throw new Error("This restaurant is not accepting pay-at-restaurant orders right now.");
        const byId = new Map(uniqueIds.map((id, index) => [id, menuSnaps[index]]));
        const orderItems = items.map((requested) => {
          const snapshot = byId.get(String(requested.itemId)); const item = snapshot?.data();
          if (!snapshot?.exists() || item?.isActive !== true || item?.isAvailable !== true) throw new Error("A selected menu item is no longer available.");
          const variants = Array.isArray(item.variants) ? item.variants : []; const addOns = Array.isArray(item.addOns) ? item.addOns : [];
          const variant = variants.find((choice: AnyRecord) => choice.id === requested.variantId);
          if (item.variantRequired && !variant) throw new Error(`Choose a portion for ${item.name}.`);
          if (requested.variantId && !variant) throw new Error(`The selected portion for ${item.name} is no longer available.`);
          const addOnIds = Array.isArray(requested.addOnIds) ? requested.addOnIds as string[] : [];
          if (new Set(addOnIds).size !== addOnIds.length) throw new Error("An add-on can only be selected once per dish.");
          const selectedAddOns = addOnIds.map((id) => addOns.find((choice: AnyRecord) => choice.id === id));
          if (selectedAddOns.some((choice) => !choice)) throw new Error(`An add-on for ${item.name} is no longer available.`);
          const quantity = Number(requested.quantity); if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) throw new Error("Choose a valid quantity.");
          const variantDelta = Number(variant?.priceDeltaPaise ?? 0); const addOnTotal = selectedAddOns.reduce((sum, choice) => sum + Number(choice?.pricePaise ?? 0), 0);
          const unitPricePaise = Number(item.pricePaise) + variantDelta + addOnTotal; const lineTotalPaise = unitPricePaise * quantity;
          const selections = [variant?.name, ...selectedAddOns.map((choice) => choice?.name)].filter(Boolean);
          return { menuItemId: String(requested.itemId), name: String(item.name), description: String(item.description ?? ""), imageUrl: String(item.imageUrl ?? ""), dietaryType: item.dietaryType, quantity, unitPricePaise, lineTotalPaise, variant: variant ? { id: variant.id, name: variant.name, priceDeltaPaise: variantDelta } : null, addOns: selectedAddOns, selections, specialInstructions: String(requested.specialInstructions ?? "") };
        });
        const subtotalPaise = orderItems.reduce((sum, line) => sum + line.lineTotalPaise, 0);
        const taxRateBps = Number(profile?.taxRateBps ?? 0); const serviceFeePaise = subtotalPaise > 0 ? Number(profile?.serviceFeePaise ?? 0) : 0;
        const taxPaise = Math.round(subtotalPaise * taxRateBps / 10_000); const totalAmountPaise = subtotalPaise + taxPaise + serviceFeePaise;
        const initialEvent = { status: "queued", at: Timestamp.now() };
        const paymentStatus = "pending";
        const orderData = { id: orderRef.id, ticketId, restaurantId: shopId, tableId: tableRef.id, qrTokenHash: tokenHash, tableNumberSnapshot: String(tableData?.tableNumber), customerName, customerPhone, customerEmail, whatsappBillOptIn, items: orderItems, subtotalPaise, taxPaise, serviceFeePaise, totalAmountPaise, paymentTiming, paymentStatus, paymentProvider: "manual", paymentMethod, paymentPaidAt: null, status: "queued", estimatedMinutes: null, expectedReadyAt: null, assignedStaffUid: null, createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
        tx.set(orderRef, orderData);
        tx.set(doc(db, "restaurants", shopId, "kitchenOrders", orderRef.id), { ticketId, tableNumberSnapshot: orderData.tableNumberSnapshot, items: orderItems.map((line) => ({ name: line.name, quantity: line.quantity, selections: line.selections, specialInstructions: line.specialInstructions })), status: "queued", estimatedMinutes: null, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
        tx.set(doc(db, "restaurants", shopId, "publicTracking", trackingId), { orderId: orderRef.id, ticketId, tableNumber: orderData.tableNumberSnapshot, status: "queued", paymentTiming, paymentStatus, paymentMethod, items: orderItems.map((line) => ({ name: line.name, quantity: line.quantity, lineTotalPaise: line.lineTotalPaise, selections: line.selections })), subtotalPaise, taxPaise, serviceFeePaise, totalAmountPaise, paymentPaidAt: orderData.paymentPaidAt, estimatedMinutes: null, expectedReadyAt: null, statusEvents: [initialEvent], createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
        tx.set(doc(db, "ticketLookup", trackingId), { restaurantId: shopId, trackingId, ticketId, createdAt: serverTimestamp() });
        tx.set(idempotencyRef, { requestHash, restaurantId: shopId, orderId: orderRef.id, ticketId, trackingId, createdAt: serverTimestamp() });
      });
      const existing = await getDoc(idempotencyRef);
      return { ticketId: existing.data()?.ticketId ?? ticketId } as TOutput;
    }
    case "lookupTicket": {
      const ticketId = String(args.ticketId ?? "").trim().toUpperCase();
      if (!/^TS-[A-F0-9]{40}$/.test(ticketId)) throw new Error("Ticket ID not found.");
      const trackingId = await sha256(ticketId); const pointer = await getDoc(doc(db, "ticketLookup", trackingId));
      if (!pointer.exists() || pointer.data().ticketId !== ticketId) throw new Error("Ticket ID not found.");
      const restaurantId = String(pointer.data().restaurantId); const tracking = await getDoc(doc(db, "restaurants", restaurantId, "publicTracking", trackingId));
      if (!tracking.exists()) throw new Error("Ticket ID not found.");
      const data = tracking.data();
      return { restaurantId, trackingId, tracking: { ticketId: data.ticketId, tableNumber: data.tableNumber, status: data.status, paymentTiming: data.paymentTiming, paymentStatus: data.paymentStatus, paymentMethod: data.paymentMethod, items: Array.isArray(data.items) ? data.items.map((item: AnyRecord) => ({ name: String(item.name ?? "Item"), quantity: Number(item.quantity ?? 0), lineTotalPaise: Number(item.lineTotalPaise ?? 0), selections: Array.isArray(item.selections) ? item.selections.map(String) : [] })) : [], subtotalPaise: typeof data.subtotalPaise === "number" ? data.subtotalPaise : undefined, taxPaise: typeof data.taxPaise === "number" ? data.taxPaise : undefined, serviceFeePaise: typeof data.serviceFeePaise === "number" ? data.serviceFeePaise : undefined, totalAmountPaise: typeof data.totalAmountPaise === "number" ? data.totalAmountPaise : undefined, estimatedMinutes: data.estimatedMinutes ?? null, expectedReadyAtMs: toMillis(data.expectedReadyAt), statusEvents: Array.isArray(data.statusEvents) ? data.statusEvents.map((event: AnyRecord) => ({ status: event.status, atMs: toMillis(event.at) })) : [] } } as TOutput;
    }
    case "setOrderEta":
    case "setOrderStatus": {
      const allowedRoles: Role[] = name === "setOrderEta" ? ["owner", "manager"] : roleNames;
      const access = await actor(shopId, allowedRoles); const orderId = String(args.orderId ?? "");
      const orderRef = doc(db, "restaurants", shopId, "orders", orderId);
      const orderViewRef = access.role === "kitchen"
        ? doc(db, "restaurants", shopId, "kitchenOrders", orderId)
        : access.role === "waiter" ? doc(db, "restaurants", shopId, "assignedOrders", orderId) : orderRef;
      const viewSnapshot = await getDoc(orderViewRef);
      if (!viewSnapshot.exists()) throw new Error("Order not found.");
      const order = viewSnapshot.data(); let nextStatus = String(args.status ?? order.status) as Status;
      const eta = Number(args.estimatedMinutes);
      if (name === "setOrderEta") {
        if (!Number.isInteger(eta) || eta < 1 || eta > 240 || !["queued", "accepted", "preparing"].includes(order.status)) throw new Error("ETA can only be set between 1 and 240 minutes for an active order.");
        if (order.status === "queued") nextStatus = "accepted";
      }
      if (name === "setOrderStatus") {
        const transitions: Record<string, string[]> = { queued: ["accepted", "cancelled"], accepted: ["preparing", "cancelled"], preparing: ["ready"], ready: ["served"], served: [], cancelled: [] };
        if (!transitions[order.status]?.includes(nextStatus)) throw new Error(`Cannot move an order from ${order.status} to ${nextStatus}.`);
        if (nextStatus === "cancelled" && access.role !== "owner") throw new Error("Only the restaurant owner can cancel an order.");
        if (access.role === "kitchen" && !["preparing", "ready"].includes(nextStatus)) throw new Error("Kitchen staff can move orders into preparation or mark them ready.");
        if (access.role === "waiter" && (nextStatus !== "served" || order.assignedStaffUid !== access.user.uid)) throw new Error("Waiters can mark only their own assigned orders as served.");
      }
      const trackingId = await sha256(String(order.ticketId));
      const refs = [doc(db, "restaurants", shopId, "publicTracking", trackingId), doc(db, "restaurants", shopId, "kitchenOrders", orderId), doc(db, "restaurants", shopId, "assignedOrders", orderId)];
      const now = Timestamp.now(); const event = { status: nextStatus, at: now };
      const usesUsage = (order.status === "queued" && nextStatus === "accepted") || (order.status === "accepted" && nextStatus === "cancelled");
      await runTransaction(db, async (tx) => {
        const subscriptionRef = doc(db, "subscriptions", shopId); const publicRestaurantRef = doc(db, "publicRestaurants", shopId); const usageRef = doc(db, "restaurants", shopId, "usageEvents", orderId);
        const [fresh, ...related] = await Promise.all([tx.get(orderViewRef), ...refs.map((ref) => tx.get(ref)), tx.get(subscriptionRef), tx.get(publicRestaurantRef), ...(usesUsage ? [tx.get(usageRef)] : [])]);
        const projectionSnapshots = related.slice(0, refs.length);
        const usageSnapshot = usesUsage ? related[refs.length + 2] : null;
        if (!fresh.exists()) throw new Error("Order not found.");
        const patch: AnyRecord = { status: nextStatus, updatedAt: serverTimestamp() };
        if (name === "setOrderEta") { patch.estimatedMinutes = eta; patch.expectedReadyAt = Timestamp.fromMillis(now.toMillis() + eta * 60_000); }
        if (fresh.data().status !== nextStatus || name === "setOrderStatus") patch.statusEvents = arrayUnion(event);
        tx.update(orderRef, patch);
        if (fresh.data().status === "queued" && nextStatus === "accepted" && usageSnapshot && !usageSnapshot.exists()) {
          tx.update(subscriptionRef, { currentUsage: increment(1), updatedAt: serverTimestamp() });
          tx.update(doc(db, "restaurants", shopId), { lifetimeAcceptedOrders: increment(1), updatedAt: serverTimestamp() });
          tx.update(publicRestaurantRef, { currentUsage: increment(1), updatedAt: serverTimestamp() });
          tx.set(usageRef, { shopId, orderId, billable: true, acceptedAt: serverTimestamp(), createdAt: serverTimestamp() });
        } else if (fresh.data().status === "accepted" && nextStatus === "cancelled" && usageSnapshot?.exists() && usageSnapshot.data().billable === true && !usageSnapshot.data().reversedAt) {
          tx.update(subscriptionRef, { currentUsage: increment(-1), updatedAt: serverTimestamp() });
          tx.update(doc(db, "restaurants", shopId), { lifetimeAcceptedOrders: increment(-1), updatedAt: serverTimestamp() });
          tx.update(publicRestaurantRef, { currentUsage: increment(-1), updatedAt: serverTimestamp() });
          tx.update(usageRef, { reversedAt: serverTimestamp(), reversalReason: "eligible_cancellation_before_preparation" });
        }
        projectionSnapshots.forEach((snapshot, index) => {
          if (!snapshot.exists()) return;
          const viewPatch: AnyRecord = { status: nextStatus, updatedAt: serverTimestamp() };
          if (name === "setOrderEta") { viewPatch.estimatedMinutes = eta; viewPatch.expectedReadyAt = patch.expectedReadyAt; }
          if (index === 0 && (fresh.data().status !== nextStatus || name === "setOrderStatus")) viewPatch.statusEvents = arrayUnion(event);
          tx.update(refs[index], viewPatch);
        });
      });
      await audit(shopId, name === "setOrderEta" ? "order.eta_saved" : "order.status_changed", "order", orderId, { ticketId: order.ticketId, status: nextStatus, ...(name === "setOrderEta" ? { estimatedMinutes: eta } : {}) });
      return { ok: true } as TOutput;
    }
    case "createCategory": {
      await actor(shopId);
      const nameValue = String(args.name ?? "").trim();
      if (nameValue.length < 2 || nameValue.length > 80) throw new Error("Category name must have 2 to 80 characters.");
      const duplicate = await getDocs(query(collection(db, "restaurants", shopId, "categories"), where("nameKey", "==", nameValue.toLocaleLowerCase("en-US")), limit(1)));
      if (!duplicate.empty) throw new Error("That category already exists.");
      const result = await addDoc(collection(db, "restaurants", shopId, "categories"), { name: nameValue, nameKey: nameValue.toLocaleLowerCase("en-US"), isActive: true, sortOrder: Date.now(), createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      await audit(shopId, "menu.category_created", "category", result.id, { name: nameValue });
      return { id: result.id } as TOutput;
    }
    case "importMenu": {
      await actor(shopId);
      const rows = Array.isArray(args.rows) ? args.rows as MenuImportRow[] : [];
      if (!rows.length || rows.length > 400) throw new Error("Import between 1 and 400 menu items at a time.");
      const normalizedRows = rows.map((row) => {
        const name = String(row.name ?? "").trim();
        const category = String(row.category ?? "").trim();
        const description = String(row.description ?? "").trim();
        const priceRupees = Number(row.priceRupees);
        if (name.length < 2 || name.length > 100 || category.length < 2 || category.length > 80
          || description.length > 500 || !Number.isFinite(priceRupees) || priceRupees < 0 || priceRupees > 10_000_000) {
          throw new Error("Each imported dish needs a name, category, and valid price; descriptions can be up to 500 characters.");
        }
        return { name, category, description, pricePaise: Math.round(priceRupees * 100), dietaryType: row.dietaryType === "non-veg" ? "non-veg" as const : "veg" as const };
      });

      const categoryCollection = collection(db, "restaurants", shopId, "categories");
      const existingCategories = await getDocs(categoryCollection);
      const categoryByName = new Map<string, { id: string; isActive: boolean }>();
      for (const entry of existingCategories.docs) {
        const data = entry.data();
        const key = String(data.nameKey ?? String(data.name ?? "").toLocaleLowerCase("en-US"));
        if (!categoryByName.has(key) || data.isActive === true) categoryByName.set(key, { id: entry.id, isActive: data.isActive === true });
      }

      const batch = writeBatch(db);
      const categoriesToCreate: string[] = [];
      const categoriesToActivate: string[] = [];
      const categoryIds = new Map<string, string>();
      const now = serverTimestamp();
      for (const row of normalizedRows) {
        const key = row.category.toLocaleLowerCase("en-US");
        const existing = categoryByName.get(key);
        if (existing) {
          categoryIds.set(key, existing.id);
          if (!existing.isActive && !categoriesToActivate.includes(existing.id)) {
            batch.update(doc(db, "restaurants", shopId, "categories", existing.id), { isActive: true, updatedAt: now });
            categoriesToActivate.push(existing.id);
          }
          continue;
        }
        const categoryRef = doc(categoryCollection);
        batch.set(categoryRef, { name: row.category, nameKey: key, isActive: true, sortOrder: existingCategories.size + categoriesToCreate.length, createdAt: now, updatedAt: now });
        categoryByName.set(key, { id: categoryRef.id, isActive: true });
        categoryIds.set(key, categoryRef.id);
        categoriesToCreate.push(row.category);
      }
      if (normalizedRows.length + categoriesToCreate.length + categoriesToActivate.length > 450) {
        throw new Error("This import creates too many Firestore records at once. Split it into smaller menu files.");
      }
      normalizedRows.forEach((row, index) => {
        const categoryId = categoryIds.get(row.category.toLocaleLowerCase("en-US"));
        if (!categoryId) throw new Error("Could not match an imported dish to its menu category.");
        const itemRef = doc(collection(db, "restaurants", shopId, "menuItems"));
        batch.set(itemRef, {
          name: row.name, description: row.description, categoryId, pricePaise: row.pricePaise, dietaryType: row.dietaryType,
          imageUrl: "", variants: [], addOns: [], variantRequired: false, isActive: true, isAvailable: true,
          sortOrder: Date.now() + index, createdAt: now, updatedAt: now,
        });
      });
      await batch.commit();
      await audit(shopId, "menu.items_imported", "menu", shopId, { itemCount: normalizedRows.length, createdCategoryCount: categoriesToCreate.length });
      return { importedCount: normalizedRows.length, createdCategories: categoriesToCreate.length } as TOutput;
    }
    case "saveMenuItem": {
      await actor(shopId);
      const payload = args as AnyRecord; const nameValue = String(payload.name ?? "").trim();
      if (nameValue.length < 2 || nameValue.length > 100 || !Number.isInteger(payload.pricePaise) || payload.pricePaise < 0) throw new Error("Enter a valid menu name and price.");
      const itemRef = payload.itemId ? doc(db, "restaurants", shopId, "menuItems", String(payload.itemId)) : doc(collection(db, "restaurants", shopId, "menuItems"));
      await runTransaction(db, async (tx) => {
        const [category, old] = await Promise.all([tx.get(doc(db, "restaurants", shopId, "categories", String(payload.categoryId))), tx.get(itemRef)]);
        if (!category.exists() || category.data().isActive !== true) throw new Error("Choose an active menu category.");
        if (payload.itemId && !old.exists()) throw new Error("Menu item not found.");
        const previous = old.data();
        tx.set(itemRef, { name: nameValue, description: String(payload.description ?? ""), categoryId: String(payload.categoryId), pricePaise: Number(payload.pricePaise), dietaryType: payload.dietaryType === "non-veg" ? "non-veg" : "veg", imageUrl: String(payload.imageUrl ?? ""), variants: Array.isArray(payload.variants) ? payload.variants : [], addOns: Array.isArray(payload.addOns) ? payload.addOns : [], variantRequired: Array.isArray(payload.variants) && payload.variants.length > 0, isActive: previous?.isActive ?? true, isAvailable: previous?.isAvailable ?? true, sortOrder: previous?.sortOrder ?? Date.now(), createdAt: previous?.createdAt ?? serverTimestamp(), updatedAt: serverTimestamp() });
      });
      await audit(shopId, payload.itemId ? "menu.item_updated" : "menu.item_created", "menuItem", itemRef.id, { name: nameValue, pricePaise: payload.pricePaise });
      return { id: itemRef.id } as TOutput;
    }
    case "setMenuAvailability": {
      await actor(shopId); const itemRef = doc(db, "restaurants", shopId, "menuItems", String(args.itemId));
      await updateDoc(itemRef, { isAvailable: args.isAvailable === true, updatedAt: serverTimestamp() });
      await audit(shopId, "menu.availability_changed", "menuItem", itemRef.id, { isAvailable: args.isAvailable === true });
      return { ok: true } as TOutput;
    }
    case "getRestaurantSettings": {
      await actor(shopId, roleNames); const snapshot = await getDoc(doc(db, "restaurants", shopId));
      if (!snapshot.exists()) throw new Error("Restaurant profile not found.");
      const data = snapshot.data(); return { name: data.name ?? "", taxRateBps: Number(data.taxRateBps ?? 0), serviceFeePaise: Number(data.serviceFeePaise ?? 0), isAcceptingOrders: data.isAcceptingOrders === true, payAtRestaurantEnabled: data.payAtRestaurantEnabled !== false, upiEnabled: data.upiEnabled === true, upiId: String(data.upiId ?? ""), upiPayeeName: String(data.upiPayeeName ?? data.name ?? "") } as TOutput;
    }
    case "saveRestaurantSettings": {
      await actor(shopId, ["owner"]); const settings = args as AnyRecord;
      if (String(settings.name ?? "").trim().length < 2 || !Number.isInteger(settings.taxRateBps) || settings.taxRateBps < 0 || settings.taxRateBps > 10_000 || !Number.isInteger(settings.serviceFeePaise) || settings.serviceFeePaise < 0) throw new Error("Enter valid restaurant settings.");
      const payAtRestaurantEnabled = settings.payAtRestaurantEnabled === true; const upiEnabled = settings.upiEnabled === true;
      const upiId = String(settings.upiId ?? "").trim(); const upiPayeeName = String(settings.upiPayeeName ?? "").trim();
      if (!payAtRestaurantEnabled && !upiEnabled) throw new Error("Enable at least one payment method.");
      if (upiEnabled && (!/^[A-Za-z0-9._-]{2,100}@[A-Za-z0-9.-]{2,64}$/.test(upiId) || upiPayeeName.length < 2 || upiPayeeName.length > 80)) throw new Error("Enter a valid UPI ID and payee name.");
      const paymentConfig = { payAtRestaurantEnabled, upiEnabled, upiId: upiEnabled ? upiId : "", upiPayeeName: upiEnabled ? upiPayeeName : String(settings.name).trim() };
      await updateDoc(doc(db, "restaurants", shopId), { name: String(settings.name).trim(), nameKey: String(settings.name).trim().toLocaleLowerCase("en-US"), taxRateBps: settings.taxRateBps, serviceFeePaise: settings.serviceFeePaise, isAcceptingOrders: settings.isAcceptingOrders === true, ...paymentConfig, updatedAt: serverTimestamp() });
      await setDoc(doc(db, "publicRestaurants", shopId), { name: String(settings.name).trim(), taxRateBps: settings.taxRateBps, serviceFeePaise: settings.serviceFeePaise, isAcceptingOrders: settings.isAcceptingOrders === true, ...paymentConfig, updatedAt: serverTimestamp() }, { merge: true });
      await audit(shopId, "restaurant.settings_updated", "restaurant", shopId, settings);
      return { ok: true } as TOutput;
    }
    case "listStaff": {
      await actor(shopId, ["owner"]); const rows = await getDocs(query(collection(db, "restaurants", shopId, "staff"), orderBy("email")));
      return { staff: rows.docs.map((entry) => ({ uid: entry.id, email: entry.data().email ?? "", displayName: entry.data().displayName ?? "", role: entry.data().role, isActive: entry.data().isActive === true })) } as TOutput;
    }
    case "setStaffRole": {
      await actor(shopId, ["owner"]); const email = String(args.email ?? "").trim().toLowerCase(); const role = args.role as Role;
      if (!email.includes("@") || !["manager", "kitchen", "waiter"].includes(role)) throw new Error("Enter a valid email and role.");
      const existing = await getDocs(query(collection(db, "restaurants", shopId, "staff"), where("email", "==", email), limit(1)));
      if (!existing.empty) {
        const member = existing.docs[0]; if (member.data().role === "owner") throw new Error("Owner accounts cannot be changed through the staff role form.");
        const staffRef = doc(db, "restaurants", shopId, "staff", member.id); const membershipRef = doc(db, "users", member.id, "memberships", shopId);
        const active = args.isActive !== false;
        const restaurantSnapshot = await getDoc(doc(db, "restaurants", shopId));
        const shopName = restaurantSnapshot.data()?.name ?? "Restaurant";
        await runTransaction(db, async (tx) => {
          tx.set(staffRef, { role, isActive: active, updatedAt: serverTimestamp() }, { merge: true });
          tx.set(membershipRef, { uid: member.id, shopId, shopName, role, isActive: active, updatedAt: serverTimestamp() }, { merge: true });
        });
        await audit(shopId, "staff.role_changed", "staff", member.id, { email, role, isActive: active });
        return { ok: true, invited: false } as TOutput;
      }
      await addDoc(collection(db, "staffInvites"), { restaurantId: shopId, email, role, isActive: args.isActive !== false, status: "pending", createdAt: serverTimestamp() });
      return { ok: true, invited: true } as TOutput;
    }
    case "assignWaiterToOrder":
    case "masterAssignWaiterToOrder": {
      if (name === "masterAssignWaiterToOrder") await platformAdmin(); else await actor(shopId, ["owner"]);
      const targetShop = String(args.shopId ?? shopId); const orderId = String(args.orderId); const staffUid = args.staffUid ? String(args.staffUid) : "";
      const orderRef = doc(db, "restaurants", targetShop, "orders", orderId); const assignedRef = doc(db, "restaurants", targetShop, "assignedOrders", orderId);
      const staffRef = staffUid ? doc(db, "restaurants", targetShop, "staff", staffUid) : null;
      await runTransaction(db, async (tx) => {
        const [order, assigned, staff] = await Promise.all([tx.get(orderRef), tx.get(assignedRef), staffRef ? tx.get(staffRef) : Promise.resolve(null)]);
        if (!order.exists()) throw new Error("Order not found.");
        if (["served", "cancelled"].includes(String(order.data().status))) throw new Error("Only open orders can be assigned.");
        if (staffUid && (!staff?.exists() || staff.data()?.isActive !== true || staff.data()?.role !== "waiter")) throw new Error("Choose an active waiter assigned to this restaurant.");
        tx.update(orderRef, { assignedStaffUid: staffUid || null, assignedAt: staffUid ? serverTimestamp() : null, updatedAt: serverTimestamp() });
        if (!staffUid) { if (assigned.exists()) tx.delete(assignedRef); }
        else tx.set(assignedRef, { ticketId: order.data().ticketId, tableNumberSnapshot: order.data().tableNumberSnapshot, items: (order.data().items ?? []).map((line: AnyRecord) => ({ name: line.name, quantity: line.quantity, selections: line.selections ?? [], specialInstructions: line.specialInstructions ?? "" })), status: order.data().status, estimatedMinutes: order.data().estimatedMinutes ?? null, expectedReadyAt: order.data().expectedReadyAt ?? null, assignedStaffUid: staffUid, createdAt: order.data().createdAt ?? serverTimestamp(), updatedAt: serverTimestamp() });
      });
      return { ok: true } as TOutput;
    }
    case "platformOverview": {
      await platformAdmin();
      const restaurantCollection = collection(db, "restaurants");
      const [total, active, suspended, acceptedOrders, restaurantRows] = await Promise.all([
        getCountFromServer(restaurantCollection),
        getCountFromServer(query(restaurantCollection, where("subscriptionStatus", "==", "active"))),
        getCountFromServer(query(restaurantCollection, where("platformStatus", "==", "suspended"))),
        getAggregateFromServer(restaurantCollection, { total: sum("lifetimeAcceptedOrders") }),
        getDocs(query(restaurantCollection, orderBy("createdAt", "desc"), limit(10))),
      ]);
      const metrics = {
        tenantTotal: total.data().count,
        tenantActive: active.data().count,
        platformSuspended: suspended.data().count,
        totalAcceptedOrders: acceptedOrders.data().total ?? 0,
      };
      const recent = await Promise.all(restaurantRows.docs.map(async (entry) => {
        const data = entry.data(); const [subscription, staffCount] = await Promise.all([getDoc(doc(db, "subscriptions", entry.id)), getDocs(query(collection(db, "restaurants", entry.id, "staff"), where("isActive", "==", true)))]);
        const billing = subscription.data() ?? {}; const state = String(billing.status ?? data.subscriptionStatus ?? "active");
        return { shopId: entry.id, name: data.name ?? "Restaurant", ownerEmail: data.ownerEmail ?? "", city: data.city ?? "", state: data.state ?? "", platformStatus: data.platformStatus ?? "active", subscriptionStatus: state, planId: billing.planId ?? "free", planName: billing.planName ?? "Free", currentUsage: Number(billing.currentUsage ?? 0), orderLimit: null, lifetimeAcceptedOrders: Number(data.lifetimeAcceptedOrders ?? 0), activeStaff: staffCount.size, createdAtMs: toMillis(data.createdAt) };
      }));
      return { metrics, recent } as TOutput;
    }
    case "masterListRestaurants": {
      await platformAdmin(); const size = Math.min(Math.max(Number(args.pageSize ?? 25), 1), 100); const term = String(args.search ?? "").trim().toLocaleLowerCase("en-US");
      let base = query(collection(db, "restaurants"), orderBy("nameKey"));
      if (term) base = query(collection(db, "restaurants"), where("nameKey", ">=", term), where("nameKey", "<=", `${term}\uf8ff`), orderBy("nameKey"));
      if (args.cursorId) { const cursor = await getDoc(doc(db, "restaurants", String(args.cursorId))); if (cursor.exists()) base = query(base, startAfter(cursor)); }
      const rows = await getDocs(query(base, limit(size + 1))); const page = rows.docs.slice(0, size);
      const tenants = await Promise.all(page.map(async (entry) => {
        const data = entry.data(); const [subscription, staffCount] = await Promise.all([getDoc(doc(db, "subscriptions", entry.id)), getDocs(query(collection(db, "restaurants", entry.id, "staff"), where("isActive", "==", true)))]);
        const billing = subscription.data() ?? {};
        return { shopId: entry.id, name: data.name ?? "Restaurant", ownerEmail: data.ownerEmail ?? "", city: data.city ?? "", state: data.state ?? "", platformStatus: data.platformStatus ?? "active", subscriptionStatus: billing.status ?? "active", planId: billing.planId ?? "free", planName: billing.planName ?? "Free", currentUsage: Number(billing.currentUsage ?? 0), orderLimit: null, lifetimeAcceptedOrders: Number(data.lifetimeAcceptedOrders ?? 0), activeStaff: staffCount.size, createdAtMs: toMillis(data.createdAt) };
      }));
      return { tenants, nextCursor: rows.docs.length > size ? page.at(-1)?.id ?? null : null } as TOutput;
    }
    case "masterListRestaurantWorkforce": {
      await platformAdmin(); const id = String(args.shopId); const profile = await getDoc(doc(db, "restaurants", id));
      if (!profile.exists()) throw new Error("Restaurant not found.");
      const [staffRows, orders] = await Promise.all([getDocs(collection(db, "restaurants", id, "staff")), getDocs(query(collection(db, "restaurants", id, "orders"), orderBy("createdAt", "desc"), limit(200)))]);
      const openOrders = orders.docs.filter((entry) => !["served", "cancelled"].includes(String(entry.data().status)));
      const staff = staffRows.docs.map((entry) => ({ uid: entry.id, email: entry.data().email ?? "", displayName: entry.data().displayName ?? "", role: entry.data().role, isActive: entry.data().isActive === true, openAssignments: openOrders.filter((order) => order.data().assignedStaffUid === entry.id).map((order) => ({ orderId: order.id, ticketId: order.data().ticketId, tableNumber: order.data().tableNumberSnapshot, status: order.data().status, createdAtMs: toMillis(order.data().createdAt), assignedStaffUid: entry.id })) }));
      return { shop: { shopId: id, name: profile.data().name ?? "Restaurant" }, staff, openOrders: openOrders.map((entry) => ({ orderId: entry.id, ticketId: entry.data().ticketId, tableNumber: entry.data().tableNumberSnapshot, status: entry.data().status, createdAtMs: toMillis(entry.data().createdAt), assignedStaffUid: entry.data().assignedStaffUid ?? null })) } as TOutput;
    }
    case "masterSetRestaurantStatus": {
      const admin = await platformAdmin(); const status = args.status === "suspended" ? "suspended" : "active"; const id = String(args.shopId);
      await updateDoc(doc(db, "restaurants", id), { platformStatus: status, updatedAt: serverTimestamp() });
      await setDoc(doc(db, "publicRestaurants", id), { platformStatus: status, updatedAt: serverTimestamp() }, { merge: true });
      await addDoc(collection(db, "platformAuditLogs"), { action: "restaurant.platform_status_changed", actorUid: admin.user.uid, actorEmail: admin.email, targetId: id, details: { status, note: args.note ?? "" }, createdAt: serverTimestamp() });
      return { ok: true } as TOutput;
    }
    case "masterAddSupportNote": {
      const admin = await platformAdmin(); const note = String(args.note ?? "").trim(); if (note.length < 5 || note.length > 1000) throw new Error("Enter a support note between 5 and 1000 characters.");
      await addDoc(collection(db, "platformAuditLogs"), { action: "support.note_added", actorUid: admin.user.uid, actorEmail: admin.email, targetId: String(args.shopId), details: { note }, createdAt: serverTimestamp() });
      return { ok: true } as TOutput;
    }
    case "masterListAuditLogs": {
      await platformAdmin(); const rows = await getDocs(query(collection(db, "platformAuditLogs"), orderBy("createdAt", "desc"), limit(200)));
      return { logs: rows.docs.map((entry) => ({ id: entry.id, ...entry.data(), createdAtMs: toMillis(entry.data().createdAt) })) } as TOutput;
    }
    case "masterAssignRestaurantStaff": {
      await platformAdmin(); const email = String(args.email ?? "").trim().toLowerCase(); const targetShop = String(args.shopId ?? ""); const role = args.role as Role;
      if (!email.includes("@") || !roleNames.includes(role) || role === "owner") throw new Error("Enter a verified staff email and a supported role.");
      await addDoc(collection(db, "staffInvites"), { restaurantId: targetShop, email, role, isActive: true, status: "pending", createdAt: serverTimestamp() });
      await addDoc(collection(db, "platformAuditLogs"), { action: "staff.invite_created", actorUid: auth.currentUser?.uid, actorEmail: auth.currentUser?.email, targetId: targetShop, details: { email, role }, createdAt: serverTimestamp() });
      return { ok: true, invited: true } as TOutput;
    }
    default: throw new Error(`Firebase action is not available: ${name}`);
  }
}

export async function claimPendingStaffInvites() {
  const { auth, db } = getFirebase(); const user = auth.currentUser;
  if (!user?.email || !user.emailVerified) return;
  const invites = await getDocs(query(collection(db, "staffInvites"), where("email", "==", user.email.toLowerCase()), where("status", "==", "pending"), limit(20)));
  for (const invite of invites.docs) {
    const data = invite.data(); const shopId = String(data.restaurantId ?? ""); const role = data.role as Role;
    if (!shopId || !roleNames.includes(role) || role === "owner" || data.isActive === false) continue;
    const staffRef = doc(db, "restaurants", shopId, "staff", user.uid); const membershipRef = doc(db, "users", user.uid, "memberships", shopId); const restaurantRef = doc(db, "restaurants", shopId);
    await runTransaction(db, async (tx) => {
      const [currentInvite, profile] = await Promise.all([tx.get(invite.ref), tx.get(restaurantRef)]);
      if (!currentInvite.exists() || currentInvite.data().status !== "pending" || !profile.exists()) return;
      const currentRole = currentInvite.data().role as Role;
      tx.set(staffRef, { uid: user.uid, email: user.email!.toLowerCase(), displayName: user.displayName ?? "", role: currentRole, isActive: true, inviteId: invite.id, updatedAt: serverTimestamp(), createdAt: serverTimestamp() }, { merge: true });
      tx.set(membershipRef, { uid: user.uid, shopId, shopName: profile.data().name ?? "Restaurant", role: currentRole, isActive: true, inviteId: invite.id, updatedAt: serverTimestamp(), createdAt: serverTimestamp() }, { merge: true });
      tx.delete(invite.ref);
    });
  }
}
