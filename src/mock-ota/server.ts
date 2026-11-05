import Fastify from 'fastify';
import { z } from 'zod';

const app = Fastify({ logger: false });

const API_BASE_URL = process.env['API_BASE_URL'] ?? 'http://api:3000';
const API_KEY = process.env['OTA_API_KEY'] ?? 'demo-aegean-key';
// Fixed IDs for Aegean property (from seed)
const AEGEAN_PROPERTY_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const AEGEAN_CHANNEL_CODE = 'ota';
const AEGEAN_NR_PLAN_ID  = ''; // resolved at runtime from ARI push
const AEGEAN_BAR_PLAN_ID = ''; // resolved at runtime

// In-memory ARI store: grid[roomCode][rateCode][date] = { price, free, stopSell }
type NightData = { price: number; free: number; stopSell: boolean };
const grid: Record<string, Record<string, Record<string, NightData>>> = {};
// Also store rate_plan_id and room_type_id from ARI for booking simulation
const ratePlanIds: Record<string, string> = {};
const roomTypeIds: Record<string, string> = {};

// ---- Receive ARI push ----
app.post('/ari', async (req, reply) => {
  const body = (req as unknown as { body: unknown }).body as {
    propertyId: string;
    updates: { roomCode: string; rateCode: string; nights: NightData[] }[];
  };

  for (const u of body.updates ?? []) {
    if (!grid[u.roomCode]) grid[u.roomCode] = {};
    if (!grid[u.roomCode]![u.rateCode]) grid[u.roomCode]![u.rateCode] = {};
    for (const n of u.nights) {
      grid[u.roomCode]![u.rateCode]![n.date as string] = n;
    }
  }

  return reply.status(200).send({ ok: true });
});

// ---- Get current ARI ----
app.get('/ari', async () => ({ grid }));

// ---- Simulate booking ----
const simulateBookingSchema = z.object({
  room_code: z.string(),
  rate_code: z.string(),
  arrival: z.string(),
  departure: z.string(),
  adults: z.number().int().min(1).default(2),
  rate_plan_id: z.string().uuid(),
  room_type_id: z.string().uuid(),
  ignore_availability: z.boolean().default(false),
  external_ref: z.string().optional(),
});

app.post('/simulate/booking', async (req, reply) => {
  const b = simulateBookingSchema.safeParse((req as unknown as { body: unknown }).body);
  if (!b.success) return reply.status(400).send({ error: 'BAD_REQUEST', message: b.error.message });

  const nights = dateRange(b.data.arrival, b.data.departure);
  if (nights.length === 0) return reply.status(400).send({ error: 'BAD_REQUEST', message: 'Invalid dates' });

  const rateGrid = grid[b.data.room_code]?.[b.data.rate_code];

  if (!b.data.ignore_availability) {
    for (const night of nights) {
      const n = rateGrid?.[night];
      if (!n || n.free <= 0 || n.stopSell) {
        return reply.status(409).send({
          error: 'NO_AVAILABILITY',
          message: `No availability for ${night} in OTA copy`,
        });
      }
    }
  }

  // Deduct from local copy
  let totalAmount = 0;
  for (const night of nights) {
    const n = rateGrid?.[night];
    if (n) {
      n.free = Math.max(n.free - 1, 0);
      totalAmount += n.price;
    }
  }

  const externalRef = b.data.external_ref ?? `OTA-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  // Post booking to StayHub
  try {
    const res = await fetch(
      `${API_BASE_URL}/v1/properties/${AEGEAN_PROPERTY_ID}/channels/${AEGEAN_CHANNEL_CODE}/reservations`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify({
          rate_plan_id: b.data.rate_plan_id,
          room_type_id: b.data.room_type_id,
          adults: b.data.adults,
          arrival: b.data.arrival,
          departure: b.data.departure,
          external_ref: externalRef,
          total_amount: Math.round(totalAmount * 100) / 100,
        }),
      },
    );
    const data = await res.json() as unknown;
    return reply.status(res.status).send({ externalRef, stayhub: data });
  } catch (err) {
    return reply.status(502).send({ error: 'BAD_GATEWAY', message: (err as Error).message });
  }
});

// ---- Simulate cancel ----
const simulateCancelSchema = z.object({ external_ref: z.string() });

app.post('/simulate/cancel', async (req, reply) => {
  const b = simulateCancelSchema.safeParse((req as unknown as { body: unknown }).body);
  if (!b.success) return reply.status(400).send({ error: 'BAD_REQUEST', message: b.error.message });

  try {
    const res = await fetch(
      `${API_BASE_URL}/v1/properties/${AEGEAN_PROPERTY_ID}/channels/${AEGEAN_CHANNEL_CODE}/reservations/${b.data.external_ref}/cancel`,
      {
        method: 'POST',
        headers: { 'x-api-key': API_KEY },
      },
    );
    const data = await res.json() as unknown;
    return reply.status(res.status).send(data);
  } catch (err) {
    return reply.status(502).send({ error: 'BAD_GATEWAY', message: (err as Error).message });
  }
});

// ---- HTML extranet ----
app.get('/', async (_req, reply) => {
  const rows: string[] = [];
  for (const [roomCode, rateCodes] of Object.entries(grid)) {
    for (const [rateCode, nights] of Object.entries(rateCodes)) {
      for (const [date, data] of Object.entries(nights).sort(([a], [b]) => a.localeCompare(b)).slice(0, 7)) {
        rows.push(
          `<tr><td>${roomCode}</td><td>${rateCode}</td><td>${date}</td>` +
          `<td>${data.price.toFixed(2)}</td><td>${data.free}</td><td>${data.stopSell ? 'YES' : 'no'}</td></tr>`,
        );
      }
    }
  }
  const html = `<!DOCTYPE html><html><head><title>Mock OTA Extranet</title>
<style>body{font-family:monospace;padding:1em}table{border-collapse:collapse}
th,td{border:1px solid #ccc;padding:4px 8px}</style></head>
<body><h1>Mock OTA Extranet</h1>
<p>Showing first 7 days per room/rate combination</p>
<table><thead><tr><th>Room</th><th>Rate</th><th>Date</th><th>Price</th><th>Free</th><th>StopSell</th></tr></thead>
<tbody>${rows.join('\n')}</tbody></table></body></html>`;
  return reply.type('text/html').send(html);
});

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

const port = Number(process.env['MOCK_OTA_PORT'] ?? 4000);
app.listen({ port, host: '0.0.0.0' }, (err) => {
  if (err) { console.error(err); process.exit(1); }
  console.log(`[mock-ota] listening on :${port}`);
});

export { app };
