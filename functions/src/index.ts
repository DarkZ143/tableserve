import { initializeApp, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, Timestamp, getFirestore, type DocumentSnapshot, type Transaction } from "firebase-admin/firestore";
import { HttpsError, onCall, onRequest, type CallableRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { calculateOrderAmounts, canAcceptRestaurantOrders, isBillableOrderTransition, isEligibleUsageReversal, isValidPhone, isWithinOrderQuota, newQrToken, newTicketId, normalizeTableNumber, qrShopMatchesRoute, sha256, transitionAllowed } from "./domain.js";

if (!getApps().length) initializeApp();
const db = getFirestore();
const auth = getAuth();
const REGION = "us-central1";
const CALL_OPTIONS = { region: REGION, enforceAppCheck: true, maxInstances: 20 } as const;
const RAZORPAY_KEY_ID = defineSecret("RAZORPAY_KEY_ID");
const RAZORPAY_KEY_SECRET = defineSecret("RAZORPAY_KEY_SECRET");
const RAZORPAY_WEBHOOK_SECRET = defineSecret("RAZORPAY_WEBHOOK_SECRET");
type RazorpayMode = "test" | "live";
function configuredRazorpayMode(): RazorpayMode | null {
  const keyId = RAZORPAY_KEY_ID.value().trim();
  if (keyId.startsWith("rzp_test_")) return "test";
  if (keyId.startsWith("rzp_live_")) return "live";
  return null;
}
function requireRazorpayMode(): RazorpayMode {
  const mode = configuredRazorpayMode();
  if (!mode) throw new HttpsError("failed-precondition", "Set RAZORPAY_KEY_ID to a Razorpay Test Mode key (rzp_test_...) or Live Mode key (rzp_live_...).");
  return mode;
}
function providerPlanIdField(mode: RazorpayMode) { return mode === "test" ? "razorpayTestPlanId" : "razorpayLivePlanId"; }
function planProviderId(plan: Record<string, any>, mode: RazorpayMode): string {
  const value = plan[providerPlanIdField(mode)];
  return typeof value === "string" ? value : "";
}
function assertSubscriptionMode(subscription: Record<string, any> | undefined, mode: RazorpayMode) {
  if (subscription?.providerMode && subscription.providerMode !== mode) {
    throw new HttpsError("failed-precondition", `This subscription belongs to Razorpay ${String(subscription.providerMode).toUpperCase()} Mode. Use that mode's Firebase Functions credentials to manage it.`);
  }
}
const roles = ["owner", "manager", "kitchen", "waiter"] as const;
type Role = typeof roles[number];
type Actor = { uid: string; email: string; restaurantId: string; role: Role };
type Status = "queued" | "accepted" | "preparing" | "ready" | "served" | "cancelled";

function invalid(message: string): never { throw new HttpsError("invalid-argument", message); }
function zodInput<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) invalid(parsed.error.issues.map((issue) => issue.message).join(" "));
  return parsed.data;
}

async function requireStaff(request: CallableRequest<unknown>, allowed: Role[] = ["owner", "manager"]): Promise<Actor> {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in with a staff account.");
  const uid = request.auth.uid;
  if (request.auth.token.email_verified !== true) throw new HttpsError("failed-precondition", "Verify your account email before accessing restaurant operations.");
  const data = request.data && typeof request.data === "object" ? request.data as Record<string, unknown> : {};
  const claimedShop = typeof request.auth.token.shopId === "string" ? request.auth.token.shopId : typeof request.auth.token.restaurantId === "string" ? request.auth.token.restaurantId : "";
  const restaurantId = typeof data.shopId === "string" && data.shopId.length > 0 ? data.shopId : claimedShop;
  if (!restaurantId || restaurantId.length > 128) throw new HttpsError("permission-denied", "Select a restaurant workspace first.");
  const [member, membership] = await Promise.all([
    db.doc(`restaurants/${restaurantId}/staff/${uid}`).get(),
    db.doc(`users/${uid}/memberships/${restaurantId}`).get(),
  ]);
  const role = member.data()?.role as Role | undefined;
  if (!member.exists || !membership.exists || membership.data()?.isActive !== true || membership.data()?.role !== role || member.data()?.isActive !== true || !role || !roles.includes(role) || !allowed.includes(role)) {
    throw new HttpsError("permission-denied", "This staff account is inactive or its role has changed.");
  }
  return { uid, email: typeof request.auth.token.email === "string" ? request.auth.token.email : "", restaurantId, role };
}

async function requirePlatformAdmin(request: CallableRequest<unknown>) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in with the provisioned platform admin account.");
  const record = await db.doc(`masterAdmins/${request.auth.uid}`).get();
  if (!record.exists || record.data()?.active !== true || record.data()?.role !== "MasterAdmin") throw new HttpsError("permission-denied", "This Master Admin account is inactive or not provisioned.");
  return { uid: request.auth.uid, email: String(request.auth.token.email ?? "") };
}

function restaurant(actor: Actor) { return db.doc(`restaurants/${actor.restaurantId}`); }
function auditRef(actor: Actor) { return restaurant(actor).collection("auditLogs").doc(); }
function auditRecord(actor: Actor, action: string, targetType: string, targetId: string, details: Record<string, unknown> = {}) {
  return { action, targetType, targetId, actorUid: actor.uid, actorEmail: actor.email, actorRole: actor.role, details, createdAt: FieldValue.serverTimestamp() };
}

function useAudit(transaction: Transaction, actor: Actor, action: string, targetType: string, targetId: string, details?: Record<string, unknown>) {
  transaction.create(auditRef(actor), auditRecord(actor, action, targetType, targetId, details));
}

async function rateLimit(request: CallableRequest<unknown>, action: string, maximum: number, windowMs = 60_000) {
  const ip = request.rawRequest.ip || request.rawRequest.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const key = sha256(`${action}:${ip}`);
  const ref = db.collection("publicRateLimits").doc(key);
  const now = Date.now();
  await db.runTransaction(async (tx) => {
    const current = await tx.get(ref);
    const data = current.data();
    const resetAt = typeof data?.resetAtMs === "number" ? data.resetAtMs : 0;
    const count = now >= resetAt ? 0 : Number(data?.count ?? 0);
    if (count >= maximum) throw new HttpsError("resource-exhausted", "Too many requests. Wait a moment and try again.");
    tx.set(ref, { count: count + 1, resetAtMs: now >= resetAt ? now + windowMs : resetAt, updatedAt: FieldValue.serverTimestamp() });
  });
}

function subscriptionStateKey(status: string): string {
  const keys: Record<string, string> = {
    active: "tenantActive", pending_payment: "tenantPendingPayment", past_due: "tenantPastDue",
    grace_period: "tenantGracePeriod", suspended: "tenantSuspended", cancelled: "tenantCancelled", expired: "tenantExpired",
  };
  return keys[status] ?? "tenantPendingPayment";
}

function mapProviderSubscriptionStatus(status: unknown): string | null {
  if (typeof status !== "string") return null;
  const states: Record<string, string> = {
    created: "pending_payment", authenticated: "pending_payment", pending: "pending_payment",
    active: "active", halted: "past_due", paused: "past_due", cancelled: "cancelled", completed: "expired", expired: "expired",
  };
  return states[status] ?? null;
}

