import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/cli.mjs",
);

test("CLI explains roles and rejects invalid server ports", () => {
  const help = spawnSync(process.execPath, [cli, "--help"], {
    encoding: "utf8",
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /relay.*peer/s);
  assert.match(help.stdout, /Dukou CLI/);
  assert.doesNotMatch(help.stdout, /[\u4e00-\u9fff]/);
  const chinese = spawnSync(process.execPath, [cli, "help", "--lang", "zh"], {
    encoding: "utf8",
  });
  assert.equal(chinese.status, 0);
  assert.match(chinese.stdout, /渡口 CLI/);
  const invalid = spawnSync(
    process.execPath,
    [cli, "relay", "--port", "70000"],
    { encoding: "utf8" },
  );
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /1-65535/);
});
