"use strict";

/**
 * Static site integrity: every page is complete, every internal link and asset
 * resolves, and no page depends on inline script (the CSP forbids it).
 *
 * This is a real audit of the shipped HTML rather than a browser test: it
 * catches broken navigation, renamed assets and relative-path mistakes that
 * otherwise only appear after deployment.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SKIP_DIRS = new Set([".git", ".git-worktree-backup", "node_modules", ".vercel"]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const allFiles = walk(ROOT).map((file) => path.relative(ROOT, file).split(path.sep).join("/"));
// Search-engine verification stubs are not product pages.
const pages = allFiles.filter((name) => name.endsWith(".html") && !path.posix.basename(name).startsWith("google"));

const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
const rewrites = new Map((vercel.rewrites || []).map((rule) => [rule.source, rule.destination]));

function exists(target) {
  return allFiles.includes(target.replace(/^\/+/, ""));
}

function resolve(fromPage, raw) {
  const clean = String(raw).split("#")[0].split("?")[0];
  if (!clean) return true; // same-page anchor
  if (/^(https?:|mailto:|tel:|data:)/i.test(clean)) return true;
  if (clean.startsWith("//")) return true;

  let target;
  if (clean.startsWith("/")) {
    target = clean.slice(1);
    if (rewrites.has("/" + target)) return exists(rewrites.get("/" + target));
  } else {
    target = path.posix.join(path.posix.dirname(fromPage), clean);
  }
  if (target === "" || target.endsWith("/")) return exists(target + "index.html");
  if (exists(target)) return true;
  if (!path.posix.extname(target)) return exists(target + ".html") || exists(target + "/index.html");
  return false;
}

test("every page declares language, viewport and a title", () => {
  assert.ok(pages.length >= 10, `only found ${pages.length} pages`);
  for (const page of pages) {
    const html = fs.readFileSync(path.join(ROOT, page), "utf8");
    assert.match(html, /<html[^>]+lang="en"/i, `${page}: missing lang`);
    assert.match(html, /<meta[^>]+name="viewport"/i, `${page}: missing viewport`);
    assert.match(html, /<title>[^<]+<\/title>/i, `${page}: missing title`);
  }
});

test("every internal link and local asset resolves", () => {
  const broken = [];
  for (const page of pages) {
    const html = fs.readFileSync(path.join(ROOT, page), "utf8");
    const refs = [...html.matchAll(/\b(?:href|src)="([^"]+)"/gi)].map((match) => match[1]);
    for (const ref of refs) {
      if (!resolve(page, ref)) broken.push(`${page} -> ${ref}`);
    }
  }
  assert.deepEqual(broken, []);
});

test("pages never rely on inline script (CSP is script-src 'self')", () => {
  for (const page of pages) {
    const html = fs.readFileSync(path.join(ROOT, page), "utf8");
    const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>/gi)];
    for (const match of inline) {
      assert.match(match[1], /type="application\/ld\+json"/i, `${page}: inline script without src`);
    }
  }
});

test("primary navigation is consistent across the public pages", () => {
  const expected = ["/", "/features", "/install", "/providers", "/commands", "/releases", "/auth/"];
  const publicPages = pages.filter((page) => !page.startsWith("auth/") && !page.startsWith("legal/") && page !== "404.html");
  for (const page of publicPages) {
    const html = fs.readFileSync(path.join(ROOT, page), "utf8");
    const nav = html.match(/<nav class="navlinks"[^>]*>([\s\S]*?)<\/nav>/i);
    assert.ok(nav, `${page}: no primary navigation`);
    const links = [...nav[1].matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
    for (const target of expected) {
      assert.ok(links.includes(target), `${page}: navigation missing ${target}`);
    }
    // GP was intentionally removed from the desktop navigation. Keep the
    // SeedCode brand and every real page link above, but never reintroduce it.
    assert.doesNotMatch(nav[1], />\s*GP\s*</i, `${page}: GP must not be in the primary navigation`);
    for (const label of ["Overview", "Features", "Install", "Providers", "Commands", "Releases", "Sign in", "Download"]) {
      assert.match(nav[1], new RegExp(`>\\s*${label}\\s*<`), `${page}: navigation label ${label} is missing`);
    }
  }
});

test("canonical and crawler URLs use the current public deployment origin", () => {
  const origin = "https://seedcode-web.vercel.app";
  // Split so a future global hostname replacement cannot turn this negative
  // assertion into a check for the current host.
  const staleHost = "seedcode-cli." + "vercel.app";
  for (const page of pages) {
    const html = read(page);
    assert.ok(!html.includes(staleHost), `${page}: stale deployment host`);
    const canonical =
      html.match(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i) ||
      html.match(/<link[^>]+href="([^"]+)"[^>]+rel="canonical"/i);
    if (canonical) assert.ok(canonical[1].startsWith(origin), `${page}: canonical host is not ${origin}`);
    for (const match of html.matchAll(/property="og:url"[^>]+content="([^"]+)"|content="([^"]+)"[^>]+property="og:url"/gi)) {
      assert.ok((match[1] || match[2]).startsWith(origin), `${page}: og:url host is not ${origin}`);
    }
  }
  for (const file of ["sitemap.xml", "robots.txt", "llms.txt", "llms-full.txt"]) {
    assert.ok(read(file).includes(origin), `${file}: missing ${origin}`);
    assert.ok(!read(file).includes(staleHost), `${file}: stale deployment host`);
  }
  assert.ok(rewrites.has("/favicon.ico"), "/favicon.ico has no rewrite");
});

test("install scripts and manifest exist where the site advertises them", () => {
  for (const required of [
    "IRM_INSTALL/install.ps1",
    "IRM_INSTALL/install.sh",
    "site.webmanifest",
    "llms.txt",
    "sitemap.xml",
    "css/style.css",
    "script/main.js",
  ]) {
    assert.ok(exists(required), `WEB/${required} is missing`);
  }
  // `/install.ps1` and `/install.sh` must be served by an explicit rewrite.
  for (const source of ["/install.ps1", "/install.sh"]) {
    assert.ok(rewrites.has(source), `${source} has no vercel rewrite`);
    assert.ok(exists(rewrites.get(source)), `${source} points at a missing file`);
  }
});

test("public clean URLs have explicit server routes", () => {
  const routes = {
    "/features": "/features.html",
    "/install": "/install.html",
    "/providers": "/providers.html",
    "/commands": "/commands.html",
    "/releases": "/releases.html",
  };
  for (const [source, destination] of Object.entries(routes)) {
    assert.equal(rewrites.get(source), destination, `${source} has no matching rewrite`);
    assert.ok(exists(destination.slice(1)), `${source} points at a missing file`);
  }
});

test("all image references use the centralized assets directory", () => {
  const image = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp)(?:[?#]|$)/i;
  const checked = new Set();

  function check(page, raw) {
    if (!image.test(raw)) return;
    let target = raw.split(/[?#]/)[0];
    if (/^https?:\/\//i.test(target)) {
      if (!/^https:\/\/seedcode-web\.vercel\.app\//i.test(target)) return;
      target = new URL(target).pathname;
    }
    if (target.startsWith("data:")) return;
    assert.ok(target.startsWith("/assets/"), `${page}: image must be under /assets: ${raw}`);
    assert.ok(exists(target.slice(1)), `${page}: missing image ${target}`);
    checked.add(target);
  }

  for (const page of pages) {
    const html = read(page);
    for (const match of html.matchAll(/\b(?:src|href|content)="([^"]+)"/gi)) {
      check(page, match[1]);
    }
  }
  for (const file of allFiles.filter((name) => name.endsWith(".css"))) {
    const css = read(file);
    for (const match of css.matchAll(/url\(["']?([^"')]+)["']?\)/gi)) {
      check(file, match[1]);
    }
  }

  const manifest = JSON.parse(read("site.webmanifest"));
  for (const icon of manifest.icons || []) {
    assert.ok(icon.src.startsWith("/assets/"), `manifest icon must be under /assets: ${icon.src}`);
    assert.ok(exists(icon.src.slice(1)), `manifest icon is missing: ${icon.src}`);
    checked.add(icon.src);
  }
  assert.ok(checked.size >= 8, `expected the shared image set, saw ${checked.size}`);
});

test("internal page links use clean URLs instead of .html", () => {
  const offenders = [];
  for (const page of pages) {
    const html = read(page);
    for (const match of html.matchAll(/href="(\/[^"]*\.html)"/gi)) {
      offenders.push(`${page} -> ${match[1]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

function read(page) {
  return fs.readFileSync(path.join(ROOT, page), "utf8");
}

test("no page ships a placeholder link", () => {
  const offenders = [];
  for (const page of pages) {
    if (read(page).includes('href="#"')) offenders.push(page);
  }
  assert.deepEqual(offenders, []);
});

test("no page relies on inline event handlers (CSP forbids them)", () => {
  const offenders = [];
  for (const page of pages) {
    const html = read(page);
    for (const match of html.matchAll(
      /\son(?:click|change|submit|input|load|error|focus|blur|keydown|keyup|mouseover|mouseout|mousedown|mouseup|touchstart|touchend)\s*=/gi
    )) {
      offenders.push(`${page}: ${match[0].trim()}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("every button and text input has an accessible name", () => {
  for (const page of pages) {
    const html = read(page);
    for (const match of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
      const text = match[2].replace(/<[^>]+>/g, "").trim();
      assert.ok(text || /aria-label="[^"]+"/.test(match[1]), `${page}: unlabelled button`);
    }
    for (const match of html.matchAll(/<input\b([^>]*)>/gi)) {
      const attrs = match[1];
      const id = (attrs.match(/\bid="([^"]+)"/) || [])[1];
      const labelledByTag = id && new RegExp(`<label[^>]*\\bfor="${id}"`).test(html);
      assert.ok(
        /aria-label="[^"]+"/.test(attrs) ||
          /aria-labelledby="[^"]+"/.test(attrs) ||
          labelledByTag,
        `${page}: unlabelled input`
      );
    }
  }
});

test("the success page never claims a connection before the backend confirms it", () => {
  const html = read("auth/success.html");
  assert.match(html, /<h1 id="title">Checking this approval/);
  assert.match(html, /<div id="connected" class="hidden">/);
  assert.match(html, /<ol class="steps hidden" id="steps"/);
});

test("every element and endpoint the auth controller uses exists", () => {
  const controller = read("script/auth.js") + read("script/session.js");
  const authPages = pages.filter((page) => page.startsWith("auth/")).map(read).join("\n");
  const ids = new Set();
  for (const match of controller.matchAll(/getElementById\("([^"]+)"\)/g)) ids.add(match[1]);
  for (const match of controller.matchAll(/\b(?:setText|hide|reveal|renderCode)\("([^"]+)"/g)) {
    ids.add(match[1]);
  }
  for (const id of ids) {
    assert.ok(authPages.includes(`id="${id}"`), `auth markup is missing #${id}`);
  }

  const endpoints = new Set(["/approve", "/deny", "/oauth/start"]);
  for (const match of read("script/auth.js").matchAll(/\bapi\("(\/[^"?]+)/g)) {
    endpoints.add(match[1]);
  }
  for (const endpoint of endpoints) {
    const file = path.join(ROOT, "api", "auth", endpoint.replace(/^\//, "") + ".js");
    assert.ok(fs.existsSync(file), `api/auth${endpoint}.js is missing`);
  }
});

test("security headers cover clean URLs, not only the .html file paths", () => {
  const cspRules = (vercel.headers || []).filter((rule) =>
    (rule.headers || []).some((header) => header.key === "Content-Security-Policy")
  );
  for (const route of [
    "features",
    "install",
    "providers",
    "commands",
    "releases",
    "terms",
    "privacy",
    "security",
    "contact",
    "license",
  ]) {
    assert.ok(
      cspRules.some((rule) => rule.source.includes(route)),
      `clean route /${route} has no CSP header rule`
    );
  }
});
