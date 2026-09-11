import express from 'express';
import { handleInboundMessage, handleInboundMedia, recordAppReply, handleMenuItemTap, handleStartOrderTap, handleDineinButtonTap, handleOrderConfirmNoTap, handleUpsellListTap, retryFailedSendAsTemplate } from './flow.js';
import { menuRowKind, handleMenuNavigation, productForRowId } from './menu-message.js';
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
        // Delivery-status callbacks (sent/delivered/read/failed) -- found
        // live, 2026-09-02: this handler never processed these at all, so
        // a send Meta accepts synchronously (a real wamid, no error) and
        // only fails afterward -- exactly what happens to a plain-text
        // reply sent just outside the 24h window sometimes -- silently
        // vanished with no retry and nothing in the UI to show it. Only
        // 'failed' does anything; 'sent'/'delivered'/'read' are genuinely
        // not actionable here (see flow.js's retryFailedSendAsTemplate for
        // why those checks come first inside it, not duplicated here).
        for (const status of change.value?.statuses || []) {
          if (status.status !== 'failed') continue;
          // Same duplicate-delivery behavior as inbound messages (see
          // isDuplicateMessage's own comment) -- confirmed live 2026-09-02:
          // without this, one real failure fired retryFailedSendAsTemplate
          // TWICE a fraction of a second apart, which would have sent the
          // customer the same recovered message twice. Keyed distinctly
          // from a message id (different id space) even though collision
          // is effectively impossible either way.
          if (isDuplicateMessage(`status:${status.id}:${status.status}`)) continue;
          const isWindowClosed = (status.errors || []).some((e) => e.code === 131047);
          if (!isWindowClosed) {
            console.error(`WhatsApp message ${status.id} failed to deliver:`, JSON.stringify(status.errors));
            continue; // a failure reason retrying the same way can't fix
          }
          await retryFailedSendAsTemplate(status.id).catch((err) => console.error(`Retry-as-template failed for ${status.id}:`, err.message));
        }

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
          // list; a product row really orders it now (see flow.js's
          // handleMenuItemTap) -- no AI call needed to know what was
          // picked, the tap alone is unambiguous.
          if (message.type === 'interactive' && message.interactive?.type === 'list_reply') {
            const rowId = message.interactive.list_reply.id;
            if (rowId.startsWith('upsell::')) {
              // flow.js's sendUpsellList -- a completely separate row-id
              // space from the general menu list below, so it's checked
              // first rather than risk menuRowKind ever treating one as an
              // ordinary product id.
              await handleUpsellListTap({ phoneNumber: message.from, channelId: message.from, rowId, channel: 'whatsapp', branchId });
            } else if (menuRowKind(rowId) === 'product') {
              const product = await productForRowId(rowId);
              if (product) await handleMenuItemTap({ phoneNumber: message.from, product, channel: 'whatsapp', branchId });
            } else {
              await handleMenuNavigation(message.from, rowId, branchId).catch((err) => console.error('handleMenuNavigation failed:', err.message));
            }
            continue;
          }
          // The "Place an order" reply button on the first greeting (see
          // flow.js's handleGreeting) -- also instant, same as a list tap.
          if (message.type === 'interactive' && message.interactive?.type === 'button_reply') {
            const buttonId = message.interactive.button_reply.id;
            const buttonTitle = message.interactive.button_reply.title;
            if (buttonId === 'start_order') {
              await handleStartOrderTap({ phoneNumber: message.from, channel: 'whatsapp', branchId });
            } else if (['dinein_menu', 'dinein_specials'].includes(buttonId)) {
              await handleDineinButtonTap({ phoneNumber: message.from, buttonId, channel: 'whatsapp', branchId });
            } else if (buttonId === 'order_confirm_yes') {
              // flow.js's sendConfirmButtons -- put through the exact same
              // text pipeline a typed "yes" would take, so every state-
              // dependent confirm branch already in dispatch() handles it
              // correctly with no new logic needed here. Uses the button's
              // own title, not a hardcoded 'yes', so the transcript reads
              // the same as if they'd typed it themselves.
              await handleInboundMessage({ phoneNumber: message.from, text: buttonTitle, channel: 'whatsapp', messageId: message.id, branchId });
            } else if (buttonId === 'order_confirm_no') {
              // Sent directly, not through the AI confirm pipeline -- see
              // handleOrderConfirmNoTap's own comment for why.
              await handleOrderConfirmNoTap({ phoneNumber: message.from, channel: 'whatsapp', branchId });
            } else if (buttonId === 'fulfilment_delivery' || buttonId === 'fulfilment_pickup') {
              // flow.js's sendFieldPrompt (the delivery/pickup buttons) --
              // same "put the button's own title through the normal text
              // pipeline" reasoning as order_confirm_yes above.
              await handleInboundMessage({ phoneNumber: message.from, text: buttonTitle, channel: 'whatsapp', messageId: message.id, branchId });
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
