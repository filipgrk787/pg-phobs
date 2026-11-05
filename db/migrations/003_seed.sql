-- Seed: two tenants with properties, rooms, rate plans, channels, inventory
-- Idempotent via ON CONFLICT DO NOTHING / INSERT WHERE NOT EXISTS

DO $$
DECLARE
  t1_id    UUID := '11111111-1111-1111-1111-111111111111';
  t2_id    UUID := '22222222-2222-2222-2222-222222222222';
  p1_id    UUID := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  p2_id    UUID := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  dbl_id   UUID := 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  sui_id   UUID := 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  vil_id   UUID := 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
  -- price levels for p1
  p1l1 UUID := gen_random_uuid(); p1l2 UUID := gen_random_uuid();
  p1l3 UUID := gen_random_uuid(); p1l4 UUID := gen_random_uuid();
  p1l5 UUID := gen_random_uuid();
  -- price levels for p2
  p2l1 UUID := gen_random_uuid(); p2l2 UUID := gen_random_uuid();
  p2l3 UUID := gen_random_uuid(); p2l4 UUID := gen_random_uuid();
  p2l5 UUID := gen_random_uuid();
  -- rate plans p1
  bar_id  UUID := gen_random_uuid();
  nr_id   UUID := gen_random_uuid();
  sec_id  UUID := gen_random_uuid();
  -- rate plans p2
  p2bar_id UUID := gen_random_uuid();
  p2nr_id  UUID := gen_random_uuid();
  p2sec_id UUID := gen_random_uuid();
  -- channels p1
  web1_id UUID := gen_random_uuid();
  ota1_id UUID := 'f0f0f0f0-f0f0-f0f0-f0f0-f0f0f0f0f0f0';
  -- channels p2
  web2_id UUID := gen_random_uuid();
  -- level price base amounts (per night per adult)
  dbl_base NUMERIC := 100;
  sui_base NUMERIC := 150;
  vil_base NUMERIC := 200;
  cur_night DATE;
