import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { pickLocalPath } from "./file-picker.mjs";
import { localFiles } from "./local-files.mjs";
import { pinPeerKeys } from "./peer-pins.mjs";
import { ReplayWindow } from "./replay-window.mjs";
import {
  BoundedQueue,
  reserveJob,
  terminalStates,
  transferId as validTransferId,
  validateMessage,
} from "./transfer-policy.mjs";
import {
  bad,
  bodyJson,
  containedFile,
  id,
  makeKeys,
  open,
  publicFingerprint,
  readJson,
  relativePath,
  reply,
  revealFile,
  safeName,
  seal,
  writeJson,
} from "./common.mjs";

const localPort = Number(process.env.CLIENT_PORT || 8788);
const peerPort = Number(process.env.PEER_PORT || localPort + 1);
const dataDir = path.resolve(
  process.env.TRANSFER_CLIENT_DATA || ".data/client",
);
const configFile = path.join(dataDir, "config.json");
const jobsFile = path.join(dataDir, "jobs.json");
const publicDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../web",
);
const sharedUiDir = path.resolve(publicDir, "../shared-ui");
const iconsDir = path.resolve(publicDir, "../node_modules/lucide-static/icons");
function privatePath(actual) {
  let privateDir = dataDir;
  try {
    // Match fs.promises.realpath's native Windows short/long path resolution.
    privateDir = fs.realpathSync.native(dataDir);
  } catch {
    /* Data directory may not exist before setup. */
  }
  const relative = path.relative(privateDir, actual);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}
let config = readJson(configFile, null);
let jobs = readJson(jobsFile, []);
let token = null;
let socket = null;
let peers = new Map();
let connectionTimer = null;
let refreshTimer = null;
const pendingLists = new Map();
const sending = new Set();
const lastErrors = [];
const replayWindow = new ReplayWindow();
const receiveQueue = new BoundedQueue();
const peerRates = new Map();
const housekeeping = setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const job of jobs) {
    if (job.status === "pending" && now - job.created > 60 * 60_000) {
      job.status = "rejected";
      job.error = "Pending offer expired";
      changed = true;
    }
  }
  if (changed) persistJobs();
  for (const [device, times] of peerRates) {
    const recent = times.filter((time) => now - time < 60_000);
    if (recent.length) peerRates.set(device, recent);
    else peerRates.delete(device);
  }
}, 60_000);
housekeeping.unref();

function peerRate(from) {
  const now = Date.now();
  const recent = (peerRates.get(from) || []).filter(
    (time) => now - time < 60_000,
  );
  if (recent.length >= 120)
    throw new Error("Too many peer requests; wait one minute");
  recent.push(now);
  peerRates.set(from, recent);
}

function addJob(job) {
  reserveJob(jobs, job.peerId);
  jobs.unshift(job);
  persistJobs();
}

async function authorizedSource(job) {
  if (job.mode !== "pull") return job.source;
  if (!permission(job.peerId).download || !config.share)
    throw new Error("Download permission was withdrawn");
  const relative = path.relative(
    await fs.promises.realpath(config.share),
    job.source,
  );
  const { actual } = await containedFile(config.share, relative, "file");
  if (actual !== job.source || privatePath(actual))
    throw new Error("Source is no longer shared");
  return actual;
}

function persistConfig() {
  writeJson(configFile, config);
}
function persistJobs() {
  writeJson(jobsFile, jobs);
}
function issue(error) {
  console.error(error);
  lastErrors.unshift({
    at: new Date().toISOString(),
    message: error.message || String(error),
  });
  lastErrors.length = Math.min(lastErrors.length, 8);
}
function jobById(transferId) {
  return jobs.find((job) => job.id === transferId);
}
function mark(job, patch) {
  Object.assign(job, patch);
  persistJobs();
}
function assertSetup() {
  if (!config?.deviceId) throw new Error("Set up this device first");
}
function permission(deviceId) {
  return (
    config.permissions?.[deviceId] || {
      browse: false,
      download: false,
      upload: false,
    }
  );
}
function peer(deviceId) {
  const found = peers.get(deviceId);
  if (!found) throw new Error("Device is not paired");
  return found;
}

