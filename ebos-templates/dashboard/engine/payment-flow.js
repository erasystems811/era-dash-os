// Payment messaging/completion -- split out of flow.js 2026-10-01 as the
// sixth phase of breaking up that file's 6800+ lines into focused pieces
// (see sweeps.js, voice-turn.js, dinein.js, staff.js, greeting.js for the
// first five). Named payment-flow.js, not payment.js -- engine/payment.js
// already exists (the low-level Paystack/Monnify/OPay API wrapper this
// file sits above, same layering idea as engine/voice.js above
// voice-turn.js). Everything here is "how a customer pays and what
// happens once they have" -- not item collection/upsell/confirm/
// fulfilment, which stay in flow.js as their own future split.
// createSingleOrderPayment/sendPosPaymentChoice/buildPayLine/
// menuKeywordMatch-adjacent order-question helpers stay private to
// whichever file actually owns them -- buildPayLine is this file's own
// private helper (only used by the functions below); answerOrThenShowMenu/
// transitionOrder/displayNameFor are flow.js's (imported back), since
// they're used well outside payment too.
import { randomBytes } from 'node:crypto';
import { pool } from '../lib/db.js';
import { sendWhatsAppDocument, sendWhatsAppCtaUrl, getWaDisplayNumber } from './whatsapp-send.js';
import { createInvoice, createReceipt } from './documents.js';
import { initializePaystackTransaction, initializePaystackTopupTransaction, initializeMonnifyTransaction, initializeOpayTransaction, getPaymentConfig } from './payment.js';
import { pushPaymentRequest, lookupTransactionByReference } from './moniepoint-api.js';
import { createDelivery } from './delivery.js';
import { getWhatsAppCredentials } from './branch-channel.js';
import { createMagicLink } from '../lib/auth.js';
import {
  summariseOrder,
  sendFeedbackRequest,
  handover,
  reply,
  recipientFor,
  logMessage,
  ensureMenuToken,
  orderAlertRecipients,
  notifyStaff,
  handoverRecipients,
  transitionOrder,
  displayNameFor,
  answerOrThenShowMenu,
  confirmOrderPayment,
} from './flow.js';

// Shared by sendPaymentInstructions and its repeat-reminder counterpart --
// same real send, same reasoning (see buildPayLine's own comment on why
// the URL travels as a button, not embedded text) either time it's needed.
//
// Chidera, 2026-09-17: "cutting from ~15 to ~10 messages per order... but
// be careful let the current quality not drop" -- `bodyText` used to be a
// separate plain-text reply sent right before this (e.g. "Please pay NGN
// X using the button below."), immediately followed by this exact button
// with a near-empty body ("Tap below to pay securely."). WhatsApp's own
// CTA-URL body field already holds up to 1024 characters, so that lead-in
// text now travels AS the button's own body instead of its own separate
// message -- same information, same button, one send instead of two. Only
// on Instagram (no CTA-URL button type) does bodyText still need its own
// plain-text line ahead of the raw link.
export async function sendPaymentLinkButton(customer, paymentUrl, bodyText) {
  if (customer.channel === 'instagram') {
    await reply(customer, `${bodyText}\n\nPay here: ${paymentUrl}`);
    return;
  }
  if (customer.channel === 'website') {
    await logMessage({
      customerId: customer.id, tableSessionId: customer.tableSessionId,
      direction: 'outbound',
      channel: customer.channel,
      sender: 'bot',
      body: `${bodyText}\n[payment link sent: ${paymentUrl}]`,
      trigger: 'payment_link',
      processed: true,
      // Chidera, 2026-09-24: "when i tap pay now and enter that paystack
      // stuff there is no back button to go back to web chat only the one
      // that goes back to the main chat." Paystack's checkout is a real
      // third-party page we don't control -- no button we add there can
      // get a customer "back to web chat" while they're on it, and a
      // WhatsApp in-app browser's own back chevron always returns to the
      // WhatsApp thread, not page history. Opening it in a NEW tab (unlike
      // "See menu"/"View invoice", which deliberately stay same-tab for
      // their own intentional round-trip back to this page) keeps THIS
      // chat tab genuinely still open behind it -- switching tabs (or just
      // closing the Paystack one once done) gets them back, something a
      // same-tab navigation into another domain can never guarantee.
      interactive: { type: 'cta_url', buttonText: 'Pay now', url: paymentUrl, newTab: true },
    });
    return;
  }
  const credentials = await getWhatsAppCredentials(customer.branch_id);
  await sendWhatsAppCtaUrl(recipientFor(customer), bodyText, 'Pay now', paymentUrl, credentials);
  await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel: customer.channel, sender: 'bot', body: `${bodyText}\n[payment link sent: ${paymentUrl}]`, trigger: 'payment_link', processed: true });
}

// Chidera, 2026-09-20: "i want them to be able to pick transfer or card,
// transfer will give them number on pos while card the bot just waits to
// auto confirm payment... i need pos to work now for both online and in
// house." Dine-in's own Stage 3 (order_payment + matchPosTransactionToPayment,
// both real and already tested -- sandbox/test-dinein-pos-payment.mjs)
// already auto-confirms EITHER a transfer-to-the-terminal or a card tap
// the exact same way (both land as a real Moniepoint POS_TRANSACTION,
// matched by amount) -- so Transfer vs Card is purely which instructions
// the customer sees, never a different backend path. This reuses that
// same mechanism for a single online order instead of a table's split/
// joint one (covers_item_ids always null here -- one customer, one
// payment, the whole order).
async function createSingleOrderPayment(order, customerId) {
  const { rows: existing } = await pool.query(
    `select * from order_payment where order_id = $1 and status = 'pending' and covers_item_ids is null`,
    [order.id]
  );
  if (existing.length) return existing[0];
  const reference = `${order.reference}-P${randomBytes(3).toString('hex').toUpperCase()}`;
  const { rows } = await pool.query(
    `insert into order_payment (order_id, provider, reference, amount, covers_item_ids, paid_by_customer_id)
     values ($1, 'pos', $2, $3, null, $4) returning *`,
    [order.id, reference, order.total, customerId]
  );
  return rows[0];
}

