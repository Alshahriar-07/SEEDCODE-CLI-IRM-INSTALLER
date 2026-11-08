"use strict";

const crypto = require("node:crypto");
const config = require("./config");

const B64 = "base64url";

function b64url(input) {
  return Buffer.from(input).toString(B64);
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString(B64);
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest(B64);
}

function hmac(value) {
  return crypto.createHmac("sha256", config.cookieSecret).update(String(value)).digest(B64);
}

/** Constant-time comparison of two strings (hashing hides length differences). */
function safeEqual(left, right) {
  const a = crypto.createHash("sha256").update(String(left)).digest();
  const b = crypto.createHash("sha256").update(String(right)).digest();
  return crypto.timingSafeEqual(a, b);
}

/** PKCE S256, the only challenge method GitHub accepts. */
function pkceChallenge(verifier) {
  return crypto.createHash("sha256").update(verifier).digest(B64);
}

function encryptionKey() {
  const raw = config.encryptionKey.trim();
  let key;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) key = Buffer.from(raw, "hex");
  else key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("AUTH_ENCRYPTION_KEY must be 32 bytes (base64 or 64 hex characters)");
  }
  return key;
}

/** AES-256-GCM at rest. The GitHub token is never stored in plaintext. */
function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString(B64)}.${tag.toString(B64)}.${ciphertext.toString(B64)}`;
}

function decrypt(payload) {
  const parts = String(payload).split(".");
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("Unsupported ciphertext");
  const iv = Buffer.from(parts[1], B64);
  const tag = Buffer.from(parts[2], B64);
  const data = Buffer.from(parts[3], B64);
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/** Signed, URL-safe cookie payload: `<base64url(json)>.<hmac>`. */
function signJson(value) {
  const body = b64url(JSON.stringify(value));
  return `${body}.${hmac(body)}`;
}

function verifySignedJson(token) {
  const [body, signature] = String(token || "").split(".");
  if (!body || !signature) return null;
  if (!safeEqual(signature, hmac(body))) return null;
  try {
    return JSON.parse(Buffer.from(body, B64).toString("utf8"));
  } catch {
    return null;
  }
}

module.exports = {
  b64url,
  randomBytes: (size) => crypto.randomBytes(size),
  randomToken,
  sha256,
  hmac,
  safeEqual,
  pkceChallenge,
  encrypt,
  decrypt,
  signJson,
  verifySignedJson,
};
