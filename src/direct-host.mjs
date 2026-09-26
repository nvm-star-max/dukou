import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import selfsigned from "selfsigned";
import { pickLocalPath } from "./file-picker.mjs";
import { localFiles } from "./local-files.mjs";
import {
  bad,
  bodyJson,
  checkPassword,
  containedFile,
  id,
  passwordHash,
  readJson,
  relativePath,
  reply,
  revealFile,
  safeName,
  writeJson,
} from "./common.mjs";

const port = Number(process.env.DIRECT_PORT || 18788);
const localHttp = process.env.DIRECT_HTTP === "1";
const localAdminPort = Number(process.env.DIRECT_LOCAL_PORT || port + 1);
const trustLocalProxy = process.env.DIRECT_TRUST_PROXY === "1";
const bind = localHttp ? "127.0.0.1" : process.env.DIRECT_BIND || "0.0.0.0";
const dataDir = path.resolve(process.env.DIRECT_DATA || ".data/direct-host");
const webDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../web-direct",
);
const sharedUiDir = path.resolve(webDir, "../shared-ui");
const iconsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../node_modules/lucide-static/icons",
);
const configFile = path.join(dataDir, "config.json");
const activityFile = path.join(dataDir, "activity.json");
const inboxDir = path.join(dataDir, "inbox");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(inboxDir, { recursive: true });

const config = readJson(configFile, {
  username: null,
  password: null,
  keyHash: null,
  mode: "folders",
  roots: [],
  allowUpload: false,
  maxUploadMB: 100,
});
const activity = readJson(activityFile, []);
const sessions = new Map();
const attempts = new Map();
const housekeeping = setInterval(() => {
  const now = Date.now();
  for (const [key, session] of sessions)
    if (session.expires <= now) sessions.delete(key);
  for (const [key, times] of attempts) {
    const recent = times.filter((time) => now - time < 15 * 60_000);
    if (recent.length) attempts.set(key, recent);
    else attempts.delete(key);
  }
}, 60_000);
housekeeping.unref();
// Use the same native canonicalization as asynchronous filesystem access.
const privateDataDir = fs.realpathSync.native(dataDir);
const privatePaths = [privateDataDir];
if (process.env.DIRECT_TLS_KEY) {
  try {
    privatePaths.push(fs.realpathSync.native(process.env.DIRECT_TLS_KEY));
  } catch {
    /* TLS startup reports a missing custom key when configured. */
  }
}

function isPrivatePath(actual) {
  return privatePaths.some((privateRoot) => {
    const relative = path.relative(privateRoot, actual);
    return (
      relative === "" ||
      (!relative.startsWith(`..${path.sep}`) &&
        relative !== ".." &&
        !path.isAbsolute(relative))
    );
  });
}
function assertPublicPath(actual) {
  if (isPrivatePath(actual))
    throw Object.assign(new Error("应用私有数据不可公开"), { status: 403 });
}