async function api(method, endpoint, body, bearer = token) {
  const url = new URL(endpoint, config.serverUrl);
  const response = await fetch(url, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error || `Server returned ${response.status}`);
  return result;
}

async function setupDevice(input) {
  if (config?.deviceId) throw new Error("Device already configured");
  const serverUrl = new URL(input.serverUrl);
  if (!["http:", "https:"].includes(serverUrl.protocol))
    throw new Error("Use an HTTP or HTTPS server URL");
  if (
    serverUrl.protocol === "http:" &&
    !["localhost", "127.0.0.1"].includes(serverUrl.hostname) &&
    process.env.ALLOW_INSECURE_SERVER !== "1"
  )
    throw new Error("Public servers require HTTPS");
  const username = String(input.username || "").trim();
  const password = String(input.password || "");
  const name = String(input.name || os.hostname()).trim();
  const keys = makeKeys();
  config = {
    serverUrl: serverUrl.href,
    name,
    permissions: {},
    peerPins: {},
    share: "",
    downloads: path.join(dataDir, "downloads"),
    keys,
  };
  try {
    const device = {
      name,
      signingPublic: keys.signingPublic,
      encryptionPublic: keys.encryptionPublic,
    };
    let enrolled;
    if (input.enrollmentKey) {
      enrolled = await api(
        "POST",
        "/api/enroll",
        { ...device, enrollmentKey: String(input.enrollmentKey).trim() },
        null,
      );
    } else {
      if (input.createAccount)
        await api("POST", "/api/register", { username, password }, null);
      const login = await api(
        "POST",
        "/api/login",
        { username, password },
        null,
      );
      enrolled = await api("POST", "/api/devices", device, login.token);
    }
    config.deviceId = enrolled.deviceId;
    persistConfig();
    await connect();
  } catch (error) {
    config = null;
    throw error;
  }
}

async function authenticate() {
  const { nonce } = await api(
    "POST",
    "/api/challenge",
    { deviceId: config.deviceId },
    null,
  );
  const signature = crypto
    .sign(null, Buffer.from(nonce), config.keys.signingPrivate)
    .toString("base64");
  token = (
    await api(
      "POST",
      "/api/device-auth",
      { deviceId: config.deviceId, signature },
      null,
    )
  ).token;
}

function ownAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((item) => item && item.family === "IPv4" && !item.internal)
    .map((item) => item.address);
}

async function refreshPeers() {
  if (!token) return;
  const result = await api("GET", "/api/devices");
  config.peerPins ||= {};
  if (pinPeerKeys(config.peerPins, result.devices)) persistConfig();
  peers = new Map(result.devices.map((device) => [device.id, device]));
}

async function connect() {
  if (!config?.deviceId) return;
  clearTimeout(connectionTimer);
  try {
    await authenticate();
    await api("POST", "/api/endpoint", {
      port: peerPort,
      addresses: ownAddresses(),
    });
    await refreshPeers();
    const wsUrl = new URL("/relay", config.serverUrl);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(wsUrl, {
      headers: { authorization: `Bearer ${token}` },
    });
    socket.on("open", async () => {
      try {
        await refreshPeers();
        for (const device of peers.values())
          if (device.online) resumeFor(device.id);
      } catch (error) {
        issue(error);
      }
    });
    socket.on("message", (data) => {
      try {
        const envelope = JSON.parse(data.toString());
        if (envelope.type === "presence") {
          const device = peers.get(envelope.deviceId);
          if (device) device.online = envelope.online;
          if (envelope.online)
            refreshPeers()
              .then(() => resumeFor(envelope.deviceId))
              .catch(issue);
        } else handleEnvelope(envelope).catch(issue);
      } catch (error) {
        issue(error);
      }
    });
    socket.on("close", () => {
      if (socket?.readyState !== WebSocket.OPEN)
        connectionTimer = setTimeout(() => connect().catch(issue), 3000);
    });
    socket.on("error", issue);
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => refreshPeers().catch(issue), 10_000);
  } catch (error) {
    issue(error);
    connectionTimer = setTimeout(() => connect().catch(issue), 5000);
  }
}

