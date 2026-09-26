import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { localFiles } from "../src/local-files.mjs";

test("local picker lists folders and optional files without exposing private data", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-transfer-picker-"));
  const privateDir = path.join(root, "private");
  fs.mkdirSync(privateDir);
  fs.mkdirSync(path.join(root, "public"));
  fs.writeFileSync(path.join(root, "sample.txt"), "example");
  try {
    const folders = await localFiles(root, { excluded: [privateDir] });
    assert.deepEqual(
      folders.entries.map((item) => item.name),
      ["public"],
    );
    const files = await localFiles(root, {
      kind: "file",
      excluded: [privateDir],
    });
    assert.deepEqual(
      files.entries.map((item) => item.name),
      ["public", "sample.txt"],
    );
    await assert.rejects(
      localFiles(privateDir, { excluded: [privateDir] }),
      /私有数据/,
    );
    await assert.rejects(localFiles("relative/path"), /绝对路径/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
