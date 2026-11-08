"use strict";

/**
 * Browser-level UI tests (Playwright).
 *
 * Runs the real pages, real CSS and real scripts from a local server that
 * implements the cleanUrls/rewrite rules from vercel.json. The /api/auth
 * endpoints are controlled fixtures only: they prove the frontend contract
 * (paths, methods, CSRF header, redirects, honest states). They are NOT a
 * production authentication test.
 *
 * Run with: npm run test:browser
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
const rewrites = new Map((vercel.rewrites || []).map((rule) => [rule.source, rule.destination]));
const CSRF = "test-csrf-token";
const LOOKUP_SESSION = "sess_0123456789abcdefghij";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (_) {
        resolve({});
      }
    });
  });
}

function sessionPayload(id) {
  const now = Math.floor(Date.now() / 1000);
  return {
    session_id: id,
    status: "pending",
    created_at: now - 30,
    expires_at: now + 300,
    client: { name: "SeedCode CLI", version: "10.4.0", os: "Windows 11" },
    github: {
      id: "583231",
      login: "octocat",
      name: "The Octocat",
      avatar_url: "https://avatars.githubusercontent.com/u/583231?v=4",
    },
    permissions: [
      "Read your GitHub profile (login, name and avatar)",
      "Authorize this terminal session to use GitHub Copilot",
      "No repository access is requested or granted",
    ],
    csrf_token: CSRF,
  };
}

async function apiHandler(req, res, url) {
  if (url.pathname === "/api/auth/lookup" && req.method === "POST") {
    const body = await readJson(req);
    if (String(body.code || "").toUpperCase() === "ABCD-EF23") {
      json(res, 200, { session_id: LOOKUP_SESSION });
    } else {
      json(res, 404, { error: "not_found", message: "That code is not pending. Start a new login." });
    }
    return;
  }
  if (url.pathname === "/api/auth/session" && req.method === "GET") {
    const id = url.searchParams.get("session") || "";
    const now = Math.floor(Date.now() / 1000);
    if (id === "pending_session" || id === LOOKUP_SESSION) {
      return json(res, 200, sessionPayload(id));
    }
    if (id === "approved_session") {
      return json(res, 200, { ...sessionPayload(id), status: "approved" });
    }
    if (id === "denied_session") {
      return json(res, 200, { ...sessionPayload(id), status: "denied" });
    }
    if (id === "expired_session") {
      return json(res, 200, { ...sessionPayload(id), expires_at: now + 2 });
    }
    return json(res, 404, { error: "not_found", message: "Unknown terminal session." });
  }
  if (url.pathname === "/api/auth/approve" && req.method === "POST") {
    if (req.headers["x-seedcode-csrf"] !== CSRF) {
      return json(res, 403, { error: "csrf", message: "This approval request could not be verified." });
    }
    return json(res, 200, {
      ok: true,
      status: "approved",
      redirect: "/auth/success?session=approved_session",
    });
  }
  if (url.pathname === "/api/auth/deny" && req.method === "POST") {
    if (req.headers["x-seedcode-csrf"] !== CSRF) {
      return json(res, 403, { error: "csrf", message: "This request could not be verified." });
    }
    return json(res, 200, {
      ok: true,
      status: "denied",
      redirect: "/auth/denied?session=denied_session",
    });
  }
  if (url.pathname === "/api/auth/oauth/start") {
    res.writeHead(302, { Location: "https://github.com/login/oauth/authorize?state=fixture" });
    res.end();
    return;
  }
  json(res, 404, { error: "not_found", message: "This fixture endpoint is not implemented." });
}

function staticFile(pathname) {
  const clean = decodeURIComponent(pathname);
  if (rewrites.has(clean)) return path.join(ROOT, rewrites.get(clean));
  if (clean.endsWith("/")) return path.join(ROOT, clean, "index.html");
  if (path.extname(clean)) return path.join(ROOT, clean);
  if (fs.existsSync(path.join(ROOT, clean + ".html"))) return path.join(ROOT, clean + ".html");
  if (fs.existsSync(path.join(ROOT, clean, "index.html"))) {
    return path.join(ROOT, clean, "index.html");
  }
  return null;
}

function handler(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname.startsWith("/api/auth/")) {
    apiHandler(req, res, url).catch(() => json(res, 500, { error: "server_error" }));
    return;
  }
  const file = staticFile(url.pathname);
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    const notFound = path.join(ROOT, "404.html");
    res.writeHead(404, { "Content-Type": TYPES[".html"] });
    fs.createReadStream(notFound).pipe(res);
    return;
  }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

let server;
let browser;
let BASE;

test.before(async () => {
  server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  BASE = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: "chrome" });
});

test.after(async () => {
  await browser?.close();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
});

function watch(page, errors) {
  page.on("console", (message) => {
    // A failed cross-origin fetch (the optional GitHub release-size lookup) is
    // logged by the browser without a URL. Local failures are captured below
    // with their real URL, so this generic network noise is not a page error.
    if (message.type() === "error" && !/Failed to load resource/i.test(message.text())) {
      errors.push(`console: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) => {
    if (request.url().startsWith(BASE)) errors.push(`requestfailed: ${request.url()}`);
  });
  page.on("response", (response) => {
    if (response.url().startsWith(BASE) && response.status() >= 400) {
      errors.push(`${response.status()} ${response.url()}`);
    }
  });
}

async function open(context, route) {
  const page = await context.newPage();
  const errors = [];
  watch(page, errors);
  await page.goto(BASE + route, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(200);
  return { page, errors };
}

test("public pages render without errors or horizontal overflow at every breakpoint", async () => {
  const routes = [
    "/",
    "/features",
    "/install",
    "/providers",
    "/commands",
    "/releases",
    "/terms",
    "/privacy",
    "/acceptable-use",
    "/security",
    "/contact",
    "/delete-account",
    "/license",
    "/legal/terms",
    "/404",
  ];
  for (const width of [1920, 1440, 1024, 768, 390, 360]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    for (const route of routes) {
      const { page, errors } = await open(context, route);
      assert.deepEqual(errors, [], `${route} at ${width}px reported errors`);
      const layout = await page.evaluate(() => ({
        scroll: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
        viewport: window.innerWidth,
        unhydratedIcons: document.querySelectorAll("i[data-i]").length,
      }));
      assert.ok(
        layout.scroll <= layout.viewport + 1,
        `${route} at ${width}px overflows horizontally (${layout.scroll} > ${layout.viewport})`
      );
      assert.equal(layout.unhydratedIcons, 0, `${route} at ${width}px left icons unrendered`);
      await page.close();
    }
    await context.close();
  }
});

test("auth pages render without errors or horizontal overflow on phone and desktop", async () => {
  const routes = [
    "/auth/",
    "/auth/login?session=pending_session",
    "/auth/approve?session=pending_session",
    "/auth/success?session=approved_session",
    "/auth/denied",
    "/auth/callback",
  ];
  for (const width of [1440, 390, 360]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    for (const route of routes) {
      const { page, errors } = await open(context, route);
      assert.deepEqual(errors, [], `${route} at ${width}px reported errors`);
      const overflow = await page.evaluate(
        () =>
          Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) -
          window.innerWidth
      );
      assert.ok(overflow <= 1, `${route} at ${width}px overflows by ${overflow}px`);
      await page.close();
    }
    await context.close();
  }
});

test("desktop navigation preserves every label and never shows GP", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const { page, errors } = await open(context, "/");
  assert.equal(await page.locator(".navlinks").isVisible(), true);
  const labels = (await page.locator(".navlinks a").allTextContents()).map((text) => text.trim());
  assert.deepEqual(labels, [
    "Overview",
    "Features",
    "Install",
    "Providers",
    "Commands",
    "Releases",
    "Sign in",
    "Download",
  ]);
  assert.equal(labels.some((label) => /\bGP\b/i.test(label)), false);
  assert.equal(await page.locator(".brand").isVisible(), true);
  assert.deepEqual(errors, []);
  await context.close();
});

test("browser back and forward navigation work", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const { page, errors } = await open(context, "/");
  await page.click('.navlinks a[href="/features"]');
  await page.waitForURL("**/features");
  await page.goBack();
  await page.waitForURL(BASE + "/");
  assert.match(await page.title(), /SeedCode CLI/);
  await page.goForward();
  await page.waitForURL("**/features");
  assert.match(await page.title(), /Features/);
  assert.deepEqual(errors, []);
  await context.close();
});

