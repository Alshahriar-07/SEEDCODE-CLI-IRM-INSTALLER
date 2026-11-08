"use strict";

const { endpoint } = require("../_lib/handler");
const { json, requireMethod } = require("../_lib/http");

const REQUIRED = [
  ["GITHUB_CLIENT_ID", () => process.env.GITHUB_CLIENT_ID],
  ["GITHUB_CLIENT_SECRET", () => process.env.GITHUB_CLIENT_SECRET],
  ["AUTH_SESSION_SECRET", () => process.env.AUTH_SESSION_SECRET],
  ["AUTH_ENCRYPTION_KEY", () => process.env.AUTH_ENCRYPTION_KEY],
  ["KV_REST_API_URL", () => process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL],
  ["KV_REST_API_TOKEN", () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN],
];

/** Configuration presence only: names of missing variables, never values. */
module.exports = endpoint(async (req, res) => {
  if (!requireMethod(req, res, "GET")) return;
  const base = (process.env.PUBLIC_BASE_URL || "https://seedcode-web.vercel.app").trim().replace(/\/+$/, "");
  const missing = REQUIRED.filter(([, read]) => !String(read() || "").trim()).map(([name]) => name);
  const rest = !missing.includes("KV_REST_API_URL") && !missing.includes("KV_REST_API_TOKEN");
  json(res, 200, {
    ok: true,
    ready: missing.length === 0,
    missing,
    store: rest ? "rest" : "memory",
    github_oauth_configured:
      !missing.includes("GITHUB_CLIENT_ID") && !missing.includes("GITHUB_CLIENT_SECRET"),
    cookie_secret_configured: !missing.includes("AUTH_SESSION_SECRET"),
    encryption_key_configured: !missing.includes("AUTH_ENCRYPTION_KEY"),
    base_url: base,
    github_callback_url: `${base}/api/auth/oauth/callback`,
    scopes: (process.env.GITHUB_OAUTH_SCOPES || "read:user").trim(),
  });
});
