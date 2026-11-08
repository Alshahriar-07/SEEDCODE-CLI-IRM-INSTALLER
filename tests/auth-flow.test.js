"use strict";

/**
 * Server-side flow tests with a mocked GitHub identity provider.
 *
 * This is not an end-to-end test against GitHub: it proves the session,
 * approval, one-time-code and replay rules implemented in this repository.
 * Real OAuth needs registered credentials and a deployment.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

process.env.NODE_ENV = "test";
process.env.AUTH_ALLOW_MEMORY_STORE = "1";
process.env.PUBLIC_BASE_URL = "https://seedcode-web.vercel.app";
process.env.GITHUB_CLIENT_ID = "test-client-id";
process.env.GITHUB_CLIENT_SECRET = "test-client-secret";
process.env.AUTH_SESSION_SECRET = "x".repeat(48);
process.env.AUTH_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");

const base = process.env.PUBLIC_BASE_URL;
const realFetch = globalThis.fetch;
let githubUser = { id: 42, login: "octocat", name: "The Octocat", avatar_url: "https://avatars.githubusercontent.com/u/42", html_url: "https://github.com/octocat" };

globalThis.fetch = async (input, init = {}) => {
  const href = typeof input === "string" ? input : input.url;
  if (href === "https://github.com/login/oauth/access_token") {
    return new Response(JSON.stringify({ access_token: "gho_test_token", token_type: "bearer", scope: "read:user" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (href === "https://api.github.com/user") {
    return new Response(JSON.stringify(githubUser), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return realFetch(input, init);
};

const handlers = {
  create: require("../api/auth/cli/session"),
  poll: require("../api/auth/cli/poll"),
  token: require("../api/auth/cli/token"),
  start: require("../api/auth/oauth/start"),
  callback: require("../api/auth/oauth/callback"),
  lookup: require("../api/auth/lookup"),
  session: require("../api/auth/session"),
  approve: require("../api/auth/approve"),
  deny: require("../api/auth/deny"),
  logout: require("../api/auth/logout"),
};

function makeReq({ method = "GET", url = "/", headers = {}, body = null }) {
  const req = {
    method,
    url,
    headers: { origin: base, host: "seedcode-web.vercel.app", ...headers },
    socket: { remoteAddress: "203.0.113.7" },
  };
  if (body !== null) req.body = body;
  return req;
}

function makeRes() {
  const out = { status: 0, headers: {}, body: "" };
  const res = {
    statusCode: 200,
    setHeader(name, value) {
      out.headers[name.toLowerCase()] = value;
    },
    end(chunk = "") {
      out.status = res.statusCode;
      out.body = String(chunk);
      out.done = true;
    },
  };
  return { res, out };
}

async function call(handler, req) {
  const { res, out } = makeRes();
  await handler(req, res);
  let json = null;
  try {
    json = out.body ? JSON.parse(out.body) : null;
  } catch {
    json = null;
  }
  return { ...out, json };
}

function setCookies(response) {
  const raw = response.headers["set-cookie"];
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

function cookieJar() {
  const jar = new Map();
  return {
    absorb(response) {
      for (const header of setCookies(response)) {
        const [pair] = header.split(";");
        const index = pair.indexOf("=");
        const name = pair.slice(0, index).trim();
        const value = pair.slice(index + 1).trim();
        if (!value) jar.delete(name);
        else jar.set(name, decodeURIComponent(value));
      }
    },
    header() {
      return [...jar.entries()].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
    },
    get(name) {
      return jar.get(name);
    },
  };
}

function verifier() {
  return crypto.randomBytes(48).toString("base64url");
}

function challenge(value) {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

async function newSession(jar = cookieJar()) {
  const pkce = verifier();
  const created = await call(handlers.create, makeReq({
    method: "POST",
    url: "/api/auth/cli/session",
    body: {
      code_challenge: challenge(pkce),
      client_name: "SeedCode CLI",
      client_version: "10.4.0",
      os: "Windows",
    },
  }));
  assert.equal(created.status, 201, created.body);
  return { session: created.json, pkce, jar };
}

async function signIn(session, jar) {
  const start = await call(handlers.start, makeReq({
    url: `/api/auth/oauth/start?session=${encodeURIComponent(session.session_id)}`,
  }));
  assert.equal(start.status, 302, start.body);
  jar.absorb(start);
  const state = new URL(start.headers.location).searchParams.get("state");
  const callback = await call(handlers.callback, makeReq({
    url: `/api/auth/oauth/callback?code=abc&state=${encodeURIComponent(state)}`,
    headers: { cookie: jar.header() },
  }));
  assert.equal(callback.status, 302, callback.body);
  jar.absorb(callback);
  assert.match(jar.get("sc_session") || "", /\./);
  return jar;
}

async function approve(session, jar) {
  const info = await call(handlers.session, makeReq({
    url: `/api/auth/session?session=${encodeURIComponent(session.session_id)}`,
    headers: { cookie: jar.header() },
  }));
  assert.equal(info.status, 200, info.body);
  jar.absorb(info);
  const csrf = info.json.csrf_token;
  const approved = await call(handlers.approve, makeReq({
    method: "POST",
    url: "/api/auth/approve",
    headers: { cookie: jar.header(), "x-seedcode-csrf": csrf },
    body: { session_id: session.session_id },
  }));
  assert.equal(approved.status, 200, approved.body);
  return { approved, csrf };
}

test("full pending -> GitHub -> approval -> one-time token handoff", async () => {
  const { session, pkce, jar } = await newSession();
  const lookup = await call(handlers.lookup, makeReq({
    method: "POST",
    url: "/api/auth/lookup",
    body: { code: session.user_code },
  }));
  assert.equal(lookup.status, 200, lookup.body);
  assert.equal(lookup.json.session_id, session.session_id);

  await signIn(session, jar);
  const info = await call(handlers.session, makeReq({
    url: `/api/auth/session?session=${encodeURIComponent(session.session_id)}`,
    headers: { cookie: jar.header() },
  }));
  assert.equal(info.json.github.login, "octocat");
  assert.equal(info.json.status, "pending");

  await approve(session, jar);
  const polled = await call(handlers.poll, makeReq({
    method: "POST",
    url: "/api/auth/cli/poll",
    body: { session_id: session.session_id, device_code: session.device_code },
  }));
  assert.equal(polled.status, 200, polled.body);
  assert.equal(polled.json.status, "approved");
  assert.ok(polled.json.authorization_code);

  const exchanged = await call(handlers.token, makeReq({
    method: "POST",
    url: "/api/auth/cli/token",
    body: {
      session_id: session.session_id,
      device_code: session.device_code,
      authorization_code: polled.json.authorization_code,
      code_verifier: pkce,
    },
  }));
  assert.equal(exchanged.status, 200, exchanged.body);
  assert.equal(exchanged.json.access_token, "gho_test_token");
  assert.equal(exchanged.json.github.login, "octocat");

  const replay = await call(handlers.token, makeReq({
    method: "POST",
    url: "/api/auth/cli/token",
    body: {
      session_id: session.session_id,
      device_code: session.device_code,
      authorization_code: polled.json.authorization_code,
      code_verifier: pkce,
    },
  }));
  assert.equal(replay.status, 409, replay.body);
});

test("approval without CSRF is rejected", async () => {
  const { session, jar } = await newSession();
  await signIn(session, jar);
  const attempt = await call(handlers.approve, makeReq({
    method: "POST",
    url: "/api/auth/approve",
    headers: { cookie: jar.header() },
    body: { session_id: session.session_id },
  }));
  assert.equal(attempt.status, 403);
  assert.equal(attempt.json.error, "csrf");
});

test("the legacy site alias can still make same-origin requests", async () => {
  const { sameOrigin } = require("../api/_lib/http");
  const legacy = "https://seedcode-cli." + "vercel.app";
  assert.equal(sameOrigin({ headers: { origin: legacy } }), true);
  assert.equal(sameOrigin({ headers: { origin: "https://attacker.example" } }), false);
});

test("a different browser cookie cannot approve the session", async () => {
  const { session, jar } = await newSession();
  await signIn(session, jar);
  const other = cookieJar();
  const attempt = await call(handlers.approve, makeReq({
    method: "POST",
    url: "/api/auth/approve",
    headers: { cookie: other.header(), "x-seedcode-csrf": "x" },
    body: { session_id: session.session_id },
  }));
  assert.equal(attempt.status, 401);
});

test("denied approval is reported and no token is issued", async () => {
  const { session, jar } = await newSession();
  await signIn(session, jar);
  const info = await call(handlers.session, makeReq({
    url: `/api/auth/session?session=${encodeURIComponent(session.session_id)}`,
    headers: { cookie: jar.header() },
  }));
  jar.absorb(info);
  const denied = await call(handlers.deny, makeReq({
    method: "POST",
    url: "/api/auth/deny",
    headers: { cookie: jar.header(), "x-seedcode-csrf": info.json.csrf_token },
    body: { session_id: session.session_id },
  }));
  assert.equal(denied.status, 200, denied.body);
  assert.equal(denied.json.status, "denied");

  const polled = await call(handlers.poll, makeReq({
    method: "POST",
    url: "/api/auth/cli/poll",
    body: { session_id: session.session_id, device_code: session.device_code },
  }));
  assert.equal(polled.json.status, "denied");
});

test("invalid OAuth state never creates a login", async () => {
  const { session, jar } = await newSession();
  const start = await call(handlers.start, makeReq({
    url: `/api/auth/oauth/start?session=${encodeURIComponent(session.session_id)}`,
  }));
  jar.absorb(start);
  const callback = await call(handlers.callback, makeReq({
    url: "/api/auth/oauth/callback?code=abc&state=forged-state",
    headers: { cookie: jar.header() },
  }));
  assert.equal(callback.status, 302);
  // The terminal session is kept in the redirect so the login page can offer a retry.
  const target = new URL(callback.headers.location, base);
  assert.equal(target.pathname, "/auth/login");
  assert.equal(target.searchParams.get("error"), "state_mismatch");
  assert.equal(target.searchParams.get("session"), session.session_id);
});

test("GitHub denial returns to the login page with the session so the person can retry", async () => {
  const { session, jar } = await newSession();
  const start = await call(handlers.start, makeReq({
    url: `/api/auth/oauth/start?session=${encodeURIComponent(session.session_id)}`,
  }));
  jar.absorb(start);
  const denied = await call(handlers.callback, makeReq({
    url: "/api/auth/oauth/callback?error=access_denied",
    headers: { cookie: jar.header() },
  }));
  assert.equal(denied.status, 302);
  const target = new URL(denied.headers.location, base);
  assert.equal(target.pathname, "/auth/login");
  assert.equal(target.searchParams.get("error"), "oauth_denied");
  assert.equal(target.searchParams.get("session"), session.session_id);
  // The one-use OAuth cookie is cleared on failure.
  jar.absorb(denied);
  assert.equal(jar.get("sc_oauth"), undefined);
});

test("a callback with no cookie falls back to the plain login page", async () => {
  const callback = await call(handlers.callback, makeReq({
    url: "/api/auth/oauth/callback?code=abc&state=whatever",
  }));
  assert.equal(callback.status, 302);
  const target = new URL(callback.headers.location, base);
  assert.equal(target.pathname, "/auth/login");
  assert.equal(target.searchParams.get("session"), null);
  assert.equal(target.searchParams.get("error"), "missing_state");
});

test("the approval page lists permissions that match the requested GitHub scope", async () => {
  const { permissionsFor } = require("../api/_lib/sessions");
  const minimal = permissionsFor("read:user");
  assert.ok(minimal.some((line) => /no repository access/i.test(line)));
  assert.ok(!minimal.some((line) => /email/i.test(line)));
  const wider = permissionsFor("read:user user:email repo");
  assert.ok(wider.some((line) => /email/i.test(line)));
  assert.ok(!wider.some((line) => /no repository access/i.test(line)));
});

test("the authorize URL asks GitHub for PKCE and the least scope by default", async () => {
  const { session } = await newSession();
  const start = await call(handlers.start, makeReq({
    url: `/api/auth/oauth/start?session=${encodeURIComponent(session.session_id)}`,
  }));
  assert.equal(start.status, 302);
  const target = new URL(start.headers.location);
  assert.equal(target.origin + target.pathname, "https://github.com/login/oauth/authorize");
  assert.equal(target.searchParams.get("client_id"), "test-client-id");
  assert.equal(target.searchParams.get("redirect_uri"), `${base}/api/auth/oauth/callback`);
  assert.equal(target.searchParams.get("scope"), "read:user");
  assert.equal(target.searchParams.get("code_challenge_method"), "S256");
  assert.ok(target.searchParams.get("code_challenge"));
  assert.ok(target.searchParams.get("state"));
});

test("health reports which variables are missing and the exact GitHub callback URL", async () => {
  const health = require("../api/auth/health");
  const saved = process.env.GITHUB_CLIENT_SECRET;
  delete process.env.GITHUB_CLIENT_SECRET;
  try {
    const result = await call(health, makeReq({ url: "/api/auth/health" }));
    assert.equal(result.status, 200);
    assert.equal(result.json.ready, false);
    assert.ok(result.json.missing.includes("GITHUB_CLIENT_SECRET"));
    assert.equal(result.json.github_callback_url, `${base}/api/auth/oauth/callback`);
    assert.ok(!result.body.includes("test-client-secret"));
  } finally {
    process.env.GITHUB_CLIENT_SECRET = saved;
  }
});

test("an expired pending session is reported and cleaned up", async () => {
  const { session } = await newSession();
  const store = require("../api/_lib/store");
  await store.putJson(`session:${session.session_id}`, {
    ...(await store.getJson(`session:${session.session_id}`)),
    expires_at: 1,
  }, 60);
  const polled = await call(handlers.poll, makeReq({
    method: "POST",
    url: "/api/auth/cli/poll",
    body: { session_id: session.session_id, device_code: session.device_code },
  }));
  assert.equal(polled.status, 200, polled.body);
  assert.equal(polled.json.status, "expired");
});

test("duplicate approval is refused", async () => {
  const { session, jar } = await newSession();
  await signIn(session, jar);
  const { csrf } = await approve(session, jar);
  const duplicate = await call(handlers.approve, makeReq({
    method: "POST",
    url: "/api/auth/approve",
    headers: { cookie: jar.header(), "x-seedcode-csrf": csrf },
    body: { session_id: session.session_id },
  }));
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.json.error, "already_approved");
});

test("wrong device code cannot poll or exchange", async () => {
  const { session, pkce, jar } = await newSession();
  await signIn(session, jar);
  await approve(session, jar);
  const polled = await call(handlers.poll, makeReq({
    method: "POST",
    url: "/api/auth/cli/poll",
    body: { session_id: session.session_id, device_code: "wrong" },
  }));
  assert.equal(polled.status, 401);
  const exchanged = await call(handlers.token, makeReq({
    method: "POST",
    url: "/api/auth/cli/token",
    body: {
      session_id: session.session_id,
      device_code: "wrong",
      authorization_code: "anything",
      code_verifier: pkce,
    },
  }));
  assert.equal(exchanged.status, 401);
});

test.after(() => {
  globalThis.fetch = realFetch;
});
