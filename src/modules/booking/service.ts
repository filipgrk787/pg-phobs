import type { PoolClient } from '../../lib/db.js';
import { Err } from '../../lib/errors.js';
import { computeNightPrice } from '../ari/pricing.js';
import type { RatePlan, LevelPrice } from '../ari/pricing.js';

const HOLD_MINUTES = 15;
const MAX_RETRIES = 8;

// ---- Payment provider interface ----
export interface PaymentProvider {
  authorize(token: string, amountCents: number, currency: string): Promise<{ ref: string }>;
}

export class MockPaymentProvider implements PaymentProvider {
  async authorize(token: string, amountCents: number, _currency: string) {
    if (token === 'fail') throw Err.paymentRequired('Card declined');
    return { ref: `mock-pay-${Date.now()}` };
  }
}

// ---- Hold ----

export interface HoldParams {
  propertyId: string;
  ratePlanId: string;
  roomTypeId: string;
  channelId: string;
  adults: number;
  arrival: string;
  departure: string;
}

export async function holdReservation(
  c: PoolClient,
  tenantId: string,
  params: HoldParams,
): Promise<{ reservationId: string; totalAmount: number; expiresAt: string }> {
  const nights = dateRange(params.arrival, params.departure);
  if (nights.length === 0) throw Err.badRequest('arrival must be before departure');

  // Fetch channel
  const { rows: chRows } = await c.query<{ markup_percent: string }>(
    `SELECT markup_percent FROM channels WHERE id = $1 AND property_id = $2`,
    [params.channelId, params.propertyId],
  );
  if (!chRows[0]) throw Err.notFound('Channel not found');
  const markupPct = Number(chRows[0].markup_percent);

  // Fetch rate plan chain
  const { rows: planRows } = await c.query<{
    id: string; code: string; parent_id: string | null;
    derive_type: string | null; derive_value: string | null;
    refundable: boolean; free_cancel_days: number | null; web_only: boolean;
  }>(
    `WITH RECURSIVE chain AS (
       SELECT id, code, parent_id, derive_type, derive_value, refundable, free_cancel_days, web_only
       FROM rate_plans WHERE id = $1
       UNION ALL
       SELECT rp.id, rp.code, rp.parent_id, rp.derive_type, rp.derive_value, rp.refundable, rp.free_cancel_days, rp.web_only
       FROM rate_plans rp JOIN chain c ON c.parent_id = rp.id
     ) SELECT * FROM chain`,
    [params.ratePlanId],
  );
  if (!planRows.length) throw Err.notFound('Rate plan not found');

  const ratePlanChain: RatePlan[] = planRows.reverse().map(p => ({
    id: p.id,
    code: p.code,
    parentId: p.parent_id,
    deriveType: p.derive_type as 'percent' | 'fixed' | null,
    deriveValue: p.derive_value !== null ? Number(p.derive_value) : null,
    refundable: p.refundable,
    freeCancelDays: p.free_cancel_days,
    webOnly: p.web_only,
  }));

  const leafPlan = planRows[planRows.length - 1]!;

  // Lock inventory nights in order (prevents deadlocks)
  const { rows: invRows } = await c.query<{
    room_type_id: string; night: string; total: number; sold: number;
    held: number; out_of_order: number; stop_sell: boolean;
  }>(
    `SELECT room_type_id, night::text, total, sold, held, out_of_order, stop_sell
     FROM inventory_nights
     WHERE room_type_id = $1 AND night = ANY($2::date[])
     ORDER BY night
     FOR UPDATE`,
    [params.roomTypeId, nights],
  );

  if (invRows.length !== nights.length) {
    throw Err.unprocessable('Inventory not configured for all requested nights');
  }

  for (const inv of invRows) {
    if (inv.stop_sell) throw Err.conflict('Stop sell active on ' + inv.night);
    const free = inv.total - inv.sold - inv.held - inv.out_of_order;
    if (free <= 0) throw Err.conflict('No availability on ' + inv.night);
  }

  // Check rate plan restrictions (min/max LOS, CTA, CTD)
  const { rows: restrictRows } = await c.query<{
    night: string; min_los: number | null; max_los: number | null;
    closed_to_arrival: boolean; closed_to_departure: boolean; stop_sell: boolean;
  }>(
    `SELECT night::text, min_los, max_los, closed_to_arrival, closed_to_departure, stop_sell
     FROM restrictions
     WHERE rate_plan_id = $1 AND night = ANY($2::date[])`,
    [params.ratePlanId, nights],
  );

  if (restrictRows.length > 0) {
    const { checkRestrictions } = await import('../ari/pricing.js');
    const restrictMap = new Map(restrictRows.map(r => [r.night, {
      night: r.night,
      minLos: r.min_los,
      maxLos: r.max_los,
      closedToArrival: r.closed_to_arrival,
      closedToDeparture: r.closed_to_departure,
      stopSell: r.stop_sell,
    }]));
    const invMap = new Map(invRows.map(r => [r.night, {
      night: r.night,
      free: r.stop_sell ? 0 : Math.max(r.total - r.sold - r.held - r.out_of_order, 0),
    }]));
    const reason = checkRestrictions(params.arrival, params.departure, nights, restrictMap, invMap);
    if (reason) throw Err.conflict(`Restriction violated: ${reason}`);
  }

  // Compute per-night prices
  const perNight: { night: string; amount: number }[] = [];
  let totalAmount = 0;

  for (const night of nights) {
    const { rows: lpRows } = await c.query<{ occupancy: number; amount: string }>(
      `SELECT lp.occupancy, lp.amount
       FROM night_levels nl
       JOIN level_prices lp ON lp.level_id = nl.level_id AND lp.room_type_id = $1
       WHERE nl.property_id = $2 AND nl.night = $3`,
      [params.roomTypeId, params.propertyId, night],
    );
    const levelPrices: LevelPrice[] = lpRows.map(r => ({ occupancy: r.occupancy, amount: Number(r.amount) }));
    const amount = computeNightPrice({ levelPrices, ratePlanChain, channelMarkupPercent: markupPct, adults: params.adults });
    perNight.push({ night, amount });
    totalAmount += amount;
  }
  totalAmount = Math.round(totalAmount * 100) / 100;

  const expiresAt = new Date(Date.now() + HOLD_MINUTES * 60_000).toISOString();

  // Snapshot refundable / free_cancel_until
  let freeCancelUntil: Date | null = null;
  if (leafPlan.refundable && leafPlan.free_cancel_days != null) {
    const d = new Date(params.arrival);
    d.setDate(d.getDate() - leafPlan.free_cancel_days);
    freeCancelUntil = d;
  }

  // Insert reservation
  const { rows: resRows } = await c.query<{ id: string }>(
    `INSERT INTO reservations(
       tenant_id, property_id, channel_id, rate_plan_id,
       status, adults, arrival, departure, total_amount,
       refundable, free_cancel_until, hold_expires_at
     ) VALUES ($1,$2,$3,$4,'held',$5,$6,$7,$8,$9,$10,$11)
     RETURNING id`,
    [
      tenantId, params.propertyId, params.channelId, params.ratePlanId,
      params.adults, params.arrival, params.departure, totalAmount,
      leafPlan.refundable, freeCancelUntil, expiresAt,
    ],
  );
  const reservationId = resRows[0]!.id;

  // Insert reservation_nights
  for (const pn of perNight) {
    await c.query(
      `INSERT INTO reservation_nights(reservation_id, night, room_type_id, tenant_id, amount)
       VALUES ($1, $2, $3, $4, $5)`,
      [reservationId, pn.night, params.roomTypeId, tenantId, pn.amount],
    );
  }

  // Increment held
  await c.query(
    `UPDATE inventory_nights SET held = held + 1, version = version + 1
     WHERE room_type_id = $1 AND night = ANY($2::date[])`,
    [params.roomTypeId, nights],
  );

  // Outbox: InventoryChanged
  await c.query(
    `INSERT INTO outbox(tenant_id, event_type, payload)
     VALUES ($1, 'InventoryChanged', $2)`,
    [tenantId, JSON.stringify({ propertyId: params.propertyId, roomTypeId: params.roomTypeId, from: params.arrival, to: params.departure })],
  );

  return { reservationId, totalAmount, expiresAt };
}

