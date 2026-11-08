"use strict";

/**
 * Authentication configuration.
 *
 * Everything secret comes from the environment; nothing here is ever shipped
 * to the browser. Production refuses to start without the required values so a
 * misconfigured deployment fails closed instead of silently degrading.
 */

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function baseUrl() {
  const raw = (process.env.PUBLIC_BASE_URL || "https://seedcode-web.vercel.app").trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("PUBLIC_BASE_URL must be an absolute URL");
  }
  if (isProduction() && url.protocol !== "https:") {
    throw new Error("PUBLIC_BASE_URL must use https in production");
  }
  return url.origin;
}

function isProduction() {
  return process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";
}

function requireEnv(name) {
  const value = (process.env[name] || "").trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const config = {
  get baseUrl() {
    return baseUrl();
  },
  get isProduction() {
    return isProduction();
  },
  get githubClientId() {
    return requireEnv("GITHUB_CLIENT_ID");
  },
  get githubClientSecret() {
    return requireEnv("GITHUB_CLIENT_SECRET");
  },
  get oauthScopes() {
    return (process.env.GITHUB_OAUTH_SCOPES || "read:user").trim();
  },
  get cookieSecret() {
    const secret = requireEnv("AUTH_SESSION_SECRET");
    if (secret.length < 32) throw new Error("AUTH_SESSION_SECRET must be at least 32 characters");
    return secret;
  },
  get encryptionKey() {
    return requireEnv("AUTH_ENCRYPTION_KEY");
  },
  get sessionTtl() {
    return intEnv("AUTH_SESSION_TTL_SECONDS", 600);
  },
  get approvalTtl() {
    return intEnv("AUTH_APPROVAL_TTL_SECONDS", 600);
  },
  get codeTtl() {
    return intEnv("AUTH_CODE_TTL_SECONDS", 120);
  },
  get pollInterval() {
    return intEnv("AUTH_POLL_INTERVAL_SECONDS", 5);
  },
  get cookieSecure() {
    return baseUrl().startsWith("https://");
  },
  get memoryStoreAllowed() {
    return !isProduction() || process.env.AUTH_ALLOW_MEMORY_STORE === "1";
  },
  //: Only these origins may call state-changing endpoints. The old
  //: seedcode-cli alias still serves the site, so keep its state-changing
  //: requests working during the transition; OAuth itself always uses the
  //: canonical PUBLIC_BASE_URL callback.
  get allowedOrigins() {
    const origin = baseUrl();
    if (origin === "https://seedcode-web.vercel.app") {
      return new Set([origin, "https://seedcode-cli.vercel.app"]);
    }
    return new Set([origin]);
  },
};

module.exports = config;
