import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { testPool, resetTestData, TENANT1, PROPERTY1, DBL_RT, tomorrow, addDays, getTenantRatePlan } from './helpers.js';
import { withTenant } from '../lib/db.js';
import { holdReservation, MockPaymentProvider } from '../modules/booking/service.js';

const payments = new MockPaymentProvider();

before(async () => { await resetTestData(); });

describe('input validation', () => {
  it('hold with arrival >= departure throws', async () => {
    const arr = tomorrow();
    const webChannelId = await getWebChannel(TENANT1, PROPERTY1);
    const barPlanId = await getTenantRatePlan(TENANT1, 'BAR');

    await assert.rejects(
      () => withTenant(testPool, TENANT1, (c) =>
        holdReservation(c, TENANT1, {
          propertyId: PROPERTY1, ratePlanId: barPlanId,
          roomTypeId: DBL_RT, channelId: webChannelId,
          adults: 2, arrival: arr, departure: arr, // same day
        }),
      ),
    );
  });

  it('hold with invalid room type throws not found', async () => {
    const webChannelId = await getWebChannel(TENANT1, PROPERTY1);
    const barPlanId = await getTenantRatePlan(TENANT1, 'BAR');
    const arr = tomorrow();
    const dep = addDays(arr, 1);

    await assert.rejects(
      () => withTenant(testPool, TENANT1, (c) =>
        holdReservation(c, TENANT1, {
          propertyId: PROPERTY1, ratePlanId: barPlanId,
          roomTypeId: '00000000-0000-0000-0000-000000000000',
          channelId: webChannelId,
          adults: 2, arrival: arr, departure: dep,
        }),
      ),
    );
  });

  it('stop_sell blocks hold', async () => {
    const arr = addDays(tomorrow(), 200);
    const dep = addDays(arr, 1);
    const webChannelId = await getWebChannel(TENANT1, PROPERTY1);
    const barPlanId = await getTenantRatePlan(TENANT1, 'BAR');

    // Set stop sell
    await withTenant(testPool, TENANT1, (c) =>
      c.query(`UPDATE inventory_nights SET stop_sell = true WHERE room_type_id = $1 AND night = $2`, [DBL_RT, arr]),
    );

    await assert.rejects(
      () => withTenant(testPool, TENANT1, (c) =>
        holdReservation(c, TENANT1, {
          propertyId: PROPERTY1, ratePlanId: barPlanId,
          roomTypeId: DBL_RT, channelId: webChannelId,
          adults: 2, arrival: arr, departure: dep,
        }),
      ),
      /Stop sell/,
    );
  });
});

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
