// Item collection, upsell, order confirm, and fulfilment -- split out of
// flow.js 2026-10-01 as the seventh and final phase of breaking up that
// file's 6800+ lines into focused pieces (see sweeps.js, voice-turn.js,
// dinein.js, staff.js, greeting.js, payment-flow.js for the first six).
// This is the real order-taking state machine itself: build the basket,
// answer item questions, offer upsells, get a yes, work out delivery or
// pickup, hand off to payment-flow.js once that's settled. dispatch()
// (the thin router that decides WHICH of these runs next based on
// order.engine_state) deliberately stays in flow.js, not here -- once
// this file is out, flow.js itself already IS the thin coordinator the
// original plan called "router": it only calls into this file, never the
// reverse except for the handful of functions this file needs back
// (summariseOrder, sendConfirmButtons, sendWebMenuLink, etc., all genuine
// shared infrastructure, not order-engine-specific).
//
// Order-question-answering (menuKeywordMatch/answerOrderQuestion/
// looksLikeBrowseQuestion/formatMenuAsText/resolveGeneralAvailability/
// answerOrThenShowMenu) stays in flow.js too -- it's used by
// payment-flow.js's handleWaitingOnPayment as much as by this file's own
// handleCollectInfo/handleCollectFulfilment/handleFulfilmentStageMessage,
// genuinely cross-cutting, not ordering-specific.
//
// flow.js imports back handleCollectInfo/handlePendingUpsell/
// handlePendingItemQuestion/handleReconfirmAfterEdit/handleCollectFulfilment/
// handleConfirmOrder/handleFulfilmentStageMessage/handleOrderModification/
// handleFulfilmentChange/handlePostPaymentFulfilmentChange/classifyPureAck/
// finishItemsCollection/markOrderConfirmed/sendTopupInvoice/
// clearPendingQuestionIfOnItem for dispatch()'s own routing switch and the
// handful of other staying functions (handlePendingBatch,
// shouldSkipTypingIndicator, handleWebMenuOrder, handleMenuItemTap,
// handleOrderConfirmYesTap) that call directly into this file; every
// exported name here is also re-exported so no existing EXTERNAL import
// site has to change.
import { pool } from '../lib/db.js';
import * as botEngine from '../bot-engine/index.js';
import { detectDelayComplaint } from './classify.js';
import { missingFieldsForOrder, missingFulfilmentFields, extractAndApply, extractOrderItems, extractOrderModifications, extractFulfilmentChange, loadBotFields, describeForExtraction, branchOptions, resolveMenu } from './fields.js';
import { askJson } from './claude.js';
import { sendWhatsAppButtons, sendWhatsAppDocument } from './whatsapp-send.js';
import { sendListMessage, productForRowId } from './menu-message.js';
import { initializePaystackTopupTransaction } from './payment.js';
import { getWhatsAppCredentials } from './branch-channel.js';
import { getDeliveryConfig, resolveZoneForAddress } from './delivery-zones.js';
import { estimateDeliveryFee } from './delivery.js';
import { sendPaymentLinkButton } from './payment-flow.js';
import {
  reply,
  logMessage,
  recipientFor,
  findOrCreateCustomer,
  resolveCustomerOrder,
  summariseOrder,
  transitionOrder,
  handover,
  ensureMenuToken,
  sendWebMenuLink,
  menuGreetingBody,
  sendConfirmButtons,
  resetServedForAddOn,
  restartItemsCollection,
  answerOrThenShowMenu,
  sendPaymentInstructions,
  resolveBackToChatUrl,
} from './flow.js';

// A bare re-ask ("What would you like to order today?") on a second try
// isn't actually helpful -- the customer already tried to answer that and
// it didn't match. For the two fields with a real, short options list
// (item, branch), naming the actual choices turns a repeated question into
// something they can act on ("we didn't have a match, here's what we do
// have" instead of the same sentence verbatim).
async function fieldPrompt(fieldKey, fallbackQuestion, branchId) {
  if (fieldKey === 'items') {
    // Chidera 2026-09-10: "let bot no longer send menu photos itself" --
    // the real web menu page (sendWebMenuLink) is the intended way to show
    // the menu now; this text listing is just the last-resort fallback
    // when that isn't available, same as it always was for a catalogue
    // small enough to actually read as text.
    const products = await resolveMenu(branchId);
    if (products.length) return `${fallbackQuestion || 'What would you like to order?'} We have: ${products.map((p) => p.name).join(', ')}.`;
  }
  if (fieldKey === 'branch') {
    const branches = await branchOptions();
    if (branches.length) return `${fallbackQuestion || 'Which branch?'} We have: ${branches.map((b) => b.name).join(', ')}.`;
  }
  return fallbackQuestion || `Sorry, can you tell me the ${fieldKey}?`;
}

export async function handleCollectInfo(customer, order, text, greetingPrefix = '') {
  // Computed once, reused for whatever reply actually ends up going out
  // below -- a message can both state an order AND ask something ("can I
  // have fried rice, how much is suya wrap"), and the question was
  // silently getting dropped whenever the order half also matched
  // successfully (only the no-match path used to check for a question at
  // all). One combined reply, not the question ignored or a second message
  // sent separately -- also folds in the greeting acknowledgment for a
  // brand-new conversation, so that's one reply too, not two.
  const questionAnswer = await answerOrThenShowMenu(customer, order, text, `Taking their order.`);
  // Mutable -- a vague item mention found further down ("1 chapman and some
  // rice") gets appended here too, so it rides along on whatever reply ends
  // up going out next instead of being silently dropped just because OTHER
  // items in the same message matched cleanly.
  let prefix = `${greetingPrefix}${questionAnswer ? `${questionAnswer} ` : ''}`;
  const send = (msg, trigger) => reply(customer, `${prefix}${msg}`.trim(), trigger || (prefix ? 'order_question_answer' : undefined));

  const { rows: items } = await pool.query('select * from order_item where order_id = $1', [order.id]);
  const outstanding = await missingFieldsForOrder(order, items);

  if (outstanding.length) {
    if (outstanding[0] === 'items') {
      // One extraction pass over the whole message pulls out every
      // item+quantity it can match, not just the first one -- a customer
      // who writes their whole order in one go should never have to repeat
      // it back one item at a time.
      const { matched, ambiguous } = await extractOrderItems(text, order.branch_id);
      // Chidera, 2026-09-17: "a customer texted she wanted to order alfredo
      // pasta and the bot attended to her with text which is good but at
      // the begining he would have also sent the menu text... some
      // customers may not know thats available" -- this "already shown"
      // check used to only be computed inside the !matched.length branch
      // below, so a message that named a real item successfully on the
      // very first try (skipping that branch entirely) never triggered the
      // menu send at all -- the customer who names one dish they already
      // know about never finds out what else is on offer. Computed once,
      // shared by both branches, so "first items interaction on this
      // order" means the same thing whether or not the message matched.
      const { rows: menuAlreadyShown } = await pool.query(
        `select 1 from message where customer_id = $1 and trigger = 'items_menu_shown' and created_at >= $2 limit 1`,
        [customer.id, order.created_at]
      );
      if (!matched.length) {
        // A vague mention that could genuinely mean more than one real item
        // ("rice" when both jollof and fried rice exist) -- ask which one,
        // always naming the actual matching options, never a guess and
        // never a generic "what would you like" that ignores what they
        // already said.
        if (ambiguous.length) {
          const lines = ambiguous.map((a) => `We have ${a.options.join(' and ')}, which do you mean?`).join(' ');
          await send(lines, 'items_clarify');
          return;
        }
        // "How much is X" isn't an order for X -- extractOrderItems
        // correctly finds nothing to add, but that's not the same as the
        // message being unclear. A real price question gets a real price
        // answer (already in `prefix` above), not the generic re-ask below.
        if (questionAnswer) {
          await send('', 'order_question_answer');
          return;
        }
        // The full "We have: ..." list is only useful the first time --
        // repeating the whole menu on every failed attempt gets tedious
        // fast. After that, a short nudge instead: they can already see
        // what's on offer, no need to recite it back every time nothing
        // matches.
        if (menuAlreadyShown.length) {
          await send(`You can check what we have and let me know what you'd like.`, 'items_reask');
        } else {
          // The real web menu page (engine/menu-page-template.js) beats
          // even a photo once it's available -- every dish, a real photo,
          // categories, a basket, built and served entirely by this
          // backend, not dependent on Meta's own catalogue indexing or the
          // old WhatsApp List Message's 10-row/no-photo limits. Chidera's
          // call, 2026-09-10: "the menu is meant to be like a site now...
          // not just in dine in[,] the normal conversation flow". WhatsApp
          // only (Instagram has no CTA-URL button type) -- Instagram keeps
          // the text fallback below unchanged.
          //
          // No menu-photo forward anymore either way -- Chidera 2026-09-10:
          // "let bot no longer send menu photos itself". The real web menu
          // (or, failing that, fieldPrompt's own text listing) is the only
          // fallback now.
          let catalogShown = false;
          if (customer.channel !== 'instagram') {
            catalogShown = await sendWebMenuLink(customer, await menuGreetingBody()).catch((err) => {
              console.error('sendWebMenuLink failed:', err.message);
              return false;
            });
          }
          // Found live, 2026-09-16: "why is bot sending me 2 text? the text
          // with menu is meant to contain the whole text" -- the fix above
          // (only 2026-09-10's note) stopped the full text ITEM LIST from
          // duplicating the button, but still sent a second, shorter
          // message ("What would you like to order?") right after every
          // time the button itself succeeded -- genuinely redundant, since
          // sendWebMenuLink's own body text ("Here's our menu, take a look
          // and let me know what you'd like.") already asks exactly that.
          // Only send anything more when the button DIDN'T go out --
          // Instagram (no CTA-URL button type) or a real send failure --
          // where fieldPrompt's text listing is the only way the customer
          // gets to see the menu at all.
          if (!catalogShown) {
            await send(await fieldPrompt('items', 'What would you like to order?', order.branch_id), 'items_menu_shown');
          } else {
            await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel: customer.channel, sender: 'bot', body: '[covered by menu button above, no separate text sent]', trigger: 'items_menu_shown', processed: true });
          }
        }
        return;
      }
      for (const m of matched) {
        await pool.query('insert into order_item (order_id, product_id, quantity, price, added_by_customer_id) values ($1, $2, $3, $4, $5)', [order.id, m.productId, m.quantity, m.price, customer.id]);
      }
      // Named a real item straight away, first try -- still worth showing
      // the full menu once (see the comment on menuAlreadyShown above):
      // they only told us about the one dish they already had in mind, not
      // everything else on offer. Sent ahead of the normal text reply
      // below, not instead of it -- "attended to her with text... at the
      // beginning he would have also sent the menu."
      if (!menuAlreadyShown.length && customer.channel !== 'instagram') {
        const sent = await sendWebMenuLink(customer, await menuGreetingBody()).catch((err) => {
          console.error('sendWebMenuLink failed:', err.message);
          return false;
        });
        // sendWebMenuLink's own logMessage tags itself 'menu_shown', not
        // 'items_menu_shown' -- that second, specific trigger is what
        // menuAlreadyShown's own query above looks for, so it has to be
        // logged here too or every later message in this same order would
        // think the menu was never shown and keep re-sending it.
        if (sent) {
          await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel: customer.channel, sender: 'bot', body: '[covered by menu button above, no separate text sent]', trigger: 'items_menu_shown', processed: true });
        }
      }
      // The clear items above still get added -- the ambiguous part just
      // rides along on whatever reply comes next (branch, confirm, etc.)
      // instead of being silently dropped.
      if (ambiguous.length) {
        prefix = `${prefix}${ambiguous.map((a) => `We have ${a.options.join(' and ')}, which do you mean? `).join('')}`;
      }
    } else {
      // Before assuming this message answers the CURRENT outstanding field
      // (branch, delivery address, whatever's next), check whether it's
      // actually asking to add/change items instead -- found live: "I also
      // want suya and rice" while still being asked for a branch was
      // silently dropped, since this branch only ever looked for the one
      // specific field it expected next, never for a new item mention.
      const { rows: currentItemsForMod } = await pool.query(
        `select p.name, oi.quantity from order_item oi join product p on p.id = oi.product_id where oi.order_id = $1`,
        [order.id]
      );
      const mods = await extractOrderModifications(text, currentItemsForMod, order.branch_id);
      if (mods) {
        // Not "your order's now X" here -- found live, 2026-09-10: this
        // used to restate the whole order, then finishItemsCollection's
        // own confirm message restated it again right after, listing
        // everything twice in one reply. finishItemsCollection is always
        // the very next thing that runs from here (nothing else follows
        // this branch), so a bare acknowledgment is enough -- the real
        // breakdown shows up once, in that message.
        await applyOrderModifications(order, mods, { allowRemovals: true }, customer);
        prefix = `${prefix}Got it. `;
      } else {
        const fields = await loadBotFields();
        const field = fields.find((f) => f.key === outstanding[0]);
        const extracted = await extractAndApply({ fieldKey: outstanding[0], message: text, contextQuestion: field?.question, order });
        if (extracted === null) {
          await send(await fieldPrompt(outstanding[0], field?.question, order.branch_id));
          return;
        }
      }
    }
    // extractAndApply/the items insert above just wrote straight to the
    // database -- reload so the missing-fields check right below sees it,
    // instead of judging against this now-stale in-memory copy.
    const { rows: reloaded } = await pool.query('select * from "order" where id = $1', [order.id]);
    Object.assign(order, reloaded[0]);
  }

  return finishItemsCollection(customer, order, prefix, { preferTextForQuestions: true });
}

