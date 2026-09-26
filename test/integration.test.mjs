import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import crypto from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { id, seal } from "../src/common.mjs";

const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function start(script, env) {
  const child = spawn(process.execPath, [path.join(project, "src", script)], {
    cwd: project,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.output = "";
  child.stdout.on("data", (data) => (child.output += data.toString()));
  child.stderr.on("data", (data) => (child.output += data.toString()));
  return child;
}
async function request(base, endpoint, method = "GET", body) {
  const response = await fetch(base + endpoint, {
    method,
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${endpoint}: ${data.error}`);
  return data;
}
async function until(action, condition, timeout = 15_000) {
  const stop = Date.now() + timeout;
  let result;
  let lastError;
  do {
    try {
      result = await action();
      if (condition(result)) return result;
    } catch (error) {
      lastError = error;
    }
    await pause(100);
  } while (Date.now() < stop);
  throw lastError || new Error(`Timed out: ${JSON.stringify(result)}`);
}

test(
  "two devices can push and pull over the relay with explicit permissions",
  { timeout: 60_000 },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-transfer-flow-"));
    const serverPort = await freePort(),
      aPort = await freePort(),
      apPort = await freePort(),
      bPort = await freePort(),
      bpPort = await freePort();
    const central = `http://127.0.0.1:${serverPort}`;
    const a = `http://127.0.0.1:${aPort}`,
      b = `http://127.0.0.1:${bPort}`;
    const children = [
      start("server.mjs", {
        PORT: String(serverPort),
        TRANSFER_SERVER_DATA: path.join(root, "server"),
      }),
      start("client.mjs", {
        CLIENT_PORT: String(aPort),
        PEER_PORT: String(apPort),
        TRANSFER_CLIENT_DATA: path.join(root, "a"),
        TRANSFER_CHUNK_DELAY_MS: "15",
      }),
      start("client.mjs", {
        CLIENT_PORT: String(bPort),
        PEER_PORT: String(bpPort),
        TRANSFER_CLIENT_DATA: path.join(root, "b"),
        DISABLE_LAN_DIRECT: "1",
      }),
    ];
    try {
      await until(
        () => request(central, "/health"),
        (x) => x.ok,
      );
      await until(
        () => request(a, "/api/status"),
        (x) => x.configured === false,
      );
      assert.equal((await fetch(`${a}/api/local-files`)).status, 400);
      await until(
        () => request(b, "/api/status"),
        (x) => x.configured === false,
      );
      const account = {
        serverUrl: central,
        username: "demo_user",
        password: "correct-horse-12345",
      };
      await request(a, "/api/setup", "POST", {
        ...account,
        name: "Alpha",
        createAccount: true,
      });
      const localBrowser = await request(a, "/api/local-files");
      assert.equal(localBrowser.path, os.homedir());
      assert.ok(Array.isArray(localBrowser.entries));
      await request(b, "/api/setup", "POST", {
        ...account,
        name: "Beta",
        createAccount: false,
      });
      const aId = (await request(a, "/api/status")).deviceId;
      const bId = (await request(b, "/api/status")).deviceId;
      const ui = await fetch(a);
      assert.equal(ui.headers.get("x-frame-options"), "DENY");
      assert.match(
        ui.headers.get("content-security-policy"),
        /frame-ancestors 'none'/,
      );
      assert.equal(
        (
          await fetch(`${a}/api/share`, {
            method: "POST",
            headers: { origin: b },
            body: "{}",
          })
        ).status,
        403,
      );
      const aConfig = JSON.parse(
        fs.readFileSync(path.join(root, "a", "config.json"), "utf8"),
      );
      const bConfig = JSON.parse(
        fs.readFileSync(path.join(root, "b", "config.json"), "utf8"),
      );
      const inject = (message) =>
        fetch(`http://127.0.0.1:${apPort}/peer`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            seal(
              message,
              bId,
              aId,
              bConfig.keys.encryptionPrivate,
              aConfig.keys.encryptionPublic,
            ),
          ),
        });
      const privateShare = await fetch(`${a}/api/share`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ directory: path.join(root, "a") }),
      });
      assert.equal(privateShare.status, 400);
      await until(
        () => request(a, "/api/devices"),
        (result) =>
          result.devices.some((device) => device.id === bId && device.online),
      );
      await until(
        () => request(b, "/api/devices"),
        (result) =>
          result.devices.some((device) => device.id === aId && device.online),
      );
      const shared = path.join(root, "shared");
      fs.mkdirSync(shared);
      fs.writeFileSync(path.join(shared, "note.txt"), "remote pull works");
      await request(a, "/api/share", "POST", { directory: shared });
      const denied = await fetch(`${b}/api/files?device=${aId}&path=`);
      assert.equal(denied.status, 400);
      await request(a, "/api/permission", "POST", {
        deviceId: bId,
        browse: true,
        download: true,
        upload: true,
      });
      const list = await request(b, `/api/files?device=${aId}&path=`);
      assert.equal(
        list.files.find((file) => file.name === "note.txt")?.size,
        17,
      );
      const search = await request(b, `/api/search?device=${aId}&q=note`);
      assert.equal(search.files[0]?.path, "note.txt");
      await request(b, "/api/pull", "POST", {
        deviceId: aId,
        remotePath: "note.txt",
      });
      await until(
        () => request(b, "/api/transfers"),
        (result) => result.transfers[0]?.status === "complete",
      );
      assert.equal(
        fs.readFileSync(path.join(root, "b", "downloads", "note.txt"), "utf8"),
        "remote pull works",
      );

      const reverseShared = path.join(root, "reverse-shared");
      fs.mkdirSync(reverseShared);
      fs.writeFileSync(
        path.join(reverseShared, "from-beta.txt"),
        "beta can share too",
      );
      await request(b, "/api/share", "POST", { directory: reverseShared });
      await request(b, "/api/permission", "POST", {
        deviceId: aId,
        browse: true,
        download: true,
        upload: true,
      });
      const reverseList = await request(a, `/api/files?device=${bId}&path=`);
      assert.equal(reverseList.files[0].name, "from-beta.txt");
      await request(a, "/api/pull", "POST", {
        deviceId: bId,
        remotePath: "from-beta.txt",
      });
      await until(
        () => request(a, "/api/transfers"),
        (result) =>
          result.transfers.some(
            (job) => job.name === "from-beta.txt" && job.status === "complete",
          ),
      );
      assert.equal(
        fs.readFileSync(
          path.join(root, "a", "downloads", "from-beta.txt"),
          "utf8",
        ),
        "beta can share too",
      );

      const enrollmentKey = (
        await request(a, "/api/enrollment-key", "POST", {})
      ).enrollmentKey;
      const dPort = await freePort(),
        dpPort = await freePort();
      const d = `http://127.0.0.1:${dPort}`;
      children.push(
        start("client.mjs", {
          CLIENT_PORT: String(dPort),
          PEER_PORT: String(dpPort),
          TRANSFER_CLIENT_DATA: path.join(root, "d"),
        }),
      );
      await until(
        () => request(d, "/api/status"),
        (result) => !result.configured,
      );
      await request(d, "/api/setup", "POST", {
        serverUrl: central,
        name: "Delta",
        enrollmentKey,
      });
      const dId = (await request(d, "/api/status")).deviceId;
      await until(
        () => request(a, "/api/devices"),
        (result) => result.devices.some((device) => device.id === dId),
      );
      const reused = await fetch(`${central}/api/enroll`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enrollmentKey, name: "Duplicate" }),
      });
      assert.equal(reused.status, 401);

      const response = await fetch(`${b}/api/send?device=${aId}`, {
        method: "POST",
        headers: { "x-file-name": "push.txt" },
        body: "push works too",
      });
      assert.equal(response.status, 202);
      const incoming = await until(
        () => request(a, "/api/transfers"),
        (result) =>
          result.transfers.some(
            (job) => job.name === "push.txt" && job.status === "pending",
          ),
      );
      await request(a, "/api/decide", "POST", {
        transferId: incoming.transfers.find((job) => job.name === "push.txt")
          .id,
        accept: true,
      });
      await until(
        () => request(a, "/api/transfers"),
        (result) =>
          result.transfers.some(
            (job) => job.name === "push.txt" && job.status === "complete",
          ),
      );
      assert.equal(
        fs.readFileSync(path.join(root, "a", "downloads", "push.txt"), "utf8"),
        "push works too",
      );

      const oldPull = (await request(a, "/api/transfers")).transfers.find(
        (job) => job.direction === "out" && job.name === "note.txt",
      );
      await request(a, "/api/permission", "POST", {
        deviceId: bId,
        browse: true,
        download: false,
        upload: true,
      });
      await inject({ kind: "accept", transferId: oldPull.id, offset: 0 });
      await pause(150);
      assert.equal(
        (await request(a, "/api/transfers")).transfers.find(
          (job) => job.id === oldPull.id,
        ).status,
        "complete",
      );
      await request(a, "/api/permission", "POST", {
        deviceId: bId,
        browse: true,
        download: true,
        upload: true,
      });
      await inject({
        kind: "offer",
        transferId: "../outside",
        name: "innocent.txt",
        size: 0,
      });
      await inject({
        kind: "offer",
        transferId: id(),
        name: "x".repeat(1000),
        size: 0,
      });
      await pause(150);
      assert.equal(
        (await request(a, "/api/transfers")).transfers.some(
          (job) => job.id === "../outside",
        ),
        false,
      );
      assert.equal(fs.existsSync(path.join(root, "a", "outside.part")), false);

      const hostileId = id();
      await inject({
        kind: "offer",
        transferId: hostileId,
        name: "ordered.bin",
        size: 2,
      });
      await until(
        () => request(a, "/api/transfers"),
        (result) => result.transfers.some((job) => job.id === hostileId),
      );
      await request(a, "/api/decide", "POST", {
        transferId: hostileId,
        accept: true,
      });
      await Promise.all([
        inject({
          kind: "chunk",
          transferId: hostileId,
          offset: 0,
          data: "QQ==",
        }),
        inject({
          kind: "chunk",
          transferId: hostileId,
          offset: 0,
          data: "QQ==",
        }),
      ]);
      await pause(150);
      assert.equal(
        (await request(a, "/api/transfers")).transfers.find(
          (job) => job.id === hostileId,
        ).transferred,
        1,
      );
      await inject({
        kind: "chunk",
        transferId: hostileId,
        offset: 1,
        data: "Qg==",
      });
      await inject({
        kind: "finish",
        transferId: hostileId,
        sha256: crypto.createHash("sha256").update("AB").digest("hex"),
      });
      await until(
        () => request(a, "/api/transfers"),
        (result) =>
          result.transfers.find((job) => job.id === hostileId)?.status ===
          "complete",
      );
      assert.equal(
        fs.readFileSync(
          path.join(root, "a", "downloads", "ordered.bin"),
          "utf8",
        ),
        "AB",
      );

      const large = Buffer.alloc(8 * 1024 * 1024, 0x5a);
      fs.writeFileSync(path.join(shared, "large.bin"), large);
      await request(b, "/api/pull", "POST", {
        deviceId: aId,
        remotePath: "large.bin",
      });
      await until(
        () => request(b, "/api/transfers"),
        (result) => {
          const transfer = result.transfers.find(
            (job) => job.name === "large.bin",
          );
          return (
            transfer &&
            transfer.transferred > 0 &&
            transfer.transferred < transfer.size
          );
        },
      );
      children[2].kill();
      await new Promise((resolve) => children[2].once("exit", resolve));
      children[2] = start("client.mjs", {
        CLIENT_PORT: String(bPort),
        PEER_PORT: String(bpPort),
        TRANSFER_CLIENT_DATA: path.join(root, "b"),
        DISABLE_LAN_DIRECT: "1",
      });
      await until(
        () => request(b, "/api/transfers"),
        (result) =>
          result.transfers.some(
            (job) => job.name === "large.bin" && job.status === "complete",
          ),
        30_000,
      );
      assert.deepEqual(
        fs.readFileSync(path.join(root, "b", "downloads", "large.bin")),
        large,
      );

      const cPort = await freePort(),
        cpPort = await freePort();
      const c = `http://127.0.0.1:${cPort}`;
      children.push(
        start("client.mjs", {
          CLIENT_PORT: String(cPort),
          PEER_PORT: String(cpPort),
          TRANSFER_CLIENT_DATA: path.join(root, "c"),
        }),
      );
      await until(
        () => request(c, "/api/status"),
        (result) => !result.configured,
      );
      await request(c, "/api/setup", "POST", {
        serverUrl: central,
        username: "other_user",
        password: "another-good-password",
        name: "Gamma",
        createAccount: true,
      });
      const cId = (await request(c, "/api/status")).deviceId;
      assert.equal((await request(c, "/api/devices")).devices.length, 0);
      const { code } = await request(a, "/api/invite", "POST", {});
      await request(c, "/api/join", "POST", { code });
      assert.ok(
        (await request(c, "/api/devices")).devices.some(
          (device) => device.id === aId && !device.sameAccount,
        ),
      );
      await request(c, "/api/unpair", "POST", { deviceId: aId });
      assert.equal((await request(c, "/api/devices")).devices.length, 0);
      await request(a, "/api/revoke", "POST", { deviceId: bId });
      assert.equal(
        (await request(a, "/api/devices")).devices.some(
          (device) => device.id === bId,
        ),
        false,
      );
    } catch (error) {
      error.message += `\n${children.map((child, index) => `PROCESS ${index}: ${child.output}`).join("\n")}`;
      throw error;
    } finally {
      for (const child of children) child.kill();
      await pause(150);
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