test("every internal page link discovered on public pages resolves", async () => {
  const routes = [
    "/",
    "/features",
    "/install",
    "/providers",
    "/commands",
    "/releases",
    "/terms",
    "/privacy",
    "/acceptable-use",
    "/security",
    "/contact",
    "/delete-account",
    "/license",
    "/legal/terms",
    "/404",
  ];
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const links = new Set();
  for (const route of routes) {
    const { page, errors } = await open(context, route);
    const hrefs = await page.locator('a[href^="/"]').evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("href")).filter(Boolean)
    );
    for (const href of hrefs) {
      const clean = href.split("#")[0];
      if (!clean || clean.startsWith("/api/")) continue;
      if (/\.(?:css|js|png|jpe?g|gif|webp|avif|svg|ico|bmp|txt|xml|webmanifest)$/i.test(clean)) continue;
      links.add(clean);
    }
    assert.deepEqual(errors, [], `${route} reported navigation errors`);
    await page.close();
  }

  for (const href of [...links].sort()) {
    const page = await context.newPage();
    const response = await page.goto(BASE + href, { waitUntil: "domcontentloaded" });
    assert.ok(response && response.status() < 400, `${href} returned ${response && response.status()}`);
    await page.close();
  }
  await context.close();
});

test("direct page URLs and nested routes survive a refresh", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  for (const route of ["/features", "/legal/terms", "/legal/privacy", "/auth/callback"]) {
    const { page, errors } = await open(context, route);
    const refreshed = await page.reload({ waitUntil: "domcontentloaded" });
    assert.ok(refreshed && refreshed.status() < 400, `${route} failed after refresh`);
    assert.deepEqual(errors, [], `${route} reported errors after refresh`);
    await page.close();
  }
  await context.close();
});

