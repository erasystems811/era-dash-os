import express from 'express';
import { handleInboundMessage, handleInboundMedia, recordAppReply, acknowledgeMenuTap } from './flow.js';
import { menuRowKind, handleMenuNavigation, productNameForRowId } from './menu-message.js';
import { resolveBranchByPhoneNumberId } from './branch-channel.js';

export const router = express.Router();

// Meta genuinely delivers the same webhook event more than once sometimes
// (confirmed live: identical message id, milliseconds apart) -- normal
// typed messages happened to be shielded from this by the debounce queue
// batching them together, but a List Message tap is deliberately NOT
// debounced (see below, a tap should feel instant), so a duplicate tap
// delivery produced two real replies. Every inbound message gets this same
// guard now, keyed on WhatsApp's own message id, so a repeat delivery of
// anything is silently dropped regardless of which path handles it.
// In-memory and time-bounded on purpose -- this only needs to catch
// duplicates arriving within the same delivery burst (milliseconds to a
// few seconds apart), not survive a server restart.
const seenMessageIds = new Map();
const DEDUP_TTL_MS = 5 * 60 * 1000;
function isDuplicateMessage(id) {
  if (!id) return false;
  const now = Date.now();
  for (const [seenId, seenAt] of seenMessageIds) {
    if (now - seenAt > DEDUP_TTL_MS) seenMessageIds.delete(seenId);
  }
  if (seenMessageIds.has(id)) return true;
  seenMessageIds.set(id, now);
  return false;
}

router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

router.post('/', async (req, res) => {
  // Acknowledge immediately -- Meta retries aggressively if the webhook
  // doesn't 200 quickly, and the actual reply happens async below.
  res.sendStatus(200);

  try {
    const entries = req.body?.entry || [];
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        // Coexistence mode (Settings' "WhatsApp connection"): a real human
        // replied from the business's OWN WhatsApp app, not this
        // dashboard. Meta mirrors it here as its own field/shape --
        // message_echoes, not messages -- so it needs its own branch, not
        // just another message type. Confirmed against Meta's actual docs
        // before writing this, same discipline as everywhere else Meta's
        // exact payload shape mattered this session.
        if (change.field === 'smb_message_echoes') {
          for (const echo of change.value?.message_echoes || []) {
            if (echo.type !== 'text' || !echo.text?.body) continue; // only text handled for now
            await recordAppReply({ phoneNumber: echo.to, text: echo.text.body });
          }
          continue;
        }
        // Which of the business's own WhatsApp numbers this event arrived
        // on -- resolves to a real branch only once that number has a
        // branch_channel row (engine/branch-channel.js); null for every
        // business today, which every call below already treats as "not
        // resolved by channel, decide some other way" (a single-branch
        // business needs no resolution at all; a shared-number multi-branch
        // business will ask the customer instead, once that's built).
        const branchId = await resolveBranchByPhoneNumberId(change.value?.metadata?.phone_number_id);
        for (const message of change.value?.messages || []) {
          if (isDuplicateMessage(message.id)) continue;
          if (message.type === 'image') {
            await handleInboundMedia({ phoneNumber: message.from, mediaId: message.image.id, kind: 'image', channel: 'whatsapp', branchId });
            continue;
          }
          if (message.type === 'document') {
            await handleInboundMedia({ phoneNumber: message.from, mediaId: message.document.id, kind: 'document', channel: 'whatsapp', branchId });
            continue;
          }
          // A tap on the List Message menu (engine/menu-message.js) --
          // never queued through the normal debounce pipeline below, a
          // button tap should feel instant, not wait out the same window a
          // typed message does. A category/"More" row just shows the next
          // list; a product row is browsing, not ordering -- WhatsApp only
          // allows one tap at a time with no real multi-select, so tapping
          // just acknowledges what they looked at and asks them to type
          // their real order (see acknowledgeMenuTap for why).
          if (message.type === 'interactive' && message.interactive?.type === 'list_reply') {
            const rowId = message.interactive.list_reply.id;
            if (menuRowKind(rowId) === 'product') {
              const productName = await productNameForRowId(rowId);
              if (productName) await acknowledgeMenuTap({ phoneNumber: message.from, itemName: productName, channel: 'whatsapp', branchId });
            } else {
              await handleMenuNavigation(message.from, rowId, branchId).catch((err) => console.error('handleMenuNavigation failed:', err.message));
            }
            continue;
          }
          if (message.type !== 'text') continue; // audio/video not handled yet
          await handleInboundMessage({ phoneNumber: message.from, text: message.text.body, channel: 'whatsapp', messageId: message.id, branchId });
        }
      }
    }
  } catch (err) {
    console.error('WhatsApp webhook processing failed:', err);
  }
});
