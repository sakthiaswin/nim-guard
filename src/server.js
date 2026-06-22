import http from "node:http";
import { URL } from "node:url";
import dotenv from "dotenv";
import { TokenBucketLimiter } from "./limiter.js";
import { estimateRequestTokens, extractActualTokens } from "./estimator.js";
import { compressRequestBody } from "./compress.js";
import { getLimitsForModel } from "./modelLimits.js";

dotenv.config();

const PORT = Number(process.env.PORT) || 8788;
const HOST = process.env.HOST || "127.0.0.1";
const NIM_BASE_URL = process.env.NIM_BASE_URL || "https://integrate.api.nvidia.com/v1";
const NIM_API_KEY = process.env.NIM_API_KEY || "";
const COMPRESSION_ENABLED = process.env.COMPRESSION_ENABLED !== "false";
const LOG_LEVEL = process.env.LOG_LEVEL || "info";

// Fallback model chain — tried in order when a model returns 429.
// FALLBACK_MODELS env: comma-separated model IDs in priority order.
// The first entry is the primary (what opencode requests gets mapped to this
// if the requested model isn't in the list). Subsequent entries are fallbacks.
const FALLBACK_MODELS = (process.env.FALLBACK_MODELS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Per-model 429 cooldown tracking: model -> timestamp when cooldown expires.
// When a model 429s from NIM (server busy), we skip it for COOLDOWN_MS.
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS) || 60_000;
const modelCooldowns = new Map();

function isOnCooldown(model) {
  const until = modelCooldowns.get(model);
  if (!until) return false;
  if (Date.now() < until) return true;
  modelCooldowns.delete(model);
  return false;
}

function setCooldown(model) {
  modelCooldowns.set(model, Date.now() + COOLDOWN_MS);
  log("warn", `Model "${model}" on cooldown for ${COOLDOWN_MS / 1000}s due to 429`);
}

if (!NIM_API_KEY) {
  console.error(
    "[nim-guard] WARNING: NIM_API_KEY is not set. Set it in .env or pass Authorization header."
  );
}

// One limiter per model.
const limiters = new Map();
function getLimiter(model) {
  if (!limiters.has(model)) {
    const { rpm, tpm } = getLimitsForModel(model);
    limiters.set(model, new TokenBucketLimiter({ rpm, tpm, name: model }));
    log("info", `Initialized limiter for "${model}": ${rpm} RPM / ${tpm} TPM`);
  }
  return limiters.get(model);
}

function log(level, ...args) {
  const levels = { debug: 0, info: 1, warn: 2, error: 3 };
  if ((levels[level] ?? 1) >= (levels[LOG_LEVEL] ?? 1)) {
    console.log(`[nim-guard ${new Date().toISOString()}] [${level}]`, ...args);
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * Build the ordered list of models to try for a given requested model.
 * - If the requested model is in the fallback list, start from it.
 * - Otherwise prepend it so it's always tried first.
 * - Skip models currently on cooldown (429'd recently).
 */
function buildTryList(requestedModel) {
  let chain =
    FALLBACK_MODELS.length > 0
      ? FALLBACK_MODELS.includes(requestedModel)
        ? FALLBACK_MODELS.slice(FALLBACK_MODELS.indexOf(requestedModel))
        : [requestedModel, ...FALLBACK_MODELS]
      : [requestedModel];

  // Put cooldown models at the end rather than dropping them entirely —
  // if everything else fails we'll still try them as a last resort.
  const available = chain.filter((m) => !isOnCooldown(m));
  const cooled = chain.filter((m) => isOnCooldown(m));
  return [...available, ...cooled];
}

/**
 * Attempt a single upstream call to NIM with the given model.
 * Returns { ok, status, body, isStream, usageTokens } or throws on network error.
 */
async function attemptNim(upstreamPath, headers, bodyToSend, model) {
  const upstreamUrl = NIM_BASE_URL.replace(/\/$/, "") + upstreamPath;
  const bodyWithModel = JSON.stringify({ ...bodyToSend, model });

  const upstreamRes = await fetch(upstreamUrl, {
    method: "POST",
    headers,
    body: bodyWithModel,
  });

  return { upstreamRes, bodyWithModel };
}

/** Stream NIM's SSE response back to the client, returning actual token count. */
async function pipeStream(upstreamRes, res, logModel, estTokens) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  let usageTokens = null;
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of upstreamRes.body) {
    const text = decoder.decode(chunk, { stream: true });
    buffer += text;
    res.write(chunk);

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const parsed = JSON.parse(payload);
        const u = extractActualTokens(parsed);
        if (u != null) usageTokens = u;
      } catch { /* mid-stream partial chunks are not valid JSON */ }
    }
  }
  res.end();
  log("debug", `Stream complete for "${logModel}": estimated ${estTokens}, actual ${usageTokens ?? "unknown"}`);
  return usageTokens;
}