// Chidera, 2026-09-20 (a second pass on the same feature): "when pos is
// selected the whole thing will still be inside the web na, for dine in
// it can be where the shared order ready to pay lives... make it 'ready
// to pay? click here'." The Transfer/Card choice itself lives on a real
// web page now (routes/menu-page.js's own /:token/pay, same shape as
// dine-in's own pay page), not WhatsApp quick-reply buttons -- this just
// sends the link into it, same CTA-URL pattern dine-in's own
// notifyGuestsReadyToPay already uses for its own "Ready to pay" button.
async function sendPosPaymentChoice(customer, order) {
  await createSingleOrderPayment(order, customer.id);
  if (!process.env.PUBLIC_URL) {
    await reply(customer, `Your order is ready to pay. Please ask a staff member for payment details.`, 'pos_pay_choice');
    return;
  }
  const token = await ensureMenuToken(customer);
  const url = `${process.env.PUBLIC_URL}/m/${token}/pay`;
  // Chidera, 2026-09-21: "look at my instagram flow... how does instagram
  // catch up" -- found live, this was built WhatsApp-only (no CTA-URL
  // button type on Instagram) with no fallback at all, unlike
  // sendPaymentLinkButton right above, which already has the correct
  // pattern -- an Instagram customer on POS would have hit this and
  // gotten nothing. Same fallback now: a plain text line with the real
  // link, auto-linkified by Instagram's own client.
  if (customer.channel === 'instagram') {
    await reply(customer, `Ready to pay?\n\n${url}`, 'pos_pay_choice');
    return;
  }
  // website: same /m/:token/pay page every channel already uses (Transfer/
  // Card choice, live payment-status polling) -- a bubble linking out to
  // it, not a real WhatsApp send. Full on-page POS parity (claim-tap etc.)
  // is Phase 2; this just closes the "falls through to a real send" gap.
  if (customer.channel === 'website') {
    await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel: customer.channel, sender: 'bot', body: `[pay link sent: ${url}]`, trigger: 'pos_pay_choice', interactive: { type: 'cta_url', buttonText: 'Ready to pay?', url } });
    return;
  }
  const credentials = await getWhatsAppCredentials(customer.branch_id);
  await sendWhatsAppCtaUrl(recipientFor(customer), 'Ready to pay?', 'Click here', url, credentials);
  await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel: customer.channel, sender: 'bot', body: `[pay link sent: ${url}]`, trigger: 'pos_pay_choice' });
}

// Chidera, 2026-09-26: "instagram doesnt need the web chat, after linking
// monify, the back to merchant site button on instagram is taking customer
// back to web chat instead of the normal instagram chat" -- Monnify/
// Paystack's own "back to merchant" redirect was hardcoded to /wa/:token
// (the real web-chat page) for every channel, copied from the 2026-09-25
// fix that gave WEBSITE customers a real thread to return to. That's only
// ever right for the website channel -- WhatsApp/Instagram customers were
// never in that page to begin with. Same root cause, and same fix, as the
// 2026-09-21 "after i closed web from instagram it took me on whatsapp"
// bug already solved for the web menu page (engine/menu-page-template.js):
// wa.me/<digits> and ig.me/m/<handle> are each platform's own equivalent,
// intercepted by that app's own in-app browser to jump back into the real
// chat. Returns null (no redirect) rather than guessing wrong when neither
// number/handle is configured -- same fallback the menu page already uses.
export async function resolveBackToChatUrl(customer, menuToken) {
  if (customer.channel === 'website') {
    return process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL}/wa/${menuToken}` : null;
  }
  if (customer.channel === 'instagram') {
    const { rows } = await pool.query(
      `select instagram_handle from branch
       where instagram_handle is not null and instagram_handle != ''
       order by (id = $1) desc
       limit 1`,
      [customer.branch_id]
    );
    const handle = rows[0]?.instagram_handle || null;
    return handle ? `https://ig.me/m/${handle}` : null;
  }
  const credentials = await getWhatsAppCredentials(customer.branch_id);
  const waNumber = await getWaDisplayNumber(credentials);
  const digits = String(waNumber || '').replace(/\D/g, '');
  return digits ? `https://wa.me/${digits}` : null;
}

