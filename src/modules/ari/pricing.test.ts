import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeNightPrice, checkRestrictions } from './pricing.js';
import type { RatePlan, LevelPrice, InventoryNight, RestrictionRow } from './pricing.js';

const bar: RatePlan = { id: '1', code: 'BAR', parentId: null, deriveType: null, deriveValue: null, refundable: true, freeCancelDays: 3, webOnly: false };
const nr: RatePlan = { id: '2', code: 'NR', parentId: '1', deriveType: 'percent', deriveValue: -10, refundable: false, freeCancelDays: null, webOnly: false };
const secret: RatePlan = { id: '3', code: 'SECRET', parentId: '1', deriveType: 'percent', deriveValue: -15, refundable: true, freeCancelDays: 3, webOnly: true };

const levelPrices: LevelPrice[] = [
  { occupancy: 1, amount: 85 },
  { occupancy: 2, amount: 100 },
  { occupancy: 3, amount: 110 },
];

describe('computeNightPrice', () => {
  it('picks base price for exact occupancy', () => {
    const price = computeNightPrice({ levelPrices, ratePlanChain: [bar], channelMarkupPercent: 0, adults: 2 });
    assert.equal(price, 100);
  });

  it('picks smallest occupancy >= adults (1 adult => 85)', () => {
    const price = computeNightPrice({ levelPrices, ratePlanChain: [bar], channelMarkupPercent: 0, adults: 1 });
    assert.equal(price, 85);
  });

  it('applies NR -10% derivation', () => {
    const price = computeNightPrice({ levelPrices, ratePlanChain: [bar, nr], channelMarkupPercent: 0, adults: 2 });
    assert.equal(price, 90);
  });

  it('applies channel markup after derivation', () => {
    // NR = 90, then 15% markup = 103.50
    const price = computeNightPrice({ levelPrices, ratePlanChain: [bar, nr], channelMarkupPercent: 15, adults: 2 });
    assert.equal(price, 103.5);
  });

  it('applies SECRET -15%', () => {
    const price = computeNightPrice({ levelPrices, ratePlanChain: [bar, secret], channelMarkupPercent: 0, adults: 2 });
    assert.equal(price, 85);
  });

  it('rounds to 2 decimal places', () => {
    const lp: LevelPrice[] = [{ occupancy: 2, amount: 100 }];
    const rp: RatePlan = { id: 'x', code: 'X', parentId: null, deriveType: 'percent', deriveValue: -7, refundable: true, freeCancelDays: null, webOnly: false };
    const price = computeNightPrice({ levelPrices: lp, ratePlanChain: [rp], channelMarkupPercent: 0, adults: 2 });
    assert.equal(price, 93); // 100 * 0.93 = 93.00
  });

  it('falls back to largest occupancy if adults > max', () => {
    const price = computeNightPrice({ levelPrices, ratePlanChain: [bar], channelMarkupPercent: 0, adults: 5 });
    assert.equal(price, 110); // largest = occ 3
  });

  it('returns 0 for empty level prices', () => {
    const price = computeNightPrice({ levelPrices: [], ratePlanChain: [bar], channelMarkupPercent: 0, adults: 2 });
    assert.equal(price, 0);
  });

  it('applies fixed derivation', () => {
    const fixedPlan: RatePlan = { id: 'f', code: 'F', parentId: null, deriveType: 'fixed', deriveValue: -20, refundable: true, freeCancelDays: null, webOnly: false };
    const price = computeNightPrice({ levelPrices: [{ occupancy: 2, amount: 100 }], ratePlanChain: [fixedPlan], channelMarkupPercent: 0, adults: 2 });
    assert.equal(price, 80);
  });
});

describe('checkRestrictions', () => {
  const makeInv = (nights: string[], free: number): Map<string, InventoryNight> =>
    new Map(nights.map(n => [n, { night: n, free }]));

  const makeRestr = (overrides: Partial<RestrictionRow> = {}): RestrictionRow => ({
    night: '2026-01-01',
    minLos: null, maxLos: null,
    closedToArrival: false, closedToDeparture: false, stopSell: false,
    ...overrides,
  });

  it('returns null when all ok', () => {
    const nights = ['2026-01-01', '2026-01-02'];
    const inv = makeInv(nights, 3);
    const result = checkRestrictions('2026-01-01', '2026-01-03', nights, new Map(), inv);
    assert.equal(result, null);
  });

  it('returns NO_AVAILABILITY when free=0', () => {
    const nights = ['2026-01-01'];
    const inv = makeInv(nights, 0);
    const result = checkRestrictions('2026-01-01', '2026-01-02', nights, new Map(), inv);
    assert.equal(result, 'NO_AVAILABILITY');
  });

  it('returns CLOSED_TO_ARRIVAL on arrival night', () => {
    const nights = ['2026-01-01', '2026-01-02'];
    const inv = makeInv(nights, 3);
    const restr = new Map([['2026-01-01', makeRestr({ closedToArrival: true })]]);
    const result = checkRestrictions('2026-01-01', '2026-01-03', nights, restr, inv);
    assert.equal(result, 'CLOSED_TO_ARRIVAL');
  });

  it('returns MIN_LOS violation', () => {
    const nights = ['2026-01-01'];
    const inv = makeInv(nights, 3);
    const restr = new Map([['2026-01-01', makeRestr({ minLos: 3 })]]);
    const result = checkRestrictions('2026-01-01', '2026-01-02', nights, restr, inv);
    assert.equal(result, 'MIN_LOS');
  });

  it('returns RATE_PLAN_STOP_SELL', () => {
    const nights = ['2026-01-01'];
    const inv = makeInv(nights, 3);
    const restr = new Map([['2026-01-01', makeRestr({ stopSell: true })]]);
    const result = checkRestrictions('2026-01-01', '2026-01-02', nights, restr, inv);
    assert.equal(result, 'RATE_PLAN_STOP_SELL');
  });

  it('returns CLOSED_TO_DEPARTURE on last night', () => {
    const nights = ['2026-01-01', '2026-01-02'];
    const inv = makeInv(nights, 3);
    // departure night - 1 is '2026-01-02', departure is '2026-01-03'
    const restr = new Map([['2026-01-02', makeRestr({ night: '2026-01-02', closedToDeparture: true })]]);
    const result = checkRestrictions('2026-01-01', '2026-01-03', nights, restr, inv);
    assert.equal(result, 'CLOSED_TO_DEPARTURE');
  });
});
