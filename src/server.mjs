import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import {
  bodyJson,
  checkPassword,
  compactId,
  id,
  passwordHash,
  readJson,
  reply,
  bad,
  writeJson,
} from "./common.mjs";

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "0.0.0.0";
const dataDir = path.resolve(
  process.env.TRANSFER_SERVER_DATA || ".data/server",
);
const dbFile = path.join(dataDir, "db.json");
const db = readJson(dbFile, { users: {}, devices: {}, pairs: [] });
const sessions = new Map();
const challenges = new Map();
const invites = new Map();
const enrollmentKeys = new Map();
const connections = new Map();
const endpoints = new Map();
const attempts = new Map();

const housekeeping = setInterval(() => {
  const now = Date.now();
  for (const [key, value] of sessions)
    if (value.expires <= now) sessions.delete(key);
  for (const [key, value] of challenges)
    if (value.expires <= now) challenges.delete(key);
  for (const [key, value] of invites)
    if (value.expires <= now) invites.delete(key);
  for (const [key, value] of enrollmentKeys)
    if (value.expires <= now) enrollmentKeys.delete(key);
  for (const [key, value] of attempts) {
    const recent = value.filter((time) => now - time < 60_000);
    if (recent.length) attempts.set(key, recent);
    else attempts.delete(key);
  }
}, 60_000);
housekeeping.unref();

