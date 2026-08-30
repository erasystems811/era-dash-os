import express from 'express';
import { handleInboundMessage, handleInboundMedia, recordAppReply, acknowledgeMenuTap } from './flow.js';
import { menuRowKind, handleMenuNavigation, productNameForRowId } from './menu-message.js';

export const router = express.Router();

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
        for (const message of change.value?.messages || []) {
          if (message.type === 'image') {
            await handleInboundMedia({ phoneNumber: message.from, mediaId: message.image.id, kind: 'image', channel: 'whatsapp' });
            continue;
          }
          if (message.type === 'document') {
            await handleInboundMedia({ phoneNumber: message.from, mediaId: message.document.id, kind: 'document', channel: 'whatsapp' });
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
              if (productName) await acknowledgeMenuTap({ phoneNumber: message.from, itemName: productName, channel: 'whatsapp' });
            } else {
              await handleMenuNavigation(message.from, rowId).catch((err) => console.error('handleMenuNavigation failed:', err.message));
            }
            continue;
          }
          if (message.type !== 'text') continue; // audio/video not handled yet
          await handleInboundMessage({ phoneNumber: message.from, text: message.text.body, channel: 'whatsapp', messageId: message.id });
        }
      }
    }
  } catch (err) {
    console.error('WhatsApp webhook processing failed:', err);
  }
});
