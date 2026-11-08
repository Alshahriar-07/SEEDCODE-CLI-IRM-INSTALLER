"use strict";

const crypto = require("./crypto");
const config = require("./config");
const github = require("./github");
const { getJson, putJson, takeJson, remove, lock, unlock } = require("./store");

class AuthError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// No 0/O/1/I: the code is read from a terminal and typed on a phone or laptop.
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SESSION_ID = /^[A-Za-z0-9_-]{20,64}$/;
const PKCE = /^[A-Za-z0-9_-]{43,128}$/;

function now() {
  return Math.floor(Date.now() / 1000);
}

function newUserCode() {
  const bytes = crypto.randomBytes(8);
  const chars = [...bytes].map((byte) => USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

function normalizeUserCode(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^(.{4})(.+)$/, "$1-$2");
}

function ensureSessionId(value) {
  const id = String(value || "").trim();
  if (!SESSION_ID.test(id)) throw new AuthError(400, "invalid_session", "Invalid session identifier.");
  return id;
}

function isExpired(record) {
  return !record || Number(record.expires_at || 0) <= now();
}

async function createCliSession({ clientName, clientVersion, os, codeChallenge }) {
  if (!PKCE.test(String(codeChallenge || ""))) {
    throw new AuthError(400, "invalid_pkce", "A valid PKCE code challenge is required.");
  }
  const sessionId = crypto.randomToken(24);
  const deviceCode = crypto.randomToken(32);
  let userCode = "";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = newUserCode();
    const claimed = await require("./store").store().setNx(
      `sc:usercode:${candidate.replace("-", "")}`,
      sessionId,
      config.sessionTtl
    );
    if (claimed) {
      userCode = candidate;
      break;
    }
  }
  if (!userCode) throw new AuthError(503, "code_unavailable", "Could not allocate a device code.");

  const record = {
    id: sessionId,
    status: "pending",
    created_at: now(),
    expires_at: now() + config.sessionTtl,
    interval: config.pollInterval,
    device_code_hash: crypto.sha256(deviceCode),
    pkce_challenge: String(codeChallenge),
    client: {
      name: String(clientName || "SeedCode CLI").slice(0, 80),
      version: String(clientVersion || "").slice(0, 40),
      os: String(os || "").slice(0, 60),
    },
    github: null,
    github_token_enc: null,
    approved_at: null,
  };
  await putJson(`session:${sessionId}`, record, config.sessionTtl);

  const base = config.baseUrl;
  return {
    session_id: sessionId,
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: `${base}/auth/`,
    verification_uri_complete: `${base}/auth/?code=${encodeURIComponent(userCode)}`,
    expires_at: record.expires_at,
    interval: record.interval,
  };
}

async function findByUserCode(code) {
  const normalized = normalizeUserCode(code);
  if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(normalized)) {
    throw new AuthError(400, "invalid_code", "Enter the code shown in your terminal (XXXX-XXXX).");
  }
  const raw = await require("./store").store().get(
    `sc:usercode:${normalized.replace("-", "")}`
  );
  if (!raw) throw new AuthError(404, "not_found", "That code is not pending. Start a new login.");
  const record = await getJson(`session:${raw}`);
  if (isExpired(record) || record.status !== "pending") {
    throw new AuthError(410, "expired", "That code has expired. Start a new login from the CLI.");
  }
  return record.id;
}

async function getSession(sessionId) {
  return getJson(`session:${ensureSessionId(sessionId)}`);
}

async function verifyDevice(record, deviceCode) {
  if (!record || !deviceCode) return false;
  return crypto.safeEqual(crypto.sha256(String(deviceCode)), record.device_code_hash);
}

async function pollSession({ sessionId, deviceCode }) {
  const id = ensureSessionId(sessionId);
  const record = await getSession(id);
  if (!record || !(await verifyDevice(record, deviceCode))) {
    throw new AuthError(401, "invalid_session", "Session or device code is invalid.");
  }
  if (isExpired(record) || record.status === "expired") {
    await remove(`session:${id}`);
    return { status: "expired" };
  }
  if (record.status === "denied") return { status: "denied" };
  if (record.status === "approved") {
    return { status: "approved", github: record.github };
  }
  return { status: "pending", interval: record.interval };
}

async function browserSession(sessionId, githubAccount) {
  if (!githubAccount) return null;
  return crypto.signJson({
    sid: sessionId,
    ghid: String(githubAccount.id),
    exp: now() + 900,
  });
}