// ---- Confirm ----

export async function confirmReservation(
  c: PoolClient,
  tenantId: string,
  reservationId: string,
  paymentToken: string,
  payments: PaymentProvider,
): Promise<{ paymentRef: string }> {
  const { rows } = await c.query<{
    id: string; status: string; total_amount: string;
    hold_expires_at: string; room_type_id: string;
    arrival: string; departure: string; property_id: string;
  }>(
    `SELECT r.id, r.status, r.total_amount, r.hold_expires_at,
            rn.room_type_id, r.arrival::text, r.departure::text, r.property_id
     FROM reservations r
     JOIN reservation_nights rn ON rn.reservation_id = r.id
     WHERE r.id = $1
     LIMIT 1`,
    [reservationId],
  );
  if (!rows[0]) throw Err.notFound('Reservation not found');
  const res = rows[0];

  if (res.status === 'confirmed') throw Err.conflict('Already confirmed');
  if (res.status === 'cancelled') throw Err.conflict('Reservation is cancelled');
  if (res.status === 'expired' || new Date(res.hold_expires_at) < new Date()) {
    throw Err.conflict('Hold has expired');
  }
  if (res.status !== 'held') throw Err.conflict('Invalid status: ' + res.status);

  const amountCents = Math.round(Number(res.total_amount) * 100);
  const { ref: paymentRef } = await payments.authorize(paymentToken, amountCents, 'EUR');

  const nights = dateRange(res.arrival, res.departure);

  await c.query(
    `UPDATE reservations SET status = 'confirmed', payment_ref = $1, updated_at = now()
     WHERE id = $2`,
    [paymentRef, reservationId],
  );

  await c.query(
    `UPDATE inventory_nights
     SET held = GREATEST(held - 1, 0), sold = sold + 1, version = version + 1
     WHERE room_type_id = $1 AND night = ANY($2::date[])`,
    [res.room_type_id, nights],
  );

  await c.query(
    `INSERT INTO outbox(tenant_id, event_type, payload) VALUES ($1,'InventoryChanged',$2)`,
    [tenantId, JSON.stringify({ propertyId: res.property_id, roomTypeId: res.room_type_id, from: res.arrival, to: res.departure })],
  );

  return { paymentRef };
}

