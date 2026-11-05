-- Extensions
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- TENANTS
-- ============================================================
CREATE TABLE tenants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key_hash    TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- SECURITY DEFINER: resolves a key hash without RLS context
CREATE OR REPLACE FUNCTION resolve_api_key(p_hash TEXT)
RETURNS TABLE(tenant_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
    SELECT ak.tenant_id FROM api_keys ak WHERE ak.key_hash = p_hash LIMIT 1;
END;
$$;

-- ============================================================
-- PROPERTIES & ROOM TYPES
-- ============================================================
CREATE TABLE properties (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE room_types (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code         TEXT NOT NULL,
  name         TEXT NOT NULL,
  total_units  INT NOT NULL CHECK (total_units > 0),
  max_occupancy INT NOT NULL CHECK (max_occupancy > 0),
  UNIQUE(property_id, code)
);

-- ============================================================
-- INVENTORY
-- ============================================================
CREATE TABLE inventory_nights (
  room_type_id  UUID NOT NULL REFERENCES room_types(id) ON DELETE CASCADE,
  night         DATE NOT NULL,
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  total         INT NOT NULL DEFAULT 0 CHECK (total >= 0),
  sold          INT NOT NULL DEFAULT 0 CHECK (sold >= 0),
  held          INT NOT NULL DEFAULT 0 CHECK (held >= 0),
  out_of_order  INT NOT NULL DEFAULT 0 CHECK (out_of_order >= 0),
  stop_sell     BOOLEAN NOT NULL DEFAULT false,
  version       INT NOT NULL DEFAULT 0,
  PRIMARY KEY (room_type_id, night)
);

-- ============================================================
-- PRICING
-- ============================================================
CREATE TABLE price_levels (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code         TEXT NOT NULL,          -- L1..L5
  multiplier   NUMERIC(6,4) NOT NULL,  -- 0.80 = 80%
  UNIQUE(property_id, code)
);

CREATE TABLE level_prices (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  level_id     UUID NOT NULL REFERENCES price_levels(id) ON DELETE CASCADE,
  room_type_id UUID NOT NULL REFERENCES room_types(id) ON DELETE CASCADE,
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  occupancy    INT NOT NULL CHECK (occupancy > 0),
  amount       NUMERIC(10,2) NOT NULL CHECK (amount >= 0),
  UNIQUE(level_id, room_type_id, occupancy)
);

CREATE TABLE night_levels (
  property_id  UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  night        DATE NOT NULL,
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  level_id     UUID NOT NULL REFERENCES price_levels(id) ON DELETE CASCADE,
  PRIMARY KEY (property_id, night)
);

-- ============================================================
-- RATE PLANS
-- ============================================================
CREATE TABLE rate_plans (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id      UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  parent_id        UUID REFERENCES rate_plans(id) ON DELETE SET NULL,
  code             TEXT NOT NULL,
  name             TEXT NOT NULL,
  derive_type      TEXT CHECK (derive_type IN ('percent','fixed')),
  derive_value     NUMERIC(10,2),
  refundable       BOOLEAN NOT NULL DEFAULT true,
  free_cancel_days INT,
  web_only         BOOLEAN NOT NULL DEFAULT false,
  UNIQUE(property_id, code)
);

CREATE TABLE restrictions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rate_plan_id    UUID NOT NULL REFERENCES rate_plans(id) ON DELETE CASCADE,
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  night           DATE NOT NULL,
  min_los         INT,
  max_los         INT,
  closed_to_arrival    BOOLEAN NOT NULL DEFAULT false,
  closed_to_departure  BOOLEAN NOT NULL DEFAULT false,
  stop_sell       BOOLEAN NOT NULL DEFAULT false,
  UNIQUE(rate_plan_id, night)
);

-- ============================================================
-- CHANNELS & MAPPINGS
-- ============================================================
CREATE TABLE channels (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code            TEXT NOT NULL,       -- web | ota | ...
  markup_percent  NUMERIC(6,2) NOT NULL DEFAULT 0,
  adapter         TEXT NOT NULL DEFAULT 'none',
  UNIQUE(property_id, code)
);

CREATE TABLE channel_mappings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id      UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  room_type_id    UUID REFERENCES room_types(id) ON DELETE CASCADE,
  rate_plan_id    UUID REFERENCES rate_plans(id) ON DELETE CASCADE,
  ota_room_code   TEXT,
  ota_rate_code   TEXT
);

