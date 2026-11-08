"use strict";

const { endpoint } = require("../../_lib/handler");
const { json, readBody, requireMethod, clientIp, rateLimit } = require("../../_lib/http");
const { pollSession, authorizationCodeFor, AuthError } = require("../../_lib/sessions");
const { store } = require("../../_lib/store");

module.exports = endpoint(async (req, res) => {
  if (!requireMethod(req, res, "POST")) return;
  const body = await readBody(req);
  const sessionId = String(body.session_id || "").slice(0, 64);
  if (!(await rateLimit("cli-poll", `${clientIp(req)}:${sessionId}`, 60, 60)).ok) {
    throw new AuthError(429, "rate_limited", "Polling too quickly.");
  }
  // A minimum gap stops a hot loop from hammering the store.
  if (!(await store().setNx(`sc:pollat:${sessionId}`, "1", 3))) {
    json(res, 429, { error: "slow_down", message: "Poll again shortly.", retry_after: 3 });
    return;
  }
  const result = await pollSession({
    sessionId: body.session_id,
    deviceCode: body.device_code,
  });
  if (result.status === "approved") {
    const code = await authorizationCodeFor(sessionId);
    if (!code) {
      throw new AuthError(410, "code_expired", "Approval expired. Start a new login.");
    }
    // The CLI exchanges this code (plus device code and PKCE verifier) for the
    // GitHub token. Polling alone never returns a credential.
    json(res, 200, { ...result, authorization_code: code });
    return;
  }
  json(res, 200, result);
});
