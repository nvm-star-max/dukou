import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BoundedQueue,
  reserveJob,
  transferId,
  validateMessage,
} from "../src/transfer-policy.mjs";

test("wire identifiers and metadata cannot become filesystem paths", () => {
  assert.equal(transferId("a".repeat(32)), "a".repeat(32));
  for (const value of [
    "../outside",
    "..\\outside",
    "/tmp/path",
    "A".repeat(32),
    null,
  ])
    assert.throws(() => validateMessage({ kind: "offer", transferId: value }));
  assert.throws(() =>
    validateMessage({
      kind: "pull-request",
      transferId: "a".repeat(32),
      path: "x".repeat(4097),
    }),
  );
});

test("remote pending jobs and retained terminal history have fixed bounds", () => {
  const jobs = Array.from({ length: 16 }, (_, i) => ({
    id: String(i),
    peerId: "a",
    status: "pending",
  }));
  assert.throws(() => reserveJob(jobs, "a"), /Too many/);
  reserveJob(jobs, "b");
  const history = Array.from({ length: 500 }, () => ({
    peerId: "a",
    status: "complete",
  }));
  reserveJob(history, "a");
  assert.equal(history.length, 499);
});

test("bounded async queue serializes state transitions and survives errors", async () => {
  const queue = new BoundedQueue(2);
  let offset = 0;
  const received = [];
  const first = queue.run(async () => {
    const before = offset;
    await new Promise((r) => setTimeout(r, 10));
    offset = before + 1;
    received.push(offset);
  });
  const second = queue.run(async () => {
    offset++;
    received.push(offset);
  });
  await assert.rejects(
    queue.run(() => {}),
    /queue is full/,
  );
  await Promise.all([first, second]);
  assert.deepEqual(received, [1, 2]);
  await assert.rejects(
    queue.run(() => {
      throw new Error("bad");
    }),
    /bad/,
  );
  await queue.run(() => offset++);
  assert.equal(offset, 3);
});
