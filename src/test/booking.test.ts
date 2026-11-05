import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  testPool, ownerPool, resetTestData,
  TENANT1, TENANT2, PROPERTY1, PROPERTY2,
  DBL_RT, SUI_RT, VIL_RT, OTA_CHANNEL_ID,
  tomorrow, addDays,
  getTenantRatePlan,
} from './helpers.js';
import { withTenant } from '../lib/db.js';
import {
  holdReservation, confirmReservation, cancelReservation,
  inboundOtaBooking, cancelOtaBooking, MockPaymentProvider,
} from '../modules/booking/service.js';

const payments = new MockPaymentProvider();

before(async () => {
  await resetTestData();
});

describe('booking: hold -> confirm', () => {
  beforeEach(async () => { await resetTestData(); });

  it('hold -> confirm moves held to sold', async () => {
    const arr = tomorrow();
    const dep = addDays(arr, 2);
    const webChannelId = await getWebChannel(TENANT1, PROPERTY1);
    const barPlanId = await getTenantRatePlan(TENANT1, 'BAR');

    const { reservationId } = await withTenant(testPool, TENANT1, (c) =>
      holdReservation(c, TENANT1, {
        propertyId: PROPERTY1, ratePlanId: barPlanId,
        roomTypeId: DBL_RT, channelId: webChannelId,
        adults: 2, arrival: arr, departure: dep,
      }),
    );

    // Verify held=1 on those nights
    const inv = await getInventory(DBL_RT, arr);
    assert.equal(inv.held, 1, 'held should be 1 after hold');
    assert.equal(inv.sold, 0, 'sold should be 0 after hold');

    await withTenant(testPool, TENANT1, (c) =>
      confirmReservation(c, TENANT1, reservationId, 'tok-valid', payments),
    );

    const inv2 = await getInventory(DBL_RT, arr);
    assert.equal(inv2.held, 0, 'held should be 0 after confirm');
    assert.equal(inv2.sold, 1, 'sold should be 1 after confirm');
  });

  it('20 parallel holds for 3 suites => exactly 3 succeed', async () => {
    const arr = addDays(tomorrow(), 30);
    const dep = addDays(arr, 1);
    const webChannelId = await getWebChannel(TENANT1, PROPERTY1);
    const barPlanId = await getTenantRatePlan(TENANT1, 'BAR');

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        withTenant(testPool, TENANT1, (c) =>
          holdReservation(c, TENANT1, {
            propertyId: PROPERTY1, ratePlanId: barPlanId,
            roomTypeId: SUI_RT, channelId: webChannelId,
            adults: 2, arrival: arr, departure: dep,
          }),
        ),
      ),
    );

    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    assert.equal(succeeded, 3, `Expected exactly 3 of 20 holds to succeed (SUI has 3 units), got ${succeeded}`);
  });

  it('declined payment token keeps the hold open', async () => {
    const arr = tomorrow();
    const dep = addDays(arr, 1);
    const webChannelId = await getWebChannel(TENANT1, PROPERTY1);
    const barPlanId = await getTenantRatePlan(TENANT1, 'BAR');

    const { reservationId } = await withTenant(testPool, TENANT1, (c) =>
      holdReservation(c, TENANT1, {
        propertyId: PROPERTY1, ratePlanId: barPlanId,
        roomTypeId: DBL_RT, channelId: webChannelId,
        adults: 2, arrival: arr, departure: dep,
      }),
    );

    await assert.rejects(
      () => withTenant(testPool, TENANT1, (c) =>
        confirmReservation(c, TENANT1, reservationId, 'fail', payments),
      ),
      /Card declined/,
    );

    // Reservation should still be 'held'
    const { rows } = await withTenant(testPool, TENANT1, async (c) =>
      c.query<{ status: string }>(`SELECT status FROM reservations WHERE id = $1`, [reservationId]),
    );
    assert.equal(rows[0]?.status, 'held');
  });

  it('cancellation penalty: NR = full amount', async () => {
    const arr = addDays(tomorrow(), 5);
    const dep = addDays(arr, 2);
    const webChannelId = await getWebChannel(TENANT1, PROPERTY1);
    const nrPlanId = await getTenantRatePlan(TENANT1, 'NR');

    const { reservationId, totalAmount } = await withTenant(testPool, TENANT1, (c) =>
      holdReservation(c, TENANT1, {
        propertyId: PROPERTY1, ratePlanId: nrPlanId,
        roomTypeId: DBL_RT, channelId: webChannelId,
        adults: 2, arrival: arr, departure: dep,
      }),
    );
    await withTenant(testPool, TENANT1, (c) =>
      confirmReservation(c, TENANT1, reservationId, 'tok-valid', payments),
    );
    const { penalty } = await withTenant(testPool, TENANT1, (c) =>
      cancelReservation(c, TENANT1, reservationId),
    );
    assert.equal(penalty, totalAmount, 'NR plan should have full penalty');
  });

  it('cancellation: BAR within free cancel period => penalty 0', async () => {
    const arr = addDays(tomorrow(), 10); // 10 days from now, free cancel is 3 days before arrival
    const dep = addDays(arr, 2);
    const webChannelId = await getWebChannel(TENANT1, PROPERTY1);
    const barPlanId = await getTenantRatePlan(TENANT1, 'BAR');

    const { reservationId } = await withTenant(testPool, TENANT1, (c) =>
      holdReservation(c, TENANT1, {
        propertyId: PROPERTY1, ratePlanId: barPlanId,
        roomTypeId: DBL_RT, channelId: webChannelId,
        adults: 2, arrival: arr, departure: dep,
      }),
    );
    await withTenant(testPool, TENANT1, (c) =>
      confirmReservation(c, TENANT1, reservationId, 'tok-valid', payments),
    );
    const { penalty } = await withTenant(testPool, TENANT1, (c) =>
      cancelReservation(c, TENANT1, reservationId),
    );
    assert.equal(penalty, 0, 'BAR within free cancel => no penalty');
  });
});

