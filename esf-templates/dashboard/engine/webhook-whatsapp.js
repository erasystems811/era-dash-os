import express from 'express';
import { pool } from '../lib/db.js';
import { getStaffByPhone, handleStaffReply } from './run-engine.js';
import { downloadWhatsAppMedia, sendWhatsApp } from './whatsapp-send.js';
import { sanitizeText } from '../bot-engine/send.js';

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

// Idempotency (engine rule 4): WhatsApp resends on poor network. wa_message_id
// is unique on the message table -- a repeat insert fails, and that failure
// IS the "already handled" signal, not a separate lookup-then-insert race.
async function alreadyHandled(waMessageId) {
  try {
    await pool.query(`insert into message (direction, wa_message_id) values ('inbound', $1)`, [waMessageId]);
    return false;
  } catch (err) {
    if (err.code === '23505') return true; // unique_violation
    throw err;
  }
}

// alreadyHandled() already inserted the bare idempotency row for this
// inbound message (direction + wa_message_id only) -- fill in who it was
// from and what it said on that same row, rather than inserting a second
// one.
async function attachInboundDetails(waMessageId, staffId, body) {
  await pool.query(`update message set staff_id = $1, body = $2 where wa_message_id = $3`, [staffId, body, waMessageId]);
}

async function logOutbound(staffId, body) {
  await pool.query(`insert into message (staff_id, direction, body) values ($1, 'outbound', $2)`, [staffId, body]);
}

router.post('/', async (req, res) => {
  // Acknowledge immediately -- Meta retries aggressively if the webhook
  // doesn't 200 quickly; the actual reply happens async below.
  res.sendStatus(200);

  try {
    const entries = req.body?.entry || [];
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        for (const message of change.value?.messages || []) {
          if (await alreadyHandled(message.id)) continue;

          const staff = await getStaffByPhone(message.from);
          if (!staff) {
            // ESF has no customer-facing surface (build schema v2.0 section
            // 2.1) -- an unrecognised number has nothing to talk to here.
            continue;
          }

          let input;
          if (message.type === 'text') {
            input = { type: 'text', text: message.text.body };
            await attachInboundDetails(message.id, staff.id, message.text.body);
          } else if (message.type === 'image') {
            const mediaDataUrl = await downloadWhatsAppMedia(message.image.id);
            input = { type: 'image', mediaDataUrl };
            await attachInboundDetails(message.id, staff.id, '[photo]');
          } else if (message.type === 'location') {
            input = { type: 'location', lat: message.location.latitude, lng: message.location.longitude };
            await attachInboundDetails(message.id, staff.id, '[location]');
          } else {
            continue; // audio/video/documents not a proof type this engine accepts
          }

          const { reply } = await handleStaffReply({ staff, input });
          if (reply) {
            const clean = sanitizeText(reply);
            await sendWhatsApp(staff.phone, clean);
            await logOutbound(staff.id, clean);
          }
        }
      }
    }
  } catch (err) {
    console.error('WhatsApp webhook processing failed:', err);
  }
});
