// One shared "ask an internal person, wait for their answer, resume the
// customer conversation" primitive -- used for both an unknown question and
// a proposed amount that needs approval. Not two separate mechanisms for
// those two cases, and not specific to any one business's bot.
//
// Transport-agnostic on purpose (same pattern as send.js's whatsappSend):
// sendToOwner/waitForOwnerReply/sendToCustomer are injected, so this works
// identically whether "waiting for the owner" means a local terminal
// prompt in a sandbox or a real WhatsApp reply from a live number.

export async function escalateAndWait({ summary, questionOrAmount, hasPhoto, sendToOwner, waitForOwnerReply, holdingMessage, sendToCustomer }) {
  if (!summary) throw new Error('escalateAndWait needs a summary of what led to the question, not a recap of the whole conversation.');
  if (!questionOrAmount) throw new Error('escalateAndWait needs the actual question or amount to send.');
  if (holdingMessage && sendToCustomer) await sendToCustomer(holdingMessage);
  await sendToOwner({ summary, questionOrAmount, hasPhoto: Boolean(hasPhoto) });
  return waitForOwnerReply();
}
