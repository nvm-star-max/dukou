import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  containedFile,
  makeKeys,
  open,
  relativePath,
  seal,
  safeName,
} from "../src/common.mjs";

test("only the intended recipient can decrypt a message", () => {
  const alice = makeKeys();
  const bob = makeKeys();
  const stranger = makeKeys();
  const envelope = seal(
    { kind: "sample", value: "private" },
    "alice",
    "bob",
    alice.encryptionPrivate,
    bob.encryptionPublic,
  );
  assert.deepEqual(
    open(envelope, bob.encryptionPrivate, alice.encryptionPublic),
    { kind: "sample", value: "private" },
  );
  assert.throws(() =>
    open(envelope, stranger.encryptionPrivate, alice.encryptionPublic),
  );
  assert.throws(() =>
    open(
      { ...envelope, to: "stranger" },
      bob.encryptionPrivate,
      alice.encryptionPublic,
    ),
  );
  assert.ok(!JSON.stringify(envelope).includes("private"));
  assert.throws(
    () =>
      open(
        { ...envelope, nonce: `${envelope.nonce} ` },
        bob.encryptionPrivate,
        alice.encryptionPublic,
      ),
    /Base64/,
  );
  assert.throws(
    () =>
      open(
        { ...envelope, tag: envelope.tag.replace(/=+$/, "") },
        bob.encryptionPrivate,
        alice.encryptionPublic,
      ),
    /Base64/,
  );
});

test("file metadata is bounded and names work across path separators", () => {
  assert.equal(safeName("C:\\folder\\sample.txt"), "sample.txt");
  assert.equal(safeName("stream:secret"), "stream_secret");
  assert.throws(() => safeName("x".repeat(256)), /255 bytes/);
});

test("shared paths cannot escape through parent segments or symlinks", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-transfer-path-"));
  const shared = path.join(root, "shared");
  fs.mkdirSync(shared);
  const outsideFolder = path.join(root, "outside");
  fs.mkdirSync(outsideFolder);
  const outside = path.join(outsideFolder, "outside.txt");
  fs.writeFileSync(outside, crypto.randomBytes(8));
  try {
    // Directory junctions do not require Windows Developer Mode or admin rights.
    fs.symlinkSync(outsideFolder, path.join(shared, "shortcut"), "junction");
    assert.throws(() => relativePath("../outside.txt"));
    assert.throws(() => relativePath("/etc/passwd"));
    await assert.rejects(
      containedFile(shared, "shortcut/outside.txt", "file"),
      /outside shared directory/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
