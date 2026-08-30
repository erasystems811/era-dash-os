import { pool } from '../lib/db.js';
import { sendWhatsApp } from './whatsapp-send.js';

// Two invariants from build schema v2.0 section 8, enforced here and only
// here so no call site has to remember them: at most one alert per (event,
// event_date, context), and quiet hours apply to every event except
// 'blocked'.

function isWithinQuietHours(quietHours) {
  if (!quietHours) return false;
  const [start, end] = quietHours.split('-').map((s) => s.trim());
  if (!start || !end) return false;
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const toMinutes = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  };
  const startM = toMinutes(start);
  const endM = toMinutes(end);
  // Overnight range (e.g. 22:00-07:00) wraps past midnight.
  return startM > endM ? nowMinutes >= startM || nowMinutes < endM : nowMinutes >= startM && nowMinutes < endM;
}

// `context` distinguishes multiple alerts of the same event on the same day
// (e.g. two different missing tasks) -- pass `${task_id}:${staff_id}` for
// per-task-per-staff events, leave blank for once-per-business events like
// daily_summary.
export async function dispatchAlert({ event, message, context = '' }) {
  const todayIso = new Date().toISOString().slice(0, 10);

  const dedup = await pool.query(
    `insert into alert_log (event, event_date, context) values ($1, $2, $3)
     on conflict (event, event_date, context) do nothing
     returning id`,
    [event, todayIso, context]
  );
  if (dedup.rowCount === 0) return { sent: false, reason: 'already alerted today' };

  const { rows: routes } = await pool.query(`select channel, target, quiet_hours from alert_route where event = $1`, [event]);
  const { rows: businessRows } = await pool.query(`select owner_phone from business limit 1`);
  const fallbackTarget = businessRows[0]?.owner_phone;

  const targets = routes.length ? routes : fallbackTarget ? [{ channel: 'whatsapp', target: fallbackTarget, quiet_hours: null }] : [];
  if (!targets.length) return { sent: false, reason: 'no alert_route and no business.owner_phone configured' };

  const results = [];
  for (const route of targets) {
    if (event !== 'blocked' && isWithinQuietHours(route.quiet_hours)) {
      results.push({ target: route.target, held: true });
      continue;
    }
    if (route.channel === 'whatsapp') {
      await sendWhatsApp(route.target, message);
      results.push({ target: route.target, sent: true });
    }
    // TODO: 'email' and 'dashboard' channels -- no email transport or
    // in-dashboard notification feed exists yet (dashboard itself is stage
    // 9 of the build order). 'whatsapp' covers the pilot.
  }
  return { sent: true, results };
}
