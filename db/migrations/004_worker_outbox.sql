-- Worker needs full outbox access (reads all tenants for polling),
-- but still has RLS on data tables (enforced by per-batch set_config in worker code).
-- Add a permissive policy for stayhub_worker on outbox that allows all rows.
-- PostgreSQL OR-combines multiple permissive policies, so app still only sees its tenant.
CREATE POLICY worker_full_outbox ON outbox TO stayhub_worker USING (true);
