import crypto from 'crypto';
import pg from 'pg';
import { Err } from './errors.js';

export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

export async function resolveApiKey(
  client: pg.PoolClient,
  rawKey: string,
): Promise<{ tenantId: string }> {
  const hash = hashApiKey(rawKey);
  // Uses SECURITY DEFINER function so no RLS context needed yet
  const { rows } = await client.query<{ tenant_id: string }>(
    `SELECT tenant_id FROM resolve_api_key($1)`,
    [hash],
  );
  const row = rows[0];
  if (!row) throw Err.unauthorized();
  return { tenantId: row.tenant_id };
}
