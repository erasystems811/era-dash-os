// The greeting/knowledge-base/complaint-intake layer -- split out of
// flow.js 2026-10-01 as the fifth phase of breaking up that file's 6800+
// lines into focused pieces (see sweeps.js, voice-turn.js, dinein.js,
// staff.js for the first four). needsChatRedirect/markChatRedirectSent/
// sendChatRedirectPing/handleClosedHoursMessage/branchHoursFor stay in
// flow.js even though this file uses some of them -- they're cross-
// cutting infrastructure used by dispatch, the top-level entry points,
// and dinein.js/staff.js too, not greeting-specific. flow.js re-exports
// every name below so no existing import site has to change, and imports
// back buildGreetingContent/handleGreeting/greetingAckFor/isPureGreeting/
// handleEnquiry/sendComplaintLink for its own internal use (dispatch,
// sendStartOrderLink).
import { pool } from '../lib/db.js';
import { resolveMenu, branchOptions } from './fields.js';
import { askText } from './claude.js';
import { getWhatsAppCredentials } from './branch-channel.js';
import { sendWhatsAppCtaUrl } from './whatsapp-send.js';
import {
  findSpecialsCategory,
  reply,
  ensureMenuToken,
  recipientFor,
  logMessage,
  sendChatRedirectPing,
  needsChatRedirect,
  markChatRedirectSent,
  sendStartOrderLink,
  handover,
  resolveGeneralAvailability,
  looksLikeBrowseQuestion,
} from './flow.js';

async function countConsecutiveKbMisses(customerId) {
  const { rows } = await pool.query(
    `select trigger from message where customer_id = $1 and direction = 'outbound' order by created_at desc limit 1`,
    [customerId]
  );
  return rows[0]?.trigger === 'kb_miss' ? 1 : 0;
}

const NO_KB_MATCH = 'NO_KB_MATCH';

// Shared by every place that needs to answer a real question from real
// data -- the knowledge base, the menu, and business/branch facts. One
// source of truth for this context, not a separate hand-copied version per
// caller (answerOrderQuestion used to have its own smaller copy with just
// the menu, missing the knowledge base and business facts entirely -- which
// is exactly why "when do you close?" got "let me check with the team"
// instead of the real "24/7" answer already sitting in the knowledge base).
export async function buildBusinessKnowledgeContext(branchId) {
  const { rows: kb } = await pool.query('select question, answer from knowledge_base order by position');
  const products = await resolveMenu(branchId);
  const { rows: bizRows } = await pool.query('select address, operating_hours from business limit 1');
  const business = bizRows[0] || {};
  const branches = await branchOptions();

  const menuContext = products.length
    ? `Current menu/catalogue (only these items are available right now):\n${products.map((p) => `${p.name}${p.description ? ` (${p.description})` : ''} -- NGN ${p.price}`).join('\n')}`
    : 'The menu/catalogue is currently empty.';
  const kbContext = kb.length ? kb.map((q) => `Q: ${q.question}\nA: ${q.answer}`).join('\n\n') : '';
  // Giving the model the real location fact(s) (and stating plainly how
  // many there are) closes the exact gap that was causing it to invent
  // branches out of nowhere when asked "how many locations" -- an empty
  // context left a vacuum for it to fill with a plausible-sounding guess;
  // a concrete fact leaves nothing to guess.
  const businessContext =
    branches.length > 1
      ? `This business has ${branches.length} branches, no others:\n${branches.map((b) => `${b.name}: ${b.address}`).join('\n')}`
      : `This business has exactly one location, no other branches:\nAddress: ${branches[0]?.address || business.address || 'not on file'}\nOperating hours: ${business.operating_hours || 'not on file'}`;

  return { businessContext, menuContext, kbContext };
}