// Shared by the initial "here's how to pay" and by an order modification
// that lands while still awaiting payment (new total needs a fresh Paystack
// transaction and a re-sent amount, not the stale one from before the
// change).
// Real Paystack integration, re-attached 2026-09-16 for a client who
// specifically wants auto-confirmation -- webhook-paystack.js's own
// auto-confirm only ever fires for a transaction that was actually
// initialized through Paystack, and nothing called
// initializePaystackTransaction anywhere until now. Deliberately per-
// business, not a return to a global "Pay now" link for everyone: the
// comment this replaced recorded why it was pulled in the first place
// (customers preferred plain bank details), and that's still true for
// every business that hasn't configured Paystack -- only
// PAYMENT_PROVIDER=paystack gets this path, everyone else keeps the exact
// bank-transfer flow unchanged. Falls back to bank details if the Paystack
// call itself fails (a network hiccup, a bad key) rather than leaving the
// customer stuck with neither.
async function buildPayLine(order, customer, { amount, amountLabel }) {
  const paymentConfig = await getPaymentConfig();
  // provider === 'pos' -- Settings' own explicit choice, always wins.
  // No configured row (or a row with no provider set) falls through to the
  // exact same PAYMENT_PROVIDER env-var check every existing client
  // already runs on today -- see payment_config's own schema comment for
  // why this must never change behavior on its own.
  if (paymentConfig?.provider === 'pos') {
    return { payLine: null, needsHandover: false, paymentUrl: null, posChoice: true };
  }
  // Chidera, 2026-09-23: "monify first" -- Monnify's dynamic bank-transfer
  // account. Unlike Paystack, there's no legacy env-var fallback to
  // consider here (this provider never existed before payment_config did),
  // so it only ever activates on an explicit Settings choice.
  if (paymentConfig?.provider === 'monnify') {
    try {
      // Chidera, 2026-09-24: "the monnify account that was sent is
      // unavailable and invalid and cant it be a link like paystack? so the
      // auto confirm can be obvious." A real hosted checkout link now
      // (initializeMonnifyTransaction returns the URL string directly,
      // same contract as initializePaystackTransaction below), not account
      // details rendered into the text -- same "using the button below"
      // wording Paystack's own branch uses, same paymentUrl handling in
      // sendPaymentInstructions (sendPaymentLinkButton), no special-casing.
      // Chidera, 2026-09-25: "why isnt customer auto taken back to web
      // chat after payment with monify?" -- same callbackUrl fix
      // Paystack's own branch below already has. 2026-09-26: that fix was
      // web-chat-only and got applied to every channel -- resolveBackToChatUrl
      // (its own comment above) sends WhatsApp/Instagram customers back to
      // their real app instead.
      const monnifyMenuToken = await ensureMenuToken(customer);
      const monnifyCallbackUrl = (await resolveBackToChatUrl(customer, monnifyMenuToken)) || undefined;
      const url = await initializeMonnifyTransaction({ order, customer, amount, callbackUrl: monnifyCallbackUrl });
      if (url) {
        // Chidera, real live report right after the checkout-link switch:
        // "that dynamic monify account is showing me as invalid and
        // unavailable" -- confirmed live (opened the actual link Monnify
        // sent back): the checkout session itself had genuinely expired,
        // a real, expected time limit on Monnify's own end. Follow-up:
        // "i cant text you, it should be auto regenerated" -- also
        // confirmed live that Monnify's own "Try again" button on an
        // expired session doesn't work either, just loops back to the
        // same dead transaction. Fixed properly now:
        // refreshExpiringPaymentLinks (this file, called from server.js
        // every 2 minutes) proactively regenerates a fresh link before
        // the customer would ever see "expired" at all -- no reply from
        // them needed, so this text doesn't need to explain a manual
        // workaround that no longer exists.
        return {
          payLine: `Please pay NGN ${amountLabel} using the button below.\n\nYour order moves to preparation automatically the moment payment goes through -- no need to send proof.`,
          needsHandover: false,
          paymentUrl: url,
        };
      }
    } catch (err) {
      console.error(`Monnify checkout link failed for order ${order.id}, falling back to bank details: ${err.message}`);
    }
  }
  // Chidera, 2026-09-23: "so what of opay?" -- same shape as Monnify above,
  // OPay's own dynamic bank-transfer account. No "Account name" line --
  // OPay's own response never returns one (see opay-api.js's own comment).
  if (paymentConfig?.provider === 'opay') {
    try {
      const result = await initializeOpayTransaction({ order, customer, amount });
      if (result) {
        const validityLine = result.expiresAt
          ? ` (valid for the next ${Math.max(1, Math.round((new Date(result.expiresAt).getTime() - Date.now()) / 60000))} minutes)`
          : '';
        return {
          payLine: `Please pay NGN ${amountLabel} using the account below${validityLine}.\n\nBank: ${result.bankName}\nAccount number: ${result.accountNumber}\n\nYour order moves to preparation automatically the moment payment goes through -- no need to send proof.`,
          needsHandover: false,
          paymentUrl: null,
        };
      }
    } catch (err) {
      console.error(`OPay dynamic account failed for order ${order.id}, falling back to bank details: ${err.message}`);
    }
  }
  const useProviderPaystack = paymentConfig?.provider ? paymentConfig.provider === 'paystack' : process.env.PAYMENT_PROVIDER === 'paystack';
  if (useProviderPaystack && process.env.PAYMENT_SECRET_KEY) {
    try {
      // Chidera, 2026-09-23: "when i click pay now and go to pay stack i
      // cant see back to chat." Every customer already has (or gets, right
      // here) a persistent menu_token -- Paystack redirects back to this
      // exact chat page once payment finishes, same "Back to chat" idea
      // documents.js's invoice page already got. 2026-09-26: same fix as
      // Monnify's own branch above -- resolveBackToChatUrl instead of
      // always /wa/:token, so WhatsApp/Instagram customers land back in
      // their real app, not the web-chat page they never used.
      const menuToken = await ensureMenuToken(customer);
      const callbackUrl = (await resolveBackToChatUrl(customer, menuToken)) || undefined;
      const url = await initializePaystackTransaction({ order, customer, amount, callbackUrl });
      if (url) {
        // Chidera, 2026-09-16: "i actually got a payment link o, but it
        // opened out of whatsapp not in" -- the URL used to be embedded
        // straight into this plain-text line, so WhatsApp rendered it as
        // an ordinary tappable link (opens the phone's own browser, same
        // as any link in any text message). paymentUrl is now returned
        // separately so the caller can send it as a real CTA-URL button
        // instead, exactly like the menu link and the handover link
        // already do -- opens inside WhatsApp's own in-app browser.
        return {
          payLine: `Please pay NGN ${amountLabel} using the button below.\n\nYour order moves to preparation automatically the moment payment goes through -- no need to send proof.`,
          needsHandover: false,
          paymentUrl: url,
        };
      }
    } catch (err) {
      console.error(`Paystack initialize failed for order ${order.id}, falling back to bank details: ${err.message}`);
    }
  }
  const { rows: biz } = await pool.query('select bank_name, bank_account_number, bank_account_name from business limit 1');
  const b = biz[0] || {};
  const hasBankDetails = b.bank_name && b.bank_account_number && b.bank_account_name;
  return {
    payLine: hasBankDetails
      ? `Please pay NGN ${amountLabel}.\n\nBank: ${b.bank_name}\nAccount number: ${b.bank_account_number}\nAccount name: ${b.bank_account_name}\n\nThen send proof of payment here.`
      : `Your total is NGN ${amountLabel}. Let me get someone to confirm payment details with you.`,
    needsHandover: !hasBankDetails,
    paymentUrl: null,
  };
}

