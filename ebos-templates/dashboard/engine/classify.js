import { askJson } from './claude.js';

const SYSTEM = `Classify the customer's WhatsApp message. Only used when they have no order or booking already in progress, so judge it as the start of something new.
intent -- exactly one of:
greeting: just saying hi, hello, good morning, or similar small talk with no actual question or order in it yet.
enquiry: a real question (about hours, price, availability, policy, anything answerable from a knowledge base).
order: they want to order or book something, even vaguely (e.g. naming a dish, or "I want to order").
complaint: unhappy about something, a problem with a past order, or asking for a refund.
wants_human -- true only if they explicitly ask to speak to a person, false otherwise.
Reply ONLY with JSON: {"intent": "greeting" or "enquiry" or "order" or "complaint", "wants_human": true or false}`;

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