async function razorpayRequest<T>(path: string, body?: Record<string, unknown>, method: "GET" | "POST" | "PATCH" = body ? "POST" : "GET"): Promise<T> {
  const keyId = RAZORPAY_KEY_ID.value();
  const keySecret = RAZORPAY_KEY_SECRET.value();
  if (!configuredRazorpayMode() || !keySecret) throw new HttpsError("failed-precondition", "Razorpay is not configured. Set a valid Razorpay mode's RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in Firebase Functions secrets.");
  const response = await fetch(`https://api.razorpay.com/v1/${path}`, {
    method,
    headers: { Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json() as T & { error?: { description?: string; reason?: string } };
  if (!response.ok) throw new HttpsError("unavailable", payload.error?.description ?? `Razorpay returned ${response.status}.`);
  return payload;
}

export const startSubscriptionCheckout = onCall({ ...CALL_OPTIONS, secrets: [RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET] }, async (request) => {
  const actor = await requireStaff(request, ["owner"]);
  const { planId, attemptKey } = zodInput(z.object({ planId: z.string().min(2).max(48), attemptKey: z.string().min(16).max(100) }), request.data);
  const mode = requireRazorpayMode();
  const subscriptionRef = db.doc(`subscriptions/${actor.restaurantId}`);
  const attemptRef = db.doc(`billingAttempts/${sha256(`${actor.restaurantId}:${attemptKey}`)}`);
  const currentSnapshot = await subscriptionRef.get();
  const current = currentSnapshot.data();
  let contract: Record<string, any> | null = null;
  let plan: Record<string, any> | undefined;
  if (planId === "custom") {
    contract = current?.pendingCustomContract as Record<string, any> | undefined ?? null;
    if (!contract || contract.status !== "offered" || !contract.providerPlanId) throw new HttpsError("failed-precondition", "There is no ready custom contract for this restaurant. Ask platform support to assign one.");
    if (contract.providerMode && contract.providerMode !== mode) throw new HttpsError("failed-precondition", `This custom contract was created in Razorpay ${String(contract.providerMode).toUpperCase()} Mode. Ask platform support to recreate it for ${mode.toUpperCase()} Mode.`);
    plan = { id: "custom", name: contract.planName, pricePaise: contract.amountPaise, orderLimit: contract.orderLimit ?? null, razorpayPlanId: contract.providerPlanId, billingPeriod: "monthly" };
  } else {
    const planSnapshot = await db.doc(`plans/${planId}`).get();
    plan = planSnapshot.data();
    if (!planSnapshot.exists || !plan || plan.isActive !== true || plan.isCustom === true || (plan.isTestOnly === true && mode !== "test")) throw new HttpsError("failed-precondition", plan?.isTestOnly === true ? "The ₹1 sandbox plan is available only with Razorpay Test Mode keys." : "This plan is not available for checkout.");
    plan = { ...plan, razorpayPlanId: planProviderId(plan, mode) };
    if (!plan.razorpayPlanId) throw new HttpsError("failed-precondition", `This plan has no Razorpay ${mode.toUpperCase()} Mode plan yet. Ask the platform admin to sync the catalog while using ${mode.toUpperCase()} Mode keys.`);
  }
  if (!plan?.razorpayPlanId) throw new HttpsError("failed-precondition", "The selected plan does not have a provider billing plan.");
  if (!RAZORPAY_KEY_ID.value() || !RAZORPAY_KEY_SECRET.value()) throw new HttpsError("failed-precondition", "Subscription checkout is not configured yet. Contact TableServe support; no payment has been taken.");
  assertSubscriptionMode(current, mode);
  if (current?.status === "active" && current.providerSubscriptionId) {
    if (current.planId === planId && current.providerPlanId === plan.razorpayPlanId && !current.pendingPlanChange) return { checkoutUrl: "", providerSubscriptionId: String(current.providerSubscriptionId), status: "active", planChangeScheduled: false, scheduleChangeAt: "now" };
    if (current.pendingPlanChange) throw new HttpsError("failed-precondition", "A plan change is already waiting for Razorpay confirmation. Refresh billing before making another change.");
  } else if (current?.providerSubscriptionId && current.status === "pending_payment") {
    throw new HttpsError("failed-precondition", "A payment checkout is already open for this restaurant. Complete it or contact support before changing plans.");
  }
  const previousAttempt = await attemptRef.get();
  if (previousAttempt.exists) {
    const saved = previousAttempt.data()!;
    if (saved.planId !== planId || saved.providerPlanId !== plan.razorpayPlanId || (saved.providerMode && saved.providerMode !== mode)) throw new HttpsError("already-exists", "This checkout attempt key was already used for a different plan or Razorpay mode.");
    if (saved.checkoutUrl) return { checkoutUrl: String(saved.checkoutUrl), providerSubscriptionId: String(saved.providerSubscriptionId), status: "pending_payment" };
    if (saved.state === "plan_change_requested") return { checkoutUrl: "", providerSubscriptionId: String(saved.providerSubscriptionId), status: "active", planChangeScheduled: true, scheduleChangeAt: String(saved.scheduleChangeAt ?? "cycle_end") };
    throw new HttpsError("aborted", "A checkout attempt with this key is still being processed. Refresh billing before retrying.");
  }
  await attemptRef.create({ shopId: actor.restaurantId, planId, providerPlanId: plan.razorpayPlanId, providerMode: mode, state: "creating", createdAt: FieldValue.serverTimestamp() });
  try {
    if (current?.status === "active" && current.providerSubscriptionId) {
      const scheduleChangeAt = Number(plan.pricePaise) > Number(current.amountPaise ?? 0) ? "now" : "cycle_end";
      const changed = await razorpayRequest<{ id: string; plan_id?: string }>(`subscriptions/${encodeURIComponent(String(current.providerSubscriptionId))}`, {
        plan_id: String(plan.razorpayPlanId), schedule_change_at: scheduleChangeAt, customer_notify: true,
      }, "PATCH");
      const appliedImmediately = scheduleChangeAt === "now" && changed.plan_id === String(plan.razorpayPlanId);
      const now = FieldValue.serverTimestamp();
      await db.runTransaction(async (tx) => {
        const [freshAttempt, freshSubscription] = await Promise.all([tx.get(attemptRef), tx.get(subscriptionRef)]);
        if (!freshAttempt.exists || freshAttempt.data()?.state !== "creating" || !freshSubscription.exists || freshSubscription.data()?.providerSubscriptionId !== current.providerSubscriptionId || freshSubscription.data()?.pendingPlanChange) throw new HttpsError("aborted", "The subscription changed while Razorpay was processing the plan update.");
        const oldAmount = Number(freshSubscription.data()?.amountPaise ?? 0);
        const newAmount = appliedImmediately ? Number(plan.pricePaise) : oldAmount;
        if (appliedImmediately) {
          tx.update(subscriptionRef, { planId, planName: plan.name, amountPaise: plan.pricePaise, orderLimit: plan.orderLimit ?? null, providerPlanId: plan.razorpayPlanId, providerMode: mode, ...(contract ? { customContractId: contract.contractId, renewalTerms: contract.renewalTerms, pendingCustomContract: FieldValue.delete() } : { customContractId: FieldValue.delete(), renewalTerms: FieldValue.delete() }), pendingPlanChange: FieldValue.delete(), updatedAt: now });
          tx.update(db.doc(`restaurants/${actor.restaurantId}`), { planId, updatedAt: now });
          tx.set(db.doc("platformMetrics/current"), { monthlyRecurringRevenuePaise: FieldValue.increment(newAmount - oldAmount), updatedAt: now }, { merge: true });
        } else {
          tx.update(subscriptionRef, { pendingPlanChange: { planId, planName: plan.name, amountPaise: plan.pricePaise, orderLimit: plan.orderLimit ?? null, providerPlanId: String(plan.razorpayPlanId), ...(contract ? { customContractId: contract.contractId, renewalTerms: contract.renewalTerms } : {}), scheduleChangeAt, requestedAt: now }, updatedAt: now });
        }
        tx.update(attemptRef, { state: "plan_change_requested", providerSubscriptionId: String(current.providerSubscriptionId), scheduleChangeAt, updatedAt: now });
        useAudit(tx, actor, "billing.plan_change_requested", "subscription", actor.restaurantId, { fromPlanId: current.planId, toPlanId: planId, scheduleChangeAt, providerPlanId: changed.plan_id ?? null });
      });
      return { checkoutUrl: "", providerSubscriptionId: String(current.providerSubscriptionId), status: "active", planChangeScheduled: true, planChangeApplied: appliedImmediately, scheduleChangeAt };
    }
    const subscription = await razorpayRequest<{ id: string; short_url?: string; status: string; current_start?: number; current_end?: number }>("subscriptions", {
      plan_id: plan.razorpayPlanId,
      total_count: 120,
      quantity: 1,
      customer_notify: true,
      notes: { shopId: actor.restaurantId, planId, ...(contract ? { contractId: contract.contractId } : {}) },
    });
    if (!subscription.short_url) throw new HttpsError("unavailable", "Razorpay created the subscription but did not return a checkout link. Contact support with the provider subscription ID.");
    const now = FieldValue.serverTimestamp();
    await db.runTransaction(async (tx) => {
      const [freshAttempt, current] = await Promise.all([tx.get(attemptRef), tx.get(subscriptionRef)]);
      if (!freshAttempt.exists || freshAttempt.data()?.state !== "creating") throw new HttpsError("aborted", "This checkout attempt changed while Razorpay was processing it.");
      tx.set(subscriptionRef, {
        shopId: actor.restaurantId, planId, planName: plan.name, amountPaise: plan.pricePaise, providerMode: mode,
        orderLimit: plan.orderLimit ?? null, providerPlanId: plan.razorpayPlanId, status: "pending_payment", provider: "razorpay",
        providerSubscriptionId: subscription.id, checkoutUrl: subscription.short_url,
        ...(contract ? { pendingCustomContract: { ...contract, status: "checkout_started" } } : {}),
        currentUsage: 0, currentPeriodStart: null, currentPeriodEnd: null, updatedAt: now,
        ...(current.exists ? {} : { currency: "INR", createdAt: now }),
      }, { merge: true });
      tx.update(attemptRef, { state: "created", providerSubscriptionId: subscription.id, checkoutUrl: subscription.short_url, updatedAt: now });
      tx.update(db.doc(`restaurants/${actor.restaurantId}`), { planId, subscriptionStatus: "pending_payment", updatedAt: now });
      useAudit(tx, actor, "billing.checkout_created", "subscription", actor.restaurantId, { planId, providerSubscriptionId: subscription.id });
    });
    return { checkoutUrl: subscription.short_url, providerSubscriptionId: subscription.id, status: "pending_payment" };
  } catch (error) {
    await attemptRef.set({ state: "error", error: error instanceof Error ? error.message.slice(0, 240) : "Unknown provider error", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    throw error;
  }
});

export const getSubscription = onCall(CALL_OPTIONS, async (request) => {
  const actor = await requireStaff(request, ["owner"]);
  const [subscription, usage] = await Promise.all([
    db.doc(`subscriptions/${actor.restaurantId}`).get(),
    db.collection(`restaurants/${actor.restaurantId}/usageCycles`).orderBy("periodStart", "desc").limit(1).get(),
  ]);
  if (!subscription.exists) throw new HttpsError("not-found", "No billing record exists for this restaurant yet.");
  const data = subscription.data()!;
  return {
    shopId: actor.restaurantId, planId: data.planId, planName: data.planName, amountPaise: data.amountPaise, providerMode: data.providerMode ?? null,
    orderLimit: data.orderLimit ?? null, status: data.status, currentUsage: Number(data.currentUsage ?? usage.docs[0]?.data().acceptedOrders ?? 0),
    currentPeriodStartMs: data.currentPeriodStart?.toMillis?.() ?? null, currentPeriodEndMs: data.currentPeriodEnd?.toMillis?.() ?? null,
    graceEndsAtMs: data.graceEndsAt?.toMillis?.() ?? null,
    checkoutUrl: data.checkoutUrl ?? null,
    providerSubscriptionId: data.providerSubscriptionId ?? null,
    providerStatus: data.providerStatus ?? null,
    cancelAtCycleEnd: data.cancelAtCycleEnd === true,
    cancelEffectiveAtMs: data.cancelEffectiveAt?.toMillis?.() ?? null,
    billingPeriod: data.billingPeriod ?? "monthly",
    pendingCustomContract: data.pendingCustomContract ? { planName: data.pendingCustomContract.planName, amountPaise: data.pendingCustomContract.amountPaise, orderLimit: data.pendingCustomContract.orderLimit ?? null, renewalTerms: data.pendingCustomContract.renewalTerms, status: data.pendingCustomContract.status } : null,
    pendingPlanChange: data.pendingPlanChange ? { planId: data.pendingPlanChange.planId, planName: data.pendingPlanChange.planName, amountPaise: data.pendingPlanChange.amountPaise, orderLimit: data.pendingPlanChange.orderLimit ?? null, scheduleChangeAt: data.pendingPlanChange.scheduleChangeAt } : null,
    payments: (await db.collection(`subscriptions/${actor.restaurantId}/payments`).orderBy("createdAt", "desc").limit(12).get()).docs.map((entry) => ({ id: entry.id, amountPaise: entry.data().amountPaise, currency: entry.data().currency ?? "INR", status: entry.data().status, event: entry.data().event, createdAtMs: entry.data().createdAt?.toMillis?.() ?? null })),
  };
});

export const refreshSubscriptionFromProvider = onCall({ ...CALL_OPTIONS, secrets: [RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET] }, async (request) => {
  const actor = await requireStaff(request, ["owner"]);
  const mode = requireRazorpayMode();
  const subscriptionRef = db.doc(`subscriptions/${actor.restaurantId}`);
  const initial = await subscriptionRef.get();
  const initialData = initial.data();
  assertSubscriptionMode(initialData, mode);
  const providerId = String(initialData?.providerSubscriptionId ?? "");
  if (!providerId) throw new HttpsError("failed-precondition", "Razorpay has not created a subscription for this restaurant yet.");
  const provider = await razorpayRequest<{ id: string; status?: string; plan_id?: string; current_start?: number; current_end?: number }>(`subscriptions/${encodeURIComponent(providerId)}`);
  if (provider.id !== providerId) throw new HttpsError("unavailable", "Razorpay returned a different subscription record; billing data was not changed.");
  let status = mapProviderSubscriptionStatus(provider.status);
  if (!status) throw new HttpsError("unavailable", `Razorpay returned an unsupported subscription state (${String(provider.status)}); billing data was not changed.`);
  if (["pending_payment", "past_due"].includes(status) && ["active", "grace_period"].includes(String(initial.data()?.status))) status = "grace_period";
  const tenantRef = db.doc(`restaurants/${actor.restaurantId}`);
  await db.runTransaction(async (tx) => {
    const [subscription, tenant] = await Promise.all([tx.get(subscriptionRef), tx.get(tenantRef)]);
    if (!subscription.exists || !tenant.exists) throw new HttpsError("not-found", "Restaurant billing record no longer exists.");
    const previous = subscription.data()!;
    const updates: Record<string, unknown> = { providerStatus: provider.status ?? null, lastProviderSyncAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() };
    let tenantPlanId: string | undefined;
    let resultingAmount = Number(previous.amountPaise ?? 0);
    let appliedPlan = false;
    const providerStartMs = Number(provider.current_start ?? 0) * 1000;
    const providerEndMs = Number(provider.current_end ?? 0) * 1000;
    const periodChanged = providerStartMs > 0 && previous.currentPeriodStart?.toMillis?.() !== providerStartMs;
    const pendingChange = previous.pendingPlanChange as Record<string, any> | undefined;
    const pendingChangeCanApply = pendingChange?.providerPlanId === provider.plan_id && (pendingChange?.scheduleChangeAt !== "cycle_end" || periodChanged);
    const pendingContract = previous.pendingCustomContract as Record<string, any> | undefined;
    const contractCanApply = status === "active" && pendingContract?.providerPlanId === provider.plan_id;
    const nextPlan = pendingChangeCanApply ? pendingChange : contractCanApply ? pendingContract : null;
    if (nextPlan) {
      resultingAmount = Number(nextPlan.amountPaise ?? previous.amountPaise ?? 0);
      updates.planId = nextPlan.planId ?? "custom";
      updates.planName = nextPlan.planName;
      updates.amountPaise = resultingAmount;
      updates.orderLimit = nextPlan.orderLimit ?? null;
      updates.providerPlanId = nextPlan.providerPlanId;
      if (nextPlan.contractId) {
        updates.customContractId = nextPlan.contractId;
        updates.renewalTerms = nextPlan.renewalTerms;
      } else {
        updates.customContractId = FieldValue.delete();
        updates.renewalTerms = FieldValue.delete();
      }
      if (pendingChangeCanApply) updates.pendingPlanChange = FieldValue.delete();
      if (contractCanApply) updates.pendingCustomContract = FieldValue.delete();
      tenantPlanId = String(updates.planId);
      appliedPlan = true;
    }
    updates.status = status;
    if (status === "grace_period") updates.graceEndsAt = previous.graceEndsAt ?? Timestamp.fromMillis(Date.now() + 72 * 60 * 60 * 1000);
    if (status === "active") updates.graceEndsAt = FieldValue.delete();
    if (status === "cancelled") updates.cancelAtCycleEnd = false;
    if (providerStartMs > 0) updates.currentPeriodStart = Timestamp.fromMillis(providerStartMs);
    if (providerEndMs > 0) updates.currentPeriodEnd = Timestamp.fromMillis(providerEndMs);
    if (periodChanged) updates.currentUsage = 0;
    tx.set(subscriptionRef, updates, { merge: true });
    tx.update(tenantRef, { ...(tenantPlanId ? { planId: tenantPlanId } : {}), subscriptionStatus: status, updatedAt: FieldValue.serverTimestamp() });
    const statusChanged = previous.status !== status;
    if (statusChanged || appliedPlan) {
      tx.set(db.doc("platformMetrics/current"), {
        ...(statusChanged ? { [subscriptionStateKey(String(previous.status))]: FieldValue.increment(-1), [subscriptionStateKey(status)]: FieldValue.increment(1) } : {}),
        monthlyRecurringRevenuePaise: FieldValue.increment((status === "active" ? resultingAmount : 0) - (previous.status === "active" ? Number(previous.amountPaise ?? 0) : 0)),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    tx.create(db.collection("platformBillingEvents").doc(), { event: "subscription.provider_sync", shopId: actor.restaurantId, providerSubscriptionId: providerId, providerStatus: provider.status ?? null, status, actorUid: actor.uid, state: "processed", receivedAt: FieldValue.serverTimestamp() });
  });
  return { ok: true, status, providerStatus: provider.status ?? null };
});

export const cancelSubscriptionAtCycleEnd = onCall({ ...CALL_OPTIONS, secrets: [RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET] }, async (request) => {
  const actor = await requireStaff(request, ["owner"]);
  const mode = requireRazorpayMode();
  const subscriptionRef = db.doc(`subscriptions/${actor.restaurantId}`);
  const initial = await subscriptionRef.get();
  const current = initial.data();
  assertSubscriptionMode(current, mode);
  const providerId = String(current?.providerSubscriptionId ?? "");
  if (!initial.exists || !providerId) throw new HttpsError("failed-precondition", "There is no Razorpay subscription to cancel.");
  if (current?.status !== "active") throw new HttpsError("failed-precondition", "Only an active subscription can be cancelled at the end of its current billing cycle.");
  if (current?.cancelAtCycleEnd === true) throw new HttpsError("already-exists", "Cancellation is already scheduled for this subscription.");
  if (current?.pendingPlanChange) throw new HttpsError("failed-precondition", "A plan change is waiting for provider confirmation. Refresh the subscription before requesting cancellation.");
  const provider = await razorpayRequest<{ id: string; status?: string; current_end?: number }>(`subscriptions/${encodeURIComponent(providerId)}/cancel`, { cancel_at_cycle_end: true });
  if (provider.id !== providerId) throw new HttpsError("unavailable", "Razorpay returned a different subscription record; cancellation was not recorded.");
  const tenantRef = db.doc(`restaurants/${actor.restaurantId}`);
  const effectiveAtMs = Number(provider.current_end ?? 0) * 1000 || current.currentPeriodEnd?.toMillis?.() || null;
  await db.runTransaction(async (tx) => {
    const [subscription, tenant] = await Promise.all([tx.get(subscriptionRef), tx.get(tenantRef)]);
    if (!subscription.exists || !tenant.exists || subscription.data()?.providerSubscriptionId !== providerId) throw new HttpsError("aborted", "The subscription changed while Razorpay was processing the cancellation.");
    const updates: Record<string, unknown> = { providerStatus: provider.status ?? null, cancelAtCycleEnd: provider.status === "cancelled" ? false : true, cancellationRequestedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() };
    if (effectiveAtMs) updates.cancelEffectiveAt = Timestamp.fromMillis(effectiveAtMs);
    const wasActive = subscription.data()?.status === "active";
    if (provider.status === "cancelled") {
      updates.status = "cancelled";
      tx.update(tenantRef, { subscriptionStatus: "cancelled", updatedAt: FieldValue.serverTimestamp() });
      if (wasActive) tx.set(db.doc("platformMetrics/current"), { tenantActive: FieldValue.increment(-1), tenantCancelled: FieldValue.increment(1), monthlyRecurringRevenuePaise: FieldValue.increment(-Number(subscription.data()?.amountPaise ?? 0)), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    }
    tx.set(subscriptionRef, updates, { merge: true });
    useAudit(tx, actor, "billing.cancellation_scheduled", "subscription", actor.restaurantId, { providerSubscriptionId: providerId, cancelEffectiveAtMs: effectiveAtMs, providerStatus: provider.status ?? null });
  });
  return { ok: true, effectiveAtMs, providerStatus: provider.status ?? null };
});

export const updatePlanCatalog = onCall(CALL_OPTIONS, async (request) => {
  const actor = await requirePlatformAdmin(request);
  const input = zodInput(z.object({
    planId: z.string().min(2).max(48), name: z.string().trim().min(2).max(60),
    pricePaise: z.number().int().min(0).max(100_000_000), orderLimit: z.number().int().min(1).max(10_000_000).nullable(),
    description: z.string().trim().max(240), features: z.array(z.string().trim().min(1).max(120)).max(20), isActive: z.boolean(), isCustom: z.boolean(),
  }), request.data);
  if (!input.isCustom && input.pricePaise < 100) invalid("Self-service plan prices must be at least ₹1.00.");
  if (input.isCustom && input.pricePaise !== 0) invalid("Set contract prices on a restaurant's custom subscription, not the public catalog.");
  if (input.planId === "test-100") throw new HttpsError("failed-precondition", "The sandbox test plan is fixed at ₹1/month and 100 accepted orders; it cannot be changed in the catalog editor.");
  await db.runTransaction(async (tx) => {
    const ref = db.doc(`plans/${input.planId}`);
    tx.set(ref, { ...input, currency: "INR", interval: "monthly", updatedAt: FieldValue.serverTimestamp(), updatedBy: actor.uid }, { merge: true });
    tx.create(db.collection("platformAuditLogs").doc(), { action: "plan.updated", actorUid: actor.uid, actorEmail: actor.email, targetId: input.planId, details: input, createdAt: FieldValue.serverTimestamp() });
  });
  return { ok: true };
});

export const masterListPlans = onCall({ ...CALL_OPTIONS, secrets: [RAZORPAY_KEY_ID] }, async (request) => {
  await requirePlatformAdmin(request);
  const snapshot = await db.collection("plans").orderBy("sortOrder").get();
  const mode = configuredRazorpayMode();
  return { razorpayMode: mode ?? "unconfigured", plans: snapshot.docs.map((doc) => {
    const data = doc.data();
    return { id: doc.id, ...data, razorpayPlanId: mode ? planProviderId(data, mode) || null : null };
  }) };
});

export const syncRazorpayPlans = onCall({ ...CALL_OPTIONS, secrets: [RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET] }, async (request) => {
  const actor = await requirePlatformAdmin(request);
  const mode = requireRazorpayMode();
  if (mode === "test") {
    const testPlan = {
      name: "Sandbox Test", pricePaise: 100, orderLimit: 100, isTestOnly: true,
      isCustom: false, sortOrder: 4,
      description: "Razorpay Test Mode only. ₹1 per month for up to 100 accepted customer orders per cycle.",
      features: ["Razorpay test-mode subscription checkout", "Up to 100 accepted customer orders per cycle", "No real payment in Razorpay Test Mode"],
      currency: "INR", interval: "monthly", isActive: true,
      usagePolicy: "Unique production orders increment once when accepted; eligible cancellation before preparation reverses once.",
      updatedAt: FieldValue.serverTimestamp(),
    };
    await db.doc("plans/test-100").set(testPlan, { merge: true });
    await db.doc("plans/custom").update({ sortOrder: 5 }).catch(() => undefined);
  }
  const plans = await db.collection("plans").where("isActive", "==", true).where("isCustom", "==", false).get();
  const synced: { id: string; providerPlanId: string }[] = [];
  for (const planDoc of plans.docs) {
    const plan = planDoc.data();
    if (plan.isTestOnly === true && mode !== "test") continue;
    const currentProviderPlanId = planProviderId(plan, mode);
    if (currentProviderPlanId) { synced.push({ id: planDoc.id, providerPlanId: currentProviderPlanId }); continue; }
    const providerPlan = await razorpayRequest<{ id: string }>("plans", {
      period: "monthly", interval: 1,
      item: { name: `TableServe ${plan.name}`, amount: plan.pricePaise, currency: "INR", description: String(plan.description ?? "TableServe monthly plan").slice(0, 240) },
      notes: { tableserve_plan_id: planDoc.id, tableserve_mode: mode, schema_version: "2" },
    });
    await planDoc.ref.update({ [providerPlanIdField(mode)]: providerPlan.id, updatedAt: FieldValue.serverTimestamp() });
    synced.push({ id: planDoc.id, providerPlanId: providerPlan.id });
  }
  await db.collection("platformAuditLogs").add({ action: "billing.plan_catalog_synced", actorUid: actor.uid, actorEmail: actor.email, details: { mode, count: synced.length }, createdAt: FieldValue.serverTimestamp() });
  return { mode, synced };
});

export const platformOverview = onCall(CALL_OPTIONS, async (request) => {
  await requirePlatformAdmin(request);
  const [metrics, tenants] = await Promise.all([
    db.doc("platformMetrics/current").get(),
    db.collection("restaurants").orderBy("createdAt", "desc").limit(8).get(),
  ]);
  const recent = await Promise.all(tenants.docs.map(async (tenant) => {
    const [subscription, staffCount] = await Promise.all([
      db.doc(`subscriptions/${tenant.id}`).get(),
      tenant.ref.collection("staff").where("isActive", "==", true).count().get(),
    ]);
    const data = tenant.data();
    const billing = subscription.data();
    return { shopId: tenant.id, name: data.name, city: data.city ?? "", state: data.state ?? "", platformStatus: data.platformStatus ?? "active", subscriptionStatus: billing?.status ?? "pending_payment", planName: billing?.planName ?? "—", currentUsage: Number(billing?.currentUsage ?? 0), orderLimit: billing?.orderLimit ?? null, lifetimeAcceptedOrders: Number(data.lifetimeAcceptedOrders ?? 0), activeStaff: staffCount.data().count, createdAtMs: data.createdAt?.toMillis?.() ?? null };
  }));
  return { metrics: metrics.data() ?? {}, recent };
});

export const masterListRestaurants = onCall(CALL_OPTIONS, async (request) => {
  await requirePlatformAdmin(request);
  const { cursorId, pageSize, search } = zodInput(z.object({ cursorId: z.string().max(128).optional(), pageSize: z.number().int().min(1).max(50).default(25), search: z.string().trim().max(100).default("") }), request.data);
  const normalizedSearch = search.toLocaleLowerCase("en-US");
  let query = normalizedSearch
    ? db.collection("restaurants").where("nameKey", ">=", normalizedSearch).where("nameKey", "<=", `${normalizedSearch}\uf8ff`).orderBy("nameKey").limit(pageSize + 1)
    : db.collection("restaurants").orderBy("createdAt", "desc").limit(pageSize + 1);
  if (cursorId) {
    const cursor = await db.doc(`restaurants/${cursorId}`).get();
    if (cursor.exists) query = query.startAfter(cursor);
  }
  const snapshot = await query.get();
  const page = snapshot.docs.slice(0, pageSize);
  const tenants = await Promise.all(page.map(async (tenant) => {
    const [subscription, staffCount] = await Promise.all([
      db.doc(`subscriptions/${tenant.id}`).get(), tenant.ref.collection("staff").where("isActive", "==", true).count().get(),
    ]);
    const data = tenant.data();
    const billing = subscription.data();
    return { shopId: tenant.id, name: data.name, ownerEmail: data.ownerEmail ?? "", city: data.city ?? "", state: data.state ?? "", platformStatus: data.platformStatus ?? "active", subscriptionStatus: billing?.status ?? "pending_payment", planId: billing?.planId ?? "", planName: billing?.planName ?? "—", amountPaise: Number(billing?.amountPaise ?? 0), currentUsage: Number(billing?.currentUsage ?? 0), orderLimit: billing?.orderLimit ?? null, pendingCustomContract: billing?.pendingCustomContract ? { planName: billing.pendingCustomContract.planName, amountPaise: billing.pendingCustomContract.amountPaise, orderLimit: billing.pendingCustomContract.orderLimit ?? null, renewalTerms: billing.pendingCustomContract.renewalTerms, status: billing.pendingCustomContract.status ?? "offered" } : null, lifetimeAcceptedOrders: Number(data.lifetimeAcceptedOrders ?? 0), activeStaff: staffCount.data().count, createdAtMs: data.createdAt?.toMillis?.() ?? null };
  }));
  return { tenants, nextCursor: snapshot.size > pageSize ? page[page.length - 1]?.id ?? null : null };
});

export const masterListRestaurantWorkforce = onCall(CALL_OPTIONS, async (request) => {
  await requirePlatformAdmin(request);
  const { shopId } = zodInput(z.object({ shopId: z.string().min(1).max(128) }), request.data);
  const tenantRef = db.doc(`restaurants/${shopId}`);
  const tenant = await tenantRef.get();
  if (!tenant.exists) throw new HttpsError("not-found", "Restaurant not found.");
  const [staffSnapshot, orderSnapshot] = await Promise.all([
    tenantRef.collection("staff").orderBy("email").get(),
    tenantRef.collection("orders").where("status", "in", ["queued", "accepted", "preparing", "ready"]).limit(300).get(),
  ]);
  const assignments = new Map<string, Record<string, unknown>[]>();
  const openOrders = orderSnapshot.docs.map((doc) => {
    const data = doc.data();
    const uid = String(data.assignedStaffUid ?? "");
    const order = { orderId: doc.id, ticketId: String(data.ticketId ?? ""), tableNumber: String(data.tableNumberSnapshot ?? ""), status: String(data.status ?? "queued"), createdAtMs: data.createdAt?.toMillis?.() ?? null, assignedStaffUid: uid || null };
    if (uid) { const bucket = assignments.get(uid) ?? []; bucket.push(order); assignments.set(uid, bucket); }
    return order;
  });
  return {
    shop: { shopId, name: String(tenant.data()?.name ?? "Restaurant") },
    staff: staffSnapshot.docs.map((doc) => ({ uid: doc.id, email: doc.data().email ?? "", displayName: doc.data().displayName ?? "", role: doc.data().role, isActive: doc.data().isActive === true, openAssignments: assignments.get(doc.id) ?? [] })),
    openOrders,
  };
});

export const masterAssignRestaurantStaff = onCall(CALL_OPTIONS, async (request) => {
  const actor = await requirePlatformAdmin(request);
  const { shopId, email, role } = zodInput(z.object({ shopId: z.string().min(1).max(128), email: z.string().trim().email().max(254), role: z.enum(["manager", "kitchen", "waiter"]) }), request.data);
  const tenantRef = db.doc(`restaurants/${shopId}`);
  const tenant = await tenantRef.get();
  if (!tenant.exists) throw new HttpsError("not-found", "Restaurant not found.");
  let member;
  try { member = await auth.getUserByEmail(email.toLowerCase()); }
  catch { throw new HttpsError("not-found", "Create this person's Firebase Email/Password account before assigning a role."); }
  if (!member.emailVerified) throw new HttpsError("failed-precondition", "The staff member must verify their email before assignment.");
  if (member.disabled) throw new HttpsError("failed-precondition", "This Firebase Authentication account is disabled.");
  const staffRef = tenantRef.collection("staff").doc(member.uid);
  const membershipRef = db.doc(`users/${member.uid}/memberships/${shopId}`);
  await db.runTransaction(async (tx) => {
    const [staff, membership] = await Promise.all([tx.get(staffRef), tx.get(membershipRef)]);
    if (staff.exists && staff.data()?.role === "owner") throw new HttpsError("failed-precondition", "The restaurant owner role cannot be changed from the platform console.");
    const now = FieldValue.serverTimestamp();
    tx.set(staffRef, { uid: member.uid, email: email.toLowerCase(), displayName: member.displayName ?? "", role, isActive: true, updatedAt: now, ...(staff.exists ? {} : { createdAt: now }) }, { merge: true });
    tx.set(membershipRef, { shopId, shopName: String(tenant.data()?.name ?? "Restaurant"), role, isActive: true, updatedAt: now, ...(membership.exists ? {} : { createdAt: now }) }, { merge: true });
    tx.create(db.collection("platformAuditLogs").doc(), { action: "restaurant.staff_assigned", actorUid: actor.uid, actorEmail: actor.email, targetId: shopId, details: { email: email.toLowerCase(), uid: member.uid, role }, createdAt: now });
  });
  return { ok: true, uid: member.uid };
});

export const masterAssignWaiterToOrder = onCall(CALL_OPTIONS, async (request) => {
  const actor = await requirePlatformAdmin(request);
  const { shopId, orderId, staffUid } = zodInput(z.object({ shopId: z.string().min(1).max(128), orderId: z.string().min(1).max(80), staffUid: z.string().min(1).max(128).nullable() }), request.data);
  const orderRef = db.doc(`restaurants/${shopId}/orders/${orderId}`);
  const assignmentRef = db.doc(`restaurants/${shopId}/assignedOrders/${orderId}`);
  const targetStaffRef = staffUid ? db.doc(`restaurants/${shopId}/staff/${staffUid}`) : null;
  const membershipRef = staffUid ? db.doc(`users/${staffUid}/memberships/${shopId}`) : null;
  await db.runTransaction(async (tx) => {
    const [order, previousAssignment] = await Promise.all([tx.get(orderRef), tx.get(assignmentRef)]);
    const [targetStaff, membership] = targetStaffRef && membershipRef ? await Promise.all([tx.get(targetStaffRef), tx.get(membershipRef)]) : [null, null];
    if (!order.exists) throw new HttpsError("not-found", "Open restaurant order not found.");
    const data = order.data()!;
    if (["served", "cancelled"].includes(String(data.status))) throw new HttpsError("failed-precondition", "Only open tickets can be assigned.");
    if (staffUid && (!targetStaff?.exists || targetStaff.data()?.role !== "waiter" || targetStaff.data()?.isActive !== true || !membership?.exists || membership.data()?.isActive !== true || membership.data()?.role !== "waiter")) throw new HttpsError("failed-precondition", "Choose a verified, active waiter assigned to this restaurant.");
    tx.update(orderRef, { assignedStaffUid: staffUid, assignedAt: staffUid ? FieldValue.serverTimestamp() : null, assignedBy: actor.uid, updatedAt: FieldValue.serverTimestamp() });
    if (!staffUid) { if (previousAssignment.exists) tx.delete(assignmentRef); }
    else {
      const items = (Array.isArray(data.items) ? data.items : []).map((item: Record<string, unknown>) => ({ name: String(item.name ?? ""), quantity: Number(item.quantity ?? 0), ...(Array.isArray(item.selections) ? { selections: item.selections.filter((value): value is string => typeof value === "string") } : {}), ...(typeof item.specialInstructions === "string" && item.specialInstructions ? { specialInstructions: item.specialInstructions } : {}) }));
      tx.set(assignmentRef, { ticketId: String(data.ticketId ?? ""), tableNumberSnapshot: String(data.tableNumberSnapshot ?? ""), items, status: String(data.status), estimatedMinutes: typeof data.estimatedMinutes === "number" ? data.estimatedMinutes : null, expectedReadyAt: data.expectedReadyAt ?? null, assignedStaffUid: staffUid, createdAt: data.createdAt ?? FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    }
    tx.create(db.collection("platformAuditLogs").doc(), { action: staffUid ? "order.waiter_assigned_by_platform" : "order.waiter_unassigned_by_platform", actorUid: actor.uid, actorEmail: actor.email, targetId: shopId, details: { orderId, ticketId: data.ticketId ?? null, staffUid }, createdAt: FieldValue.serverTimestamp() });
  });
  return { ok: true };
});

export const masterSetRestaurantStatus = onCall(CALL_OPTIONS, async (request) => {
  const actor = await requirePlatformAdmin(request);
  const { shopId, status, note } = zodInput(z.object({ shopId: z.string().min(1).max(128), status: z.enum(["active", "suspended"]), note: z.string().trim().max(500).default("") }), request.data);
  await db.runTransaction(async (tx) => {
    const tenantRef = db.doc(`restaurants/${shopId}`);
    const metricsRef = db.doc("platformMetrics/current");
    const tenant = await tx.get(tenantRef);
    if (!tenant.exists) throw new HttpsError("not-found", "Restaurant not found.");
    const oldStatus = tenant.data()?.platformStatus ?? "active";
    tx.update(tenantRef, { platformStatus: status, updatedAt: FieldValue.serverTimestamp() });
    if (oldStatus !== status) tx.set(metricsRef, { platformSuspended: FieldValue.increment((status === "suspended" ? 1 : 0) - (oldStatus === "suspended" ? 1 : 0)), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    tx.create(db.collection("platformAuditLogs").doc(), { action: status === "suspended" ? "restaurant.suspended" : "restaurant.reactivated", actorUid: actor.uid, actorEmail: actor.email, targetId: shopId, details: { oldStatus, status, note }, createdAt: FieldValue.serverTimestamp() });
  });
  return { ok: true };
});

export const masterAssignCustomPlan = onCall({ ...CALL_OPTIONS, secrets: [RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET] }, async (request) => {
  const actor = await requirePlatformAdmin(request);
  const mode = requireRazorpayMode();
  const input = zodInput(z.object({ shopId: z.string().min(1).max(128), planName: z.string().trim().min(2).max(60), amountPaise: z.number().int().min(100).max(100_000_000), orderLimit: z.number().int().min(1).max(10_000_000).nullable(), requestKey: z.string().min(16).max(100) }), request.data);
  const tenantRef = db.doc(`restaurants/${input.shopId}`);
  const subRef = db.doc(`subscriptions/${input.shopId}`);
  const attemptRef = db.doc(`customPlanAttempts/${sha256(`${input.shopId}:${mode}:${input.requestKey}`)}`);
  const [tenant, sub] = await Promise.all([tenantRef.get(), subRef.get()]);
  if (!tenant.exists || !sub.exists) throw new HttpsError("not-found", "Restaurant subscription not found.");
  const requestHash = sha256(JSON.stringify({ planName: input.planName, amountPaise: input.amountPaise, orderLimit: input.orderLimit }));
  let contractId = "";
  let providerPlanId = "";
  const claimed = await db.runTransaction(async (tx) => {
    const existing = await tx.get(attemptRef);
    if (existing.exists) {
      const saved = existing.data()!;
      if (saved.requestHash !== requestHash) throw new HttpsError("already-exists", "This contract request key has already been used for different terms.");
      if (saved.providerMode && saved.providerMode !== mode) throw new HttpsError("failed-precondition", "This contract attempt belongs to a different Razorpay mode.");
      if (saved.state === "creating") throw new HttpsError("aborted", "This custom contract request is already being processed.");
      contractId = String(saved.contractId);
      providerPlanId = String(saved.providerPlanId ?? "");
      if (saved.state === "offered") return true;
      tx.update(attemptRef, { state: "creating", error: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
      return false;
    }
    contractId = randomUUID();
    tx.create(attemptRef, { shopId: input.shopId, contractId, requestHash, planName: input.planName, amountPaise: input.amountPaise, orderLimit: input.orderLimit, providerMode: mode, state: "creating", createdAt: FieldValue.serverTimestamp() });
    return false;
  });
  if (claimed) return { ok: true, contractId, status: "offered" };
  try {
    if (!providerPlanId) {
      const providerPlan = await razorpayRequest<{ id: string }>("plans", {
        period: "monthly", interval: 1,
        item: { name: `TableServe ${input.planName}`, amount: input.amountPaise, currency: "INR", description: "Monthly TableServe custom contract" },
        notes: { shopId: input.shopId, contractId, schema_version: "2" },
      });
      providerPlanId = providerPlan.id;
      await attemptRef.update({ providerPlanId, state: "plan_created", updatedAt: FieldValue.serverTimestamp() });
    }
    await db.runTransaction(async (tx) => {
      const [freshAttempt, freshTenant, freshSub] = await Promise.all([tx.get(attemptRef), tx.get(tenantRef), tx.get(subRef)]);
      if (!freshAttempt.exists || !freshTenant.exists || !freshSub.exists) throw new HttpsError("aborted", "Restaurant records changed while the contract was being prepared.");
      if (freshAttempt.data()?.state === "offered") return;
      const contract = { contractId, planId: "custom", planName: input.planName, amountPaise: input.amountPaise, orderLimit: input.orderLimit, billingPeriod: "monthly", renewalTerms: "Renews monthly until cancelled.", providerPlanId, providerMode: mode, status: "offered", assignedAt: FieldValue.serverTimestamp(), assignedBy: actor.uid };
      tx.update(subRef, { pendingCustomContract: contract, updatedAt: FieldValue.serverTimestamp() });
      tx.update(attemptRef, { state: "offered", updatedAt: FieldValue.serverTimestamp() });
      tx.create(db.collection("platformAuditLogs").doc(), { action: "subscription.custom_plan_assigned", actorUid: actor.uid, actorEmail: actor.email, targetId: input.shopId, details: { shopId: input.shopId, planName: input.planName, amountPaise: input.amountPaise, orderLimit: input.orderLimit, billingPeriod: "monthly", contractId, providerPlanId }, createdAt: FieldValue.serverTimestamp() });
    });
    return { ok: true, contractId, providerPlanId, status: "offered" };
  } catch (error) {
    await attemptRef.set({ state: "error", error: error instanceof Error ? error.message.slice(0, 240) : "Provider request failed", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    throw error;
  }
});

export const masterAddSupportNote = onCall(CALL_OPTIONS, async (request) => {
  const actor = await requirePlatformAdmin(request);
  const { shopId, note } = zodInput(z.object({ shopId: z.string().min(1).max(128), note: z.string().trim().min(5).max(1000) }), request.data);
  const tenant = await db.doc(`restaurants/${shopId}`).get();
  if (!tenant.exists) throw new HttpsError("not-found", "Restaurant not found.");
  await db.runTransaction(async (tx) => {
    tx.create(db.collection("supportNotes").doc(), { shopId, note, actorUid: actor.uid, actorEmail: actor.email, createdAt: FieldValue.serverTimestamp() });
    tx.create(db.collection("platformAuditLogs").doc(), { action: "support.note_added", actorUid: actor.uid, actorEmail: actor.email, targetId: shopId, details: { noteLength: note.length }, createdAt: FieldValue.serverTimestamp() });
  });
  return { ok: true };
});

export const masterListAuditLogs = onCall(CALL_OPTIONS, async (request) => {
  await requirePlatformAdmin(request);
  const snapshot = await db.collection("platformAuditLogs").orderBy("createdAt", "desc").limit(100).get();
  return { logs: snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data(), createdAtMs: entry.data().createdAt?.toMillis?.() ?? null })) };
});

export const razorpayWebhook = onRequest({ region: REGION, maxInstances: 10, secrets: [RAZORPAY_KEY_ID, RAZORPAY_WEBHOOK_SECRET] }, async (request, response) => {
  if (request.method !== "POST" || !Buffer.isBuffer(request.rawBody)) { response.status(400).send("Invalid webhook request"); return; }
  const mode = configuredRazorpayMode();
  if (!mode) { response.status(503).send("Razorpay mode is not configured"); return; }
  const secret = RAZORPAY_WEBHOOK_SECRET.value();
  const signature = request.get("x-razorpay-signature") ?? "";
  const eventId = request.get("x-razorpay-event-id") ?? "";
  if (!secret || !/^[0-9a-f]{64}$/i.test(signature) || !eventId || eventId.length > 128) { response.status(401).send("Webhook is not configured or signed"); return; }
  const expected = createHmac("sha256", secret).update(request.rawBody).digest();
  const received = Buffer.from(signature, "hex");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) { response.status(401).send("Invalid signature"); return; }
  let body: Record<string, any>;
  try { body = JSON.parse(request.rawBody.toString("utf8")) as Record<string, any>; }
  catch { response.status(400).send("Invalid JSON"); return; }
  const event = typeof body.event === "string" ? body.event : "unknown";
  const entity = body.payload?.subscription?.entity;
  const providerId = typeof entity?.id === "string" ? entity.id : "";
  if (!providerId) { response.status(200).send("Ignored: no subscription entity"); return; }
  const matches = await db.collection("subscriptions").where("providerSubscriptionId", "==", providerId).limit(1).get();
  if (matches.empty) {
    const notes = entity.notes && typeof entity.notes === "object" ? entity.notes as Record<string, unknown> : {};
    await db.collection("platformBillingEvents").doc(sha256(eventId)).set({ eventId, event, providerSubscriptionId: providerId, notes, state: "unmatched", receivedAt: FieldValue.serverTimestamp() }, { merge: true });
    // A checkout webhook can arrive before the checkout callable stores its provider ID.
    // Ask Razorpay to retry those events; the unmatched event record remains replayable.
    response.status(typeof notes.shopId === "string" ? 503 : 200).send(typeof notes.shopId === "string" ? "Subscription checkout is still being recorded; retry this webhook" : "Stored unmatched provider event");
    return;
  }
  const subscriptionRef = matches.docs[0].ref;
  const shopId = subscriptionRef.id;
  const tenantRef = db.doc(`restaurants/${shopId}`);
  const eventRef = db.collection("platformBillingEvents").doc(sha256(eventId));
  const newStatus: Record<string, string> = {
    "subscription.activated": "active", "subscription.charged": "active",
    "subscription.authenticated": "pending_payment", "subscription.pending": "pending_payment", "subscription.halted": "past_due", "subscription.cancelled": "cancelled",
    "subscription.completed": "expired", "subscription.expired": "expired", "subscription.paused": "past_due", "subscription.resumed": "active",
  };
  const providerEventStatus = newStatus[event];
  await db.runTransaction(async (tx) => {
    const [eventSnapshot, subSnapshot, tenantSnapshot] = await Promise.all([tx.get(eventRef), tx.get(subscriptionRef), tx.get(tenantRef)]);
    if (eventSnapshot.exists && eventSnapshot.data()?.state !== "unmatched") return;
    const previous = subSnapshot.data();
    if (!previous || !tenantSnapshot.exists) {
      tx.set(eventRef, { eventId, event, shopId, providerSubscriptionId: providerId, state: "orphaned", receivedAt: FieldValue.serverTimestamp() }, { merge: true });
      return;
    }
    if (previous.providerMode && previous.providerMode !== mode) {
      tx.set(eventRef, { eventId, event, shopId, providerSubscriptionId: providerId, providerMode: mode, state: "mode_mismatch", receivedAt: FieldValue.serverTimestamp() }, { merge: true });
      return;
    }
    const updates: Record<string, unknown> = { providerMode: mode, providerStatus: entity.status ?? null, lastProviderEvent: event, updatedAt: FieldValue.serverTimestamp() };
    const tenantUpdates: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
    let status = providerEventStatus;
    if (status && ["pending_payment", "past_due"].includes(status) && ["active", "grace_period"].includes(String(previous.status))) status = "grace_period";
    if (status) { updates.status = status; tenantUpdates.subscriptionStatus = status; }
    if (status === "grace_period") updates.graceEndsAt = previous.graceEndsAt ?? Timestamp.fromMillis(Date.now() + 72 * 60 * 60 * 1000);
    if (status === "active") updates.graceEndsAt = FieldValue.delete();
    if (status === "cancelled") updates.cancelAtCycleEnd = false;
    let appliedPlan = false;
    let appliedPlanAmount = Number(previous.amountPaise ?? 0);
    const pendingPlanChange = previous.pendingPlanChange as { planId?: string; planName?: string; amountPaise?: number; orderLimit?: number | null; providerPlanId?: string; scheduleChangeAt?: string; customContractId?: string; renewalTerms?: string } | undefined;
    const planChangeConfirmed = pendingPlanChange?.scheduleChangeAt === "cycle_end"
      ? event === "subscription.charged"
      : ["subscription.updated", "subscription.charged", "subscription.activated", "subscription.resumed"].includes(event);
    const pendingCustomContract = previous.pendingCustomContract as { contractId?: string; planId?: string; planName?: string; amountPaise?: number; orderLimit?: number | null; providerPlanId?: string; renewalTerms?: string } | undefined;
    const customContractConfirmed = status === "active" && pendingCustomContract?.providerPlanId === entity.plan_id;
    if (pendingPlanChange?.providerPlanId && entity.plan_id === pendingPlanChange.providerPlanId && planChangeConfirmed) {
      updates.planId = pendingPlanChange.planId;
      updates.planName = pendingPlanChange.planName;
      updates.amountPaise = pendingPlanChange.amountPaise;
      updates.orderLimit = pendingPlanChange.orderLimit ?? null;
      updates.providerPlanId = pendingPlanChange.providerPlanId;
      appliedPlanAmount = Number(pendingPlanChange.amountPaise ?? previous.amountPaise ?? 0);
      if (pendingPlanChange.customContractId) {
        updates.customContractId = pendingPlanChange.customContractId;
        updates.renewalTerms = pendingPlanChange.renewalTerms;
      } else {
        updates.customContractId = FieldValue.delete();
        updates.renewalTerms = FieldValue.delete();
      }
      updates.pendingPlanChange = FieldValue.delete();
      appliedPlan = true;
      tenantUpdates.planId = pendingPlanChange.planId;
    } else if (customContractConfirmed && pendingCustomContract) {
      updates.planId = pendingCustomContract.planId ?? "custom";
      updates.planName = pendingCustomContract.planName;
      updates.amountPaise = pendingCustomContract.amountPaise;
      updates.orderLimit = pendingCustomContract.orderLimit ?? null;
      updates.providerPlanId = pendingCustomContract.providerPlanId;
      appliedPlanAmount = Number(pendingCustomContract.amountPaise ?? previous.amountPaise ?? 0);
      updates.customContractId = pendingCustomContract.contractId;
      updates.renewalTerms = pendingCustomContract.renewalTerms;
      updates.pendingCustomContract = FieldValue.delete();
      appliedPlan = true;
      tenantUpdates.planId = "custom";
    }
    const start = Number(entity.current_start ?? 0);
    const end = Number(entity.current_end ?? 0);
    if (start > 0) updates.currentPeriodStart = Timestamp.fromMillis(start * 1000);
    if (end > 0) updates.currentPeriodEnd = Timestamp.fromMillis(end * 1000);
    if (start > 0 && previous.currentPeriodStart?.toMillis?.() !== start * 1000) updates.currentUsage = 0;
    tx.set(subscriptionRef, updates, { merge: true });
    tx.update(tenantRef, tenantUpdates);
    if ((status && previous.status !== status) || appliedPlan) {
      const resultingStatus = status ?? String(previous.status);
      const resultingAmount = appliedPlan ? appliedPlanAmount : Number(previous.amountPaise ?? 0);
      tx.set(db.doc("platformMetrics/current"), {
        ...(status && previous.status !== status ? {
          [subscriptionStateKey(previous.status)]: FieldValue.increment(-1),
          [subscriptionStateKey(status)]: FieldValue.increment(1),
        } : {}),
        monthlyRecurringRevenuePaise: FieldValue.increment((resultingStatus === "active" ? resultingAmount : 0) - (previous.status === "active" ? Number(previous.amountPaise ?? 0) : 0)),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    if (event === "subscription.charged") {
      const amount = Number(body.payload?.payment?.entity?.amount ?? 0);
      if (Number.isSafeInteger(amount) && amount > 0) {
        tx.set(db.doc("platformMetrics/current"), { saasCollectedPaise: FieldValue.increment(amount), successfulSaasPayments: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        tx.create(db.collection(`subscriptions/${shopId}/payments`).doc(sha256(eventId)), { eventId, event, amountPaise: amount, currency: body.payload?.payment?.entity?.currency ?? "INR", status: "paid", providerPaymentId: body.payload?.payment?.entity?.id ?? null, createdAt: FieldValue.serverTimestamp() });
      }
    }
    if (["subscription.halted", "subscription.pending"].includes(event)) tx.set(db.doc("platformMetrics/current"), { failedSaasPayments: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    tx.set(eventRef, { eventId, event, shopId, providerSubscriptionId: providerId, providerStatus: entity.status ?? null, status: status ?? previous.status, state: "processed", receivedAt: FieldValue.serverTimestamp() }, { merge: true });
  });
  response.status(200).send("Webhook accepted");
});

const restaurantCreateSchema = z.object({
  name: z.string().trim().min(2).max(120), planId: z.string().min(2).max(48),
  ownerName: z.string().trim().min(2).max(100), phone: z.string().trim().min(8).max(24),
  address: z.string().trim().min(3).max(240), city: z.string().trim().min(2).max(80),
  state: z.string().trim().min(2).max(80), postalCode: z.string().trim().min(4).max(12),
  cuisine: z.string().trim().max(80).default(""), timezone: z.string().trim().max(64).default("Asia/Kolkata"),
});

export const listPlans = onCall({ ...CALL_OPTIONS, secrets: [RAZORPAY_KEY_ID] }, async () => {
  const mode = configuredRazorpayMode();
  const snapshot = await db.collection("plans").where("isActive", "==", true).orderBy("sortOrder").get();
  const visiblePlans = snapshot.docs.map((doc) => {
    const data = doc.data();
    return { id: doc.id, data };
  }).filter(({ data }) => data.isTestOnly !== true || mode === "test").map(({ id, data }) => ({
    id, name: data.name, pricePaise: data.pricePaise, orderLimit: data.orderLimit ?? null,
    description: data.description ?? "", features: Array.isArray(data.features) ? data.features : [],
    isCustom: data.isCustom === true, isActive: data.isActive === true, isTestOnly: data.isTestOnly === true,
  }));
  return { plans: visiblePlans };
});

export const createRestaurant = onCall({ ...CALL_OPTIONS, secrets: [RAZORPAY_KEY_ID] }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in with your owner account first.");
  await rateLimit(request, "createRestaurant", 5);
  const input = zodInput(restaurantCreateSchema, request.data);
  const owner = await auth.getUser(request.auth.uid);
  if (!owner.email || !owner.emailVerified) throw new HttpsError("failed-precondition", "Verify your Email/Password account before creating a restaurant.");
  const ownerEmail = owner.email.toLowerCase();
  const planRef = db.doc(`plans/${input.planId}`);
  const plan = await planRef.get();
  if (!plan.exists || plan.data()?.isActive !== true || plan.data()?.isCustom === true) throw new HttpsError("failed-precondition", "Choose an available self-service plan.");
  const planData = plan.data()!;
  if (planData.isTestOnly === true && configuredRazorpayMode() !== "test") throw new HttpsError("failed-precondition", "The ₹1 sandbox plan is available only while Firebase Functions use Razorpay Test Mode keys.");
  const restaurantRef = db.collection("restaurants").doc();
  const staffRef = restaurantRef.collection("staff").doc(owner.uid);
  const membershipRef = db.doc(`users/${owner.uid}/memberships/${restaurantRef.id}`);
  const subscriptionRef = db.doc(`subscriptions/${restaurantRef.id}`);
  const auditRef = restaurantRef.collection("auditLogs").doc();
  await db.runTransaction(async (tx) => {
    const [existingMembership, currentPlan] = await Promise.all([tx.get(membershipRef), tx.get(planRef)]);
    if (existingMembership.exists) throw new HttpsError("already-exists", "This workspace has already been created.");
    if (!currentPlan.exists || currentPlan.data()?.isActive !== true) throw new HttpsError("failed-precondition", "That plan is no longer available.");
    const now = FieldValue.serverTimestamp();
    tx.create(restaurantRef, {
      schemaVersion: 2, shopId: restaurantRef.id, name: input.name, nameKey: input.name.toLocaleLowerCase("en-US"),
      ownerUid: owner.uid, ownerEmail, ownerName: input.ownerName, phone: input.phone,
      address: input.address, city: input.city, state: input.state, postalCode: input.postalCode,
      cuisine: input.cuisine, timezone: input.timezone, currency: "INR", taxRateBps: 0, serviceFeePaise: 0,
      isAcceptingOrders: false, platformStatus: "active", subscriptionStatus: "pending_payment",
      planId: input.planId, lifetimeAcceptedOrders: 0, createdAt: now, updatedAt: now,
    });
    tx.create(staffRef, { uid: owner.uid, email: ownerEmail, displayName: owner.displayName ?? input.ownerName, role: "owner", isActive: true, createdAt: now, updatedAt: now });
    tx.create(membershipRef, { shopId: restaurantRef.id, shopName: input.name, role: "owner", isActive: true, createdAt: now, updatedAt: now });
    tx.create(subscriptionRef, {
      shopId: restaurantRef.id, planId: input.planId, planName: planData.name,
      amountPaise: planData.pricePaise, orderLimit: planData.orderLimit ?? null,
      status: "pending_payment", currency: "INR", provider: "razorpay",
      currentUsage: 0, currentPeriodStart: null, currentPeriodEnd: null,
      createdAt: now, updatedAt: now,
    });
    tx.create(auditRef, { action: "restaurant.created", targetType: "restaurant", targetId: restaurantRef.id, actorUid: owner.uid, actorEmail: owner.email, actorRole: "owner", details: { name: input.name, planId: input.planId }, createdAt: now });
    tx.set(db.doc("platformMetrics/current"), { tenantTotal: FieldValue.increment(1), tenantPendingPayment: FieldValue.increment(1), updatedAt: now }, { merge: true });
  });
  return { shopId: restaurantRef.id, status: "pending_payment" };
});

export const listMyRestaurants = onCall(CALL_OPTIONS, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  if (request.auth.token.email_verified !== true) throw new HttpsError("failed-precondition", "Verify your account email before continuing.");
  const snapshot = await db.collection(`users/${request.auth.uid}/memberships`).where("isActive", "==", true).orderBy("createdAt", "desc").get();
  return { shops: snapshot.docs.map((doc) => ({ shopId: doc.id, name: doc.data().shopName ?? "Restaurant", role: doc.data().role })) };
});

export const getMyShopAccess = onCall(CALL_OPTIONS, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  if (request.auth.token.email_verified !== true) throw new HttpsError("failed-precondition", "Verify your account email before continuing.");
  const { shopId } = zodInput(z.object({ shopId: z.string().min(1).max(128) }), request.data);
  const [membership, staff] = await Promise.all([
    db.doc(`users/${request.auth.uid}/memberships/${shopId}`).get(),
    db.doc(`restaurants/${shopId}/staff/${request.auth.uid}`).get(),
  ]);
  const data = staff.data();
  if (!membership.exists || membership.data()?.isActive !== true || !staff.exists || data?.isActive !== true || data?.role !== membership.data()?.role) throw new HttpsError("permission-denied", "You do not have active access to this restaurant.");
  return { shopId, role: data.role, shopName: membership.data()?.shopName ?? "Restaurant" };
});

const tableSchema = z.object({ tableNumber: z.string().trim().min(1, "Enter a table number.").max(24, "Table number is too long.") });
const tableIdSchema = z.object({ tableId: z.string().min(1).max(80) });
const variantSchema = z.object({ id: z.string().min(1).max(80), name: z.string().trim().min(1).max(80), priceDeltaPaise: z.number().int().min(0).max(100_000_000) });
const addOnSchema = z.object({ id: z.string().min(1).max(80), name: z.string().trim().min(1).max(80), pricePaise: z.number().int().min(0).max(100_000_000) });
const menuSaveSchema = z.object({
  itemId: z.string().min(1).max(80).optional(), name: z.string().trim().min(2).max(100), description: z.string().trim().max(500).default(""),
  categoryId: z.string().min(1).max(80), pricePaise: z.number().int().min(0).max(100_000_000), dietaryType: z.enum(["veg", "non-veg"]),
  imageUrl: z.string().trim().max(2048).default(""), variants: z.array(variantSchema).max(20).default([]), addOns: z.array(addOnSchema).max(30).default([]),
});

function qrMap(hash: string) { return db.collection("qrLookup").doc(hash); }

export const resolveTableQr = onCall(CALL_OPTIONS, async (request) => {
  const { shopId, token } = zodInput(z.object({ shopId: z.string().min(1).max(128), token: z.string().min(30).max(100) }), request.data);
  await rateLimit(request, "resolveTableQr", 120);
  const hash = sha256(token);
  const mapSnapshot = await qrMap(hash).get();
  if (!mapSnapshot.exists || mapSnapshot.data()?.isActive !== true) throw new HttpsError("not-found", "This table QR is invalid or inactive.");
  const map = mapSnapshot.data()!;
  if (!qrShopMatchesRoute(shopId, String(map.restaurantId))) throw new HttpsError("not-found", "This QR belongs to a different restaurant.");
  const restaurantRef = db.doc(`restaurants/${map.restaurantId}`);
  const tableRef = restaurantRef.collection("tables").doc(String(map.tableId));
  const [tableSnapshot, restaurantSnapshot, subscriptionSnapshot] = await Promise.all([tableRef.get(), restaurantRef.get(), db.doc(`subscriptions/${shopId}`).get()]);
  if (!tableSnapshot.exists || !restaurantSnapshot.exists) throw new HttpsError("not-found", "This table QR is no longer available.");
  const table = tableSnapshot.data()!;
  const profile = restaurantSnapshot.data()!;
  if (table.isActive !== true || table.qrTokenHash !== hash || typeof profile.name !== "string") throw new HttpsError("not-found", "This table QR is invalid or inactive.");
  const subscription = subscriptionSnapshot.data();
  const periodEndMs = subscription?.currentPeriodEnd?.toMillis?.() ?? 0;
  const orderingAllowed = canAcceptRestaurantOrders({ restaurantOpen: profile.isAcceptingOrders === true, platformStatus: String(profile.platformStatus ?? "active"), subscriptionStatus: String(subscription?.status ?? "pending_payment"), periodEndMs: periodEndMs || null, graceEndMs: subscription?.graceEndsAt?.toMillis?.() ?? null, currentUsage: Number(subscription?.currentUsage ?? 0), orderLimit: subscription?.orderLimit === null || subscription?.orderLimit === undefined ? null : Number(subscription.orderLimit), nowMs: Date.now() });
  return {
    shopId, restaurantId: shopId, restaurantName: profile.name, tableNumber: String(table.tableNumber),
    taxRateBps: Number(profile.taxRateBps ?? 0), serviceFeePaise: Number(profile.serviceFeePaise ?? 0),
    isAcceptingOrders: orderingAllowed,
  };
});

export const resolveLegacyTableQr = onCall(CALL_OPTIONS, async (request) => {
  const { token } = zodInput(z.object({ token: z.string().min(30).max(100) }), request.data);
  await rateLimit(request, "resolveLegacyTableQr", 60);
  const hash = sha256(token);
  const mapSnapshot = await qrMap(hash).get();
  if (!mapSnapshot.exists || mapSnapshot.data()?.isActive !== true) throw new HttpsError("not-found", "This table QR is invalid or inactive.");
  const map = mapSnapshot.data()!;
  const table = await db.doc(`restaurants/${map.restaurantId}/tables/${map.tableId}`).get();
  if (!table.exists || table.data()?.isActive !== true || table.data()?.qrTokenHash !== hash) throw new HttpsError("not-found", "This table QR is invalid or inactive.");
  return { shopId: String(map.restaurantId) };
});

export const listTables = onCall(CALL_OPTIONS, async (request) => {
  const actor = await requireStaff(request);
  const snapshot = await restaurant(actor).collection("tables").orderBy("tableNumber").get();
  return { tables: snapshot.docs.map((doc) => {
    const data = doc.data();
    return { id: doc.id, tableNumber: data.tableNumber, isActive: data.isActive === true, qrToken: typeof data.qrToken === "string" ? data.qrToken : "", createdAt: data.createdAt?.toMillis?.() ?? null };
  }) };
});

export const createTable = onCall(CALL_OPTIONS, async (request) => {
  const actor = await requireStaff(request);
  const { tableNumber } = zodInput(tableSchema, request.data);
  const numberKey = normalizeTableNumber(tableNumber);
  if (!numberKey) invalid("Enter a valid table number.");
  const restaurantRef = restaurant(actor);
  const tableRef = restaurantRef.collection("tables").doc();
  const numberRef = restaurantRef.collection("tableNumbers").doc(sha256(numberKey));
  const token = newQrToken();
  const tokenHash = sha256(token);
  const audit = auditRef(actor);
  await db.runTransaction(async (tx) => {
    const [profile, registered] = await Promise.all([tx.get(restaurantRef), tx.get(numberRef)]);
    if (!profile.exists) throw new HttpsError("failed-precondition", "Create the restaurant profile before adding tables.");
    if (registered.exists) throw new HttpsError("already-exists", "An active table already uses that number.");
    tx.create(tableRef, { restaurantId: actor.restaurantId, tableNumber, isActive: true, qrToken: token, qrTokenHash: tokenHash, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    tx.create(numberRef, { tableId: tableRef.id, tableNumber, updatedAt: FieldValue.serverTimestamp() });
    tx.create(qrMap(tokenHash), { restaurantId: actor.restaurantId, tableId: tableRef.id, isActive: true, createdAt: FieldValue.serverTimestamp() });
    tx.create(audit, auditRecord(actor, "table.created", "table", tableRef.id, { tableNumber }));
  });
  return { id: tableRef.id, tableNumber, qrToken: token };
});

export const renameTable = onCall(CALL_OPTIONS, async (request) => {
  const actor = await requireStaff(request);
  const { tableId, tableNumber } = zodInput(tableIdSchema.extend({ tableNumber: tableSchema.shape.tableNumber }), request.data);
  const restaurantRef = restaurant(actor);
  const tableRef = restaurantRef.collection("tables").doc(tableId);
  const nextKey = normalizeTableNumber(tableNumber);
  const nextNumberRef = restaurantRef.collection("tableNumbers").doc(sha256(nextKey));
  const audit = auditRef(actor);
  await db.runTransaction(async (tx) => {
    const tableSnapshot = await tx.get(tableRef);
    if (!tableSnapshot.exists) throw new HttpsError("not-found", "Table not found.");
    const table = tableSnapshot.data()!;
    if (table.isActive) {
      const previousKey = normalizeTableNumber(String(table.tableNumber));
      if (nextKey !== previousKey) {
        const [nextNumber, previousNumber] = await Promise.all([tx.get(nextNumberRef), tx.get(restaurantRef.collection("tableNumbers").doc(sha256(previousKey)))]);
        if (nextNumber.exists) throw new HttpsError("already-exists", "An active table already uses that number.");
        if (previousNumber.exists && previousNumber.data()?.tableId === tableId) tx.delete(previousNumber.ref);
        tx.create(nextNumberRef, { tableId, tableNumber, updatedAt: FieldValue.serverTimestamp() });
      }
    }
    tx.update(tableRef, { tableNumber, updatedAt: FieldValue.serverTimestamp() });
    tx.create(audit, auditRecord(actor, "table.renamed", "table", tableId, { previous: table.tableNumber, tableNumber }));
  });
  return { ok: true };
});

export const regenerateTableQr = onCall(CALL_OPTIONS, async (request) => {
  const actor = await requireStaff(request);
  const { tableId } = zodInput(tableIdSchema, request.data);
  const tableRef = restaurant(actor).collection("tables").doc(tableId);
  const token = newQrToken();
  const tokenHash = sha256(token);
  const audit = auditRef(actor);
  await db.runTransaction(async (tx) => {
    const tableSnapshot = await tx.get(tableRef);
    if (!tableSnapshot.exists || tableSnapshot.data()?.isActive !== true) throw new HttpsError("failed-precondition", "Activate the table before regenerating its QR.");
    const table = tableSnapshot.data()!;
    if (typeof table.qrTokenHash === "string") tx.delete(qrMap(table.qrTokenHash));
    tx.create(qrMap(tokenHash), { restaurantId: actor.restaurantId, tableId, isActive: true, createdAt: FieldValue.serverTimestamp() });
    tx.update(tableRef, { qrToken: token, qrTokenHash: tokenHash, updatedAt: FieldValue.serverTimestamp() });
    tx.create(audit, auditRecord(actor, "table.qr_regenerated", "table", tableId, { tableNumber: table.tableNumber }));
  });
  return { qrToken: token };
});

export const setTableActive = onCall(CALL_OPTIONS, async (request) => {
  const actor = await requireStaff(request);
  const { tableId, isActive } = zodInput(tableIdSchema.extend({ isActive: z.boolean() }), request.data);
  const restaurantRef = restaurant(actor);
  const tableRef = restaurantRef.collection("tables").doc(tableId);
  const audit = auditRef(actor);
  const token = isActive ? newQrToken() : "";
  const tokenHash = token ? sha256(token) : "";
  let returnedToken = "";
  await db.runTransaction(async (tx) => {
    const tableSnapshot = await tx.get(tableRef);
    if (!tableSnapshot.exists) throw new HttpsError("not-found", "Table not found.");
    const table = tableSnapshot.data()!;
    if (table.isActive === isActive) { returnedToken = isActive && typeof table.qrToken === "string" ? table.qrToken : ""; return; }
    const numberRef = restaurantRef.collection("tableNumbers").doc(sha256(normalizeTableNumber(String(table.tableNumber))));
    if (!isActive) {
      const numberSnapshot = await tx.get(numberRef);
      if (numberSnapshot.exists && numberSnapshot.data()?.tableId === tableId) tx.delete(numberRef);
      if (typeof table.qrTokenHash === "string") tx.delete(qrMap(table.qrTokenHash));
      tx.update(tableRef, { isActive: false, qrToken: null, qrTokenHash: null, updatedAt: FieldValue.serverTimestamp() });
    } else {
      const numberSnapshot = await tx.get(numberRef);
      if (numberSnapshot.exists) throw new HttpsError("already-exists", "An active table already uses that number.");
      tx.create(numberRef, { tableId, tableNumber: table.tableNumber, updatedAt: FieldValue.serverTimestamp() });
      tx.create(qrMap(tokenHash), { restaurantId: actor.restaurantId, tableId, isActive: true, createdAt: FieldValue.serverTimestamp() });
      tx.update(tableRef, { isActive: true, qrToken: token, qrTokenHash: tokenHash, updatedAt: FieldValue.serverTimestamp() });
      returnedToken = token;
    }
    tx.create(audit, auditRecord(actor, isActive ? "table.activated" : "table.deactivated", "table", tableId, { tableNumber: table.tableNumber }));
  });
  return { ok: true, ...(isActive ? { qrToken: returnedToken } : {}) };
});

const placeOrderSchema = z.object({
  shopId: z.string().min(1).max(128), qrToken: z.string().min(30).max(100), idempotencyKey: z.string().min(16).max(100),
  customerName: z.string().trim().min(2).max(80), customerPhone: z.string().trim().min(8).max(20),
  items: z.array(z.object({ itemId: z.string().min(1).max(80), quantity: z.number().int().min(1).max(20), variantId: z.string().max(80).optional(), addOnIds: z.array(z.string().max(80)).max(30).default([]), specialInstructions: z.string().trim().max(250).optional() })).min(1).max(50),
});

export const placeOrder = onCall({ ...CALL_OPTIONS, timeoutSeconds: 60 }, async (request) => {
  const input = zodInput(placeOrderSchema, request.data);
  if (!isValidPhone(input.customerPhone)) invalid("Enter a valid phone number.");
  await rateLimit(request, "placeOrder", 12);
  const tokenHash = sha256(input.qrToken);
  const requestHash = sha256(JSON.stringify({ tokenHash, customerName: input.customerName, customerPhone: input.customerPhone, items: input.items }));
  const idempotencyRef = db.collection("idempotencyLookup").doc(sha256(input.idempotencyKey));
  const priorAttempt = await idempotencyRef.get();
  if (priorAttempt.exists) {
    const stored = priorAttempt.data()!;
    if (stored.requestHash !== requestHash) throw new HttpsError("already-exists", "This order request key was already used with different details.");
    return { ticketId: String(stored.ticketId) };
  }
  const mapRef = qrMap(tokenHash);
  const mapSnapshot = await mapRef.get();
  if (!mapSnapshot.exists || mapSnapshot.data()?.isActive !== true) throw new HttpsError("not-found", "This table QR is invalid or inactive.");
  const map = mapSnapshot.data()!;
  const rid = String(map.restaurantId);
  if (!qrShopMatchesRoute(input.shopId, rid)) throw new HttpsError("not-found", "This QR belongs to a different restaurant.");
  const restaurantRef = db.doc(`restaurants/${rid}`);
  const subscriptionRef = db.doc(`subscriptions/${rid}`);
  const tableRef = restaurantRef.collection("tables").doc(String(map.tableId));
  const menuRefs = [...new Set(input.items.map((item) => item.itemId))].map((id) => restaurantRef.collection("menuItems").doc(id));
  const orderRef = restaurantRef.collection("orders").doc();
  const ticketId = newTicketId();
  const trackingId = sha256(ticketId);
  const trackingRef = restaurantRef.collection("publicTracking").doc(trackingId);
  const lookupRef = db.collection("ticketLookup").doc(trackingId);
  const now = Timestamp.now();
  const activityRef = restaurantRef.collection("auditLogs").doc();
  let returnedTicketId = ticketId;
  await db.runTransaction(async (tx) => {
    const idempotent = await tx.get(idempotencyRef);
    if (idempotent.exists) {
      const stored = idempotent.data()!;
      if (stored.requestHash !== requestHash) throw new HttpsError("already-exists", "This order request key was already used with different details.");
      returnedTicketId = String(stored.ticketId);
      return;
    }
    const [restaurantSnapshot, tableSnapshot, subscriptionSnapshot, ...menuSnapshots] = await Promise.all([tx.get(restaurantRef), tx.get(tableRef), tx.get(subscriptionRef), ...menuRefs.map((ref) => tx.get(ref))]);
    const profile = restaurantSnapshot.data();
    const table = tableSnapshot.data();
    const subscription = subscriptionSnapshot.data();
    if (!restaurantSnapshot.exists || !tableSnapshot.exists || !profile || !table || !subscriptionSnapshot.exists || !subscription) throw new HttpsError("not-found", "This restaurant table is unavailable.");
    if (table.isActive !== true || table.qrTokenHash !== tokenHash) throw new HttpsError("not-found", "This table QR is invalid or inactive.");
    const currentUsage = Number(subscription.currentUsage ?? 0);
    const orderLimit = subscription.orderLimit === null || subscription.orderLimit === undefined ? null : Number(subscription.orderLimit);
    const withinQuota = isWithinOrderQuota(orderLimit, currentUsage);
    const entitlementActive = canAcceptRestaurantOrders({ restaurantOpen: profile.isAcceptingOrders === true, platformStatus: String(profile.platformStatus ?? "active"), subscriptionStatus: String(subscription.status), periodEndMs: subscription.currentPeriodEnd?.toMillis?.() ?? null, graceEndMs: subscription.graceEndsAt?.toMillis?.() ?? null, currentUsage, orderLimit, nowMs: Date.now() });
    if (!entitlementActive) throw new HttpsError("failed-precondition", "Online ordering is temporarily unavailable; please contact staff.");
    if (!withinQuota) throw new HttpsError("resource-exhausted", "This restaurant has reached its online order limit for this billing cycle. Please contact staff.");
    const snapshotById = new Map(menuRefs.map((ref, index) => [ref.id, menuSnapshots[index]]));
    const orderItems = input.items.map((requested) => {
      if (new Set(requested.addOnIds).size !== requested.addOnIds.length) throw new HttpsError("invalid-argument", "An add-on can only be selected once per dish.");
      const snapshot = snapshotById.get(requested.itemId);
      const item = snapshot?.data();
      if (!snapshot?.exists || !item || item.isActive !== true || item.isAvailable !== true) throw new HttpsError("failed-precondition", "A selected menu item is no longer available.");
      if (!Number.isSafeInteger(item.pricePaise) || item.pricePaise < 0) throw new HttpsError("failed-precondition", "A menu item has an invalid price configuration.");
      const variants = Array.isArray(item.variants) ? item.variants : [];
      const addOns = Array.isArray(item.addOns) ? item.addOns : [];
      const selectedVariant = requested.variantId ? variants.find((choice: { id: string }) => choice.id === requested.variantId) : undefined;
      if (item.variantRequired === true && !selectedVariant) throw new HttpsError("invalid-argument", `Choose a portion for ${item.name}.`);
      if (requested.variantId && !selectedVariant) throw new HttpsError("invalid-argument", `The selected portion for ${item.name} is no longer available.`);
      const selectedAddOns = requested.addOnIds.map((id) => addOns.find((choice: { id: string }) => choice.id === id));
      if (selectedAddOns.some((choice) => !choice)) throw new HttpsError("invalid-argument", `An add-on for ${item.name} is no longer available.`);
      const variantDelta = Number(selectedVariant?.priceDeltaPaise ?? 0);
      const addOnTotal = selectedAddOns.reduce((sum, choice) => sum + Number(choice?.pricePaise ?? 0), 0);
      if (![variantDelta, addOnTotal].every(Number.isSafeInteger)) throw new HttpsError("failed-precondition", "A menu modifier has an invalid price.");
      const unitPricePaise = Number(item.pricePaise) + variantDelta + addOnTotal;
      const lineTotalPaise = unitPricePaise * requested.quantity;
      if (!Number.isSafeInteger(lineTotalPaise)) throw new HttpsError("invalid-argument", "Order total is too large.");
      return {
        menuItemId: requested.itemId, name: String(item.name), description: String(item.description ?? ""),
        imageUrl: String(item.imageUrl ?? ""), dietaryType: item.dietaryType,
        quantity: requested.quantity, unitPricePaise, lineTotalPaise,
        variant: selectedVariant ? { id: selectedVariant.id, name: selectedVariant.name, priceDeltaPaise: variantDelta } : null,
        addOns: selectedAddOns.map((choice) => ({ id: choice!.id, name: choice!.name, pricePaise: Number(choice!.pricePaise ?? 0) })),
        selections: [selectedVariant?.name, ...selectedAddOns.map((choice) => choice?.name)].filter((label): label is string => Boolean(label)),
        specialInstructions: requested.specialInstructions ?? "",
      };
    });
    const subtotal = orderItems.reduce((sum, item) => sum + item.lineTotalPaise, 0);
    const taxRateBps = Number(profile.taxRateBps ?? 0);
    const serviceFeePaise = subtotal > 0 ? Number(profile.serviceFeePaise ?? 0) : 0;
    if (!Number.isInteger(taxRateBps) || taxRateBps < 0 || taxRateBps > 10_000 || !Number.isSafeInteger(serviceFeePaise) || serviceFeePaise < 0) throw new HttpsError("failed-precondition", "Restaurant tax or service fee settings are invalid.");
    if (!Number.isSafeInteger(subtotal)) throw new HttpsError("invalid-argument", "Order total is too large.");
    const amounts = calculateOrderAmounts(subtotal, taxRateBps, serviceFeePaise);
    if (![amounts.taxPaise, amounts.totalAmountPaise].every(Number.isSafeInteger)) throw new HttpsError("invalid-argument", "Order total is too large.");
    const initialEvent = { status: "queued" as Status, at: now };
    const tracking = { ticketId, tableNumber: String(table.tableNumber), status: "queued" as Status, estimatedMinutes: null, expectedReadyAt: null, statusEvents: [initialEvent], createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() };
    const kitchenRef = restaurantRef.collection("kitchenOrders").doc(orderRef.id);
    tx.create(orderRef, {
      id: orderRef.id, ticketId, restaurantId: rid, tableId: tableRef.id, tableNumberSnapshot: String(table.tableNumber),
      customerName: input.customerName, customerPhone: input.customerPhone, items: orderItems, ...amounts,
      status: "queued", estimatedMinutes: null, expectedReadyAt: null, assignedStaffUid: null, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });
    tx.create(kitchenRef, {
      ticketId, tableNumberSnapshot: String(table.tableNumber), items: orderItems.map((item) => ({ name: item.name, quantity: item.quantity, selections: item.selections, specialInstructions: item.specialInstructions })),
      status: "queued", estimatedMinutes: null, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });
    tx.create(trackingRef, tracking);
    tx.create(lookupRef, { restaurantId: rid, trackingId, ticketId, createdAt: FieldValue.serverTimestamp() });
    tx.create(idempotencyRef, { requestHash, restaurantId: rid, orderId: orderRef.id, ticketId, trackingId, createdAt: FieldValue.serverTimestamp() });
    tx.create(activityRef, { action: "order.created", targetType: "order", targetId: orderRef.id, actorUid: null, actorEmail: null, actorRole: "customer", details: { ticketId, tableNumber: String(table.tableNumber) }, createdAt: FieldValue.serverTimestamp() });
  });
  return { ticketId: returnedTicketId };
});

function serializeTracking(snapshot: DocumentSnapshot): Record<string, unknown> {
  const data = snapshot.data()!;
  return {
    ticketId: data.ticketId, tableNumber: data.tableNumber, status: data.status,
    estimatedMinutes: typeof data.estimatedMinutes === "number" ? data.estimatedMinutes : null,
    expectedReadyAtMs: data.expectedReadyAt?.toMillis?.() ?? null,
    statusEvents: Array.isArray(data.statusEvents) ? data.statusEvents.map((event: { status: Status; at?: Timestamp }) => ({ status: event.status, atMs: event.at?.toMillis?.() ?? null })) : [],
  };
}

export const lookupTicket = onCall(CALL_OPTIONS, async (request) => {
  const { ticketId } = zodInput(z.object({ ticketId: z.string().trim().min(8).max(60) }), request.data);
  await rateLimit(request, "lookupTicket", 30);
  const normalized = ticketId.toUpperCase();
  if (!/^TS-[A-F0-9]{40}$/.test(normalized)) throw new HttpsError("not-found", "Ticket ID not found.");
  const trackingId = sha256(normalized);
  const pointer = await db.collection("ticketLookup").doc(trackingId).get();
  if (!pointer.exists || pointer.data()?.ticketId !== normalized) throw new HttpsError("not-found", "Ticket ID not found.");
  const restaurantId = String(pointer.data()?.restaurantId);
  const track = await db.doc(`restaurants/${restaurantId}/publicTracking/${trackingId}`).get();
  if (!track.exists) throw new HttpsError("not-found", "Ticket ID not found.");
  return { restaurantId, trackingId, tracking: serializeTracking(track) };
});

async function applyBillableUsageTransition(tx: Transaction, actor: Actor, orderId: string, order: Record<string, unknown>, nextStatus: Status) {
  const currentStatus = String(order.status);
  const isAcceptance = isBillableOrderTransition(currentStatus, nextStatus);
  const isEligibleCancellation = isEligibleUsageReversal(currentStatus, nextStatus);
  if (!isAcceptance && !isEligibleCancellation) return;
  const subscriptionRef = db.doc(`subscriptions/${actor.restaurantId}`);
  const eventRef = restaurant(actor).collection("usageEvents").doc(orderId);
  const [subscriptionSnapshot, eventSnapshot] = await Promise.all([tx.get(subscriptionRef), tx.get(eventRef)]);
  if (!subscriptionSnapshot.exists) throw new HttpsError("failed-precondition", "This restaurant does not have an active billing subscription.");
  const subscription = subscriptionSnapshot.data()!;
  const currentStart = subscription.currentPeriodStart?.toMillis?.() ?? 0;
  const currentEnd = subscription.currentPeriodEnd?.toMillis?.() ?? 0;
  if (!currentStart || !currentEnd || currentEnd <= Date.now()) throw new HttpsError("failed-precondition", "The restaurant billing period is not active.");
  const cycleId = String(currentStart);
  const cycleRef = restaurant(actor).collection("usageCycles").doc(cycleId);
  const cycleSnapshot = await tx.get(cycleRef);
  if (isAcceptance) {
    if (subscription.status !== "active" && subscription.status !== "grace_period") throw new HttpsError("failed-precondition", "The restaurant subscription does not permit new accepted orders.");
    if (eventSnapshot.exists && eventSnapshot.data()?.billable === true) return;
    const count = Number(cycleSnapshot.data()?.acceptedOrders ?? 0);
    const limit = subscription.orderLimit === null || subscription.orderLimit === undefined ? null : Number(subscription.orderLimit);
    if (!isWithinOrderQuota(limit, count)) throw new HttpsError("resource-exhausted", "The plan's accepted-order limit has been reached. Upgrade the plan to accept more orders.");
    const now = Timestamp.now();
    tx.set(cycleRef, { shopId: actor.restaurantId, cycleId, periodStart: Timestamp.fromMillis(currentStart), periodEnd: Timestamp.fromMillis(currentEnd), acceptedOrders: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp(), ...(cycleSnapshot.exists ? {} : { createdAt: FieldValue.serverTimestamp() }) }, { merge: true });
    tx.set(subscriptionRef, { currentUsage: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    tx.update(restaurant(actor), { lifetimeAcceptedOrders: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() });
    tx.set(db.doc("platformMetrics/current"), { totalAcceptedOrders: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    tx.set(eventRef, { shopId: actor.restaurantId, orderId, cycleId, billable: true, acceptedAt: now, createdAt: FieldValue.serverTimestamp() }, { merge: true });
    return;
  }
  if (!eventSnapshot.exists || eventSnapshot.data()?.billable !== true || eventSnapshot.data()?.reversedAt) return;
  const event = eventSnapshot.data()!;
  const billedCycleId = String(event.cycleId ?? "");
  if (!billedCycleId) throw new HttpsError("internal", "The order has an invalid billing usage record.");
  const billedCycleRef = restaurant(actor).collection("usageCycles").doc(billedCycleId);
  const billedCycleSnapshot = billedCycleId === cycleId ? cycleSnapshot : await tx.get(billedCycleRef);
  const billedCount = Number(billedCycleSnapshot.data()?.acceptedOrders ?? 0);
  if (billedCount < 1) throw new HttpsError("internal", "The order usage counter is inconsistent; contact support.");
  tx.update(billedCycleRef, { acceptedOrders: FieldValue.increment(-1), updatedAt: FieldValue.serverTimestamp() });
  if (billedCycleId === cycleId) tx.set(subscriptionRef, { currentUsage: FieldValue.increment(-1), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  tx.set(eventRef, { reversedAt: FieldValue.serverTimestamp(), reversalReason: "eligible_cancellation_before_preparation" }, { merge: true });
  tx.set(db.doc("platformMetrics/current"), { totalAcceptedOrders: FieldValue.increment(-1), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
}

export const setOrderEta = onCall(CALL_OPTIONS, async (request) => {
  const actor = await requireStaff(request, ["owner", "manager"]);
  const { orderId, estimatedMinutes } = zodInput(z.object({ orderId: z.string().min(1).max(80), estimatedMinutes: z.number().int().min(1).max(240) }), request.data);
  const orderRef = restaurant(actor).collection("orders").doc(orderId);
  await db.runTransaction(async (tx) => {
    const orderSnapshot = await tx.get(orderRef);
    if (!orderSnapshot.exists) throw new HttpsError("not-found", "Order not found.");
    const order = orderSnapshot.data()!;
    if (!["queued", "accepted", "preparing"].includes(String(order.status))) throw new HttpsError("failed-precondition", "ETA can only be set on an active order.");
    const trackingRef = restaurant(actor).collection("publicTracking").doc(sha256(String(order.ticketId)));
    const trackingSnapshot = await tx.get(trackingRef);
    const kitchenRef = restaurant(actor).collection("kitchenOrders").doc(orderId);
    const assignedRef = restaurant(actor).collection("assignedOrders").doc(orderId);
    const [kitchenSnapshot, assignedSnapshot] = await Promise.all([tx.get(kitchenRef), tx.get(assignedRef)]);
    const now = Timestamp.now();
    const nextStatus = order.status === "queued" ? "accepted" : order.status;
    const eventAdded = nextStatus !== order.status;
    const expectedReadyAt = Timestamp.fromMillis(now.toMillis() + estimatedMinutes * 60_000);
    await applyBillableUsageTransition(tx, actor, orderId, order, nextStatus as Status);
    tx.update(orderRef, { status: nextStatus, estimatedMinutes, expectedReadyAt, updatedAt: FieldValue.serverTimestamp(), ...(eventAdded ? { statusEvents: FieldValue.arrayUnion({ status: nextStatus, at: now }) } : {}) });
    if (trackingSnapshot.exists) tx.update(trackingRef, { status: nextStatus, estimatedMinutes, expectedReadyAt, updatedAt: FieldValue.serverTimestamp(), ...(eventAdded ? { statusEvents: FieldValue.arrayUnion({ status: nextStatus, at: now }) } : {}) });
    if (kitchenSnapshot.exists) tx.update(kitchenRef, { status: nextStatus, estimatedMinutes, updatedAt: FieldValue.serverTimestamp() });
    if (assignedSnapshot.exists) tx.update(assignedRef, { status: nextStatus, estimatedMinutes, updatedAt: FieldValue.serverTimestamp() });
    useAudit(tx, actor, "order.eta_saved", "order", orderId, { ticketId: order.ticketId, estimatedMinutes });
  });
  return { ok: true };
});

export const setOrderStatus = onCall(CALL_OPTIONS, async (request) => {
  const actor = await requireStaff(request, ["owner", "manager", "kitchen", "waiter"]);
  const { orderId, status } = zodInput(z.object({ orderId: z.string().min(1).max(80), status: z.enum(["queued", "accepted", "preparing", "ready", "served", "cancelled"]) }), request.data);
  if (status === "cancelled" && actor.role !== "owner") throw new HttpsError("permission-denied", "Only the restaurant owner can cancel an order.");
  if (status === "served" && actor.role === "kitchen") throw new HttpsError("permission-denied", "Kitchen staff cannot mark a guest order as served.");
  if (actor.role === "kitchen" && !["preparing", "ready"].includes(status)) throw new HttpsError("permission-denied", "Kitchen staff can move orders into preparation or mark them ready.");
  const orderRef = restaurant(actor).collection("orders").doc(orderId);
  await db.runTransaction(async (tx) => {
    const orderSnapshot = await tx.get(orderRef);
    if (!orderSnapshot.exists) throw new HttpsError("not-found", "Order not found.");
    const order = orderSnapshot.data()!;
    if (actor.role === "waiter" && (status !== "served" || order.assignedStaffUid !== actor.uid)) throw new HttpsError("permission-denied", "Waiters can mark only their own assigned orders as served.");
    if (!transitionAllowed(String(order.status), status)) throw new HttpsError("failed-precondition", `Cannot move an order from ${order.status} to ${status}.`);
    const trackingRef = restaurant(actor).collection("publicTracking").doc(sha256(String(order.ticketId)));
    const trackingSnapshot = await tx.get(trackingRef);
    const kitchenRef = restaurant(actor).collection("kitchenOrders").doc(orderId);
    const assignedRef = restaurant(actor).collection("assignedOrders").doc(orderId);
    const [kitchenSnapshot, assignedSnapshot] = await Promise.all([tx.get(kitchenRef), tx.get(assignedRef)]);
    const event = { status, at: Timestamp.now() };
    await applyBillableUsageTransition(tx, actor, orderId, order, status);
    tx.update(orderRef, { status, statusEvents: FieldValue.arrayUnion(event), updatedAt: FieldValue.serverTimestamp() });
    if (trackingSnapshot.exists) tx.update(trackingRef, { status, statusEvents: FieldValue.arrayUnion(event), updatedAt: FieldValue.serverTimestamp() });
    if (kitchenSnapshot.exists) tx.update(kitchenRef, { status, updatedAt: FieldValue.serverTimestamp() });
    if (assignedSnapshot.exists) tx.update(assignedRef, { status, updatedAt: FieldValue.serverTimestamp() });
    useAudit(tx, actor, "order.status_changed", "order", orderId, { ticketId: order.ticketId, previousStatus: order.status, status });
  });
  return { ok: true };
});

export const createCategory = onCall(CALL_OPTIONS, async (request) => {
  const actor = await requireStaff(request);
  const { name } = zodInput(z.object({ name: z.string().trim().min(2).max(80) }), request.data);
  const categoryRef = restaurant(actor).collection("categories").doc();
  await db.runTransaction(async (tx) => {
    const existing = await tx.get(restaurant(actor).collection("categories").where("nameKey", "==", name.toLocaleLowerCase("en-US")).limit(1));
    if (!existing.empty) throw new HttpsError("already-exists", "That category already exists.");
    tx.create(categoryRef, { name, nameKey: name.toLocaleLowerCase("en-US"), isActive: true, sortOrder: Date.now(), createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    useAudit(tx, actor, "menu.category_created", "category", categoryRef.id, { name });
  });
  return { id: categoryRef.id };
});

export const saveMenuItem = onCall(CALL_OPTIONS, async (request) => {
  const actor = await requireStaff(request);
  const input = zodInput(menuSaveSchema, request.data);
  const restaurantRef = restaurant(actor);
  const categoryRef = restaurantRef.collection("categories").doc(input.categoryId);
  const itemRef = input.itemId ? restaurantRef.collection("menuItems").doc(input.itemId) : restaurantRef.collection("menuItems").doc();
  if (input.imageUrl) {
    try { if (new URL(input.imageUrl).protocol !== "https:") invalid("Dish image URL must use HTTPS."); }
    catch { invalid("Dish image URL must be a valid HTTPS URL."); }
  }
  await db.runTransaction(async (tx) => {
    const [categorySnapshot, existingItem] = await Promise.all([tx.get(categoryRef), tx.get(itemRef)]);
    if (!categorySnapshot.exists || categorySnapshot.data()?.isActive !== true) throw new HttpsError("failed-precondition", "Choose an active menu category.");
    if (input.itemId && !existingItem.exists) throw new HttpsError("not-found", "Menu item not found.");
    const existing = existingItem.data();
    tx.set(itemRef, {
      name: input.name, description: input.description, categoryId: input.categoryId, pricePaise: input.pricePaise,
      dietaryType: input.dietaryType, imageUrl: input.imageUrl, variants: input.variants, addOns: input.addOns,
      variantRequired: input.variants.length > 0, isActive: existing?.isActive ?? true, isAvailable: existing?.isAvailable ?? true,
      sortOrder: existing?.sortOrder ?? Date.now(), updatedAt: FieldValue.serverTimestamp(), ...(existing ? {} : { createdAt: FieldValue.serverTimestamp() }),
    }, { merge: true });
    useAudit(tx, actor, input.itemId ? "menu.item_updated" : "menu.item_created", "menuItem", itemRef.id, { name: input.name, pricePaise: input.pricePaise });
  });
  return { id: itemRef.id };
});

export const setMenuAvailability = onCall(CALL_OPTIONS, async (request) => {
  const actor = await requireStaff(request);
  const { itemId, isAvailable } = zodInput(z.object({ itemId: z.string().min(1).max(80), isAvailable: z.boolean() }), request.data);
  const itemRef = restaurant(actor).collection("menuItems").doc(itemId);
  await db.runTransaction(async (tx) => {
    const item = await tx.get(itemRef);
    if (!item.exists) throw new HttpsError("not-found", "Menu item not found.");
    tx.update(itemRef, { isAvailable, updatedAt: FieldValue.serverTimestamp() });
    useAudit(tx, actor, "menu.availability_changed", "menuItem", itemId, { isAvailable });
  });
  return { ok: true };
});

export const getRestaurantSettings = onCall(CALL_OPTIONS, async (request) => {
  const actor = await requireStaff(request);
  const profile = await restaurant(actor).get();
  if (!profile.exists) throw new HttpsError("failed-precondition", "Create a restaurant profile before configuring settings.");
  const data = profile.data()!;
  return { name: String(data.name ?? ""), taxRateBps: Number(data.taxRateBps ?? 0), serviceFeePaise: Number(data.serviceFeePaise ?? 0), isAcceptingOrders: data.isAcceptingOrders === true };
});

export const saveRestaurantSettings = onCall(CALL_OPTIONS, async (request) => {
  const actor = await requireStaff(request, ["owner"]);
  const settings = zodInput(z.object({ name: z.string().trim().min(2).max(120), taxRateBps: z.number().int().min(0).max(10_000), serviceFeePaise: z.number().int().min(0).max(100_000_000), isAcceptingOrders: z.boolean() }), request.data);
  await db.runTransaction(async (tx) => {
    const profile = await tx.get(restaurant(actor));
    if (!profile.exists) throw new HttpsError("not-found", "Restaurant profile not found.");
    tx.update(restaurant(actor), { ...settings, updatedAt: FieldValue.serverTimestamp() });
    useAudit(tx, actor, "restaurant.settings_updated", "restaurant", actor.restaurantId, { name: settings.name, isAcceptingOrders: settings.isAcceptingOrders });
  });
  return { ok: true };
});

export const listStaff = onCall(CALL_OPTIONS, async (request) => {
  const actor = await requireStaff(request, ["owner"]);
  const snapshot = await restaurant(actor).collection("staff").orderBy("email").get();
  return { staff: snapshot.docs.map((doc) => ({ uid: doc.id, email: doc.data().email ?? "", displayName: doc.data().displayName ?? "", role: doc.data().role, isActive: doc.data().isActive === true })) };
});

export const assignWaiterToOrder = onCall(CALL_OPTIONS, async (request) => {
  const actor = await requireStaff(request, ["owner"]);
  const { orderId, staffUid } = zodInput(z.object({ orderId: z.string().min(1).max(80), staffUid: z.string().min(1).max(128).nullable() }), request.data);
  const orderRef = restaurant(actor).collection("orders").doc(orderId);
  const staffRef = staffUid ? restaurant(actor).collection("staff").doc(staffUid) : null;
  const assignedRef = restaurant(actor).collection("assignedOrders").doc(orderId);
  await db.runTransaction(async (tx) => {
    const [orderSnapshot, assignedSnapshot] = await Promise.all([tx.get(orderRef), tx.get(assignedRef)]);
    const staffSnapshot = staffRef ? await tx.get(staffRef) : null;
    if (!orderSnapshot.exists) throw new HttpsError("not-found", "Order not found.");
    const order = orderSnapshot.data()!;
    if (["served", "cancelled"].includes(String(order.status))) throw new HttpsError("failed-precondition", "Only open orders can be assigned.");
    if (staffRef && (!staffSnapshot?.exists || staffSnapshot.data()?.isActive !== true || staffSnapshot.data()?.role !== "waiter")) {
      throw new HttpsError("failed-precondition", "Choose an active service staff account.");
    }
    tx.update(orderRef, { assignedStaffUid: staffUid, assignedAt: staffUid ? FieldValue.serverTimestamp() : null, assignedBy: actor.uid, updatedAt: FieldValue.serverTimestamp() });
    if (!staffUid) {
      if (assignedSnapshot.exists) tx.delete(assignedRef);
    } else {
      const items = (Array.isArray(order.items) ? order.items : []).map((item: Record<string, unknown>) => ({
        name: String(item.name ?? ""), quantity: Number(item.quantity ?? 0),
        ...(Array.isArray(item.selections) ? { selections: item.selections.filter((value): value is string => typeof value === "string") } : {}),
        ...(typeof item.specialInstructions === "string" && item.specialInstructions ? { specialInstructions: item.specialInstructions } : {}),
      }));
      tx.set(assignedRef, {
        ticketId: String(order.ticketId), tableNumberSnapshot: String(order.tableNumberSnapshot), items,
        status: String(order.status), estimatedMinutes: typeof order.estimatedMinutes === "number" ? order.estimatedMinutes : null,
        expectedReadyAt: order.expectedReadyAt ?? null, assignedStaffUid: staffUid,
        createdAt: order.createdAt ?? FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      });
    }
    useAudit(tx, actor, staffUid ? "order.waiter_assigned" : "order.waiter_unassigned", "order", orderId, { ticketId: order.ticketId, staffUid });
  });
  return { ok: true };
});

export const setStaffRole = onCall(CALL_OPTIONS, async (request) => {
  const actor = await requireStaff(request, ["owner"]);
  const { email, role, isActive } = zodInput(z.object({ email: z.string().trim().email().max(254), role: z.enum(["manager", "kitchen", "waiter"]), isActive: z.boolean().default(true) }), request.data);
  let member;
  try { member = await auth.getUserByEmail(email); }
  catch { throw new HttpsError("not-found", "Create this person’s Firebase Authentication account before assigning a role."); }
  if (!member.emailVerified) throw new HttpsError("failed-precondition", "This person must verify their email address before they can be assigned to the restaurant.");
  if (member.disabled && isActive) throw new HttpsError("failed-precondition", "This Firebase Authentication account is disabled.");
  if (member.uid === actor.uid && isActive === false) throw new HttpsError("failed-precondition", "You cannot deactivate your own owner account here.");
  const staffRef = restaurant(actor).collection("staff").doc(member.uid);
  const membershipRef = db.doc(`users/${member.uid}/memberships/${actor.restaurantId}`);
  const restaurantSnapshot = await restaurant(actor).get();
  const existing = await staffRef.get();
  if (existing.exists && existing.data()?.role === "owner") throw new HttpsError("failed-precondition", "Owner accounts cannot be changed through the staff role form.");
  await db.runTransaction(async (tx) => {
    const [staffSnapshot, membershipSnapshot] = await Promise.all([tx.get(staffRef), tx.get(membershipRef)]);
    const now = FieldValue.serverTimestamp();
    tx.set(staffRef, { uid: member.uid, email: email.toLowerCase(), displayName: member.displayName ?? "", role, isActive, updatedAt: now, ...(staffSnapshot.exists ? {} : { createdAt: now }) }, { merge: true });
    tx.set(membershipRef, { shopId: actor.restaurantId, shopName: restaurantSnapshot.data()?.name ?? "Restaurant", role, isActive, updatedAt: now, ...(membershipSnapshot.exists ? {} : { createdAt: now }) }, { merge: true });
    tx.create(auditRef(actor), auditRecord(actor, "staff.role_changed", "staff", member.uid, { email, role, isActive }));
  });
  return { ok: true };
});
