import pg from 'pg';

// Safety: refuse to run against non-localhost PG
const pgHost = process.env['PGHOST'] ?? 'localhost';
if (pgHost !== 'localhost' && pgHost !== '127.0.0.1') {
  console.error(`REFUSING to run tests against PGHOST=${pgHost}. Only localhost allowed.`);
  process.exit(1);
}

export const testPool = new pg.Pool({
  host: pgHost,
  port: Number(process.env['PGPORT'] ?? 5432),
  database: process.env['PGDATABASE'] ?? 'stayhub',
  user: process.env['PGUSER'] ?? 'stayhub_app',
  password: process.env['PGPASSWORD'] ?? 'stayhub_app_pass',
  max: 20,
});

export const ownerPool = new pg.Pool({
  host: pgHost,
  port: Number(process.env['PGPORT'] ?? 5432),
  database: process.env['PGDATABASE'] ?? 'stayhub',
  user: process.env['OWNER_PGUSER'] ?? 'stayhub_owner',
  password: process.env['OWNER_PGPASSWORD'] ?? 'stayhub_owner_pass',
  max: 3,
});

// Known seed IDs (from 003_seed.sql)
export const TENANT1 = '11111111-1111-1111-1111-111111111111';
export const TENANT2 = '22222222-2222-2222-2222-222222222222';
export const PROPERTY1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
export const PROPERTY2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
export const DBL_RT = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
export const SUI_RT = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
export const VIL_RT = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
export const OTA_CHANNEL_ID = 'f0f0f0f0-f0f0-f0f0-f0f0-f0f0f0f0f0f0';

export async function resetTestData(): Promise<void> {
  const client = await ownerPool.connect();
  try {
    // Reset inventory and reservations, re-run seed idempotently
    await client.query(`
      DELETE FROM outbox WHERE tenant_id IN ($1, $2)
    `, [TENANT1, TENANT2]);
    await client.query(`
      DELETE FROM reservations WHERE tenant_id IN ($1, $2)
    `, [TENANT1, TENANT2]);
    await client.query(`
      UPDATE inventory_nights SET sold = 0, held = 0, stop_sell = false, version = 0
      WHERE tenant_id IN ($1, $2)
    `, [TENANT1, TENANT2]);
    await client.query(`
      DELETE FROM restrictions WHERE tenant_id IN ($1, $2)
    `, [TENANT1, TENANT2]);
    // Reset night levels to L3
    await client.query(`
      UPDATE night_levels nl SET level_id = pl.id
      FROM price_levels pl
      WHERE pl.property_id = nl.property_id AND pl.code = 'L3'
        AND nl.tenant_id IN ($1, $2)
    `, [TENANT1, TENANT2]);
  } finally {
    client.release();
  }
}

export async function getTenantChannel(tenantId: string, channelCode: string): Promise<{ id: string; propertyId: string }> {
  const client = await testPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const { rows } = await client.query<{ id: string; property_id: string }>(
      `SELECT id, property_id FROM channels WHERE code = $1 LIMIT 1`,
      [channelCode],
    );
    await client.query('COMMIT');
    if (!rows[0]) throw new Error(`Channel ${channelCode} not found for tenant ${tenantId}`);
    return { id: rows[0].id, propertyId: rows[0].property_id };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function getTenantRatePlan(tenantId: string, code: string): Promise<string> {
  const client = await testPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM rate_plans WHERE code = $1 LIMIT 1`,
      [code],
    );
    await client.query('COMMIT');
    if (!rows[0]) throw new Error(`Rate plan ${code} not found`);
    return rows[0].id;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export function tomorrow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