function readBrowserSession(raw) {
  const payload = crypto.verifySignedJson(raw);
  if (!payload || !payload.sid || !payload.ghid) return null;
  if (Number(payload.exp || 0) <= now()) return null;
  return { sessionId: ensureSessionId(payload.sid), githubId: String(payload.ghid) };
}

/**
 * Begin the browser leg: bind a single-use OAuth state to one pending CLI
 * session. The PKCE verifier never leaves the server.
 */
async function startOAuth(sessionId) {
  const id = ensureSessionId(sessionId);
  const record = await getSession(id);
  if (!record || isExpired(record)) {
    throw new AuthError(410, "expired", "This terminal session has expired. Start again from the CLI.");
  }
  if (record.status !== "pending") {
    throw new AuthError(409, "not_pending", "This terminal session is no longer awaiting approval.");
  }
  const state = crypto.randomToken(24);
  const verifier = crypto.randomToken(48);
  const challenge = crypto.pkceChallenge(verifier);
  await putJson(`oauth:${state}`, { sid: id, verifier, exp: now() + 600 }, 600);
  return {
    state,
    authorizeUrl: github.authorizeUrl(state, challenge),
    cookie: crypto.signJson({ state, sid: id, exp: now() + 600 }),
  };
}

/** Session id remembered in the signed OAuth cookie (used for retry links only). */
function oauthCookieSession(cookie) {
  const payload = crypto.verifySignedJson(cookie);
  if (!payload || !payload.sid) return "";
  return SESSION_ID.test(String(payload.sid)) ? String(payload.sid) : "";
}

/** What the approval page tells the person, derived from the real OAuth scope. */
function permissionsFor(scope) {
  const granted = String(scope || "").split(/[\s,]+/).filter(Boolean);
  const list = ["Read your GitHub profile (login, name and avatar)"];
  if (granted.includes("user:email") || granted.includes("user")) {
    list.push("Read your GitHub email addresses");
  }
  list.push("Authorize this terminal session to use GitHub Copilot");
  const repoAccess = granted.some(
    (item) => item === "repo" || item.startsWith("repo:") || item === "public_repo"
  );
  if (!repoAccess) list.push("No repository access is requested or granted");
  return list;
}

async function completeOAuth({ code, state, cookie }) {
  const cookiePayload = crypto.verifySignedJson(cookie);
  if (!cookiePayload || !cookiePayload.state) {
    throw new AuthError(400, "missing_state", "OAuth state cookie is missing. Start the login again.");
  }
  if (!crypto.safeEqual(cookiePayload.state, String(state || ""))) {
    throw new AuthError(400, "state_mismatch", "OAuth state did not match. Start the login again.");
  }
  if (Number(cookiePayload.exp || 0) <= now()) {
    throw new AuthError(410, "expired", "The login took too long. Start the login again.");
  }
  const pending = await takeJson(`oauth:${state}`);
  if (!pending || Number(pending.exp || 0) <= now()) {
    throw new AuthError(400, "invalid_state", "OAuth state is invalid or already used.");
  }
  const token = await github.exchangeCode(String(code || ""), pending.verifier);
  const account = await github.fetchUser(token.accessToken);

  const record = await getSession(pending.sid);
  if (!record || isExpired(record) || record.status !== "pending") {
    throw new AuthError(410, "expired", "The terminal session expired before GitHub finished.");
  }

  record.github = account;
  record.github_token_enc = crypto.encrypt(token.accessToken);
  record.oauth_scope = token.scope;
  record.oauth_token_type = token.tokenType;
  await putJson(`session:${pending.sid}`, record, Math.max(30, record.expires_at - now()));
  return { sessionId: pending.sid, account };
}

/** The one-time code for an approved session, returned only to the CLI that
 * proved its device code. */
async function authorizationCodeFor(sessionId) {
  const pending = await getJson(`code:${ensureSessionId(sessionId)}`);
  if (!pending || Number(pending.exp || 0) <= now()) return null;
  return crypto.decrypt(pending.code_enc);
}

