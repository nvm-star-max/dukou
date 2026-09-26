import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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
async function waitFor(base) {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(`${base}/api/status`);
      if (response.ok) return;
    } catch {
      /* Host may still be starting. */
    }
    await pause(50);
  }
  throw new Error("Direct host did not start");
}
async function json(
  base,
  endpoint,
  method = "GET",
  body,
  cookie,
  headers = {},
) {
  const response = await fetch(base + endpoint, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, data: await response.json() };
}
async function requestWithHost(
  port,
  endpoint,
  host,
  cookie,
  extraHeaders = {},
) {
  return new Promise((resolve, reject) => {
    http
      .get(
        {
          hostname: "127.0.0.1",
          port,
          path: endpoint,
          headers: { host, cookie, ...extraHeaders },
        },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () =>
            resolve({
              status: response.statusCode,
              data: JSON.parse(Buffer.concat(chunks).toString()),
            }),
          );
        },
      )
      .on("error", reject);
  });
}

async function tlsStatus(port) {
  return new Promise((resolve, reject) => {
    https
      .get(
        {
          hostname: "127.0.0.1",
          port,
          path: "/api/status",
          rejectUnauthorized: false,
        },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () =>
            resolve({
              headers: response.headers,
              data: JSON.parse(Buffer.concat(chunks).toString()),
            }),
          );
        },
      )
      .on("error", reject);
  });
}

