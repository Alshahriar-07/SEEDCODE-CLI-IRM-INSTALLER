# SeedCode authentication service

This directory is the Vercel project for `https://seedcode-web.vercel.app`.
It serves the public site, the authentication pages under `/auth/`, and the
serverless endpoints under `/api/auth/`.

## Flow

```
CLI                         Website backend                    GitHub
 |  POST /api/auth/cli/session  |                                  |
 |  (PKCE challenge only)       |  store pending session           |
 |  <-- session + device code   |                                  |
 |                              |                                  |
 |  open /auth/?code=XXXX-XXXX  |                                  |
 |                              |  GET /api/auth/oauth/start       |
 |                              |  --> github.com/login/oauth      |
 |                              |  <-- callback (state + PKCE) --> |
 |                              |      exchange code, /user         |
 |                              |      encrypted token at rest      |
 |                              |                                  |
 |                              |  user Approves / Denies           |
 |  POST /cli/poll (device code)|  one-time code issued             |
 |  POST /cli/token (code+PKCE) |  token decrypted once, then gone  |
 |  keyring <-- GitHub token    |                                  |
 |  official Copilot SDK: models + streaming                       |
```

The website approval authorizes one terminal session. It is **not** a Copilot
API key: model access is always checked by GitHub's Copilot SDK against the
account's real entitlement.

## Endpoints

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `POST /api/auth/cli/session` | rate limit | create a pending terminal session |
| `POST /api/auth/cli/poll` | device code | status; returns a one-time code when approved |
| `POST /api/auth/cli/token` | device code + code + PKCE | one-time GitHub token handoff |
| `POST /api/auth/lookup` | rate limit | resolve a typed `XXXX-XXXX` code |
| `GET /api/auth/oauth/start` | pending session | GitHub OAuth with state + PKCE |
| `GET /api/auth/oauth/callback` | signed state cookie | exchange code, set browser session |
| `GET /api/auth/session` | browser session cookie | approval-page details + CSRF token |
| `POST /api/auth/approve` | cookie + CSRF + session id | approve; mints one-time code |
| `POST /api/auth/deny` | cookie + CSRF + session id | deny and cancel |
| `POST /api/auth/logout` | same-origin | clear browser cookies |
| `GET /api/auth/health` | none | configuration presence (no secrets) |

## GitHub OAuth App setup

1. GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**.
2. Fill in exactly:
   - **Application name**: `SeedCode CLI`
   - **Homepage URL**: `https://seedcode-web.vercel.app`
   - **Authorization callback URL**: `https://seedcode-web.vercel.app/api/auth/oauth/callback`
3. Register it, copy the **Client ID**, then **Generate a new client secret**.
4. Put both in the Vercel project environment as `GITHUB_CLIENT_ID` and
   `GITHUB_CLIENT_SECRET` (never in the repository, never in browser code).

The callback URL must match `PUBLIC_BASE_URL` exactly, including the scheme.
The site, the installers and this backend all use `seedcode-web.vercel.app`;
if you attach a custom domain, change `PUBLIC_BASE_URL` and the GitHub callback
URL together.

Scopes default to `read:user` (profile only). Override with
`GITHUB_OAUTH_SCOPES` if the Copilot SDK needs more; the approval page lists
permissions from the scope that was actually granted.

After deploying, open `/api/auth/health`. It reports `ready: true` when every
variable is set, otherwise `missing` names what is absent, and
`github_callback_url` shows the exact URL GitHub must have.

## CLI protocol

PKCE: generate a random `code_verifier` (43–128 chars of `A-Za-z0-9-_`) and send
`code_challenge = base64url(sha256(code_verifier))`.

1. `POST /api/auth/cli/session` with
   `{ client_name, client_version, os, code_challenge }` →
   `201 { session_id, device_code, user_code, verification_uri,
   verification_uri_complete, expires_at, interval }`.
2. Show `user_code` and open `verification_uri_complete` in the browser.
3. Poll `POST /api/auth/cli/poll` with `{ session_id, device_code }` every
   `interval` seconds (never faster than 3 s; a `429 slow_down` means wait).
   `status` is `pending`, `approved`, `denied` or `expired`. `approved` also
   carries a one-time `authorization_code`.
4. `POST /api/auth/cli/token` with
   `{ session_id, device_code, authorization_code, code_verifier }` →
   `{ access_token, token_type, scope, github }`. This works once; a replay
   returns `409 replayed`. Store the token in the OS credential store.

The CLI must use the same base URL as the site: `https://seedcode-web.vercel.app`.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| GitHub says the `redirect_uri` is not associated with the app | Callback URL in the OAuth App differs from `PUBLIC_BASE_URL` |
| Approve fails with `bad_origin` | The site is opened on a different host than `PUBLIC_BASE_URL` |
| `/api/auth/health` shows `ready: false` | Names in `missing` are not set for this Vercel environment |
| Every login ends on the sign-in page with `oauth_failed` | Wrong client secret, or the OAuth App was deleted |

## Vercel configuration

1. Import the repository with **Root Directory** set to `WEB`.
2. Add the variables from [`.env.example`](.env.example): `PUBLIC_BASE_URL`,
   `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `AUTH_SESSION_SECRET`,
   `AUTH_ENCRYPTION_KEY`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`.
3. Create a Vercel KV (Upstash Redis) store and connect it to the project.
   Production refuses to run without it: pending OAuth state must not live in
   a single function instance.
4. Deploy. Static pages are served from the project root, the API functions
   from `api/`, and `vercel.json` supplies rewrites, clean URLs, CSP, and
   no-store headers for authentication responses.

Generate the two secrets:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"  # AUTH_ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"  # AUTH_SESSION_SECRET
```

## Security properties

- PKCE S256 for GitHub OAuth; the verifier is stored server-side, keyed by a
  one-use `state`, and never enters the browser.
- OAuth `state` is compared against an HMAC-signed, HttpOnly, SameSite=Lax
  cookie before the code is exchanged.
- Browser approval requires the signed GitHub session cookie, a CSRF header
  that matches the `sc_csrf` cookie, a same-origin request, and the exact
  session id from the cookie.
- Session and one-time codes expire (10 min / 2 min by default). The
  authorization code is consumed atomically (`GETDEL`), so replays and
  duplicate approvals fail.
- The GitHub token is AES-256-GCM encrypted at rest, returned once over TLS to
  the CLI that proved its device code, then deleted from the session.
- Rate limits cover session creation, polling, lookups, approval, denial and
  token exchange. Responses are `no-store`; secrets are never logged or placed
  in URLs.
- The `/auth/` pages are `noindex`, frame-denied, and use a strict CSP with no
  inline scripts or styles.

## Tests

```bash
node --test WEB/tests/auth-flow.test.js
```

The test drives the real handlers with an in-memory store and a mocked GitHub
token/profile response. It proves the pending → approval → one-time handoff →
replay rejection chain, CSRF rejection, wrong-browser approval, denial, invalid
state, expiry, duplicate approval and wrong device codes.

A true end-to-end test still requires a registered OAuth App, a deployed
backend, a GitHub account with Copilot access, and `github-copilot-sdk`
installed in the CLI environment. Nothing in this repository claims otherwise.
