/**
 * Payload compression — reduces tokens sent to NIM before rate-limit
 * accounting and before the request goes out. Targets the highest-bloat
 * patterns in agentic coding sessions: repeated tool output, long log/stack
 * dumps, large file reads, and redundant whitespace.
 *
 * Design goals:
 *  - Lossless where it matters: never touches the latest user/assistant turn
 *    by default (configurable), so the model always sees fresh, uncompressed
 *    instructions.
 *  - Reversible-ish: truncated blocks get a clear marker + size, so the model
 *    knows data was cut and won't hallucinate completeness.
 *  - Cheap: pure string ops, no ML, runs in microseconds, safe to put in the
 *    hot path of every request.
 */

const DEFAULT_OPTS = {
  enabled: true,
  // Don't compress the last N messages — keeps immediate context crisp.
  preserveLastMessages: 2,
  // Collapse 3+ blank lines into 1.
  collapseBlankLines: true,
  // Collapse runs of repeated trailing whitespace.
  trimTrailingWhitespace: true,
  // Truncate any single message content beyond this many chars (tool
  // outputs, file dumps, logs). Set 0 to disable.
  maxMessageChars: 12000,
  // When truncating, keep this many chars from the head and tail (context
  // is usually at the edges: command + final result/error).
  truncateHeadChars: 4000,
  truncateTailChars: 4000,
  // Deduplicate identical consecutive tool-result messages (common when
  // subagents poll/retry the same read).
  dedupeRepeatedToolResults: true,
};

export function compressRequestBody(body, userOpts = {}) {
  const opts = { ...DEFAULT_OPTS, ...userOpts };
  if (!opts.enabled || !Array.isArray(body.messages)) {
    return { body, stats: { tokensSavedEstimate: 0, transformsApplied: [] } };
  }

  const transformsApplied = [];
  const before = JSON.stringify(body.messages).length;

  const total = body.messages.length;
  const preserveFrom = Math.max(0, total - opts.preserveLastMessages);

  let prevToolResultSignature = null;
  const compressed = body.messages.map((msg, idx) => {
    const isPreserved = idx >= preserveFrom;
    let m = msg;

    // Dedupe identical consecutive tool results (common in subagent retry loops)
    if (
      opts.dedupeRepeatedToolResults &&
      msg.role === "tool" &&
      typeof msg.content === "string"
    ) {
      const sig = msg.tool_call_id + ":" + msg.content.length + ":" + msg.content.slice(0, 80);
      if (sig === prevToolResultSignature) {
        transformsApplied.push("dedupe_repeated_tool_result");
        m = { ...msg, content: "[identical to previous tool result, omitted to save tokens]" };
      }
      prevToolResultSignature = sig;
    }

    if (!isPreserved && typeof m.content === "string") {
      let content = m.content;

      if (opts.collapseBlankLines) {
        content = content.replace(/\n{3,}/g, "\n\n");
      }
      if (opts.trimTrailingWhitespace) {
        content = content.replace(/[ \t]+\n/g, "\n").replace(/[ \t]+$/g, "");
      }
      if (opts.maxMessageChars > 0 && content.length > opts.maxMessageChars) {
        const head = content.slice(0, opts.truncateHeadChars);
        const tail = content.slice(-opts.truncateTailChars);
        const cutChars = content.length - head.length - tail.length;
        content = `${head}\n\n[... truncated ${cutChars} chars to save tokens ...]\n\n${tail}`;
        transformsApplied.push("truncate_long_content");
      }

      if (content !== m.content) {
        m = { ...m, content };
      }
    }

    return m;
  });

  const after = JSON.stringify(compressed).length;
  const charsSaved = Math.max(0, before - after);

  return {
    body: { ...body, messages: compressed },
    stats: {
      tokensSavedEstimate: Math.ceil(charsSaved / 4),
      charsSaved,
      transformsApplied: [...new Set(transformsApplied)],
    },
  };
}