describe('booking: OTA inbound', () => {
  beforeEach(async () => { await resetTestData(); });

  it('OTA booking sold -> inventory decreases', async () => {
    const arr = addDays(tomorrow(), 60);
    const dep = addDays(arr, 2);
    const barPlanId = await getTenantRatePlan(TENANT1, 'BAR');

    const invBefore = await getInventory(DBL_RT, arr);

    await withTenant(testPool, TENANT1, (c) =>
      inboundOtaBooking(c, TENANT1, {
        propertyId: PROPERTY1, channelId: OTA_CHANNEL_ID,
        ratePlanId: barPlanId, roomTypeId: DBL_RT,
        adults: 2, arrival: arr, departure: dep,
        externalRef: 'OTA-001', totalAmount: 200,
      }),
    );

    const invAfter = await getInventory(DBL_RT, arr);
    assert.equal(invAfter.sold, invBefore.sold + 1, 'sold should increase by 1 after OTA booking');
  });

  it('duplicate OTA delivery recorded once', async () => {
    const arr = addDays(tomorrow(), 61);
    const dep = addDays(arr, 1);
    const barPlanId = await getTenantRatePlan(TENANT1, 'BAR');

    const r1 = await withTenant(testPool, TENANT1, (c) =>
      inboundOtaBooking(c, TENANT1, {
        propertyId: PROPERTY1, channelId: OTA_CHANNEL_ID,
        ratePlanId: barPlanId, roomTypeId: DBL_RT,
        adults: 2, arrival: arr, departure: dep,
        externalRef: 'OTA-DUP', totalAmount: 100,
      }),
    );
    const r2 = await withTenant(testPool, TENANT1, (c) =>
      inboundOtaBooking(c, TENANT1, {
        propertyId: PROPERTY1, channelId: OTA_CHANNEL_ID,
        ratePlanId: barPlanId, roomTypeId: DBL_RT,
        adults: 2, arrival: arr, departure: dep,
        externalRef: 'OTA-DUP', totalAmount: 100,
      }),
    );
    assert.equal(r1.reservationId, r2.reservationId, 'same reservationId for duplicate OTA ref');

    const inv = await getInventory(DBL_RT, arr);
    assert.equal(inv.sold, 1, 'sold should only be 1 after duplicate delivery');
  });

  it('OTA cancel by external_ref is idempotent', async () => {
    const arr = addDays(tomorrow(), 62);
    const dep = addDays(arr, 1);
    const barPlanId = await getTenantRatePlan(TENANT1, 'BAR');

    await withTenant(testPool, TENANT1, (c) =>
      inboundOtaBooking(c, TENANT1, {
        propertyId: PROPERTY1, channelId: OTA_CHANNEL_ID,
        ratePlanId: barPlanId, roomTypeId: DBL_RT,
        adults: 2, arrival: arr, departure: dep,
        externalRef: 'OTA-CANCEL', totalAmount: 100,
      }),
    );

    const r1 = await withTenant(testPool, TENANT1, (c) =>
      cancelOtaBooking(c, TENANT1, OTA_CHANNEL_ID, 'OTA-CANCEL'),
    );
    const r2 = await withTenant(testPool, TENANT1, (c) =>
      cancelOtaBooking(c, TENANT1, OTA_CHANNEL_ID, 'OTA-CANCEL'),
    );
    assert.equal(r1.reservationId, r2.reservationId);

    const inv = await getInventory(DBL_RT, arr);
    assert.equal(inv.sold, 0, 'sold should be 0 after cancel');
  });
});

