// The only function allowed to send a message. Every rule about how ERA
// bots communicate lives here, enforced, not remembered by whoever's
// building the next flow.
//
// Formatting rule: no markdown-style bullets/emphasis. "*" is never allowed
// (single or double). "-" is only blocked when it's being used as
// punctuation/a bullet (standalone, doubled, or leading a line) -- a hyphen
// inside a real word ("check-in", "well-known") or a date ("12-08-2026")
// is left alone. Structure lists with line breaks, "label: value" pairs, or
// numbered lines ("1.", "2.") instead.

function hasBannedFormatting(text) {
  if (text.includes('*')) return true;
  if (/(^|\n)\s*-\s+/.test(text)) return true; // leading bullet dash
  if (/--/.test(text)) return true; // double dash
  if (/\s-\s/.test(text)) return true; // standalone dash used as punctuation
  return false;
}

export function sanitizeText(text) {
  if (hasBannedFormatting(text)) {
    // Fail loudly instead of silently mangling content -- the bug belongs
    // in whatever prompt/template produced this text, same lesson as
    // Bali's leaked-raw-markdown incident.
    throw new Error(
      `Message contains banned formatting (* or a bullet/standalone -): "${text}". Use line breaks, "label: value", or numbered lines ("1.", "2.") instead.`
    );
  }
  return text;
}

export function formatInternalMessage({ role, senderName, roleHasMultiplePeople }, message) {
  const prefix = roleHasMultiplePeople && senderName ? `${role}(${senderName})` : role;
  return sanitizeText(`${prefix}: ${message}`);
}

export function handoffIntro({ staffName, staffRole }) {
  return sanitizeText(`Hi, my name is ${staffName}, I am the ${staffRole}. You will now be speaking with me.`);
}

const ALLOWED_TRIGGERS = ['swipe_reply', 'explicit_type_command', 'bot_flow_step', 'staff_handoff_intro', 'wake_template'];

export async function sendMessage({ trigger, to, text, whatsappSend }) {
  // A message may only go out via one of these explicit, deliberate
  // triggers -- never as a side effect of anything else. Stated by the
  // owner as the one rule that matters most: no leak by mistake, no
  // implicit "well only one thing is open so it must mean X".
  if (!ALLOWED_TRIGGERS.includes(trigger)) {
    throw new Error(`sendMessage called with no valid trigger ("${trigger}"). A message may only go out via: ${ALLOWED_TRIGGERS.join(', ')}.`);
  }
  const clean = sanitizeText(text);
  return whatsappSend(to, clean);
}
