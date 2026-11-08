"use strict";

const { endpoint } = require("../_lib/handler");
const {
  json,
  requireMethod,
  parseCookies,
  serializeCookie,
  csrfToken,
} = require("../_lib/http");
const { getSession, readBrowserSession, permissionsFor, AuthError } = require("../_lib/sessions");

module.exports = endpoint(async (req, res) => {
  if (!requireMethod(req, res, "GET")) return;
  const url = new URL(req.url, "https://placeholder.invalid");
  const sessionId = url.searchParams.get("session");
  if (!sessionId) throw new AuthError(400, "missing_session", "No terminal session was provided.");

  const cookies = parseCookies(req);
  const browser = readBrowserSession(cookies.sc_session);
  if (!browser || browser.sessionId !== sessionId) {
    throw new AuthError(401, "sign_in_required", "Sign in with GitHub to view this terminal request.");
  }
  const record = await getSession(sessionId);
  if (!record) throw new AuthError(404, "not_found", "Unknown terminal session.");
  if (!record.github || String(record.github.id) !== browser.githubId) {
    throw new AuthError(403, "unauthorized", "This session belongs to another GitHub account.");
  }

  let csrf = cookies.sc_csrf;
  if (!csrf) {
    csrf = csrfToken();
    res.setHeader(
      "Set-Cookie",
      serializeCookie("sc_csrf", csrf, {
        maxAge: 900,
        httpOnly: false,
        sameSite: "Strict",
      })
    );
  }

  json(res, 200, {
    session_id: record.id,
    status: record.status,
    created_at: record.created_at,
    expires_at: record.expires_at,
    client: record.client,
    github: record.github,
    permissions: permissionsFor(record.oauth_scope),
    csrf_token: csrf,
  });
});
