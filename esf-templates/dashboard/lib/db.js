import pg from 'pg';

const { Pool } = pg;

// ESF_TEST_PGLITE=1 swaps the real Postgres connection for an in-process
// embedded Postgres (PGlite) exposing the same .query(text, params) shape --
// lets sandbox/test-engine.mjs (and any future CI run) exercise the real
// engine against a real (if tiny) Postgres with no server/Docker needed.
// Same pattern as ebos-templates/dashboard/lib/db.js. Never used outside
// test runs -- production always uses the real Pool below.
export const pool = process.env.ESF_TEST_PGLITE === '1' ? await createTestPool() : new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: Number(process.env.DB_POOL_MAX) || 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

async function createTestPool() {
  const { PGlite } = await import('@electric-sql/pglite');
  const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');
  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const __dirname = path.dirname(fileURLToPath(import.meta.url));

  const db = new PGlite({ extensions: { pgcrypto } });
  const schema = readFileSync(path.join(__dirname, '..', '..', 'schema.sql'), 'utf8');
  await db.exec(schema);
  return {
    query: async (text, params) => db.query(text, params),
    connect: async () => ({
      query: async (text, params) => db.query(text, params),
      release: () => {},
    }),
    end: async () => db.close(),
  };
}
