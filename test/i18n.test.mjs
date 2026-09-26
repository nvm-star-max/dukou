import assert from "node:assert/strict";
import { test } from "node:test";
import { localize } from "../shared-ui/i18n.js";

test("English is the default translation for main controls", () => {
  assert.equal(localize("设备权限"), "Device permissions");
  assert.equal(localize("证书 SHA-256"), "Certificate SHA-256");
  assert.equal(localize("选择文件夹"), "Choose folder");
});
