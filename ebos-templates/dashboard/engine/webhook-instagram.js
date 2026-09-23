// Instagram's webhook payload shape is the long-standing Messenger
// Platform format (entry[].messaging[], sender.id/message.text/
// message.attachments), NOT WhatsApp Business API's shape
// (entry[].changes[].value.messages[]) -- a genuinely different parser,
// even though both ultimately go through Meta's Graph API. Confirmed
// against Meta's current docs before writing this, same as webhook-
// whatsapp.js's own history of not guessing at payload shapes.
import express from 'express';
import { pool } from '../lib/db.js';
import { handleInboundMessage, handleInboundMedia, recordAppReplyInstagram } from './flow.js';

export const router = express.Router();

router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

router.post('/', async (req, res) => {
  // Acknowledge immediately -- same reasoning as webhook-whatsapp.js, Meta
  // retries aggressively on a slow/failed response.
  res.sendStatus(200);

  try {
    const entries = req.body?.entry || [];
    for (const entry of entries) {
      for (const event of entry.messaging || []) {
        const message = event.message;
        if (!message) continue;

        // Meta mirrors every business-sent message back through this same
        // webhook (is_echo: true), regardless of whether the bot's own API
        // call sent it or a human typed it directly in the Instagram app --
        // Instagram gives no separate signal for the two the way WhatsApp's
        // smb_message_echoes does. So this checks message.platform_message_id
        // (stamped on every message flow.js sends) against the echo's own
        // mid: a match means "that's one of ours, ignore it"; no match means
        // a real human just replied from the app, and the bot needs to go
        // quiet for that conversation the same way it does for WhatsApp
        // coexistence. Confirmed against Meta's actual docs: on an echo,
        // sender.id is the BUSINESS's own account and recipient.id is the
        // customer -- the opposite of a normal inbound event, so this reads
        // recipient.id here, not sender.id.
        if (message.is_echo) {
          const { rows } = await pool.query('select 1 from message where platform_message_id = $1 limit 1', [message.mid]);
          if (rows.length) continue; // Our own send (bot or staff-via-dashboard) -- already logged, nothing to do.
          const customerChannelId = event.recipient?.id;
          if (customerChannelId && message.text) {
            await recordAppReplyInstagram({ channelId: customerChannelId, text: message.text });
          }
          continue;
        }

        const senderId = event.sender?.id;
        if (!senderId) continue;

        const attachments = Array.isArray(message.attachments) ? message.attachments : [];
        const mediaAttachment = attachments.find((a) => a.type === 'image' || a.type === 'file' || a.type === 'video');
        if (mediaAttachment?.payload?.url) {
          const kind = mediaAttachment.type === 'image' ? 'image' : 'document';
          await handleInboundMedia({ channelId: senderId, mediaId: mediaAttachment.payload.url, kind, channel: 'instagram' });
          continue;
        }
        if (!message.text) continue; // no text and no usable attachment -- nothing to act on
        await handleInboundMessage({ channelId: senderId, text: message.text, channel: 'instagram', messageId: message.mid });
      }
    }
  } catch (err) {
    console.error('Instagram webhook processing failed:', err);
    // Same reasoning as webhook-whatsapp.js's own catch -- see its comment.
    await pool
      .query(`insert into ai_errors (message) values ($1)`, [`Instagram webhook processing failed: ${err.message}`.slice(0, 500)])
      .catch(() => {});
  }
});
