// WhatsApp only allows a pre-approved template message outside the 24-hour
// customer service window -- a freeform message sent outside that window
// fails silently. Send the short template first, then wait: ANY reply from
// the customer reopens the window (that's how WhatsApp's own rule works) --
// never wait for a specific word like "ok", that's a fragile match that
// will fail the moment someone replies "sure" or "yes" instead.

export async function sendWakeTemplateIfNeeded({ lastCustomerMessageAt, sendTemplate, queuePendingText, businessName, pendingText }) {
  const hoursSince = (Date.now() - new Date(lastCustomerMessageAt).getTime()) / 36e5;
  if (hoursSince < 24) return { sentTemplate: false };
  await sendTemplate({ businessName });
  await queuePendingText(pendingText);
  return { sentTemplate: true };
}

export function shouldFlushQueuedMessage({ hasQueuedMessage }) {
  // Called on ANY inbound reply after a wake template went out -- not
  // pattern-matched against specific wording.
  return Boolean(hasQueuedMessage);
}
