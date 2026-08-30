// One reusable way to pull a single piece of information out of a message.
// Every field (name, date, yes/no, address, anything) goes through this --
// never write a new one-off extraction prompt per field again. Fix a bug
// here once, it's fixed for every field in every bot at once.

const DATE_TYPE_WARNING =
  "Never invent a missing part. If the message gives only a day of the month with no month, or a relative date you cannot resolve without knowing today's date, return null -- do not guess a month or year.";

function buildPrompt(field) {
  const lines = [
    `Extract the value of "${field.label}" from the customer's WhatsApp message below, if it's actually present.`,
    field.description || '',
    'Accept any capitalization -- WhatsApp users often type in all lowercase, and that is exactly as valid as a capitalized answer.',
    'Judge the whole message, not just its opening words -- a casual opener ("hey", "so") does not change whether real content follows.',
    'A short bare reply (e.g. "full", "yes") can be a real answer, not meaningless -- it will be given to you together with the question it is answering, so judge it in that context.',
  ];
  if (field.type === 'date') lines.push(DATE_TYPE_WARNING);
  if (field.examples?.length) lines.push(`Examples of valid answers: ${field.examples.join(', ')}`);
  lines.push(`Reply ONLY with JSON: {"${field.key}": <value> or null}`);
  return lines.filter(Boolean).join(' ');
}

export function defineField(config) {
  // config: { key, label, description, type: 'text'|'date'|'boolean'|'choice', examples, choices, validate }
  if (!config.key) throw new Error('Field config needs a "key".');
  if (!config.label) throw new Error('Field config needs a "label".');
  return { type: 'text', ...config };
}

export async function extractField(field, message, { askJson, contextQuestion }) {
  // askJson: (systemPrompt, userText) => Promise<object> -- the real LLM
  // call is injected so this stays testable against fixtures without a
  // live API call.
  if (!message) return null;
  const text = contextQuestion ? `Question asked: "${contextQuestion}"\nReply: "${message}"` : message;
  const result = await askJson(buildPrompt(field), text);
  const value = result?.[field.key];
  if (value === undefined || value === null) return null;
  if (field.type === 'boolean' && typeof value !== 'boolean') return null;
  if (field.choices && !field.choices.includes(value)) return null;
  if (field.validate && !field.validate(value)) return null;
  return value;
}
