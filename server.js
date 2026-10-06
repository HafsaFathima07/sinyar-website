import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import pgSession from 'connect-pg-simple';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createStorage } from './storage.js';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const port = Number(env.PORT || 3000);
const frontendUrl = env.FRONTEND_URL || `http://localhost:${port}`;
const nodeEnv = env.NODE_ENV || 'development';
const storageProvider = env.STORAGE_PROVIDER || (nodeEnv === 'production' || isVercel ? 'supabase' : 'local');
const isVercel = env.VERCEL === '1' || Boolean(env.VERCEL);
const databaseUrl = env.DATABASE_URL || '';
const databaseNeedsSsl = nodeEnv === 'production' || env.DATABASE_SSL === 'true' || /supabase\.(co|com)/i.test(databaseUrl);
const missing = ['DATABASE_URL', 'SESSION_SECRET'].filter(name => !env[name] || env[name].startsWith('replace-'));
if (missing.length) {
  console.error(`Startup failed: missing required environment variable(s): ${missing.join(', ')}`);
  process.exitCode = 1;
}
const pool = new Pool({
  connectionString: databaseUrl,
  max: Math.min(Number(env.PG_POOL_MAX || 3), 3),
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000,
  family: Number(env.PG_IP_FAMILY || 4),
  ssl: databaseNeedsSsl ? { rejectUnauthorized: false } : undefined
});
pool.on('error', error => console.error(`PostgreSQL pool error: ${error.message}`));
const PgStore = pgSession(session);
const uploadDir = path.resolve(__dirname, env.UPLOAD_DIR || './uploads');
const storage = createStorage({ provider: storageProvider, uploadDir, supabaseUrl: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY, bucket: env.SUPABASE_STORAGE_BUCKET || 'sinyar-files', isVercel, nodeEnv });
const app = express();
const asyncHandler = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const json = schema => (req, res, next) => { const parsed = schema.safeParse(req.body); if (!parsed.success) return next(new HttpError(422, 'Request validation failed.', parsed.error.flatten())); req.body = parsed.data; next(); };
class HttpError extends Error { constructor(status, message, details = undefined) { super(message); this.status = status; this.details = details; } }
const userIdSchema = z.string().trim().min(1).max(80);
const passwordSchema = z.string().min(8).max(200);
const loginSchema = z.object({ userId: userIdSchema, password: z.string().min(1).max(200) });
const itemSchema = z.object({ sno: z.string().max(100).optional().default(''), desc: z.string().max(20000).optional().default(''), quote: z.string().max(100).optional().default(''), po: z.string().max(100).optional().default(''), adv: z.string().max(100).optional().default(''), sample: z.string().max(100).optional().default(''), clientApp: z.string().max(100).optional().default(''), eta: z.string().max(100).optional().default(''), remarks: z.string().max(20000).optional().default(''), cost: z.string().max(100).optional().default('') });
const projectSchema = z.object({ number: z.string().trim().min(1).max(100), name: z.string().max(500).optional().default(''), client: z.string().max(500).optional().default(''), week: z.string().max(200).optional().default(''), items: z.array(itemSchema).max(500).optional().default([]), version: z.number().int().positive().optional() });
const quoteSchema = z.object({ id: z.number().int().positive().optional(), ref: z.string().max(200).optional().default(''), project: z.string().max(100).optional().default(''), vendor: z.string().max(500).optional().default(''), date: z.string().max(100).optional().default(''), valid: z.string().max(100).optional().default(''), amount: z.string().max(100).optional().default(''), status: z.string().max(100).optional().default('Pending'), fileKey: z.string().uuid().optional().nullable(), fileName: z.string().max(500).optional().nullable(), fileType: z.string().max(200).optional().nullable() });
const procurementSchema = z.object({ id: z.number().int().positive().optional(), po: z.string().max(200).optional().default(''), supplier: z.string().max(500).optional().default(''), description: z.string().max(20000).optional().default(''), orderDate: z.string().max(100).optional().default(''), deliveryDate: z.string().max(100).optional().default(''), status: z.string().max(100).optional().default('Draft'), project: z.string().max(100).optional().default('') });
const projectNumberParam = z.object({ number: z.string().trim().min(1).max(100) });
const fileParam = z.object({ key: z.string().uuid() });
const allowedTypes = new Map([
  ['pdf', ['application/pdf']],
  ['xlsx', ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/octet-stream']],
  ['xls', ['application/vnd.ms-excel', 'application/octet-stream']],
  ['csv', ['text/csv', 'application/csv', 'application/vnd.ms-excel', 'application/octet-stream']]
]);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 }, fileFilter: (_req, file, cb) => { const extension = path.extname(file.originalname).slice(1).toLowerCase(); cb(null, allowedTypes.has(extension) && allowedTypes.get(extension).includes(file.mimetype)); } });

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: frontendUrl, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 300 }));
app.use(session({ store: new PgStore({ pool, tableName: 'user_sessions', createTableIfMissing: true }), secret: env.SESSION_SECRET || 'invalid', resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax', secure: env.COOKIE_SECURE === 'true' || nodeEnv === 'production', maxAge: 8 * 60 * 60 * 1000 } }));

const send = (res, data, status = 200) => res.status(status).json(data);
const currentUser = req => req.session.user;
const owner = req => req.session.user.id;
const requireAuth = (req, _res, next) => req.session.user ? next() : next(new HttpError(401, 'Authentication required.'));
const requireAdmin = (req, _res, next) => req.session.user?.role === 'admin' ? next() : next(new HttpError(403, 'Administrator access required.'));
async function audit(req, action, entityType, entityId, metadata = {}) { await pool.query('INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, metadata) VALUES ($1,$2,$3,$4,$5)', [currentUser(req)?.id || null, action, entityType, entityId == null ? null : String(entityId), JSON.stringify(metadata)]); }
async function ensureAdmin() { const username = env.ADMIN_USERNAME; const password = env.ADMIN_PASSWORD; if (!username || !password || password.startsWith('replace-')) return; const hash = await bcrypt.hash(password, 12); await pool.query('INSERT INTO users (user_id, password_hash, role) VALUES ($1,$2,\'admin\') ON CONFLICT (user_id) DO NOTHING', [username, hash]); }
function mapMaterial(row) { return { id: row.id, sno: row.sno, desc: row.description, quote: row.quotation_received, po: row.po_status, adv: row.advance_payment, sample: row.sample_submission_date, clientApp: row.client_approval, eta: row.delivery_eta, remarks: row.remarks, cost: row.cost }; }
async function getProject(req, number) { const result = await pool.query('SELECT id, owner_id, project_number AS number, project_name AS name, client_name AS client, report_week AS week, version, updated_at AS "updatedAt" FROM projects WHERE project_number=$1', [number]); if (!result.rows[0]) throw new HttpError(404, 'Project not found.'); const project = result.rows[0]; project.items = (await pool.query('SELECT id, sno, description, quotation_received, po_status, advance_payment, sample_submission_date, client_approval, delivery_eta, remarks, cost FROM material_items WHERE project_id=$1 ORDER BY id', [project.id])).rows.map(mapMaterial); return project; }
async function saveMaterials(client, projectId, items) { await client.query('DELETE FROM material_items WHERE project_id=$1', [projectId]); for (const item of items) await client.query('INSERT INTO material_items (project_id,sno,description,quotation_received,po_status,advance_payment,sample_submission_date,client_approval,delivery_eta,remarks,cost) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [projectId,item.sno,item.desc,item.quote,item.po,item.adv,item.sample,item.clientApp,item.eta,item.remarks,item.cost]); }

app.get('/api/health', asyncHandler(async (_req, res) => { await pool.query('SELECT 1'); send(res, { status: 'ok' }); }));
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });
app.post('/api/auth/login', loginLimiter, json(loginSchema), asyncHandler(async (req, res) => { const result = await pool.query('SELECT id,user_id,password_hash,role,active FROM users WHERE user_id=$1', [req.body.userId]); const user = result.rows[0]; if (!user || !user.active || !(await bcrypt.compare(req.body.password, user.password_hash))) throw new HttpError(401, 'Invalid User ID or Password. Please try again.'); req.session.user = { id: user.id, uid: user.user_id, role: user.role }; await audit(req, 'login', 'user', user.id); send(res, { user: req.session.user }); }));
app.post('/api/auth/logout', requireAuth, asyncHandler(async (req, res) => { await audit(req, 'logout', 'user', owner(req)); req.session.destroy(error => error ? res.status(500).json({ error: 'Unable to end session.' }) : res.status(204).end()); }));
app.get('/api/auth/me', requireAuth, (req, res) => send(res, { user: currentUser(req) }));

app.get('/api/users', requireAdmin, asyncHandler(async (_req, res) => send(res, { users: (await pool.query('SELECT user_id AS "uid", role, active, created_at AS "createdAt" FROM users ORDER BY user_id')).rows })));
app.post('/api/users', requireAdmin, json(z.object({ userId: userIdSchema, password: passwordSchema })), asyncHandler(async (req, res) => { try { const result = await pool.query('INSERT INTO users (user_id,password_hash) VALUES ($1,$2) RETURNING user_id AS "uid",role,active,created_at AS "createdAt"', [req.body.userId, await bcrypt.hash(req.body.password, 12)]); await audit(req, 'create', 'user', result.rows[0].uid); send(res, { user: result.rows[0] }, 201); } catch (error) { if (error.code === '23505') throw new HttpError(409, 'User already exists.'); throw error; } }));
app.delete('/api/users/:userId', requireAdmin, asyncHandler(async (req, res) => { if (req.params.userId === currentUser(req).uid) throw new HttpError(400, 'Cannot deactivate the current administrator.'); const result = await pool.query('UPDATE users SET active=false,updated_at=NOW() WHERE user_id=$1 RETURNING id', [req.params.userId]); if (!result.rowCount) throw new HttpError(404, 'User not found.'); await audit(req, 'deactivate', 'user', req.params.userId); res.status(204).end(); }));

app.get('/api/projects', requireAuth, asyncHandler(async (req, res) => { const rows = await pool.query('SELECT project_number FROM projects ORDER BY project_number'); send(res, { projects: await Promise.all(rows.rows.map(row => getProject(req, row.project_number))) }); }));
app.get('/api/projects/by-number/:projectNumber', requireAuth, asyncHandler(async (req, res) => send(res, { project: await getProject(req, req.params.projectNumber) })));
app.put('/api/projects/:number', requireAuth, json(projectSchema), asyncHandler(async (req, res) => { const client = await pool.connect(); try { await client.query('BEGIN'); const existing = (await client.query('SELECT id,version FROM projects WHERE project_number=$1 FOR UPDATE', [req.params.number])).rows[0]; if (existing && req.body.version !== undefined && existing.version !== req.body.version) throw new HttpError(409, 'Project was changed by another session. Reload before saving.'); const project = existing ? (await client.query('UPDATE projects SET project_name=$1,client_name=$2,report_week=$3,version=version+1,updated_at=NOW() WHERE id=$4 RETURNING id,project_number AS number,project_name AS name,client_name AS client,report_week AS week,version,updated_at AS "updatedAt"', [req.body.name, req.body.client, req.body.week, existing.id])).rows[0] : (await client.query('INSERT INTO projects (owner_id,project_number,project_name,client_name,report_week) VALUES ($1,$2,$3,$4,$5) RETURNING id,project_number AS number,project_name AS name,client_name AS client,report_week AS week,version,updated_at AS "updatedAt"', [owner(req), req.params.number, req.body.name, req.body.client, req.body.week])).rows[0]; await saveMaterials(client, project.id, req.body.items); await client.query('COMMIT'); await audit(req, existing ? 'update' : 'create', 'project', project.id); project.items = req.body.items; send(res, { project }); } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } }));
app.delete('/api/projects/:number', requireAuth, asyncHandler(async (req, res) => { const found = await pool.query('SELECT id,owner_id FROM projects WHERE project_number=$1', [req.params.number]); if (!found.rowCount) throw new HttpError(404, 'Project not found.'); if (found.rows[0].owner_id !== owner(req) && currentUser(req).role !== 'admin') throw new HttpError(403, 'Delete permission denied.'); await pool.query('DELETE FROM projects WHERE id=$1', [found.rows[0].id]); await audit(req, 'delete', 'project', found.rows[0].id); res.status(204).end(); }));
app.get('/api/projects/:number/materials', requireAuth, asyncHandler(async (req, res) => send(res, { materials: (await getProject(req, req.params.number)).items })));
app.post('/api/projects/:number/materials', requireAuth, json(itemSchema), asyncHandler(async (req, res) => { const project = await getProject(req, req.params.number); const result = await pool.query('INSERT INTO material_items (project_id,sno,description,quotation_received,po_status,advance_payment,sample_submission_date,client_approval,delivery_eta,remarks,cost) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id', [project.id,req.body.sno,req.body.desc,req.body.quote,req.body.po,req.body.adv,req.body.sample,req.body.clientApp,req.body.eta,req.body.remarks,req.body.cost]); await audit(req, 'create', 'material_item', result.rows[0].id); send(res, { id: result.rows[0].id }, 201); }));
app.put('/api/projects/:number/materials/:id', requireAuth, json(itemSchema), asyncHandler(async (req, res) => { const project = await getProject(req, req.params.number); const item = req.body; const result = await pool.query('UPDATE material_items SET sno=$1,description=$2,quotation_received=$3,po_status=$4,advance_payment=$5,sample_submission_date=$6,client_approval=$7,delivery_eta=$8,remarks=$9,cost=$10,updated_at=NOW() WHERE id=$11 AND project_id=$12 RETURNING id', [item.sno,item.desc,item.quote,item.po,item.adv,item.sample,item.clientApp,item.eta,item.remarks,item.cost,req.params.id,project.id]); if (!result.rowCount) throw new HttpError(404, 'Material item not found.'); await audit(req, 'update', 'material_item', req.params.id); send(res, { ok: true }); }));
app.delete('/api/projects/:number/materials/:id', requireAuth, asyncHandler(async (req, res) => { const project = await getProject(req, req.params.number); const result = await pool.query('DELETE FROM material_items WHERE id=$1 AND project_id=$2 RETURNING id', [req.params.id,project.id]); if (!result.rowCount) throw new HttpError(404, 'Material item not found.'); await audit(req, 'delete', 'material_item', req.params.id); res.status(204).end(); }));

async function quotationRows(_req) { return (await pool.query('SELECT id,quote_ref AS ref,project_number AS project,vendor,quote_date AS date,valid_until AS valid,amount,status,document_key AS "fileKey",document_name AS "fileName",document_type AS "fileType" FROM quotations ORDER BY id')).rows; }
app.get('/api/quotations', requireAuth, asyncHandler(async (req, res) => send(res, { quotations: await quotationRows(req) })));
async function assertOwnedFile(client, _userId, fileKey) { if (!fileKey) return; const result = await client.query('SELECT storage_key FROM files WHERE storage_key=$1', [fileKey]); if (!result.rowCount) throw new HttpError(404, 'File not found.'); }
app.post('/api/quotations', requireAuth, json(quoteSchema), asyncHandler(async (req, res) => { const q = req.body; await assertOwnedFile(pool, owner(req), q.fileKey); const result = await pool.query('INSERT INTO quotations (owner_id,project_id,quote_ref,project_number,vendor,quote_date,valid_until,amount,status,document_key,document_name,document_type) VALUES ($1,(SELECT id FROM projects WHERE owner_id=$1 AND project_number=$2),$3,$2,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id', [owner(req),q.project,q.ref,q.vendor,q.date,q.valid,q.amount,q.status,q.fileKey || null,q.fileName || null,q.fileType || null]); await audit(req, 'create', 'quotation', result.rows[0].id); send(res, { id: result.rows[0].id }, 201); }));
app.put('/api/quotations', requireAuth, json(z.object({ quotations: z.array(quoteSchema).max(500) })), asyncHandler(async (req, res) => { const client = await pool.connect(); try { await client.query('BEGIN'); const oldFiles = (await client.query('SELECT document_key FROM quotations WHERE document_key IS NOT NULL')).rows.map(row => row.document_key); for (const q of req.body.quotations) await assertOwnedFile(client, owner(req), q.fileKey); await client.query('DELETE FROM quotations'); for (const q of req.body.quotations) await client.query('INSERT INTO quotations (owner_id,project_id,quote_ref,project_number,vendor,quote_date,valid_until,amount,status,document_key,document_name,document_type) VALUES ($1,(SELECT id FROM projects WHERE project_number=$2 LIMIT 1),$3,$2,$4,$5,$6,$7,$8,$9,$10,$11)', [owner(req),q.project,q.ref,q.vendor,q.date,q.valid,q.amount,q.status,q.fileKey || null,q.fileName || null,q.fileType || null]); const activeFiles = new Set(req.body.quotations.map(q => q.fileKey).filter(Boolean)); for (const fileKey of oldFiles.filter(key => !activeFiles.has(key))) { await client.query('DELETE FROM files WHERE storage_key=$1', [fileKey]); await storage.delete(fileKey); } await client.query('COMMIT'); await audit(req, 'replace', 'quotation', owner(req)); send(res, { ok: true }); } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } }));
app.put('/api/quotations/:id', requireAuth, json(quoteSchema), asyncHandler(async (req, res) => { const q = req.body; const result = await pool.query('UPDATE quotations SET quote_ref=$1,project_number=$2,vendor=$3,quote_date=$4,valid_until=$5,amount=$6,status=$7,updated_at=NOW() WHERE id=$8 RETURNING id', [q.ref,q.project,q.vendor,q.date,q.valid,q.amount,q.status,req.params.id]); if (!result.rowCount) throw new HttpError(404, 'Quotation not found.'); await audit(req, 'update', 'quotation', req.params.id); send(res, { ok: true }); }));
app.delete('/api/quotations/:id', requireAuth, asyncHandler(async (req, res) => { const found = await pool.query('SELECT id,owner_id,document_key FROM quotations WHERE id=$1', [req.params.id]); if (!found.rowCount) throw new HttpError(404, 'Quotation not found.'); if (found.rows[0].owner_id !== owner(req) && currentUser(req).role !== 'admin') throw new HttpError(403, 'Delete permission denied.'); if (found.rows[0].document_key && (await pool.query('SELECT 1 FROM quotations WHERE document_key=$1 AND id<>$2 LIMIT 1', [found.rows[0].document_key, req.params.id])).rowCount === 0) { await storage.delete(found.rows[0].document_key); await pool.query('DELETE FROM files WHERE storage_key=$1', [found.rows[0].document_key]); } await pool.query('DELETE FROM quotations WHERE id=$1', [req.params.id]); await audit(req, 'delete', 'quotation', req.params.id); res.status(204).end(); }));

async function procurementRows(_req) { return (await pool.query('SELECT id,purchase_order AS "po",supplier,description,order_date AS "orderDate",delivery_date AS "deliveryDate",status FROM procurement_items ORDER BY id')).rows; }
app.get('/api/procurement', requireAuth, asyncHandler(async (req, res) => send(res, { procurement: await procurementRows(req) })));
app.put('/api/procurement', requireAuth, json(z.object({ procurement: z.array(procurementSchema).max(500) })), asyncHandler(async (req, res) => { const client = await pool.connect(); try { await client.query('BEGIN'); await client.query('DELETE FROM procurement_items'); for (const item of req.body.procurement) await client.query('INSERT INTO procurement_items (owner_id,project_id,purchase_order,supplier,description,order_date,delivery_date,status) VALUES ($1,(SELECT id FROM projects WHERE project_number=$2 LIMIT 1),$3,$4,$5,$6,$7,$8)', [owner(req),item.project || '',item.po,item.supplier,item.description,item.orderDate,item.deliveryDate,item.status]); await client.query('COMMIT'); await audit(req, 'replace', 'procurement', owner(req)); send(res, { ok: true }); } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } }));
app.post('/api/procurement', requireAuth, json(procurementSchema), asyncHandler(async (req, res) => { const item = req.body; const result = await pool.query('INSERT INTO procurement_items (owner_id,project_id,purchase_order,supplier,description,order_date,delivery_date,status) VALUES ($1,(SELECT id FROM projects WHERE owner_id=$1 AND project_number=$2),$3,$4,$5,$6,$7,$8) RETURNING id', [owner(req),item.project,item.po,item.supplier,item.description,item.orderDate,item.deliveryDate,item.status]); await audit(req, 'create', 'procurement', result.rows[0].id); send(res, { id: result.rows[0].id }, 201); }));
app.put('/api/procurement/:id', requireAuth, json(procurementSchema), asyncHandler(async (req, res) => { const item = req.body; const result = await pool.query('UPDATE procurement_items SET purchase_order=$1,supplier=$2,description=$3,order_date=$4,delivery_date=$5,status=$6,updated_at=NOW() WHERE id=$7 RETURNING id', [item.po,item.supplier,item.description,item.orderDate,item.deliveryDate,item.status,req.params.id]); if (!result.rowCount) throw new HttpError(404, 'Procurement item not found.'); await audit(req, 'update', 'procurement', req.params.id); send(res, { ok: true }); }));
app.delete('/api/procurement/:id', requireAuth, asyncHandler(async (req, res) => { const found = await pool.query('SELECT id,owner_id FROM procurement_items WHERE id=$1', [req.params.id]); if (!found.rowCount) throw new HttpError(404, 'Procurement item not found.'); if (found.rows[0].owner_id !== owner(req) && currentUser(req).role !== 'admin') throw new HttpError(403, 'Delete permission denied.'); await pool.query('DELETE FROM procurement_items WHERE id=$1', [req.params.id]); await audit(req, 'delete', 'procurement', req.params.id); res.status(204).end(); }));