// Finds the earliest catalogue-question still unanswered across every item
// on this order, in item-then-question order -- null once every item's
// questions (if it has any at all) are all answered. Kept as its own query
// (not parsed out of order_item.modification's free text) so "has this
// specific question been asked yet" is a real fact, not a guess.
async function askNextItemQuestion(orderId) {
  const { rows } = await pool.query(
    `select oi.id as order_item_id, pq.id as question_id, pq.question, pq.options, p.name as product_name
     from order_item oi
     join product p on p.id = oi.product_id
     join product_question pq on pq.product_id = p.id
     where oi.order_id = $1
       and not exists (
         select 1 from order_item_answer oa where oa.order_item_id = oi.id and oa.question_id = pq.id
       )
     order by oi.id, pq.position
     limit 1`,
    [orderId]
  );
  return rows[0] || null;
}

// Cross-sell, per Chidera 2026-09-10: a real question with the actual
// options named ("Would you like to add a drink? We have: Coke, Fanta,
// Chapman.") asked and answered as its own exchange BEFORE the final "to
// confirm" summary, not decoration folded into it or sent after -- "you
// must be clear on what customer wants before asking that total yes to
// confirm thing". Only ever for a category this business actually sells
// (never invented, same rule as everywhere else the menu gets named), and
// each category is offered at most once per order (order.upsell_offered)
// so declining it doesn't get asked again on every turn. Keyed off
// product.category, the same field the Catalogue page already groups by --
// no new setup for a restaurant that's already categorized its menu, and
// it simply never fires for one that hasn't.
// Chidera 2026-09-10: "the bott should know when to recommend a protein or
// when to recommend a drink... or when to recommend a snack... or even
// when to recommend water." nextUpsellGroup below already asks one group
// at a time, skips anything the order already has, and never repeats a
// group already offered this order -- so which of these actually gets
// offered, and in what order, already follows what's really being
// ordered without any extra logic; adding a real category here is what
// makes it apply to more than drink/protein. Water deliberately isn't its
// own group -- most catalogues list a water bottle under Drinks like any
// other beverage (era-demo's own category list confirms this: DRINKS,
// MAINS, nothing separate), so a rigid "category = water" group would
// just never fire for almost anyone. Folded into 'drink's own keywords
// instead, so a business that DOES give it a distinct category still
// gets it offered, under the same "would you like a drink" ask.
// Exported so routes/api.js's upsell-success-rate stat can tell whether an
// offered category actually landed in the final order using the exact same
// keyword matching nextUpsellGroup itself uses to decide a category's
// already satisfied -- one source of truth for what counts as a match,
// not a second guess at the same keywords.
// Chidera, 2026-09-25: "let upsell only be protein and drink or side and
// drink now no more snack" -- snack dropped from the priority tracks below
// (nextUpsellGroup), so it's never actively offered going forward. Kept
// HERE though, not deleted -- routes/api.js's computeUpsellStats and this
// file's own logMetric('upsell_accepted') both look up a past order's
// upsell_offered entries against this exact array to tell whether an
// already-recorded offer (snack entries from before today, on real live
// orders) actually landed; deleting the group here would silently zero
// out accepted-count accuracy for that real historical data, not just stop
// new snack offers.
export const UPSELL_GROUPS = [
  { key: 'drink', keywords: ['drink', 'beverage', 'juice', 'water'], label: 'a drink' },
  { key: 'protein', keywords: ['protein', 'meat'], label: 'a protein' },
  { key: 'side', keywords: ['side', 'sides'], label: 'a side' },
  { key: 'snack', keywords: ['snack', 'small chop', 'appetiser', 'appetizer', 'starter'], label: 'a snack' },
];

// Chidera, 2026-09-25, same message: "and only 2 upsell" -- down from 3.
const MAX_UPSELL_PICKS = 2;

export function categoryMatchesGroup(category, keywords) {
  if (!category) return false;
  const lower = category.toLowerCase();
  return keywords.some((k) => lower.includes(k));
}

// Full product rows, not just names -- Chidera 2026-09-10: "an upsell
// should bring up that view drinks thats like a list and click button...
// if i want to reduce api cost what will be the best option?" A tap needs
// a real product id to route the same zero-AI-cost way any other menu-list
// tap already does (see sendUpsellList/handleUpsellListTap below); the
// text fallback (sendUpsellList returning false, or a typed reply --
// handlePendingUpsell) just reads .name off these instead.
function catalogueOptions(menu, keywords) {
  return menu.filter((p) => categoryMatchesGroup(p.category, keywords));
}

// Chidera, 2026-09-25: "let upsell only be protein and drink or side and
// drink now no more snack, and only 2 upsell" -- then, same day, a
// correction: "protein is more important than side." Still exactly one
// of {protein, side} paired with drink, never both -- protein is just
// the tie breaker for WHICH one when an order is missing both (checked
// first below); an order missing only side still gets side, same as
// before.
// Chidera, 2026-10-01, real live report: "when i tapped egg under choose
// for protein upsell, it delivered double message" (separate poll-race
// bug, fixed in web-chat-page-template.js) "and i said that for upsell
// its either protein and drink or side and drink, now after protein im
// still seeing side infact make drink first then protein or side...
// second." Two real fixes below: (1) 'drink' now leads priorityKeys
// instead of trailing it. (2) the non-drink pick is only EVER computed
// once per order -- the moment either 'protein' or 'side' shows up in
// upsell_offered (asked about at all, accepted or declined), the other
// one is locked out for good. The old code recomputed nonDrinkKey fresh
// on every call from hasProtein/hasSide (what's actually IN the order),
// not from what's already been OFFERED -- so accepting the protein
// upsell flipped hasProtein true, emptied proteinOptions, and the very
// next call silently fell through to offering side too, exactly the
// "protein and side both" case this was always supposed to rule out.
const SIDE_KEYWORDS = UPSELL_GROUPS.find((g) => g.key === 'side').keywords;
const PROTEIN_KEYWORDS = UPSELL_GROUPS.find((g) => g.key === 'protein').keywords;

// Next upsell offer worth making, if any -- one whole category at a time
// (every real product in it, not just a representative one), already-
// ordered categories and already-offered-this-order categories both
// excluded, capped at MAX_UPSELL_PICKS sequential offers total. Naturally
// returns null once every real cross-sell opportunity is either satisfied,
// already declined, or the cap's been reached.
async function nextUpsellGroup(order, orderItems) {
  if (!orderItems.length) return null;
  const offered = order.upsell_offered || [];
  if (offered.length >= MAX_UPSELL_PICKS) return null;
  const menu = await resolveMenu(order.branch_id);
  const orderedCategories = orderItems.map((oi) => menu.find((p) => p.id === oi.product_id)?.category).filter(Boolean);
  const hasProtein = orderedCategories.some((c) => categoryMatchesGroup(c, PROTEIN_KEYWORDS));
  const hasSide = orderedCategories.some((c) => categoryMatchesGroup(c, SIDE_KEYWORDS));
  // protein/side already asked about this order (either tapped in or
  // declined) -- that's this order's one non-drink slot, decided for good,
  // never reopened for the other category.
  let nonDrinkKey = null;
  if (!offered.includes('protein') && !offered.includes('side')) {
    // Chidera, 2026-09-25: "protein is more important than side" -- but
    // only when protein is actually a real, orderable category for this
    // business; a catalogue with no protein products at all (test-upsell-
    // multiselect-quantity.mjs's own seed, confirmed) must still fall
    // through to side, not silently offer nothing.
    const proteinOptions = !hasProtein ? catalogueOptions(menu, PROTEIN_KEYWORDS) : [];
    const sideOptions = !hasSide ? catalogueOptions(menu, SIDE_KEYWORDS) : [];
    nonDrinkKey = proteinOptions.length ? 'protein' : sideOptions.length ? 'side' : null;
  }
  // Chidera, 2026-10-01: "make drink first then protein or side second."
  const priorityKeys = nonDrinkKey ? ['drink', nonDrinkKey] : ['drink'];
  const priorityGroups = priorityKeys.map((key) => UPSELL_GROUPS.find((g) => g.key === key));
  for (const group of priorityGroups) {
    if (offered.includes(group.key)) continue; // already asked about this one this order
    const options = catalogueOptions(menu, group.keywords);
    if (!options.length) continue;
    const orderHasIt = orderedCategories.some((c) => categoryMatchesGroup(c, group.keywords));
    if (orderHasIt) continue;
    return { ...group, options };
  }
  return null;
}

// The upsell offer as a real WhatsApp List Message (tap to add) instead of
// free text an AI call has to parse -- Chidera 2026-09-10: "an upsell
// should bring up that view drinks thats like a list and click button...
// if i want to reduce api cost what will be the best option?" A tap costs
// zero AI calls (handleUpsellListTap below just reads the row id straight
// back to a real product, same as any other menu-list tap), where the old
// free-text version could burn up to three separate AI calls just parsing
// one reply ("is this a change?", "does this name an item?", "are they
// saying yes without naming one?" -- the last of those existed specifically
// to patch the ambiguity a list tap makes impossible by construction).
// Capped at 8 options + a "No thanks" row (9 total, under WhatsApp's
// 10-row hard limit) -- an upsell nudge doesn't need the main menu's own
// pagination, it's a short nudge, not a browse.
// Row ids are prefixed (upsell::<productId>, upsell::skip) rather than a
// bare product id -- keeps this completely separate from the general
// "View menu" list's own row-id space (menu-message.js), which a bare id
// would otherwise collide with.
// Exported for sandbox/test-web-chat-ordering.mjs -- exercises this
// function's website branch directly, since the real dispatch() path that
// would normally reach it needs a live Anthropic key this environment
// doesn't have (extractOrderModifications, called before any state-based
// routing for an order past collect_info).
function upsellSectionTitle(upsell) {
  return upsell.label.charAt(0).toUpperCase() + upsell.label.slice(1);
}

// Chidera, 2026-09-24: "can i have it as a dropdown they can choose, and
// an optional type extra note if they have extra, so they just only have
// to select." website-channel only -- WhatsApp has no dropdown UI to send
// this as, so it keeps asking in plain text there, same as it always did
// (finishItemsCollection's own caller falls through to that when this
// returns false). Real options only, same "never invent structure that
// isn't really there" rule as everywhere else in this file -- a question
// with none returns false too, falling through to the plain-text ask.
async function sendItemQuestionAsChoice(customer, nextQuestion, prefix, soFar) {
  if (customer.channel !== 'website') return false;
  if (!nextQuestion.options || !nextQuestion.options.length) return false;
  await logMessage({
    customerId: customer.id, tableSessionId: customer.tableSessionId,
    direction: 'outbound',
    channel: customer.channel,
    sender: 'bot',
    body: `${prefix}${soFar}For your ${nextQuestion.product_name}, ${nextQuestion.question}`.trim(),
    trigger: 'item_question_asked',
    interactive: { type: 'item_question', buttonText: 'Choose', options: nextQuestion.options },
  });
  return true;
}