test("an unknown route serves the branded 404 page", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const response = await page.goto(BASE + "/no-such-page", { waitUntil: "domcontentloaded" });
  assert.equal(response.status(), 404);
  assert.match(await page.title(), /Page not found/);
  assert.equal(await page.locator(".navlinks").isVisible(), false);
  await context.close();
});

test("mobile navigation opens, exposes aria-expanded and closes with Escape", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const { page, errors } = await open(context, "/");
  assert.equal(await page.locator(".navlinks").isVisible(), false);
  await page.click(".mobile");
  assert.equal(await page.locator(".navlinks").isVisible(), true);
  assert.equal(await page.getAttribute(".mobile", "aria-expanded"), "true");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".navlinks").isVisible(), false);
  assert.equal(await page.getAttribute(".mobile", "aria-expanded"), "false");
  const focus = await page.evaluate(() => ({
    tag: document.activeElement.tagName,
    cls: String(document.activeElement.className),
    label: document.activeElement.getAttribute("aria-label"),
  }));
  assert.equal(focus.cls.includes("mobile"), true, `focus should return to the menu button: ${JSON.stringify(focus)}`);
  assert.deepEqual(errors, []);
  await context.close();
});

test("command palette opens with Ctrl+K, filters and navigates", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const { page, errors } = await open(context, "/");
  await page.keyboard.press("Control+K");
  await page.waitForSelector(".pal:not([hidden]) .box");
  assert.equal(await page.getAttribute(".pal .box", "aria-modal"), "true");
  await page.fill(".pal input", "install");
  await page.waitForTimeout(80);
  await page.keyboard.press("Enter");
  await page.waitForURL("**/install");
  assert.deepEqual(errors, []);
  await context.close();
});

test("commands filter hides non-matches and reports an empty result", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const { page, errors } = await open(context, "/commands");
  await page.fill("#q", "provider");
  const visible = page.locator(".table tbody tr:visible");
  const count = await visible.count();
  assert.ok(count > 0, "expected at least one matching command");
  for (let i = 0; i < count; i += 1) {
    assert.match((await visible.nth(i).textContent()).toLowerCase(), /provider/);
  }
  await page.fill("#q", "zzzz-no-command");
  assert.equal(await page.locator("p.empty").isVisible(), true);
  assert.equal(await page.getAttribute("p.empty", "role"), "status");
  await page.fill("#q", "");
  assert.ok((await page.locator(".table tbody tr:visible").count()) > count);
  assert.deepEqual(errors, []);
  await context.close();
});

test("copy buttons confirm the copy and place the command on the clipboard", async () => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const { page, errors } = await open(context, "/install");
  const button = page.locator("button.copy").first();
  const command = await button.getAttribute("data-copy");
  await button.click();
  await page.waitForFunction(
    () => /Copied|Selected/.test(document.querySelector("button.copy").textContent),
    { timeout: 4000 }
  );
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(clipboard, command);
  assert.deepEqual(errors, []);
  await context.close();
});

test("code entry formats the code, finds the session and can be reset", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const { page, errors } = await open(context, "/auth/");
  await page.fill("#code", "abcdef23");
  assert.equal(await page.inputValue("#code"), "ABCD-EF23");
  await page.click("#check");
  await page.waitForSelector("#pending-panel:not(.hidden)");
  assert.equal(await page.locator("#code-panel").isVisible(), false);
  assert.equal(
    await page.getAttribute("#continue", "href"),
    `/api/auth/oauth/start?session=${LOOKUP_SESSION}`
  );
  await page.click("#reset");
  assert.equal(await page.locator("#code-panel").isVisible(), true);
  await page.fill("#code", "abc");
  await page.click("#check");
  await page.waitForSelector("#error:not(.hidden)");
  assert.match(await page.textContent("#error"), /full code/i);
  assert.deepEqual(errors, []);
  await context.close();
});

