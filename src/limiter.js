/**
 * Token-bucket rate limiter for RPM (requests/min) and TPM (tokens/min).
 *
 * Behavior: QUEUE AND WAIT, never reject.
 * When a request would exceed either bucket, it waits (async) until
 * enough capacity frees up, then proceeds. This guarantees the caller
 * (opencode, subagents, anything) never sees a 429 from us — only
 * added latency, which is what the user asked for.
 *
 * Two independent buckets (RPM, TPM) are checked; the request waits
 * for whichever recovers later.
 */

export class TokenBucketLimiter {
  /**
   * @param {object} opts
   * @param {number} opts.rpm - max requests per rolling 60s window
   * @param {number} opts.tpm - max tokens per rolling 60s window
   * @param {string} [opts.name] - label for logging
   * @param {number} [opts.safetyMarginPct] - reserve this % of capacity as headroom (default 5%)
   */
  constructor({ rpm, tpm, name = "default", safetyMarginPct = 5 }) {
    this.name = name;
    this.rpmLimit = Math.max(1, Math.floor(rpm * (1 - safetyMarginPct / 100)));
    this.tpmLimit = Math.max(1, Math.floor(tpm * (1 - safetyMarginPct / 100)));
    this.rawRpm = rpm;
    this.rawTpm = tpm;

    // Sliding window logs: arrays of {ts, cost}
    this.requestLog = [];
    this.tokenLog = [];

    // FIFO queue of waiters, each resolved in order once capacity exists.
    this._queue = [];
    this._processing = false;

    // Stats
    this.stats = {
      totalRequests: 0,
      totalTokensReserved: 0,
      totalTokensActual: 0,
      totalWaitMs: 0,
      maxWaitMs: 0,
      queuedCount: 0,
    };
  }

  _prune(log, now) {
    const cutoff = now - 60_000;
    let i = 0;
    while (i < log.length && log[i].ts < cutoff) i++;
    if (i > 0) log.splice(0, i);
  }

  _currentRequestCount(now) {
    this._prune(this.requestLog, now);
    return this.requestLog.length;
  }

  _currentTokenSum(now) {
    this._prune(this.tokenLog, now);
    let sum = 0;
    for (const e of this.tokenLog) sum += e.cost;
    return sum;
  }

  /**
   * Returns ms to wait until at least one more request slot AND
   * `estTokens` more token capacity will be available. 0 if available now.
   */
  _msUntilCapacity(estTokens, now) {
    this._prune(this.requestLog, now);
    this._prune(this.tokenLog, now);

    let waitForRpm = 0;
    if (this.requestLog.length >= this.rpmLimit) {
      // wait until oldest request ages out of the 60s window
      const oldest = this.requestLog[0].ts;
      waitForRpm = oldest + 60_000 - now;
    }

    let waitForTpm = 0;
    const currentTokens = this.tokenLog.reduce((s, e) => s + e.cost, 0);
    if (currentTokens + estTokens > this.tpmLimit) {
      // walk forward through the token log until enough has aged out
      let projected = currentTokens;
      for (const e of this.tokenLog) {
        if (projected + estTokens <= this.tpmLimit) break;
        projected -= e.cost;
        waitForTpm = e.ts + 60_000 - now;
      }
      if (projected + estTokens > this.tpmLimit) {
        // even after full drain still won't fit (estTokens > tpmLimit alone) —
        // cap wait to window length; caller's single request just eats whole budget
        waitForTpm = Math.max(waitForTpm, 60_000);
      }
    }

    return Math.max(0, waitForRpm, waitForTpm);
  }

  /**
   * Reserve capacity for a request with an *estimated* token cost.
   * Resolves once capacity is available, recording the reservation.
   * Returns a handle: { commit(actualTokens), release() }
   */
  async acquire(estTokens, { onWait } = {}) {
    const startedAt = Date.now();
    this.stats.totalRequests++;

    // Serialize through a simple promise chain so concurrent callers
    // queue fairly (FIFO) instead of racing the bucket check.
    const myTurn = this._enqueue();
    await myTurn;

    let waited = 0;
    // Loop in case other reservations landed while we waited our turn.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const now = Date.now();
      const ms = this._msUntilCapacity(estTokens, now);
      if (ms <= 0) break;
      waited += ms;
      this.stats.queuedCount++;
      if (onWait) onWait(ms, this.name);
      await sleep(ms);
    }

    const now = Date.now();
    this.requestLog.push({ ts: now });
    const tokenEntry = { ts: now, cost: estTokens };
    this.tokenLog.push(tokenEntry);

    const totalWait = Date.now() - startedAt;
    this.stats.totalWaitMs += totalWait;
    this.stats.maxWaitMs = Math.max(this.stats.maxWaitMs, totalWait);
    this.stats.totalTokensReserved += estTokens;

    this._dequeue();

    return {
      waitedMs: totalWait,
      /** Replace the estimate with the real usage once the API responds. */
      commit: (actualTokens) => {
        if (typeof actualTokens === "number" && actualTokens >= 0) {
          tokenEntry.cost = actualTokens;
          this.stats.totalTokensActual += actualTokens;
        }
      },
      /** Call if the request failed before consuming any tokens — frees the reservation. */
      release: () => {
        const idx = this.tokenLog.indexOf(tokenEntry);
        if (idx !== -1) this.tokenLog.splice(idx, 1);
        const ridx = this.requestLog.findIndex((e) => e.ts === now);
        if (ridx !== -1) this.requestLog.splice(ridx, 1);
      },
    };
  }

  _enqueue() {
    return new Promise((resolve) => {
      this._queue.push(resolve);
      if (!this._processing) this._dequeue();
    });
  }

  _dequeue() {
    this._processing = false;
    const next = this._queue.shift();
    if (next) {
      this._processing = true;
      next();
    }
  }

  snapshot() {
    const now = Date.now();
    return {
      name: this.name,
      rpm: { limit: this.rawRpm, effectiveLimit: this.rpmLimit, current: this._currentRequestCount(now) },
      tpm: { limit: this.rawTpm, effectiveLimit: this.tpmLimit, current: this._currentTokenSum(now) },
      stats: { ...this.stats },
    };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
