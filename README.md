<div align="center">

<img src="https://img.shields.io/badge/NVIDIA-NIM-76b900?style=for-the-badge&logo=nvidia&logoColor=white" alt="NVIDIA NIM"/>
<img src="https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js"/>
<img src="https://img.shields.io/badge/OpenAI-Compatible-412991?style=for-the-badge&logo=openai&logoColor=white" alt="OpenAI Compatible"/>
<img src="https://img.shields.io/badge/License-MIT-blue?style=for-the-badge" alt="MIT License"/>

<br/><br/>

```
███╗   ██╗██╗███╗   ███╗      ██████╗ ██╗   ██╗ █████╗ ██████╗ ██████╗
████╗  ██║██║████╗ ████║     ██╔════╝ ██║   ██║██╔══██╗██╔══██╗██╔══██╗
██╔██╗ ██║██║██╔████╔██║     ██║  ███╗██║   ██║███████║██████╔╝██║  ██║
██║╚██╗██║██║██║╚██╔╝██║     ██║   ██║██║   ██║██╔══██║██╔══██╗██║  ██║
██║ ╚████║██║██║ ╚═╝ ██║     ╚██████╔╝╚██████╔╝██║  ██║██║  ██║██████╔╝
╚═╝  ╚═══╝╚═╝╚═╝     ╚═╝      ╚═════╝  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝
```

### **Drop-in rate-limit proxy for NVIDIA NIM's free tier**
*Queue-and-wait RPM/TPM gating · Token compression · Smart model fallback · 35+ models*

<br/>

