// Delivery booking. Chowdeck's Relay product has a real, public API,
// confirmed against their actual reference docs (chowdeck-api.readme.io):
// fee quote is POST /relay/delivery/fee (NOT merchant-scoped -- a separate
// path from create delivery), create delivery is POST
// /merchant/{ref}/delivery, and every amount Chowdeck returns is in kobo
// (100 kobo = 1 naira), same convention Paystack uses -- divided by 100
// before it's stored, since every other price column in this app is plain
// naira.
//
// The fee endpoint requires source_address/destination_address as
// {latitude, longitude} objects -- the *_string fields alone aren't enough
// -- so both addresses are run through Google's Geocoding API first (see
// geocode.js) before asking Chowdeck for a fee.
//
// Still wrapped so any wrong assumption, a geocoding miss, or an unexpected
// response shape falls back to the 'manual' path instead of losing the
// order.
import { pool } from '../lib/db.js';
import { geocodeAddress } from './geocode.js';

const CHOWDECK_API_BASE = process.env.CHOWDECK_API_BASE || 'https://api.chowdeck.com';

// Two separate switches, on purpose. Whether Chowdeck creds even exist in
// this deployment's .env is ERA's own call (only ERA can set those, via the
// control panel or a script) -- it's whether the feature is AVAILABLE to
// this business at all. business.delivery_enabled is that business's own,
// already sitting in Settings (client/src/pages/Settings.jsx) but never
// actually wired to anything -- toggling it there had zero effect on real
// bookings until now. Chowdeck only ever gets used when BOTH are true; ERA
// turning the credentials off always wins over what the business wants.
async function chowdeckAvailable() {
  if (!(process.env.DELIVERY_PROVIDER === 'chowdeck' && process.env.CHOWDECK_SECRET_KEY && process.env.CHOWDECK_MERCHANT_REFERENCE)) {
    return false;
  }
  const { rows } = await pool.query('select delivery_enabled from business limit 1');
  return Boolean(rows[0]?.delivery_enabled);
}

export async function createDelivery(order, customer) {
  if (await chowdeckAvailable()) {
    try {
      return await chowdeckDelivery(order, customer);
    } catch (err) {
      console.error(`Chowdeck delivery booking failed, falling back to manual: ${err.message}`);
      return manualDelivery(order, customer);
    }
  }
  return manualDelivery(order, customer);
}

async function chowdeckHeaders() {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${process.env.CHOWDECK_SECRET_KEY}`,
  };
}

// If this order was placed against a specific branch (see schema.sql's
// branch table), that branch is where the rider actually picks up from --
// business.address is only the right fallback for a single-location
// business with no branch rows at all.
async function resolveSource(order) {
  if (order.branch_id) {
    const { rows } = await pool.query('select name, address, phone_number from branch where id = $1', [order.branch_id]);
    if (rows[0]) return rows[0];
  }
  const { rows: bizRows } = await pool.query('select name, address, phone_number from business limit 1');
  return bizRows[0] || {};
}

// Shared by the pre-payment estimate (so the customer is actually charged
// the real delivery cost) and the post-payment booking below. Each call is
// a fresh quote -- Chowdeck fee quotes aren't held stable long enough to
// safely reuse a fee_id minutes later at payment-confirmation time, so the
// price the customer paid and the price actually booked can drift slightly
// if Chowdeck's own pricing changes between the two calls. Known tradeoff,
// not solved here.
async function quoteChowdeckFee(order, customer) {
  const business = await resolveSource(order);
  if (!business?.address || !customer.address) throw new Error('missing source or destination address');

  const headers = await chowdeckHeaders();
  // Relay's fee endpoint is NOT merchant-scoped -- /relay/delivery/fee, a
  // different path prefix than create-delivery below.
  const [sourceCoords, destinationCoords] = await Promise.all([
    geocodeAddress(business.address),
    geocodeAddress(customer.address),
  ]);
  const feeRes = await fetch(`${CHOWDECK_API_BASE}/relay/delivery/fee`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      source_address: sourceCoords,
      destination_address: destinationCoords,
      source_address_string: business.address,
      destination_address_string: customer.address,
    }),
  });
  if (!feeRes.ok) throw new Error(`fee quote failed: ${feeRes.status} ${await feeRes.text()}`);
  const fee = await feeRes.json();
  const feeId = fee?.id ?? fee?.data?.id;
  const amountKobo = fee?.total_amount ?? fee?.data?.total_amount;
  if (!feeId || amountKobo == null) throw new Error('fee quote response had no usable fee id/amount');
  return { feeId, feeNaira: amountKobo / 100, business };
}

// Called before payment so the delivery cost is part of what the customer
// actually pays, instead of the business silently absorbing it. Never
// throws -- a geocoding miss or a down Chowdeck just means no delivery fee
// gets added (order still proceeds), same fallback philosophy as booking.
export async function estimateDeliveryFee(order, customer) {
  if (!(await chowdeckAvailable())) return 0;
  try {
    const { feeNaira } = await quoteChowdeckFee(order, customer);
    return feeNaira;
  } catch (err) {
    console.error(`Chowdeck fee estimate failed, no delivery fee added: ${err.message}`);
    return 0;
  }
}

async function chowdeckDelivery(order, customer) {
  const merchantRef = process.env.CHOWDECK_MERCHANT_REFERENCE;
  const headers = await chowdeckHeaders();
  const { feeId, business } = await quoteChowdeckFee(order, customer);

  const createRes = await fetch(`${CHOWDECK_API_BASE}/merchant/${merchantRef}/delivery`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      fee_id: feeId,
      item_type: 'food',
      user_action: 'sending',
      reference: order.reference,
      source_contact: { name: business.name, phone: business.phone_number },
      destination_contact: { name: customer.name || 'Customer', phone: customer.phone_number },
    }),
  });
  if (!createRes.ok) throw new Error(`create delivery failed: ${createRes.status} ${await createRes.text()}`);
  const created = await createRes.json();
  const data = created?.data ?? created;

  // Chowdeck returns delivery_price in kobo, same as Paystack -- every other
  // price column here is plain naira.
  const priceNaira = (data.delivery_price || 0) / 100;
  const { rows } = await pool.query(
    `insert into delivery (order_id, customer_id, address, phone_number, provider, provider_delivery_id, tracking_url, status, price)
     values ($1, $2, $3, $4, 'chowdeck', $5, $6, 'pending', $7) returning *`,
    [order.id, customer.id, customer.address, customer.phone_number, data.id ? String(data.id) : data.reference, data.tracking_url || null, priceNaira]
  );
  return { riderName: null, trackingUrl: data.tracking_url || null, record: rows[0] };
}

async function manualDelivery(order, customer) {
  const { rows } = await pool.query(
    `insert into delivery (order_id, customer_id, address, phone_number, provider, status, price)
     values ($1, $2, $3, $4, 'manual', 'pending', 0) returning *`,
    [order.id, customer.id, customer.address, customer.phone_number]
  );
  return { riderName: null, trackingUrl: null, record: rows[0] };
}
