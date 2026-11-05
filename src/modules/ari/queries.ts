import type { PoolClient } from '../../lib/db.js';
import { computeNightPrice, checkRestrictions } from './pricing.js';
import type { RatePlan, LevelPrice, RestrictionRow, InventoryNight } from './pricing.js';

export interface AvailabilityOffer {
  ratePlanId: string;
  ratePlanCode: string;
  roomTypeId: string;
  roomTypeCode: string;
  totalAmount: number;
  perNight: { night: string; amount: number }[];
  available: boolean;
  unavailableReason?: string;
  refundable: boolean;
  freeCancelUntil?: string; // ISO date
}

export interface SearchParams {
  propertyId: string;
  arrival: string;
  departure: string;
  adults: number;
  channelCode?: string;
}

export async function searchAvailability(
  c: PoolClient,
  params: SearchParams,
): Promise<AvailabilityOffer[]> {
  const { propertyId, arrival, departure, adults, channelCode } = params;

  // Build nights array
  const nights = dateRange(arrival, departure);
  if (nights.length === 0) return [];

  // Channel info
  const { rows: channelRows } = await c.query<{
    id: string; code: string; markup_percent: string;
  }>(
    `SELECT id, code, markup_percent FROM channels
     WHERE property_id = $1 AND ($2::text IS NULL OR code = $2)
     ORDER BY code`,
    [propertyId, channelCode ?? null],
  );

  const offers: AvailabilityOffer[] = [];

  for (const ch of channelRows) {
    const markupPct = Number(ch.markup_percent);

    // Rate plans visible on this channel (exclude web_only for non-web)
    const { rows: planRows } = await c.query<{
      id: string; code: string; parent_id: string | null;
      derive_type: string | null; derive_value: string | null;
      refundable: boolean; free_cancel_days: number | null; web_only: boolean;
    }>(
      `SELECT id, code, parent_id, derive_type, derive_value,
              refundable, free_cancel_days, web_only
       FROM rate_plans
       WHERE property_id = $1 AND ($2 = 'web' OR web_only = false)`,
      [propertyId, ch.code],
    );

    // Room types
    const { rows: rtRows } = await c.query<{
      id: string; code: string; total_units: number; max_occupancy: number;
    }>(
      `SELECT id, code, total_units, max_occupancy FROM room_types WHERE property_id = $1`,
      [propertyId],
    );

    for (const rt of rtRows) {
      // Inventory nights
      const { rows: invRows } = await c.query<{
        night: string; total: number; sold: number; held: number;
        out_of_order: number; stop_sell: boolean;
      }>(
        `SELECT night::text, total, sold, held, out_of_order, stop_sell
         FROM inventory_nights
         WHERE room_type_id = $1 AND night >= $2 AND night < $3`,
        [rt.id, arrival, departure],
      );

      const invMap = new Map<string, InventoryNight>();
      for (const row of invRows) {
        const free = row.stop_sell ? 0 :
          Math.max(row.total - row.sold - row.held - row.out_of_order, 0);
        invMap.set(row.night, { night: row.night, free });
      }

      // Active level prices per night
      const { rows: lpRows } = await c.query<{
        night: string; occupancy: number; amount: string;
      }>(
        `SELECT nl.night::text, lp.occupancy, lp.amount
         FROM night_levels nl
         JOIN level_prices lp ON lp.level_id = nl.level_id
           AND lp.room_type_id = $1
         WHERE nl.property_id = $2 AND nl.night >= $3 AND nl.night < $4`,
        [rt.id, propertyId, arrival, departure],
      );

      const lpByNight = new Map<string, LevelPrice[]>();
      for (const row of lpRows) {
        const list = lpByNight.get(row.night) ?? [];
        list.push({ occupancy: row.occupancy, amount: Number(row.amount) });
        lpByNight.set(row.night, list);
      }

      for (const plan of planRows) {
        // Build rate plan chain (root->leaf)
        const chain = buildChain(plan.id, planRows);

        // Restrictions
        const { rows: rRows } = await c.query<{
          night: string; min_los: number | null; max_los: number | null;
          closed_to_arrival: boolean; closed_to_departure: boolean; stop_sell: boolean;
        }>(
          `SELECT night::text, min_los, max_los, closed_to_arrival, closed_to_departure, stop_sell
           FROM restrictions
           WHERE rate_plan_id = $1 AND night >= $2 AND night < $3`,
          [plan.id, arrival, departure],
        );
        const restrictMap = new Map<string, RestrictionRow>();
        for (const row of rRows) {
          restrictMap.set(row.night, {
            night: row.night,
            minLos: row.min_los,
            maxLos: row.max_los,
            closedToArrival: row.closed_to_arrival,
            closedToDeparture: row.closed_to_departure,
            stopSell: row.stop_sell,
          });
        }

        const reason = checkRestrictions(arrival, departure, nights, restrictMap, invMap);

        // Price per night
        const perNight: { night: string; amount: number }[] = [];
        let totalAmount = 0;

        for (const night of nights) {
          const levelPrices = lpByNight.get(night) ?? [];
          const amount = computeNightPrice({ levelPrices, ratePlanChain: chain, channelMarkupPercent: markupPct, adults });
          perNight.push({ night, amount });
          totalAmount += amount;
        }
        totalAmount = Math.round(totalAmount * 100) / 100;

        // free_cancel_until: arrival - free_cancel_days
        let freeCancelUntil: string | undefined;
        if (plan.refundable && plan.free_cancel_days != null) {
          const d = new Date(arrival);
          d.setDate(d.getDate() - plan.free_cancel_days);
          freeCancelUntil = d.toISOString().slice(0, 10);
        }

        offers.push({
          ratePlanId: plan.id,
          ratePlanCode: plan.code,
          roomTypeId: rt.id,
          roomTypeCode: rt.code,
          totalAmount,
          perNight,
          available: reason === null,
          unavailableReason: reason ?? undefined,
          refundable: plan.refundable,
          freeCancelUntil,
        });
      }
    }
  }

  // Sort: available first, then by totalAmount asc
  offers.sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1;
    return a.totalAmount - b.totalAmount;
  });

  return offers;
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