[**Quick Start**](#-quick-start) · [**How It Works**](#-how-it-works) · [**Model List**](#-supported-models) · [**opencode Setup**](#-opencode-setup) · [**Configuration**](#-configuration) · [**API**](#-endpoints)

</div>

---

## 🤔 The Problem

Coding agents don't make one API call per task — they make **dozens**. Tool calls, subagent delegation, retries, and multi-step reasoning all hit the same NIM API key. On the free tier:

```
Your coding task:  Plan → Research → Code → Test → Debug → Refactor
                     ↓       ↓        ↓      ↓       ↓        ↓
NIM API calls:    [req 1] [req 2] [req 3-8] [9-15] [16-24]  [25-30]
                                                              ↑
                                                         💥 429 Error
                                                    Task breaks mid-flight
```

A hard 429 mid-task breaks whatever the agent was doing — lost context, half-written files, incomplete refactors.

## ✅ The Solution

```
opencode / subagents
        ↓
  ┌─────────────────────────────────────┐
  │           nim-guard proxy           │
  │                                     │
  │  1. Compress payload  → save tokens │
  │  2. Check RPM/TPM bucket            │
  │     ├── has room → forward now      │
  │     └── full → queue & wait (no 429)│
  │  3. Forward to NIM                  │
  │  4. On 429 → try next model         │
  │  5. Reconcile real token usage      │
  └─────────────────────────────────────┘
        ↓
  NVIDIA NIM API
  (35+ free models)
```

**nim-guard** sits between your tools and NIM. It queues requests when limits are near, compresses token-heavy payloads, and automatically falls back to another model when one is overloaded — all transparently, without your agent ever seeing an error.

---

## ✨ Features

| Feature | Detail |
|---|---|
| 🚦 **Queue & Wait** | Requests wait for RPM/TPM headroom instead of failing with 429 |
| 🔀 **Model Fallback** | On server-busy 429, silently retries with next model in chain — same context |
| 🗜️ **Token Compression** | Truncates bloated tool outputs, dedupes repeated results — up to 60% savings |
| 📊 **Real Usage Tracking** | Estimates token cost pre-flight, reconciles with actual `usage` block after |
| 🔁 **Streaming-Safe** | Full SSE passthrough, usage extracted from final stream chunk |
| 🧠 **Per-Model Budgets** | Each model gets its own independent RPM/TPM bucket |
| 🛡️ **Safety Margin** | 5% headroom reserved so estimation drift doesn't push you over |
| 📡 **Stats Endpoint** | Live RPM/TPM usage, queue depth, wait times per model |
| ⚡ **Zero Dependencies** | Only `dotenv` — pure Node.js built-ins for everything else |

---

## 🚀 Quick Start

### Prerequisites

- **Node.js 18+** — check with `node --version`
- **NVIDIA NIM API key** — free at [build.nvidia.com](https://build.nvidia.com)
- **opencode** — [opencode.ai](https://opencode.ai) *(or any OpenAI-compatible client)*

---

### Step 1 — Get your NVIDIA NIM API key

<details>
<summary><b>Click to expand: How to get a free NIM API key</b></summary>

1. Go to **[build.nvidia.com](https://build.nvidia.com)** and sign up (free — no credit card)
2. Verify your email address
3. Navigate to **[build.nvidia.com/settings/api-keys](https://build.nvidia.com/settings/api-keys)**
4. Click **Generate API Key**
5. Copy the key — it starts with `nvapi-` and is ~56 characters long
6. ⚠️ Save it somewhere safe — you only see it once

> **Free tier includes:** 1,000 inference credits on signup (up to 5,000 on request), 40 requests/minute, access to all 100+ models in the catalog.

</details>

---

### Step 2 — Clone and install

```bash
# Clone the repo
git clone https://github.com/sakthiaswin/opencode_nim.git
cd opencode_nim

# Install dependencies (only dotenv)
npm install
```

---

### Step 3 — Configure

**Windows:**
```cmd
copy .env.example .env
notepad .env
```

**macOS / Linux:**
```bash
cp .env.example .env
nano .env   # or vim, code, whatever you prefer
```

Edit `.env` with your key and limits:

```env
# Your NIM API key (required)
NIM_API_KEY=nvapi-your-actual-key-here

# Rate limits — check your actual limits at build.nvidia.com/account
NIM_RPM=40
NIM_TPM=100000

# Fallback chain — tried in order when a model returns 429 (server busy)
FALLBACK_MODELS=deepseek-ai/deepseek-v4-pro,deepseek-ai/deepseek-v4-flash,moonshotai/kimi-k2.6,z-ai/glm-5.1,minimaxai/minimax-m2.7,mistralai/mistral-nemotron,nvidia/llama-3_3-nemotron-super-49b-v1,meta/llama-4-maverick-17b-128e-instruct,meta/llama-3.3-70b-instruct,stepfun-ai/step-3.5-flash,mistralai/mistral-large-2-instruct,meta/llama-3.1-70b-instruct

# Everything else can stay as default
COMPRESSION_ENABLED=true
LOG_LEVEL=info
PORT=8788
HOST=127.0.0.1
NIM_BASE_URL=https://integrate.api.nvidia.com/v1
```

> 💡 **Finding your real RPM/TPM:** After your first real API call, run:
> ```bash
> curl -v -X POST https://integrate.api.nvidia.com/v1/chat/completions \
>   -H "Authorization: Bearer YOUR_KEY" \
>   -H "Content-Type: application/json" \
>   -d '{"model":"meta/llama-3.1-8b-instruct","messages":[{"role":"user","content":"hi"}],"max_tokens":5}' \
>   2>&1 | grep -i "x-ratelimit"
> ```
> Use the `x-ratelimit-limit-requests` and `x-ratelimit-limit-tokens` values.

---

### Step 4 — Start the proxy

```bash
npm start
```

You should see:

```
[nim-guard] [info] nim-guard listening on http://127.0.0.1:8788
[nim-guard] [info] Forwarding to NIM at https://integrate.api.nvidia.com/v1
[nim-guard] [info] Compression: enabled
[nim-guard] [info] Fallback chain: deepseek-ai/deepseek-v4-pro → deepseek-ai/deepseek-v4-flash → ...
[nim-guard] [info] Point opencode at: http://127.0.0.1:8788/v1
```

**Keep this terminal open.** nim-guard runs as a foreground process.

---

### Step 5 — Verify it's working

```bash
# Health check
curl http://127.0.0.1:8788/healthz

# Send a real test request
curl -X POST http://127.0.0.1:8788/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"meta/llama-3.1-8b-instruct","messages":[{"role":"user","content":"say hi"}],"stream":false}'

# Check live stats
curl http://127.0.0.1:8788/stats
```

If `/stats` shows your model with `current > 0` — it's working.

---

## 🛠️ opencode Setup

### Step 1 — Copy the provider config

Replace your `opencode.jsonc` at `~/.config/opencode/opencode.jsonc` with the one from this repo:

**Windows:** `C:\Users\YOUR_USERNAME\.config\opencode\opencode.jsonc`  
**macOS/Linux:** `~/.config/opencode/opencode.jsonc`

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    // keep your existing plugins here
  ],
  "provider": {
    "nimguard": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "NIM via nim-guard",
      "options": {
        "baseURL": "http://127.0.0.1:8788/v1"
      },
      "models": {
        "deepseek-ai/deepseek-v4-pro": { "name": "DeepSeek V4 Pro" },
        "deepseek-ai/deepseek-v4-flash": { "name": "DeepSeek V4 Flash" },
        "moonshotai/kimi-k2.6": { "name": "Kimi K2.6" }
        // ... see opencode.jsonc in this repo for all 35 models
      }
    }
  },
  "model": "nimguard/deepseek-ai/deepseek-v4-flash"
}
```

### Step 2 — Register your API key

Inside opencode's TUI, run:

```
/connect
```

Select **Other**, enter `nimguard` as the provider ID (must match exactly), paste your NIM key.

### Step 3 — Switch models in opencode

Inside opencode, press `/` and type `model` to switch between any of the 35 configured models on the fly.

---

## 🤖 Supported Models

> All models are free-tier on NVIDIA NIM. Model IDs are the exact strings for API calls.  
> ⚠️ NIM's catalog changes — if a model returns 404, check [build.nvidia.com/models](https://build.nvidia.com/models) for the current ID.

### 🧠 Reasoning & Coding Champions

| Model | ID | Params | Best For |
|---|---|---|---|
| DeepSeek V4 Pro | `deepseek-ai/deepseek-v4-pro` | MoE | Long-horizon coding, 1M ctx |
| DeepSeek V4 Flash | `deepseek-ai/deepseek-v4-flash` | 284B MoE | Fast coding, agents |
| DeepSeek R1 | `deepseek-ai/deepseek-r1` | 671B | Deep reasoning |
| Kimi K2.6 | `moonshotai/kimi-k2.6` | 1T MoE (32B active) | Agentic coding, 300 subagents |
| GLM-5.1 | `z-ai/glm-5.1` | 754B | Complex engineering, tool use |
| MiniMax M2.7 | `minimaxai/minimax-m2.7` | 230B MoE | Coding + reasoning |

### ⚡ Nemotron Family (NVIDIA)

| Model | ID | Params | Best For |
|---|---|---|---|
| Nemotron Super 49B | `nvidia/llama-3_3-nemotron-super-49b-v1` | 49B | Best NVIDIA reasoning |
| Nemotron 70B Instruct | `nvidia/llama-3.1-nemotron-70b-instruct` | 70B | Tool calling, RAG |
| Nemotron Nano 8B | `nvidia/llama-3.1-nemotron-nano-8b-v1` | 8B | Fast, on-device |
| Nemotron Mini 4B | `nvidia/nemotron-mini-4b-instruct` | 4B | Lightest NVIDIA model |

### 🦙 Llama Family (Meta)

| Model | ID | Params | Best For |
|---|---|---|---|
| Llama 4 Maverick | `meta/llama-4-maverick-17b-128e-instruct` | 128E MoE | Most popular, multimodal |
| Llama 4 Scout | `meta/llama-4-scout-17b-16e-instruct` | 16E MoE | Efficient multimodal |
| Llama 3.3 70B | `meta/llama-3.3-70b-instruct` | 70B | Strong coding |
| Llama 3.1 405B | `meta/llama-3.1-405b-instruct` | 405B | Largest Llama |
| Llama 3.1 70B | `meta/llama-3.1-70b-instruct` | 70B | Balanced |
| Llama 3.1 8B | `meta/llama-3.1-8b-instruct` | 8B | Fast, low cost |
| Llama 3.2 3B | `meta/llama-3.2-3b-instruct` | 3B | Edge |
| Llama 3.2 1B | `meta/llama-3.2-1b-instruct` | 1B | Lightest |

### 🌊 Mistral Family

| Model | ID | Params | Best For |
|---|---|---|---|
| Mistral Nemotron | `mistralai/mistral-nemotron` | — | **Best function calling** |
| Mistral Large 2 | `mistralai/mistral-large-2-instruct` | — | General, 128K ctx |
| Mixtral 8x22B | `mistralai/mixtral-8x22b-instruct-v0.1` | 8x22B MoE | Tool calling |
| Mixtral 8x7B | `mistralai/mixtral-8x7b-instruct-v0.1` | 8x7B MoE | Fast MoE |
| Mistral 7B | `mistralai/mistral-7b-instruct-v0.3` | 7B | Lightweight |

### 💎 Other Top Models

| Model | ID | Params | Best For |
|---|---|---|---|
| Step-3.5 Flash | `stepfun-ai/step-3.5-flash` | 200B MoE | Agentic AI |
| Phi-4 | `microsoft/phi-4` | 14B | Strong reasoning per param |
| Phi-4 Mini | `microsoft/phi-4-mini-instruct` | — | Compact + fast |
| Phi-3 Medium 128K | `microsoft/phi-3-medium-128k-instruct` | — | Long context |
| Gemma 3 27B | `google/gemma-3-27b-it` | 27B | Google reasoning |
| Gemma 3 12B | `google/gemma-3-12b-it` | 12B | Balanced |
| Gemma 3n E4B | `google/gemma-3n-e4b-it` | E4B | Edge + multimodal |
| Gemma 3n E2B | `google/gemma-3n-e2b-it` | E2B | Lightest Gemma |
| Seed-OSS 36B | `bytedance/seed-oss-36b` | 36B | ByteDance |

---

## ⚙️ Configuration

Full reference for `.env`:

```env
# ── Required ──────────────────────────────────────────────────────────────────
NIM_API_KEY=nvapi-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# ── Server ────────────────────────────────────────────────────────────────────
HOST=127.0.0.1          # bind address (127.0.0.1 = local only, safe default)
PORT=8788               # proxy port — point opencode at http://127.0.0.1:8788/v1
NIM_BASE_URL=https://integrate.api.nvidia.com/v1

# ── Logging ───────────────────────────────────────────────────────────────────
LOG_LEVEL=info          # debug | info | warn | error

# ── Rate limits ───────────────────────────────────────────────────────────────
NIM_RPM=40              # requests per minute (free tier default)
NIM_TPM=100000          # tokens per minute (check your account)

# ── Per-model overrides (optional) ────────────────────────────────────────────
# Overrides NIM_RPM/NIM_TPM for specific models
MODEL_LIMITS_JSON={"deepseek-ai/deepseek-v4-pro":{"rpm":40,"tpm":100000},"meta/llama-3.1-8b-instruct":{"rpm":40,"tpm":100000}}

# ── Fallback chain ────────────────────────────────────────────────────────────
# Comma-separated model IDs in priority order.
# When a model 429s (server busy), proxy tries the next one — same context, no error.
FALLBACK_MODELS=deepseek-ai/deepseek-v4-pro,deepseek-ai/deepseek-v4-flash,moonshotai/kimi-k2.6,z-ai/glm-5.1,minimaxai/minimax-m2.7,mistralai/mistral-nemotron,meta/llama-4-maverick-17b-128e-instruct,meta/llama-3.3-70b-instruct

# How long (ms) to skip a model after a 429 before retrying it
COOLDOWN_MS=60000       # default: 60s (one RPM window)

# ── Compression ───────────────────────────────────────────────────────────────
COMPRESSION_ENABLED=true
```

---

## 🔬 How It Works

### Request lifecycle

```
Client sends request
       │
       ▼
┌─ Compression ──────────────────────────────────┐
│  • Collapse blank lines & trailing whitespace  │
│  • Truncate messages > 12,000 chars            │
│    (head + tail, with [truncated N chars])     │
│  • Dedupe identical consecutive tool results  │
│  • Last 2 messages always preserved intact    │
└────────────────────────────────────────────────┘
       │
       ▼
┌─ Token Estimation ─────────────────────────────┐
│  Pre-flight estimate: ~4 chars/token           │
│  Includes messages + tool defs + max_tokens    │
└────────────────────────────────────────────────┘
       │
       ▼
┌─ Rate-Limit Gate (per model) ──────────────────┐
│  Rolling 60s window tracks RPM and TPM         │
│  5% safety margin reserved                     │
│                                                │
│  Budget available? ──► proceed immediately     │
│  Budget full?      ──► sleep until slot opens  │
│                        (never reject)          │
└────────────────────────────────────────────────┘
       │
       ▼
┌─ Forward to NIM ───────────────────────────────┐
│  NIM returns 200? ──► stream/return to client  │
│  NIM returns 429? ──► put model on 60s cooldown│
│                        try next in chain       │
│  NIM returns 4xx? ──► pass error through       │
└────────────────────────────────────────────────┘
       │
       ▼
┌─ Reconcile Usage ──────────────────────────────┐
│  Replace estimate with real usage.total_tokens │
│  Budget stays accurate across long sessions    │
└────────────────────────────────────────────────┘
```

### Compression example

**Before** (typical agentic coding session, message 3 of 20):
```
[tool result: 28,000 chars of pytest output with 400 repeated lines]
```

**After** compression:
```
[first 4,000 chars — test command and first failures]
[... truncated 20,000 chars to save tokens ...]
[last 4,000 chars — final error and summary]
```

**Token savings: ~4,000–6,000 tokens on that one message alone.**

---

## 📡 Endpoints

### `GET /healthz`
Liveness check.
```json
{ "status": "ok", "uptime": 142.3 }
```

### `GET /stats`
Live usage snapshot per model.
```json
{
  "models": [
    {
      "name": "deepseek-ai/deepseek-v4-pro",
      "rpm": { "limit": 40, "effectiveLimit": 38, "current": 12 },
      "tpm": { "limit": 100000, "effectiveLimit": 95000, "current": 41200 },
      "stats": {
        "totalRequests": 87,
        "totalTokensReserved": 412000,
        "totalTokensActual": 358211,
        "totalWaitMs": 21340,
        "maxWaitMs": 4200,
        "queuedCount": 6
      }
    }
  ],
  "cooldowns": {},
  "fallbackChain": ["deepseek-ai/deepseek-v4-pro", "deepseek-ai/deepseek-v4-flash"]
}
```

### `POST /v1/chat/completions`
Rate-limited, compressed, fallback-aware proxy — identical to the NIM API.

### `GET /v1/*`
Everything else forwarded untouched (e.g. `/v1/models`).

---

## 🧪 Testing

```bash
# Unit tests — limiter logic, no network, no real waits (~1s)
node test/limiter.test.js

# Expected output:
# PASS: 5 requests within RPM=5 budget completed instantly: 0ms
# PASS: 6th request correctly computed wait of 60000ms (would queue, not reject)
# PASS: TPM-only exhaustion correctly triggers wait: 60000ms
# PASS: commit() correctly reconciles estimate (900) down to actual (50)
# PASS: release() fully frees both RPM and TPM reservations
# PASS: safety margin correctly reduces effective RPM (100 -> 90)
# PASS: 20 concurrent acquires under generous budget all resolved without deadlock
```

```bash
# End-to-end test with mock NIM server (no real API key needed)
# Terminal 1:
node test/mock-nim.js

# Terminal 2:
NIM_BASE_URL=http://127.0.0.1:9999/v1 NIM_API_KEY=test PORT=8788 npm start

# Terminal 3 (Windows):
curl -X POST http://127.0.0.1:8788/v1/chat/completions ^
  -H "Content-Type: application/json" ^
  -d "{\"model\":\"meta/llama-3.1-8b-instruct\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"stream\":false}"
```

---

## 🗂️ Project Structure

```
nim-guard/
├── src/
│   ├── server.js        # Main proxy server, HTTP handler, fallback chain
│   ├── limiter.js       # Token-bucket RPM/TPM limiter with queue-and-wait
│   ├── compress.js      # Payload compression to reduce token pressure
│   ├── estimator.js     # Pre-flight token cost estimation + usage extraction
│   └── modelLimits.js   # Per-model RPM/TPM config from env
├── test/
│   ├── limiter.test.js  # Unit tests for limiter logic (7 tests)
│   └── mock-nim.js      # Local fake NIM server for e2e testing
├── opencode.jsonc        # Ready-to-use opencode provider config (35 models)
├── .env.example          # Full config reference
├── package.json
└── README.md
```

---

## ❓ Troubleshooting

<details>
<summary><b>curl: stats shows {"models":[]} after sending messages</b></summary>

opencode is not routing through the proxy. Check that:
1. `baseURL` in `opencode.jsonc` is exactly `http://127.0.0.1:8788/v1`
2. The provider key is `nimguard` (matches exactly in both `provider` block and `model` string)
3. nim-guard is actually running (`npm start` in a terminal)
4. You ran `/connect` inside opencode and entered `nimguard` as the provider ID

</details>

<details>
<summary><b>429 on every request, even after waiting</b></summary>

Your free-tier **credits** (not just RPM) may be exhausted. Credits don't reset on a 60s window — they're consumed permanently.

Check: [build.nvidia.com](https://build.nvidia.com) → account → Usage/Credits.

If at 0: request more free credits (up to 5,000 total) via the developer portal, or switch to a lighter model like `meta/llama-3.1-8b-instruct` which costs fewer credits per call.

</details>

<details>
<summary><b>Model returns 404</b></summary>

NIM's catalog changes — models get added and deprecated. Go to [build.nvidia.com/models](https://build.nvidia.com/models), find the current model page, copy the exact model ID from the API example code, and update your `opencode.jsonc` and `FALLBACK_MODELS`.

</details>

<details>
<summary><b>Very slow responses</b></summary>

This is NIM server load, not the proxy. nim-guard adds microseconds of overhead. Popular models (DeepSeek V4 Pro, Kimi K2.6) get congested during peak hours (US daytime). Use the fallback chain to automatically route to less congested models.

</details>

<details>
<summary><b>Windows: 'cp' is not recognized</b></summary>

Use `copy` instead of `cp`:
```cmd
copy .env.example .env
notepad .env
```

</details>

<details>
<summary><b>Running nim-guard in the background (Windows)</b></summary>

Option 1 — keep a terminal open (simplest).

Option 2 — run as a background service with pm2:
```cmd
npm install -g pm2
pm2 start src/server.js --name nim-guard
pm2 save
pm2 startup
```

</details>

---

## ⚠️ Limitations

- **Single-process budget.** RPM/TPM tracked in-memory. If you share one NIM key across multiple nim-guard instances, they won't coordinate — run one instance per key.
- **Token estimates are approximate** (~4 chars/token) until reconciled after each response. The 5% safety margin absorbs normal drift.
- **Not a full gateway.** No multi-key pooling, semantic caching, or cost tracking by design. For those, pair with [Headroom](https://github.com/chopratejas/headroom) or a full gateway (Bifrost, Kong AI Gateway).
- **40 RPM is shared across all models on one key.** This is a NIM account-level limit, not per-model. nim-guard tracks per-model budgets as a conservative lower bound, but you can still hit the global account ceiling.

---

## 🤝 Contributing

Issues and PRs welcome. If NIM adds new models or changes rate-limit behavior, open a PR to update the model list and defaults.

---

## 📄 License

MIT — do whatever you want with it.

---

<div align="center">

Built for the [opencode](https://opencode.ai) + [NVIDIA NIM](https://build.nvidia.com) free-tier stack.

**⭐ Star this repo if it saved you from a 429**

</div>
