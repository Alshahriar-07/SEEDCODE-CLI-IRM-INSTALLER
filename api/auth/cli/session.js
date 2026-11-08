"use strict";

const { endpoint } = require("../../_lib/handler");
const { json, readBody, requireMethod, clientIp, rateLimit } = require("../../_lib/http");
const { createCliSession, AuthError } = require("../../_lib/sessions");

module.exports = endpoint(async (req, res) => {
  if (!requireMethod(req, res, "POST")) return;
  if (!(await rateLimit("cli-session", clientIp(req), 10, 60)).ok) {
    throw new AuthError(429, "rate_limited", "Too many login attempts. Wait a minute.");
  }
  const body = await readBody(req);
  const session = await createCliSession({
    clientName: body.client_name,
    clientVersion: body.client_version,
    os: body.os,
    codeChallenge: body.code_challenge,
  });
  json(res, 201, session);
});
