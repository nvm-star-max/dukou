import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const id = () => crypto.randomBytes(16).toString("hex");
export const compactId = () =>
  crypto.randomBytes(6).toString("base64url").toUpperCase();

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export async function bodyJson(request, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("Request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export function reply(response, status, data) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(data));
}

export function bad(response, error, status = 400) {
  reply(response, status, {
    error: error instanceof Error ? error.message : String(error),
  });
}

export function passwordHash(
  password,
  salt = crypto.randomBytes(16).toString("hex"),
) {
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString("hex")}`;
}

export function checkPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  return crypto.timingSafeEqual(
    Buffer.from(hash, "hex"),
    Buffer.from(passwordHash(password, salt).split(":")[1], "hex"),
  );
}

export function publicFingerprint(publicKey) {
  return crypto
    .createHash("sha256")
    .update(publicKey)
    .digest("hex")
    .match(/.{1,4}/g)
    .slice(0, 8)
    .join("-");
}

export function makeKeys() {
  const signing = crypto.generateKeyPairSync("ed25519");
  const encryption = crypto.generateKeyPairSync("x25519");
  return {
    signingPrivate: signing.privateKey.export({ format: "pem", type: "pkcs8" }),
    signingPublic: signing.publicKey.export({ format: "pem", type: "spki" }),
    encryptionPrivate: encryption.privateKey.export({
      format: "pem",
      type: "pkcs8",
    }),
    encryptionPublic: encryption.publicKey.export({
      format: "pem",
      type: "spki",
    }),
  };
}

function sharedKey(privateKey, publicKey) {
  const secret = crypto.diffieHellman({
    privateKey: crypto.createPrivateKey(privateKey),
    publicKey: crypto.createPublicKey(publicKey),
  });
  return crypto.hkdfSync(
    "sha256",
    secret,
    Buffer.alloc(0),
    Buffer.from("open-transfer-demo-v1"),
    32,
  );
}

export function seal(message, from, to, ownPrivate, peerPublic) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    sharedKey(ownPrivate, peerPublic),
    nonce,
  );
  cipher.setAAD(Buffer.from(`${from}:${to}`));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(message)),
    cipher.final(),
  ]);
  return {
    from,
    to,
    nonce: nonce.toString("base64"),
    ciphertext: encrypted.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

export function open(envelope, ownPrivate, peerPublic) {
  const nonce = canonicalBase64(envelope.nonce, 12);
  const tag = canonicalBase64(envelope.tag, 16);
  const ciphertext = canonicalBase64(envelope.ciphertext);
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    sharedKey(ownPrivate, peerPublic),
    nonce,
  );
  decipher.setAAD(Buffer.from(`${envelope.from}:${envelope.to}`));
  decipher.setAuthTag(tag);
  return JSON.parse(
    Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
      "utf8",
    ),
  );
}

export function canonicalBase64(value, bytes) {
  if (typeof value !== "string" || value.length > 1_000_000)
    throw new Error("Invalid Base64 encoding");
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.toString("base64") !== value ||
    (bytes !== undefined && decoded.length !== bytes)
  )
    throw new Error("Invalid Base64 encoding");
  return decoded;
}

export function safeName(value) {
  const name = path
    .basename(String(value).replaceAll("\\", "/"))
    .replace(/[\x00-\x1f<>:"|?*]/g, "_");
  if (!name || name === "." || name === "..")
    throw new Error("Invalid file name");
  if (Buffer.byteLength(name, "utf8") > 255)
    throw new Error("File name exceeds 255 bytes");
  return name;
}

export function relativePath(value) {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    path.isAbsolute(value)
  )
    throw new Error("Invalid path");
  const parts = value.split(/[\\/]/).filter(Boolean);
  if (parts.some((part) => part === "." || part === ".."))
    throw new Error("Invalid path");
  return parts.join("/");
}

export async function containedFile(root, requested, type) {
  const relative = relativePath(requested);
  const actualRoot = await fs.promises.realpath(root);
  const actual = await fs.promises.realpath(path.join(actualRoot, relative));
  const within = path.relative(actualRoot, actual);
  if (
    within === ".." ||
    within.startsWith(`..${path.sep}`) ||
    path.isAbsolute(within)
  )
    throw new Error("Path outside shared directory");
  const stats = await fs.promises.stat(actual);
  if (type === "file" && !stats.isFile()) throw new Error("Not a file");
  if (type === "directory" && !stats.isDirectory())
    throw new Error("Not a directory");
  return { actual, stats };
}

export async function revealFile(file) {
  if (process.platform === "darwin") {
    await execFileAsync("open", ["-R", file]);
  } else if (process.platform === "win32") {
    await execFileAsync("explorer.exe", [`/select,${file}`]);
  } else {
    await execFileAsync("xdg-open", [path.dirname(file)]);
  }
}