describe('booking: tenant isolation', () => {
  beforeEach(async () => { await resetTestData(); });

  it('tenant B gets empty list on tenant A resources', async () => {
    // Tenant 2 trying to see Tenant 1 property should get nothing
    const { rows } = await withTenant(testPool, TENANT2, async (c) =>
      c.query(`SELECT id FROM properties WHERE id = $1`, [PROPERTY1]),
    );
    assert.equal(rows.length, 0, 'Tenant 2 should not see Tenant 1 property');
  });

  it('tenant B hold on tenant A room type fails (no inventory visible)', async () => {
    const webChannel2 = await getWebChannel(TENANT2, PROPERTY2);
    const barPlan2 = await getTenantRatePlan(TENANT2, 'BAR');

    // Try to book PROPERTY1's DBL with TENANT2's context
    await assert.rejects(
      () => withTenant(testPool, TENANT2, (c) =>
        holdReservation(c, TENANT2, {
          propertyId: PROPERTY1, ratePlanId: barPlan2,
          roomTypeId: DBL_RT, channelId: webChannel2,
          adults: 2, arrival: tomorrow(), departure: addDays(tomorrow(), 1),
        }),
      ),
    );
  });
});

describe('booking: restrictions affect availability', () => {
  beforeEach(async () => { await resetTestData(); });

  it('min_los restriction blocks short stays', async () => {
    const arr = addDays(tomorrow(), 90);
    const dep = addDays(arr, 1); // 1 night, min_los=3
    const webChannelId = await getWebChannel(TENANT1, PROPERTY1);
    const barPlanId = await getTenantRatePlan(TENANT1, 'BAR');

    // Set restriction
    await withTenant(testPool, TENANT1, async (c) => {
      await c.query(
        `INSERT INTO restrictions(rate_plan_id, tenant_id, night, min_los)
         VALUES ($1, $2, $3, 3)
         ON CONFLICT(rate_plan_id, night) DO UPDATE SET min_los = 3`,
        [barPlanId, TENANT1, arr],
      );
    });

    await assert.rejects(
      () => withTenant(testPool, TENANT1, (c) =>
        holdReservation(c, TENANT1, {
          propertyId: PROPERTY1, ratePlanId: barPlanId,
          roomTypeId: DBL_RT, channelId: webChannelId,
          adults: 2, arrival: arr, departure: dep,
        }),
      ),
    );
  });
});

describe('booking: yield level change affects price', () => {
  beforeEach(async () => { await resetTestData(); });

  it('changing level L5 raises price vs L3', async () => {
    const arr = addDays(tomorrow(), 100);
    const dep = addDays(arr, 1);
    const webChannelId = await getWebChannel(TENANT1, PROPERTY1);
    const barPlanId = await getTenantRatePlan(TENANT1, 'BAR');

    const { totalAmount: amountL3 } = await withTenant(testPool, TENANT1, (c) =>
      holdReservation(c, TENANT1, {
        propertyId: PROPERTY1, ratePlanId: barPlanId,
        roomTypeId: DBL_RT, channelId: webChannelId,
        adults: 2, arrival: arr, departure: dep,
      }),
    );
    await resetTestData();

    // Set level to L5
    await withTenant(testPool, TENANT1, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `SELECT id FROM price_levels WHERE property_id = $1 AND code = 'L5'`,
        [PROPERTY1],
      );
      await c.query(
        `UPDATE night_levels SET level_id = $1 WHERE property_id = $2 AND night = $3`,
        [rows[0]!.id, PROPERTY1, arr],
      );
    });

    const { totalAmount: amountL5 } = await withTenant(testPool, TENANT1, (c) =>
      holdReservation(c, TENANT1, {
        propertyId: PROPERTY1, ratePlanId: barPlanId,
        roomTypeId: DBL_RT, channelId: webChannelId,
        adults: 2, arrival: arr, departure: dep,
      }),
    );

    assert.ok(amountL5 > amountL3, `L5 (${amountL5}) should be more than L3 (${amountL3})`);
  });
});

// ---- Helpers ----
async function getInventory(roomTypeId: string, night: string): Promise<{ total: number; sold: number; held: number; out_of_order: number; stop_sell: boolean }> {
  // Owner bypasses RLS
  const client = await ownerPool.connect();
  try {
    const { rows } = await client.query<{ total: number; sold: number; held: number; out_of_order: number; stop_sell: boolean }>(
      `SELECT total, sold, held, out_of_order, stop_sell FROM inventory_nights WHERE room_type_id = $1 AND night = $2`,
      [roomTypeId, night],
    );
    return rows[0] ?? { total: 0, sold: 0, held: 0, out_of_order: 0, stop_sell: false };
  } finally {
    client.release();
  }
}

async function getWebChannel(tenantId: string, propertyId: string): Promise<string> {
  const client = await testPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM channels WHERE property_id = $1 AND code = 'web' LIMIT 1`,
      [propertyId],
    );
    await client.query('COMMIT');
    if (!rows[0]) throw new Error(`web channel not found for ${propertyId}`);
    return rows[0].id;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