test("login page handles a session, a cancelled GitHub login and a bare visit", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });

  let opened = await open(context, "/auth/login?session=pending_session");
  assert.equal(
    await opened.page.getAttribute("#continue-github", "href"),
    "/api/auth/oauth/start?session=pending_session"
  );
  await opened.page.close();

  opened = await open(context, "/auth/login?error=oauth_denied");
  assert.match(await opened.page.textContent("#error"), /cancelled/i);
  assert.equal(await opened.page.locator("#login-actions").isVisible(), false);
  assert.equal(await opened.page.locator("#login-restart").isVisible(), true);
  await opened.page.close();

  opened = await open(context, "/auth/login");
  assert.match(await opened.page.textContent("#error"), /needs a terminal session/i);
  assert.equal(await opened.page.locator("#login-actions").isVisible(), false);
  assert.deepEqual(opened.errors, []);
  await context.close();
});

test("approval flow sends the CSRF header and lands on a verified success page", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const { page, errors } = await open(context, "/auth/approve?session=pending_session");
  await page.waitForSelector("#approve:not([disabled])");
  assert.equal(await page.textContent("#github-name"), "The Octocat");
  assert.equal(await page.locator("#permissions li").count(), 3);
  assert.match(await page.textContent("#expires-in"), /^\d+:\d\d$/);
  await page.click("#approve");
  await page.waitForURL("**/auth/success?session=approved_session");
  await page.waitForSelector("#connected:not(.hidden)");
  assert.equal(await page.textContent("#title"), "Terminal connected");
  assert.equal(await page.locator("#steps").isVisible(), true);
  assert.equal(await page.textContent("#github-login"), "@octocat");
  assert.equal(await page.textContent("#session-short"), "approved…sion");
  assert.deepEqual(errors, []);
  await context.close();
});

test("denial flow lands on the denied page", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const { page, errors } = await open(context, "/auth/approve?session=pending_session");
  await page.waitForSelector("#deny:not([disabled])");
  await page.click("#deny");
  await page.waitForURL("**/auth/denied?session=denied_session");
  assert.equal(await page.textContent("#title"), "Connection denied");
  assert.deepEqual(errors, []);
  await context.close();
});

test("an expiring session stops the decision buttons and explains why", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const { page, errors } = await open(context, "/auth/approve?session=expired_session");
  await page.waitForSelector("#approve:not([disabled])");
  await page.waitForFunction(
    () => document.querySelector("#expires-in").textContent === "expired",
    { timeout: 8000 }
  );
  assert.equal(await page.locator("#approve").isDisabled(), true);
  assert.equal(await page.locator("#deny").isDisabled(), true);
  assert.match(await page.textContent("#error"), /expired/i);
  assert.deepEqual(errors, []);
  await context.close();
});

test("the success page is honest when it has nothing to confirm", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

  let opened = await open(context, "/auth/success");
  assert.equal(await opened.page.textContent("#title"), "Nothing to confirm");
  assert.equal(await opened.page.locator("#connected").isVisible(), false);
  assert.equal(
    (await opened.page.textContent("main")).includes("Terminal connected"),
    false,
    "must not claim success without a session"
  );
  await opened.page.close();

  opened = await open(context, "/auth/success?session=denied_session");
  assert.equal(await opened.page.textContent("#title"), "Terminal not approved");
  assert.equal(await opened.page.locator("#connected").isVisible(), false);
  await opened.page.close();

  opened = await open(context, "/auth/success?session=unknown_session");
  assert.equal(await opened.page.textContent("#title"), "Approval not confirmed");
  assert.equal(await opened.page.locator("#connected").isVisible(), false);
  // The only expected error is the fixture's intentional 404 for the unknown
  // session; there must be no uncaught script error.
  assert.ok(
    opened.errors.every((entry) => entry.includes("/api/auth/session")),
    `unexpected errors: ${opened.errors.join(", ")}`
  );
  assert.equal(opened.errors.filter((entry) => entry.startsWith("pageerror")).length, 0);
  await context.close();
});

test("approve page without a session explains the problem instead of loading forever", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const { page, errors } = await open(context, "/auth/approve");
  assert.match(await page.textContent("#error"), /needs a terminal session/i);
  assert.equal(await page.locator("#decision").isVisible(), false);
  assert.equal(await page.locator("#loading-note").isVisible(), false);
  assert.deepEqual(errors, []);
  await context.close();
});
