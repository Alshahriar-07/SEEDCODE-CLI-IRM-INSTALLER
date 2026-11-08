"use strict";

const { endpoint } = require("../_lib/handler");
const {
  json,
  readBody,
  requireMethod,
  sameOrigin,
  parseCookies,
  clientIp,
  rateLimit,
} = require("../_lib/http");
const { safeEqual } = require("../_lib/crypto");
const { denySession, readBrowserSession, AuthError } = require("../_lib/sessions");

module.exports = endpoint(async (req, res) => {
  if (!requireMethod(req, res, "POST")) return;
  if (!sameOrigin(req)) {
    throw new AuthError(403, "bad_origin", "Deny from the SeedCode website.");
  }
  if (!(await rateLimit("deny", clientIp(req), 20, 60)).ok) {
    throw new AuthError(429, "rate_limited", "Too many attempts. Wait a minute.");
  }
  const cookies = parseCookies(req);
  const browser = readBrowserSession(cookies.sc_session);
  if (!browser) throw new AuthError(401, "sign_in_required", "Sign in with GitHub first.");
  const csrf = req.headers["x-seedcode-csrf"];
  if (!cookies.sc_csrf || !csrf || !safeEqual(cookies.sc_csrf, String(csrf))) {
    throw new AuthError(403, "csrf", "This request could not be verified.");
  }
  const body = await readBody(req);
  if (String(body.session_id || "") !== browser.sessionId) {
    throw new AuthError(403, "wrong_session", "The request is for a different terminal session.");
  }

  await denySession({ sessionId: browser.sessionId, githubId: browser.githubId });
  json(res, 200, {
    ok: true,
    status: "denied",
    redirect: `/auth/denied?session=${encodeURIComponent(browser.sessionId)}`,
  });
});