export async function sendPaymentInstructions(customer, order) {
  const { total, deliveryFee } = await summariseOrder(order);
  const invoicePath = await createInvoice(order);
  // PUBLIC_URL is this deployment's own https://<subdomain> -- without it
  // there's no real public URL to send at all (a bare relative path means
  // nothing outside a browser already on this site).
  // A link to the HTML invoice page isn't "the invoice" as far as a
  // customer's concerned -- they expect an actual file. Sent as a real
  // WhatsApp document (Gotenberg renders the same page to PDF on the fly,
  // see routes/documents.js), falling back to a text link only if that
  // send fails, so the invoice info is never just lost.
  let invoiceSent = false;
  // Chidera, 2026-09-25: "the invoice and pay now should be one chat" --
  // website's own document bubble used to be logged here, separately,
  // then a SECOND bubble carrying the actual pay line (and, when an
  // online payment link exists, its own "Pay now" cta_url button) went
  // out right after. Only the URL is captured here now; the invoice HTML
  // page itself already embeds a "Pay now" button reading the same
  // order.payment_link_url (routes/documents.js's own documentPage), so
  // one combined bubble covers both without inventing a second
  // interactive type.
  let invoiceWebsiteUrl = null;
  if (process.env.PUBLIC_URL) {
    try {
      const invoicePdfUrl = `${process.env.PUBLIC_URL}${invoicePath}/pdf`;
      if (customer.channel === 'instagram') {
        // Chidera, 2026-09-26: "on instagram the invoice is taking me to
        // facebook, it should open in the web app" -- sending the raw PDF
        // as a file attachment (sendInstagramDocument) made Instagram open
        // it in its own Facebook-branded document viewer instead. Deliberately
        // not sending anything here -- invoiceSent stays false (not set below,
        // unlike the other two branches), so the same invoiceUrl text-link
        // fallback every OTHER failed-PDF case already falls back to (a few
        // lines below) fires here too, linking straight to the plain HTML
        // invoice page instead of a PDF.
      } else if (customer.channel === 'website') {
        // website: link to the plain HTML invoice page (routes/documents.js's
        // GET /invoice/:orderId), not the /pdf route -- the customer's
        // already in a browser, so there's no reason to round-trip through
        // Gotenberg (an internal docker-only service, unreachable outside
        // the compose network) just to hand them back a page they could've
        // viewed directly. Found live, 2026-09-23: linking to /pdf here
        // marked invoiceSent=true unconditionally, without this try/catch
        // ever actually rendering anything -- the button looked fine but
        // failed the moment a customer tapped it ("the invoice link keeps
        // not opening, an invalid link").
        invoiceWebsiteUrl = `${process.env.PUBLIC_URL}${invoicePath}`;
        invoiceSent = true;
      } else {
        await sendWhatsAppDocument(recipientFor(customer), invoicePdfUrl, `invoice-${order.reference}.pdf`, `Invoice for order ${order.reference}`);
        await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel: customer.channel, sender: 'bot', body: `[invoice PDF] ${invoicePdfUrl}`, trigger: 'invoice_pdf' });
        invoiceSent = true;
      }
    } catch (err) {
      console.error(`Failed to send invoice PDF, falling back to a text link: ${err.message}`);
    }
  }
  // Invoice always comes first, on its own -- it's the compulsory receipt of
  // what's being bought, not a footnote on the payment line. Always followed
  // by bank details now -- see the note above the function.
  const invoiceUrl = process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL}${invoicePath}` : null;
  // "attached above" is only true for WhatsApp/Instagram (a genuinely
  // separate, earlier real document send there) -- on website it's the
  // SAME bubble, and the document/interactive part always renders BELOW
  // the body text (renderMessage's own body-then-actions order). Same fix
  // as completePayment's own receiptLine, see its comment.
  const invoiceLine = invoiceSent
    ? customer.channel === 'website'
      ? `Your invoice is attached below.`
      : `Your invoice is attached above.`
    : invoiceUrl
      ? `Here's your invoice: ${invoiceUrl}`
      : `Your invoice for this order is ready.`;
  // Silent up until now -- the customer only agreed to the items total
  // earlier in "confirm order" (delivery fee wasn't known yet then). Stated
  // here so the amount they're about to pay never comes as a surprise.
  const deliveryFeeLine = deliveryFee > 0 ? ` (includes NGN ${deliveryFee} delivery fee)` : '';
  // Structured, one fact per line -- same reasoning as the item-by-item
  // price confirmation (Chidera's earlier call: "structured line by line
  // way not paragraph"), now for the bank details too. Chidera 2026-09-11:
  // "that message that comes before invoice should stop showing in a
  // paragraph form and show in a structured manner." A bank name, account
  // number, and account name run together in one comma sentence is
  // exactly the kind of thing that's easy to misread or fat-finger
  // copying out -- each on its own line reads the way a real transfer
  // slip would.
  const { payLine, needsHandover, paymentUrl, posChoice } = await buildPayLine(order, customer, { amount: total, amountLabel: `${total}${deliveryFeeLine}` });
  if (customer.channel === 'website' && invoiceWebsiteUrl) {
    // Chidera, 2026-09-25: "when i said invoice and pay now in same chat i
    // meant itll have 2 buttons not just the pay now in the invoice" --
    // a real, separate "Pay now" button right on this bubble (not only
    // the invoice page's own embedded one) whenever there's an actual
    // online payment link to pay with. POS (Transfer/Card) has no single
    // paymentUrl to attach here -- it keeps its own separate choice
    // message right after, same as before.
    await logMessage({
      customerId: customer.id,
      tableSessionId: customer.tableSessionId,
      direction: 'outbound',
      channel: customer.channel,
      sender: 'bot',
      body: posChoice ? invoiceLine : `${invoiceLine}\n\n${payLine}`,
      trigger: 'invoice_pdf',
      interactive: {
        type: 'document',
        filename: `invoice-${order.reference}`,
        url: invoiceWebsiteUrl,
        ...(paymentUrl && !posChoice ? { payUrl: paymentUrl, payLabel: 'Pay now' } : {}),
      },
    });
    if (posChoice) await sendPosPaymentChoice(customer, order);
  } else if (posChoice) {
    // A CTA-URL button (paymentUrl) or plain text can carry the invoice
    // line inline, but a Transfer/Card choice needs its own real WhatsApp
    // buttons message -- sent separately, same multi-message shape the
    // invoice PDF + payment link already use today.
    await reply(customer, invoiceLine);
    await sendPosPaymentChoice(customer, order);
  } else if (paymentUrl) {
    await sendPaymentLinkButton(customer, paymentUrl, `${invoiceLine}\n\n${payLine}`);
  } else {
    await reply(customer, `${invoiceLine}\n\n${payLine}`);
  }
  // ackText false -- payLine already told them someone will confirm payment
  // details (see above), same double-ack bug as the others fixed 2026-09-03.
  if (needsHandover) await handover(customer, 'Order ready for payment but no payment method is configured for this business yet', null, false);
}

// Chidera, 2026-09-24: "if a staff make paid with cash and put amount the
// bot would send a link for transfer of outstanding balance na" -- a real
// gap: cash_collected used to be purely a recorded number, nothing ever
// compared it against the order total or told the customer anything.
// Scoped to just the shortfall, not sendPaymentInstructions' whole flow --
// no second invoice send (the table's already been served and invoiced),
// just the amount still owed. Reuses buildPayLine, the same place every
// other payment link in this file goes through, so whichever provider
// this business has configured (Monnify/OPay/Paystack/bank-details/POS)
// just works here too, automatically.
export async function sendOutstandingBalanceLink(customer, order, amount) {
  const { payLine, needsHandover, paymentUrl, posChoice } = await buildPayLine(order, customer, { amount, amountLabel: `${amount}` });
  const intro = `You paid NGN ${Number(order.cash_collected || 0).toLocaleString()} in cash for order ${order.reference} -- there's still NGN ${amount} left to pay.`;
  if (posChoice) {
    await reply(customer, intro);
    await sendPosPaymentChoice(customer, order);
    return;
  }
  if (paymentUrl) {
    await sendPaymentLinkButton(customer, paymentUrl, `${intro}\n\n${payLine}`);
  } else {
    await reply(customer, `${intro}\n\n${payLine}`);
  }
  if (needsHandover) await handover(customer, 'Dine-in table has an outstanding cash balance but no payment method is configured for this business yet', null, false);
}

// A customer nudging the bot while still unpaid ("where's the link", "resend
// it") used to get a hardcoded "use the link I sent above" no matter what
// was actually sent, or if nothing usable ever was -- a real lie if it was
// bank details, or a handover. Re-states whatever is ACTUALLY true right
// now instead of assuming a link exists -- but only the FIRST time. After
// that, repeated nudges get a short acknowledgment, never the full reminder
// again -- five identical reminders in a row is worse than none.
export async function handleWaitingOnPayment(customer, order, text) {
  const answer = await answerOrThenShowMenu(customer, order, text, `Payment is still pending, bank transfer only.`);
  if (answer) {
    await reply(customer, answer, 'order_question_answer');
    return;
  }

  // Proof already sent -- Chidera 2026-09-11: "why did bot tell me to pay
  // again after i sent okay, when ive already send receipt of payment."
  // engine_state stays 'confirm_payment' the whole time proof is under
  // review (only handleInboundMedia's own insert moves payment_status to
  // 'proof_submitted', see flow.js's payment-proof handler), so a plain ack
  // ("okay", "alright") landing here before staff confirm it used to fall
  // straight into the reminder below and re-quote the bank details -- reads
  // as ignoring the receipt they just sent. Checked ahead of the reminder
  // logic below, not folded into it, since this should say the same thing
  // every single time, not just once.
  if (order.payment_status === 'proof_submitted') {
    await reply(customer, `Still confirming your payment, I'll let you know shortly.`, 'payment_wait_ack');
    return;
  }

  if (order.payment_reminder_sent_at) {
    await reply(customer, `Still waiting on your payment, I'll confirm as soon as it comes through.`, 'payment_wait_ack');
    return;
  }
  await sendPaymentReminder(customer, order);
}