BEGIN
  -- TENANTS
  INSERT INTO tenants(id, name) VALUES
    (t1_id, 'Aegean Hotels'),
    (t2_id, 'Olive Grove Villas')
  ON CONFLICT(id) DO NOTHING;

  -- API KEYS  (sha256 of 'demo-aegean-key' and 'demo-olive-key')
  INSERT INTO api_keys(tenant_id, key_hash, description) VALUES
    (t1_id, encode(digest('demo-aegean-key','sha256'),'hex'), 'Demo key Aegean'),
    (t2_id, encode(digest('demo-olive-key', 'sha256'),'hex'), 'Demo key Olive')
  ON CONFLICT(key_hash) DO NOTHING;

  -- PROPERTIES
  INSERT INTO properties(id, tenant_id, name) VALUES
    (p1_id, t1_id, 'Aegean Bay Hotel'),
    (p2_id, t2_id, 'Olive Grove Villa')
  ON CONFLICT(id) DO NOTHING;

  -- ROOM TYPES
  INSERT INTO room_types(id, property_id, tenant_id, code, name, total_units, max_occupancy) VALUES
    (dbl_id, p1_id, t1_id, 'DBL', 'Double Room', 10, 3),
    (sui_id, p1_id, t1_id, 'SUI', 'Suite',       3,  4),
    (vil_id, p2_id, t2_id, 'VIL', 'Villa',        4,  6)
  ON CONFLICT(id) DO NOTHING;

  -- PRICE LEVELS p1
  INSERT INTO price_levels(id, property_id, tenant_id, code, multiplier) VALUES
    (p1l1, p1_id, t1_id, 'L1', 0.80),
    (p1l2, p1_id, t1_id, 'L2', 0.90),
    (p1l3, p1_id, t1_id, 'L3', 1.00),
    (p1l4, p1_id, t1_id, 'L4', 1.20),
    (p1l5, p1_id, t1_id, 'L5', 1.40)
  ON CONFLICT(id) DO NOTHING;

  -- PRICE LEVELS p2
  INSERT INTO price_levels(id, property_id, tenant_id, code, multiplier) VALUES
    (p2l1, p2_id, t2_id, 'L1', 0.80),
    (p2l2, p2_id, t2_id, 'L2', 0.90),
    (p2l3, p2_id, t2_id, 'L3', 1.00),
    (p2l4, p2_id, t2_id, 'L4', 1.20),
    (p2l5, p2_id, t2_id, 'L5', 1.40)
  ON CONFLICT(id) DO NOTHING;

  -- LEVEL PRICES p1 DBL (occ 1,2,3)
  INSERT INTO level_prices(level_id, room_type_id, tenant_id, occupancy, amount) VALUES
    (p1l1, dbl_id, t1_id, 1, ROUND(dbl_base * 0.80 * 0.85, 2)),
    (p1l1, dbl_id, t1_id, 2, ROUND(dbl_base * 0.80, 2)),
    (p1l1, dbl_id, t1_id, 3, ROUND(dbl_base * 0.80 * 1.10, 2)),
    (p1l2, dbl_id, t1_id, 1, ROUND(dbl_base * 0.90 * 0.85, 2)),
    (p1l2, dbl_id, t1_id, 2, ROUND(dbl_base * 0.90, 2)),
    (p1l2, dbl_id, t1_id, 3, ROUND(dbl_base * 0.90 * 1.10, 2)),
    (p1l3, dbl_id, t1_id, 1, ROUND(dbl_base * 1.00 * 0.85, 2)),
    (p1l3, dbl_id, t1_id, 2, ROUND(dbl_base * 1.00, 2)),
    (p1l3, dbl_id, t1_id, 3, ROUND(dbl_base * 1.00 * 1.10, 2)),
    (p1l4, dbl_id, t1_id, 1, ROUND(dbl_base * 1.20 * 0.85, 2)),
    (p1l4, dbl_id, t1_id, 2, ROUND(dbl_base * 1.20, 2)),
    (p1l4, dbl_id, t1_id, 3, ROUND(dbl_base * 1.20 * 1.10, 2)),
    (p1l5, dbl_id, t1_id, 1, ROUND(dbl_base * 1.40 * 0.85, 2)),
    (p1l5, dbl_id, t1_id, 2, ROUND(dbl_base * 1.40, 2)),
    (p1l5, dbl_id, t1_id, 3, ROUND(dbl_base * 1.40 * 1.10, 2))
  ON CONFLICT(level_id, room_type_id, occupancy) DO NOTHING;

  -- LEVEL PRICES p1 SUI (occ 1,2,3,4)
  INSERT INTO level_prices(level_id, room_type_id, tenant_id, occupancy, amount) VALUES
    (p1l1, sui_id, t1_id, 1, ROUND(sui_base * 0.80 * 0.80, 2)),
    (p1l1, sui_id, t1_id, 2, ROUND(sui_base * 0.80 * 0.90, 2)),
    (p1l1, sui_id, t1_id, 3, ROUND(sui_base * 0.80, 2)),
    (p1l1, sui_id, t1_id, 4, ROUND(sui_base * 0.80 * 1.15, 2)),
    (p1l2, sui_id, t1_id, 1, ROUND(sui_base * 0.90 * 0.80, 2)),
    (p1l2, sui_id, t1_id, 2, ROUND(sui_base * 0.90 * 0.90, 2)),
    (p1l2, sui_id, t1_id, 3, ROUND(sui_base * 0.90, 2)),
    (p1l2, sui_id, t1_id, 4, ROUND(sui_base * 0.90 * 1.15, 2)),
    (p1l3, sui_id, t1_id, 1, ROUND(sui_base * 1.00 * 0.80, 2)),
    (p1l3, sui_id, t1_id, 2, ROUND(sui_base * 1.00 * 0.90, 2)),
    (p1l3, sui_id, t1_id, 3, ROUND(sui_base * 1.00, 2)),
    (p1l3, sui_id, t1_id, 4, ROUND(sui_base * 1.00 * 1.15, 2)),
    (p1l4, sui_id, t1_id, 1, ROUND(sui_base * 1.20 * 0.80, 2)),
    (p1l4, sui_id, t1_id, 2, ROUND(sui_base * 1.20 * 0.90, 2)),
    (p1l4, sui_id, t1_id, 3, ROUND(sui_base * 1.20, 2)),
    (p1l4, sui_id, t1_id, 4, ROUND(sui_base * 1.20 * 1.15, 2)),
    (p1l5, sui_id, t1_id, 1, ROUND(sui_base * 1.40 * 0.80, 2)),
    (p1l5, sui_id, t1_id, 2, ROUND(sui_base * 1.40 * 0.90, 2)),
    (p1l5, sui_id, t1_id, 3, ROUND(sui_base * 1.40, 2)),
    (p1l5, sui_id, t1_id, 4, ROUND(sui_base * 1.40 * 1.15, 2))
  ON CONFLICT(level_id, room_type_id, occupancy) DO NOTHING;

  -- LEVEL PRICES p2 VIL (occ 1..4 for simplicity, up to max 6)
  INSERT INTO level_prices(level_id, room_type_id, tenant_id, occupancy, amount) VALUES
    (p2l1, vil_id, t2_id, 2, ROUND(vil_base * 0.80, 2)),
    (p2l1, vil_id, t2_id, 4, ROUND(vil_base * 0.80 * 1.20, 2)),
    (p2l2, vil_id, t2_id, 2, ROUND(vil_base * 0.90, 2)),
    (p2l2, vil_id, t2_id, 4, ROUND(vil_base * 0.90 * 1.20, 2)),
    (p2l3, vil_id, t2_id, 2, ROUND(vil_base * 1.00, 2)),
    (p2l3, vil_id, t2_id, 4, ROUND(vil_base * 1.00 * 1.20, 2)),
    (p2l4, vil_id, t2_id, 2, ROUND(vil_base * 1.20, 2)),
    (p2l4, vil_id, t2_id, 4, ROUND(vil_base * 1.20 * 1.20, 2)),
    (p2l5, vil_id, t2_id, 2, ROUND(vil_base * 1.40, 2)),
    (p2l5, vil_id, t2_id, 4, ROUND(vil_base * 1.40 * 1.20, 2))
  ON CONFLICT(level_id, room_type_id, occupancy) DO NOTHING;

  -- RATE PLANS p1
  INSERT INTO rate_plans(id, property_id, tenant_id, code, name, refundable, free_cancel_days, web_only) VALUES
    (bar_id, p1_id, t1_id, 'BAR', 'Best Available Rate', true,  3,     false)
  ON CONFLICT(id) DO NOTHING;
  INSERT INTO rate_plans(id, property_id, tenant_id, parent_id, code, name, derive_type, derive_value, refundable, free_cancel_days, web_only) VALUES
    (nr_id,  p1_id, t1_id, bar_id, 'NR',     'Non-Refundable',  'percent', -10, false, NULL, false),
    (sec_id, p1_id, t1_id, bar_id, 'SECRET', 'Secret Web Rate', 'percent', -15, true,  3,    true)
  ON CONFLICT(id) DO NOTHING;

  -- RATE PLANS p2
  INSERT INTO rate_plans(id, property_id, tenant_id, code, name, refundable, free_cancel_days, web_only) VALUES
    (p2bar_id, p2_id, t2_id, 'BAR', 'Best Available Rate', true,  3,     false)
  ON CONFLICT(id) DO NOTHING;
  INSERT INTO rate_plans(id, property_id, tenant_id, parent_id, code, name, derive_type, derive_value, refundable, free_cancel_days, web_only) VALUES
    (p2nr_id,  p2_id, t2_id, p2bar_id, 'NR',     'Non-Refundable',  'percent', -10, false, NULL,  false),
    (p2sec_id, p2_id, t2_id, p2bar_id, 'SECRET', 'Secret Web Rate', 'percent', -15, true,  3,     true)
  ON CONFLICT(id) DO NOTHING;

  -- CHANNELS p1
  INSERT INTO channels(id, property_id, tenant_id, code, markup_percent, adapter) VALUES
    (web1_id, p1_id, t1_id, 'web', 0,  'none'),
    (ota1_id, p1_id, t1_id, 'ota', 15, 'mock-ota')
  ON CONFLICT(id) DO NOTHING;

  -- CHANNELS p2 (web only)
  INSERT INTO channels(id, property_id, tenant_id, code, markup_percent, adapter) VALUES
    (web2_id, p2_id, t2_id, 'web', 0, 'none')
  ON CONFLICT(id) DO NOTHING;

  -- CHANNEL MAPPINGS for ota1 (BAR + NR rate plans mapped to OTA codes)
  INSERT INTO channel_mappings(channel_id, tenant_id, room_type_id, rate_plan_id, ota_room_code, ota_rate_code) VALUES
    (ota1_id, t1_id, dbl_id, bar_id, 'OTA_DBL', 'OTA_BAR'),
    (ota1_id, t1_id, dbl_id, nr_id,  'OTA_DBL', 'OTA_NR'),
    (ota1_id, t1_id, sui_id, bar_id, 'OTA_SUI', 'OTA_BAR'),
    (ota1_id, t1_id, sui_id, nr_id,  'OTA_SUI', 'OTA_NR')
  ON CONFLICT DO NOTHING;

  -- DEFAULT NIGHT LEVELS: L3 for 365 days
  FOR cur_night IN
    SELECT generate_series(CURRENT_DATE, CURRENT_DATE + 364, '1 day'::interval)::DATE
  LOOP
    INSERT INTO night_levels(property_id, night, tenant_id, level_id) VALUES
      (p1_id, cur_night, t1_id, p1l3),
      (p2_id, cur_night, t2_id, p2l3)
    ON CONFLICT(property_id, night) DO NOTHING;
  END LOOP;

  -- INVENTORY: 365 days for all room types
  FOR cur_night IN
    SELECT generate_series(CURRENT_DATE, CURRENT_DATE + 364, '1 day'::interval)::DATE
  LOOP
    INSERT INTO inventory_nights(room_type_id, night, tenant_id, total) VALUES
      (dbl_id, cur_night, t1_id, 10),
      (sui_id, cur_night, t1_id,  3),
      (vil_id, cur_night, t2_id,  4)
    ON CONFLICT(room_type_id, night) DO NOTHING;
  END LOOP;

END$$;