export async function sendUpsellList(customer, upsell, prefix = '') {
  if (customer.channel !== 'whatsapp' && customer.channel !== 'website') return false;
  const rows = upsell.options.slice(0, 8).map((p) => ({
    id: `upsell::${p.id}`,
    title: p.name.slice(0, 24),
    description: `NGN ${Number(p.price).toLocaleString()}`,
  }));
  rows.push({ id: 'upsell::skip', title: 'No thanks', description: 'Skip' });
  // Chidera, 2026-09-24 (correction): "the former would you like to add a
  // drink is very okay just that it was to enable multi selesct and all."
  // Reverted to the plain single-category ask -- the earlier "combined
  // categories" wording was a solution to a problem this design no longer
  // has (each offer is one category again, sequential, not several
  // combined into one confusing list).
  const bodyText = `${prefix}Would you like to add ${upsell.label}?`.trim();
  // website: same row ids as WhatsApp's list message (upsell::<id>,
  // upsell::skip) -- a tap on the chat page posts the row id to
  // POST /:token/tap, which calls handleUpsellListTap exactly as the real
  // WhatsApp list_reply webhook event does today.
  if (customer.channel === 'website') {
    await logMessage({
      customerId: customer.id, tableSessionId: customer.tableSessionId,
      direction: 'outbound',
      channel: customer.channel,
      sender: 'bot',
      body: `${bodyText} We have: ${upsell.options.map((o) => o.name).join(', ')}.`,
      trigger: 'upsell_offered_list',
      interactive: { type: 'list', buttonText: 'Choose', sectionTitle: upsellSectionTitle(upsell), rows },
    });
    return true;
  }
  // Chidera, 2026-09-20: two real gaps found investigating a report of a
  // plain-text upsell on pomodoro -- (1) this never resolved the branch's
  // own credentials, only the raw shared env var (fixed by passing
  // getWhatsAppCredentials through, same as every other send in this
  // file); (2) a genuine Meta-side failure here had nothing catching it,
  // so it would have thrown all the way out of finishItemsCollection
  // instead of degrading to the plain-text fallback that already exists
  // right below this function's own call site. Couldn't actually confirm
  // which of the two explains that specific report (the success log and
  // the text fallback wrote the exact same body, so the dashboard
  // couldn't tell them apart either) -- trigger is now different for each
  // path specifically so that's answerable for real next time, not guessed.
  try {
    const credentials = await getWhatsAppCredentials(customer.branch_id);
    await sendListMessage(recipientFor(customer), {
      bodyText,
      buttonText: 'Choose',
      sectionTitle: upsellSectionTitle(upsell),
      rows,
    }, credentials);
  } catch (err) {
    console.error(`sendUpsellList: list send failed, falling back to text: ${err.message}`);
    return false;
  }
  // Logged as the real bodyText actually sent (including any order-so-far
  // readback), not a separate hand-written string -- was drifting from
  // what the customer actually saw, so the dashboard transcript read
  // differently than the real conversation did.
  await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel: customer.channel, sender: 'bot', body: `${bodyText} We have: ${upsell.options.map((o) => o.name).join(', ')}.`, trigger: 'upsell_offered_list' });
  return true;
}

// Chidera 2026-09-11: "reconfirm my order to me first before you ak me any
// add a drink or peppered or not question so you are sure of what im
// ordering." A quick itemized readback right before asking an item
// question or an upsell -- so a customer sees exactly what the bot thinks
// they ordered BEFORE getting asked to customize or add to it, not just
// once at the very end. Skipped when there's nothing on the order yet
// (shouldn't happen -- finishItemsCollection only ever runs after an
// item's already been added -- but never worth a blank "Your order so
// far:" line if it somehow did).
async function orderSoFarSummary(order) {
  const { itemLines } = await summariseOrder(order);
  return itemLines.length ? `Your order so far:\n${itemLines.join('\n')}\n\n` : '';
}

// The tail end of item collection -- shared between the normal path
// (handleCollectInfo above), handlePendingItemQuestion, and
// handlePendingUpsell below, so all three end up asking for the next
// item-question, the next missing field, the next upsell, or moving to
// confirmation the same way, instead of multiple versions drifting apart.
// The item-question check runs first and unconditionally, every time this
// is reached -- including right after handlePendingUpsell adds a drink,
// so a drink that itself has a product_question ("hot or cold?") still
// gets asked, the same as if it had been the very first item ordered.
// autoConfirm: Chidera, 2026-09-17: "full review before submit... making
// the WhatsApp confirm yes/no unnecessary." Defaulted false everywhere --
// every existing caller (typed WhatsApp, handlePendingItemQuestion,
// handlePendingUpsell) keeps asking the real yes/no exactly as before.
// Only handleWebMenuOrder ever passes true, and only when the submission
// carried a real fulfilment choice -- meaning it came through the site's
// own review sheet (items + delivery/pickup + total, all already shown
// and confirmed there), not a stray/incomplete web hit. Item-question and
// missing-field checks below still run unconditionally either way -- a
// genuinely unanswered question still gets asked over WhatsApp rather
// than silently skipped; autoConfirm only ever replaces the FINAL
// yes/no ask, once nothing else was actually outstanding.
// deltaLines -- Chidera, 2026-09-20: "when they add on send them the yes
// to confirm button and place the ordr, let their total and items be
// compounding in the ready to pay stuff." An add-on round (order already
// confirmed once before) still gets the same real yes/no confirm gate
// every round does -- just scoped to what's NEW this round (deltaLines),
// not the whole running order restated again. The full, ever-growing
// total/item list is what the ready-to-pay page shows (routes/dinein-
// menu.js's payStatusPayload, already reading the one shared order's
// live total) -- that's where "compounding" belongs, not every chat
// message. null (the default) means the normal, first-round full summary.
export async function finishItemsCollection(customer, order, prefix = '', { autoConfirm = false, preferTextForQuestions = false, deltaLines = null } = {}) {
  const nextQuestion = await askNextItemQuestion(order.id);
  if (nextQuestion) {
    await pool.query('update "order" set pending_question_order_item_id = $1, pending_question_id = $2 where id = $3', [
      nextQuestion.order_item_id,
      nextQuestion.question_id,
      order.id,
    ]);
    // Chidera, 2026-09-20: "let ... details of food specification eg. cold
    // or room temp be processes in the flow on the website to save cost"
    // -- one web link (the general menu page, already pre-loaded with this
    // exact pending order -- see routes/menu-page.js's pendingOrderPayload
    // and menu-page-template.js's firstUnansweredKey) covers every
    // outstanding item-question in one visit instead of one Meta message
    // per question.
    //
    // preferTextForQuestions -- Chidera, 2026-09-20, real report (Emmanuel,
    // era-demo): "if they are already using text no need to send them back
    // to the menu to answer cold or not, just go text it." A customer who
    // placed THIS item by typing (not tapping through the web menu or a
    // button) is already mid-conversation in plain text -- redirecting
    // them to a web link for one short question is a worse experience
    // than just asking it, not a cheaper one. Set true by every
    // text-originated caller below; left false (web link first, same as
    // before) for every web/button-tap-originated caller, where a link is
    // the natural continuation of what they were already doing.
    // pending_question_order_item_id/_id above are still set regardless,
    // so a customer who ignores the link and just types an answer anyway
    // (handlePendingItemQuestion) still works exactly as before.
    const soFarForChoice = await orderSoFarSummary(order);
    // Chidera, 2026-09-24: "can i have it as a dropdown they can choose,
    // and an optional type extra note if they have extra, so they just
    // only have to select." Same real product_question.options the web
    // menu page's own qSheet already offers a select-plus-optional-note
    // UI for -- now available directly in the chat too, so a website
    // customer never has to leave it (or type a free-text answer by hand)
    // just to say "cold" or "no pepper". Only for a question that
    // genuinely HAS real options set in Catalogue -- one with none keeps
    // asking in plain text exactly as before, same "never invent
    // structure that isn't really there" rule as everywhere else.
    const shownChoice = await sendItemQuestionAsChoice(customer, nextQuestion, prefix, soFarForChoice);
    if (shownChoice) return;
    if (!preferTextForQuestions) {
      const shownLink = await sendWebMenuLink(customer, `${prefix}Just need a couple more details on your order -- tap below to finish up.`, 'Finish my order', null, null, order);
      if (shownLink) return;
    }
    // Chidera, 2026-09-24: first tried naming the quantity + a split-answer
    // hint here for a multi-unit line ("for things like drink just asks
    // for your drinks cold or room temperature, the customer can type 1
    // cold and 1 room temperature") -- then corrected: "no need to ask
    // that extra 'you have 2, feel free to split it'...blah blah...the
    // first cold or room temperature is fine." Back to the plain question,
    // every time. handlePendingItemQuestion already stores whatever's
    // typed here verbatim (no forced single answer), so a real split
    // answer still works fine without the bot spelling out the option.
    await reply(customer, `${prefix}${soFarForChoice}For your ${nextQuestion.product_name}, ${nextQuestion.question}`.trim(), 'item_question_asked');
    return;
  }

  const { rows: itemsAfter } = await pool.query('select * from order_item where order_id = $1', [order.id]);
  const stillOutstanding = await missingFieldsForOrder(order, itemsAfter);
  if (stillOutstanding.length) {
    const fields = await loadBotFields();
    const nextField = fields.find((f) => f.key === stillOutstanding[0]);
    await reply(customer, `${prefix}${await fieldPrompt(stillOutstanding[0], nextField?.question, order.branch_id)}`.trim());
    return;
  }

  const upsell = await nextUpsellGroup(order, itemsAfter);
  if (upsell) {
    await pool.query('update "order" set pending_upsell_category = $1, upsell_offered = array_append(upsell_offered, $1) where id = $2', [
      upsell.key,
      order.id,
    ]);
    const soFar = await orderSoFarSummary(order);
    const sent = await sendUpsellList(customer, upsell, `${prefix}${soFar}`);
    if (!sent) {
      await reply(customer, `${prefix}${soFar}Would you like to add ${upsell.label}? We have: ${upsell.options.map((o) => o.name).join(', ')}.`.trim(), 'upsell_offered_text');
    }
    return;
  }

  // Chidera, 2026-09-24: "after i said no thanks and later on i wanted to
  // add, the bot was not acknowledging my new selection." handleUpsellListTap/
  // handleUpsellMultiTap can now add an item via a tap on an OLDER,
  // already-answered upsell bubble even after the order's moved past
  // collect_info (confirm_order, confirm_payment, ...) -- the forward
  // transition chain below only has one real starting point
  // (collect_info -> check_availability -> calculate_price -> confirm_order,
  // per the state machine's own allowed moves), so attempting it from any
  // later state throws. Recompute and acknowledge instead, same
  // "modification at a later stage" shape applyOrderModifications already
  // uses elsewhere -- no transition needed, the order was already past
  // this point.
  if (order.engine_state !== 'collect_info') {
    const { total } = await summariseOrder(order);
    await pool.query('update "order" set total = $1 where id = $2', [total, order.id]);
    // Chidera, 2026-09-25, real live incident: a plain "New total: NGN X"
    // text here left two real problems for an order already past
    // collect_info -- (1) any order_confirm_asked bubble already sent
    // silently stops responding: handleOrderConfirmYesTap's own guard
    // requires engine_state === 'confirm_order', which this late add never
    // touches, so a tap on an OLDER confirm_order-stage bubble's buttons
    // (or, worse, one from BEFORE this add, now showing a stale total)
    // does nothing; (2) if payment instructions/an invoice were already
    // sent once (confirm_payment), that link is now for the WRONG, stale
    // amount. "whenever the new total is updated, instead of just typing
    // new total resend me the invoice and paynow thing." Same reset-then-
    // resend shape applyOrderModifications' own wasAlreadyConfirmed branch
    // already uses for a typed "add X" -- this is the same fix for a
    // TAPPED add (an older upsell bubble) instead.
    if (order.engine_state === 'confirm_payment') {
      await pool.query('update "order" set confirmed_at = null where id = $1', [order.id]);
      order.confirmed_at = null;
      await sendPaymentInstructions(customer, order);
      return;
    }
    if (order.engine_state === 'confirm_order') {
      await pool.query('update "order" set confirmed_at = null where id = $1', [order.id]);
      order.confirmed_at = null;
      const { itemLines: freshLines, total: freshTotal } = await summariseOrder(order);
      await sendConfirmButtons(customer, `Got it, your order:\n${freshLines.join('\n')}\nNew total: NGN ${freshTotal}.`, 'order_confirm_asked');
      return;
    }
    await reply(customer, `${prefix}New total: NGN ${total}.`.trim(), 'upsell_late_add');
    return;
  }

  await transitionOrder(order, 'check_availability');
  await transitionOrder(order, 'calculate_price');
  const { itemLines, total, deliveryFee } = await summariseOrder(order);
  await pool.query('update "order" set total = $1 where id = $2', [total, order.id]);
  await transitionOrder(order, 'confirm_order');

  if (autoConfirm) {
    // Same confirmed_at + handleCollectFulfilment(customer, order, null)
    // pair handleConfirmOrder itself uses right after a real typed/tapped
    // "yes" -- handleCollectFulfilment does its own transitionOrder to
    // confirm_payment once fulfilment's resolved (already is here, see
    // applyWebFulfilment), so it goes straight to payment instructions
    // instead of a fresh yes/no ask for an order already reviewed and
    // confirmed on the site itself.
    await pool.query(`update "order" set confirmed_at = now() where id = $1`, [order.id]);
    order.confirmed_at = new Date();
    await handleCollectFulfilment(customer, order, null);
    return;
  }

  // Chidera, 2026-09-23, live report on era-demo: "it gave me a bill of
  // food with total of 4700 my food way 1700 but it didnt state the
  // delivery there, one could easily misunderstand" -- deltaLines is a
  // repeat add-on round (wasAlreadyConfirmed), reached only after the
  // order's very first confirm -- by then fulfilment/delivery fee is
  // usually already known, so `total` here could silently include a real
  // delivery fee never shown. The non-deltaLines branch is the genuinely
  // first-ever confirm, before fulfilment's even asked -- deliveryFee is
  // always 0 there, so this line is a no-op for it, not a behavior change.
  const deliveryFeeLine = deliveryFee > 0 ? [`Delivery fee: NGN ${deliveryFee}`] : [];
  const summary = deltaLines
    ? [...deltaLines, ...deliveryFeeLine, `Table's total is now: NGN ${total}`].join('\n')
    : [...itemLines, ...deliveryFeeLine, `Total: NGN ${total}`].join('\n');
  const heading = deltaLines ? 'Add on:' : 'To confirm:';
  await sendConfirmButtons(customer, `${prefix}${heading}\n${summary}`.trim(), 'order_confirm_asked');
}