// Extracted from handleWaitingOnPayment above -- the actual "here's how to
// pay, again" send, shared with sweepAbandonedWebChatOrders in sweeps.js
// (the abandonment nudge, Phase 2 of the web-chat feature). Caller's job
// to check order.payment_reminder_sent_at first: handleWaitingOnPayment
// only gets here once, right after its own check; the sweep's own SQL
// query already filters to payment_reminder_sent_at is null, so it's
// never re-checked here -- one source of truth for "has this order's ONE
// reminder already gone out," never two competing guards.
export async function sendPaymentReminder(customer, order) {
  await pool.query(`update "order" set payment_reminder_sent_at = now() where id = $1`, [order.id]);

  // Same buildPayLine as sendPaymentInstructions -- this is the same
  // underlying fact (how to pay), just on a repeat reminder, so it must
  // never say something different (a stale bank-transfer reminder after
  // the business switched to Paystack would be a real lie).
  const { payLine, needsHandover, paymentUrl } = await buildPayLine(order, customer, { amount: order.total, amountLabel: order.total });
  if (paymentUrl) {
    await sendPaymentLinkButton(customer, paymentUrl, payLine);
  } else {
    await reply(customer, payLine, 'payment_reminder');
  }
  if (needsHandover) await handover(customer, 'Customer waiting on payment but no payment link/bank details are available', null, false);
}

// Called from the Paystack webhook once a TOP-UP is verified (see
// completePayment just below for the main-order equivalent) -- Chidera,
// 2026-09-20: "totally stop sending account number... use just paystack."
// Deliberately does NOT touch the order's own status/engine_state -- the
// order itself is already fully paid and moving through its own
// lifecycle; a topup is just extra money for items already added
// (applyOrderModifications already inserted them regardless of payment).
export async function completeTopupPayment(topupId) {
  const { rows } = await pool.query('select * from order_topup where id = $1', [topupId]);
  const topup = rows[0];
  if (!topup || topup.payment_status === 'confirmed') return;
  await pool.query(`update order_topup set payment_status = 'confirmed' where id = $1`, [topupId]);

  const { rows: orderRows } = await pool.query('select * from "order" where id = $1', [topup.order_id]);
  const order = orderRows[0];
  if (!order) return;
  const { rows: custRows } = await pool.query('select * from customers where id = $1', [order.customer_id]);
  const customer = custRows[0];
  if (customer) await reply(customer, `Payment received for your top-up on order ${order.reference} -- thank you!`);

  const orderRecipients = await orderAlertRecipients();
  if (orderRecipients.length) {
    const itemLines = (topup.items || []).map((i) => `${i.quantity}x ${i.name}`).join(', ');
    const alertText = `Top-up payment confirmed on order ${order.reference}: ${itemLines} (NGN ${topup.amount}).`;
    for (const { phoneNumber: to, staffId } of orderRecipients) await notifyStaff({ staffId, phoneNumber: to, title: 'Top-up paid', body: alertText });
  }
}

// Chidera, 2026-09-25: "after payment is confirmed instead of the bare
// payment received, send customer a receipt, but receipt shouldnt look
// like invoice it is a receipt" -- a real RECEIPT (routes/documents.js's
// own receiptPage, deliberately not the invoice template with a different
// title -- see its own comment) sent as a WhatsApp document, same
// resilient send-then-fallback-to-a-link shape sendPaymentInstructions
// already uses for the invoice. Extracted out of completePayment
// (2026-09-25, "hope dine in has receipt too and the receipt has back to
// chat") so routes/api.js's own dine-in "Mark paid" route can send the
// exact same real receipt -- dine-in settles in person, so its own
// payment never went through completePayment at all (payment_status never
// reaches 'confirmed'/'accepted' there -- see completePayment's own
// comment on this), and had no receipt of any kind until now.
// followUpText -- whatever operational info belongs right after the
// receipt line, in the SAME message/bubble (delivery status, pickup
// instructions, or dine-in's own thank-you) -- always starts with its own
// leading space, so callers with nothing to add can just pass ''.
export async function sendReceiptMessage(customer, order, followUpText = '') {
  const receiptPath = await createReceipt(order);
  let receiptSent = false;
  // Chidera, 2026-09-25: "the receipt and the your receipt is attached
  // should be in one chat" -- website's own document bubble used to be
  // logged separately, then a SECOND bubble with the actual follow-up
  // text went out right after. Only the URL is captured here now; the
  // real combined send (text + document, one bubble) happens below once
  // the full body text is known.
  let receiptWebsiteUrl = null;
  if (process.env.PUBLIC_URL) {
    try {
      // Found live, 2026-09-25: this whole block predates the website
      // channel (main-only, never touched by the web-chat merge) and had
      // no website branch at all -- customer.channel === 'website' fell
      // straight into the `else` below, sending a REAL WhatsApp document
      // to a customer who should have gotten a free chat bubble.
      if (customer.channel === 'website') {
        // website: same fix as sendPaymentInstructions' own invoice branch
        // -- link to the plain HTML receipt page, not /pdf (Gotenberg-
        // backed, internal-only).
        receiptWebsiteUrl = `${process.env.PUBLIC_URL}${receiptPath}`;
        receiptSent = true;
      } else if (customer.channel === 'instagram') {
        // Chidera, 2026-09-26: "receipt too is taking me to facebook" --
        // same root cause and fix as sendPaymentInstructions' own invoice
        // branch above: sendInstagramDocument opened the PDF through
        // Instagram's own Facebook-branded document viewer. Deliberately
        // not sending anything here -- receiptSent stays false, so the
        // receiptUrl text-link fallback below links to the plain HTML
        // receipt page instead of a PDF.
      } else {
        const receiptPdfUrl = `${process.env.PUBLIC_URL}${receiptPath}/pdf`;
        await sendWhatsAppDocument(recipientFor(customer), receiptPdfUrl, `receipt-${order.reference}.pdf`, `Receipt for order ${order.reference}`);
        await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel: customer.channel, sender: 'bot', body: `[receipt PDF] ${receiptPdfUrl}`, trigger: 'receipt_pdf' });
        receiptSent = true;
      }
    } catch (err) {
      console.error(`Failed to send receipt PDF, falling back to a text link: ${err.message}`);
    }
  }
  const receiptUrl = process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL}${receiptPath}` : null;
  // Chidera, 2026-09-25: "the receipt text also didnt have the your
  // payment has been received, your receipt is attached here it just
  // went straight to your receipt is attached above, the receipt is
  // below sef." Two real gaps: (1) the explicit "payment received"
  // confirmation was dropped entirely once the receipt document itself
  // became the opener; (2) "attached above" was only ever true for
  // WhatsApp/Instagram (the document is a genuinely separate, earlier
  // real send there) -- on website it's the SAME bubble, and the
  // document/interactive part of a bubble always renders BELOW the body
  // text (renderMessage's own body-then-actions order), so "above" was
  // just wrong there.
  const receiptLine = receiptSent
    ? customer.channel === 'website'
      ? 'Your payment has been received. Your receipt is attached below.'
      : 'Your payment has been received. Your receipt is attached above.'
    : receiptUrl
      ? `Your payment has been received. Here's your receipt: ${receiptUrl}`
      : 'Your payment has been received.';
  const bodyText = `${receiptLine}${followUpText}`;

  // One bubble, not two -- see this function's own comment above. Every
  // other website reply already goes through reply() (real WhatsApp send
  // for every other channel, a no-op websocket-free bubble for website),
  // which has no `interactive` param; this bypasses it only for website,
  // straight to logMessage, so the document reference and the real
  // follow-up text land in the SAME row.
  if (customer.channel === 'website' && receiptWebsiteUrl) {
    await logMessage({
      customerId: customer.id,
      tableSessionId: customer.tableSessionId,
      direction: 'outbound',
      channel: customer.channel,
      sender: 'bot',
      body: bodyText,
      trigger: 'payment_confirmed',
      interactive: { type: 'document', filename: `receipt-${order.reference}`, url: receiptWebsiteUrl },
    });
    return;
  }
  await reply(customer, bodyText, 'payment_confirmed');
}