function saveConfig() {
  writeJson(configFile, config);
}
function record(kind, name, actor, stored = null) {
  activity.unshift({ at: new Date().toISOString(), kind, name, actor, stored });
  activity.length = Math.min(activity.length, 150);
  writeJson(activityFile, activity);
}
function isLocal(request) {
  const loopbackSocket = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
    request.socket.remoteAddress,
  );
  if (
    request.headers["x-forwarded-for"] ||
    request.headers["x-forwarded-proto"]
  )
    return false;
  let hostname;
  try {
    hostname = new URL(`http://${request.headers.host}`).hostname;
  } catch {
    return false;
  }
  return (
    loopbackSocket && ["localhost", "127.0.0.1", "[::1]"].includes(hostname)
  );
}
function secureRequest(request) {
  return (
    !!request.socket.encrypted ||
    (trustLocalProxy &&
      ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
        request.socket.remoteAddress,
      ) &&
      request.headers["x-forwarded-proto"] === "https")
  );
}
function sessionFor(request) {
  const cookie = request.headers.cookie
    ?.split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith("ot_session="));
  const session = sessions.get(cookie?.slice("ot_session=".length));
  if (!session || session.expires < Date.now()) return null;
  return session;
}
function requireSession(request) {
  const session = sessionFor(request);
  if (!session) throw Object.assign(new Error("请先登录"), { status: 401 });
  return session;
}
function requireAdmin(request) {
  const session = requireSession(request);
  if (!isLocal(request) || session.kind !== "password")
    throw Object.assign(new Error("仅主机本地管理员可操作"), { status: 403 });
  return session;
}
function setSession(request, response, kind) {
  const token = id() + id();
  sessions.set(token, { kind, expires: Date.now() + 12 * 60 * 60_000 });
  response.setHeader(
    "set-cookie",
    `ot_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secureRequest(request) ? "; Secure" : ""}`,
  );
}
function verifyAccessKey(candidate) {
  if (!config.keyHash || typeof candidate !== "string") return false;
  const digest = crypto.createHash("sha256").update(candidate).digest();
  return crypto.timingSafeEqual(digest, Buffer.from(config.keyHash, "hex"));
}
function issueKey() {
  const key = crypto.randomBytes(32).toString("base64url");
  config.keyHash = crypto.createHash("sha256").update(key).digest("hex");
  for (const [token, session] of sessions)
    if (session.kind === "key") sessions.delete(token);
  saveConfig();
  return key;
}
function loginAddress(request) {
  const proxyAddress = request.headers["x-forwarded-for"];
  return trustLocalProxy &&
    ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
      request.socket.remoteAddress,
    ) &&
    typeof proxyAddress === "string" &&
    net.isIP(proxyAddress.trim())
    ? proxyAddress.trim()
    : request.socket.remoteAddress;
}
function loginRate(request, valid) {
  const address = loginAddress(request);
  const recent = (attempts.get(address) || []).filter(
    (time) => Date.now() - time < 15 * 60_000,
  );
  if (recent.length >= 6)
    throw Object.assign(new Error("登录尝试过多，请 15 分钟后再试"), {
      status: 429,
    });
  if (valid === undefined) return;
  if (valid) attempts.delete(address);
  else {
    recent.push(Date.now());
    attempts.set(address, recent);
  }
}
function ownAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((item) => item && item.family === "IPv4" && !item.internal)
    .map((item) => item.address);
}
function availableRoots() {
  if (config.mode === "folders") return config.roots;
  if (process.platform === "win32") {
    return "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
      .split("")
      .map((letter) => ({
        id: `drive-${letter}`,
        label: `${letter}:`,
        path: `${letter}:\\`,
      }))
      .filter((root) => fs.existsSync(root.path));
  }
  return [{ id: "system", label: "系统文件 /", path: "/" }];
}
function rootFor(rootId) {
  const root = availableRoots().find((item) => item.id === rootId);
  if (!root) throw Object.assign(new Error("共享位置不存在"), { status: 404 });
  return root;
}
function publicRoot(root) {
  return { id: root.id, label: root.label, type: root.type || "directory" };
}
async function addRoot(directory) {
  if (typeof directory !== "string" || !path.isAbsolute(directory))
    throw new Error("请输入文件或文件夹的绝对路径");
  const actual = await fs.promises.realpath(directory);
  assertPublicPath(actual);
  const stats = await fs.promises.stat(actual);
  if (!stats.isFile() && !stats.isDirectory())
    throw new Error("请选择普通文件或文件夹");
  if (config.roots.some((root) => root.path === actual))
    throw new Error("该位置已加入");
  config.roots.push({
    id: id(),
    label: path.basename(actual) || actual,
    path: actual,
    type: stats.isFile() ? "file" : "directory",
  });
  saveConfig();
  return config.roots;
}
function responseHeaders(request, response) {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader(
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  if (secureRequest(request))
    response.setHeader("strict-transport-security", "max-age=31536000");
}
function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  const expected = `${secureRequest(request) ? "https" : "http"}://${request.headers.host}`;
  return origin === expected;
}
function errorReply(response, error) {
  if (!response.headersSent) bad(response, error, error.status || 400);
  else response.destroy(error);
}
function mime(file) {
  const extension = path.extname(file).toLowerCase();
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
    }[extension] || "application/octet-stream"
  );
}
async function list(root, requested) {
  if (root.type === "file") {
    if (requested && requested !== path.basename(root.path))
      throw new Error("File not found");
    const actual = await fs.promises.realpath(root.path);
    assertPublicPath(actual);
    const stats = await fs.promises.stat(actual);
    return [
      {
        name: path.basename(root.path),
        directory: false,
        size: stats.size,
        modified: stats.mtime.toISOString(),
        path: "",
      },
    ];
  }
  const relative = relativePath(requested);
  const { actual } = await containedFile(root.path, relative, "directory");
  assertPublicPath(actual);
  const entries = [];
  for (const entry of (
    await fs.promises.readdir(actual, { withFileTypes: true })
  ).slice(0, 1000)) {
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory()))
      continue;
    try {
      const child = await fs.promises.realpath(path.join(actual, entry.name));
      if (isPrivatePath(child)) continue;
      const stats = await fs.promises.stat(child);
      entries.push({
        name: entry.name,
        directory: entry.isDirectory(),
        size: entry.isDirectory() ? null : stats.size,
        modified: stats.mtime.toISOString(),
      });
    } catch {
      /* A file may disappear while listing. */
    }
  }
  return entries;
}
async function search(root, text) {
  const query = String(text || "")
    .trim()
    .toLocaleLowerCase();
  if (!query || query.length > 100)
    throw new Error("搜索词长度需要在 1 到 100 之间");
  if (root.type === "file") {
    assertPublicPath(await fs.promises.realpath(root.path));
    return {
      files: path.basename(root.path).toLocaleLowerCase().includes(query)
        ? await list(root, "")
        : [],
      limited: false,
    };
  }
  const queue = [""],
    matches = [];
  let scanned = 0;
  while (queue.length && scanned < 5000 && matches.length < 100) {
    const current = queue.shift();
    let directory;
    try {
      directory = (await containedFile(root.path, current, "directory")).actual;
      assertPublicPath(directory);
    } catch {
      continue;
    }
    let entries;
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++scanned > 5000 || matches.length >= 100) break;
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory()))
        continue;
      const entryPath = [current, entry.name].filter(Boolean).join("/");
      let child;
      try {
        child = await fs.promises.realpath(path.join(directory, entry.name));
        if (isPrivatePath(child)) continue;
      } catch {
        continue;
      }
      if (entry.name.toLocaleLowerCase().includes(query)) {
        try {
          const stats = await fs.promises.stat(child);
          matches.push({
            name: entry.name,
            path: entryPath,
            directory: entry.isDirectory(),
            size: entry.isDirectory() ? null : stats.size,
            modified: stats.mtime.toISOString(),
          });
        } catch {
          /* Skip files that disappeared. */
        }
      }
      if (entry.isDirectory()) queue.push(entryPath);
    }
  }
  return { files: matches, limited: scanned >= 5000 || matches.length >= 100 };
}