async function answerFromKnowledgeBase(message) {
  const { businessContext, menuContext, kbContext } = await buildBusinessKnowledgeContext();

  const system = `You are a strict lookup, not a conversationalist. Your only source of truth is the DATA block at the end of this prompt. You have no other knowledge about this business, its history, its facilities, or anything about it beyond what's printed in DATA -- treat yourself as knowing literally nothing else, the way a brand-new hire reading only this sheet would. Do not use general assumptions about what a typical business like this "usually" has (multiple locations, certain hours, certain policies) -- assume nothing beyond DATA.\n\nRule: if the customer's question is about a fact that is not written in DATA word-for-word or as a clear paraphrase of it, that is a miss. A miss means: reply with exactly this one word and nothing else: ${NO_KB_MATCH}. Silence on a topic in DATA always means "not covered", never "safe to guess." This applies to every kind of fact equally -- physical addresses, number of locations, opening hours, delivery areas, policies -- there is no topic where guessing a plausible-sounding answer is acceptable.\n\nException: a direct, unambiguous logical consequence of a stated fact is not a guess, and IS answerable -- e.g. "open 24/7" directly means "never closes", so "when do you close?" has a real answer (we don't close) even though the word "close" isn't in DATA. The menu/catalogue listed is stated as the FULL, exhaustive list of what's available right now -- so asked about any item NOT on it ("is there white rice?", "do you have suya sauce?"), the direct answer is a short "no, we don't have that" (that clause only -- do NOT also name what's actually available, a real, always-current menu with photos and prices is shown separately as a button right after, that's what covers "here's what we do have," never write that part out yourself), not a miss -- absence from an exhaustive list is itself the answer, not an unknown. Only treat something as a genuine miss if DATA doesn't address the topic at all, not merely because the question is phrased differently from how DATA states it.\n\nSame rule for an unclear question: do not write your own clarifying question, and never describe what topics you're able to help with or list examples of what you can answer -- that is not this business's voice, a staff member doesn't announce their own job description. Just output ${NO_KB_MATCH}.\n\nNever write out more than one or two item names in a row yourself, for any reason -- a menu can be large, and a real always-current menu with photos and prices is always shown separately as a button (see ISGENERALAVAILABILITY below) whenever the full list matters. If they ask specifically about the price of a particular item ("how much is X", "is it 1500?"), answer that directly with the real number instead.\n\nSeparately from the text you reply with, also decide: does answering this properly involve the full list of what's available -- either a BROAD browse question naming no specific item ("what do you have", "what's on the menu", "what's available", "can I see the menu/catalogue"), OR a specific item that's NOT available (where "here's what we do have" would be the natural next thing to say)? If either, end your reply on its own new line with exactly: ISGENERALAVAILABILITY -- for the broad case leave the rest of your reply empty, for the not-available case keep only the short "no" clause before it. Do not add this line for a question about a specific item that IS available (name it and its price, if asked, as normal), or for anything else.\n\nDATA:\n${businessContext}\n\n${menuContext}\n\n${kbContext}`;
  const raw = await askText(system, message);
  const isGeneralAvailability = /ISGENERALAVAILABILITY\s*$/i.test(raw.trim());
  const cleaned = raw.replace(/ISGENERALAVAILABILITY\s*$/i, '').trim();
  // Matched loosely (contains, case-insensitive) rather than an exact
  // string match -- a model asked for an exact phrase like "I don't know"
  // will sometimes still rephrase it, so a distinctive all-caps token
  // checked this way is the more reliable version of the same idea.
  const answer = cleaned.toUpperCase().includes(NO_KB_MATCH) ? null : cleaned;
  return { answer, isGeneralAvailability };
}