// The reply to the upsell question above. Checked in order:
// 1) a real change to what's already in the order ("change it to jollof",
//    "remove the fried rice") -- found live, 2026-09-10: without this
//    check, a "change it to X" arriving right while a drink was being
//    offered got read as "add X" through the item-matcher below instead
//    of the swap it obviously meant, leaving both the old and new item on
//    the order at once.
// 2) failing that, the same real item-matcher the main order uses
//    (extractOrderItems), so "yes, a coke" or just "coke" both work the
//    same way an item mention always does elsewhere, not a bespoke
//    yes/no parser.
// 3) failing THAT, whether they said yes at all without naming one --
//    found live, 2026-09-10: "yes" to "Would you like to add a drink? We
//    have: Coke, Chapman, Zobo" matched no product name, so it silently
//    fell through as if they'd said no -- nothing added, nothing asked,
//    straight to confirming the order with no drink on it. A plain
//    decline still moves on exactly as before; only a real yes-but-which
//    re-asks, and only once (the offer's already marked offered, so it
//    can't loop forever even if they keep answering vaguely).
export async function handlePendingUpsell(customer, order, text) {
  const { rows: currentItems } = await pool.query(
    `select p.name, oi.quantity from order_item oi join product p on p.id = oi.product_id where oi.order_id = $1`,
    [order.id]
  );
  const mods = await extractOrderModifications(text, currentItems, order.branch_id);
  if (mods) {
    order.pending_upsell_category = null;
    await pool.query('update "order" set pending_upsell_category = null where id = $1', [order.id]);
    // Same reasoning as handleCollectInfo's own mods branch -- no "your
    // order's now X" here, finishItemsCollection's own confirm message is
    // the one place that lists it.
    await applyOrderModifications(order, mods, { allowRemovals: true }, customer);
    return finishItemsCollection(customer, order, 'Got it. ', { preferTextForQuestions: true });
  }

  const { matched } = await extractOrderItems(text, order.branch_id);
  if (matched.length) {
    order.pending_upsell_category = null;
    await pool.query('update "order" set pending_upsell_category = null where id = $1', [order.id]);
    // added_by_customer_id -- same fix as applyOrderModifications' own
    // insert (Chidera, 2026-09-20: "why are you seperating it" re a
    // chicken added via this exact upsell path). A second, parallel
    // insert this function has always had its own copy of, missed the
    // first time through.
    for (const m of matched) {
      await pool.query('insert into order_item (order_id, product_id, quantity, price, added_by_customer_id) values ($1, $2, $3, $4, $5)', [order.id, m.productId, m.quantity, m.price, customer.id]);
    }
    // Chidera, 2026-09-20: "when an item is added, why is stale amount on
    // ready to pay still there" -- same fix as applyOrderModifications'
    // own insert (this function's OTHER add path, just above), missed
    // here since this is a second, parallel insert that was never routed
    // through it. Any PENDING order_payment is now stale the moment a
    // real item gets added, regardless of which of this function's own
    // two paths did it.
    await pool.query(`delete from order_payment where order_id = $1 and status = 'pending'`, [order.id]);
    return finishItemsCollection(customer, order, `Added ${matched.map((m) => `${m.quantity}x ${m.name}`).join(', ')}. `, { preferTextForQuestions: true });
  }

  const wantsQuestion = 'Are they saying yes, they would like to add one, without yet naming which specific option?';
  const wantsOneField = botEngine.defineField({
    key: 'wantsOne',
    label: 'wants one',
    type: 'boolean',
    description: describeForExtraction(wantsQuestion, { type: 'boolean' }),
  });
  const wantsOne = await botEngine.extractField(wantsOneField, text, { askJson });
  if (wantsOne === true) {
    const group = UPSELL_GROUPS.find((g) => g.key === order.pending_upsell_category);
    const menu = await resolveMenu(order.branch_id);
    const options = group ? catalogueOptions(menu, group.keywords) : [];
    // pending_upsell_category deliberately left set -- their next message
    // is still the answer to this same offer, not a fresh one.
    await reply(customer, `Great, which one would you like? We have: ${options.map((o) => o.name).join(', ')}.`, 'upsell_clarify');
    return;
  }

  order.pending_upsell_category = null;
  await pool.query('update "order" set pending_upsell_category = null where id = $1', [order.id]);
  return finishItemsCollection(customer, order, '', { preferTextForQuestions: true });
}

// A tap on sendUpsellList's List Message above -- the zero-AI-cost path,
// handled entirely separately from handlePendingUpsell (which only ever
// sees a TYPED reply now, since a list tap arrives as its own webhook
// event and never reaches dispatch()/the pending_upsell_category text
// check at all). Row ids are 'upsell::<productId>' or 'upsell::skip', set
// by sendUpsellList -- webhook-whatsapp.js routes here before its normal
// menu-list row handling, since this id space is deliberately separate
// from that one.
export async function handleUpsellListTap({ phoneNumber, channelId, rowId, channel = 'whatsapp', branchId, customer: presetCustomer }) {
  const customer = presetCustomer || (await findOrCreateCustomer({ phoneNumber, channelId, channel, branchId }));
  const order = await resolveCustomerOrder(customer);
  // Chidera, 2026-09-24: "after i said no thanks and later on i wanted to
  // add, the bot was not acknowledging my new selection, a person can
  // alsways select and itll be added." Real bug: pending_upsell_category
  // gets cleared the instant ANY offer is answered (skip or pick), so
  // tapping an item on an OLDER, already-answered bubble later -- a
  // completely legitimate change of mind -- used to require it still be
  // set, and silently did nothing once it wasn't. A tap carries a real,
  // unambiguous product id regardless of whether it's still the CURRENT
  // offer -- only a genuinely gone order (none at all, or already
  // completed/cancelled) is a real no-op.
  if (!order || ['completed', 'cancelled'].includes(order.status)) return;

  if (order.pending_upsell_category) {
    order.pending_upsell_category = null;
    await pool.query('update "order" set pending_upsell_category = null where id = $1', [order.id]);
  }

  const picked = rowId.slice('upsell::'.length);
  if (picked === 'skip') {
    await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'inbound', channel, sender: 'customer', body: '[tapped: No thanks]', processed: true });
    return finishItemsCollection(customer, order, '');
  }

  const product = await productForRowId(picked);
  if (!product) return finishItemsCollection(customer, order, '');
  await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'inbound', channel, sender: 'customer', body: `[tapped: ${product.name}]`, processed: true });
  // added_by_customer_id -- Chidera, 2026-09-20, real report ("water is
  // still categorized as guest"): a THIRD parallel insert for an upsell-
  // added item, missed by the earlier "guest-chicken" fix -- that pass
  // covered applyOrderModifications' own insert and handlePendingUpsell's
  // typed-match insert, but this one (a tap on the upsell's own WhatsApp
  // LIST message -- the default, zero-AI-cost way most customers actually
  // accept an upsell) has always had its own separate insert that never
  // set it.
  await pool.query('insert into order_item (order_id, product_id, quantity, price, added_by_customer_id) values ($1, $2, 1, $3, $4)', [order.id, product.id, product.price, customer.id]);
  // Chidera, 2026-09-20: "when an item is added, why is stale amount on
  // ready to pay still there... it should show new outstanding balance
  // na" -- same fix as applyOrderModifications' own insert; this is the
  // default, zero-AI-cost way most customers actually accept an upsell
  // (a tap on the list, not typing), and the most likely real path behind
  // this exact report. Any PENDING order_payment is now stale the moment
  // a real item gets added.
  await pool.query(`delete from order_payment where order_id = $1 and status = 'pending'`, [order.id]);
  return finishItemsCollection(customer, order, `Added ${product.name}. `);
}

// Chidera, 2026-09-24: "let them be able to pick multiple and also when
// they pick one let the + and - thing show so they can buy more than 1
// ... since upsells are more than 1 dont take them back to the menu to
// ask all those finish your order questions, just ask them in webchat
// the peppered or not and all." Web-chat only -- WhatsApp's native List
// Message has no multi-select or quantity control, so real WhatsApp
// customers stay on handleUpsellListTap above (one tap, one item,
// quantity 1, still redirects to the menu for its own questions -- that
// stays unchanged, a real cost tradeoff for real WhatsApp specifically).
// picks: [{ productId, quantity }], already deduplicated and non-empty by
// the time the route calls this.
export async function handleUpsellMultiTap({ customer, picks }) {
  const order = await resolveCustomerOrder(customer);
  // Same fix as handleUpsellListTap above -- a real product pick must not
  // silently no-op just because this isn't the CURRENT pending offer
  // anymore (e.g. picking from an older bubble after already declining a
  // later one).
  if (!order || ['completed', 'cancelled'].includes(order.status)) return;

  if (order.pending_upsell_category) {
    order.pending_upsell_category = null;
    await pool.query('update "order" set pending_upsell_category = null where id = $1', [order.id]);
  }

  const added = [];
  for (const pick of picks) {
    const product = await productForRowId(pick.productId);
    if (!product) continue;
    const quantity = Math.max(1, Math.min(20, Math.trunc(Number(pick.quantity)) || 1));
    await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'inbound', channel: 'website', sender: 'customer', body: `[tapped: ${quantity}x ${product.name}]`, processed: true });
    await pool.query('insert into order_item (order_id, product_id, quantity, price, added_by_customer_id) values ($1, $2, $3, $4, $5)', [order.id, product.id, quantity, product.price, customer.id]);
    added.push(`${quantity}x ${product.name}`);
  }
  // preferTextForQuestions: true -- "dont take them back to the menu...
  // just ask them in webchat." Already on the free web chat page; a
  // redirect out to /m/:token for one short question is a worse
  // experience here than just asking it, same reasoning
  // handlePendingItemQuestion's own text-originated callers already use.
  if (!added.length) return finishItemsCollection(customer, order, '', { preferTextForQuestions: true });
  await pool.query(`delete from order_payment where order_id = $1 and status = 'pending'`, [order.id]);
  return finishItemsCollection(customer, order, `Added ${added.join(', ')}. `, { preferTextForQuestions: true });
}

