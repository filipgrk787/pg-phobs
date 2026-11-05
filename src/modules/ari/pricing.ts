// Pure pricing logic — no DB calls, fully unit-testable.

export interface LevelPrice {
  occupancy: number;
  amount: number; // base amount at this level
}

export interface RatePlan {
  id: string;
  code: string;
  parentId: string | null;
  deriveType: 'percent' | 'fixed' | null;
  deriveValue: number | null;
  refundable: boolean;
  freeCancelDays: number | null;
  webOnly: boolean;
}

export interface NightPriceInput {
  levelPrices: LevelPrice[];    // all prices for the active level on this night
  ratePlanChain: RatePlan[];    // from root to leaf (root first)
  channelMarkupPercent: number;
  adults: number;
}

/** Returns the nightly rate in the currency's smallest representation rounded to 2dp. */
export function computeNightPrice(input: NightPriceInput): number {
  const { levelPrices, ratePlanChain, channelMarkupPercent, adults } = input;

  // Pick base: smallest occupancy >= adults, or largest if none qualify
  const sorted = [...levelPrices].sort((a, b) => a.occupancy - b.occupancy);
  const match = sorted.find(p => p.occupancy >= adults) ?? sorted[sorted.length - 1];
  if (!match) return 0;

  let price = match.amount;

  // Walk the derivation chain (skip root which has no derive_type)
  for (const plan of ratePlanChain) {
    if (!plan.deriveType || plan.deriveValue === null) continue;
    if (plan.deriveType === 'percent') {
      price = price * (1 + plan.deriveValue / 100);
    } else {
      price = price + plan.deriveValue;
    }
  }

  // Channel markup
  price = price * (1 + channelMarkupPercent / 100);

  return round2(Math.max(price, 0));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---- Restriction checks (pure) ----

export interface RestrictionRow {
  night: string;           // ISO date
  minLos: number | null;
  maxLos: number | null;
  closedToArrival: boolean;
  closedToDeparture: boolean;
  stopSell: boolean;
}

export interface InventoryNight {
  night: string;
  free: number; // total - sold - held - out_of_order; already 0 if stop_sell
}

export type RestrictionReason =
  | 'NO_AVAILABILITY'
  | 'STOP_SELL'
  | 'CLOSED_TO_ARRIVAL'
  | 'CLOSED_TO_DEPARTURE'
  | 'MIN_LOS'
  | 'MAX_LOS'
  | 'RATE_PLAN_STOP_SELL';

export function checkRestrictions(
  arrivalDate: string,
  departureDate: string,
  nights: string[],  // sorted arrival..departure-1
  restrictions: Map<string, RestrictionRow>,
  inventory: Map<string, InventoryNight>,
): RestrictionReason | null {
  const los = nights.length;
  const departurePrev = nights[nights.length - 1] ?? arrivalDate;

  for (const night of nights) {
    const inv = inventory.get(night);
    if (!inv || inv.free <= 0) return 'NO_AVAILABILITY';

    const r = restrictions.get(night);
    if (!r) continue;

    if (r.stopSell) return 'RATE_PLAN_STOP_SELL';

    if (night === arrivalDate) {
      if (r.closedToArrival) return 'CLOSED_TO_ARRIVAL';
      if (r.minLos !== null && los < r.minLos) return 'MIN_LOS';
      if (r.maxLos !== null && los > r.maxLos) return 'MAX_LOS';
    }

    if (night === departurePrev) {
      if (r.closedToDeparture) return 'CLOSED_TO_DEPARTURE';
    }
  }

  return null;
}
