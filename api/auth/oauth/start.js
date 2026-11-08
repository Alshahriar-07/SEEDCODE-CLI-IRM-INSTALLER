"use strict";

const { endpoint } = require("../../_lib/handler");
const {
  requireMethod,
  clientIp,
  rateLimit,
  parseCookies,
  serializeCookie,
  redirectExternal,
} = require("../../_lib/http");
const { startOAuth, AuthError } = require("../../_lib/sessions");

module.exports = endpoint(async (req, res) => {
  if (!requireMethod(req, res, "GET")) return;
  if (!(await rateLimit("oauth-start", clientIp(req), 20, 60)).ok) {
    throw new AuthError(429, "rate_limited", "Too many login attempts. Wait a minute.");
  }
  const url = new URL(req.url, "https://placeholder.invalid");
  const sessionId = url.searchParams.get("session");
  if (!sessionId) throw new AuthError(400, "missing_session", "Start the login from the CLI.");

  const { authorizeUrl, cookie } = await startOAuth(sessionId);
  res.setHeader(
    "Set-Cookie",
    serializeCookie("sc_oauth", cookie, { maxAge: 600, httpOnly: true, sameSite: "Lax" })
  );
  redirectExternal(res, authorizeUrl, ["github.com"]);
});