// The reply to a question just asked by askNextItemQuestion above -- taken
// literally as the answer (no yes/no or item-change classification here on
// purpose, this is a short, deliberately simple exchange), recorded both
// as a real (order_item, question) fact and folded into order_item.modification
// for anywhere that already displays that column (Kanban card, order
// detail). Then either the next unanswered question, or back into the
// normal flow via finishItemsCollection once every item's questions are done.
export async function handlePendingItemQuestion(customer, order, text) {
  const answer = text.trim();
  const pendingQuestionId = order.pending_question_id;
  const pendingItemId = order.pending_question_order_item_id;
  // Chidera, 2026-09-25, real live report: "while placing my order after
  // the bot upsold me a drink and i chose cold it sent me double reply."
  // A genuine race, not a UI bug: this question can be answered two ways
  // almost at once (a dropdown tap and typed text arriving together, or
  // two rapid taps before the client's own in-flight guard registers) --
  // both requests read the SAME pending_question_id before either one
  // cleared it (the clear used to happen at the very END, after all the
  // real work), so both ran the full apply-and-reply path, each sending
  // its own "Got it..." message. Claiming the question atomically FIRST
  // (only clearing it if it's still what was just read) means the
  // second, losing request finds nothing left to claim and does nothing
  // more, instead of running the whole flow twice.
  const { rows: claimed } = await pool.query(
    `update "order" set pending_question_order_item_id = null, pending_question_id = null
     where id = $1 and pending_question_id = $2 returning id`,
    [order.id, pendingQuestionId]
  );
  if (!claimed.length) return; // someone else already answered this exact question
  order.pending_question_order_item_id = null;
  order.pending_question_id = null;

  const { rows: qRows } = await pool.query('select question from product_question where id = $1', [pendingQuestionId]);
  const questionText = qRows[0]?.question || '';

  await pool.query(
    `insert into order_item_answer (order_item_id, question_id, answer) values ($1, $2, $3)
     on conflict (order_item_id, question_id) do update set answer = excluded.answer`,
    [pendingItemId, pendingQuestionId, answer]
  );
  const { rows: itemRows } = await pool.query('select modification from order_item where id = $1', [pendingItemId]);
  const existingMod = itemRows[0]?.modification;
  const newMod = existingMod ? `${existingMod}; ${questionText}: ${answer}` : `${questionText}: ${answer}`;
  await pool.query('update order_item set modification = $1 where id = $2', [newMod, pendingItemId]);

  // finishItemsCollection's own item-question check (its very first thing)
  // picks up the next unanswered question itself if there is one -- no
  // need to duplicate that lookup here too. preferTextForQuestions --
  // they just answered this one by typing, so a second outstanding
  // question stays in text too, not a web-link detour.
  return finishItemsCollection(customer, order, 'Got it. ', { preferTextForQuestions: true });
}

// Chidera, 2026-09-24: "can i have it as a dropdown they can choose, and
// an optional type extra note if they have extra." routes/web-chat.js's
// own POST /:token/tap door for the select-plus-optional-note sheet
// (sendItemQuestionAsChoice's own interactive bubble) -- composes the
// exact same "Option (note)" shape the web menu page's own qSheet already
// stores (order_item_answer.answer is still just one plain string either
// way), then reuses handlePendingItemQuestion verbatim, same as a typed
// answer would. Deterministic, zero AI call, same shape as
// handleUpsellListTap/handleOrderConfirmYesTap.
export async function handleItemQuestionChoiceTap({ customer, option, note }) {
  const order = await resolveCustomerOrder(customer);
  // A stale tap (the order's moved on, or this question's already been
  // answered another way) -- nothing to do, same "stale tap = no-op"
  // reasoning as handleUpsellListTap's own guard.
  if (!order || !order.pending_question_id || ['completed', 'cancelled'].includes(order.status)) return;
  const trimmedOption = String(option || '').trim();
  if (!trimmedOption) return;
  const trimmedNote = String(note || '').trim();
  const answer = trimmedNote ? `${trimmedOption} (${trimmedNote})` : trimmedOption;
  await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'inbound', channel: 'website', sender: 'customer', body: `[selected: ${answer}]`, processed: true });
  return handlePendingItemQuestion(customer, order, answer);
}

// "Confirmed" (order.status) and "engine_state = confirm_order" are not the
// same fact -- engine_state stays confirm_order for both the yes/no ask AND
// the fulfilment questions that follow a yes, since delivery-vs-pickup
// still isn't decided yet either way. status flips to 'confirmed' the
// moment they say yes, which is what dispatch() below uses to tell "still
// deciding whether to order this" from "ordering it, now working out how it
// gets to them" -- asking for an address is not the same step as agreeing
// to buy.
export async function handleConfirmOrder(customer, order, text) {
  // A plain "no" doesn't reliably mean "cancel this entirely" -- they may
  // just want to change something, or hesitate for a reason unrelated to
  // wanting out. So "no" never cancels here: it just asks what to change,
  // and leaves the order exactly as it is (still open, nothing lost). A
  // real modification ("remove the suya wrap") is already caught earlier
  // in dispatch(), before this function is even reached. There's no
  // customer-facing way to actively cancel anymore -- an order that's
  // genuinely abandoned just ages out on its own (see closeStaleOrders).
  const confirmQuestion = 'Are they confirming yes, ready to go ahead with this order as it is?';
  const confirmedField = botEngine.defineField({
    key: 'confirmed',
    label: 'confirmation',
    type: 'boolean',
    description: describeForExtraction(confirmQuestion, { type: 'boolean' }),
  });
  const value = await botEngine.extractField(confirmedField, text, { askJson });
  if (value === null || value === false) {
    // Not a plain yes doesn't mean nothing was actually said -- a real
    // question ("does that include delivery?") deserves a real answer, not
    // a rigid repeat of the same prompt regardless of what they asked.
    const answer = await answerOrThenShowMenu(customer, order, text, `Waiting on them to confirm yes, or say what they would like to change.`);
    if (answer) {
      await reply(customer, `${answer} Just let me know, yes to confirm, or what you would like to change.`);
      return;
    }
    // dispatch() already ran extractOrderModifications on this exact text
    // before handleConfirmOrder was ever reached, and it found nothing --
    // but that's a stricter AI call, reasoning about whether this is a
    // CHANGE to the current order. Found live, 2026-09-10: "I'll have
    // chapman" failed that stricter check and fell all the way through to
    // a canned non-answer, even though the plainer item-matcher
    // (extractOrderItems, same one used for a fresh order) reads it
    // correctly every time. One more, more lenient try before giving up --
    // a name-only, deterministic reply, not the vague generic one.
    const { matched } = await extractOrderItems(text, order.branch_id);
    if (matched.length) {
      await handleOrderModification(customer, order, { adds: matched, removes: [], sets: [] });
      return;
    }
    await reply(customer, 'No problem, just let me know what you would like to change, or reply yes to confirm as is.');
    return;
  }

  await markOrderConfirmed(customer, order);
}

// Chidera, 2026-09-20: "when they add on send them the yes to confirm
// button and place the ordr" -- the staff "table added more" alert
// (resetServedForAddOn) fires HERE, on the real yes, not the moment the
// item was inserted -- same two-step "shown, then confirmed" shape the
// very first round of an order already has. order.served_at still holds
// whatever it was before this round started (nothing resets it earlier
// anymore), so this is a genuine no-op for a first-ever order (never
// served yet) and the real, intended alert for a repeat add-on round on a
// table that had already been served. Shared by handleConfirmOrder (a
// genuine typed "yes") and handleOrderConfirmYesTap below (a tap on the
// button itself) so both converge on the exact same confirmation.
export async function markOrderConfirmed(customer, order) {
  await pool.query(`update "order" set confirmed_at = now() where id = $1`, [order.id]);
  order.confirmed_at = new Date();
  await resetServedForAddOn(order);
  await handleCollectFulfilment(customer, order, null);
}

// Same yes/no gate as handleConfirmOrder, but for the case where an edit
// landed AFTER fulfilment was already resolved and payment instructions
// already sent once (engine_state is already 'confirm_payment' -- see
// handleOrderModification). Deliberately does NOT call
// handleCollectFulfilment: fulfilment_type/address are already known and
// re-running that would both re-ask something already answered and, since
// engine_state never left 'confirm_payment', hit an illegal
// confirm_payment -> confirm_payment transition in transitionOrder. A plain
// yes here just re-sends payment instructions for the new total.
export async function handleReconfirmAfterEdit(customer, order, text) {
  // Same reasoning as handleConfirmOrder above -- "no" never cancels, it
  // just asks what to change and leaves the order (and the edit already
  // made) exactly as it is.
  const confirmQuestion = 'Are they confirming yes, ready to go ahead with the updated order as it is?';
  const confirmedField = botEngine.defineField({
    key: 'confirmed',
    label: 'confirmation',
    type: 'boolean',
    description: describeForExtraction(confirmQuestion, { type: 'boolean' }),
  });
  const value = await botEngine.extractField(confirmedField, text, { askJson });
  if (value === null || value === false) {
    const answer = await answerOrThenShowMenu(customer, order, text, `Waiting on them to confirm yes, or say what they would like to change, on the updated order.`);
    await reply(customer, answer ? `${answer} Just let me know, yes to confirm, or what you would like to change.` : 'No problem, just let me know what you would like to change, or reply yes to confirm as is.');
    return;
  }

  await pool.query(`update "order" set confirmed_at = now() where id = $1`, [order.id]);
  order.confirmed_at = new Date();
  await sendPaymentInstructions(customer, order);
}

// Buttons instead of plain text for the one field with a real small,
// fixed set of options worth tapping -- Chidera 2026-09-11: "make
// delivery or pickup clickable buttons." Every other field (branch,
// delivery address, ...) still goes through the plain-text fieldPrompt
// unchanged; this only intercepts fulfilment_type specifically. A tap
// sends its own title ("Delivery"/"Pickup") back through the normal text
// pipeline (webhook-whatsapp.js), so extractAndApply/applyField handle it
// exactly the same way a typed answer already does -- no new parsing.
export async function sendFieldPrompt(customer, fieldKey, promptText, trigger) {
  if (fieldKey === 'fulfilment_type' && (customer.channel === 'whatsapp' || customer.channel === 'website')) {
    const buttons = [
      { id: 'fulfilment_delivery', title: 'Delivery' },
      { id: 'fulfilment_pickup', title: 'Pickup' },
    ];
    if (customer.channel === 'website') {
      await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel: customer.channel, sender: 'bot', body: promptText, trigger: trigger || 'bot_flow_step', interactive: { type: 'buttons', buttons } });
      return;
    }
    const credentials = await getWhatsAppCredentials(customer.branch_id);
    await sendWhatsAppButtons(recipientFor(customer), promptText, buttons, credentials);
    await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel: customer.channel, sender: 'bot', body: promptText, trigger: trigger || 'bot_flow_step' });
    return;
  }
  await reply(customer, promptText, trigger);
}

// Buttons for the delivery-area yes/no confirmation -- same reasoning and
// same "tap sends its title back through the normal text pipeline, no new
// parsing" shape as sendFieldPrompt's fulfilment_type buttons just above
// (Chidera, 2026-09-16: "when bot is confirming a delivery address...let
// it use button clicks of yes and no"). A tap arrives as plain text
// ("Yes"/"No"), so handleCollectFulfilment's existing
// botEngine.extractField boolean classification below needs no changes at
// all -- it already understands "Yes"/"No" as well as any typed answer.
async function sendYesNoConfirm(customer, promptText) {
  if (customer.channel === 'whatsapp' || customer.channel === 'website') {
    const buttons = [
      { id: 'confirm_yes', title: 'Yes' },
      { id: 'confirm_no', title: 'No' },
    ];
    if (customer.channel === 'website') {
      await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel: customer.channel, sender: 'bot', body: promptText, trigger: 'bot_flow_step', interactive: { type: 'buttons', buttons } });
      return;
    }
    const credentials = await getWhatsAppCredentials(customer.branch_id);
    await sendWhatsAppButtons(recipientFor(customer), promptText, buttons, credentials);
    await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel: customer.channel, sender: 'bot', body: promptText, trigger: 'bot_flow_step' });
    return;
  }
  await reply(customer, promptText);
}

