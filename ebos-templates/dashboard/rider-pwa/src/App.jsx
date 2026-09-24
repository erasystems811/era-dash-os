import React, { useEffect, useState } from 'react';
import { api } from './api.js';

// The Push API needs the VAPID public key as raw bytes, not the base64url
// string the server hands back -- this is the standard conversion every
// Web Push tutorial uses, no library needed for it.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

// Registers the service worker and subscribes to real push (App.jsx's own
// in-page alarm only ever fires while this tab is open -- this is what
// actually rings/vibrates the phone with the screen off or the app
// backgrounded, Chidera's report: "there wasnt any actual ring on my
// phone"). Returns a real result instead of failing silently, because
// going on duty with no working alarm defeats the whole point of being on
// duty -- Chidera's call: "make allow notification a prerequisite to be
// on duty".
//
// Two different kinds of "didn't work", handled differently by the
// caller: `unsupported` is a deployment/browser-level fact the rider has
// no control over (an old browser, or this business's push not set up yet
// -- see engine/push-notify.js) and must never block someone from working
// just because ERA hasn't finished wiring something up; `denied` is the
// rider's own choice (tapped Block, or their phone's settings already had
// notifications off for this site) and is exactly the case worth stopping
// them going on duty over, since it's the one thing they can actually fix
// right then.
async function subscribeToPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return { ok: false, reason: 'unsupported' };
  try {
    const { publicKey } = await api.get('/push-public-key');
    if (!publicKey) return { ok: false, reason: 'unsupported' }; // this deployment hasn't got VAPID keys set up yet
    const registration = await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return { ok: false, reason: 'denied' };
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }
    await api.post('/push-subscribe', { subscription: subscription.toJSON() });
    return { ok: true };
  } catch (err) {
    console.error('Push subscription failed:', err);
    // A real, unexpected failure (not a plain "denied") -- treated the
    // same as unsupported, not the rider's fault, so it never blocks them.
    return { ok: false, reason: 'unsupported' };
  }
}

// Chidera, 2026-09-24: "every rider must tap allow for notification and
// location if not they can accept any ride or use the platform" -- location
// was deliberately non-blocking before this (useLocationReporting's own
// comment: never stop a rider working just because one position read
// failed, since that happens routinely -- weak signal, a slow GPS fix).
// That reasoning still holds for a single failed READING once on duty; it
// never applied to the RIDER'S OWN CHOICE to block location outright, which
// this checks for up front, the same denied/unsupported split
// subscribeToPush already uses for notifications: `denied` (they tapped
// Block) is the one thing a rider can actually go fix right then, and is
// exactly what going on duty with no way to ever find their real position
// should refuse over; `unsupported` (no geolocation API on this browser at
// all) is a device fact outside their control and must never block them.
function requestLocationPermission() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve({ ok: false, reason: 'unsupported' });
    navigator.geolocation.getCurrentPosition(
      () => resolve({ ok: true }),
      (err) => resolve({ ok: false, reason: err.code === err.PERMISSION_DENIED ? 'denied' : 'unsupported' }),
      { enableHighAccuracy: false, timeout: 10_000 }
    );
  });
}

// Posts the rider's own position on whatever interval the caller picks --
// 15s during an active delivery, 60s on-duty idle, and simply not called
// at all off duty (spec B3/B6: the rider pays for his own data and can't
// always charge his phone, so continuous/high-frequency location is a cost
// passed to the person earning least in the chain). intervalMs === null
// means "don't report at all".
function useLocationReporting(intervalMs) {
  useEffect(() => {
    if (!intervalMs || !navigator.geolocation) return;
    const report = () => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          api.post('/location', { lat: pos.coords.latitude, lng: pos.coords.longitude }).catch(() => {});
        },
        () => {}, // permission denied or unavailable -- silently skip this tick, never block the rest of the app over it
        { enableHighAccuracy: false, maximumAge: intervalMs, timeout: 10_000 }
      );
    };
    report();
    const id = setInterval(report, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}