function sameSubnet(address) {
  return ownAddresses().some(
    (own) =>
      own.split(".").slice(0, 3).join(".") ===
      address.split(".").slice(0, 3).join("."),
  );
}

async function send(to, message) {
  const device = peer(to);
  const envelope = seal(
    message,
    config.deviceId,
    to,
    config.keys.encryptionPrivate,
    device.encryptionPublic,
  );
  for (const endpoint of process.env.ENABLE_LAN_DIRECT === "1"
    ? device.lan || []
    : []) {
    if (!sameSubnet(endpoint.address)) continue;
    try {
      const response = await fetch(
        `http://${endpoint.address}:${endpoint.port}/peer`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(envelope),
          signal: AbortSignal.timeout(1200),
        },
      );
      if (response.ok) return;
    } catch {
      /* Fall back to relay. */
    }
  }
  if (socket?.readyState !== WebSocket.OPEN)
    throw new Error("Discovery service is disconnected");
  socket.send(JSON.stringify(envelope));
}

function resumeFor(deviceId) {
  for (const job of jobs) {
    if (
      job.peerId !== deviceId ||
      ["complete", "rejected", "error"].includes(job.status)
    )
      continue;
    if (job.direction === "out" && job.source) offer(job).catch(issue);
    if (job.direction === "in" && job.remotePath)
      send(deviceId, {
        kind: "pull-request",
        transferId: job.id,
        path: job.remotePath,
      }).catch(issue);
  }
}

async function offer(job) {
  await authorizedSource(job);
  if (!fs.existsSync(job.source)) {
    mark(job, { status: "error", error: "Source file no longer exists" });
    return;
  }
  await send(job.peerId, {
    kind: "offer",
    transferId: job.id,
    name: job.name,
    size: job.size,
  });
  mark(job, { status: "offered" });
}

async function pump(job) {
  if (sending.has(job.id)) return;
  sending.add(job.id);
  try {
    if (process.env.TRANSFER_CHUNK_DELAY_MS)
      await new Promise((resolve) =>
        setTimeout(resolve, Number(process.env.TRANSFER_CHUNK_DELAY_MS)),
      );
    await authorizedSource(job);
    if (job.status !== "sending") return;
    const position = job.transferred || 0;
    if (position >= job.size) {
      const digest = await fileDigest(job.source);
      await send(job.peerId, {
        kind: "finish",
        transferId: job.id,
        sha256: digest,
      });
      mark(job, { status: "verifying" });
      return;
    }
    const handle = await fs.promises.open(job.source, "r");
    try {
      const buffer = Buffer.alloc(Math.min(192 * 1024, job.size - position));
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        position,
      );
      if (!bytesRead) throw new Error("Source file changed during transfer");
      await send(job.peerId, {
        kind: "chunk",
        transferId: job.id,
        offset: position,
        data: buffer.subarray(0, bytesRead).toString("base64"),
      });
      mark(job, { status: "sending" });
    } finally {
      await handle.close();
    }
  } catch (error) {
    mark(job, { status: "error", error: error.message });
    issue(error);
  } finally {
    sending.delete(job.id);
  }
}

