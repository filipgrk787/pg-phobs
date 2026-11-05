import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, '../../db/migrations');

async function main() {
  const pool = new pg.Pool({
    host: process.env['PGHOST'] ?? 'localhost',
    port: Number(process.env['PGPORT'] ?? 5432),
    database: process.env['PGDATABASE'] ?? 'stayhub',
    user: process.env['OWNER_PGUSER'] ?? 'stayhub_owner',
    password: process.env['OWNER_PGPASSWORD'],
  });

  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // Inject role passwords from env into session GUCs for 001_roles.sql
    const appPass = process.env['APP_PGPASSWORD'] ?? 'stayhub_app_pass';
    const wkrPass = process.env['WORKER_PGPASSWORD'] ?? 'stayhub_worker_pass';
    await client.query(
      `SELECT set_config('setup.app_password', $1, false),
              set_config('setup.worker_password', $2, false)`,
      [appPass, wkrPass],
    );

    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const { rowCount } = await client.query(
        'SELECT 1 FROM schema_migrations WHERE filename = $1',
        [file],
      );
      if (rowCount && rowCount > 0) {
        console.log(`  skip ${file}`);
        continue;
      }
      console.log(`  apply ${file}`);
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations(filename) VALUES($1)',
          [file],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
    console.log('migrations complete');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('migration failed', err);
  process.exit(1);
});