// ---- Cancel ----

export async function cancelReservation(
  c: PoolClient,
  tenantId: string,
  reservationId: string,
): Promise<{ penalty: number }> {
  const { rows } = await c.query<{
    id: string; status: string; total_amount: string;
    refundable: boolean; free_cancel_until: string | null;
    room_type_id: string; arrival: string; departure: string; property_id: string;
  }>(
    `SELECT r.id, r.status, r.total_amount, r.refundable, r.free_cancel_until::text,
            rn.room_type_id, r.arrival::text, r.departure::text, r.property_id
     FROM reservations r
     JOIN reservation_nights rn ON rn.reservation_id = r.id
     WHERE r.id = $1
     LIMIT 1`,
    [reservationId],
  );
  if (!rows[0]) throw Err.notFound('Reservation not found');
  const res = rows[0];

  if (res.status === 'cancelled') throw Err.conflict('Already cancelled');
  if (res.status === 'expired') throw Err.conflict('Hold already expired');

  const totalAmount = Number(res.total_amount);
  let penalty = 0;

  if (!res.refundable) {
    penalty = totalAmount;
  } else if (res.free_cancel_until && new Date() > new Date(res.free_cancel_until)) {
    penalty = totalAmount;
  }

  const nights = dateRange(res.arrival, res.departure);

  await c.query(
    `UPDATE reservations SET status = 'cancelled', updated_at = now() WHERE id = $1`,
    [reservationId],
  );

  if (res.status === 'held') {
    await c.query(
      `UPDATE inventory_nights
       SET held = GREATEST(held - 1, 0), version = version + 1
       WHERE room_type_id = $1 AND night = ANY($2::date[])`,
      [res.room_type_id, nights],
    );
  } else if (res.status === 'confirmed') {
    await c.query(
      `UPDATE inventory_nights
       SET sold = GREATEST(sold - 1, 0), version = version + 1
       WHERE room_type_id = $1 AND night = ANY($2::date[])`,
      [res.room_type_id, nights],
    );
  }

  await c.query(
    `INSERT INTO outbox(tenant_id, event_type, payload) VALUES ($1,'InventoryChanged',$2)`,
    [tenantId, JSON.stringify({ propertyId: res.property_id, roomTypeId: res.room_type_id, from: res.arrival, to: res.departure })],
  );

  return { penalty };
}

// ---- OTA inbound booking ----