-- ============================================================
-- RESERVATIONS
-- ============================================================
CREATE TABLE reservations (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  property_id        UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  channel_id         UUID NOT NULL REFERENCES channels(id) ON DELETE RESTRICT,
  rate_plan_id       UUID NOT NULL REFERENCES rate_plans(id) ON DELETE RESTRICT,
  status             TEXT NOT NULL DEFAULT 'held'
                       CHECK (status IN ('held','confirmed','cancelled','expired')),
  adults             INT NOT NULL CHECK (adults > 0),
  arrival            DATE NOT NULL,
  departure          DATE NOT NULL,
  total_amount       NUMERIC(10,2) NOT NULL CHECK (total_amount >= 0),
  external_ref       TEXT,
  overbooked         BOOLEAN NOT NULL DEFAULT false,
  refundable         BOOLEAN NOT NULL DEFAULT true,
  free_cancel_until  TIMESTAMPTZ,
  hold_expires_at    TIMESTAMPTZ,
  payment_ref        TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(channel_id, external_ref) DEFERRABLE INITIALLY IMMEDIATE
);
-- Allow multiple NULLs in external_ref (UNIQUE ignores NULLs by default in PG)

CREATE TABLE reservation_nights (
  reservation_id  UUID NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  night           DATE NOT NULL,
  room_type_id    UUID NOT NULL REFERENCES room_types(id) ON DELETE RESTRICT,
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  amount          NUMERIC(10,2) NOT NULL,
  PRIMARY KEY (reservation_id, night)
);

-- ============================================================
-- OUTBOX
-- ============================================================
CREATE TABLE outbox (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_type   TEXT NOT NULL,
  payload      JSONB NOT NULL,
  attempts     INT NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  dead         BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX outbox_pending_idx ON outbox(available_at)
  WHERE processed_at IS NULL AND dead = false;

-- ============================================================
-- YIELD RULES
-- ============================================================
CREATE TABLE yield_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  occ_threshold   NUMERIC(5,4) NOT NULL CHECK (occ_threshold BETWEEN 0 AND 1),
  level_id        UUID NOT NULL REFERENCES price_levels(id) ON DELETE CASCADE,
  priority        INT NOT NULL DEFAULT 0
);

-- ============================================================
-- GRANTS
-- ============================================================
GRANT USAGE ON SCHEMA public TO stayhub_app, stayhub_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO stayhub_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO stayhub_worker;
-- Worker gets full outbox access (needs it without RLS for dead-letter, etc.)
-- (RLS on outbox will still apply via NOBYPASSRLS; worker sets tenant via set_config)
GRANT EXECUTE ON FUNCTION resolve_api_key(TEXT) TO stayhub_app;
GRANT EXECUTE ON FUNCTION resolve_api_key(TEXT) TO stayhub_worker;

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE tenants             ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys            ENABLE ROW LEVEL SECURITY;
ALTER TABLE properties          ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_types          ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_nights    ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_levels        ENABLE ROW LEVEL SECURITY;
ALTER TABLE level_prices        ENABLE ROW LEVEL SECURITY;
ALTER TABLE night_levels        ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_plans          ENABLE ROW LEVEL SECURITY;
ALTER TABLE restrictions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE channels            ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_mappings    ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservations        ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservation_nights  ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox              ENABLE ROW LEVEL SECURITY;
ALTER TABLE yield_rules         ENABLE ROW LEVEL SECURITY;

-- Helper: returns current tenant_id GUC or NULL (empty string => NULL)
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::UUID;
$$;

-- Policy factory: tenant_id = current_tenant_id()
-- tenants table: only the row for the current tenant
CREATE POLICY tenant_isolation ON tenants
  USING (id = current_tenant_id());

-- All other tables
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'api_keys','properties','room_types','inventory_nights',
    'price_levels','level_prices','night_levels',
    'rate_plans','restrictions','channels','channel_mappings',
    'reservations','reservation_nights','outbox','yield_rules'
  ] LOOP
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id())', t);
  END LOOP;
END$$;

-- SECURITY DEFINER hold sweeper (runs across tenants)
CREATE OR REPLACE FUNCTION expire_holds()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  affected INT;
BEGIN
  WITH expired AS (
    SELECT r.id, rn.room_type_id, rn.night
    FROM reservations r
    JOIN reservation_nights rn ON rn.reservation_id = r.id
    WHERE r.status = 'held' AND r.hold_expires_at < now()
  ),
  updated_res AS (
    UPDATE reservations SET status = 'expired', updated_at = now()
    WHERE id IN (SELECT DISTINCT id FROM expired)
    RETURNING id
  ),
  updated_inv AS (
    UPDATE inventory_nights inv
    SET held = GREATEST(held - 1, 0), version = version + 1
    FROM expired e
    WHERE inv.room_type_id = e.room_type_id AND inv.night = e.night
  )
  SELECT COUNT(*) INTO affected FROM updated_res;
  RETURN affected;
END;
$$;

GRANT EXECUTE ON FUNCTION expire_holds() TO stayhub_worker;
GRANT EXECUTE ON FUNCTION current_tenant_id() TO stayhub_app, stayhub_worker;