// Was a phone-entry screen followed by a WhatsApp-OTP screen -- switched
// 2026-09-02 to a single phone + PIN form (Chidera's call): a rider is
// already added by the restaurant before they can sign in at all, so
// there's no "send a code" step needed, only a PIN staff already gave them
// in person.
function PhoneAndPinLogin({ onLoggedIn }) {
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [signing, setSigning] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    setSigning(true);
    try {
      const state = await api.post('/login', { phone: phone.trim(), pin: pin.trim() });
      onLoggedIn(state);
    } catch (err) {
      setError(err.message);
    } finally {
      setSigning(false);
    }
  }

  return (
    <div className="screen">
      <div className="brand">Rider</div>
      <h1>Sign in</h1>
      <p className="hint">Enter your phone number and the PIN the restaurant gave you.</p>
      {error && <div className="error">{error}</div>}
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <input
          type="tel"
          inputMode="tel"
          autoFocus
          placeholder="e.g. 2348030000000"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          required
        />
        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={6}
          placeholder="PIN"
          style={{ textAlign: 'center', letterSpacing: '8px', fontSize: 28 }}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          required
        />
        <button type="submit" disabled={signing || !phone.trim() || pin.length < 4}>
          {signing ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

function naira(amount) {
  return `₦${Number(amount).toLocaleString()}`;
}

// A loud beep synthesised in-browser (no audio file to fetch/cache, which
// matters on a cheap phone with full storage and patchy data -- spec
// 0.2/0.3), repeated for ~20s like a real ringing phone instead of one
// 700ms ping (Chidera's report: "i need a long ring like 20 seconds") --
// fires the moment an offer event arrives, whether or not the app is in
// the foreground. Returns a stop() so the caller can cut it short the
// instant the rider actually acts on the offer (accept/decline), rather
// than ringing at them for the full 20s regardless.
const ALARM_DURATION_MS = 20000;
const ALARM_CYCLE_MS = 1000;

function playAlarm() {
  let stopped = false;
  let ctx = null;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
  } catch {
    // Some browsers refuse to start audio without a prior user gesture --
    // vibration below still fires either way, never worth failing loudly
    // over a missed beep.
  }

  function ring() {
    if (stopped) return;
    if (ctx) {
      try {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.value = 880;
        gain.gain.value = 0.3;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        setTimeout(() => osc.stop(), 700);
      } catch {
        // ignore -- see above
      }
    }
    if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 300]);
  }

  ring();
  const interval = setInterval(ring, ALARM_CYCLE_MS);
  const stopAt = setTimeout(stop, ALARM_DURATION_MS);

  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    clearTimeout(stopAt);
    if (navigator.vibrate) navigator.vibrate(0);
    if (ctx) ctx.close().catch(() => {});
  }

  return stop;
}

