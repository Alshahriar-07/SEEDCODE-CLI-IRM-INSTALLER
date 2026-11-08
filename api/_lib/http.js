"use strict";

const crypto = require("node:crypto");
const config = require("./config");
const { store } = require("./store");

function json(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  res.end(payload);
}

function redirect(res, location) {
  if (!isAllowedRedirect(location)) {
    json(res, 500, { error: "invalid_redirect", message: "Redirect target is not allowed." });
    return;
  }
  res.statusCode = 302;
  res.setHeader("Location", location);
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.end();
}

/** Redirect to a fixed external origin (GitHub's authorization page). */
function redirectExternal(res, location, allowedHosts) {
  let target;
  try {
    target = new URL(location);
  } catch {
    json(res, 500, { error: "invalid_redirect", message: "Invalid redirect target." });
    return;
  }
  if (!allowedHosts.includes(target.host)) {
    json(res, 500, { error: "invalid_redirect", message: "Redirect target is not allowed." });
    return;
  }
  res.statusCode = 302;
  res.setHeader("Location", target.toString());
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.end();
}

function isAllowedRedirect(location) {
  try {
    const target = new URL(location, config.baseUrl);
    return target.origin === config.baseUrl;
  } catch {
    return false;
  }
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    if (req.body.length > 16_384) throw new Error("body_too_large");
    return req.body ? JSON.parse(req.body) : {};
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 16_384) {
        reject(new Error("body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded) return forwarded.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

function requireMethod(req, res, allowed) {
  if (req.method === allowed) return true;
  res.setHeader("Allow", allowed);
  json(res, 405, { error: "method_not_allowed", message: `Use ${allowed}.` });
  return false;
}

/** State-changing requests must come from the site's own origin. */
function sameOrigin(req) {
  const source = req.headers.origin || req.headers.referer || "";
  if (!source) return false;
  try {
    return config.allowedOrigins.has(new URL(source).origin);
  } catch {
    return false;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const cookies = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      // A malformed cookie must not turn every auth request into a 500. Treat
      // it as absent so the normal sign-in-required path runs instead.
      continue;
    }
  }
  return cookies;
}

function serializeCookie(name, value, options = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path || "/"}`];
  bits.push(`Max-Age=${options.maxAge ?? 600}`);
  if (options.httpOnly !== false) bits.push("HttpOnly");
  if (options.secure ?? config.cookieSecure) bits.push("Secure");
  bits.push(`SameSite=${options.sameSite || "Lax"}`);
  return bits.join("; ");
}

function clearCookie(name) {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${
    config.cookieSecure ? "; Secure" : ""
  }`;
}

function csrfToken() {
  return crypto.randomBytes(24).toString("base64url");
}

async function rateLimit(bucket, subject, limit, windowSeconds) {
  const key = `rate:${bucket}:${subject}`;
  const count = await store().incr(key);
  if (count === 1) await store().expire(key, windowSeconds);
  return { ok: count <= limit, remaining: Math.max(0, limit - count) };
}

module.exports = {
  json,
  redirect,
  redirectExternal,
  isAllowedRedirect,
  readBody,
  clientIp,
  requireMethod,
  sameOrigin,
  parseCookies,
  serializeCookie,
  clearCookie,
  csrfToken,
  rateLimit,
};
