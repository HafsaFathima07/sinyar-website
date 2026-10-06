require('dotenv').config();
const fs = require('node:fs/promises');
const pg = require('pg');

async function main() {
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  family: Number(process.env.PG_IP_FAMILY || 4),
  ssl: process.env.DATABASE_SSL === 'true' || process.env.NODE_ENV === 'production' || /supabase\.(co|com)/i.test(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : undefined
});
try {
  const schema = await fs.readFile(require('node:path').join(__dirname, '..', 'schema.sql'), 'utf8');
  await pool.query(schema);
  console.log('Database migration completed.');
} finally {
  await pool.end();
}
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
