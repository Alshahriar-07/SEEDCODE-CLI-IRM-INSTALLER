"use strict";

const config = require("./config");

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";

function callbackUrl() {
  return `${config.baseUrl}/api/auth/oauth/callback`;
}

/** GitHub's documented OAuth web flow with PKCE (S256). */
function authorizeUrl(state, codeChallenge) {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", config.githubClientId);
  url.searchParams.set("redirect_uri", callbackUrl());
  url.searchParams.set("scope", config.oauthScopes);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

async function exchangeCode(code, codeVerifier) {
  const body = new URLSearchParams({
    client_id: config.githubClientId,
    client_secret: config.githubClientSecret,
    code,
    redirect_uri: callbackUrl(),
    code_verifier: codeVerifier,
  });
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`GitHub token exchange failed (${response.status})`);
  const payload = await response.json();
  if (!payload.access_token) {
    throw new Error(payload.error_description || payload.error || "GitHub returned no access token");
  }
  return { accessToken: payload.access_token, scope: payload.scope || "", tokenType: payload.token_type };
}

async function fetchUser(accessToken) {
  const response = await fetch(USER_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "SeedCode-Auth",
    },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`GitHub user lookup failed (${response.status})`);
  const user = await response.json();
  if (!user || !user.id || !user.login) throw new Error("GitHub returned an incomplete profile");
  return {
    id: String(user.id),
    login: String(user.login),
    name: user.name ? String(user.name) : "",
    avatar_url: user.avatar_url ? String(user.avatar_url) : "",
    html_url: user.html_url ? String(user.html_url) : `https://github.com/${user.login}`,
  };
}

module.exports = { authorizeUrl, exchangeCode, fetchUser, callbackUrl };
