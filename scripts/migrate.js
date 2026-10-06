import 'dotenv/config';
import fs from 'node:fs/promises';
import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  family: Number(process.env.PG_IP_FAMILY || 4),
  ssl: process.env.DATABASE_SSL === 'true' || process.env.NODE_ENV === 'production' || /supabase\.(co|com)/i.test(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : undefined
});
try {
  const schema = await fs.readFile(new URL('../schema.sql', import.meta.url), 'utf8');
  await pool.query(schema);
  console.log('Database migration completed.');
} finally {
  await pool.end();
}
