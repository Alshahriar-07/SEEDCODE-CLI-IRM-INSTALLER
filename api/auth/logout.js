"use strict";

const { endpoint } = require("../_lib/handler");
const {
  json,
  requireMethod,
  sameOrigin,
  clearCookie,
} = require("../_lib/http");
const { AuthError } = require("../_lib/sessions");

module.exports = endpoint(async (req, res) => {
  if (!requireMethod(req, res, "POST")) return;
  if (!sameOrigin(req)) throw new AuthError(403, "bad_origin", "Log out from the SeedCode website.");
  res.setHeader("Set-Cookie", [clearCookie("sc_session"), clearCookie("sc_csrf")]);
  json(res, 200, { ok: true });
});
