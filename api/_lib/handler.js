"use strict";

const { json } = require("./http");
const { AuthError } = require("./sessions");

/** Wrap an endpoint: one JSON error shape, no secrets or stack traces leak. */
function endpoint(fn) {
  return async function handler(req, res) {
    try {
      await fn(req, res);
    } catch (error) {
      if (error instanceof AuthError) {
        json(res, error.status, { error: error.code, message: error.message });
        return;
      }
      const message = String(error && error.message ? error.message : error);
      // Deliberately generic to the client; details stay in the server log.
      console.error("[seedcode-auth]", message.replace(/token=[^&\s]+/g, "token=[redacted]"));
      json(res, 500, {
        error: "server_error",
        message: "Authentication is temporarily unavailable. Try again.",
      });
    }
  };
}

module.exports = { endpoint };
