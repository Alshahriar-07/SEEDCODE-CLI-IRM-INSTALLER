"use strict";

const { endpoint } = require("../../_lib/handler");
const {
  json,
  redirect,
  clientIp,
  rateLimit,
  parseCookies,
  serializeCookie,
  clearCookie,
  csrfToken,
} = require("../../_lib/http");
const {
  completeOAuth,
  browserSession,
  oauthCookieSession,
  AuthError,
} = require("../../_lib/sessions");

/** Back to the login page, keeping the terminal session so the person can retry. */
function failTo(res, sessionId, reason) {
  const query = new URLSearchParams();
  if (sessionId) query.set("session", sessionId);
  query.set("error", reason);
  res.setHeader("Set-Cookie", clearCookie("sc_oauth"));
  redirect(res, `/auth/login?${query.toString()}`);
}

module.exports = endpoint(async (req, res) => {
  if (req.method !== "GET") {
    json(res, 405, { error: "method_not_allowed", message: "Use GET." });
    return;
  }
  if (!(await rateLimit("oauth-callback", clientIp(req), 20, 60)).ok) {
    throw new AuthError(429, "rate_limited", "Too many attempts. Wait a minute.");
  }
  const url = new URL(req.url, "https://placeholder.invalid");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookie = parseCookies(req).sc_oauth;
  const sessionId = oauthCookieSession(cookie);

  if (url.searchParams.get("error")) {
    failTo(res, sessionId, "oauth_denied");
    return;
  }
  if (!code || !state) {
    failTo(res, sessionId, "oauth_missing");
    return;
  }
  try {
    const { sessionId: approvedSession, account } = await completeOAuth({ code, state, cookie });
    const browser = await browserSession(approvedSession, account);
    res.setHeader("Set-Cookie", [
      serializeCookie("sc_session", browser, {
        maxAge: 900,
        httpOnly: true,
        sameSite: "Lax",
      }),
      serializeCookie("sc_csrf", csrfToken(), { maxAge: 900, httpOnly: false, sameSite: "Strict" }),
      clearCookie("sc_oauth"),
    ]);
    redirect(res, `/auth/approve?session=${encodeURIComponent(approvedSession)}`);
  } catch (error) {
    const reason = error instanceof AuthError ? error.code : "oauth_failed";
    failTo(res, sessionId, reason);
  }
});