// A plain Google Maps search link -- opens the phone's own installed maps
// app on a tap (no API key, no embedded map view needed for this, just a
// handoff -- spec B3's "navigation handoff", not turn-by-turn built into
// this app itself).
function navHandoffUrl(address) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address || '')}`;
}

// The three lifecycle steps after accepting (spec B4/screen 5-6): picked
// up, arrived (with a maps handoff to get there), then the customer's code
// to close the job. One screen, its own local status so a lost connection
// or a refresh doesn't lose where the rider actually is -- /assignments/:id
// itself is the source of truth on the server, this is just tracking the
// same thing client-side between taps.
function ActiveDelivery({ assignment: initialAssignment, offer, dropoffAddress, customerPhone, onFinished }) {
  const [assignment, setAssignment] = useState(initialAssignment);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [delivered, setDelivered] = useState(false);

  // 15s -- an active delivery is the one case worth tighter reporting, so
  // the customer's tracking page (routes/tracking.js) and the restaurant's
  // live map both stay meaningfully current while a job is actually moving.
  useLocationReporting(delivered ? null : 15_000);

  // Staff have their own override for a stuck delivery (lost code, dead
  // phone, handed to a neighbour -- routes/delivery.js's /assignments/:id/
  // release), which closes it out on the dashboard side. Without this,
  // the rider's phone would just sit on the code-entry screen forever with
  // no way to know, then get a confusing "already delivered" error the
  // moment they actually typed a code in (Chidera's ask, 2026-09-11: "if a
  // rider is manually marked complete let the code stuff stop pending").
  // Only polls while actually on that screen, not the whole active delivery.
  useEffect(() => {
    if (assignment.status !== 'ARRIVED') return;
    const id = setInterval(async () => {
      try {
        const latest = await api.get(`/assignments/${assignment.id}`);
        if (latest.status === 'DELIVERED') setDelivered(true);
      } catch {
        // A transient network blip here just means the next poll tries
        // again -- never worth surfacing as an error on top of a delivery
        // the rider is still actively trying to close out themselves.
      }
    }, 10_000);
    return () => clearInterval(id);
  }, [assignment.status, assignment.id]);

  async function markPickedUp() {
    setError(null);
    setBusy(true);
    try {
      setAssignment(await api.post(`/assignments/${assignment.id}/picked-up`, {}));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function markArrived() {
    setError(null);
    setBusy(true);
    try {
      setAssignment(await api.post(`/assignments/${assignment.id}/arrived`, {}));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function deliver(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.post(`/assignments/${assignment.id}/deliver`, { code: code.trim() });
      setDelivered(true);
    } catch (err) {
      // Staff's own override already closed this out on the dashboard side
      // -- a real race with the polling effect above, not a mistake on the
      // rider's part, so this should never look like an error to them.
      if (err.alreadyDelivered) setDelivered(true);
      else setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (delivered) {
    return (
      <div className="screen">
        <div className="brand">Rider</div>
        <h1>Delivered</h1>
        <p className="hint">Nice work. Back on duty for the next one.</p>
        <button onClick={onFinished}>Back to duty</button>
      </div>
    );
  }

  return (
    <div className="screen">
      <div className="brand">{offer.zoneName}</div>
      {error && <div className="error">{error}</div>}

      {assignment.status === 'ASSIGNED' && (
        <>
          <h1>Head to pickup</h1>
          <p className="hint">{offer.pickupName || 'The restaurant'}{offer.pickupAddress ? `, ${offer.pickupAddress}` : ''}</p>
          <a href={navHandoffUrl(offer.pickupAddress)} target="_blank" rel="noreferrer">
            <button type="button">Open in Maps</button>
          </a>
          <button onClick={markPickedUp} disabled={busy}>
            {busy ? 'Updating...' : "I've picked it up"}
          </button>
        </>
      )}

      {assignment.status === 'PICKED_UP' && (
        <>
          <h1>On the way</h1>
          <p className="hint">
            Delivering to {offer.zoneName}
            {dropoffAddress ? `: ${dropoffAddress}` : ''}.
          </p>
          {dropoffAddress && (
            <a href={navHandoffUrl(dropoffAddress)} target="_blank" rel="noreferrer">
              <button type="button">Open in Maps</button>
            </a>
          )}
          {customerPhone && (
            <a href={`tel:${customerPhone}`}>
              <button type="button">Call customer</button>
            </a>
          )}
          <button onClick={markArrived} disabled={busy}>
            {busy ? 'Updating...' : "I've arrived"}
          </button>
        </>
      )}

      {assignment.status === 'ARRIVED' && (
        <>
          <h1>Enter their code</h1>
          <p className="hint">Ask the customer for the code they were sent, to close out this delivery.</p>
          {customerPhone && (
            <a href={`tel:${customerPhone}`}>
              <button type="button">Call customer</button>
            </a>
          )}
          <form onSubmit={deliver} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={4}
              autoFocus
              placeholder="0000"
              style={{ textAlign: 'center', letterSpacing: '8px', fontSize: 28 }}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              required
            />
            <button type="submit" disabled={busy || code.length < 4}>
              {busy ? 'Checking...' : 'Complete delivery'}
            </button>
          </form>
        </>
      )}
    </div>
  );
}

// Shown the instant an offer event arrives, over whatever screen the rider
// was already on. Accept is a race (spec B4) -- the request either wins
// (200) or a rival rider already took it (409), never anything in between.
function OfferScreen({ offer, onAccepted, onDone }) {
  const [busy, setBusy] = useState(false);
  const [declined, setDeclined] = useState(null);

  useEffect(() => {
    const stop = playAlarm();
    return stop;
  }, [offer.id]);

  async function accept() {
    setBusy(true);
    try {
      const data = await api.post(`/offers/${offer.id}/accept`, {});
      onAccepted(data.assignment, data.dropoffAddress, data.customerPhone);
    } catch (err) {
      setDeclined(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (declined) {
    return (
      <div className="screen">
        <div className="brand">Rider</div>
        <h1>Too late</h1>
        <p className="hint">{declined}</p>
        <button onClick={onDone}>Back to duty</button>
      </div>
    );
  }

  return (
    <div className="screen">
      <div className="brand">{offer.urgent ? '⚠ URGENT DELIVERY' : 'New delivery'}</div>
      <h1>{offer.zoneName}</h1>
      <p className="hint">Pickup: {offer.pickupName || 'the restaurant'}{offer.pickupAddress ? `, ${offer.pickupAddress}` : ''}</p>
      <div style={{ textAlign: 'center', fontSize: 36, fontWeight: 700 }}>{naira(offer.payout)}</div>
      <button onClick={accept} disabled={busy}>
        {busy ? 'Accepting...' : 'Accept'}
      </button>
      <button type="button" className="link" onClick={onDone}>
        Ignore
      </button>
    </div>
  );
}

function Duty({ rider, initialActive, onLoggedOut }) {
  const [status, setStatus] = useState(rider.status || 'off_duty');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [offer, setOffer] = useState(null);
  // Set once an offer is actually accepted -- takes over the whole screen
  // until the delivery is closed out, independent of on/off duty (a rider
  // mid-delivery isn't listening for new offers anyway, see below). Seeded
  // from /me's own live lookup (routes/rider.js's loadRiderState), not
  // always null -- a refresh (or reopening the app after it was killed)
  // must never lose track of a delivery already in progress (Chidera's
  // report, 2026-09-03: "what of his existing ride he was on?").
  const [active, setActive] = useState(initialActive || null);

  const onDuty = status === 'on_duty';

  // 60s while on duty and idle (ActiveDelivery's own 15s takes over once a
  // job is accepted, see there) -- none at all off duty. This is what
  // makes "go off duty" actually mean something on the data bill, not just
  // on the offer feed.
  useLocationReporting(onDuty && !active ? 60_000 : null);

  // Only holds the connection open while actually on duty AND not already
  // in the middle of a delivery -- spec 0.3/B6: the rider pays for his own
  // data, so nothing streams while off duty or busy with a job he can't
  // take another one during anyway. Reconnects automatically (EventSource's
  // own built-in behaviour) if the connection drops, and immediately
  // replays any still-OPEN offer for this rider on (re)connect
  // (routes/rider.js's own /offers/stream).
  useEffect(() => {
    if (!onDuty || active) return;
    const source = new EventSource('/rider/api/offers/stream');
    source.onmessage = (event) => {
      const data = JSON.parse(event.data);
      // Staff handling the order directly (Orders.jsx's "Mark in delivery"
      // button) cancels the offer server-side and retracts it here too --
      // otherwise a rider already staring at this exact offer would have
      // no way to know it's no longer really available, and would either
      // sit on a dead alarm or get a confusing "someone else already
      // accepted" the moment they tried (Chidera's ask, 2026-09-11).
      if (data.retracted) {
        setOffer((current) => (current?.id === data.id ? null : current));
        return;
      }
      setOffer((current) => current || data); // never interrupt an offer already being decided
    };
    return () => source.close();
  }, [onDuty, active]);

  async function toggleDuty() {
    setError(null);
    setBusy(true);
    const next = onDuty ? 'off_duty' : 'on_duty';
    // Allow notifications is a real prerequisite for going ON duty
    // (Chidera's call) -- an offer with no working alarm defeats the
    // whole point of being on duty. `unsupported` (an old browser, or
    // this business's push not set up yet -- not the rider's own choice)
    // never blocks them; `denied` (they tapped Block) does, since it's
    // the one thing they can actually go fix right then.
    if (next === 'on_duty') {
      const pushResult = await subscribeToPush();
      if (!pushResult.ok && pushResult.reason === 'denied') {
        setBusy(false);
        setError("Turn on notifications for this app in your phone settings first -- otherwise you won't hear new delivery offers.");
        return;
      }
      // Same prerequisite as notifications, now also for location --
      // Chidera, 2026-09-24: "every rider must tap allow for notification
      // and location if not they can accept any ride or use the platform".
      const locationResult = await requestLocationPermission();
      if (!locationResult.ok && locationResult.reason === 'denied') {
        setBusy(false);
        setError('Turn on location for this app in your phone settings first -- staff and customers need to see where you are during a delivery.');
        return;
      }
    }
    try {
      const updated = await api.post('/duty', { status: next });
      setStatus(updated.status);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    await api.post('/logout');
    onLoggedOut();
  }

  if (active) {
    return (
      <ActiveDelivery
        assignment={active.assignment}
        offer={active.offer}
        dropoffAddress={active.dropoffAddress}
        customerPhone={active.customerPhone}
        onFinished={() => {
          setActive(null);
          setOffer(null);
        }}
      />
    );
  }

  if (offer) {
    return (
      <OfferScreen
        offer={offer}
        onAccepted={(assignment, dropoffAddress, customerPhone) =>
          setActive({ assignment, offer, dropoffAddress, customerPhone })
        }
        onDone={() => setOffer(null)}
      />
    );
  }

  return (
    <div className="screen">
      <div className="brand">Rider</div>
      <h1>Hi, {rider.name}</h1>
      {error && <div className="error">{error}</div>}
      <div style={{ textAlign: 'center', margin: '12px 0' }}>
        <span className={`status-badge ${onDuty ? 'on' : 'off'}`}>{onDuty ? 'ON DUTY' : 'OFF DUTY'}</span>
      </div>
      <p className="hint" style={{ textAlign: 'center' }}>
        {onDuty ? "You'll get an alarm when a delivery comes in nearby." : 'Go on duty to start receiving delivery offers.'}
      </p>
      <button className={onDuty ? 'off' : ''} onClick={toggleDuty} disabled={busy}>
        {busy ? 'Updating...' : onDuty ? 'Go off duty' : 'Go on duty'}
      </button>
      <button type="button" className="link" onClick={logout}>
        Sign out
      </button>
    </div>
  );
}

export default function App() {
  // undefined = still checking /me, null = signed out, object = signed in
  const [rider, setRider] = useState(undefined);
  const [initialActive, setInitialActive] = useState(null);

  useEffect(() => {
    api
      .get('/me')
      .then((d) => {
        setRider(d.rider);
        setInitialActive(d.active || null);
      })
      .catch(() => setRider(null));
  }, []);

  if (rider === undefined) return null;

  if (rider) {
    return <Duty rider={rider} initialActive={initialActive} onLoggedOut={() => setRider(null)} />;
  }

  return (
    <PhoneAndPinLogin
      onLoggedIn={(state) => {
        setInitialActive(state.active || null);
        setRider(state.rider);
      }}
    />
  );
}