export async function handleCollectFulfilment(customer, order, text) {
  // Dine-in (payment_mode = 'at_table') never asks for delivery/pickup or
  // takes payment through the bot -- spec 5.4: "settled at the table...
  // the order completes without a payment confirmation step." Still walks
  // the real state machine (confirm_payment -> payment_acceptance ->
  // fulfilment are the only legal next steps from confirm_order, see
  // bot_state's seed data), just with no message or wait at any of them --
  // same status handling completePayment gives every other order, minus
  // the delivery/pickup-specific messaging that makes no sense for someone
  // already sitting at the table.
  if (order.payment_mode === 'at_table') {
    await transitionOrder(order, 'confirm_payment');
    await transitionOrder(order, 'payment_acceptance');
    await pool.query(`update "order" set status = 'preparation' where id = $1`, [order.id]);
    await transitionOrder(order, 'fulfilment');
    await reply(customer, 'Your order has been placed. Thank you 🙏\n\nIt will be with you shortly.', 'dinein_order_placed');
    return;
  }

  const outstanding = await missingFulfilmentFields(order);
  if (outstanding.length && text !== null) {
    const fields = await loadBotFields();
    const field = fields.find((f) => f.key === outstanding[0]);
    const extracted = await extractAndApply({ fieldKey: outstanding[0], message: text, contextQuestion: field?.question, order });
    if (extracted === null) {
      // Same principle as everywhere else -- not a clean answer to this
      // field doesn't mean nothing was actually asked.
      const answer = await answerOrThenShowMenu(customer, order, text, `Deciding on ${outstanding[0] === 'delivery_address' ? 'the delivery address' : 'delivery or pickup'}.`);
      // Only the no-answer branch is a genuine "didn't understand" signal --
      // when `answer` is set the customer asked a real question and this is
      // just the normal follow-up prompt after answering it, not a miss.
      if (answer) {
        await sendFieldPrompt(customer, outstanding[0], `${answer} ${await fieldPrompt(outstanding[0], field?.question, order.branch_id)}`);
      } else {
        await sendFieldPrompt(customer, outstanding[0], await fieldPrompt(outstanding[0], field?.question, order.branch_id), 'field_reprompt');
      }
      return;
    }
    const { rows: reloaded } = await pool.query('select * from "order" where id = $1', [order.id]);
    Object.assign(order, reloaded[0]);
  }

  const stillOutstanding = await missingFulfilmentFields(order);
  if (stillOutstanding.length) {
    // Chidera, 2026-09-20: "let delivery/pickup details processing ... be
    // processes in the flow on the website to save cost" -- one web link
    // covers delivery-vs-pickup, the real address, AND (own_riders) a real
    // zone dropdown in a single visit, instead of the multi-message
    // text chain this used to be (delivery or pickup? -> address? ->
    // "is that X area?" -> confirm/retry ...). A customer who ignores the
    // link and just types an answer anyway still works exactly as before
    // (the `text !== null` block above this one is untouched) -- this is
    // the cheaper default, never the only path.
    const shownLink = await sendWebMenuLink(customer, 'Just need your delivery/pickup details -- tap below to finish up.', 'Finish my order', null, null, order);
    if (shownLink) return;
    const fields = await loadBotFields();
    const nextField = fields.find((f) => f.key === stillOutstanding[0]);
    await sendFieldPrompt(customer, stillOutstanding[0], await fieldPrompt(stillOutstanding[0], nextField?.question, order.branch_id));
    return;
  }

  // Only known once fulfilment_type/address are actually decided -- adding
  // this before payment means the customer pays the real delivery cost
  // instead of the business quietly absorbing it. No-op (returns 0) for
  // pickup orders and for any business not on real Chowdeck delivery.
  if (order.fulfilment_type === 'delivery') {
    const deliveryConfig = await getDeliveryConfig();
    if (deliveryConfig.mode === 'own_riders' && !order.delivery_zone_id) {
      // Three states, same null/non-null gate idiom confirm_order's own
      // confirmed_at uses (see schema.sql's comment on the two columns
      // below): a candidate zone awaiting yes/no, "already asked what area
      // this is" awaiting their answer, or neither yet (first pass).
      // Chidera's call, 2026-09-02: a matched zone is never applied
      // silently any more -- always confirmed first -- and a miss asks the
      // customer directly for the area instead of giving straight up to a
      // human. Persisted the moment it's actually confirmed (not
      // re-resolved at dispatch time) so the price the customer is about
      // to pay and the amount the rider is eventually owed both come from
      // the exact same zone row -- see schema.sql's own comment on
      // order.delivery_zone_id.
      if (order.delivery_zone_candidate_id) {
        const confirmQuestion = 'Are they confirming yes, that this is the right delivery area?';
        const confirmedField = botEngine.defineField({
          key: 'area_confirmed',
          label: 'delivery area confirmation',
          type: 'boolean',
          description: describeForExtraction(confirmQuestion, { type: 'boolean' }),
        });
        const confirmed = text === null ? null : await botEngine.extractField(confirmedField, text, { askJson });
        if (confirmed === true) {
          const { rows: zoneRows } = await pool.query('select * from delivery_zone where id = $1', [order.delivery_zone_candidate_id]);
          const zone = zoneRows[0];
          await pool.query(
            `update "order" set delivery_zone_id = $1, delivery_fee = $2, delivery_zone_candidate_id = null where id = $3`,
            [zone.id, zone.customer_fee, order.id]
          );
          order.delivery_zone_id = zone.id;
          order.delivery_fee = Number(zone.customer_fee);
          // Falls through below to total/payment -- confirmed, nothing left to ask.
        } else if (confirmed === false) {
          // Try the rejection itself before falling back to a blind
          // re-ask -- "no, it's Wuse" says both in one message, and
          // resolveZoneForAddress's plain substring match catches that.
          const retry = await resolveZoneForAddress(text, order.branch_id);
          if (retry) {
            await pool.query(`update "order" set delivery_zone_candidate_id = $1 where id = $2`, [retry.id, order.id]);
            order.delivery_zone_candidate_id = retry.id;
            await sendYesNoConfirm(customer, `Got it, just to confirm, is that delivery to ${retry.name}?`);
            return;
          }
          await pool.query(
            `update "order" set delivery_zone_candidate_id = null, delivery_area_prompted_at = now() where id = $1`,
            [order.id]
          );
          order.delivery_zone_candidate_id = null;
          order.delivery_area_prompted_at = new Date();
          await reply(customer, 'No problem -- please, what area is this delivery for?');
          return;
        } else {
          const { rows: zoneRows } = await pool.query('select name from delivery_zone where id = $1', [order.delivery_zone_candidate_id]);
          await sendYesNoConfirm(customer, `Just to confirm, is that delivery to ${zoneRows[0]?.name}?`);
          return;
        }
      } else if (!order.delivery_area_prompted_at) {
        const zone = await resolveZoneForAddress(customer.address, order.branch_id);
        if (zone) {
          await pool.query(`update "order" set delivery_zone_candidate_id = $1 where id = $2`, [zone.id, order.id]);
          order.delivery_zone_candidate_id = zone.id;
          await sendYesNoConfirm(customer, `Just to confirm, is that delivery to ${zone.name}?`);
          return;
        }
        await pool.query(`update "order" set delivery_area_prompted_at = now() where id = $1`, [order.id]);
        order.delivery_area_prompted_at = new Date();
        await reply(customer, 'Please, what area is this delivery for?');
        return;
      } else {
        const zone = text === null ? null : await resolveZoneForAddress(text, order.branch_id);
        if (zone) {
          await pool.query(`update "order" set delivery_zone_candidate_id = $1 where id = $2`, [zone.id, order.id]);
          order.delivery_zone_candidate_id = zone.id;
          await sendYesNoConfirm(customer, `Just to confirm, is that delivery to ${zone.name}?`);
          return;
        }
        // Never guess a zone (spec B5) -- a wrong one means a wrong price
        // charged to the customer and a wrong amount owed to a rider, both
        // real money. Same handover primitive sendPaymentInstructions
        // already uses when bank details aren't configured.
        await handover(customer, 'Delivery address could not be matched to a delivery zone');
        return;
      }
    } else if (deliveryConfig.mode !== 'own_riders') {
      const deliveryFee = await estimateDeliveryFee(order, customer);
      if (deliveryFee > 0) {
        await pool.query(`update "order" set delivery_fee = $1 where id = $2`, [deliveryFee, order.id]);
        order.delivery_fee = deliveryFee;
      }
    }
  }
  const { total } = await summariseOrder(order);
  await pool.query(`update "order" set total = $1 where id = $2`, [total, order.id]);
  order.total = total;

  await transitionOrder(order, 'confirm_payment');
  await sendPaymentInstructions(customer, order);
}

// Reviewing an order isn't a one-shot thing -- "add a chapman" or "remove
// the suya wrap" can come at any point before payment, and recalculates the
// total live. Once payment_status is actually confirmed/accepted, removing
// or changing what's already paid for is refused (that money's real,
// already moving), but adding more is still fine -- it just means extra to
// collect, flagged to staff rather than assumed handled.
// The real DB mutation behind an "add X" / "remove Y" / "make it 3 Z"
// request -- shared between handleOrderModification (confirm_order onward,
// its own "reply yes to confirm" messaging) and the earlier collect_info
// stage (handleCollectInfo, a different, softer acknowledgment since the
// order hasn't reached that gate yet). Same mutation either way, just
// different words wrapped around it per stage.
// Removing an order_item that still has an item-customization question
// pending on it (order.pending_question_order_item_id -- "peppered or
// not?", asked per-item, see line ~1136) hit the row's own foreign key
// live, 2026-09-11: deleting it while that column still pointed at it
// threw order_pending_question_order_item_id_fkey, a 500 on both the AI
// "remove X" path and the web menu's "Review order" (a removed item that
// happened to still be mid-question). Clearing the pointer first -- same
// as a normal answer would once it's actually answered -- is the fix,
// not skipping the delete or working around the constraint.
export async function clearPendingQuestionIfOnItem(order, orderItemId) {
  if (order.pending_question_order_item_id !== orderItemId) return;
  order.pending_question_order_item_id = null;
  order.pending_question_id = null;
  await pool.query('update "order" set pending_question_order_item_id = null, pending_question_id = null where id = $1', [order.id]);
}

// customer -- Chidera, 2026-09-20, real report: "what do you mean by a
// guest-chicken... was it not the same number that ordered chicken
// through an upsell? why are you seperating it?" Root cause: this insert
// never set added_by_customer_id at all, unlike the web-menu review
// route's own item insert (which always does) -- so any item added
// through a typed-chat path, upsell acceptance included
// (handlePendingUpsell below), landed with added_by_customer_id null,
// and pendingOrderPayload's labelFor falls back to "a guest" for a null
// id no matter whose real number it actually was. Now attributed to
// whichever customer is actually in this conversation, same as every
// other item-adding path already does.
export async function applyOrderModifications(order, mods, { allowRemovals }, customer) {
  const { rows: existingItems } = await pool.query('select id, product_id, quantity from order_item where order_id = $1', [order.id]);
  let addedValue = 0;

  for (const item of mods.adds) {
    const existing = existingItems.find((e) => e.product_id === item.productId);
    if (existing) {
      await pool.query('update order_item set quantity = quantity + $1 where id = $2', [item.quantity, existing.id]);
    } else {
      await pool.query('insert into order_item (order_id, product_id, quantity, price, added_by_customer_id) values ($1, $2, $3, $4, $5)', [order.id, item.productId, item.quantity, item.price, customer?.id || null]);
    }
    addedValue += item.quantity * Number(item.price);
  }

  if (allowRemovals) {
    for (const item of mods.removes) {
      const existing = existingItems.find((e) => e.product_id === item.productId);
      if (existing) await clearPendingQuestionIfOnItem(order, existing.id);
      await pool.query('delete from order_item where order_id = $1 and product_id = $2', [order.id, item.productId]);
    }
    for (const item of mods.sets) {
      await pool.query('update order_item set quantity = $1 where order_id = $2 and product_id = $3', [item.quantity, order.id, item.productId]);
    }
  }

  const { itemLines, total, deliveryFee } = await summariseOrder(order);
  await pool.query('update "order" set total = $1 where id = $2', [total, order.id]);
  // Chidera, 2026-09-20, real report: "after requesting payment and its
  // pending i added another water... it kept showing me old stale
  // amount" -- same fix as routes/dinein-menu.js's own /review route, for
  // this (typed-chat) add-on path. Any PENDING order_payment is frozen at
  // whatever the order totalled when it was requested; a real item change
  // makes that stale regardless of which channel added it. Confirmed
  // payments are real money already received and untouched here.
  if (mods.adds.length || (allowRemovals && (mods.removes.length || mods.sets.length))) {
    await pool.query(`delete from order_payment where order_id = $1 and status = 'pending'`, [order.id]);
  }
  // A dine-in order already marked served that gets something added to it
  // needs serving again -- back to In House's first pipeline, not sitting
  // in the second (awaiting payment) still showing the old items. Chidera
  // 2026-09-11: "even if staff marks served and it goes to the next
  // pipeline and they still add it should go back to first pipeline."
  //
  // Deliberately NOT fired here anymore -- Chidera, 2026-09-20: "when they
  // add on send them the yes to confirm button and place the ordr." This
  // used to fire the moment an item was inserted, before the customer had
  // even confirmed the add-on -- staff could see "back to Serving" before
  // the guest had actually decided to go through with it. handleConfirmOrder
  // now calls resetServedForAddOn itself, on the real yes tap, same two-
  // step "shown, then confirmed" shape the very first round already has.
  return { itemLines, total, deliveryFee, addedValue };
}