async function fileDigest(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function uniqueDestination(name) {
  const safe = safeName(name);
  const parsed = path.parse(safe);
  let output = path.join(config.downloads, safe);
  for (
    let n = 2;
    fs.existsSync(output) ||
    jobs.some((job) => job.destination === output && job.status !== "complete");
    n++
  ) {
    output = path.join(config.downloads, `${parsed.name} (${n})${parsed.ext}`);
  }
  return output;
}

async function accept(job) {
  validTransferId(job.id);
  fs.mkdirSync(config.downloads, { recursive: true });
  if (!job.destination) job.destination = uniqueDestination(job.name);
  const downloadRoot = await fs.promises.realpath(config.downloads);
  if (!job.localPartId) {
    // Migrate only a legacy confined partial file, never an arbitrary stored path.
    const legacy = path.join(downloadRoot, `${job.id}.part`);
    job.localPartId = id();
    const target = path.join(downloadRoot, `${job.localPartId}.part`);
    try {
      const stats = await fs.promises.lstat(legacy);
      if (!stats.isFile() || stats.isSymbolicLink())
        throw new Error("Unsafe partial file");
      await fs.promises.link(legacy, target);
      await fs.promises.unlink(legacy);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  validTransferId(job.localPartId);
  job.part = path.join(downloadRoot, `${job.localPartId}.part`);
  try {
    const created = await fs.promises.open(job.part, "wx", 0o600);
    await created.close();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  let offset = 0;
  const partial = await fs.promises.lstat(job.part);
  if (!partial.isFile() || partial.isSymbolicLink() || partial.size > job.size)
    throw new Error("Unsafe partial file");
  offset = partial.size;
  mark(job, { status: "receiving", transferred: offset });
  await send(job.peerId, { kind: "accept", transferId: job.id, offset });
}

function handleEnvelope(envelope) {
  return receiveQueue.run(() => processEnvelope(envelope));
}

async function processEnvelope(envelope) {
  if (envelope.to !== config.deviceId) return;
  const device = peer(envelope.from);
  const message = open(
    envelope,
    config.keys.encryptionPrivate,
    device.encryptionPublic,
  );
  if (!replayWindow.accept(envelope.from, envelope.nonce)) return;
  validateMessage(message);
  const from = envelope.from;
  if (["list", "search", "pull-request", "offer"].includes(message.kind))
    peerRate(from);
  const transferId = message.transferId;
  let job = transferId ? jobById(transferId) : null;
  switch (message.kind) {
    case "list": {
      if (!permission(from).browse || !config.share)
        return send(from, {
          kind: "list-result",
          requestId: message.requestId,
          error: "Browsing is not permitted",
        });
      try {
        const relative = relativePath(message.path || "");
        const { actual } = await containedFile(
          config.share,
          relative,
          "directory",
        );
        if (privatePath(actual)) throw new Error("应用私有数据不可浏览");
        const entries = await fs.promises.readdir(actual, {
          withFileTypes: true,
        });
        const files = [];
        for (const entry of entries.slice(0, 500)) {
          if (
            entry.isSymbolicLink() ||
            (!entry.isFile() && !entry.isDirectory())
          )
            continue;
          if (privatePath(path.join(actual, entry.name))) continue;
          const stats = await fs.promises.stat(path.join(actual, entry.name));
          files.push({
            name: entry.name,
            directory: entry.isDirectory(),
            size: stats.size,
            modified: stats.mtime.toISOString(),
          });
        }
        return send(from, {
          kind: "list-result",
          requestId: message.requestId,
          path: relative,
          files,
        });
      } catch (error) {
        return send(from, {
          kind: "list-result",
          requestId: message.requestId,
          error: error.message,
        });
      }
    }
    case "search": {
      if (!permission(from).browse || !config.share)
        return send(from, {
          kind: "search-result",
          requestId: message.requestId,
          error: "Searching is not permitted",
        });
      try {
        const query = String(message.query || "")
          .trim()
          .toLocaleLowerCase();
        if (!query || query.length > 100)
          throw new Error("Invalid search query");
        const matches = [],
          queue = [""];
        let scanned = 0;
        while (queue.length && scanned < 5000 && matches.length < 100) {
          const current = queue.shift();
          const { actual } = await containedFile(
            config.share,
            current,
            "directory",
          );
          if (privatePath(actual)) continue;
          for (const entry of await fs.promises.readdir(actual, {
            withFileTypes: true,
          })) {
            if (++scanned > 5000 || matches.length >= 100) break;
            if (
              entry.isSymbolicLink() ||
              (!entry.isDirectory() && !entry.isFile())
            )
              continue;
            if (privatePath(path.join(actual, entry.name))) continue;
            const entryPath = [current, entry.name].filter(Boolean).join("/");
            if (entry.name.toLocaleLowerCase().includes(query)) {
              const stats = await fs.promises.stat(
                path.join(actual, entry.name),
              );
              matches.push({
                name: entry.name,
                path: entryPath,
                directory: entry.isDirectory(),
                size: stats.size,
                modified: stats.mtime.toISOString(),
              });
            }
            if (entry.isDirectory()) queue.push(entryPath);
          }
        }
        return send(from, {
          kind: "search-result",
          requestId: message.requestId,
          files: matches,
          limited: scanned >= 5000 || matches.length >= 100,
        });
      } catch (error) {
        return send(from, {
          kind: "search-result",
          requestId: message.requestId,
          error: error.message,
        });
      }
    }
    case "list-result":
    case "search-result": {
      const pending = pendingLists.get(message.requestId);
      if (pending && pending.peerId === from) {
        pendingLists.delete(message.requestId);
        message.error
          ? pending.reject(new Error(message.error))
          : pending.resolve(message);
      }
      return;
    }
    case "pull-request": {
      if (!permission(from).download || !config.share)
        return send(from, {
          kind: "reject",
          transferId,
          reason: "Download is not permitted",
        });
      try {
        if (
          job &&
          (job.peerId !== from ||
            job.direction !== "out" ||
            job.mode !== "pull" ||
            ["complete", "rejected"].includes(job.status))
        )
          throw new Error("Transfer identity or state mismatch");
        const { actual, stats } = await containedFile(
          config.share,
          message.path,
          "file",
        );
        if (privatePath(actual)) throw new Error("应用私有数据不可下载");
        if (job && (job.source !== actual || job.size !== stats.size))
          throw new Error("Source file changed; start a new transfer");
        if (!job) {
          job = {
            id: transferId,
            peerId: from,
            direction: "out",
            mode: "pull",
            name: safeName(actual),
            size: stats.size,
            source: actual,
            transferred: 0,
            status: "offered",
            created: Date.now(),
          };
          addJob(job);
        }
        return offer(job);
      } catch (error) {
        return send(from, {
          kind: "reject",
          transferId,
          reason: error.message,
        });
      }
    }
    case "offer": {
      if (job && (job.peerId !== from || job.direction !== "in"))
        throw new Error("Transfer identity mismatch");
      if (!job && !permission(from).upload)
        return send(from, {
          kind: "reject",
          transferId,
          reason: "Incoming files are blocked",
        });
      if (
        !Number.isSafeInteger(message.size) ||
        message.size < 0 ||
        message.size > 100 * 1024 * 1024 * 1024
      )
        throw new Error("Invalid file size");
      if (job?.mode === "pull" && job.status === "requesting") {
        job.name = safeName(message.name);
        job.size = message.size;
        persistJobs();
      }
      if (!job) {
        job = {
          id: transferId,
          peerId: from,
          direction: "in",
          mode: "push",
          name: safeName(message.name),
          size: message.size,
          transferred: 0,
          status: "pending",
          created: Date.now(),
        };
        addJob(job);
      }
      if (
        job.peerId !== from ||
        job.direction !== "in" ||
        job.size !== message.size
      )
        throw new Error("Transfer identity mismatch");
      if (job.status === "complete")
        return send(from, { kind: "complete", transferId });
      if (job.status === "rejected" && job.mode === "push")
        mark(job, { status: "pending", error: null });
      if (job.mode === "pull" || job.status === "receiving") return accept(job);
      return;
    }
    case "accept": {
      if (
        !job ||
        job.peerId !== from ||
        job.direction !== "out" ||
        !["offered", "sending", "verifying"].includes(job.status)
      )
        return;
      await authorizedSource(job);
      if (
        !Number.isSafeInteger(message.offset) ||
        message.offset < 0 ||
        message.offset > job.size
      )
        throw new Error("Invalid resume offset");
      mark(job, { transferred: message.offset, status: "sending" });
      return pump(job);
    }
    case "chunk": {
      if (
        !job ||
        job.peerId !== from ||
        job.direction !== "in" ||
        job.status !== "receiving"
      )
        return;
      if (message.offset !== job.transferred)
        return send(from, {
          kind: "accept",
          transferId,
          offset: job.transferred,
        });
      if (typeof message.data !== "string" || message.data.length > 262144)
        throw new Error("Invalid chunk");
      const buffer = Buffer.from(message.data, "base64");
      if (
        buffer.length > 192 * 1024 ||
        job.transferred + buffer.length > job.size
      )
        throw new Error("Invalid chunk");
      const position = job.transferred;
      const handle = await fs.promises.open(
        job.part,
        fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0),
      );
      try {
        let written = 0;
        while (written < buffer.length) {
          const result = await handle.write(
            buffer,
            written,
            buffer.length - written,
            position + written,
          );
          if (!result.bytesWritten) throw new Error("Incomplete file write");
          written += result.bytesWritten;
        }
      } finally {
        await handle.close();
      }
      mark(job, { transferred: position + buffer.length });
      return send(from, { kind: "ack", transferId, offset: job.transferred });
    }
    case "ack": {
      if (
        !job ||
        job.peerId !== from ||
        job.direction !== "out" ||
        job.status !== "sending" ||
        !Number.isSafeInteger(message.offset) ||
        message.offset <= job.transferred ||
        message.offset > job.size
      )
        return;
      mark(job, { transferred: message.offset });
      return pump(job);
    }
    case "finish": {
      if (
        !job ||
        job.peerId !== from ||
        job.direction !== "in" ||
        job.status !== "receiving" ||
        job.transferred !== job.size
      )
        return;
      if (job.size === 0 && !fs.existsSync(job.part))
        await fs.promises.writeFile(job.part, "");
      const actual = await fileDigest(job.part);
      if (actual !== message.sha256) {
        mark(job, { status: "error", error: "File checksum mismatch" });
        return send(from, {
          kind: "reject",
          transferId,
          reason: "File checksum mismatch",
        });
      }
      await fs.promises.rename(job.part, job.destination);
      mark(job, { status: "complete", transferred: job.size });
      return send(from, { kind: "complete", transferId });
    }
    case "complete":
      if (
        job &&
        job.peerId === from &&
        job.direction === "out" &&
        job.status === "verifying"
      )
        mark(job, { status: "complete", transferred: job.size });
      return;
    case "reject":
      if (job && job.peerId === from)
        mark(job, { status: "rejected", error: message.reason });
      return;
    default:
      return;
  }
}

async function remoteQuery(deviceId, message) {
  peer(deviceId);
  const requestId = id();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingLists.delete(requestId);
      reject(new Error("Remote device did not respond"));
    }, 15_000);
    pendingLists.set(requestId, {
      peerId: deviceId,
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    send(deviceId, { ...message, requestId }).catch((error) => {
      clearTimeout(timer);
      pendingLists.delete(requestId);
      reject(error);
    });
  });
}

function localRequestAllowed(request) {
  if (
    request.socket.remoteAddress !== "127.0.0.1" &&
    request.socket.remoteAddress !== "::1" &&
    request.socket.remoteAddress !== "::ffff:127.0.0.1"
  )
    return false;
  try {
    const expected = new URL(`http://${request.headers.host}`);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(expected.hostname))
      return false;
    const origin = request.headers.origin;
    if (origin && origin !== expected.origin) return false;
    if (request.headers["sec-fetch-site"] === "cross-site") return false;
    return true;
  } catch {
    return false;
  }
}

