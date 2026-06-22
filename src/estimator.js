/**
 * Approximate token counting without pulling in a model-specific tokenizer.
 * Good enough for rate-limit *gating* decisions — we always reconcile with
 * the real `usage` block from the API response afterward (see limiter.commit).
 *
 * Heuristic: ~4 chars/token for English/code text (OpenAI/NIM models are
 * all BPE-family and this holds within ~10-15% for typical prompts/code).
 */
const CHARS_PER_TOKEN = 4;

export function estimateTextTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Estimate total prompt tokens for an OpenAI-style chat completion body,
 * including tool definitions and tool call/result content — these are
 * often the largest contributors in agentic coding tasks.
 */
export function estimateRequestTokens(body) {
  let total = 0;

  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      total += estimateMessageTokens(msg);
      total += 4; // role/formatting overhead per message
    }
  }

  if (Array.isArray(body.tools)) {
    for (const t of body.tools) {
      total += estimateTextTokens(JSON.stringify(t));
    }
  }

  // Reserve room for the response too, so TPM accounting reflects
  // total round-trip cost, not just the prompt half.
  const maxTokens = body.max_tokens || body.max_completion_tokens || 1024;
  total += Math.min(maxTokens, 4096);

  return total;
}

function estimateMessageTokens(msg) {
  if (!msg) return 0;
  let total = 0;

  if (typeof msg.content === "string") {
    total += estimateTextTokens(msg.content);
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (typeof part === "string") total += estimateTextTokens(part);
      else if (part?.text) total += estimateTextTokens(part.text);
      else total += estimateTextTokens(JSON.stringify(part));
    }
  }

  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      total += estimateTextTokens(JSON.stringify(tc.function || tc));
    }
  }

  if (msg.tool_call_id) total += 8;

  return total;
}

/** Pull the real usage figure out of a (possibly streamed-and-reassembled) response. */
export function extractActualTokens(responseJson) {
  const u = responseJson?.usage;
  if (!u) return null;
  return u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0);
}