/** Main proxy handler — compresses, rate-limits, tries fallback chain on 429. */
async function proxyToNim(req, res, parsedBody) {
  const requestedModel = parsedBody.model || "unknown";

  // 1. Compress once — same compressed body is reused across fallback attempts.
  let bodyToSend = parsedBody;
  if (COMPRESSION_ENABLED) {
    const result = compressRequestBody(parsedBody);
    bodyToSend = result.body;
    if (result.stats.transformsApplied.length) {
      log("debug", `Compressed "${requestedModel}": ~${result.stats.tokensSavedEstimate} tokens saved`, result.stats.transformsApplied);
    }
  }

  const estTokens = estimateRequestTokens(bodyToSend);
  const upstreamPath = req.url.replace(/^\/v1/, "");
  const authHeader = req.headers["authorization"] || `Bearer ${NIM_API_KEY}`;
  const headers = { "Content-Type": "application/json", Authorization: authHeader };

  const tryList = buildTryList(requestedModel);
  log("debug", `Fallback chain for "${requestedModel}":`, tryList);

  let lastError = null;

  for (let i = 0; i < tryList.length; i++) {
    const model = tryList[i];
    const isFallback = model !== requestedModel;
    if (isFallback) {
      log("info", `Falling back to "${model}" (attempt ${i + 1}/${tryList.length})`);
    }

    // 2. Rate-limit gate per model.
    const limiter = getLimiter(model);
    const reservation = await limiter.acquire(estTokens, {
      onWait: (ms, name) => log("info", `Queueing for "${name}": waiting ${ms}ms`),
    });
    if (reservation.waitedMs > 50) {
      log("info", `"${model}" proceeded after ${reservation.waitedMs}ms queue wait`);
    }

    // 3. Call NIM.
    let upstreamRes;
    try {
      ({ upstreamRes } = await attemptNim(upstreamPath, headers, bodyToSend, model));
    } catch (err) {
      reservation.release();
      log("error", `Network error calling "${model}":`, err.message);
      lastError = err.message;
      continue; // try next model
    }

    // 4a. 429 — server busy or rate limit. Put on cooldown, try next model.
    if (upstreamRes.status === 429) {
      reservation.release();
      setCooldown(model);
      lastError = `429 from "${model}"`;
      const remaining = tryList.slice(i + 1);
      if (remaining.length > 0) {
        log("info", `"${model}" returned 429 (server busy), trying next: "${remaining[0]}"`);
        continue;
      } else {
        log("warn", `All models exhausted after 429s. No fallback remaining.`);
        break;
      }
    }

    // 4b. Other non-200 error — release budget, pass error through, stop chain.
    if (!upstreamRes.ok) {
      reservation.release();
      const text = await upstreamRes.text();
      log("warn", `"${model}" returned ${upstreamRes.status}`);
      res.writeHead(upstreamRes.status, { "Content-Type": upstreamRes.headers.get("content-type") || "application/json" });
      return res.end(text);
    }

    // 4c. Success — pipe response back, rewriting model name to what opencode
    // originally asked for so it stays context-consistent.
    const isStream = bodyToSend.stream === true;

    if (isFallback) {
      log("info", `Using "${model}" as fallback for "${requestedModel}" — context preserved`);
    }

    if (isStream && upstreamRes.body) {
      const usageTokens = await pipeStream(upstreamRes, res, model, estTokens);
      reservation.commit(usageTokens ?? estTokens);
      return;
    }

    // Non-streaming: rewrite model field in response so opencode sees the
    // model it requested, keeping session context consistent.
    let text = await upstreamRes.text();
    try {
      const parsed = JSON.parse(text);
      const actual = extractActualTokens(parsed);
      reservation.commit(actual ?? estTokens);
      log("debug", `"${model}" complete: estimated ${estTokens}, actual ${actual ?? "unknown"}`);
      // Transparently rewrite model name back to what was requested.
      if (isFallback && parsed.model) {
        parsed.model = requestedModel;
        text = JSON.stringify(parsed);
      }
    } catch {
      reservation.commit(estTokens);
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(text);
  }

  // All models failed.
  if (!res.headersSent) {
    sendJson(res, 503, {
      error: {
        message: `nim-guard: all models in fallback chain failed. Last error: ${lastError}`,
        fallback_chain: tryList,
      },
    });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/healthz") {
    return sendJson(res, 200, { status: "ok", uptime: process.uptime() });
  }

  if (req.method === "GET" && url.pathname === "/stats") {
    const snapshot = Array.from(limiters.values()).map((l) => l.snapshot());
    const cooldowns = Object.fromEntries(
      Array.from(modelCooldowns.entries()).map(([m, until]) => [m, { cooldownUntil: new Date(until).toISOString(), remainingMs: until - Date.now() }])
    );
    return sendJson(res, 200, { models: snapshot, cooldowns, fallbackChain: FALLBACK_MODELS });
  }

  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    const rawBodyBuf = await readBody(req);
    let parsedBody;
    try {
      parsedBody = JSON.parse(rawBodyBuf.toString("utf8"));
    } catch {
      return sendJson(res, 400, { error: { message: "nim-guard: invalid JSON body" } });
    }
    try {
      await proxyToNim(req, res, parsedBody);
    } catch (err) {
      log("error", "Unhandled error:", err);
      if (!res.headersSent) sendJson(res, 500, { error: { message: `nim-guard: ${err.message}` } });
    }
    return;
  }

  // Passthrough for /v1/models etc.
  const upstreamUrl = NIM_BASE_URL.replace(/\/$/, "") + req.url.replace(/^\/v1/, "");
  const rawBodyBuf = req.method !== "GET" ? await readBody(req) : undefined;
  try {
    const upstreamRes = await fetch(upstreamUrl, {
      method: req.method,
      headers: {
        "Content-Type": "application/json",
        Authorization: req.headers["authorization"] || `Bearer ${NIM_API_KEY}`,
      },
      body: rawBodyBuf,
    });
    const text = await upstreamRes.text();
    res.writeHead(upstreamRes.status, { "Content-Type": upstreamRes.headers.get("content-type") || "application/json" });
    res.end(text);
  } catch (err) {
    sendJson(res, 502, { error: { message: `nim-guard: passthrough failed: ${err.message}` } });
  }
});

server.listen(PORT, HOST, () => {
  log("info", `nim-guard listening on http://${HOST}:${PORT}`);
  log("info", `Forwarding to NIM at ${NIM_BASE_URL}`);
  log("info", `Compression: ${COMPRESSION_ENABLED ? "enabled" : "disabled"}`);
  log("info", `Fallback chain: ${FALLBACK_MODELS.length ? FALLBACK_MODELS.join(" → ") : "(none configured)"}`);
  log("info", `Point opencode at: http://${HOST}:${PORT}/v1`);
});