type PlanRow = {
  id: string; parent_id: string | null;
  code: string;
  derive_type: string | null; derive_value: string | null;
  refundable: boolean; free_cancel_days: number | null; web_only: boolean;
};

function buildChain(leafId: string, all: PlanRow[]): import('./pricing.js').RatePlan[] {
  const map = new Map(all.map(p => [p.id, p]));
  const chain: import('./pricing.js').RatePlan[] = [];
  let cur = map.get(leafId);
  while (cur) {
    chain.unshift({
      id: cur.id,
      code: cur.code,
      parentId: cur.parent_id,
      deriveType: cur.derive_type as 'percent' | 'fixed' | null,
      deriveValue: cur.derive_value !== null ? Number(cur.derive_value) : null,
      refundable: cur.refundable,
      freeCancelDays: cur.free_cancel_days,
      webOnly: cur.web_only,
    });
    cur = cur.parent_id ? map.get(cur.parent_id) : undefined;
  }
  return chain;
}

export async function getAriGrid(
  c: PoolClient,
  params: { propertyId: string; channelId: string; from: string; to: string },
) {
  const nights = dateRange(params.from, params.to);

  const { rows: channelRows } = await c.query<{
    code: string; markup_percent: string;
    room_type_id: string; room_type_code: string;
    rate_plan_id: string; rate_plan_code: string;
    ota_room_code: string | null; ota_rate_code: string | null;
  }>(
    `SELECT ch.code, ch.markup_percent,
            rt.id AS room_type_id, rt.code AS room_type_code,
            rp.id AS rate_plan_id, rp.code AS rate_plan_code,
            cm.ota_room_code, cm.ota_rate_code
     FROM channels ch
     JOIN channel_mappings cm ON cm.channel_id = ch.id
     JOIN room_types rt ON rt.id = cm.room_type_id
     JOIN rate_plans rp ON rp.id = cm.rate_plan_id
     WHERE ch.id = $1 AND ch.property_id = $2`,
    [params.channelId, params.propertyId],
  );

  const grid: Record<string, Record<string, { price: number; free: number; stopSell: boolean }>> = {};

  for (const cm of channelRows) {
    const key = `${cm.ota_room_code}|${cm.ota_rate_code}`;

    const { rows: invRows } = await c.query<{
      night: string; total: number; sold: number; held: number;
      out_of_order: number; stop_sell: boolean;
    }>(
      `SELECT night::text, total, sold, held, out_of_order, stop_sell
       FROM inventory_nights
       WHERE room_type_id = $1 AND night >= $2 AND night < $3`,
      [cm.room_type_id, params.from, params.to],
    );

    const invMap = new Map(invRows.map(r => [r.night, r]));

    const { rows: planRows } = await c.query<PlanRow>(
      `WITH RECURSIVE chain AS (
         SELECT id, code, parent_id, derive_type, derive_value, refundable, free_cancel_days, web_only
         FROM rate_plans WHERE id = $1
         UNION ALL
         SELECT rp.id, rp.code, rp.parent_id, rp.derive_type, rp.derive_value, rp.refundable, rp.free_cancel_days, rp.web_only
         FROM rate_plans rp JOIN chain c ON c.parent_id = rp.id
       ) SELECT * FROM chain`,
      [cm.rate_plan_id],
    );

    const ratePlanChain = planRows.reverse().map(p => ({
      id: p.id,
      code: p.code,
      parentId: p.parent_id,
      deriveType: p.derive_type as 'percent' | 'fixed' | null,
      deriveValue: p.derive_value !== null ? Number(p.derive_value) : null,
      refundable: p.refundable,
      freeCancelDays: p.free_cancel_days,
      webOnly: p.web_only,
    }));

    if (!grid[key]) grid[key] = {};

    for (const night of nights) {
      const { rows: lpRows } = await c.query<{ occupancy: number; amount: string }>(
        `SELECT lp.occupancy, lp.amount
         FROM night_levels nl
         JOIN level_prices lp ON lp.level_id = nl.level_id AND lp.room_type_id = $1
         WHERE nl.property_id = $2 AND nl.night = $3`,
        [cm.room_type_id, params.propertyId, night],
      );

      const levelPrices = lpRows.map(r => ({ occupancy: r.occupancy, amount: Number(r.amount) }));
      const price = computeNightPrice({ levelPrices, ratePlanChain, channelMarkupPercent: Number(cm.markup_percent), adults: 2 });
      const inv = invMap.get(night);
      const free = inv ? (inv.stop_sell ? 0 : Math.max(inv.total - inv.sold - inv.held - inv.out_of_order, 0)) : 0;

      grid[key]![night] = { price, free, stopSell: inv?.stop_sell ?? true };
    }
  }

  return { channelCode: channelRows[0]?.code, grid };
}