// A "Place an order" button on the very first greeting -- Chidera's call,
// 2026-09-10: a customer who taps this skips straight to the real menu
// list (see the button_reply handling in webhook-whatsapp.js), the same
// way a table's QR code does for dine-in, with no AI classifyIntent call
// needed to work out they wanted to order. WhatsApp only -- Instagram/voice
// have no reply-button equivalent, so they keep the plain-text greeting.
//
// One tap, one message -- Chidera 2026-09-10: "i want straight to the see
// menu button no two step" (fixed by switching to a direct-open cta_url
// button), then "menu and todays specials should not be 2 differnt
// texts" (a second "Special offers" MESSAGE, sent right after the first),
// then, after that got read as "drop specials from the greeting
// entirely": "i said specials and menu buttons should be in same chat i
// didnt say remove specialsss". Both stay, in the one message: "See menu"
// is the real button (opens the general menu on one tap, same as
// before); the specials link rides along as a second URL inside that
// same message's own body text, which WhatsApp auto-links and makes
// tappable on its own -- no second bubble, no second bot round-trip, and
// still one tap either way.
// No AI call here anymore -- Chidera 2026-09-11: "i need that first what
// would you like to order with menu to go out instantly no typing again."
// classifyIntent only ever routes here for a PURE greeting with nothing
// else in it (a real question or an order in the same message goes to
// 'enquiry'/'order' instead, never here), so there's nothing substantive
// left for an AI call to react to -- greetingAckFor already does the same
// tone-matching deterministically (used the same way in handleEnquiry/
// handleCollectInfo already), just without the network round trip.
// Split out from handleGreeting, 2026-09-22, so this FULL welcome text
// (menu framing + specials) can be reused as the web-chat page's own first
// bubble (routes/web-chat.js) instead of only ever being a real WhatsApp
// send -- see sendStartOrderLink below for what the real WhatsApp message
// shrinks to.
// Exported for routes/web-chat.js's own first-load render -- see that
// route's GET /:token.
export async function buildGreetingContent(customer) {
  // Chidera 2026-09-11: "welcome to <restaurant name>, what would you
  // like to order" -- then, after an initial pass kept greetingAckFor's
  // tone-matched prefix (Good morning!/Hey there!) alongside it: "not
  // that hey there" -- and then: "add hello before the welcome". Plain
  // "Hello!", not greetingAckFor's tone-matching (that's the "hey there"
  // that was already turned down).
  //
  // Chidera, 2026-09-20: "we agreed a name so bot can refer to customer"
  // -- customer.name is only ever set via the web menu's own name popup
  // (routes/menu-page.js's POST /:token/name), never invented or guessed;
  // this is the first place it's actually read back. Falls back to the
  // exact same plain wording as before when it isn't set, which is still
  // the common case until a business turns the popup on and customers
  // start filling it in.
  const { rows: bizRows } = await pool.query('select name from business limit 1');
  const businessName = bizRows[0]?.name || 'us';
  const message = customer.name
    ? `Hello ${customer.name}! Welcome to ${businessName}, what would you like to order?`
    : `Hello! Welcome to ${businessName}, what would you like to order?`;
  const specialsCategory = await findSpecialsCategory(customer.branch_id);
  return { message, businessName, specialsCategory };
}

// Chidera, 2026-09-23: "i need customer complaint and all those in the
// site as well... a site they are given where they can chat there too, to
// lay their complaints... i have to reduce billable text all round."
// Reuses the SAME /wa/:token page the ordering flow already uses -- no new
// page needed, the real free-text pipeline (routes/web-chat.js's
// /:token/message -> handleWebChatMessage -> handlePendingBatch) already
// classifies free text into 'complaint'/wantsHuman exactly like real
// WhatsApp text does, it just never had an entry point that DIDN'T assume
// ordering. Calling handover() straight from here (like this branch used
// to) would alert staff with nothing but "customer asked for a person" --
// no actual complaint yet, since they haven't said what's wrong -- and
// spend a real WhatsApp send doing it. One short link instead: once they
// actually type their complaint on the page, THAT free-text turn re-runs
// this exact classifyIntent branch and fires the real handover with their
// real words, landing as a free website bubble (customer.channel is
// 'website' by then) and a staff alert via push where available
// (notifyStaff). ?ctx=complaint tells the page's own first-bubble render
// (routes/web-chat.js) to greet them about their complaint, not the normal
// "what would you like to order?".
export async function sendComplaintLink(customer) {
  if (!process.env.PUBLIC_URL) {
    await reply(customer, `I'm sorry to hear that. Please tell me what happened and I'll get someone to help.`, 'complaint_redirect');
    return;
  }
  const token = await ensureMenuToken(customer);
  const chatUrl = `${process.env.PUBLIC_URL}/wa/${token}?ctx=complaint`;
  const credentials = await getWhatsAppCredentials(customer.branch_id);
  const shortMessage = `I'm sorry to hear that. Tap below to tell us what happened.`;
  await sendWhatsAppCtaUrl(recipientFor(customer), shortMessage, 'Tell us more', chatUrl, credentials);
  await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel: customer.channel, sender: 'bot', body: shortMessage, trigger: 'complaint_redirect', processed: true });
}

