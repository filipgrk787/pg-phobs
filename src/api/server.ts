import Fastify from 'fastify';
import { pool, withTenant, withClient } from '../lib/db.js';
import { resolveApiKey } from '../lib/auth.js';
import { AppError, Err } from '../lib/errors.js';
import { searchAvailability, getAriGrid } from '../modules/ari/queries.js';
import {
  holdReservation, confirmReservation, cancelReservation,
  inboundOtaBooking, cancelOtaBooking, MockPaymentProvider,
} from '../modules/booking/service.js';
import { setLevels, runYield, setRestrictions, setStopSell } from '../modules/yield/service.js';
import { z } from 'zod';

const app = Fastify({ logger: { level: process.env['NODE_ENV'] === 'production' ? 'warn' : 'info' } });

const payments = new MockPaymentProvider();

// ---- Error handler ----
app.setErrorHandler((err, _req, reply) => {
  if (err instanceof AppError) {
    return reply.status(err.statusCode).send({ error: err.error, message: err.message, details: err.details });
  }
  app.log.error(err);
  return reply.status(500).send({ error: 'INTERNAL', message: 'Internal server error' });
});

// ---- Auth middleware ----
app.addHook('onRequest', async (req, reply) => {
  if (req.url === '/health' || req.url === '/') return;

  const key = req.headers['x-api-key'];
  if (typeof key !== 'string' || !key) {
    return reply.status(401).send({ error: 'UNAUTHORIZED', message: 'Missing x-api-key' });
  }

  const c = await pool.connect();
  try {
    const { tenantId } = await resolveApiKey(c, key);
    (req as unknown as Record<string, string>)['tenantId'] = tenantId;
  } catch (e) {
    if (e instanceof AppError) {
      return reply.status(e.statusCode).send({ error: e.error, message: e.message });
    }
    throw e;
  } finally {
    c.release();
  }
});

function tenantId(req: unknown): string {
  return (req as Record<string, string>)['tenantId'] ?? '';
}

// ---- Health ----
app.get('/health', async () => ({ status: 'ok', ts: new Date().toISOString() }));

// ---- Properties ----
app.get('/v1/properties', async (req) => {
  return withTenant(pool, tenantId(req), async (c) => {
    const { rows } = await c.query(`
      SELECT p.id, p.name,
        json_agg(DISTINCT jsonb_build_object('id',rt.id,'code',rt.code,'name',rt.name,'total_units',rt.total_units,'max_occupancy',rt.max_occupancy)) AS room_types,
        json_agg(DISTINCT jsonb_build_object('id',rp.id,'code',rp.code,'name',rp.name,'web_only',rp.web_only,'refundable',rp.refundable)) AS rate_plans,
        json_agg(DISTINCT jsonb_build_object('id',ch.id,'code',ch.code,'markup_percent',ch.markup_percent)) AS channels
      FROM properties p
      LEFT JOIN room_types rt ON rt.property_id = p.id
      LEFT JOIN rate_plans rp ON rp.property_id = p.id
      LEFT JOIN channels ch ON ch.property_id = p.id
      GROUP BY p.id, p.name
    `);
    return { properties: rows };
  });
});

// ---- Availability ----
const availabilitySchema = z.object({
  property_id: z.string().uuid(),
  arrival: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  departure: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  adults: z.coerce.number().int().min(1).max(10),
  channel: z.string().optional(),
});

app.get('/v1/availability', async (req) => {
  const q = availabilitySchema.safeParse((req as unknown as { query: unknown }).query);
  if (!q.success) throw Err.badRequest('Invalid query params', q.error.flatten());

  return withTenant(pool, tenantId(req), async (c) => {
    const offers = await searchAvailability(c, {
      propertyId: q.data.property_id,
      arrival: q.data.arrival,
      departure: q.data.departure,
      adults: q.data.adults,
      ...(q.data.channel !== undefined ? { channelCode: q.data.channel } : {}),
    });
    return { offers };
  });
});

