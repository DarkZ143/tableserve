import test from "node:test";
import assert from "node:assert/strict";
import { calculateOrderAmounts, canAcceptRestaurantOrders, isBillableOrderTransition, isEligibleUsageReversal, isValidPhone, isWithinOrderQuota, newQrToken, newTicketId, normalizeTableNumber, paiseFromRupees, qrShopMatchesRoute, sha256, transitionAllowed } from "../src/domain.ts";

test("QR tokens are high entropy URL-safe values and hash deterministically", () => {
  const token = newQrToken();
  assert.equal(token.length, 43);
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  assert.equal(sha256(token), sha256(token));
  assert.notEqual(sha256(token), sha256(newQrToken()));
});

test("ticket IDs are separate, high-entropy public references", () => {
  const ticket = newTicketId();
  assert.match(ticket, /^TS-[A-F0-9]{40}$/);
  assert.notEqual(ticket, newTicketId());
});

test("table uniqueness uses normalized table numbers", () => {
  assert.equal(normalizeTableNumber(" 07 "), normalizeTableNumber("07"));
  assert.equal(normalizeTableNumber("A-1"), normalizeTableNumber("a-1"));
  assert.notEqual(normalizeTableNumber("07"), normalizeTableNumber("7"));
});

test("all order amounts use integer paise and server rate arithmetic", () => {
  assert.equal(paiseFromRupees(123.45), 12345);
  assert.deepEqual(calculateOrderAmounts(10001, 500, 300), {
    subtotalPaise: 10001,
    taxPaise: 500,
    serviceFeePaise: 300,
    totalAmountPaise: 10801,
  });
});

test("phone validation accepts international input and rejects malformed input", () => {
  assert.equal(isValidPhone("+91 98765 43210"), true);
  assert.equal(isValidPhone("abc123"), false);
});

test("order status changes follow the restaurant workflow", () => {
  assert.equal(transitionAllowed("queued", "accepted"), true);
  assert.equal(transitionAllowed("preparing", "ready"), true);
  assert.equal(transitionAllowed("ready", "served"), true);
  assert.equal(transitionAllowed("served", "preparing"), false);
  assert.equal(transitionAllowed("queued", "served"), false);
});

test("only first acceptance is billable and eligible early cancellation reverses usage", () => {
  assert.equal(isBillableOrderTransition("queued", "accepted"), true);
  assert.equal(isBillableOrderTransition("accepted", "preparing"), false);
  assert.equal(isEligibleUsageReversal("accepted", "cancelled"), true);
  assert.equal(isEligibleUsageReversal("preparing", "cancelled"), false);
});

test("plan quota is total capacity and unlimited plans have no fixed cap", () => {
  assert.equal(isWithinOrderQuota(1500, 1499), true);
  assert.equal(isWithinOrderQuota(1500, 1500), false);
  assert.equal(isWithinOrderQuota(4000, 1500), true);
  assert.equal(isWithinOrderQuota(null, 100000), true);
});

test("QR route shop must match the server token mapping", () => {
  assert.equal(qrShopMatchesRoute("shop-a", "shop-a"), true);
  assert.equal(qrShopMatchesRoute("shop-b", "shop-a"), false);
  assert.equal(qrShopMatchesRoute("", "shop-a"), false);
});

test("new food orders require an open restaurant, active cycle and remaining quota", () => {
  const base = { restaurantOpen: true, platformStatus: "active", subscriptionStatus: "active", periodEndMs: 2_000, currentUsage: 99, orderLimit: 100, nowMs: 1_000 };
  assert.equal(canAcceptRestaurantOrders(base), true);
  assert.equal(canAcceptRestaurantOrders({ ...base, currentUsage: 100 }), false);
  assert.equal(canAcceptRestaurantOrders({ ...base, platformStatus: "suspended" }), false);
  assert.equal(canAcceptRestaurantOrders({ ...base, subscriptionStatus: "pending_payment" }), false);
  assert.equal(canAcceptRestaurantOrders({ ...base, periodEndMs: 999 }), false);
  assert.equal(canAcceptRestaurantOrders({ ...base, orderLimit: null, currentUsage: 1_000_000 }), true);
});

test("past-due subscriptions accept orders only during the explicit grace window", () => {
  const base = { restaurantOpen: true, platformStatus: "active", subscriptionStatus: "grace_period", periodEndMs: 900, graceEndMs: 2_000, currentUsage: 2, orderLimit: 10, nowMs: 1_000 };
  assert.equal(canAcceptRestaurantOrders(base), true);
  assert.equal(canAcceptRestaurantOrders({ ...base, nowMs: 2_000 }), false);
  assert.equal(canAcceptRestaurantOrders({ ...base, currentUsage: 10 }), false);
  assert.equal(canAcceptRestaurantOrders({ ...base, platformStatus: "suspended" }), false);
});