// Chidera, 2026-09-24: "if they want to reply, let reply not come to the
// bare chat let the customer be pinged with a you have a message from our
// manager, with tap here to chat button." routes/api.js's own complaint
// reply endpoint calls this: the manager's actual reply text is logged as
// a free website bubble (so it's there once they open the chat, same
// near-zero-cost shape as everything else on this page), but a customer
// who's genuinely left has no way to know it's waiting -- a manager
// replying is unscheduled, unlike a payment confirmation the customer is
// actively expecting, so this always sends a real, short WhatsApp ping
// pointing them back, never conditional on whether they're still on the
// page right now.
export async function notifyComplaintReply(customer, replyText) {
  // The manager's real reply lives as a free website bubble -- the ping
  // below stays generic on purpose, never the reply content itself,
  // matching this whole feature's own near-zero-message-cost shape (the
  // real content is free once they're on the page, only the nudge to get
  // them there is a billable send).
  await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel: 'website', sender: 'bot', body: replyText, trigger: 'complaint_reply' });
  if (!process.env.PUBLIC_URL) return;
  await sendChatRedirectPing(customer, `You have a message from our manager.`, { trigger: 'complaint_reply_ping' });
}

export async function handleGreeting(customer, text) {
  // Chidera, 2026-09-21: "look at my instagram flow... how does instagram
  // catch up to our current state" -- found live: an Instagram customer
  // got this bare greeting with NO menu link at all, ever, anywhere in
  // the flow (WhatsApp's own CTA-URL button type doesn't exist there) --
  // they could only order by typing item names and hoping the AI parsed
  // them right. voice genuinely can't use a link at all (spoken, not
  // visual), so it keeps the bare greeting -- Instagram gets the same
  // real menu URL WhatsApp does, just as a plain text line instead of a
  // button (auto-linkified by Instagram's own client), same fallback
  // shape sendPaymentLinkButton/sendPosPaymentChoice already use.
  if (customer.channel === 'voice' || !process.env.PUBLIC_URL) {
    const { message } = await buildGreetingContent(customer);
    await reply(customer, message, 'greeting');
    return;
  }
  if (customer.channel === 'instagram') {
    const { message, specialsCategory } = await buildGreetingContent(customer);
    const token = await ensureMenuToken(customer);
    const menuUrl = `${process.env.PUBLIC_URL}/m/${token}`;
    const body = specialsCategory
      ? `${message}\n\nMenu: ${menuUrl}\nToday's specials: ${menuUrl}?cat=${encodeURIComponent(specialsCategory)}`
      : `${message}\n\nMenu: ${menuUrl}`;
    await reply(customer, body, 'greeting');
    return;
  }
  if (customer.channel === 'website') {
    // Chidera, 2026-09-25, real report: "i texted hi and it replied me
    // welcome what would you like to order? in just text it didnt send
    // the menu attached to it." This branch WAS reachable -- typing free
    // text like "hi" directly into an already-open web chat (not tapping
    // a button) goes through dispatch()'s normal intent classification,
    // which lands here -- the old comment's "shouldn't normally be
    // reached" was wrong. Used to send buildGreetingContent's bare
    // message with no menu link at all; now a real bubble with a "See
    // menu" button, same shape sendOrderGreeting (routes/web-chat.js's
    // own first-visit greeting) and the Instagram branch above already use.
    const { message, specialsCategory } = await buildGreetingContent(customer);
    const token = await ensureMenuToken(customer);
    const menuUrl = `${process.env.PUBLIC_URL}/m/${token}`;
    const body = specialsCategory
      ? `${message}\n\nToday's specials: ${menuUrl}?cat=${encodeURIComponent(specialsCategory)}`
      : message;
    await logMessage({
      customerId: customer.id,
      tableSessionId: customer.tableSessionId,
      direction: 'outbound',
      channel: 'website',
      sender: 'bot',
      body,
      trigger: 'greeting',
      interactive: { type: 'cta_url', buttonText: 'See menu', url: menuUrl },
    });
    return;
  }
  // Chidera, 2026-09-25: "after an order has been completed a retext from
  // same customer, bot can respond with greeting text again a max of 3
  // times" -- this used to send a real, billable WhatsApp greeting on
  // EVERY single re-text with no open order (a customer who's done
  // ordering and just keeps saying "hi"), unbounded. Same
  // needsChatRedirect/markChatRedirectSent budget the bare-WhatsApp
  // mid-order redirect already shares across this customer -- a first-
  // ever contact still always sends (chat_redirect_sent_at is null), a
  // genuine web-chat visit or 24h of silence still renews it.
  if (!(await needsChatRedirect(customer))) return;
  await sendStartOrderLink(customer);
  await markChatRedirectSent(customer);
}