app.post('/api/files', requireAuth, asyncHandler((req, res, next) => upload.single('file')(req, res, error => error ? next(error) : next())), asyncHandler(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Unsupported or missing file. Allowed files: PDF, XLS, XLSX, CSV.');
  const extension = path.extname(req.file.originalname).slice(1).toLowerCase();
  const safeName = path.basename(req.file.originalname).replace(/[^a-zA-Z0-9._ -]/g, '_');
  if (!safeName || safeName !== req.file.originalname || !allowedTypes.get(extension)?.includes(req.file.mimetype)) throw new HttpError(400, 'Invalid file name or type.');
  let saved;
  try { saved = await storage.put(req.file, extension); } catch (error) { if (error.message === 'File storage is not configured') throw new HttpError(503, error.message); throw error; }
  try { await pool.query('INSERT INTO files (storage_key,owner_id,original_name,mime_type,size_bytes) VALUES ($1,$2,$3,$4,$5)', [saved.key,owner(req),safeName,req.file.mimetype,req.file.size]); } catch (error) { await storage.delete(saved.key); throw error; }
  await audit(req, 'create', 'file', saved.key, { name: safeName }); send(res, { fileKey: saved.key, fileName: safeName, fileType: req.file.mimetype }, 201);
}));
app.get('/api/files/:key', requireAuth, asyncHandler(async (req, res) => {
  if (!fileParam.safeParse(req.params).success) throw new HttpError(422, 'Invalid file key.');
  const result = await pool.query('SELECT original_name FROM files WHERE storage_key=$1', [req.params.key]);
  if (!result.rows[0]) throw new HttpError(404, 'File not found.');
  try { const url = await storage.getOrSignedUrl(req.params.key); res.redirect(302, url); } catch (error) { if (error.message === 'File storage is not configured') throw new HttpError(503, error.message); throw error; }
}));
app.delete('/api/files/:key', requireAuth, asyncHandler(async (req, res) => {
  if (!fileParam.safeParse(req.params).success) throw new HttpError(422, 'Invalid file key.');
  const result = await pool.query('SELECT storage_key,owner_id FROM files WHERE storage_key=$1', [req.params.key]);
  if (!result.rows[0]) throw new HttpError(404, 'File not found.');
  if (result.rows[0].owner_id !== owner(req) && currentUser(req).role !== 'admin') throw new HttpError(403, 'Delete permission denied.');
  const references = await pool.query('SELECT 1 FROM quotations WHERE document_key=$1 LIMIT 1', [req.params.key]);
  if (references.rowCount) throw new HttpError(409, 'File is still referenced by a quotation.');
  await storage.delete(req.params.key); await pool.query('DELETE FROM files WHERE storage_key=$1', [req.params.key]); await audit(req, 'delete', 'file', req.params.key); res.status(204).end();
}));

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'sinyar_enterprise_procurement_and_quotation_tracker_suite (2).html')));
app.use(express.static(__dirname));
app.use((error, _req, res, _next) => { if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File exceeds the 25 MB limit.' }); const status = error.status || (error.code === '23505' ? 409 : 500); if (status >= 500) console.error(error); res.status(status).json({ error: status === 500 ? 'Internal server error.' : error.message }); });

async function start() { if (process.exitCode) return; try { if (!isVercel) await storage.init(); await pool.query('SELECT 1'); await ensureAdmin(); app.listen(port, () => console.log(`Sinyar Tracker backend listening on ${frontendUrl} (${nodeEnv})`)); } catch (error) { console.error(`Startup failed: unable to connect to PostgreSQL. ${error.message}`); process.exitCode = 1; } }
if (!env.VERCEL) await start();
export { app, pool };