// Adding items to an already-paid order gets its own, smaller invoice --
// only what's newly owed, not the whole order total again (the rest is
// already paid). Chidera 2026-09-11: "calculate only their new add on and
// send them an invoice for top up, no need for hsndvover just take the
// order normally" -- no escalation to a human here, staff instead see it
// land in the order's own page (OrderDetail.jsx's Top-ups card), the same
// way the payment-proof gallery replaces a handover ping for a repeat
// proof image.
export async function sendTopupInvoice(customer, order, addedItems, addedValue) {
  const snapshot = addedItems.map((i) => ({ name: i.name, quantity: i.quantity, price: i.price }));
  const { rows: topupRows } = await pool.query(
    `insert into order_topup (order_id, items, amount) values ($1, $2, $3) returning id`,
    [order.id, JSON.stringify(snapshot), addedValue]
  );
  const topupId = topupRows[0].id;
  const itemLines = snapshot.map((i) => `${i.quantity}x ${i.name} -- NGN ${i.quantity * Number(i.price)}`).join('\n');

  const invoicePath = `/documents/topup/${topupId}`;
  let invoiceSent = false;
  if (process.env.PUBLIC_URL) {
    try {
      const invoicePdfUrl = `${process.env.PUBLIC_URL}${invoicePath}/pdf`;
      if (customer.channel === 'instagram') {
        // Same fix as sendPaymentInstructions' own 2026-09-26 comment above --
        // no PDF file attachment for Instagram (opens via its own Facebook-
        // branded viewer); invoiceSent stays false so the invoiceUrl
        // text-link fallback below links to the plain HTML page instead.
      } else if (customer.channel === 'website') {
        // Same fix as sendPaymentInstructions' website branch above -- link
        // to the plain HTML topup invoice page, not /pdf (Gotenberg-backed,
        // internal-only, and never actually rendered before this bubble was
        // marked "sent").
        const invoiceHtmlUrl = `${process.env.PUBLIC_URL}${invoicePath}`;
        await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel: customer.channel, sender: 'bot', body: `[topup invoice] ${invoiceHtmlUrl}`, trigger: 'topup_invoice_pdf', interactive: { type: 'document', filename: `topup-${order.reference}`, url: invoiceHtmlUrl } });
        invoiceSent = true;
      } else {
        await sendWhatsAppDocument(recipientFor(customer), invoicePdfUrl, `topup-${order.reference}.pdf`, `Top-up invoice for order ${order.reference}`);
        await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel: customer.channel, sender: 'bot', body: `[topup invoice PDF] ${invoicePdfUrl}`, trigger: 'topup_invoice_pdf' });
        invoiceSent = true;
      }
    } catch (err) {
      console.error(`Failed to send top-up invoice PDF, falling back to a text link: ${err.message}`);
    }
  }
  const invoiceUrl = process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL}${invoicePath}` : null;
  const invoiceLine = invoiceSent
    ? `Your top-up invoice is attached above.`
    : invoiceUrl
      ? `Here's your top-up invoice: ${invoiceUrl}`
      : `Your top-up invoice is ready.`;

  // Chidera, 2026-09-20: "totally stop sending account number for era
  // demo and use just paystack" -- used to be deliberately bank-transfer-
  // only (own comment here said reusing order.reference would collide
  // with the original payment's own Paystack transaction). Now that every
  // reference is unique per attempt (payment.js's callPaystackInitialize),
  // that blocker's gone -- try Paystack first, same as buildPayLine
  // already does for the main order, falling back to bank details only
  // when Paystack genuinely isn't configured or the call itself fails.
  let paymentUrl = null;
  if (process.env.PAYMENT_PROVIDER === 'paystack' && process.env.PAYMENT_SECRET_KEY) {
    try {
      // 2026-09-26: same fix as sendPaymentInstructions' own Paystack/Monnify
      // branches -- resolveBackToChatUrl instead of always /wa/:token.
      const menuToken = await ensureMenuToken(customer);
      const callbackUrl = (await resolveBackToChatUrl(customer, menuToken)) || undefined;
      paymentUrl = await initializePaystackTopupTransaction({ topupId, order, customer, amount: addedValue, callbackUrl });
    } catch (err) {
      console.error(`Paystack initialize failed for topup ${topupId}, falling back to bank details: ${err.message}`);
    }
  }
  if (paymentUrl) {
    const payLine = `Please pay NGN ${addedValue} for the extra item(s) using the button below.`;
    await sendPaymentLinkButton(customer, paymentUrl, `Got it, added on:\n${itemLines}\n\n${invoiceLine}\n\n${payLine}`);
    return;
  }
  const { rows: biz } = await pool.query('select bank_name, bank_account_number, bank_account_name from business limit 1');
  const b = biz[0] || {};
  const hasBankDetails = b.bank_name && b.bank_account_number && b.bank_account_name;
  const payLine = hasBankDetails
    ? `Please pay NGN ${addedValue} for the extra item(s).\n\nBank: ${b.bank_name}\nAccount number: ${b.bank_account_number}\nAccount name: ${b.bank_account_name}\n\nThen send proof of payment here.`
    : `You owe an extra NGN ${addedValue} for this. Let me get someone to confirm payment details with you.`;

  await reply(customer, `Got it, added on:\n${itemLines}\n\n${invoiceLine}\n\n${payLine}`);
  if (!hasBankDetails) await handover(customer, 'Top-up order ready for payment but no payment method is configured for this business yet', null, false);
}

export async function handleOrderModification(customer, order, mods) {
  const paid = order.payment_status === 'confirmed' || order.payment_status === 'accepted';
  // Captured before applyOrderModifications -- Chidera, 2026-09-20: "when
  // they add on send them the yes to confirm button and place the ordr."
  // Dine-in never sets payment_status to confirmed/accepted until it's
  // actually marked paid post-serving (payment happens AFTER eating), so
  // `paid` above is always false for a served-but-unpaid table -- an
  // add-on there used to fall all the way through to the same full "Got
  // it, your order: [the WHOLE running bill] New total... confirm?"
  // re-ask every other pre-payment edit gets. wasAlreadyConfirmed (this
  // order already went through its own real yes once before) is what
  // actually distinguishes a repeat add-on from the genuinely first-ever
  // order -- a repeat round still gets its own real yes/no confirm gate,
  // just scoped to what's new (deltaLines below), not the whole order
  // restated again.
  const wasAlreadyConfirmed = Boolean(order.confirmed_at);
  // Chidera, 2026-09-25: "if a customer places an order in dine in and
  // changes it in a form of reduction... kitchen would have already
  // started preparing order and theyll get a price reduction for what
  // has been placed?" A real gap the `paid` check above never covers --
  // dine-in's own payment_status stays 'pending' the whole meal (settled
  // at the end, not up front, see this function's own comment above), so
  // a round already confirmed and sent to the kitchen (confirming a round
  // IS what dispatches it -- markOrderConfirmed's "place the ordr") could
  // still have items silently removed and the price quietly dropped, with
  // no one on staff any the wiser that food already being cooked just got
  // taken off the bill. Same escalate-to-a-human treatment as an
  // already-paid order gets below, just gated on "already sent to the
  // kitchen" instead of "already paid" for this one channel.
  const alreadySentToKitchen = order.payment_mode === 'at_table' && wasAlreadyConfirmed;

  if ((paid || alreadySentToKitchen) && (mods.removes.length || mods.sets.length)) {
    // A change/removal after payment needs a real person -- Chidera
    // 2026-09-11: "after payment is made if they want to add take it and
    // add it, but if they want to change, hand it over to a human."
    // Adding more still goes straight through below unchanged (falls
    // through to the adds-only branch when mods.adds is also non-empty);
    // it's only removing or changing what's already paid for (or, for
    // dine-in, already sent to the kitchen) that gets escalated instead
    // of just being declined.
    await reply(
      customer,
      paid
        ? `Your order's already paid for, so I can't remove or change what's in it myself -- let me get someone to help with that.`
        : `That order is already gone to the kitchen, so I can't remove or change what's in it myself -- let me get someone to help with that.`
    );
    // Chidera, 2026-09-25: "then tell staff in handover text what is the
    // table name, what they also want to remove" -- same reasoning as
    // routes/dinein-menu.js's own web-basket-resubmit version of this
    // exact escalation (its own comment has the full story); this is the
    // typed-chat path (a dine-in guest typing "remove the rice" instead of
    // using the menu page), table_id is null for a paid online order so
    // that line is simply omitted there, not shown blank.
    const removedLines = [...mods.removes.map((i) => `${i.quantity}x ${i.name}`), ...mods.sets.map((i) => `${i.name} to ${i.quantity}`)];
    const { rows: tableRowsForHandover } = order.table_id
      ? await pool.query('select label from restaurant_table where id = $1', [order.table_id])
      : { rows: [] };
    await handover(
      customer,
      paid ? 'Customer wants to remove or change items on an already-paid order' : 'Customer wants to remove or change items already sent to the kitchen',
      {
        table: tableRowsForHandover[0] ? `Table: ${tableRowsForHandover[0].label}` : null,
        wants: removedLines.length ? `Wants to remove/change: ${removedLines.join(', ')}` : null,
      },
      false
    );
    if (!mods.adds.length) return;
  }

  const { itemLines, total, deliveryFee, addedValue } = await applyOrderModifications(order, mods, { allowRemovals: !(paid || alreadySentToKitchen) }, customer);
  // Chidera, 2026-09-23, live report on era-demo: "it gave me a bill of
  // food with total of 4700 my food way 1700 but it didnt state the
  // delivery there, one could easily misunderstand" -- summariseOrder's
  // own `total` has always silently included delivery_fee, this message
  // only ever listed the items. Same fix as handleWebMenuOrder's own
  // confirm message.
  const summary = deliveryFee > 0 ? `${itemLines.join('\n')}\nDelivery fee: NGN ${deliveryFee}` : itemLines.join('\n');

  if (paid) {
    await sendTopupInvoice(customer, order, mods.adds, addedValue);
    return;
  }

  // Pure addition only -- a removal or change alongside it is a rarer,
  // more substantial edit that still deserves the fuller read-back below,
  // not folded into a quick "add on" confirm that would silently skip
  // over what was taken off. preferTextForQuestions -- this whole path
  // only runs from a TYPED reply (dispatch's own mods-detection), so any
  // item question the new line needs stays in text too (Chidera,
  // 2026-09-20, real report re Emmanuel: "if they are already using text
  // no need to send them back to the menu... just go text it").
  if (wasAlreadyConfirmed && mods.adds.length && !mods.removes.length && !mods.sets.length) {
    await pool.query(`update "order" set confirmed_at = null where id = $1`, [order.id]);
    order.confirmed_at = null;
    const deltaLines = mods.adds.map((i) => `${i.quantity}x ${i.name}`);
    await restartItemsCollection(order);
    return finishItemsCollection(customer, order, '', { preferTextForQuestions: true, deltaLines });
  }

  // Any edit before payment needs a fresh yes -- whether still picking
  // items (confirm_order) or already past that gate with payment
  // instructions already sent for the old total (confirm_payment). Only the
  // yes/no gate resets here; fulfilment (delivery vs pickup, address) is
  // never touched, so re-confirming never re-asks something already
  // answered. engine_state itself is deliberately left alone -- if it's
  // already confirm_payment, handleReconfirmAfterEdit re-sends payment
  // instructions directly on the next yes, it never routes back through
  // handleCollectFulfilment (whose own transitionOrder(..., 'confirm_payment')
  // would be an illegal confirm_payment -> confirm_payment move).
  await pool.query(`update "order" set confirmed_at = null where id = $1`, [order.id]);
  order.confirmed_at = null;
  await sendConfirmButtons(customer, `Got it, your order:\n${summary}\nNew total: NGN ${total}.`, 'order_confirm_asked');
}

