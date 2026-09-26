import assert from "node:assert/strict";
import { test } from "node:test";
import { pinPeerKeys } from "../src/peer-pins.mjs";

test("device key changes are blocked before updating trusted pins", () => {
  const pins = {};
  const trusted = {
    id: "device-a",
    name: "Alpha",
    signingPublic: "sign-a",
    encryptionPublic: "encrypt-a",
  };
  assert.equal(pinPeerKeys(pins, [trusted]), true);
  assert.equal(pinPeerKeys(pins, [trusted]), false);
  assert.throws(
    () => pinPeerKeys(pins, [{ ...trusted, encryptionPublic: "attacker-key" }]),
    /密钥已变更/,
  );
  assert.deepEqual(pins[trusted.id], {
    signingPublic: "sign-a",
    encryptionPublic: "encrypt-a",
  });
});
