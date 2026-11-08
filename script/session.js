/* Small shared helpers for the auth pages. No secrets, no storage. */
(function () {
  "use strict";

  const config = window.SEEDCODE_AUTH;
  const DEFAULT_TIMEOUT_MS = 15000;

  function failure(message, code, status) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    return error;
  }

  async function api(path, options) {
    const settings = options || {};
    const headers = Object.assign({ Accept: "application/json" }, settings.headers || {});
    if (settings.body !== undefined) headers["Content-Type"] = "application/json";
    const timeoutMs =
      Number(settings.timeoutMs) > 0 ? Number(settings.timeoutMs) : DEFAULT_TIMEOUT_MS;
    // Every loading state must resolve. A stalled request aborts instead of
    // leaving a disabled button and a spinner on screen forever.
    const controller = new AbortController();
    const timer = window.setTimeout(function () {
      controller.abort();
    }, timeoutMs);
    let response;
    try {
      response = await fetch(config.apiBase + path, {
        method: settings.method || "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers: headers,
        body: settings.body === undefined ? undefined : JSON.stringify(settings.body),
        signal: controller.signal,
      });
    } catch (_) {
      // Clear the abort timer even when fetch rejects immediately; otherwise a
      // failed request leaves a timer alive until the full timeout elapses.
      window.clearTimeout(timer);
      if (controller.signal.aborted) {
        throw failure(
          "SeedCode took too long to respond. Check your connection and try again.",
          "timeout",
          0
        );
      }
      throw failure(
        "Could not reach SeedCode. Check your connection and try again.",
        "network",
        0
      );
    }
    let data = null;
    try {
      const text = await response.text();
      if (text) data = JSON.parse(text);
    } catch (_) {
      if (controller.signal.aborted) {
        throw failure("SeedCode took too long to respond. Try again.", "timeout", 0);
      }
      data = null;
    } finally {
      window.clearTimeout(timer);
    }
    if (!response.ok) {
      const error = new Error((data && data.message) || "The request could not be completed.");
      error.code = data && data.error;
      error.status = response.status;
      throw error;
    }
    if (data === null) {
      throw failure(
        "SeedCode returned an unexpected response. Reload the page and try again.",
        "bad_response",
        502
      );
    }
    return data;
  }

  function param(name) {
    return new URLSearchParams(window.location.search).get(name) || "";
  }

  function setText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = value == null ? "" : String(value);
  }

  function showError(message) {
    const box = document.getElementById("error");
    if (!box) return;
    box.textContent = message;
    box.classList.remove("hidden");
  }

  function clearError() {
    const box = document.getElementById("error");
    if (!box) return;
    box.textContent = "";
    box.classList.add("hidden");
  }

  function hide(id) {
    const element = document.getElementById(id);
    if (element) element.classList.add("hidden");
  }

  function reveal(id) {
    const element = document.getElementById(id);
    if (element) element.classList.remove("hidden");
  }

  function formatTime(epochSeconds) {
    if (!epochSeconds) return "—";
    try {
      return new Date(Number(epochSeconds) * 1000).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
    } catch (_) {
      return "—";
    }
  }

  function shortSession(id) {
    const value = String(id || "");
    return value.length > 14 ? value.slice(0, 8) + "…" + value.slice(-4) : value;
  }

  /** Mark the sign-in rail: 1-3 is the current stage, 4 means everything is done. */
  function setSteps(current) {
    const rail = document.getElementById("steps");
    if (!rail) return;
    Array.prototype.forEach.call(rail.children, function (item, index) {
      const number = index + 1;
      item.classList.toggle("done", current === 4 || number < current);
      if (number === current) item.setAttribute("aria-current", "step");
      else item.removeAttribute("aria-current");
    });
  }

  window.SCSession = {
    api,
    param,
    setText,
    showError,
    clearError,
    hide,
    reveal,
    formatTime,
    shortSession,
    setSteps,
  };
})();
