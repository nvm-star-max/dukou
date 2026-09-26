import assert from "node:assert/strict";
import { test } from "node:test";
import { ReplayWindow } from "../src/replay-window.mjs";

test("encrypted messages are accepted once without trusting device clocks", () => {
  const window = new ReplayWindow(2, 100);
  const one = Buffer.alloc(12, 1).toString("base64");
  const two = Buffer.alloc(12, 2).toString("base64");
  assert.equal(window.accept("a", one, 1000), true);
  assert.equal(window.accept("a", one, 1001), false);
  assert.equal(window.accept("b", one, 1001), true);
  assert.equal(window.accept("a", two, 1002), true);
  assert.equal(window.seen.size, 2);
  assert.equal(window.accept("a", two, 1003), false);
  assert.equal(window.accept("b", one, 1102), true);
  assert.equal(window.accept("a", two, 1102), true);
  assert.equal(window.accept("a", `${two} `, 1103), false);
  assert.equal(window.accept("a", "short", 1103), false);
});