// Called from the Paystack webhook once a payment is verified -- not part
// of handleInboundMessage's request/reply loop, since payment confirmation
// arrives from Paystack, not from the customer's next WhatsApp message.
export async function completePayment(orderId) {
  const { rows } = await pool.query('select * from "order" where id = $1', [orderId]);
  const order = rows[0];
  if (!order || order.engine_state !== 'confirm_payment') return;

  const { rows: custRows } = await pool.query('select * from customers where id = $1', [order.customer_id]);
  const customer = custRows[0];
  // No live request/customer object to flip here -- this fires from
  // Paystack's webhook, staff's "Confirm payment" click, or Moniepoint's
  // auto-match, none of which have one. web_chat_active_at (touched on
  // every request into routes/web-chat.js) is the persisted breadcrumb: if
  // this customer's most recent turn was on the web-chat page recently,
  // the payment-confirmed message becomes a bubble there instead of a real
  // WhatsApp send. customers.channel itself is never touched -- a fresh
  // WhatsApp text days later must still start the normal WhatsApp flow.
  if (customer && customer.web_chat_active_at && new Date(customer.web_chat_active_at) > new Date(Date.now() - 30 * 60 * 1000)) {
    customer.channel = 'website';
  }

  await transitionOrder(order, 'payment_acceptance');
  // This function IS "payment confirmed" -- whether that's Paystack's own
  // webhook (cryptographically verified, nothing left for a person to
  // check) or staff's own "Confirm payment received" click after looking
  // at a submitted proof. Either way, the kanban `status` jumps straight
  // to 'preparation' here, never sitting in 'confirmation' a moment
  // longer than it takes to actually confirm it (Chidera's own words:
  // "when receipt is confirmed immediately take them to preparing").
  // Fulfilment progress past this (ready, in_transit, completed) is
  // staff's own call as they physically prepare/dispatch it, not
  // something the bot decides -- payment succeeding is not the same fact
  // as food being ready.
  // Chidera, 2026-09-24: "the today dashboard is not really calculating
  // collected" -- real bug, found tracing it: this function (every
  // AUTOMATED payment webhook -- Paystack, Monnify, OPay, Moniepoint POS --
  // routes here) has been "the moment payment is confirmed" since it was
  // written (see this function's own comment above), but never actually
  // set payment_status on the order itself. Only the STAFF-facing manual
  // "Confirm payment received" click (routes/api.js) ever did. Every real,
  // automated payment was moving the order forward correctly (kanban,
  // delivery, customer message) while silently leaving payment_status at
  // its original pending value -- so /orders/stats/today's own "collected"
  // sum (which filters on payment_status in ('confirmed','accepted'))
  // never counted a single automated payment, only manually-confirmed
  // proof-of-payment orders. Same value ('confirmed') the manual path uses.
  await pool.query(`update "order" set status = 'preparation', payment_status = 'confirmed' where id = $1`, [order.id]);
  await transitionOrder(order, 'fulfilment');

  // Chidera, 2026-09-25: "after payment is confirmed instead of the bare
  // payment received, send customer a receipt, but receipt shouldnt look
  // like invoice it is a receipt" -- see sendReceiptMessage's own comment
  // for the real send/one-bubble/wording details, extracted out so
  // routes/api.js's own dine-in "Mark paid" route (which never went
  // through completePayment at all -- dine-in settles in person, its own
  // payment_status never reaches 'confirmed'/'accepted') can send the
  // exact same real receipt too.
  if (order.fulfilment_type === 'delivery') {
    const delivery = await createDelivery(order, customer);
    const riderLine = delivery.riderName ? ` Your rider is ${delivery.riderName}.` : '';
    // Chowdeck doesn't name a rider at booking time (one isn't assigned
    // yet) -- riderLine above will stay empty for a real Chowdeck delivery,
    // but the tracking link is available immediately and is the thing
    // actually worth sending.
    const trackingLine = delivery.trackingUrl ? ` Track it here: ${delivery.trackingUrl}` : '';
    // Chidera, 2026-09-24: "let the webchat notification of received pop
    // as a banner so customer can know their payment has been confirmed
    // cause sometimes paystack leaves it loading there." A distinct
    // trigger (not the generic bot_flow_step default) so the chat page's
    // own poll() can recognise THIS specific message and show a banner,
    // not just a bubble easy to miss while they're still tabbed over to
    // Paystack's own checkout.
    await sendReceiptMessage(customer, order, ` Your order is being prepared for delivery.${riderLine}${trackingLine}`);
  } else {
    const { rows: bizRows } = await pool.query('select address, phone_number from business limit 1');
    const biz = bizRows[0] || {};
    const branchRows = order.branch_id ? (await pool.query('select address, phone_number from branch where id = $1', [order.branch_id])).rows : [];
    const b = branchRows[0] || {};
    await sendReceiptMessage(
      customer,
      order,
      ` I'll let you know when to pick up your order. You'll pick up at ${b.address || biz.address || 'our location'} and call ${b.phone_number || biz.phone_number || 'us'} when you arrive.`
    );
  }

  // Deliberately NOT transitioning to 'completed' here -- payment clearing
  // is not the same fact as the order actually being done. Staying at
  // 'fulfilment' keeps the order open (see getOpenOrder) so a customer can
  // still message in to add something while it's being prepared/delivered.
  // Staff marking it completed on the dashboard (routes/api.js) is what
  // actually closes it.

  // Chidera, 2026-09-23: "after they name payment let feedback pop so they
  // remain on page" -- sendFeedbackRequest's own 3 completion sites
  // (dine-in payment, delivery release, pickup release) all fire well
  // after this moment, by which point an online customer has near-always
  // left the chat page (web_chat_active_at gone stale) and it goes out as
  // a real WhatsApp/Instagram send instead of a free bubble. Firing it
  // here too, right alongside the payment-confirmed message itself while
  // they're still looking at the page, catches it while free. Safe to
  // just add, not move -- sendFeedbackRequest's own order_feedback
  // (order_id) on-conflict-do-nothing guard means whichever call reaches
  // it first wins and every later one is a silent no-op, so this can
  // never double-send once fulfilment actually completes too.
  sendFeedbackRequest(order.id).catch((err) => console.error('sendFeedbackRequest failed:', err.message));

  // Chidera, 2026-09-16: "a staff number should be able to get a confirmed
  // order after paystack has automatically confirmed payment on their
  // whatsapp without accessing the back end... the open link will just
  // show the kanban so they can click the ready button."
  // Chidera, 2026-09-24: "turn handover messages to 1 text not 2 different,
  // but the button and text together and same with the ones stating what
  // the customer ordered" -- this was the alert text and the board-link
  // button as two separate WhatsApp sends (two billable messages), same
  // shape handover() itself had before its own 2026-09-24 merge just above.
  // Same fix here: one cta_url message carries the alert as its body AND
  // the button, when a link is even possible.
  const orderRecipients = await orderAlertRecipients();
  if (orderRecipients.length) {
    // Chidera, 2026-09-16: "when reporting to staff what to prepare, make
    // it structured not like a paragraph" -- was using summariseOrder's
    // `lines` (a single comma-run paragraph, its own comment says so
    // explicitly), not `itemLines` (one item per line), which the
    // customer-facing confirm message already switched to 2026-09-10 for
    // the exact same reason. Staff reading what to prepare deserves the
    // same structured format, not a regression back to the paragraph.
    const { itemLines, total } = await summariseOrder(order);
    // Chidera, 2026-09-25: "on the handover whatsapp text to inform on what
    // has been paid and placed, if its delivery let the delivery area and
    // address also be in the text" -- staff reading this to prep/dispatch
    // shouldn't have to open the dashboard just to find out where it's
    // going. Area only applies to own_riders (delivery_zone_id is null for
    // Chowdeck/manual -- see its own schema comment); address always comes
    // from customer.address, the same field createDelivery already reads.
    let deliveryLines = '';
    if (order.fulfilment_type === 'delivery') {
      const zoneRows = order.delivery_zone_id ? (await pool.query('select name from delivery_zone where id = $1', [order.delivery_zone_id])).rows : [];
      const zoneName = zoneRows[0]?.name;
      const lines = [];
      if (zoneName) lines.push(`Area: ${zoneName}`);
      if (customer.address) lines.push(`Address: ${customer.address}`);
      if (lines.length) deliveryLines = `\n${lines.join('\n')}`;
    }
    const alertText = `Payment confirmed, ready to prepare: ${displayNameFor(customer)} (${order.fulfilment_type || 'pickup'})${deliveryLines}\n${itemLines.join('\n')}\nTotal: NGN ${total}`;
    const credentials = await getWhatsAppCredentials(order.branch_id);
    for (const { phoneNumber: to, staffId } of orderRecipients) {
      // Chidera, 2026-09-17: "the link is meant to open the specific
      // kanban inside for that order not the pipeline surface" -- still
      // the board itself, not a detail page (her own earlier call: "the
      // kanban not the conversation... the ready button" lives on the
      // board's own card), just landing scrolled to and highlighting
      // THIS order's card instead of the customer having to hunt for it
      // among everything else in the pipeline. Orders.jsx reads ?order=.
      const link = process.env.PUBLIC_URL && staffId ? `${process.env.PUBLIC_URL}/api/auth/magic/${await createMagicLink(staffId, `/?order=${order.id}`)}` : null;
      await notifyStaff({ staffId, phoneNumber: to, title: 'Order ready to prepare', body: alertText, linkUrl: link, linkButtonText: 'Open Orders', credentials });
    }
  }
}

