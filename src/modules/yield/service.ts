import type { PoolClient } from '../../lib/db.js';
import { Err } from '../../lib/errors.js';

export interface SetLevelsParams {
  propertyId: string;
  levelCode: string;
  from: string;
  to: string;
}

export async function setLevels(
  c: PoolClient,
  tenantId: string,
  params: SetLevelsParams,
): Promise<{ nightsUpdated: number }> {
  const { rows: levelRows } = await c.query<{ id: string }>(
    `SELECT id FROM price_levels WHERE property_id = $1 AND code = $2`,
    [params.propertyId, params.levelCode],
  );
  if (!levelRows[0]) throw Err.notFound('Price level not found: ' + params.levelCode);
  const levelId = levelRows[0].id;

  const { rowCount } = await c.query(
    `INSERT INTO night_levels(property_id, night, tenant_id, level_id)
     SELECT $1, s::date, $2, $3
     FROM generate_series($4::date, $5::date - '1 day'::interval, '1 day') s
     ON CONFLICT(property_id, night) DO UPDATE SET level_id = EXCLUDED.level_id
     WHERE night_levels.level_id <> EXCLUDED.level_id`,
    [params.propertyId, tenantId, levelId, params.from, params.to],
  );

  const nights = rowCount ?? 0;
  if (nights > 0) {
    await c.query(
      `INSERT INTO outbox(tenant_id, event_type, payload) VALUES ($1,'RateChanged',$2)`,
      [tenantId, JSON.stringify({ propertyId: params.propertyId, from: params.from, to: params.to, levelCode: params.levelCode })],
    );
  }
  return { nightsUpdated: nights };
}

export interface RunYieldParams {
  propertyId: string;
  from: string;
  to: string;
  dryRun?: boolean;
}

export interface YieldResult {
  night: string;
  occupancy: number;
  levelCode: string;
  changed: boolean;
}

export async function runYield(
  c: PoolClient,
  tenantId: string,
  params: RunYieldParams,
): Promise<YieldResult[]> {
  const nights = dateRange(params.from, params.to);
  const results: YieldResult[] = [];

  // Fetch yield rules ordered by priority desc
  const { rows: rules } = await c.query<{
    occ_threshold: string; level_id: string; priority: number;
  }>(
    `SELECT occ_threshold, level_id, priority
     FROM yield_rules WHERE property_id = $1
     ORDER BY priority DESC`,
    [params.propertyId],
  );

  // Current night levels and inventory per night
  const { rows: invRows } = await c.query<{
    night: string; total: number; sold: number; held: number;
  }>(
    `SELECT inv.night::text, SUM(inv.total) as total, SUM(inv.sold) as sold, SUM(inv.held) as held
     FROM inventory_nights inv
     JOIN room_types rt ON rt.id = inv.room_type_id
     WHERE rt.property_id = $1 AND inv.night >= $2 AND inv.night < $3
     GROUP BY inv.night`,
    [params.propertyId, params.from, params.to],
  );
  const invMap = new Map(invRows.map(r => [r.night, r]));

  const { rows: currentLevels } = await c.query<{
    night: string; level_id: string; level_code: string;
  }>(
    `SELECT nl.night::text, nl.level_id, pl.code AS level_code
     FROM night_levels nl
     JOIN price_levels pl ON pl.id = nl.level_id
     WHERE nl.property_id = $1 AND nl.night >= $2 AND nl.night < $3`,
    [params.propertyId, params.from, params.to],
  );
  const currentMap = new Map(currentLevels.map(r => [r.night, r]));

  // Base level (L3)
  const { rows: baseLevels } = await c.query<{ id: string; code: string }>(
    `SELECT id, code FROM price_levels WHERE property_id = $1 ORDER BY code`,
    [params.propertyId],
  );
  const baseLevelMap = new Map(baseLevels.map(l => [l.id, l.code]));

  for (const night of nights) {
    const inv = invMap.get(night);
    if (!inv) continue;

    const capacity = Number(inv.total);
    if (capacity === 0) continue;
    const occ = (Number(inv.sold) + Number(inv.held)) / capacity;

    // Find matching rule (highest priority first)
    let winnerLevelId: string | null = null;
    for (const rule of rules) {
      if (occ >= Number(rule.occ_threshold)) {
        winnerLevelId = rule.level_id;
        break;
      }
    }

    const current = currentMap.get(night);
    const currentLevelId = current?.level_id;

    // Find default level (L3 by code or first if not found)
    const defaultLevel = baseLevels.find(l => l.code === 'L3') ?? baseLevels[0];
    const targetLevelId = winnerLevelId ?? defaultLevel?.id ?? currentLevelId ?? '';
    const targetCode = baseLevelMap.get(targetLevelId) ?? 'L3';

    const changed = targetLevelId !== currentLevelId;

    if (changed && !params.dryRun && targetLevelId) {
      await c.query(
        `INSERT INTO night_levels(property_id, night, tenant_id, level_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT(property_id, night) DO UPDATE SET level_id = EXCLUDED.level_id`,
        [params.propertyId, night, tenantId, targetLevelId],
      );
    }

    results.push({ night, occupancy: Math.round(occ * 100) / 100, levelCode: targetCode, changed });
  }

  if (!params.dryRun) {
    const changedNights = results.filter(r => r.changed);
    if (changedNights.length > 0) {
      await c.query(
        `INSERT INTO outbox(tenant_id, event_type, payload) VALUES ($1,'RateChanged',$2)`,
        [tenantId, JSON.stringify({ propertyId: params.propertyId, from: params.from, to: params.to })],
      );
    }
  }

  return results;
}

