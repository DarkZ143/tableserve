import { createHash, randomBytes } from "node:crypto";

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function newQrToken(): string {
  return randomBytes(32).toString("base64url");
}

export function newTicketId(): string {
  return `TS-${randomBytes(20).toString("hex").toUpperCase()}`;
}

export function normalizeTableNumber(value: string): string {
  return value.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

export function paiseFromRupees(value: number): number {
  return Math.round(value * 100);
}

export function calculateOrderAmounts(subtotalPaise: number, taxRateBps: number, serviceFeePaise: number) {
  const taxPaise = Math.round(subtotalPaise * taxRateBps / 10_000);
  return { subtotalPaise, taxPaise, serviceFeePaise, totalAmountPaise: subtotalPaise + taxPaise + serviceFeePaise };
}

export function isValidPhone(value: string): boolean {
  return /^\+?[0-9()\-\s]{8,20}$/.test(value.trim());
}

export function transitionAllowed(current: string, next: string): boolean {
  const transitions: Record<string, string[]> = {
    queued: ["accepted", "cancelled"],
    accepted: ["preparing", "cancelled"],
    preparing: ["ready"],
    ready: ["served"],
    served: [],
    cancelled: [],
  };
  return transitions[current]?.includes(next) ?? false;
}

export function isBillableOrderTransition(current: string, next: string): boolean {
  return current === "queued" && next === "accepted";
}

export function isEligibleUsageReversal(current: string, next: string): boolean {
  return current === "accepted" && next === "cancelled";
}

export function isWithinOrderQuota(limit: number | null, currentUsage: number): boolean {
  return limit === null || currentUsage < limit;
}

export function canAcceptRestaurantOrders(input: {
  restaurantOpen: boolean;
  platformStatus: string;
  subscriptionStatus: string;
  periodEndMs: number | null;
  graceEndMs?: number | null;
  currentUsage: number;
  orderLimit: number | null;
  nowMs: number;
}): boolean {
  const billingWindowOpen = input.subscriptionStatus === "active"
    ? input.periodEndMs !== null && input.periodEndMs > input.nowMs
    : input.subscriptionStatus === "grace_period"
      ? input.graceEndMs !== null && input.graceEndMs !== undefined && input.graceEndMs > input.nowMs
      : false;
  return input.restaurantOpen
    && input.platformStatus !== "suspended"
    && billingWindowOpen
    && isWithinOrderQuota(input.orderLimit, input.currentUsage);
}

export function qrShopMatchesRoute(routeShopId: string, mappedShopId: string): boolean {
  return routeShopId.length > 0 && routeShopId === mappedShopId;
}
