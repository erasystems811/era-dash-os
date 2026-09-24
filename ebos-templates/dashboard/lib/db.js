import pg from 'pg';

const { Pool } = pg;

// EBOS_TEST_PGLITE=1 swaps the real Postgres connection for an in-process
// embedded Postgres (PGlite) exposing the same .query(text, params) shape --
// lets sandbox/test-conversation.mjs and any future CI run exercise the
// real engine against a real (if tiny) Postgres with no server/Docker
// needed. Never used outside test runs -- production always uses the real
// Pool below.
// max defaults to pg's own default of 10 if left unset -- far too small once
// a business has thousands of customers messaging in the same window, each
// turn doing several sequential queries. DB_POOL_MAX lets each deployment
// tune this to how big its own Postgres/server actually is (see
// docker-compose.yml.template's max_connections, which this must stay under).
export const pool = process.env.EBOS_TEST_PGLITE === '1' ? await createTestPool() : new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: Number(process.env.DB_POOL_MAX) || 200,
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
  // Real production Postgres (docker-compose.yml.template's postgres
  // service) has no TZ override, so it runs UTC -- PGlite's own default
  // session timezone otherwise follows the host machine's local zone
  // (found live, 2026-09-25: a dev machine set to Africa/Lagos made every
  // date_trunc('month', ...) bucket land in the wrong month here while
  // being correct in real production), which made local test runs an
  // unreliable check of month-bucketed queries. Pinned to match production.
  await db.exec(`set timezone = 'UTC';`);
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
