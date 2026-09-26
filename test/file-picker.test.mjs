import assert from "node:assert/strict";
import { test } from "node:test";
import { pickLocalPath, pickerCommands } from "../src/file-picker.mjs";

test("native picker uses a system dialog without shell interpolation", async () => {
  assert.equal(pickerCommands("darwin", "directory")[0].command, "osascript");
  assert.equal(pickerCommands("win32", "file")[0].command, "powershell.exe");
  assert.equal(pickerCommands("linux", "directory")[0].command, "zenity");
  assert.throws(() => pickerCommands("darwin", "other"));
  const calls = [];
  const selected = await pickLocalPath(
    "directory",
    "linux",
    async (command, args) => {
      calls.push([command, args]);
      if (command === "zenity")
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return { stdout: "/tmp/shared\n" };
    },
  );
  assert.equal(selected, "/tmp/shared");
  assert.deepEqual(
    calls.map(([command]) => command),
    ["zenity", "kdialog"],
  );
});
