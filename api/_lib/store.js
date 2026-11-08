"use strict";

/**
 * Session store.
 *
 * Production uses a Redis-compatible REST key/value store (Vercel KV or
 * Upstash). A process-local map exists only for local development and tests;
 * production fails closed when no store is configured, so pending OAuth
 * sessions are never kept in an instance that may disappear between requests.
 */

const config = require("./config");

const PREFIX = "sc:";

class MemoryStore {
  constructor() {
    this.map = new Map();
  }

  #alive(entry) {
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      this.map.delete(entry.key);
      return null;
    }
    return entry;
  }

  async get(key) {
    const entry = this.#alive(this.map.get(key));
    return entry ? entry.value : null;
  }

  async set(key, value, ttlSeconds) {
    this.map.set(key, {
      key,
      value: String(value),
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : 0,
    });
  }

  async setNx(key, value, ttlSeconds) {
    if (this.#alive(this.map.get(key))) return false;
    await this.set(key, value, ttlSeconds);
    return true;
  }

  async take(key) {
    const entry = this.#alive(this.map.get(key));
    if (!entry) return null;
    this.map.delete(key);
    return entry.value;
  }

  async del(key) {
    this.map.delete(key);
  }

  async incr(key) {
    const entry = this.#alive(this.map.get(key));
    const next = (entry ? Number(entry.value) : 0) + 1;
    this.map.set(key, {
      key,
      value: String(next),
      expiresAt: entry ? entry.expiresAt : 0,
    });
    return next;
  }

  async expire(key, ttlSeconds) {
    const entry = this.map.get(key);
    if (entry) entry.expiresAt = Date.now() + ttlSeconds * 1000;
  }
}

class RestStore {
  constructor(url, token) {
    this.url = url.replace(/\/+$/, "");
    this.token = token;
  }

  async #command(command) {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`Session store request failed (${response.status})`);
    }
    const payload = await response.json();
    if (payload && payload.error) throw new Error("Session store command failed");
    return payload ? payload.result : null;
  }

  async get(key) {
    return this.#command(["GET", key]);
  }

  async set(key, value, ttlSeconds) {
    const command = ttlSeconds ? ["SET", key, value, "EX", ttlSeconds] : ["SET", key, value];
    await this.#command(command);
  }

  async setNx(key, value, ttlSeconds) {
    const command = ["SET", key, value, "NX"];
    if (ttlSeconds) command.push("EX", ttlSeconds);
    return (await this.#command(command)) === "OK";
  }

  async take(key) {
    return this.#command(["GETDEL", key]);
  }

  async del(key) {
    await this.#command(["DEL", key]);
  }

  async incr(key) {
    return Number(await this.#command(["INCR", key]));
  }

  async expire(key, ttlSeconds) {
    await this.#command(["EXPIRE", key, ttlSeconds]);
  }
}

let cached = null;

function createStore() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return new RestStore(url, token);
  if (config.memoryStoreAllowed) return new MemoryStore();
  throw new Error(
    "No session store configured. Set KV_REST_API_URL and KV_REST_API_TOKEN (or Upstash equivalents)."
  );
}

function store() {
  if (!cached) cached = createStore();
  return cached;
}

/** JSON helpers so every record is written with an explicit TTL. */
async function getJson(key, fallback = null) {
  const raw = await store().get(PREFIX + key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function putJson(key, value, ttlSeconds) {
  await store().set(PREFIX + key, JSON.stringify(value), ttlSeconds);
}

async function takeJson(key) {
  const raw = await store().take(PREFIX + key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function remove(key) {
  await store().del(PREFIX + key);
}

async function lock(key, ttlSeconds = 10) {
  return store().setNx(PREFIX + `lock:${key}`, "1", ttlSeconds);
}

async function unlock(key) {
  await store().del(PREFIX + `lock:${key}`);
}

module.exports = { getJson, putJson, takeJson, remove, lock, unlock, store, MemoryStore };
