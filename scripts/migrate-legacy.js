require('dotenv').config();
const fs = require('node:fs/promises');
const path = require('node:path');
const pg = require('pg');
const bcrypt = require('bcryptjs');

async function main() {
const source = process.argv[2];
if (!source) throw new Error('Usage: npm run migrate:legacy -- ./legacy-export.json');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const input = JSON.parse(await fs.readFile(path.resolve(source), 'utf8'));
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  family: Number(process.env.PG_IP_FAMILY || 4),
  ssl: process.env.DATABASE_SSL === 'true' || process.env.NODE_ENV === 'production' || /supabase\.(co|com)/i.test(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : undefined
});
const failures = [];
const userMap = input.users || input.registeredUsers || {};
try {
  for (const [userId, record] of Object.entries(userMap)) {
    try {
      if (!record.password && !record.passwordHash) throw new Error('missing password or passwordHash');
      const passwordHash = record.passwordHash || await bcrypt.hash(record.password, 12);
      await pool.query('INSERT INTO users (user_id,password_hash,role) VALUES ($1,$2,$3) ON CONFLICT (user_id) DO NOTHING', [userId, passwordHash, record.role === 'admin' ? 'admin' : 'user']);
    } catch (error) { failures.push({ type: 'user', id: userId, error: error.message }); }
  }
  const users = (await pool.query('SELECT id,user_id FROM users')).rows;
  const ownerId = users[0]?.id;
  if (!ownerId) throw new Error('No destination user exists.');
  const projects = input.materials || input.projects || {};
  for (const [number, project] of Object.entries(projects)) {
    try {
      const result = await pool.query(`INSERT INTO projects (owner_id,project_number,project_name,client_name,report_week) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (owner_id,project_number) DO UPDATE SET project_name=EXCLUDED.project_name,client_name=EXCLUDED.client_name,report_week=EXCLUDED.report_week RETURNING id`, [ownerId, number, project.name || '', project.client || '', project.week || '']);
      for (const item of project.items || []) await pool.query('INSERT INTO material_items (project_id,sno,description,quotation_received,po_status,advance_payment,sample_submission_date,client_approval,delivery_eta,remarks,cost) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [result.rows[0].id,item.sno || '',item.desc || '',item.quote || '',item.po || '',item.adv || '',item.sample || '',item.clientApp || '',item.eta || '',item.remarks || '',item.cost || '']);
    } catch (error) { failures.push({ type: 'project', id: number, error: error.message }); }
  }
  for (const quote of input.quotations || input.quotes || []) {
    try { await pool.query('INSERT INTO quotations (owner_id,quote_ref,project_number,vendor,quote_date,valid_until,amount,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [ownerId,quote.ref || '',quote.project || '',quote.vendor || '',quote.date || '',quote.valid || '',quote.amount || '',quote.status || 'Pending']); } catch (error) { failures.push({ type: 'quotation', id: quote.ref || 'unknown', error: error.message }); }
  }
  console.log(JSON.stringify({ imported: true, failures }, null, 2));
} finally { await pool.end(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