export async function setRestrictions(
  c: PoolClient,
  tenantId: string,
  params: {
    ratePlanId: string;
    from: string;
    to: string;
    minLos?: number;
    maxLos?: number;
    closedToArrival?: boolean;
    closedToDeparture?: boolean;
    stopSell?: boolean;
  },
): Promise<{ nightsUpdated: number }> {
  const { rows: planRows } = await c.query<{ id: string }>(
    `SELECT id FROM rate_plans WHERE id = $1`,
    [params.ratePlanId],
  );
  if (!planRows[0]) throw Err.notFound('Rate plan not found');

  const nights = dateRange(params.from, params.to);
  for (const night of nights) {
    await c.query(
      `INSERT INTO restrictions(rate_plan_id, tenant_id, night, min_los, max_los, closed_to_arrival, closed_to_departure, stop_sell)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT(rate_plan_id, night) DO UPDATE SET
         min_los = COALESCE(EXCLUDED.min_los, restrictions.min_los),
         max_los = COALESCE(EXCLUDED.max_los, restrictions.max_los),
         closed_to_arrival = EXCLUDED.closed_to_arrival,
         closed_to_departure = EXCLUDED.closed_to_departure,
         stop_sell = EXCLUDED.stop_sell`,
      [
        params.ratePlanId, tenantId, night,
        params.minLos ?? null, params.maxLos ?? null,
        params.closedToArrival ?? false,
        params.closedToDeparture ?? false,
        params.stopSell ?? false,
      ],
    );
  }

  return { nightsUpdated: nights.length };
}

export async function setStopSell(
  c: PoolClient,
  _tenantId: string,
  params: { roomTypeId: string; from: string; to: string; stopSell: boolean },
): Promise<{ nightsUpdated: number }> {
  const { rowCount } = await c.query(
    `UPDATE inventory_nights SET stop_sell = $1, version = version + 1
     WHERE room_type_id = $2 AND night >= $3 AND night < $4`,
    [params.stopSell, params.roomTypeId, params.from, params.to],
  );
  return { nightsUpdated: rowCount ?? 0 };
}

function dateRange(from: string, to: string): string[] {
  const nights: string[] = [];
  const cur = new Date(from);
  const end = new Date(to);
  while (cur < end) {
    nights.push(cur.toISOString().slice(0, 10));
    cur.setDate(cur.getDate() + 1);
  }
  return nights;
}
