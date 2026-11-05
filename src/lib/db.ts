import pg from 'pg';

const { Pool } = pg;

export type PoolClient = pg.PoolClient;
export type QueryResult<T extends pg.QueryResultRow = pg.QueryResultRow> = pg.QueryResult<T>;

function makePool(overrides: Partial<pg.PoolConfig> = {}): pg.Pool {
  const pool = new Pool({
    host: process.env['PGHOST'] ?? 'localhost',
    port: Number(process.env['PGPORT'] ?? 5432),
    database: process.env['PGDATABASE'] ?? 'stayhub',
    user: process.env['PGUSER'] ?? 'stayhub_app',
    password: process.env['PGPASSWORD'],
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ...overrides,
  });
  pool.on('error', (err) => {
    console.error('pg pool error', err.message);
  });
  return pool;
}

export const pool = makePool();

export async function withTenant<T>(
  client: pg.Pool | pg.PoolClient,
  tenantId: string,
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const isPool = 'connect' in client && typeof (client as pg.Pool).connect === 'function' && !('release' in client);
  const c: pg.PoolClient = isPool ? await (client as pg.Pool).connect() : (client as pg.PoolClient);
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    if (isPool) c.release();
  }
}

export async function withClient<T>(
  p: pg.Pool,
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const c = await p.connect();
  try {
    return await fn(c);
  } finally {
    c.release();
  }
}