// Deterministic, not AI-driven -- this can never guess or invent an answer,
// which matters here specifically: it runs alongside real content in the
// SAME reply (handleCollectInfo, handleEnquiry), so there's no room for it
// to improvise past a plain courtesy phrase. Covers the greetings actually
// seen in real conversations; anything not matched just means no prefix,
// never a forced or wrong one.
//
// Composes rather than short-circuits: found live, a message with BOTH a
// time-of-day greeting and a wellbeing question ("good afternoon, how are
// you doing?") only got the time-of-day half acknowledged -- the "how are
// you" was answered with silence, technically "not ignored" (something
// still went out) but not actually a real answer to what was asked either.
// Every branch below can fire independently and all their text concatenates
// into one reply, matching how a real person would answer both parts of
// "good afternoon, how are you" in one breath.
export function greetingAckFor(text) {
  let ack = '';
  if (/good\s*morning/i.test(text)) ack += 'Good morning! ';
  else if (/good\s*afternoon/i.test(text)) ack += 'Good afternoon! ';
  else if (/good\s*evening/i.test(text)) ack += 'Good evening! ';
  else if (/\b(hi|hello|hey+)\b/i.test(text)) ack += 'Hey there! ';
  if (/how\s*(far|you\s*(dey|de)|are\s*you|is\s*(your\s*day|it\s*going))\b/i.test(text)) {
    ack += "I'm doing well, thank you for asking. ";
  }
  return ack;
}

// A confident, deterministic shortcut around classifyIntent's own AI call
// -- Chidera 2026-09-11: "i need that first what would you like to order
// with menu to go out instantly no typing again." Reuses the exact same
// patterns greetingAckFor already matches: strips every greeting phrase
// out of the message, and if literally nothing else is left (just
// whitespace/punctuation), this is confidently "just saying hi" with no
// question or order riding along -- classifyIntent's own definition of
// 'greeting' -- so there's nothing an AI call could add by looking at it.
// Anything with real content left over ("hi, do you have jollof?") still
// goes through classifyIntent as normal, unaffected.
export function isPureGreeting(text) {
  const stripped = text
    .replace(/good\s*(morning|afternoon|evening)/gi, '')
    .replace(/\b(hi+|hello+|hey+|yo|greetings)\b/gi, '')
    .replace(/how\s*(far|you\s*(dey|de)|are\s*you|is\s*(your\s*day|it\s*going))\b/gi, '')
    .replace(/[\s!.,?]+/g, '');
  return stripped.length === 0;
}

export async function handleEnquiry(customer, text) {
  const { answer: rawAnswer, isGeneralAvailability } = await answerFromKnowledgeBase(text);
  const answer = await resolveGeneralAvailability(customer, isGeneralAvailability, rawAnswer, text);
  // Same idiom as handleCollectInfo's greetingPrefix -- a batched message can
  // both greet AND ask a browse question ("good afternoon, what do you
  // have?"), and the greeting was being silently dropped whenever the
  // question half resolved to an empty answer (a pure browse question is
  // BY DESIGN answered with just the menu button, so `answer` alone was
  // often falsy and this whole function returned without sending anything).
  // handleCollectInfo already folds a greeting into its reply this same
  // way; this path never did, which is exactly the gap that made a
  // multi-part message with a greeting in it look ignored.
  const greeting = greetingAckFor(text);
  if (answer || greeting) {
    await reply(customer, `${greeting}${answer || ''}`.trim(), 'kb_answer');
    return;
  }
  // Covers both how the menu could have just been sent instead of text --
  // the AI's own classification, or the deterministic phrasing check inside
  // resolveGeneralAvailability -- either way, nothing more is needed here.
  if (isGeneralAvailability || looksLikeBrowseQuestion(text)) return;
  const priorMisses = await countConsecutiveKbMisses(customer.id);
  if (priorMisses >= 1) {
    await handover(customer, "Customer asked something twice that isn't in the knowledge base");
    return;
  }
  await reply(customer, "Let me check on that for you, one moment.", 'kb_miss');
}