test(
  "HTTPS host also exposes loopback-only HTTP administration",
  { timeout: 30_000 },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-transfer-tls-"));
    const port = await freePort();
    const localPort = await freePort();
    const child = spawn(
      process.execPath,
      [path.join(project, "src/direct-host.mjs")],
      {
        cwd: project,
        env: {
          ...process.env,
          DIRECT_HTTP: "0",
          DIRECT_PORT: String(port),
          DIRECT_LOCAL_PORT: String(localPort),
          DIRECT_DATA: root,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    try {
      const base = `http://127.0.0.1:${localPort}`;
      await waitFor(base);
      const local = await json(base, "/api/status");
      assert.equal(local.data.local, true);
      assert.equal(local.data.protocol, "http");
      assert.equal(
        local.response.headers.get("strict-transport-security"),
        null,
      );
      assert.equal((await tlsStatus(port)).data.protocol, "https");
      assert.ok((await tlsStatus(port)).headers["strict-transport-security"]);
      const setup = await json(base, "/api/setup", "POST", {
        username: "owner",
        password: "a-long-test-password",
      });
      assert.equal(setup.response.status, 201);
      assert.doesNotMatch(setup.response.headers.get("set-cookie"), /; Secure/);
      assert.equal(
        (
          await json(
            base,
            "/api/admin",
            "GET",
            undefined,
            setup.response.headers.get("set-cookie").split(";")[0],
          )
        ).response.status,
        200,
      );
    } finally {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "one host serves authenticated browser downloads and a separate upload inbox",
  { timeout: 30_000 },
  async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "open-transfer-direct-"),
    );
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const child = spawn(
      process.execPath,
      [path.join(project, "src/direct-host.mjs")],
      {
        cwd: project,
        env: {
          ...process.env,
          DIRECT_HTTP: "1",
          DIRECT_PORT: String(port),
          DIRECT_DATA: path.join(root, "host"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (data) => (output += data.toString()));
    child.stderr.on("data", (data) => (output += data.toString()));
    try {
      await waitFor(base);
      const fixture = path.join(root, "shared");
      fs.mkdirSync(fixture);
      fs.writeFileSync(path.join(fixture, "sample.txt"), "hello from host");
      const setup = await json(base, "/api/setup", "POST", {
        username: "owner",
        password: "a-long-test-password",
      });
      assert.equal(setup.response.status, 201);
      const adminCookie = setup.response.headers
        .get("set-cookie")
        .split(";")[0];
      const accessKey = setup.data.accessKey;
      assert.equal(
        (await json(base, "/api/status", "GET", undefined, adminCookie)).data
          .admin,
        true,
      );
      assert.equal(
        (
          await requestWithHost(
            port,
            "/api/status",
            `remote.example:${port}`,
            adminCookie,
          )
        ).data.admin,
        false,
      );
      assert.equal(
        (
          await requestWithHost(
            port,
            "/api/admin",
            `remote.example:${port}`,
            adminCookie,
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await requestWithHost(
            port,
            "/api/admin/local-files",
            `remote.example:${port}`,
            adminCookie,
          )
        ).status,
        403,
      );
      const localFiles = await json(
        base,
        `/api/admin/local-files?path=${encodeURIComponent(fixture)}&kind=file`,
        "GET",
        undefined,
        adminCookie,
      );
      assert.equal(localFiles.response.status, 200);
      assert.equal(localFiles.data.entries[0].name, "sample.txt");
      assert.equal(
        (
          await requestWithHost(
            port,
            "/api/admin",
            `127.0.0.1:${port}`,
            adminCookie,
            { "x-forwarded-for": "203.0.113.9" },
          )
        ).status,
        403,
      );

      const folder = await json(
        base,
        "/api/admin/roots",
        "POST",
        { action: "add", directory: fixture },
        adminCookie,
      );
      assert.equal(folder.response.status, 200);
      const rootId = folder.data.roots[0].id;
      const single = await json(
        base,
        "/api/admin/roots",
        "POST",
        { action: "add", directory: path.join(fixture, "sample.txt") },
        adminCookie,
      );
      assert.equal(single.response.status, 200);
      const singleId = single.data.roots[1].id;
      const login = await json(base, "/api/login", "POST", { accessKey });
      assert.equal(login.response.status, 200);
      const guestCookie = login.response.headers
        .get("set-cookie")
        .split(";")[0];
      assert.equal(
        (await json(base, "/api/admin", "GET", undefined, guestCookie)).response
          .status,
        403,
      );
      assert.equal(
        (
          await json(
            base,
            "/api/admin/local-files",
            "GET",
            undefined,
            guestCookie,
          )
        ).response.status,
        403,
      );
      assert.equal(
        (
          await json(
            base,
            "/api/admin/pick-root",
            "POST",
            { kind: "directory" },
            guestCookie,
          )
        ).response.status,
        403,
      );
      const files = await json(
        base,
        `/api/list?root=${rootId}`,
        "GET",
        undefined,
        guestCookie,
      );
      assert.equal(files.data.files[0].name, "sample.txt");
      const search = await json(
        base,
        `/api/search?root=${rootId}&q=sample`,
        "GET",
        undefined,
        guestCookie,
      );
      assert.equal(search.data.files[0].path, "sample.txt");
      assert.equal(
        (
          await json(
            base,
            `/api/list?root=${rootId}&path=../`,
            "GET",
            undefined,
            guestCookie,
          )
        ).response.status,
        400,
      );
      const download = await fetch(
        `${base}/api/download?root=${rootId}&path=sample.txt`,
        { headers: { cookie: guestCookie, range: "bytes=6-9" } },
      );
      assert.equal(download.status, 206);
      assert.equal(await download.text(), "from");
      const singleFile = await json(
        base,
        `/api/list?root=${singleId}`,
        "GET",
        undefined,
        guestCookie,
      );
      assert.equal(singleFile.data.files[0].name, "sample.txt");
      const singleDownload = await fetch(
        `${base}/api/download?root=${singleId}`,
        { headers: { cookie: guestCookie } },
      );
      assert.equal(await singleDownload.text(), "hello from host");

      assert.equal(
        (
          await json(
            base,
            "/api/admin/roots",
            "POST",
            { action: "add", directory: path.join(root, "host") },
            adminCookie,
          )
        ).response.status,
        403,
      );
      const parent = await json(
        base,
        "/api/admin/roots",
        "POST",
        { action: "add", directory: root },
        adminCookie,
      );
      const parentId = parent.data.roots.at(-1).id;
      const parentFiles = await json(
        base,
        `/api/list?root=${parentId}`,
        "GET",
        undefined,
        guestCookie,
      );
      assert.deepEqual(
        parentFiles.data.files.map((file) => file.name),
        ["shared"],
      );
      assert.equal(
        (
          await json(
            base,
            `/api/list?root=${parentId}&path=host`,
            "GET",
            undefined,
            guestCookie,
          )
        ).response.status,
        403,
      );

      assert.equal(
        (
          await json(
            base,
            "/api/admin/options",
            "POST",
            { allowUpload: true, maxUploadMB: 100 },
            adminCookie,
          )
        ).response.status,
        200,
      );
      const upload = await fetch(`${base}/api/upload?name=sent.txt`, {
        method: "POST",
        headers: { cookie: guestCookie },
        body: "from guest",
      });
      assert.equal(upload.status, 201);
      assert.equal(fs.readdirSync(path.join(root, "host", "inbox")).length, 1);
      assert.equal(
        (
          await json(
            base,
            "/api/admin/mode",
            "POST",
            { mode: "whole" },
            adminCookie,
          )
        ).response.status,
        400,
      );
      assert.equal(
        (
          await json(
            base,
            "/api/admin/mode",
            "POST",
            { mode: "whole", confirmation: "OPEN ALL" },
            adminCookie,
          )
        ).response.status,
        200,
      );
      assert.equal(
        (await json(base, "/api/roots", "GET", undefined, guestCookie)).data
          .mode,
        "whole",
      );
      const rotate = await json(
        base,
        "/api/admin/key",
        "POST",
        {},
        adminCookie,
      );
      assert.equal(rotate.response.status, 200);
      assert.equal(
        (await json(base, "/api/roots", "GET", undefined, guestCookie)).response
          .status,
        401,
      );
      assert.equal(
        (await json(base, "/api/login", "POST", { accessKey })).response.status,
        401,
      );
      assert.equal(
        (
          await json(base, "/api/login", "POST", {
            accessKey: rotate.data.accessKey,
          })
        ).response.status,
        200,
      );
    } catch (error) {
      error.message += `\nHOST OUTPUT:\n${output}`;
      throw error;
    } finally {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
