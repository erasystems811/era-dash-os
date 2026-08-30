// Claude Sonnet 5 pricing (engine/claude.js's MODEL), Anthropic's published
// per-million-token rates. Intro pricing runs through 2026-08-31; the rate
// is picked by the call's own created_at, not "today", so cost for calls
// already logged stays correct after the cutover instead of being silently
// repriced.
export const STANDARD = { inputPerMTok: 3.0, outputPerMTok: 15.0 };
export const INTRO = { inputPerMTok: 2.0, outputPerMTok: 10.0 };
export const INTRO_ENDS = new Date('2026-09-01T00:00:00Z');

// Prompt caching (engine/claude.js) prices cache writes/reads off the same
// per-model input rate, not a separate published number -- 1.25x for a
// 5-minute-TTL write, 0.1x for a read, confirmed against Anthropic's docs
// 2026-08-20. cache_creation_input_tokens/cache_read_input_tokens are 0 for
// any call that didn't cache, so this is a no-op for those rows.
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

// Raw math, one rate tier at a time -- exported so a caller aggregating
// many rows (routes/api.js's usage-summary) can sum tokens per tier in SQL
// and price each tier's totals in one call, instead of pricing row by row
// in JS. A single call's own numbers work here too (see costForUsage).
export function costForTokens(rate, { inputTokens, outputTokens, cacheCreationInputTokens = 0, cacheReadInputTokens = 0 }) {
  const inputCost = (inputTokens / 1_000_000) * rate.inputPerMTok;
  const cacheWriteCost = (cacheCreationInputTokens / 1_000_000) * rate.inputPerMTok * CACHE_WRITE_MULTIPLIER;
  const cacheReadCost = (cacheReadInputTokens / 1_000_000) * rate.inputPerMTok * CACHE_READ_MULTIPLIER;
  const outputCost = (outputTokens / 1_000_000) * rate.outputPerMTok;
  return inputCost + cacheWriteCost + cacheReadCost + outputCost;
}

export function costForUsage({ inputTokens, outputTokens, cacheCreationInputTokens = 0, cacheReadInputTokens = 0, createdAt }) {
  const rate = new Date(createdAt) < INTRO_ENDS ? INTRO : STANDARD;
  return costForTokens(rate, { inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens });
}
