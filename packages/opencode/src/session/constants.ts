/**
 * Shared string constants and patterns for the session layer.
 *
 * These live in a single file so anti-confabulation messaging can be tuned
 * in one place and asserted against from tests, without scattering magic
 * strings across compaction.ts / message-v2.ts / processor.ts.
 */

/**
 * Used as the errorText of a tool-result when the corresponding tool part
 * was pruned (`part.state.time.compacted` set by SessionCompaction.prune).
 *
 * Design notes:
 * - Emitted via `state: "output-error"` so Anthropic sees `is_error: true`.
 *   A pruned call as "success with blank output" causes the model to
 *   reconstruct the missing output from memory, leading to fabricated
 *   tool_use blocks in subsequent text.
 * - The language is intentionally imperative ("DO NOT") because Claude
 *   follows direct instructions in tool_result contents more reliably
 *   than passive descriptions.
 */
export const PRUNED_TOOL_OUTPUT_NOTICE =
  "This tool result was pruned from context to save tokens. " +
  "DO NOT attempt to recall, reconstruct, paraphrase, or narrate the previous output. " +
  "If you need this information to answer the user, call the tool again to get current state. " +
  "Any fact that depended on this pruned output MUST be re-verified before use."

/**
 * Prepended to the default compaction prompt. Gives the summarizing agent
 * explicit rules against copying tool IDs or writing tool-call narrative
 * text that the next agent could then imitate.
 */
export const COMPACTION_ANTI_CONFAB_RULES = `You are summarizing a conversation for another agent to continue.

CRITICAL RULES — these prevent a known failure mode where the next agent
confabulates tool results:

1. Do NOT copy, cite, or reference any 'toolu_...' tool-use IDs. They are
   invalid after this summary and referencing them will cause the next agent
   to fabricate fake IDs in its output.

2. Do NOT write tool invocations in narrative text form. Specifically, never
   produce strings like "[Tool Use: bash(...)]" or "H: [Tool Result for ...]".
   That format is hallucination bait — the next agent will imitate it.

3. For every file, service, deployment, or build artifact you mention as
   existing or working, mark it with "(as of compaction)". The next agent
   MUST re-verify before acting on those facts.

4. Structure the summary in three clearly separated sections:
     ## Verified facts (as of compaction)
         — things confirmed by tool output earlier in the conversation
     ## Plans and intent
         — things we wanted to do but may not have completed
     ## Must re-verify before use
         — things whose state may have changed since pruning / compaction
`

/**
 * Prepended to the synthetic "continue" user message injected after a
 * completed auto-compaction. Tells the next turn to treat the summary as
 * stale input and to verify before answering factual questions.
 */
export const POST_COMPACT_REALITY_CHECK =
  "[Context was just compacted. Everything in the prior summary is a " +
  "snapshot from an older state and may be stale. Before claiming any file, " +
  "service, build artifact, or deployment exists or is working based on the " +
  "summary, call a verification tool. If the user asks a factual question " +
  "about current state, start with a fresh verification tool call. Do NOT " +
  "answer from the summary alone.]\n\n"

/**
 * Detects when an assistant text part contains a fabricated tool-call
 * rendering — i.e. text that looks like "[Tool Use: name(args)]" or
 * "H: [Tool Result for toolu_xxx: ...]".
 *
 * This format is not produced by any OpenCode or AI SDK code path (verified
 * by exhaustive grep). It is emitted by the model itself when it tries to
 * reconstruct pruned tool outputs from memory. A match is a strong signal
 * that Patch 1 (pruned → output-error) isn't reaching this code path for
 * some reason, or that a new failure mode has appeared.
 *
 * The pattern is anchored on the `toolu_` prefix for the result branch to
 * avoid false positives on legitimate inline discussions of tool usage.
 */
export const CONFABULATION_PATTERN = /\[Tool Use:\s+\w+\(|H:\s*\[Tool Result for\s+toolu_/
