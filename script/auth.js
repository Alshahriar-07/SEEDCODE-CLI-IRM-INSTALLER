/* SeedCode sign-in pages. One file, one job per data-page value. */
(function () {
  "use strict";

  const S = window.SCSession;
  const { api, param, setText, showError, clearError, hide, reveal, formatTime, shortSession, setSteps } = S;
  const page = document.body.getAttribute("data-page");

  // Plain-language text for every code the backend can return.
  const ERROR_TEXT = {
    oauth_denied: "GitHub sign-in was cancelled. You can try again.",
    oauth_missing: "GitHub didn’t return what SeedCode needs. Try signing in again.",
    missing_state: "The sign-in attempt couldn’t be verified. Try signing in again.",
    state_mismatch: "The sign-in attempt couldn’t be verified. Try signing in again.",
    invalid_state: "That sign-in attempt expired or was already used. Try signing in again.",
    oauth_failed: "GitHub sign-in failed. Try again.",
    expired: "This terminal session expired. Run /provider in your terminal to start a new login.",
    code_expired: "The approval expired. Run /provider in your terminal to start a new login.",
    not_pending: "This terminal session is no longer waiting for approval.",
    sign_in_required: "Sign in with GitHub to continue.",
    unauthorized: "This session belongs to a different GitHub account. Start a new login from your terminal.",
    wrong_session: "That approval belongs to a different terminal session.",
    already_approved: "This terminal session is already approved. You can close this tab.",
    not_found: "That code isn’t waiting for a login. Check the terminal, or start a new login.",
    invalid_code: "Enter the full code shown in your terminal, like ABCD-EF23.",
    invalid_session: "This sign-in link isn’t valid. Start a new login from your terminal.",
    missing_session: "This page needs a terminal session. Start from your terminal or enter its code.",
    rate_limited: "Too many attempts. Wait a minute, then try again.",
    busy: "Another request is in progress. Try again in a moment.",
    csrf: "This request couldn’t be verified. Reload the page and try again.",
    bad_origin: "Open this page from the SeedCode website and try again.",
    network: "Could not reach SeedCode. Check your connection and try again.",
    timeout: "SeedCode took too long to respond. Check your connection and try again.",
    bad_response: "SeedCode returned an unexpected response. Reload the page and try again.",
    server_error: "Sign-in is temporarily unavailable. Try again in a minute.",
  };

  function errorMessage(error) {
    const code = typeof error === "string" ? error : error && error.code;
    if (code && ERROR_TEXT[code]) return ERROR_TEXT[code];
    if (error && error.message && error.status && error.status < 500) return error.message;
    return "Something went wrong. Start again from your terminal.";
  }

  function setAvatar(image, account) {
    if (!image || !account || !account.avatar_url) return;
    try {
      const url = new URL(account.avatar_url);
      if (url.host === window.SEEDCODE_AUTH.avatarHost && url.protocol === "https:") {
        image.src = url.toString();
        image.alt = "GitHub avatar for " + account.login;
        image.classList.remove("hidden");
      }
    } catch (_) {
      /* no avatar is fine */
    }
  }

  /** ABCD-EF23: uppercase, letters and digits only, dash after the fourth character. */
  function formatCode(raw) {
    const clean = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    return clean.length > 4 ? clean.slice(0, 4) + "-" + clean.slice(4) : clean;
  }

  function renderCode(containerId, code) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.textContent = "";
    container.setAttribute("aria-label", "Terminal code " + code.split("").join(" "));
    code.split("").forEach(function (char) {
      const cell = document.createElement("span");
      cell.textContent = char;
      if (char === "-") cell.className = "dash";
      container.appendChild(cell);
    });
  }

  function githubStartUrl(session) {
    return "/api/auth/oauth/start?session=" + encodeURIComponent(session);
  }

  async function initIndex() {
    const form = document.getElementById("code-form");
    const input = document.getElementById("code");
    const check = document.getElementById("check");
    const reset = document.getElementById("reset");

    function invalid(state) {
      if (input) input.setAttribute("aria-invalid", state ? "true" : "false");
    }

    async function lookup(value) {
      clearError();
      invalid(false);
      const code = formatCode(value);
      if (code.length !== 9) {
        invalid(true);
        showError(errorMessage("invalid_code"));
        if (input) input.focus();
        return;
      }
      if (check) {
        check.disabled = true;
        check.textContent = "Checking…";
      }
      try {
        const result = await api("/lookup", { method: "POST", body: { code: code } });
        if (!result || !result.session_id) {
          const bad = new Error("Unexpected lookup response");
          bad.code = "bad_response";
          throw bad;
        }
        renderCode("pending-code", code);
        setText("pending-session", shortSession(result.session_id));
        document.getElementById("continue").href = githubStartUrl(result.session_id);
        hide("code-panel");
        reveal("pending-panel");
        setText("title", "Confirm your terminal");
        setText("lead", "Check that this matches the code in your terminal, then sign in with GitHub.");
        setSteps(2);
        document.getElementById("continue").focus();
      } catch (error) {
        invalid(true);
        showError(errorMessage(error));
        if (input) input.focus();
      } finally {
        if (check) {
          check.disabled = false;
          check.textContent = "Check code";
        }
      }
    }

    if (input) {
      input.addEventListener("input", function () {
        input.value = formatCode(input.value);
        invalid(false);
      });
    }
    if (form && input) {
      form.addEventListener("submit", function (event) {
        event.preventDefault();
        lookup(input.value);
      });
    }
    if (reset) {
      reset.addEventListener("click", function () {
        clearError();
        hide("pending-panel");
        reveal("code-panel");
        setText("title", "Link your terminal");
        setText("lead", "Enter the code your terminal is showing, then sign in with GitHub to finish.");
        setSteps(1);
        if (input) {
          input.value = "";
          input.focus();
        }
      });
    }

    const fromLink = formatCode(param("code"));
    if (fromLink) {
      if (input) input.value = fromLink;
      lookup(fromLink);
    }
  }

  function initLogin() {
    const session = param("session");
    const error = param("error");
    const button = document.getElementById("continue-github");

    if (error) showError(errorMessage(error));
    if (!session) {
      if (!error) showError(errorMessage("missing_session"));
      hide("login-actions");
      reveal("login-restart");
      return;
    }
    if (button) button.href = githubStartUrl(session);
    setText("session-short", shortSession(session));
    if (error) setText("github-label", "Try GitHub again");
  }

  function startCountdown(expiresAt, onExpired) {
    const label = document.getElementById("expires-in");
    if (!label || !expiresAt) return;
    function tick() {
      const left = Number(expiresAt) - Math.floor(Date.now() / 1000);
      if (left <= 0) {
        label.textContent = "expired";
        label.classList.add("warn");
        window.clearInterval(timer);
        onExpired();
        return;
      }
      const minutes = Math.floor(left / 60);
      const seconds = String(left % 60).padStart(2, "0");
      label.textContent = minutes + ":" + seconds;
      label.classList.toggle("warn", left <= 60);
    }
    const timer = window.setInterval(tick, 1000);
    tick();
  }

  async function initApprove() {
    const session = param("session");
    if (!session) {
      showError(errorMessage("missing_session"));
      hide("session-details");
      hide("decision");
      hide("loading-note");
      return;
    }
    let info;
    try {
      info = await api("/session?session=" + encodeURIComponent(session));
    } catch (error) {
      if (error.status === 401) {
        window.location.replace(
          "/auth/login?session=" + encodeURIComponent(session) + "&error=sign_in_required"
        );
        return;
      }
      showError(errorMessage(error));
      hide("session-details");
      hide("decision");
      hide("loading-note");
      return;
    }

    if (!info || !info.github || !info.client) {
      showError(errorMessage("bad_response"));
      hide("session-details");
      hide("decision");
      hide("loading-note");
      return;
    }

    setAvatar(document.getElementById("avatar"), info.github);
    setText("github-name", info.github.name || info.github.login);
    setText("github-login", "@" + info.github.login);
    setText("client-name", info.client.name || "SeedCode CLI");
    setText("client-version", info.client.version || "");
    setText("client-os", info.client.os || "unknown");
    setText("session-id", shortSession(session));
    setText("requested-at", formatTime(info.created_at));

    const list = document.getElementById("permissions");
    if (list) {
      list.textContent = "";
      (info.permissions || []).forEach(function (permission) {
        const item = document.createElement("li");
        item.textContent = permission;
        list.appendChild(item);
      });
    }
    hide("loading-note");

    if (info.status === "approved") {
      reveal("already-approved");
      hide("decision");
      setText("expires-in", "—");
      return;
    }
    if (info.status !== "pending") {
      showError(errorMessage("not_pending"));
      hide("decision");
      setText("expires-in", "—");
      return;
    }

    const approve = document.getElementById("approve");
    const deny = document.getElementById("deny");
    const csrf = info.csrf_token;

    function lock() {
      approve.disabled = true;
      deny.disabled = true;
    }

    async function decide(path, trigger, busyLabel) {
      clearError();
      lock();
      const original = trigger.textContent;
      trigger.textContent = busyLabel;
      try {
        const result = await api(path, {
          method: "POST",
          headers: { "x-seedcode-csrf": csrf },
          body: { session_id: session },
        });
        if (
          !result ||
          typeof result.redirect !== "string" ||
          !result.redirect.startsWith("/") ||
          result.redirect.startsWith("//")
        ) {
          const bad = new Error("Unexpected approval response");
          bad.code = "bad_response";
          throw bad;
        }
        window.location.assign(result.redirect);
      } catch (error) {
        trigger.textContent = original;
        showError(errorMessage(error));
        approve.disabled = false;
        deny.disabled = false;
      }
    }

    approve.disabled = false;
    deny.disabled = false;
    approve.addEventListener("click", function () {
      decide("/approve", approve, "Approving…");
    });
    deny.addEventListener("click", function () {
      decide("/deny", deny, "Denying…");
    });
    startCountdown(info.expires_at, function () {
      lock();
      showError(errorMessage("expired"));
    });
  }

  /**
   * This page never assumes the approval happened. Without a session it says so;
   * it only shows the success state after the backend confirms `approved`.
   */
  async function initSuccess() {
    const session = param("session");
    const connectedTitle = "Terminal connected";
    const connectedLead =
      "Go back to your terminal. It finishes signing in on its own and lists the GitHub Copilot models your account can use.";

    function notConfirmed(message, note) {
      setText("title", "Approval not confirmed");
      setText("success-lead", message);
      setText("success-note", note);
    }

    if (!session) {
      setText("title", "Nothing to confirm");
      setText(
        "success-lead",
        "This page confirms a terminal approval. Start a login from your terminal to see the result here."
      );
      setText("success-note", "No terminal session was linked to this page.");
      return;
    }
    let info;
    try {
      info = await api("/session?session=" + encodeURIComponent(session));
    } catch (_) {
      // A consumed or cleared session is normal after the CLI collects its
      // credential, but this browser has no evidence of success to show.
      notConfirmed(
        "This browser can’t confirm the terminal approval right now. If you just approved a terminal, check the terminal: it finishes on its own.",
        "If the terminal is still waiting, start a new login from it."
      );
      return;
    }
    if (!info || !info.github || !info.client) {
      notConfirmed(
        "SeedCode returned an unexpected response. Check your terminal to see whether the login finished.",
        "You can close this tab."
      );
      return;
    }
    if (info.status !== "approved") {
      const statusText =
        { pending: "still pending", denied: "denied", expired: "expired", consumed: "already used" }[
          info.status
        ] || "not approved";
      setText("title", "Terminal not approved");
      setText(
        "success-lead",
        "This terminal session is " + statusText + ", so nothing was connected."
      );
      setText("success-note", "Run /provider in your terminal to start a new login.");
      return;
    }

    setAvatar(document.getElementById("avatar"), info.github);
    setText("github-name", info.github.name || info.github.login);
    setText("github-login", "@" + info.github.login);
    setText(
      "connected-client",
      (info.client.name || "SeedCode CLI") + " on " + (info.client.os || "this machine")
    );
    setText("session-short", shortSession(session));
    setText("title", connectedTitle);
    setText("success-lead", connectedLead);
    setText("success-note", "You can close this tab.");
    reveal("steps");
    reveal("connected");
  }

  if (page === "index") initIndex();
  else if (page === "login") initLogin();
  else if (page === "approve") initApprove();
  else if (page === "success") initSuccess();
})();