export async function inboundOtaBooking(
  c: PoolClient,
  tenantId: string,
  params: {
    propertyId: string;
    channelId: string;
    ratePlanId: string;
    roomTypeId: string;
    adults: number;
    arrival: string;
    departure: string;
    externalRef: string;
    totalAmount: number;
  },
): Promise<{ reservationId: string; overbooked: boolean }> {
  const nights = dateRange(params.arrival, params.departure);

  // Idempotency: ON CONFLICT DO NOTHING
  const { rows: existing } = await c.query<{ id: string }>(
    `SELECT id FROM reservations WHERE channel_id = $1 AND external_ref = $2`,
    [params.channelId, params.externalRef],
  );
  if (existing[0]) {
    return { reservationId: existing[0].id, overbooked: false };
  }

  // Lock and increment sold (OTA already sold; we accept even if negative)
  const { rows: invRows } = await c.query<{
    room_type_id: string; night: string; total: number; sold: number;
    held: number; out_of_order: number;
  }>(
    `SELECT room_type_id, night::text, total, sold, held, out_of_order
     FROM inventory_nights
     WHERE room_type_id = $1 AND night = ANY($2::date[])
     ORDER BY night FOR UPDATE`,
    [params.roomTypeId, nights],
  );

  let overbooked = false;
  for (const inv of invRows) {
    const free = inv.total - inv.sold - inv.held - inv.out_of_order;
    if (free <= 0) { overbooked = true; break; }
  }

  const { rows: resRows } = await c.query<{ id: string }>(
    `INSERT INTO reservations(
       tenant_id, property_id, channel_id, rate_plan_id,
       status, adults, arrival, departure, total_amount,
       external_ref, overbooked, refundable
     ) VALUES ($1,$2,$3,$4,'confirmed',$5,$6,$7,$8,$9,$10,false)
     ON CONFLICT(channel_id, external_ref) DO NOTHING
     RETURNING id`,
    [
      tenantId, params.propertyId, params.channelId, params.ratePlanId,
      params.adults, params.arrival, params.departure, params.totalAmount,
      params.externalRef, overbooked,
    ],
  );

  if (!resRows[0]) {
    // race: another concurrent insert won
    const { rows: r2 } = await c.query<{ id: string }>(
      `SELECT id FROM reservations WHERE channel_id = $1 AND external_ref = $2`,
      [params.channelId, params.externalRef],
    );
    return { reservationId: r2[0]!.id, overbooked: false };
  }

  const reservationId = resRows[0].id;

  for (const night of nights) {
    const inv = invRows.find(r => r.night === night);
    // If OTA row not found (misconfigured), still record the night but mark overbooked
    await c.query(
      `INSERT INTO reservation_nights(reservation_id, night, room_type_id, tenant_id, amount)
       VALUES ($1,$2,$3,$4,$5)`,
      [reservationId, night, params.roomTypeId, tenantId, params.totalAmount / nights.length],
    );
    if (inv) {
      await c.query(
        `UPDATE inventory_nights SET sold = sold + 1, version = version + 1
         WHERE room_type_id = $1 AND night = $2`,
        [params.roomTypeId, night],
      );
    }
  }

  const eventType = overbooked ? 'OverbookingDetected' : 'InventoryChanged';
  await c.query(
    `INSERT INTO outbox(tenant_id, event_type, payload) VALUES ($1,$2,$3)`,
    [tenantId, eventType, JSON.stringify({ propertyId: params.propertyId, roomTypeId: params.roomTypeId, from: params.arrival, to: params.departure, reservationId, overbooked })],
  );

  return { reservationId, overbooked };
}

// ---- OTA cancel by external ref ----

export async function cancelOtaBooking(
  c: PoolClient,
  tenantId: string,
  channelId: string,
  externalRef: string,
): Promise<{ reservationId: string }> {
  const { rows } = await c.query<{
    id: string; status: string; room_type_id: string;
    arrival: string; departure: string; property_id: string;
  }>(
    `SELECT r.id, r.status, rn.room_type_id, r.arrival::text, r.departure::text, r.property_id
     FROM reservations r
     JOIN reservation_nights rn ON rn.reservation_id = r.id
     WHERE r.channel_id = $1 AND r.external_ref = $2
     LIMIT 1`,
    [channelId, externalRef],
  );
  if (!rows[0]) throw Err.notFound('OTA reservation not found');
  const res = rows[0];

  if (res.status === 'cancelled') return { reservationId: res.id };

  const nights = dateRange(res.arrival, res.departure);

  await c.query(
    `UPDATE reservations SET status = 'cancelled', updated_at = now() WHERE id = $1`,
    [res.id],
  );
  await c.query(
    `UPDATE inventory_nights
     SET sold = GREATEST(sold - 1, 0), version = version + 1
     WHERE room_type_id = $1 AND night = ANY($2::date[])`,
    [res.room_type_id, nights],
  );
  await c.query(
    `INSERT INTO outbox(tenant_id, event_type, payload) VALUES ($1,'InventoryChanged',$2)`,
    [tenantId, JSON.stringify({ propertyId: res.property_id, roomTypeId: res.room_type_id, from: res.arrival, to: res.departure })],
  );

  return { reservationId: res.id };
}

function dateRange(arrival: string, departure: string): string[] {
  const nights: string[] = [];
  const cur = new Date(arrival);
  const end = new Date(departure);
  while (cur < end) {
    nights.push(cur.toISOString().slice(0, 10));
    cur.setDate(cur.getDate() + 1);
  }
  return nights;
}
