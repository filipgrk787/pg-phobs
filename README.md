# StayHub PoC

A multi-tenant hotel distribution hub: one ARI engine as single source of truth, website booking engine, OTA channel, and yield manager all reading from and writing back through one transactional core.

## Quick Start

```bash
# 1. Install dependencies (Node 22 required)
npm install

# 2. Copy env
cp .env.example .env

# 3. Start everything
docker compose up --build

# 4. Run tests (in separate terminal, after compose is up)
npm test

# 5. Run demo walkthrough
bash scripts/demo.sh
```

## API Reference

All `/v1` routes require `x-api-key` header. Dates are `YYYY-MM-DD`. Ranges are from-inclusive, to-exclusive.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Liveness check |
| GET | `/v1/properties` | List properties with rooms, plans, channels |
| GET | `/v1/availability` | Search availability & prices (`?property_id&arrival&departure&adults[&channel]`) |
| POST | `/v1/bookings/hold` | Hold a reservation (15-min TTL) |
| POST | `/v1/bookings/:id/confirm` | Confirm with payment token |
| POST | `/v1/bookings/:id/cancel` | Cancel (penalty calculated from rate plan) |
| GET | `/v1/bookings/:id` | Get reservation detail |
| PUT | `/v1/yield/levels` | Set price level for a date range |
| POST | `/v1/yield/run` | Run yield rules (dry_run supported) |
| PUT | `/v1/restrictions` | Set restrictions (min/max LOS, CTA/CTD, stop_sell) |
| PUT | `/v1/inventory/stop-sell` | Toggle stop-sell on inventory |
| GET | `/v1/properties/:id/ari` | Get ARI grid for a channel (`?channel&from&to`) |
| POST | `/v1/properties/:id/channels/:code/reservations` | OTA inbound booking |
| POST | `/v1/properties/:id/channels/:code/reservations/:ref/cancel` | OTA cancel by external ref |

**Error format:** `{ error: string, message: string, details?: unknown }`

**Demo keys:**
- `demo-aegean-key` — Aegean Hotels (Aegean Bay Hotel, DBL×10, SUI×3, OTA channel)
- `demo-olive-key` — Olive Grove Villas (web only)

## Mock OTA Extranet

Browse to [http://localhost:4000](http://localhost:4000) to see the ARI table received from StayHub.

## Running Tests

Tests run against a real Postgres (must be `localhost` — safety guard).

```bash
# Start postgres only
docker compose up postgres migrate -d

# Then run tests
npm test
```

## Local → Azure Mapping

| Local | Azure |
|-------|-------|
| `postgres` container | Azure Database for PostgreSQL Flexible Server |
| `api` container | Azure Container Apps (api) |
| `worker` container | Azure Container Apps (worker) |
| `mock-ota` container | Azure Container Apps (mock-ota) — replace with real OTA adapter |
| `.env` secrets | Azure Key Vault + Container Apps secret references |
| Outbox polling | Azure Service Bus (replace poller with Service Bus trigger) or keep polling |
| `docker compose` | Azure Container Apps Environment + managed identity |

No code changes required for the move — only env var values change.

## Architecture Notes

- **Tenant isolation:** RLS on every table; `set_config('app.tenant_id', $1, true)` per transaction. Zero rows if no tenant set (fail closed).
- **Outbox pattern:** Every mutation inserts an event in the same transaction. Worker polls with `FOR UPDATE SKIP LOCKED`, coalesces by property, pushes ARI. Backoff: exponential up to 300s, dead after 8 attempts.
- **Hold sweeper:** `expire_holds()` SECURITY DEFINER function runs across tenants, called by worker every 10 polls.
- **Pricing:** Pure TS in `src/modules/ari/pricing.ts` — no DB, fully unit-testable.
- **API keys:** Stored as SHA-256 hashes; resolved via `SECURITY DEFINER` function.

## Known Limits

- Payment provider is a mock (no real Stripe integration)
- OTA adapter is a mock (no real Booking.com XML/API)
- Yield rules are configured directly in DB (no CRUD API for rules)
- No authentication beyond API keys (no JWT, no OAuth)
- No rate limiting
- Outbox worker is a simple polling loop (not Service Bus based)
