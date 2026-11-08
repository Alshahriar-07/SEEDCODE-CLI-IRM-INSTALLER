"use strict";

const { endpoint } = require("../../_lib/handler");
const { json, readBody, requireMethod, clientIp, rateLimit } = require("../../_lib/http");
const { exchangeAuthorizationCode, AuthError } = require("../../_lib/sessions");

module.exports = endpoint(async (req, res) => {
  if (!requireMethod(req, res, "POST")) return;
  if (!(await rateLimit("cli-token", clientIp(req), 30, 60)).ok) {
    throw new AuthError(429, "rate_limited", "Too many attempts. Wait a minute.");
  }
  const body = await readBody(req);
  const token = await exchangeAuthorizationCode({
    sessionId: body.session_id,
    deviceCode: body.device_code,
    code: body.authorization_code,
    codeVerifier: body.code_verifier,
  });
  json(res, 200, token, { "Cache-Control": "no-store, no-cache, must-revalidate" });
});