// Chidera, 2026-09-21: "THE IDEA IS FOR IT TO APROVE AUTO CONFIRME HOW
// PAYSTACK DOES" -- checks Moniepoint directly, right now, using this
// exact payment's own reference (the same one pushPaymentRequest
// registered it under). Confirmed live: actualAmount stays null the
// whole time a request is pending or expired, and only gets a real value
// once a matching transfer has actually cleared -- checking for that,
// not a specific status string, since the exact "it's paid" wording was
// never actually observed live (the one real test transfer arrived after
// its request had already expired).
export async function checkMoniepointPaymentPaid(payment) {
  if (!payment?.reference) return false;
  const tx = await lookupTransactionByReference(payment.reference).catch((err) => {
    console.error('Moniepoint payment status check failed:', err.message);
    return null;
  });
  if (!tx || tx.actualAmount == null) return false;
  // A non-null actualAmount only means SOME transfer cleared against this
  // reference, not that it covers what's owed -- a short transfer (bank
  // fee, mistyped amount) must not be reported as paid. Compare in kobo,
  // same minor-unit convention as pushPaymentRequest's own amountKobo and
  // webhook-moniepoint.js's amount handling. >= rather than strict
  // equality so a genuine overpayment still counts as paid.
  const expectedKobo = Math.round(Number(payment.amount) * 100);
  return Number(tx.actualAmount) >= expectedKobo;
}

// Chidera, 2026-09-21: "THE IDEA IS FOR IT TO APROVE AUTO CONFIRME HOW
// PAYSTACK DOES" -- a real, ONE-TIME Moniepoint account generated just for
// this one payment (pushPaymentRequest, POST /v1/transactions, keyed by
// this row's own `reference`), confirmed live -- and, since confirmed
// live, the ONLY account Moniepoint will ever actually track against our
// reference (an ordinary transfer straight to the business's regular
// static account is never even seen as a "POS transaction" on their
// side, so it can never be auto-confirmed by any mechanism, webhook or
// lookup -- tried quoting the static account here for exactly one real
// session, confirmed dead end). Also still fixes the original "tie"
// problem (two pending payments at the same amount, same static account)
// for good, since every payment now gets its own real account.
//
// Reused for DYNAMIC_ACCOUNT_TTL_MS (4 minutes -- a little short of
// Moniepoint's own confirmed ~5-minute expiry) rather than pushed fresh
// on every page load -- a fresh push also re-flashes the physical
// terminal's own screen (confirmed live, unavoidable -- Chidera: "dont
// worry build it"), no reason to do that more than once per payment.
//
// dynamic_account_ready_at (READY_DELAY_MS, 60s): real live report,
// 2026-09-21 -- paying a freshly generated account IMMEDIATELY failed
// with "Recipient KYC registration is incomplete" (a real bank-side
// rejection); a separate account, paid several minutes after being
// generated, went through fine. Consistent with the short NIBSS
// propagation delay new virtual accounts commonly need before every
// bank's own Name Enquiry recognizes them -- the pay page now hides the
// account number behind a short "preparing" countdown until this
// timestamp, instead of ever letting a customer try to pay it too soon.
//
// Returns null when no terminal_serial is configured (pos_sync_config)
// or the push fails for any reason -- callers fall straight back to the
// existing static-account behaviour unchanged, never a broken pay page.
const DYNAMIC_ACCOUNT_TTL_MS = 4 * 60 * 1000;
const READY_DELAY_MS = 60 * 1000;

