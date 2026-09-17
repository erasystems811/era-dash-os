import { askJson } from './claude.js';

const SYSTEM = `Classify the customer's WhatsApp message. Only used when they have no order or booking already in progress, so judge it as the start of something new.
intent -- exactly one of:
greeting: just saying hi, hello, good morning, or similar small talk with no actual question or order in it yet.
enquiry: a real question (about hours, price, availability, policy, anything answerable from a knowledge base).
order: they want to order or book something, even vaguely (e.g. naming a dish, or "I want to order").
complaint: unhappy about something, a problem with a past order, or asking for a refund.
wants_human -- true only if they explicitly ask to speak to a person, false otherwise.
Reply ONLY with JSON: {"intent": "greeting" or "enquiry" or "order" or "complaint", "wants_human": true or false}`;

// Chidera, 2026-09-16/17: "my ai api cost is scary o, how can i possibly
// make it less and still be natural" tried Haiku here for exactly this
// reasoning -- these only ever return a routing label, never text the
// customer sees. Reverted the same day: "i tapped yes confirm how does
// that imply i asked for a person" -- a real customer's "Yes, confirm"
// (confirming an order) got misread by Haiku as wanting a human and
// handed over to staff. Tested directly against both models with the
// exact text: Sonnet correctly says wants_human: false for "Yes, confirm"
// and bare "Yes"; Haiku said true for both. Back on Sonnet for all three
// -- a routing mistake this consequential (a customer silently pulled out
// of automated handling) isn't worth the savings until Haiku's reliability
// on this specific task can be proven, not assumed.
export async function classifyIntent(message) {
  const result = await askJson(SYSTEM, message);
  const intent = ['greeting', 'enquiry', 'order', 'complaint'].includes(result?.intent) ? result.intent : 'enquiry';
  return { intent, wantsHuman: result?.wants_human === true };
}

const WANTS_HUMAN_SYSTEM = `Does this WhatsApp message explicitly ask to speak to a person, a human, staff, or the owner -- not a vague complaint or a passing mention? Reply ONLY with JSON: {"wants_human": true or false}`;

export async function detectWantsHuman(message) {
  const result = await askJson(WANTS_HUMAN_SYSTEM, message);
  return result?.wants_human === true;
}

const DELAY_COMPLAINT_SYSTEM = `Is this message frustration or a complaint about an order taking too long, being delayed, or wasting their time -- not just a plain "how long" question asked once, but real frustration/annoyance about the wait? Reply ONLY with JSON: {"complaint": true or false}.`;

export async function detectDelayComplaint(message) {
  const result = await askJson(DELAY_COMPLAINT_SYSTEM, message);
  return result?.complaint === true;
}