async function approveSession({ sessionId, githubId }) {
  const id = ensureSessionId(sessionId);
  const acquired = await lock(`approve:${id}`);
  if (!acquired) throw new AuthError(409, "busy", "Approval is already in progress. Try again.");
  try {
    const record = await getSession(id);
    if (!record) throw new AuthError(404, "not_found", "Unknown terminal session.");
    if (isExpired(record)) throw new AuthError(410, "expired", "This terminal session has expired.");
    if (!record.github || String(record.github.id) !== String(githubId)) {
      throw new AuthError(403, "unauthorized", "Sign in with GitHub before approving this session.");
    }
    if (record.status === "approved") {
      throw new AuthError(409, "already_approved", "This terminal session was already approved.");
    }
    if (record.status !== "pending") {
      throw new AuthError(409, "not_pending", "This terminal session cannot be approved.");
    }
    // The plaintext code is delivered only over the device-code-authenticated
    // poll; at rest it is encrypted and short-lived.
    const code = crypto.randomToken(32);
    await putJson(
      `code:${id}`,
      { code_enc: crypto.encrypt(code), exp: now() + config.codeTtl },
      config.codeTtl
    );
    record.status = "approved";
    record.approved_at = now();
    await putJson(`session:${id}`, record, Math.max(30, record.expires_at - now()));
    return { status: "approved" };
  } finally {
    await unlock(`approve:${id}`);
  }
}

async function denySession({ sessionId, githubId }) {
  const id = ensureSessionId(sessionId);
  const acquired = await lock(`deny:${id}`);
  if (!acquired) throw new AuthError(409, "busy", "A decision is already in progress.");
  try {
    const record = await getSession(id);
    if (!record) throw new AuthError(404, "not_found", "Unknown terminal session.");
    if (!record.github || String(record.github.id) !== String(githubId)) {
      throw new AuthError(403, "unauthorized", "Sign in with GitHub before denying this session.");
    }
    if (record.status === "approved") {
      throw new AuthError(409, "already_approved", "This terminal session was already approved.");
    }
    record.status = "denied";
    record.github_token_enc = null;
    await putJson(`session:${id}`, record, Math.max(30, record.expires_at - now()));
    await remove(`code:${id}`);
    return { status: "denied" };
  } finally {
    await unlock(`deny:${id}`);
  }
}

/**
 * One-time handoff: the CLI proves the device code, the one-time authorization
 * code and the PKCE verifier. The code is consumed atomically, so a replay or a
 * duplicate approval cannot mint a second token.
 */
async function exchangeAuthorizationCode({ sessionId, deviceCode, code, codeVerifier }) {
  const id = ensureSessionId(sessionId);
  const record = await getSession(id);
  if (!record || !(await verifyDevice(record, deviceCode))) {
    throw new AuthError(401, "invalid_session", "Session or device code is invalid.");
  }
  if (isExpired(record)) throw new AuthError(410, "expired", "This terminal session has expired.");
  if (record.status !== "approved") {
    throw new AuthError(409, "not_approved", "The terminal session has not been approved yet.");
  }
  if (crypto.pkceChallenge(String(codeVerifier || "")) !== record.pkce_challenge) {
    throw new AuthError(400, "invalid_pkce", "PKCE verification failed.");
  }
  const pending = await getJson(`code:${id}`);
  if (!pending || Number(pending.exp || 0) <= now()) {
    throw new AuthError(410, "code_expired", "The authorization code expired. Start a new login.");
  }
  if (!crypto.safeEqual(crypto.decrypt(pending.code_enc), String(code || ""))) {
    throw new AuthError(400, "invalid_code", "The authorization code is invalid.");
  }
  const consumed = await takeJson(`code:${id}`);
  if (!consumed) {
    throw new AuthError(409, "replayed", "This authorization code was already used.");
  }
  if (!crypto.safeEqual(crypto.decrypt(consumed.code_enc), String(code || ""))) {
    throw new AuthError(409, "replayed", "This authorization code was already used.");
  }
  if (!record.github_token_enc) {
    throw new AuthError(409, "no_token", "No GitHub credential is available for this session.");
  }
  const accessToken = crypto.decrypt(record.github_token_enc);

  // The token is handed over exactly once; the session cannot mint another.
  record.github_token_enc = null;
  record.status = "consumed";
  await putJson(`session:${id}`, record, 60);

  return {
    access_token: accessToken,
    token_type: "bearer",
    scope: record.oauth_scope || "",
    github: record.github,
  };
}

module.exports = {
  AuthError,
  createCliSession,
  findByUserCode,
  getSession,
  pollSession,
  startOAuth,
  completeOAuth,
  oauthCookieSession,
  permissionsFor,
  approveSession,
  denySession,
  exchangeAuthorizationCode,
  authorizationCodeFor,
  browserSession,
  readBrowserSession,
  normalizeUserCode,
};