export async function ensureDynamicPosAccount(payment) {
  if (payment.dynamic_account_number && payment.dynamic_account_expires_at && new Date(payment.dynamic_account_expires_at) > new Date()) {
    return {
      accountNumber: payment.dynamic_account_number,
      accountName: payment.dynamic_account_name,
      expiresAt: payment.dynamic_account_expires_at,
      readyAt: payment.dynamic_account_ready_at,
    };
  }
  try {
    const { rows } = await pool.query(`select terminal_serial from pos_sync_config where enabled = true and terminal_serial is not null limit 1`);
    const terminalSerial = rows[0]?.terminal_serial;
    if (!terminalSerial) return null;

    const amountKobo = Math.round(Number(payment.amount) * 100);
    await pushPaymentRequest({ terminalSerial, amountKobo, merchantReference: payment.reference });
    const tx = await lookupTransactionByReference(payment.reference);
    if (!tx?.accountNumber) return null;

    const expiresAt = new Date(Date.now() + DYNAMIC_ACCOUNT_TTL_MS);
    const readyAt = new Date(Date.now() + READY_DELAY_MS);
    await pool.query(
      `update order_payment set dynamic_account_number = $1, dynamic_account_name = $2, dynamic_account_expires_at = $3, dynamic_account_ready_at = $4 where id = $5`,
      [tx.accountNumber, tx.accountName, expiresAt, readyAt, payment.id]
    );
    payment.dynamic_account_number = tx.accountNumber;
    payment.dynamic_account_name = tx.accountName;
    payment.dynamic_account_expires_at = expiresAt;
    payment.dynamic_account_ready_at = readyAt;
    return { accountNumber: tx.accountNumber, accountName: tx.accountName, expiresAt, readyAt };
  } catch (err) {
    console.error('ensureDynamicPosAccount failed, falling back to the static account:', err.message);
    return null;
  }
}

// Chidera, 2026-09-21: "I SENT MONEY NO PLACE FOR CUSTOMER TO TAP I SENT
// THE MONEY FOR BOT TO AUTO CONFIRM" -- the pay page's own "I've sent it"
// button. Checks Moniepoint directly first (checkMoniepointPaymentPaid) --
// if it already shows paid, confirms instantly (confirmOrderPayment's own
// existing customer-facing messaging, e.g. completePayment's "Payment
// received...", handles telling them, same as a real webhook match
// would). Only falls back to alerting staff when Moniepoint doesn't show
// it yet -- a real transfer can still land after this (a request expires
// ~5 minutes after creation, confirmed live, and a late transfer still
// reaches the real account safely, also confirmed live with real money --
// see order_payment's own schema comment) -- so this NEVER tells a
// customer their payment failed, only "not yet" for a person to check.
export async function notifyCustomerClaimedPosPayment(payment, order, customer) {
  if (payment && payment.status === 'pending' && (await checkMoniepointPaymentPaid(payment))) {
    await confirmOrderPayment(payment.id);
    return;
  }

  const amount = payment ? Number(payment.amount) : Number(order.total);
  const reason = `Customer says they've sent a POS transfer (NGN ${amount.toLocaleString()}) but it hasn't auto-confirmed yet`;
  await pool.query(`update customers set handled_by = 'staff', handover_at = now(), handover_reason = $1 where id = $2`, [reason, customer.id]);
  await reply(customer, `Noted, I'll confirm your transfer and get back to you here shortly.`, 'handover_ack');

  const recipients = await handoverRecipients();
  if (!recipients.length) return;

  // Chidera, 2026-09-21: "WHY IS DINE IN HANDOVER TAKING ME OUT OF
  // WHATSAPP TO SHOW ME INVOICE?" -- a plain-text URL in the alert body
  // is exactly the bug already fixed once for handover()'s own primary
  // link (2026-09-03 comment above) -- WhatsApp auto-linkifies it to open
  // the device's own external browser, not its in-app one. Dropped
  // entirely, not converted to a second CTA button (WhatsApp only allows
  // one per message) -- the "Confirm payment" button below already lands
  // staff on the order page, which shows the same invoice/items and any
  // payment-proof images inline (OrderDetail.jsx's own paymentProofs).
  //
  // "LET INVOICE HANDOVER FOR DINE IN GROUP PAYMENT BASED ON HOW PARTIES
  // AGREED TO MAKE THE PAYMENT...SO STAFF WONT SEE TO CHECK FOR A SMALL
  // AMOUNT IN A LARGE INVOICE AND BE WONDERING HOW" -- a split/joint
  // dine-in payment can genuinely be a small slice of a much bigger table
  // total (payStatusPayload's own coversLabel logic, dinein-menu.js) --
  // without saying what this specific amount actually covers, staff
  // seeing e.g. "NGN 1200" claimed against a "NGN 4700" order have no way
  // to tell if that's right or a mistake.
  let coverageNote = '';
  if (payment && order.channel === 'dinein') {
    if (payment.covers_item_ids === null) {
      coverageNote = ` This covers the whole table (order total NGN ${Number(order.total).toLocaleString()}).`;
    } else {
      const { rows: coveredItems } = await pool.query(
        `select p.name, oi.quantity from order_item oi join product p on p.id = oi.product_id where oi.id = any($1::uuid[])`,
        [payment.covers_item_ids]
      );
      const itemsLabel = coveredItems.map((i) => (i.quantity > 1 ? `${i.quantity}x ${i.name}` : i.name)).join(', ') || 'part of the order';
      coverageNote = ` This is just for their own share (${itemsLabel}), not the whole table. The table's full order comes to NGN ${Number(order.total).toLocaleString()}.`;
    }
  }
  const credentials = await getWhatsAppCredentials(customer.branch_id);
  for (const { phoneNumber: to, staffId } of recipients) {
    const alert = `${displayNameFor(customer)} says they sent a POS transfer of NGN ${amount.toLocaleString()} but it hasn't auto-confirmed yet.${coverageNote}`;
    const path = `/orders/${order.id}`;
    const link = !process.env.PUBLIC_URL
      ? null
      : staffId
        ? `${process.env.PUBLIC_URL}/api/auth/magic/${await createMagicLink(staffId, path)}`
        : `${process.env.PUBLIC_URL}${path}`;
    await notifyStaff({ staffId, phoneNumber: to, title: 'POS transfer claimed', body: alert, linkUrl: link, linkButtonText: 'Confirm payment', credentials });
  }
}