async function handle(request, response) {
  responseHeaders(request, response);
  try {
    const url = new URL(request.url, "http://localhost");
    if (!["GET", "POST"].includes(request.method))
      throw Object.assign(new Error("Method not allowed"), { status: 405 });
    if (request.method === "POST" && !sameOrigin(request))
      throw Object.assign(new Error("Origin mismatch"), { status: 403 });

    if (
      request.method === "GET" &&
      ["/", "/app.js", "/style.css"].includes(url.pathname)
    ) {
      const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      response.writeHead(200, {
        "content-type": mime(name),
        "cache-control": "no-store",
      });
      return fs.createReadStream(path.join(webDir, name)).pipe(response);
    }
    if (
      request.method === "GET" &&
      /^\/icons\/[a-z0-9-]+\.svg$/.test(url.pathname)
    ) {
      const file = path.join(iconsDir, path.basename(url.pathname));
      if (!fs.existsSync(file)) return bad(response, "Not found", 404);
      response.writeHead(200, {
        "content-type": "image/svg+xml",
        "cache-control": "public, max-age=86400",
      });
      return fs.createReadStream(file).pipe(response);
    }
    if (
      request.method === "GET" &&
      [
        "/local-picker.js",
        "/local-picker.css",
        "/i18n.js",
        "/i18n.css",
      ].includes(url.pathname)
    ) {
      const file = path.join(sharedUiDir, url.pathname);
      response.writeHead(200, {
        "content-type": mime(file),
        "cache-control": "no-store",
      });
      return fs.createReadStream(file).pipe(response);
    }
    if (request.method === "GET" && url.pathname === "/api/status") {
      const session = sessionFor(request);
      return reply(response, 200, {
        configured: !!config.password,
        authorized: !!session,
        admin: !!session && session.kind === "password" && isLocal(request),
        local: isLocal(request),
        mode: session ? config.mode : undefined,
        allowUpload: session ? config.allowUpload : undefined,
        hostName: os.hostname(),
        protocol: secureRequest(request) ? "https" : "http",
        addresses:
          isLocal(request) && !localHttp
            ? ownAddresses().map(
                (address) =>
                  `${localHttp ? "http" : "https"}://${address}:${port}`,
              )
            : [],
        fingerprint: tlsFingerprint,
      });
    }
    if (request.method === "POST" && url.pathname === "/api/setup") {
      if (config.password || !isLocal(request))
        throw Object.assign(new Error("仅可在主机本地完成初次设置"), {
          status: 403,
        });
      const { username, password } = await bodyJson(request);
      if (
        !/^[a-zA-Z0-9_.-]{3,40}$/.test(username || "") ||
        typeof password !== "string" ||
        password.length < 12
      )
        throw new Error("账号需 3-40 位，密码至少 12 位");
      config.username = username;
      config.password = passwordHash(password);
      const accessKey = issueKey();
      setSession(request, response, "password");
      record("setup", "主机已初始化", "local");
      return reply(response, 201, { accessKey });
    }
    if (request.method === "POST" && url.pathname === "/api/login") {
      loginRate(request);
      const { username, password, accessKey } = await bodyJson(request);
      const passwordValid =
        username === config.username &&
        typeof password === "string" &&
        !!config.password &&
        checkPassword(password, config.password);
      const keyValid = verifyAccessKey(accessKey);
      loginRate(request, passwordValid || keyValid);
      if (!passwordValid && !keyValid)
        throw Object.assign(new Error("账号、密码或访问密钥不正确"), {
          status: 401,
        });
      setSession(request, response, passwordValid ? "password" : "key");
      record("login", "设备已连接", passwordValid ? "password" : "key");
      return reply(response, 200, { ok: true });
    }
    if (request.method === "POST" && url.pathname === "/api/logout") {
      const cookie = request.headers.cookie
        ?.split(";")
        .map((item) => item.trim())
        .find((item) => item.startsWith("ot_session="));
      sessions.delete(cookie?.slice("ot_session=".length));
      response.setHeader(
        "set-cookie",
        `ot_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureRequest(request) ? "; Secure" : ""}`,
      );
      return reply(response, 200, { ok: true });
    }

    const session = requireSession(request);
    if (request.method === "GET" && url.pathname === "/api/roots")
      return reply(response, 200, {
        roots: availableRoots().map(publicRoot),
        mode: config.mode,
      });
    if (request.method === "GET" && url.pathname === "/api/list")
      return reply(response, 200, {
        files: await list(
          rootFor(url.searchParams.get("root")),
          url.searchParams.get("path") || "",
        ),
      });
    if (request.method === "GET" && url.pathname === "/api/search")
      return reply(
        response,
        200,
        await search(
          rootFor(url.searchParams.get("root")),
          url.searchParams.get("q"),
        ),
      );
    if (request.method === "GET" && url.pathname === "/api/download") {
      const root = rootFor(url.searchParams.get("root"));
      let actual, stats;
      if (root.type === "file") {
        const requested = url.searchParams.get("path") || "";
        if (requested && requested !== path.basename(root.path))
          throw new Error("File not found");
        actual = await fs.promises.realpath(root.path);
        assertPublicPath(actual);
        stats = await fs.promises.stat(actual);
      } else {
        ({ actual, stats } = await containedFile(
          root.path,
          url.searchParams.get("path"),
          "file",
        ));
        assertPublicPath(actual);
      }
      const range = request.headers.range;
      let start = 0,
        end = stats.size - 1,
        status = 200;
      if (range) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(range);
        if (!match)
          throw Object.assign(new Error("Unsupported range"), { status: 416 });
        start = Number(match[1]);
        end = match[2] ? Math.min(Number(match[2]), end) : end;
        if (start > end || start >= stats.size)
          throw Object.assign(new Error("Range outside file"), { status: 416 });
        status = 206;
      }
      response.writeHead(status, {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(actual))}`,
        "content-length": Math.max(0, end - start + 1),
        "accept-ranges": "bytes",
        ...(status === 206
          ? { "content-range": `bytes ${start}-${end}/${stats.size}` }
          : {}),
        "cache-control": "no-store",
      });
      record("download", path.basename(actual), session.kind);
      return fs
        .createReadStream(actual, stats.size ? { start, end } : {})
        .on("error", (error) => response.destroy(error))
        .pipe(response);
    }
    if (request.method === "POST" && url.pathname === "/api/upload") {
      if (!config.allowUpload)
        throw Object.assign(new Error("主机未开放接收"), { status: 403 });
      const name = safeName(url.searchParams.get("name") || "file");
      const maxBytes = config.maxUploadMB * 1024 * 1024;
      if (Number(request.headers["content-length"] || 0) > maxBytes)
        throw Object.assign(new Error("文件超过上传上限"), { status: 413 });
      const destination = path.join(inboxDir, `${id()}-${name}`);
      let received = 0;
      const counter = new Transform({
        transform(chunk, encoding, callback) {
          received += chunk.length;
          callback(
            received > maxBytes ? new Error("文件超过上传上限") : null,
            chunk,
          );
        },
      });
      try {
        await pipeline(
          request,
          counter,
          fs.createWriteStream(destination, { flags: "wx", mode: 0o600 }),
        );
      } catch (error) {
        await fs.promises.rm(destination, { force: true });
        throw error;
      }
      record("upload", name, session.kind, path.basename(destination));
      return reply(response, 201, { name, bytes: received });
    }
    if (request.method === "GET" && url.pathname === "/api/activity")
      return reply(response, 200, { activity: activity.slice(0, 30) });

    requireAdmin(request);
    if (request.method === "GET" && url.pathname === "/api/admin/local-files")
      return reply(
        response,
        200,
        await localFiles(url.searchParams.get("path"), {
          kind: url.searchParams.get("kind") || "directory",
          excluded: privatePaths,
        }),
      );
    if (request.method === "GET" && url.pathname === "/api/admin")
      return reply(response, 200, {
        mode: config.mode,
        roots: config.roots,
        allowUpload: config.allowUpload,
        maxUploadMB: config.maxUploadMB,
        inbox: inboxDir,
        hasKey: !!config.keyHash,
      });
    if (request.method === "POST" && url.pathname === "/api/admin/mode") {
      const { mode, confirmation } = await bodyJson(request);
      if (!["folders", "whole"].includes(mode))
        throw new Error("Invalid sharing mode");
      if (mode === "whole" && confirmation !== "OPEN ALL")
        throw new Error("请输入 OPEN ALL 以确认整机公开风险");
      config.mode = mode;
      saveConfig();
      record("scope", mode === "whole" ? "整机只读" : "指定文件夹", "local");
      return reply(response, 200, { mode });
    }
    if (request.method === "POST" && url.pathname === "/api/admin/roots") {
      const { action, directory, rootId } = await bodyJson(request);
      if (action === "add") {
        await addRoot(directory);
      } else if (action === "remove") {
        config.roots = config.roots.filter((root) => root.id !== rootId);
        saveConfig();
      } else throw new Error("Invalid action");
      return reply(response, 200, { roots: config.roots });
    }
    if (request.method === "POST" && url.pathname === "/api/admin/pick-root") {
      const { kind } = await bodyJson(request);
      const selected = await pickLocalPath(kind);
      if (!selected) return reply(response, 200, { cancelled: true });
      return reply(response, 200, { roots: await addRoot(selected) });
    }
    if (request.method === "POST" && url.pathname === "/api/admin/key") {
      const accessKey = issueKey();
      record("key", "访问密钥已轮换", "local");
      return reply(response, 200, { accessKey });
    }
    if (request.method === "POST" && url.pathname === "/api/admin/options") {
      const { allowUpload, maxUploadMB } = await bodyJson(request);
      if (
        !Number.isInteger(maxUploadMB) ||
        maxUploadMB < 1 ||
        maxUploadMB > 10240
      )
        throw new Error("上传上限需在 1 到 10240 MB 之间");
      config.allowUpload = !!allowUpload;
      config.maxUploadMB = maxUploadMB;
      saveConfig();
      return reply(response, 200, { ok: true });
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/admin/open-location"
    ) {
      const { name } = await bodyJson(request);
      const { actual } = await containedFile(inboxDir, safeName(name), "file");
      await revealFile(actual);
      return reply(response, 200, { ok: true });
    }
    return bad(response, "Not found", 404);
  } catch (error) {
    errorReply(response, error);
  }
}

let tlsFingerprint = null;
let server;
if (localHttp) {
  server = http.createServer(handle);
} else {
  let cert, key;
  if (process.env.DIRECT_TLS_CERT && process.env.DIRECT_TLS_KEY) {
    cert = fs.readFileSync(process.env.DIRECT_TLS_CERT, "utf8");
    key = fs.readFileSync(process.env.DIRECT_TLS_KEY, "utf8");
  } else {
    const certFile = path.join(dataDir, "tls-cert.pem");
    const keyFile = path.join(dataDir, "tls-key.pem");
    if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
      const altNames = [
        { type: 2, value: "localhost" },
        { type: 7, ip: "127.0.0.1" },
        ...ownAddresses().map((ip) => ({ type: 7, ip })),
      ];
      const generated = selfsigned.generate(
        [{ name: "commonName", value: os.hostname() }],
        {
          days: 365,
          keySize: 2048,
          algorithm: "sha256",
          extensions: [{ name: "subjectAltName", altNames }],
        },
      );
      fs.writeFileSync(certFile, generated.cert, { mode: 0o600 });
      fs.writeFileSync(keyFile, generated.private, { mode: 0o600 });
    }
    cert = fs.readFileSync(certFile, "utf8");
    key = fs.readFileSync(keyFile, "utf8");
  }
  tlsFingerprint = new crypto.X509Certificate(cert).fingerprint256;
  server = https.createServer({ cert, key }, handle);
}
server.listen(port, bind, () => {
  console.log(
    `Direct host: ${localHttp ? "http" : "https"}://127.0.0.1:${port}`,
  );
  if (!localHttp)
    for (const address of ownAddresses())
      console.log(`LAN: https://${address}:${port}`);
  if (tlsFingerprint) console.log(`TLS certificate SHA-256: ${tlsFingerprint}`);
});
if (!localHttp) {
  const localAdmin = http.createServer(handle);
  localAdmin.on("error", (error) => {
    if (error.code !== "EADDRINUSE") throw error;
    localAdmin.listen(0, "127.0.0.1");
  });
  localAdmin.listen(localAdminPort, "127.0.0.1", () => {
    console.log(
      `Local administration: http://127.0.0.1:${localAdmin.address().port}`,
    );
  });
}
