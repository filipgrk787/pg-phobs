-- Runtime roles; passwords injected via session GUCs set by the migrate runner
DO $$
DECLARE
  app_pass  text := current_setting('setup.app_password',  true);
  wkr_pass  text := current_setting('setup.worker_password', true);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stayhub_app') THEN
    EXECUTE format('CREATE ROLE stayhub_app LOGIN PASSWORD %L NOBYPASSRLS', app_pass);
  ELSE
    EXECUTE format('ALTER ROLE stayhub_app PASSWORD %L', app_pass);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stayhub_worker') THEN
    EXECUTE format('CREATE ROLE stayhub_worker LOGIN PASSWORD %L NOBYPASSRLS', wkr_pass);
  ELSE
    EXECUTE format('ALTER ROLE stayhub_worker PASSWORD %L', wkr_pass);
  END IF;
END$$;
