import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parsers } from "prettier/plugins/babel";

const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const hasHan = /\p{Script=Han}/u;

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(filename) : [filename];
  });
}

test("default README is English and language guides have valid local links", () => {
  const main = fs.readFileSync(path.join(project, "README.md"), "utf8");
  assert.match(main, /^# Dukou\r?\n/);
  assert.match(main, /\]\(README\.zh-CN\.md\)/);
  for (const heading of main.match(/^#{1,6} .+$/gm) || [])
    assert.equal(
      hasHan.test(heading),
      false,
      "Default headings must be English",
    );
  for (const file of ["README.md", "README.en.md", "README.zh-CN.md"])
    for (const match of fs
      .readFileSync(path.join(project, file), "utf8")
      .matchAll(/\]\(([^():\s]+\.md)(?:#[^)]*)?\)/g))
      assert.ok(
        fs.existsSync(path.join(project, match[1])),
        `${file}: ${match[1]}`,
      );
});

test("source comments are English while localization strings remain permitted", () => {
  const files = ["src", "test", "shared-ui", "web", "web-direct"].flatMap(
    (directory) => sourceFiles(path.join(project, directory)),
  );
  for (const filename of files) {
    const content = fs.readFileSync(filename, "utf8");
    let comments = [];
    if (/\.m?js$/.test(filename))
      comments = (parsers.babel.parse(content).comments || []).map(
        (comment) => comment.value,
      );
    else if (filename.endsWith(".html"))
      comments = content.match(/<!--[\s\S]*?-->/g) || [];
    else if (filename.endsWith(".css"))
      comments = content.match(/\/\*[\s\S]*?\*\//g) || [];
    for (const comment of comments)
      assert.equal(
        hasHan.test(comment),
        false,
        path.relative(project, filename),
      );
  }
  for (const filename of [
    "Dockerfile",
    "Caddyfile",
    "Caddyfile.direct",
    "compose.yaml",
    ".github/workflows/ci.yml",
  ])
    for (const line of fs
      .readFileSync(path.join(project, filename), "utf8")
      .split("\n"))
      if (/^\s*#/.test(line)) assert.equal(hasHan.test(line), false, filename);
});