// ---- Hold ----
const holdSchema = z.object({
  property_id: z.string().uuid(),
  rate_plan_id: z.string().uuid(),
  room_type_id: z.string().uuid(),
  channel_id: z.string().uuid(),
  adults: z.number().int().min(1),
  arrival: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  departure: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

app.post('/v1/bookings/hold', async (req, reply) => {
  const b = holdSchema.safeParse((req as unknown as { body: unknown }).body);
  if (!b.success) throw Err.badRequest('Invalid body', b.error.flatten());

  const result = await withTenant(pool, tenantId(req), (c) =>
    holdReservation(c, tenantId(req), {
      propertyId: b.data.property_id,
      ratePlanId: b.data.rate_plan_id,
      roomTypeId: b.data.room_type_id,
      channelId: b.data.channel_id,
      adults: b.data.adults,
      arrival: b.data.arrival,
      departure: b.data.departure,
    }),
  );
  return reply.status(201).send(result);
});

// ---- Confirm ----
const confirmSchema = z.object({ payment_token: z.string().min(1) });

app.post('/v1/bookings/:id/confirm', async (req, reply) => {
  const id = (req.params as Record<string, string>)['id'] ?? '';
  const b = confirmSchema.safeParse((req as unknown as { body: unknown }).body);
  if (!b.success) throw Err.badRequest('Invalid body', b.error.flatten());

  const result = await withTenant(pool, tenantId(req), (c) =>
    confirmReservation(c, tenantId(req), id, b.data.payment_token, payments),
  );
  return reply.status(200).send(result);
});

// ---- Cancel ----
app.post('/v1/bookings/:id/cancel', async (req, reply) => {
  const id = (req.params as Record<string, string>)['id'] ?? '';
  const result = await withTenant(pool, tenantId(req), (c) =>
    cancelReservation(c, tenantId(req), id),
  );
  return reply.status(200).send(result);
});

// ---- Get booking ----
app.get('/v1/bookings/:id', async (req) => {
  const id = (req.params as Record<string, string>)['id'] ?? '';
  return withTenant(pool, tenantId(req), async (c) => {
    const { rows } = await c.query(`
      SELECT r.*, json_agg(json_build_object('night',rn.night,'amount',rn.amount) ORDER BY rn.night) AS nights
      FROM reservations r
      JOIN reservation_nights rn ON rn.reservation_id = r.id
      WHERE r.id = $1
      GROUP BY r.id
    `, [id]);
    if (!rows[0]) throw Err.notFound('Reservation not found');
    return rows[0];
  });
});

// ---- Yield: set levels ----
const setLevelsSchema = z.object({
  property_id: z.string().uuid(),
  level_code: z.string(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

app.put('/v1/yield/levels', async (req) => {
  const b = setLevelsSchema.safeParse((req as unknown as { body: unknown }).body);
  if (!b.success) throw Err.badRequest('Invalid body', b.error.flatten());
  return withTenant(pool, tenantId(req), (c) =>
    setLevels(c, tenantId(req), { propertyId: b.data.property_id, levelCode: b.data.level_code, from: b.data.from, to: b.data.to }),
  );
});

// ---- Yield: run ----
const runYieldSchema = z.object({
  property_id: z.string().uuid(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dry_run: z.boolean().optional(),
});

app.post('/v1/yield/run', async (req) => {
  const b = runYieldSchema.safeParse((req as unknown as { body: unknown }).body);
  if (!b.success) throw Err.badRequest('Invalid body', b.error.flatten());
  return withTenant(pool, tenantId(req), (c) =>
    runYield(c, tenantId(req), { propertyId: b.data.property_id, from: b.data.from, to: b.data.to, ...(b.data.dry_run !== undefined ? { dryRun: b.data.dry_run } : {}) }),
  );
});

// ---- Restrictions ----
const restrictionSchema = z.object({
  rate_plan_id: z.string().uuid(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  min_los: z.number().int().min(1).optional(),
  max_los: z.number().int().min(1).optional(),
  closed_to_arrival: z.boolean().optional(),
  closed_to_departure: z.boolean().optional(),
  stop_sell: z.boolean().optional(),
});

app.put('/v1/restrictions', async (req) => {
  const b = restrictionSchema.safeParse((req as unknown as { body: unknown }).body);
  if (!b.success) throw Err.badRequest('Invalid body', b.error.flatten());
  return withTenant(pool, tenantId(req), (c) =>
    setRestrictions(c, tenantId(req), {
      ratePlanId: b.data.rate_plan_id, from: b.data.from, to: b.data.to,
      ...(b.data.min_los !== undefined ? { minLos: b.data.min_los } : {}),
      ...(b.data.max_los !== undefined ? { maxLos: b.data.max_los } : {}),
      ...(b.data.closed_to_arrival !== undefined ? { closedToArrival: b.data.closed_to_arrival } : {}),
      ...(b.data.closed_to_departure !== undefined ? { closedToDeparture: b.data.closed_to_departure } : {}),
      ...(b.data.stop_sell !== undefined ? { stopSell: b.data.stop_sell } : {}),
    }),
  );
});

// ---- Stop sell ----
const stopSellSchema = z.object({
  room_type_id: z.string().uuid(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  stop_sell: z.boolean(),
});

app.put('/v1/inventory/stop-sell', async (req) => {
  const b = stopSellSchema.safeParse((req as unknown as { body: unknown }).body);
  if (!b.success) throw Err.badRequest('Invalid body', b.error.flatten());
  return withTenant(pool, tenantId(req), (c) =>
    setStopSell(c, tenantId(req), { roomTypeId: b.data.room_type_id, from: b.data.from, to: b.data.to, stopSell: b.data.stop_sell }),
  );
});

// ---- ARI grid ----
const ariQuerySchema = z.object({
  channel: z.string(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

app.get('/v1/properties/:id/ari', async (req) => {
  const propertyId = (req.params as Record<string, string>)['id'] ?? '';
  const q = ariQuerySchema.safeParse((req as unknown as { query: unknown }).query);
  if (!q.success) throw Err.badRequest('Invalid query params', q.error.flatten());

  return withTenant(pool, tenantId(req), async (c) => {
    const { rows: channelRows } = await c.query<{ id: string }>(
      `SELECT id FROM channels WHERE property_id = $1 AND code = $2`,
      [propertyId, q.data.channel],
    );
    if (!channelRows[0]) throw Err.notFound('Channel not found');
    return getAriGrid(c, { propertyId, channelId: channelRows[0].id, from: q.data.from, to: q.data.to });
  });
});

// ---- OTA inbound booking ----
const otaBookingSchema = z.object({
  rate_plan_id: z.string().uuid(),
  room_type_id: z.string().uuid(),
  adults: z.number().int().min(1),
  arrival: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  departure: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  external_ref: z.string().min(1),
  total_amount: z.number().min(0),
});

app.post('/v1/properties/:id/channels/:code/reservations', async (req, reply) => {
  const propertyId = (req.params as Record<string, string>)['id'] ?? '';
  const channelCode = (req.params as Record<string, string>)['code'] ?? '';
  const b = otaBookingSchema.safeParse((req as unknown as { body: unknown }).body);
  if (!b.success) throw Err.badRequest('Invalid body', b.error.flatten());

  return withTenant(pool, tenantId(req), async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `SELECT id FROM channels WHERE property_id = $1 AND code = $2`,
      [propertyId, channelCode],
    );
    if (!rows[0]) throw Err.notFound('Channel not found');

    const result = await inboundOtaBooking(c, tenantId(req), {
      propertyId,
      channelId: rows[0].id,
      ratePlanId: b.data.rate_plan_id,
      roomTypeId: b.data.room_type_id,
      adults: b.data.adults,
      arrival: b.data.arrival,
      departure: b.data.departure,
      externalRef: b.data.external_ref,
      totalAmount: b.data.total_amount,
    });
    return reply.status(201).send(result);
  });
});

// ---- OTA cancel ----
app.post('/v1/properties/:id/channels/:code/reservations/:ref/cancel', async (req) => {
  const propertyId = (req.params as Record<string, string>)['id'] ?? '';
  const channelCode = (req.params as Record<string, string>)['code'] ?? '';
  const externalRef = (req.params as Record<string, string>)['ref'] ?? '';

  return withTenant(pool, tenantId(req), async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `SELECT id FROM channels WHERE property_id = $1 AND code = $2`,
      [propertyId, channelCode],
    );
    if (!rows[0]) throw Err.notFound('Channel not found');
    return cancelOtaBooking(c, tenantId(req), rows[0].id, externalRef);
  });
});

// ---- Boot ----
const port = Number(process.env['PORT'] ?? 3000);
app.listen({ port, host: '0.0.0.0' }, (err) => {
  if (err) { app.log.error(err); process.exit(1); }
});

export { app };