const localServer = http.createServer(async (request, response) => {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader(
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  try {
    if (!localRequestAllowed(request))
      return bad(response, "Local access only", 403);
    const url = new URL(request.url, "http://localhost");
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      return fs
        .createReadStream(path.join(publicDir, "index.html"))
        .pipe(response);
    }
    if (
      request.method === "GET" &&
      ["/app.js", "/style.css"].includes(url.pathname)
    ) {
      response.writeHead(200, {
        "content-type": url.pathname.endsWith(".js")
          ? "text/javascript; charset=utf-8"
          : "text/css; charset=utf-8",
        "cache-control": "no-store",
      });
      return fs
        .createReadStream(path.join(publicDir, url.pathname))
        .pipe(response);
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
      response.writeHead(200, {
        "content-type": url.pathname.endsWith(".js")
          ? "text/javascript; charset=utf-8"
          : "text/css; charset=utf-8",
        "cache-control": "no-store",
      });
      return fs
        .createReadStream(path.join(sharedUiDir, url.pathname))
        .pipe(response);
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
    if (request.method === "GET" && url.pathname === "/api/status")
      return reply(response, 200, {
        configured: !!config?.deviceId,
        name: config?.name,
        deviceId: config?.deviceId,
        fingerprint: config
          ? publicFingerprint(
              config.keys.signingPublic + config.keys.encryptionPublic,
            )
          : null,
        server: config?.serverUrl,
        connected: socket?.readyState === WebSocket.OPEN,
        share: config?.share,
        downloads: config?.downloads,
        errors: lastErrors,
      });
    if (request.method === "POST" && url.pathname === "/api/setup") {
      await setupDevice(await bodyJson(request));
      return reply(response, 200, { ok: true });
    }
    assertSetup();
    if (request.method === "GET" && url.pathname === "/api/local-files")
      return reply(
        response,
        200,
        await localFiles(url.searchParams.get("path"), {
          kind: "directory",
          excluded: [dataDir],
        }),
      );
    if (request.method === "GET" && url.pathname === "/api/devices")
      return reply(response, 200, {
        devices: [...peers.values()].map((device) => ({
          ...device,
          fingerprint: publicFingerprint(
            device.signingPublic + device.encryptionPublic,
          ),
          permission: permission(device.id),
        })),
      });
    if (request.method === "POST" && url.pathname === "/api/enrollment-key")
      return reply(response, 201, await api("POST", "/api/enrollment-key", {}));
    if (request.method === "POST" && url.pathname === "/api/invite")
      return reply(response, 200, await api("POST", "/api/invite", {}));
    if (request.method === "POST" && url.pathname === "/api/join") {
      const result = await api("POST", "/api/join", await bodyJson(request));
      await refreshPeers();
      return reply(response, 200, result);
    }
    if (request.method === "POST" && url.pathname === "/api/unpair") {
      const { deviceId } = await bodyJson(request);
      await api("POST", "/api/unpair", { deviceId });
      await refreshPeers();
      return reply(response, 200, { ok: true });
    }
    if (request.method === "POST" && url.pathname === "/api/revoke") {
      const { deviceId } = await bodyJson(request);
      await api("POST", "/api/revoke", { deviceId });
      await refreshPeers();
      return reply(response, 200, { ok: true });
    }
    if (request.method === "POST" && url.pathname === "/api/share") {
      const { directory } = await bodyJson(request);
      const actual = directory
        ? (await containedFile(path.resolve(directory), "", "directory")).actual
        : "";
      if (actual && privatePath(actual))
        throw new Error("应用私有数据不可共享");
      config.share = actual;
      persistConfig();
      return reply(response, 200, { share: actual });
    }
    if (request.method === "POST" && url.pathname === "/api/pick-share") {
      const selected = await pickLocalPath("directory");
      if (!selected) return reply(response, 200, { cancelled: true });
      const actual = (await containedFile(selected, "", "directory")).actual;
      if (privatePath(actual)) throw new Error("应用私有数据不可共享");
      config.share = actual;
      persistConfig();
      return reply(response, 200, { share: config.share });
    }
    if (request.method === "POST" && url.pathname === "/api/permission") {
      const { deviceId, browse, download, upload } = await bodyJson(request);
      peer(deviceId);
      config.permissions[deviceId] = {
        browse: !!browse,
        download: !!download,
        upload: !!upload,
      };
      persistConfig();
      return reply(response, 200, { ok: true });
    }
    if (request.method === "GET" && url.pathname === "/api/files")
      return reply(
        response,
        200,
        await remoteQuery(url.searchParams.get("device"), {
          kind: "list",
          path: relativePath(url.searchParams.get("path") || ""),
        }),
      );
    if (request.method === "GET" && url.pathname === "/api/search")
      return reply(
        response,
        200,
        await remoteQuery(url.searchParams.get("device"), {
          kind: "search",
          query: url.searchParams.get("q") || "",
        }),
      );
    if (request.method === "POST" && url.pathname === "/api/pull") {
      const { deviceId, remotePath } = await bodyJson(request);
      peer(deviceId);
      relativePath(remotePath);
      const job = {
        id: id(),
        peerId: deviceId,
        direction: "in",
        mode: "pull",
        remotePath,
        name: safeName(remotePath),
        size: 0,
        transferred: 0,
        status: "requesting",
        created: Date.now(),
      };
      addJob(job);
      await send(deviceId, {
        kind: "pull-request",
        transferId: job.id,
        path: remotePath,
      });
      return reply(response, 202, { transferId: job.id });
    }
    if (request.method === "POST" && url.pathname === "/api/send") {
      const deviceId = url.searchParams.get("device");
      peer(deviceId);
      const name = safeName(
        decodeURIComponent(request.headers["x-file-name"] || "file"),
      );
      const jobId = id();
      reserveJob(jobs, deviceId);
      const source = path.join(dataDir, "outgoing", jobId);
      fs.mkdirSync(path.dirname(source), { recursive: true });
      const limit = 1024 * 1024 * 1024;
      let bytes = 0;
      const counter = new Transform({
        transform(chunk, encoding, callback) {
          bytes += chunk.length;
          callback(
            bytes > limit
              ? new Error("File exceeds the 1 GiB staging limit")
              : null,
            chunk,
          );
        },
      });
      try {
        await pipeline(
          request,
          counter,
          fs.createWriteStream(source, { flags: "wx", mode: 0o600 }),
        );
      } catch (error) {
        await fs.promises.rm(source, { force: true });
        throw error;
      }
      const stats = await fs.promises.stat(source);
      const job = {
        id: jobId,
        peerId: deviceId,
        direction: "out",
        mode: "push",
        source,
        name,
        size: stats.size,
        transferred: 0,
        status: "offered",
        created: Date.now(),
      };
      try {
        addJob(job);
      } catch (error) {
        await fs.promises.rm(source, { force: true });
        throw error;
      }
      await offer(job);
      return reply(response, 202, { transferId: jobId });
    }
    if (request.method === "GET" && url.pathname === "/api/transfers")
      return reply(response, 200, {
        transfers: jobs.map(({ source, part, ...job }) => job),
      });
    if (request.method === "POST" && url.pathname === "/api/open-location") {
      const { transferId } = await bodyJson(request);
      const job = jobById(transferId);
      if (!job || job.direction !== "in" || job.status !== "complete")
        throw new Error("No completed download");
      const { actual } = await containedFile(
        config.downloads,
        path.basename(job.destination),
        "file",
      );
      await revealFile(actual);
      return reply(response, 200, { ok: true });
    }
    if (request.method === "POST" && url.pathname === "/api/decide") {
      const { transferId, accept: yes } = await bodyJson(request);
      const job = jobById(transferId);
      if (!job || job.direction !== "in" || job.status !== "pending")
        throw new Error("No pending transfer");
      if (yes) await receiveQueue.run(() => accept(job));
      else {
        mark(job, { status: "rejected" });
        await send(job.peerId, {
          kind: "reject",
          transferId,
          reason: "Recipient declined",
        });
      }
      return reply(response, 200, { ok: true });
    }
    if (request.method === "POST" && url.pathname === "/api/retry") {
      const { transferId } = await bodyJson(request);
      const job = jobById(transferId);
      if (!job || !["error", "rejected"].includes(job.status))
        throw new Error("Transfer cannot be retried");
      if (job.direction === "in" && !job.remotePath) {
        mark(job, { error: null });
        await receiveQueue.run(() => accept(job));
      } else {
        mark(job, {
          status: job.direction === "in" ? "requesting" : "offered",
          error: null,
        });
        resumeFor(job.peerId);
      }
      return reply(response, 200, { ok: true });
    }
    return bad(response, "Not found", 404);
  } catch (error) {
    issue(error);
    bad(response, error);
  }
});

const peerServer = http.createServer(async (request, response) => {
  try {
    if (request.method !== "POST" || request.url !== "/peer")
      return bad(response, "Not found", 404);
    assertSetup();
    const envelope = await bodyJson(request, 1_000_000);
    if (envelope.to !== config.deviceId || !peers.has(envelope.from))
      throw new Error("Unknown peer");
    handleEnvelope(envelope).catch(issue);
    reply(response, 200, { ok: true });
  } catch (error) {
    bad(response, error);
  }
});

localServer.listen(localPort, "127.0.0.1", () =>
  console.log(`Client UI: http://127.0.0.1:${localPort}`),
);
peerServer.listen(
  peerPort,
  process.env.ENABLE_LAN_DIRECT === "1" ? "0.0.0.0" : "127.0.0.1",
  () => console.log(`LAN peer endpoint: ${peerPort}`),
);
if (config?.deviceId) connect().catch(issue);
