"use strict";

const { endpoint } = require("../_lib/handler");
const { json, readBody, requireMethod, clientIp, rateLimit } = require("../_lib/http");
const { findByUserCode, AuthError } = require("../_lib/sessions");

module.exports = endpoint(async (req, res) => {
  if (!requireMethod(req, res, "POST")) return;
  // Guessing a device code is pointless at this rate, and the session still
  // requires a GitHub sign-in before it can be approved.
  if (!(await rateLimit("lookup", clientIp(req), 10, 60)).ok) {
    throw new AuthError(429, "rate_limited", "Too many attempts. Wait a minute.");
  }
  const body = await readBody(req);
  const sessionId = await findByUserCode(body.code);
  json(res, 200, { session_id: sessionId });
});
