import pg from 'pg';
import { getAriGrid } from '../modules/ari/queries.js';
import { getAdapter } from '../modules/channels/adapter.js';
import type { AriUpdate } from '../modules/channels/adapter.js';

const POLL_MS = Number(process.env['WORKER_POLL_MS'] ?? 1000);
const MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 300_000;

const workerPool = new pg.Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? 5432),
  database: process.env['PGDATABASE'] ?? 'stayhub',
  user: process.env['PGUSER'] ?? 'stayhub_worker',
  password: process.env['PGPASSWORD'],
  max: 5,
});

workerPool.on('error', (err) => {
  console.error('[worker] pg pool error (will retry):', err.message);
});

async function processOneBatch(): Promise<number> {
  const client = await workerPool.connect();
  try {
    await client.query('BEGIN');

    // Poll: grab up to 10 unprocessed events, skip locked
    const { rows: events } = await client.query<{
      id: string; tenant_id: string; event_type: string; payload: unknown; attempts: number;
    }>(
      `SELECT id, tenant_id, event_type, payload, attempts
       FROM outbox
       WHERE processed_at IS NULL AND dead = false AND available_at <= now()
       ORDER BY available_at
       LIMIT 10
       FOR UPDATE SKIP LOCKED`,
    );

    if (events.length === 0) {
      await client.query('ROLLBACK');
      return 0;
    }

    // Coalesce InventoryChanged + RateChanged events by (tenant, property)
    type AggKey = string;
    const propertyMap = new Map<AggKey, { tenantId: string; propertyId: string; from: string; to: string; eventIds: string[] }>();

    for (const ev of events) {
      if (ev.event_type === 'InventoryChanged' || ev.event_type === 'RateChanged') {
        const p = ev.payload as { propertyId: string; from: string; to: string };
        const key: AggKey = `${ev.tenant_id}:${p.propertyId}`;
        const existing = propertyMap.get(key);
        if (existing) {
          existing.eventIds.push(ev.id);
          if (p.from < existing.from) existing.from = p.from;
          if (p.to > existing.to) existing.to = p.to;
        } else {
          propertyMap.set(key, { tenantId: ev.tenant_id, propertyId: p.propertyId, from: p.from, to: p.to, eventIds: [ev.id] });
        }
      } else {
        // Other event types (OverbookingDetected, etc.) — just log and mark done
        console.log(`[worker] event ${ev.event_type} tenant=${ev.tenant_id}`);
        await client.query(
          `UPDATE outbox SET processed_at = now() WHERE id = $1`,
          [ev.id],
        );
      }
    }

    await client.query('COMMIT');

    // Process each coalesced property batch (outside the initial transaction)
    for (const [, batch] of propertyMap) {
      await processBatch(batch.tenantId, batch.propertyId, batch.from, batch.to, batch.eventIds);
    }

    return events.length;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function processBatch(
  tenantId: string,
  propertyId: string,
  from: string,
  to: string,
  eventIds: string[],
): Promise<void> {
  const client = await workerPool.connect();
  try {
    // Set tenant context (worker RLS)
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);

    // Get all OTA channels for this property
    const { rows: channels } = await client.query<{
      id: string; code: string; adapter: string;
    }>(
      `SELECT id, code, adapter FROM channels WHERE property_id = $1 AND adapter <> 'none'`,
      [propertyId],
    );

    for (const ch of channels) {
      try {
        const { grid } = await getAriGrid(client, { propertyId, channelId: ch.id, from, to });

        // Convert grid to AriUpdate array
        const updates: AriUpdate[] = Object.entries(grid).map(([key, nightMap]) => {
          const [roomCode = '', rateCode = ''] = key.split('|');
          return {
            roomCode,
            rateCode,
            nights: Object.entries(nightMap).map(([date, v]) => ({
              date,
              price: v.price,
              free: v.free,
              stopSell: v.stopSell,
            })),
          };
        });

        const adapter = getAdapter(ch.adapter);
        await adapter.pushAri(propertyId, updates);
        console.log(`[worker] pushed ARI to ${ch.code} property=${propertyId} nights=${updates[0]?.nights.length ?? 0}`);
      } catch (err) {
        console.error(`[worker] ARI push failed channel=${ch.code}`, (err as Error).message);
        // Mark events for retry with backoff
        for (const eventId of eventIds) {
          const { rows: evRow } = await client.query<{ attempts: number }>(
            `SELECT attempts FROM outbox WHERE id = $1`,
            [eventId],
          );
          const attempts = (evRow[0]?.attempts ?? 0) + 1;
          if (attempts >= MAX_ATTEMPTS) {
            await client.query(`UPDATE outbox SET dead = true WHERE id = $1`, [eventId]);
          } else {
            const backoff = Math.min(BASE_BACKOFF_MS * Math.pow(2, attempts - 1), MAX_BACKOFF_MS);
            await client.query(
              `UPDATE outbox SET attempts = $1, available_at = now() + ($2 || ' ms')::interval WHERE id = $3`,
              [attempts, backoff, eventId],
            );
          }
        }
        await client.query('COMMIT');
        return;
      }
    }

    // Mark all events processed
    for (const eventId of eventIds) {
      await client.query(`UPDATE outbox SET processed_at = now() WHERE id = $1`, [eventId]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[worker] batch error:', (err as Error).message);
  } finally {
    client.release();
  }
}

async function runExpireHolds(): Promise<void> {
  const client = await workerPool.connect();
  try {
    const { rows } = await client.query<{ expire_holds: number }>(`SELECT expire_holds()`);
    const released = rows[0]?.expire_holds ?? 0;
    if (released > 0) console.log(`[worker] expired ${released} holds`);
  } catch (err) {
    console.error('[worker] expire_holds error:', (err as Error).message);
  } finally {
    client.release();
  }
}

let running = true;
process.on('SIGTERM', () => { running = false; });
process.on('SIGINT', () => { running = false; });

async function loop(): Promise<void> {
  console.log('[worker] started, polling every', POLL_MS, 'ms');
  let expireCounter = 0;
  while (running) {
    try {
      await processOneBatch();
    } catch (err) {
      console.error('[worker] poll error:', (err as Error).message);
    }
    expireCounter++;
    if (expireCounter >= 10) {
      expireCounter = 0;
      await runExpireHolds();
    }
    await sleep(POLL_MS);
  }
  await workerPool.end();
  console.log('[worker] stopped');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

loop().catch(err => { console.error('[worker] fatal:', err); process.exit(1); });