// Switching delivery<->pickup after it was already set (dispatch() only
// calls this once payment isn't done yet -- see the rule at the top of
// dispatch). delivery_fee always resets to 0 first: switching to pickup
// means no fee at all, and switching to delivery means the old fee (quoted
// for a stale state) is stale and has to be re-quoted, not reused.
export async function handleFulfilmentChange(customer, order, newType) {
  await pool.query(`update "order" set fulfilment_type = $1, delivery_fee = 0 where id = $2`, [newType, order.id]);
  order.fulfilment_type = newType;
  order.delivery_fee = 0;

  if (order.engine_state === 'confirm_order') {
    // Payment instructions were never sent yet -- handleCollectFulfilment
    // already does everything a fresh answer would (ask for an address if
    // one's still needed, quote the real delivery fee, transition, and send
    // payment instructions once nothing's missing), so just re-run it.
    await reply(customer, `Got it, switching to ${newType}.`);
    await handleCollectFulfilment(customer, order, null);
    return;
  }

  // confirm_payment -- payment instructions already went out once for the
  // old fulfilment/total, so this has to redo the fee estimate and re-send
  // fresh instructions, not just silently update a number nobody sees.
  //
  // Chidera, 2026-09-16: "when i switch to delivery why did it send me 2
  // messages of what is your delivery address" -- this used to ask for the
  // address itself right here, then immediately call handleCollectFulfilment
  // below, which asks for it AGAIN on its own (same as the confirm_order
  // branch above already relies on it doing). One plain "switching"
  // acknowledgement, same shape as that branch, and let
  // handleCollectFulfilment ask exactly once.
  if (newType === 'delivery' && !customer.address) {
    await reply(customer, `Got it, switching to delivery.`);
    await handleCollectFulfilment(customer, order, null);
    return;
  }
  if (newType === 'delivery') {
    const deliveryFee = await estimateDeliveryFee(order, customer);
    if (deliveryFee > 0) {
      await pool.query(`update "order" set delivery_fee = $1 where id = $2`, [deliveryFee, order.id]);
      order.delivery_fee = deliveryFee;
    }
  }
  const { total } = await summariseOrder(order);
  await pool.query(`update "order" set total = $1 where id = $2`, [total, order.id]);
  order.total = total;
  await reply(customer, `Got it, switched to ${newType}. New total NGN ${total}.`);
  await sendPaymentInstructions(customer, order);
}

// Deterministic (no AI call), not fuzzy -- this decides whether to say
// NOTHING at all, which is exactly the kind of decision that must never be
// a guess. Only matches if EVERY line of the message is purely one of
// these, word-for-word -- "ok but when's it coming" has a real question
// riding along and must not be silenced just because it starts with "ok".
// Deliberately just a word list, not an AI call -- this must never depend
// on Claude being reachable at all (found live: an Anthropic outage broke
// even the cheapest, simplest case when this ran through an AI check
// first). The tradeoff is real and known: it only catches phrasing
// actually in this list, so a genuinely novel way of saying "we're done
// here" can still slip through and get a reply. Grow this list as real
// cases turn up rather than reaching for an AI classifier -- a closing
// remark should never be slower or less reliable than the rest of the bot.
const PURE_ACK =
  /^(ok(ay)?|yh|yeah|yep|yup|alright|aight|sure|got ?it|noted|fine|k|cool|nice|sounds good|perfect|great|awesome|bet|gotcha|understood|will do|no problem|np|good|bye|goodbye|see you|take care|have a good (day|night|one)|all good|that works|that'?s fine)[.!]*$/i;
const PURE_THANKS = /^(thanks?( you)?|tysm|thank ?u|appreciate ?it|much appreciated)[.!]*$/i;
// A polite decline of whatever was just offered/asked ("anything else?" ->
// "no thank you") -- NOT the same as PURE_THANKS (that regex is anchored
// and requires the whole line to start with "thanks"/"thank you", so a
// leading "no" already fails it -- found live, 2026-09-03: "no thank you"
// matched neither PURE_THANKS nor PURE_ACK, so it fell all the way through
// to full AI dispatch instead of getting a simple acknowledgment). Always
// gets a short "Okay!" -- never silence (declining deserves some
// response) and never the 'thanks' branch's "You're welcome!" (nonsensical
// for a decline).
const PURE_DECLINE = /^(no,? ?thanks?( you)?|nah,? ?(i'?m good|thanks?)|i'?m good( thanks?)?|not (right )?now|no,? ?i'?m (good|fine)|no need)[.!]*$/i;

// null = not applicable (some part of the message needs a real answer),
// 'ack' = every line was a pure acknowledgment, reply with nothing,
// 'thanks' = at least one line was a thank-you (and the rest, if any, were
// pure acks too) -- a plain "you're welcome" back, not silence.
// 'decline' = a polite "no" to whatever was just offered -- a plain "Okay!"
// back, not silence, not "you're welcome".
export function classifyPureAck(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  let sawThanks = false;
  let sawDecline = false;
  for (const line of lines) {
    if (PURE_THANKS.test(line)) {
      sawThanks = true;
      continue;
    }
    if (PURE_DECLINE.test(line)) {
      sawDecline = true;
      continue;
    }
    if (!PURE_ACK.test(line)) return null;
  }
  if (sawDecline) return 'decline';
  return sawThanks ? 'thanks' : 'ack';
}

// Real bug, found live 2026-09-03: this used to say "Paid and being
// prepared for delivery" no matter what order.status actually was --
// including for an order already out with a rider. A customer asking "how
// long" got told the truth from days ago, not the truth right now. Every
// stage own_riders actually moves through (orderStages.js's own pipeline
// comment): preparation -> ready -> delivery/in_transit -> completed.
// Chidera, 2026-09-20: a second real bug, found from a real report -- this
// had no dine-in case at all, so a table order reaching this same code
// path (it does -- handleCollectFulfilment's at_table branch walks it
// through to engine_state 'fulfilment' same as any other order) always
// fell through to the delivery/pickup default and said "Paid and being
// prepared for pickup" -- wrong on both counts: dine-in never collects
// payment through the bot at all (settled at the table, after being
// served), and it was never pickup or delivery to begin with.
function fulfilmentStatusLine(order) {
  if (order.payment_mode === 'at_table') {
    return order.served_at
      ? `You've been served -- pay at the table whenever you're ready.`
      : `Your order's being prepared -- pay at the table once you've been served.`;
  }
  if (order.status === 'ready') {
    return order.fulfilment_type === 'delivery' ? `Paid and ready, waiting on a rider to pick it up.` : `Paid and ready for pickup whenever you are.`;
  }
  if (order.status === 'delivery' || order.status === 'in_transit') {
    return `Paid and on its way to you with the rider now.`;
  }
  // 'preparation' (the normal case) and any other/unexpected status this
  // function still gets called for -- same honest default it always had.
  return order.fulfilment_type === 'delivery' ? `Paid and being prepared for delivery.` : `Paid and being prepared for pickup.`;
}

// Same real-question-first principle as handleWaitingOnPayment -- already
// paid and being prepared/delivered doesn't mean the customer stopped
// having things to ask ("when's it coming", "what did I order again"). But
// once the order's actually done being processed, a plain "ok"/"alright"
// needs no reply at all -- repeating "already paid and being prepared"
// after every acknowledgment reads as not listening, not as helpful.
export async function handleFulfilmentStageMessage(customer, order, text) {
  // Chidera, 2026-09-20: "if customer just says okay or alright or all
  // these reply that means okay or agreement, bot doesnt need to say
  // anything again, save my api" -- this comment used to claim pure ack/
  // thanks was already filtered out upstream (handlePendingBatch), but
  // that filter only stays silent when there's NO open order at all --
  // deliberately, so a plain "okay" while payment is still outstanding
  // still gets the payment nudge (see its own comment). An order sitting
  // here, already paid and just being prepared, always HAS an open order,
  // so a plain "okay" always fell through to this function anyway, which
  // never actually checked for one itself -- burning a delay-complaint AI
  // call, an answerOrThenShowMenu AI call, and a repeated "already being
  // prepared" message on every single acknowledgment. This is the one
  // place that comment's own claim needed to actually be true.
  const ackType = classifyPureAck(text);
  if (ackType === 'ack') return;
  if (ackType === 'thanks') {
    await reply(customer, `You're welcome!`, 'thanks_ack');
    return;
  }
  if (ackType === 'decline') {
    await reply(customer, `Okay!`, 'decline_ack');
    return;
  }

  // Repeated frustration about the wait is a real complaint, not a status
  // question -- answering it with delivery/pickup facts misses that they're
  // upset, not just asking.
  if (await detectDelayComplaint(text)) {
    await reply(customer, `I'm sorry about this, let me check, I'll get back to you shortly.`, 'delay_complaint_ack');
    await handover(customer, 'Customer complained about order delay/wait time', null, false);
    return;
  }

  const statusLine = fulfilmentStatusLine(order);
  const answer = await answerOrThenShowMenu(customer, order, text, statusLine);
  if (answer) {
    await reply(customer, answer, 'order_question_answer');
    return;
  }
  await reply(customer, `${statusLine} Let me know if you'd like to add anything else.`);
}

// Switching delivery<->pickup after payment is real (paid expecting to pick
// up, then can't make it) -- but real money/logistics are already in motion
// by this point (a rider may already be dispatched for a delivery order, or
// a real delivery fee may now need collecting that was never charged for a
// pickup order). The bot records the change and acknowledges it properly --
// never silence, never pretending nothing happened -- but always hands the
// actual logistics off to a person rather than silently re-booking a rider
// or charging more on its own.
export async function handlePostPaymentFulfilmentChange(customer, order, newType) {
  const previousType = order.fulfilment_type;
  await pool.query(`update "order" set fulfilment_type = $1 where id = $2`, [newType, order.id]);
  order.fulfilment_type = newType;

  // Switching TO pickup needs nothing a human has to arrange -- no rider,
  // no fee, just where to go -- so the bot answers it directly with the
  // real address instead of handing it to staff, same info/wording as the
  // pickup line completePayment already sends. Switching the other way
  // (to delivery) still genuinely needs a person (a rider to book, a real
  // delivery fee to work out), so that keeps the handover below.
  //
  // Chidera, 2026-09-20: real report -- "i changed to pick up why wasnt
  // the order recalculated to take out delivery fee." Root cause: this
  // used to only update fulfilment_type, never delivery_fee/total, unlike
  // the pre-payment version of this same switch (handleFulfilmentChange
  // above). Since the order's ALREADY paid, silently shrinking total
  // would misrepresent what actually got collected -- the real fact is a
  // refund is owed. delivery_fee/total are still corrected here (so the
  // dashboard/invoice reflect what the order is genuinely worth now, not
  // a stale delivery-inclusive figure), and the handover below names the
  // exact refund amount instead of a vague "sort that out."
  if (newType === 'pickup') {
    const oldFee = Number(order.delivery_fee || 0);
    if (oldFee > 0) {
      const newTotal = Number(order.total) - oldFee;
      await pool.query(`update "order" set delivery_fee = 0, total = $1 where id = $2`, [newTotal, order.id]);
      order.delivery_fee = 0;
      order.total = newTotal;
    }
    const { rows: bizRows } = await pool.query('select address, phone_number from business limit 1');
    const biz = bizRows[0] || {};
    const branchRows = order.branch_id ? (await pool.query('select address, phone_number from branch where id = $1', [order.branch_id])).rows : [];
    const b = branchRows[0] || {};
    const refundLine = oldFee > 0 ? ` Since you'd already paid the delivery fee, we'll refund you NGN ${oldFee} for that.` : '';
    await reply(
      customer,
      `Okay, this is the pickup address: ${b.address || biz.address || 'our location'}. When your order is ready I'll let you know so you can pick it up.${refundLine}`
    );
    if (oldFee > 0) {
      await handover(customer, `Customer switched an already-paid order from delivery to pickup -- they're owed a NGN ${oldFee} delivery fee refund`, null, false);
    }
    return;
  }

  await reply(customer, `Got it, you'd like ${newType} instead of ${previousType}. Your order's already paid, so let me get someone to sort that out for you.`);
  await handover(customer, `Customer wants to switch an already-paid order from ${previousType} to ${newType}`, null, false);
}
