import test from "node:test";
import assert from "node:assert/strict";
import { tablePathFromQr } from "../../lib/qr.ts";

const token = "A".repeat(43);

test("camera scanner resolves restaurant-scoped table QR codes", () => {
  assert.equal(tablePathFromQr(`https://tableserve.example/t/shop_123/${token}`, "https://tableserve.example"), `/t/shop_123/${token}`);
});

test("camera scanner keeps legacy table QR links working", () => {
  assert.equal(tablePathFromQr(`/t/${token}`, "https://tableserve.example"), `/t/${token}`);
});

test("camera scanner rejects other hosts, query strings, hashes and malformed tokens", () => {
  assert.equal(tablePathFromQr(`https://attacker.example/t/shop_123/${token}`, "https://tableserve.example"), null);
  assert.equal(tablePathFromQr(`/t/shop_123/${token}?redirect=https://attacker.example`, "https://tableserve.example"), null);
  assert.equal(tablePathFromQr(`/t/shop_123/${token}#fragment`, "https://tableserve.example"), null);
  assert.equal(tablePathFromQr("/t/shop_123/not-a-token", "https://tableserve.example"), null);
});
