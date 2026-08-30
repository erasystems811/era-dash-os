// The one place a real Claude API call is made -- everything else in the
// engine only ever sees askJson/askText, never a raw fetch. Same model and
// call shape already proven in gold-seller-bot's sandbox/chat.mjs.
import { pool } from '../lib/db.js';

const MODEL = 'claude-sonnet-5';

// Prompt caching is a pure wire-format change -- same model, same prompt
// text, same output, just billed differently when the same prefix repeats.
// Zero risk to the bot's actual voice/behavior, unlike switching models,
// which is why this is the first cost lever turned on, not that one.
//
// Sonnet 5's minimum cacheable prefix is 1024 tokens (confirmed against
// Anthropic's docs 2026-08-20) -- ~4100+ characters at a conservative
// ~4 chars/token. Below that, cache_control is harmless but does nothing
// (Anthropic just returns cache_creation_input_tokens: 0), so this
// threshold only needs to avoid false negatives, not be exact. The
// long "strict lookup" / mid-conversation system prompts in flow.js clear
// this easily; classify.js's short prompts don't and are left as plain
// strings, unaffected either way.
const CACHEABLE_MIN_CHARS = 4200;

function systemParam(system) {
  if (system.length < CACHEABLE_MIN_CHARS) return system;
  return [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
}

// Every business shares the same ANTHROPIC_API_KEY, so Anthropic's own
// billing can't tell one business's spend from another's -- this is the
// only way ERA Dash OS's monitoring panel can show this business's real
// AI cost. Logging failure must never break a customer-facing reply, so
// this is fire-and-forget with its own try/catch, not awaited-and-thrown.
async function logUsage(usage) {
  if (!usage) return;
  try {
    await pool.query(
      `insert into ai_usage (model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens) values ($1, $2, $3, $4, $5)`,
      [MODEL, usage.input_tokens || 0, usage.output_tokens || 0, usage.cache_creation_input_tokens || 0, usage.cache_read_input_tokens || 0]
    );
  } catch (err) {
    console.error('ai_usage log failed:', err.message);
  }
}

// A real, non-retryable failure (credits exhausted, hard rate limit,
// invalid request) -- separate from ai_usage, so a monitoring check can
// tell "Claude is having real trouble" apart from "nobody's messaged
// lately" with one plain HTTPS request, no server access needed.
async function logError(message) {
  try {
    await pool.query(`insert into ai_errors (message) values ($1)`, [message.slice(0, 500)]);
  } catch (err) {
    console.error('ai_errors log failed:', err.message);
  }
}

// A momentary 429/5xx or a dropped connection is exactly the kind of thing
// that shouldn't cost a customer a real reply -- without this, one blip sent
// them straight to the generic "having some trouble" + handover
// (flow.js's scheduleDebouncedProcessing catch). Deliberately NOT a
// concurrency limiter/queue -- calls still fire exactly one per step, at
// whatever moment they're needed; this only ever kicks in on an actual
// failure.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [500, 1500];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callClaude(system, userText, maxTokens, images) {
  // images: [{ mediaType: 'image/jpeg'|'image/png'|..., base64: '...' }] --
  // optional, for reading uploaded photo(s) (e.g. a multi-page menu) instead
  // of text. All pages go in the same call, not one call per page, so an
  // item split or repeated across pages still gets read with full context.
  const content = images?.length
    ? [
        ...images.map((image) => ({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } })),
        { type: 'text', text: userText },
      ]
    : userText;
  const body = JSON.stringify({
    model: MODEL,
    max_tokens: maxTokens,
    system: systemParam(system),
    messages: [{ role: 'user', content }],
  });

  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body,
      });
    } catch (err) {
      // Network-level failure (DNS, connection reset, timeout) -- as
      // transient as a 5xx, same retry treatment.
      if (attempt >= RETRY_DELAYS_MS.length) {
        await logError(`network error: ${err.message}`);
        throw err;
      }
      await sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }
    if (res.ok) {
      const data = await res.json();
      await logUsage(data.usage);
      return data.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
    }
    const errorText = await res.text();
    if (RETRYABLE_STATUS.has(res.status) && attempt < RETRY_DELAYS_MS.length) {
      await sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }
    await logError(`Anthropic API error ${res.status}: ${errorText}`);
    throw new Error(`Anthropic API error ${res.status}: ${errorText}`);
  }
}

// askJson: (systemPrompt, userText) => Promise<object> -- the shape
// bot-engine/extract.js's extractField expects as its injected dependency.
export async function askJson(systemPrompt, userText) {
  const text = await callClaude(systemPrompt, userText, 256);
  return extractJson(text);
}

export async function askText(systemPrompt, userText) {
  return callClaude(systemPrompt, userText, 512);
}

// For reading one or more uploaded images (photo(s) of a menu, etc) instead
// of text -- all pages in one call, see callClaude's comment above.
export async function askJsonWithImages(systemPrompt, userText, images) {
  const text = await callClaude(systemPrompt, userText, 2048, images);
  return extractJson(text);
}

function extractJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return {};
  try {
    return JSON.parse(match[0]);
  } catch {
    return {};
  }
}