function persist() {
  writeJson(dbFile, db);
}
function auth(request) {
  const token = request.headers.authorization?.replace(/^Bearer /, "");
  const session = sessions.get(token);
  if (!session || session.expires < Date.now())
    throw new Error("Authentication required");
  return session;
}
function related(a, b) {
  if (a === b) return true;
  const da = db.devices[a];
  const dbb = db.devices[b];
  return !!(
    da &&
    dbb &&
    (da.user === dbb.user ||
      db.pairs.some((pair) => pair.includes(a) && pair.includes(b)))
  );
}
function visibleDevices(deviceId) {
  return Object.entries(db.devices)
    .filter(([other]) => other !== deviceId && related(deviceId, other))
    .map(([otherId, device]) => ({
      id: otherId,
      name: device.name,
      encryptionPublic: device.encryptionPublic,
      signingPublic: device.signingPublic,
      online: connections.has(otherId),
      lan: endpoints.get(otherId) || [],
      sameAccount: device.user === db.devices[deviceId].user,
    }));
}
function broadcastPresence(deviceId) {
  for (const [other, socket] of connections) {
    if (
      other !== deviceId &&
      related(deviceId, other) &&
      socket.readyState === WebSocket.OPEN
    ) {
      socket.send(
        JSON.stringify({
          type: "presence",
          deviceId,
          online: connections.has(deviceId),
        }),
      );
    }
  }
}
function rateLimit(request) {
  const address = request.socket.remoteAddress;
  if (attempts.size > 20_000 && !attempts.has(address))
    throw new Error("Server is busy; try again later");
  const previous = attempts.get(address) || [];
  const recent = previous.filter((time) => Date.now() - time < 60_000);
  if (recent.length >= 30)
    throw new Error("Too many attempts; wait one minute");
  recent.push(Date.now());
  attempts.set(address, recent);
}
function registerDevice(user, { name, signingPublic, encryptionPublic }) {
  if (typeof name !== "string" || name.length < 1 || name.length > 60)
    throw new Error("Invalid device name");
  if (
    Object.values(db.devices).some(
      (device) => device.signingPublic === signingPublic,
    )
  )
    throw new Error("Device already registered");
  if (
    crypto.createPublicKey(signingPublic).asymmetricKeyType !== "ed25519" ||
    crypto.createPublicKey(encryptionPublic).asymmetricKeyType !== "x25519"
  )
    throw new Error("Invalid device keys");
  const deviceId = id();
  db.devices[deviceId] = { user, name, signingPublic, encryptionPublic };
  persist();
  return deviceId;
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    if (request.method === "GET" && url.pathname === "/health")
      return reply(response, 200, { ok: true });
    if (request.method === "POST" && url.pathname === "/api/register") {
      rateLimit(request);
      const { username, password } = await bodyJson(request);
      if (
        !/^[a-zA-Z0-9_.-]{3,40}$/.test(username || "") ||
        typeof password !== "string" ||
        password.length < 12
      )
        throw new Error(
          "Use a 3-40 character username and a password of at least 12 characters",
        );
      if (db.users[username]) throw new Error("Account already exists");
      db.users[username] = { password: passwordHash(password) };
      persist();
      return reply(response, 201, { ok: true });
    }
    if (request.method === "POST" && url.pathname === "/api/login") {
      rateLimit(request);
      const { username, password } = await bodyJson(request);
      if (
        !db.users[username] ||
        typeof password !== "string" ||
        !checkPassword(password, db.users[username].password)
      )
        return bad(response, "Invalid credentials", 401);
      const token = id() + id();
      sessions.set(token, {
        user: username,
        expires: Date.now() + 15 * 60_000,
      });
      return reply(response, 200, { token });
    }
    if (request.method === "POST" && url.pathname === "/api/devices") {
      const session = auth(request);
      if (session.deviceId) throw new Error("Account login required");
      return reply(response, 201, {
        deviceId: registerDevice(session.user, await bodyJson(request)),
      });
    }
    if (request.method === "POST" && url.pathname === "/api/enroll") {
      rateLimit(request);
      const { enrollmentKey, ...device } = await bodyJson(request);
      if (typeof enrollmentKey !== "string")
        return bad(response, "Invalid enrollment key", 401);
      const digest = crypto
        .createHash("sha256")
        .update(enrollmentKey)
        .digest("hex");
      const enrollment = enrollmentKeys.get(digest);
      if (!enrollment || enrollment.expires < Date.now())
        return bad(response, "Invalid or expired enrollment key", 401);
      const deviceId = registerDevice(enrollment.user, device);
      enrollmentKeys.delete(digest);
      return reply(response, 201, { deviceId });
    }
    if (request.method === "POST" && url.pathname === "/api/challenge") {
      rateLimit(request);
      const { deviceId } = await bodyJson(request);
      if (!db.devices[deviceId]) return bad(response, "Unknown device", 404);
      const nonce = id() + id();
      challenges.set(deviceId, { nonce, expires: Date.now() + 60_000 });
      return reply(response, 200, { nonce });
    }
    if (request.method === "POST" && url.pathname === "/api/device-auth") {
      rateLimit(request);
      const { deviceId, signature } = await bodyJson(request);
      const challenge = challenges.get(deviceId);
      challenges.delete(deviceId);
      if (
        !challenge ||
        challenge.expires < Date.now() ||
        !crypto.verify(
          null,
          Buffer.from(challenge.nonce),
          db.devices[deviceId].signingPublic,
          Buffer.from(signature || "", "base64"),
        )
      )
        return bad(response, "Invalid device signature", 401);
      const token = id() + id();
      sessions.set(token, {
        user: db.devices[deviceId].user,
        deviceId,
        expires: Date.now() + 24 * 60 * 60_000,
      });
      return reply(response, 200, { token });
    }
    const session = auth(request);
    if (!session.deviceId) throw new Error("Device authentication required");
    if (request.method === "GET" && url.pathname === "/api/devices")
      return reply(response, 200, {
        devices: visibleDevices(session.deviceId),
      });
    if (request.method === "POST" && url.pathname === "/api/enrollment-key") {
      const enrollmentKey = crypto.randomBytes(32).toString("base64url");
      const digest = crypto
        .createHash("sha256")
        .update(enrollmentKey)
        .digest("hex");
      enrollmentKeys.set(digest, {
        user: session.user,
        issuer: session.deviceId,
        expires: Date.now() + 10 * 60_000,
      });
      return reply(response, 201, { enrollmentKey, expiresInSeconds: 600 });
    }
    if (request.method === "POST" && url.pathname === "/api/endpoint") {
      const { port: peerPort, addresses } = await bodyJson(request);
      if (
        !Number.isInteger(peerPort) ||
        peerPort < 1024 ||
        peerPort > 65535 ||
        !Array.isArray(addresses)
      )
        throw new Error("Invalid endpoint");
      endpoints.set(
        session.deviceId,
        addresses
          .filter((address) => /^\d{1,3}(\.\d{1,3}){3}$/.test(address))
          .slice(0, 8)
          .map((address) => ({ address, port: peerPort })),
      );
      return reply(response, 200, { ok: true });
    }
    if (request.method === "POST" && url.pathname === "/api/invite") {
      const code = compactId();
      invites.set(code, {
        deviceId: session.deviceId,
        expires: Date.now() + 10 * 60_000,
      });
      return reply(response, 200, { code, expiresInSeconds: 600 });
    }
    if (request.method === "POST" && url.pathname === "/api/join") {
      rateLimit(request);
      const { code } = await bodyJson(request);
      const invite = invites.get(String(code || "").toUpperCase());
      if (
        !invite ||
        invite.expires < Date.now() ||
        invite.deviceId === session.deviceId
      )
        throw new Error("Invalid or expired pairing code");
      invites.delete(code.toUpperCase());
      if (!related(invite.deviceId, session.deviceId))
        db.pairs.push([invite.deviceId, session.deviceId]);
      persist();
      broadcastPresence(invite.deviceId);
      broadcastPresence(session.deviceId);
      return reply(response, 200, { paired: true });
    }
    if (request.method === "POST" && url.pathname === "/api/unpair") {
      const { deviceId } = await bodyJson(request);
      if (db.devices[deviceId]?.user === session.user)
        throw new Error("Use revoke for a device in your account");
      db.pairs = db.pairs.filter(
        (pair) => !(pair.includes(deviceId) && pair.includes(session.deviceId)),
      );
      persist();
      return reply(response, 200, { ok: true });
    }
    if (request.method === "POST" && url.pathname === "/api/revoke") {
      const { deviceId } = await bodyJson(request);
      if (
        deviceId === session.deviceId ||
        db.devices[deviceId]?.user !== session.user
      )
        throw new Error("Cannot revoke this device");
      delete db.devices[deviceId];
      db.pairs = db.pairs.filter((pair) => !pair.includes(deviceId));
      endpoints.delete(deviceId);
      for (const [key, value] of enrollmentKeys)
        if (value.issuer === deviceId) enrollmentKeys.delete(key);
      for (const [key, value] of invites)
        if (value.deviceId === deviceId) invites.delete(key);
      challenges.delete(deviceId);
      for (const [key, value] of sessions)
        if (value.deviceId === deviceId) sessions.delete(key);
      connections.get(deviceId)?.close();
      persist();
      return reply(response, 200, { ok: true });
    }
    return bad(response, "Not found", 404);
  } catch (error) {
    bad(
      response,
      error,
      error.message === "Authentication required" ? 401 : 400,
    );
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 1_000_000 });
server.on("upgrade", (request, socket, head) => {
  try {
    if (!request.url.startsWith("/") || request.url.startsWith("//")) {
      socket.destroy();
      return;
    }
    const url = new URL(request.url, "http://localhost");
    const session = sessions.get(
      request.headers.authorization?.replace(/^Bearer /, ""),
    );
    if (
      url.pathname !== "/relay" ||
      !session?.deviceId ||
      session.expires < Date.now()
    ) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) =>
      wss.emit("connection", ws, session),
    );
  } catch {
    socket.destroy();
  }
});
wss.on("connection", (socket, session) => {
  const { deviceId } = session;
  const expiryTimer = setTimeout(
    () => socket.close(1008, "Session expired"),
    Math.max(1, session.expires - Date.now()),
  );
  expiryTimer.unref();
  connections.get(deviceId)?.close();
  connections.set(deviceId, socket);
  broadcastPresence(deviceId);
  socket.on("message", (data) => {
    try {
      if (session.expires <= Date.now() || !db.devices[deviceId]) {
        socket.close(1008, "Authentication required");
        return;
      }
      const envelope = JSON.parse(data.toString());
      if (envelope.from !== deviceId || !related(deviceId, envelope.to)) return;
      const target = connections.get(envelope.to);
      if (
        target?.readyState === WebSocket.OPEN &&
        target.bufferedAmount < 4_000_000
      )
        target.send(data);
    } catch {
      /* Discard malformed relay frames. */
    }
  });
  socket.on("close", () => {
    clearTimeout(expiryTimer);
    if (connections.get(deviceId) === socket) {
      connections.delete(deviceId);
      broadcastPresence(deviceId);
    }
  });
});
server.listen(port, host, () =>
  console.log(`Discovery and relay listening on ${host}:${port}`),
);
