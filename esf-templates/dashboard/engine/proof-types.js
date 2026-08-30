// Validates one inbound WhatsApp message against a step's proof_type +
// proof_config, and turns it into an `entry` row's shape. This module IS
// the product surface (build schema v2.0 section 5) -- every business's
// task/step rows are just different combinations of the same nine cases
// here, never a new code path per business.
//
// `input` (built by webhook-whatsapp.js from the raw Meta payload):
//   { type: 'text', text } | { type: 'image', mediaDataUrl } | { type: 'location', lat, lng }
//
// Returns { answer: 'done' | 'problem', value, media_url, lat, lng, note }
// on success. Throws ReAskError(message) when the input doesn't satisfy the
// proof format at all (e.g. a number step got non-numeric text) -- the
// webhook catches that and re-sends the same instruction plus `message`,
// never silently drops or half-records it.

export class ReAskError extends Error {}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6_371_000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// {{value}} -> the submitted reference; {{secret.NAME}} -> process.env.NAME.
// No generic secrets vault exists yet (build schema v2.0 section 3.11 is
// still a plan, not built) -- interpolating straight against process.env is
// the honest MVP stand-in, same shape the doc's own api-type example
// expects a client to configure (an env var name, not a literal key).
function interpolate(template, { value }) {
  return template
    .replace(/\{\{value\}\}/g, encodeURIComponent(value ?? ''))
    .replace(/\{\{secret\.([A-Za-z0-9_]+)\}\}/g, (_, name) => process.env[name] || '');
}

function getPath(obj, dotPath) {
  return dotPath.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

async function callApiProof(proofConfig, value) {
  const { url, method = 'GET', headers = {}, success_path, success_value, on_fail = 'reject' } = proofConfig;
  const renderedUrl = interpolate(url, { value });
  const renderedHeaders = {};
  for (const [k, v] of Object.entries(headers)) renderedHeaders[k] = interpolate(v, { value });

  let ok = false;
  let bodyForNote = '';
  try {
    const res = await fetch(renderedUrl, { method, headers: renderedHeaders });
    const json = await res.json().catch(() => ({}));
    ok = res.ok && String(getPath(json, success_path)) === String(success_value);
    bodyForNote = JSON.stringify(json).slice(0, 200);
  } catch (err) {
    bodyForNote = err.message;
  }

  if (ok) return { answer: 'done', value, note: null };
  if (on_fail === 'flag') return { answer: 'problem', value, note: `Unverified (api check did not match): ${bodyForNote}` };
  throw new ReAskError(`That reference could not be verified. Please check it and send it again.`);
}

export async function validateProof({ proofType, proofConfig, input, business }) {
  const cfg = proofConfig || {};

  switch (proofType) {
    case 'tap': {
      // No real button in a plain-text WhatsApp reply -- any non-empty
      // reply to the "Reply DONE when finished" instruction counts. This is
      // the lowest-assurance proof type on purpose (build schema v2.0
      // section 5's own ordering); if a business needs more, step_override
      // or a different proof_type on this step is the answer, not a fancier
      // parser here.
      if (input.type !== 'text' || !input.text?.trim()) {
        throw new ReAskError('Reply DONE when you have finished this step.');
      }
      return { answer: 'done', value: input.text.trim() };
    }

    case 'photo': {
      if (input.type !== 'image' || !input.mediaDataUrl) {
        throw new ReAskError('Please send a photo for this step.');
      }
      // min > 1 accumulation (counting how many photos have arrived so far
      // for this step, and whether to advance yet) lives in run-engine.js,
      // not here -- this function is stateless/per-message by design and
      // has no DB access; it only validates that THIS message is a real
      // photo.
      return { answer: 'done', media_url: input.mediaDataUrl };
    }

    case 'location': {
      if (input.type !== 'location' || input.lat == null || input.lng == null) {
        throw new ReAskError('Please share your location (the WhatsApp location pin, not typed text).');
      }
      const radiusM = cfg.radius_m ?? business?.radius_m ?? 200;
      const withinRadius =
        business?.lat != null && business?.lng != null
          ? haversineMeters(input.lat, input.lng, business.lat, business.lng) <= radiusM
          : true; // no business coordinates set yet -- accept, don't block on missing config
      return {
        answer: withinRadius ? 'done' : 'problem',
        lat: input.lat,
        lng: input.lng,
        note: withinRadius ? null : `Location is outside the ${radiusM}m radius for this business.`,
      };
    }

    case 'number': {
      if (input.type !== 'text') throw new ReAskError('Please reply with a number.');
      const n = Number(String(input.text).replace(/,/g, '').trim());
      if (!Number.isFinite(n)) throw new ReAskError('That is not a valid number. Please try again.');
      if (cfg.min != null && n < cfg.min) throw new ReAskError(`That number is below the minimum (${cfg.min}). Please check and resend.`);
      if (cfg.max != null && n > cfg.max) throw new ReAskError(`That number is above the maximum (${cfg.max}). Please check and resend.`);
      return { answer: 'done', value: String(n) };
    }

    case 'text': {
      if (input.type !== 'text') throw new ReAskError('Please reply with a text message.');
      const minLength = cfg.min_length ?? 1;
      if (input.text.trim().length < minLength) throw new ReAskError(`Please write a bit more (at least ${minLength} characters).`);
      return { answer: 'done', value: input.text.trim() };
    }

    case 'choice': {
      if (input.type !== 'text') throw new ReAskError(`Please reply with one of: ${(cfg.options || []).join(', ')}`);
      const options = cfg.options || [];
      const raw = input.text.trim();
      // Accept the option text itself (case-insensitive) or its 1-based
      // position in the list -- typing "2" is faster than typing "Half" on
      // a phone keyboard mid-shift.
      const byNumber = options[Number(raw) - 1];
      const byText = options.find((o) => o.toLowerCase() === raw.toLowerCase());
      const matched = byNumber || byText;
      if (!matched) throw new ReAskError(`Please reply with one of: ${options.join(', ')}`);
      return { answer: 'done', value: matched };
    }

    case 'code': {
      // No verification endpoint is specified by this proof type itself
      // (build schema v2.0 section 5's own table) -- it records whatever
      // code she was given, it does not check it against anything. A
      // business that needs the code itself verified should pair this step
      // with an `api` step, not expect `code` to do both jobs.
      if (input.type !== 'text' || !input.text?.trim()) throw new ReAskError('Please enter the code.');
      return { answer: 'done', value: input.text.trim() };
    }

    case 'api': {
      if (input.type !== 'text' || !input.text?.trim()) throw new ReAskError('Please send the reference to verify.');
      return callApiProof(cfg, input.text.trim());
    }

    case 'countersign': {
      // Cross-staff routing (messaging the confirming role and recording
      // THEIR reply, not the original staff member's) is handled entirely
      // in run-engine.js's deliverStepPrompt/handleCountersignConfirmation
      // -- by the time validateProof ever sees a 'countersign' proof_type,
      // it means no active staff member holds the configured role, and
      // this is the deliberate degrade-to-self-report fallback, not the
      // normal path.
      if (input.type !== 'text' || !input.text?.trim()) throw new ReAskError(`Please have the ${cfg.role || 'countersigning staff member'} confirm.`);
      return { answer: 'done', value: input.text.trim(), note: `Recorded as self-reported -- no active "${cfg.role || '(unset role)'}" staff member exists to countersign.` };
    }

    default:
      throw new Error(`Unknown proof_type "${proofType}".`);
  }
}
