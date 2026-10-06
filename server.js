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
const storageProvider = env.STORAGE_PROVIDER || 'local';
const databaseUrl = env.DATABASE_URL || '';
const databaseNeedsSsl = nodeEnv === 'production' || env.DATABASE_SSL === 'true' || /supabase\.(co|com)/i.test(databaseUrl);
const missing = ['DATABASE_URL', 'SESSION_SECRET'].filter(name => !env[name] || env[name].startsWith('replace-'));
if (missing.length) {
  console.error(`Startup failed: missing required environment variable(s): ${missing.join(', ')}`);
  process.exitCode = 1;
}
const pool = new Pool({
  connectionString: databaseUrl,
  max: Number(env.PG_POOL_MAX || 5),
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000,
  family: Number(env.PG_IP_FAMILY || 4),
  ssl: databaseNeedsSsl ? { rejectUnauthorized: false } : undefined
});
pool.on('error', error => console.error(`PostgreSQL pool error: ${error.message}`));
const PgStore = pgSession(session);
const uploadDir = path.resolve(__dirname, env.UPLOAD_DIR || './uploads');
const storage = createStorage({ provider: storageProvider, uploadDir, endpoint: env.S3_ENDPOINT, region: env.S3_REGION, bucket: env.S3_BUCKET, accessKeyId: env.S3_ACCESS_KEY_ID, secretKey: env.S3_SECRET_KEY });
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
const upload = multer({ dest: uploadDir, limits: { fileSize: 25 * 1024 * 1024 }, fileFilter: (_req, file, cb) => { const extension = path.extname(file.originalname).slice(1).toLowerCase(); cb(null, allowedTypes.has(extension) && allowedTypes.get(extension).includes(file.mimetype)); } });

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
async function getProject(req, number) { const result = await pool.query('SELECT id, project_number AS number, project_name AS name, client_name AS client, report_week AS week, version, updated_at AS "updatedAt" FROM projects WHERE owner_id=$1 AND project_number=$2', [owner(req), number]); if (!result.rows[0]) throw new HttpError(404, 'Project not found.'); const project = result.rows[0]; project.items = (await pool.query('SELECT id, sno, description, quotation_received, po_status, advance_payment, sample_submission_date, client_approval, delivery_eta, remarks, cost FROM material_items WHERE project_id=$1 ORDER BY id', [project.id])).rows.map(mapMaterial); return project; }
async function saveMaterials(client, projectId, items) { await client.query('DELETE FROM material_items WHERE project_id=$1', [projectId]); for (const item of items) await client.query('INSERT INTO material_items (project_id,sno,description,quotation_received,po_status,advance_payment,sample_submission_date,client_approval,delivery_eta,remarks,cost) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [projectId,item.sno,item.desc,item.quote,item.po,item.adv,item.sample,item.clientApp,item.eta,item.remarks,item.cost]); }

app.get('/api/health', asyncHandler(async (_req, res) => { await pool.query('SELECT 1'); send(res, { status: 'ok' }); }));
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });
app.post('/api/auth/login', loginLimiter, json(loginSchema), asyncHandler(async (req, res) => { const result = await pool.query('SELECT id,user_id,password_hash,role,active FROM users WHERE user_id=$1', [req.body.userId]); const user = result.rows[0]; if (!user || !user.active || !(await bcrypt.compare(req.body.password, user.password_hash))) throw new HttpError(401, 'Invalid User ID or Password. Please try again.'); req.session.user = { id: user.id, uid: user.user_id, role: user.role }; await audit(req, 'login', 'user', user.id); send(res, { user: req.session.user }); }));
app.post('/api/auth/logout', requireAuth, asyncHandler(async (req, res) => { await audit(req, 'logout', 'user', owner(req)); req.session.destroy(error => error ? res.status(500).json({ error: 'Unable to end session.' }) : res.status(204).end()); }));
app.get('/api/auth/me', requireAuth, (req, res) => send(res, { user: currentUser(req) }));

app.get('/api/users', requireAdmin, asyncHandler(async (_req, res) => send(res, { users: (await pool.query('SELECT user_id AS "uid", role, active, created_at AS "createdAt" FROM users ORDER BY user_id')).rows })));
app.post('/api/users', requireAdmin, json(z.object({ userId: userIdSchema, password: passwordSchema })), asyncHandler(async (req, res) => { try { const result = await pool.query('INSERT INTO users (user_id,password_hash) VALUES ($1,$2) RETURNING user_id AS "uid",role,active,created_at AS "createdAt"', [req.body.userId, await bcrypt.hash(req.body.password, 12)]); await audit(req, 'create', 'user', result.rows[0].uid); send(res, { user: result.rows[0] }, 201); } catch (error) { if (error.code === '23505') throw new HttpError(409, 'User already exists.'); throw error; } }));
app.delete('/api/users/:userId', requireAdmin, asyncHandler(async (req, res) => { if (req.params.userId === currentUser(req).uid) throw new HttpError(400, 'Cannot deactivate the current administrator.'); const result = await pool.query('UPDATE users SET active=false,updated_at=NOW() WHERE user_id=$1 RETURNING id', [req.params.userId]); if (!result.rowCount) throw new HttpError(404, 'User not found.'); await audit(req, 'deactivate', 'user', req.params.userId); res.status(204).end(); }));

app.get('/api/projects', requireAuth, asyncHandler(async (req, res) => { const rows = await pool.query('SELECT project_number FROM projects WHERE owner_id=$1 ORDER BY project_number', [owner(req)]); send(res, { projects: await Promise.all(rows.rows.map(row => getProject(req, row.project_number))) }); }));
app.get('/api/projects/by-number/:projectNumber', requireAuth, asyncHandler(async (req, res) => send(res, { project: await getProject(req, req.params.projectNumber) })));
app.put('/api/projects/:number', requireAuth, json(projectSchema), asyncHandler(async (req, res) => { const client = await pool.connect(); try { await client.query('BEGIN'); const existing = (await client.query('SELECT id,version FROM projects WHERE owner_id=$1 AND project_number=$2 FOR UPDATE', [owner(req), req.params.number])).rows[0]; if (existing && req.body.version !== undefined && existing.version !== req.body.version) throw new HttpError(409, 'Project was changed by another session. Reload before saving.'); const project = (await client.query(`INSERT INTO projects (owner_id,project_number,project_name,client_name,report_week,version) VALUES ($1,$2,$3,$4,$5,1) ON CONFLICT (owner_id,project_number) DO UPDATE SET project_name=$3,client_name=$4,report_week=$5,version=projects.version+1,updated_at=NOW() RETURNING id,project_number AS number,project_name AS name,client_name AS client,report_week AS week,version,updated_at AS "updatedAt"`, [owner(req), req.params.number, req.body.name, req.body.client, req.body.week])).rows[0]; await saveMaterials(client, project.id, req.body.items); await client.query('COMMIT'); await audit(req, existing ? 'update' : 'create', 'project', project.id); project.items = req.body.items; send(res, { project }); } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } }));
app.delete('/api/projects/:number', requireAuth, asyncHandler(async (req, res) => { const result = await pool.query('DELETE FROM projects WHERE owner_id=$1 AND project_number=$2 RETURNING id', [owner(req), req.params.number]); if (!result.rowCount) throw new HttpError(404, 'Project not found.'); await audit(req, 'delete', 'project', result.rows[0].id); res.status(204).end(); }));
app.get('/api/projects/:number/materials', requireAuth, asyncHandler(async (req, res) => send(res, { materials: (await getProject(req, req.params.number)).items })));
app.post('/api/projects/:number/materials', requireAuth, json(itemSchema), asyncHandler(async (req, res) => { const project = await getProject(req, req.params.number); const result = await pool.query('INSERT INTO material_items (project_id,sno,description,quotation_received,po_status,advance_payment,sample_submission_date,client_approval,delivery_eta,remarks,cost) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id', [project.id,req.body.sno,req.body.desc,req.body.quote,req.body.po,req.body.adv,req.body.sample,req.body.clientApp,req.body.eta,req.body.remarks,req.body.cost]); await audit(req, 'create', 'material_item', result.rows[0].id); send(res, { id: result.rows[0].id }, 201); }));
app.put('/api/projects/:number/materials/:id', requireAuth, json(itemSchema), asyncHandler(async (req, res) => { const project = await getProject(req, req.params.number); const item = req.body; const result = await pool.query('UPDATE material_items SET sno=$1,description=$2,quotation_received=$3,po_status=$4,advance_payment=$5,sample_submission_date=$6,client_approval=$7,delivery_eta=$8,remarks=$9,cost=$10,updated_at=NOW() WHERE id=$11 AND project_id=$12 RETURNING id', [item.sno,item.desc,item.quote,item.po,item.adv,item.sample,item.clientApp,item.eta,item.remarks,item.cost,req.params.id,project.id]); if (!result.rowCount) throw new HttpError(404, 'Material item not found.'); await audit(req, 'update', 'material_item', req.params.id); send(res, { ok: true }); }));
app.delete('/api/projects/:number/materials/:id', requireAuth, asyncHandler(async (req, res) => { const project = await getProject(req, req.params.number); const result = await pool.query('DELETE FROM material_items WHERE id=$1 AND project_id=$2 RETURNING id', [req.params.id,project.id]); if (!result.rowCount) throw new HttpError(404, 'Material item not found.'); await audit(req, 'delete', 'material_item', req.params.id); res.status(204).end(); }));

async function quotationRows(req) { return (await pool.query('SELECT id,quote_ref AS ref,project_number AS project,vendor,quote_date AS date,valid_until AS valid,amount,status,document_key AS "fileKey",document_name AS "fileName",document_type AS "fileType" FROM quotations WHERE owner_id=$1 ORDER BY id', [owner(req)])).rows; }
app.get('/api/quotations', requireAuth, asyncHandler(async (req, res) => send(res, { quotations: await quotationRows(req) })));
async function assertOwnedFile(client, userId, fileKey) { if (!fileKey) return; const result = await client.query('SELECT storage_key FROM files WHERE storage_key=$1 AND owner_id=$2', [fileKey, userId]); if (!result.rowCount) throw new HttpError(403, 'File access denied.'); }
app.post('/api/quotations', requireAuth, json(quoteSchema), asyncHandler(async (req, res) => { const q = req.body; await assertOwnedFile(pool, owner(req), q.fileKey); const result = await pool.query('INSERT INTO quotations (owner_id,project_id,quote_ref,project_number,vendor,quote_date,valid_until,amount,status,document_key,document_name,document_type) VALUES ($1,(SELECT id FROM projects WHERE owner_id=$1 AND project_number=$2),$3,$2,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id', [owner(req),q.project,q.ref,q.vendor,q.date,q.valid,q.amount,q.status,q.fileKey || null,q.fileName || null,q.fileType || null]); await audit(req, 'create', 'quotation', result.rows[0].id); send(res, { id: result.rows[0].id }, 201); }));
app.put('/api/quotations', requireAuth, json(z.object({ quotations: z.array(quoteSchema).max(500) })), asyncHandler(async (req, res) => { const client = await pool.connect(); try { await client.query('BEGIN'); const oldFiles = (await client.query('SELECT document_key FROM quotations WHERE owner_id=$1 AND document_key IS NOT NULL', [owner(req)])).rows.map(row => row.document_key); for (const q of req.body.quotations) await assertOwnedFile(client, owner(req), q.fileKey); await client.query('DELETE FROM quotations WHERE owner_id=$1', [owner(req)]); for (const q of req.body.quotations) await client.query('INSERT INTO quotations (owner_id,project_id,quote_ref,project_number,vendor,quote_date,valid_until,amount,status,document_key,document_name,document_type) VALUES ($1,(SELECT id FROM projects WHERE owner_id=$1 AND project_number=$2),$3,$2,$4,$5,$6,$7,$8,$9,$10,$11)', [owner(req),q.project,q.ref,q.vendor,q.date,q.valid,q.amount,q.status,q.fileKey || null,q.fileName || null,q.fileType || null]); const activeFiles = new Set(req.body.quotations.map(q => q.fileKey).filter(Boolean)); for (const fileKey of oldFiles.filter(key => !activeFiles.has(key))) { await client.query('DELETE FROM files WHERE storage_key=$1 AND owner_id=$2', [fileKey, owner(req)]); await storage.remove(fileKey); } await client.query('COMMIT'); await audit(req, 'replace', 'quotation', owner(req)); send(res, { ok: true }); } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } }));
app.put('/api/quotations/:id', requireAuth, json(quoteSchema), asyncHandler(async (req, res) => { const q = req.body; const result = await pool.query('UPDATE quotations SET quote_ref=$1,project_number=$2,vendor=$3,quote_date=$4,valid_until=$5,amount=$6,status=$7,updated_at=NOW() WHERE id=$8 AND owner_id=$9 RETURNING id', [q.ref,q.project,q.vendor,q.date,q.valid,q.amount,q.status,req.params.id,owner(req)]); if (!result.rowCount) throw new HttpError(404, 'Quotation not found.'); await audit(req, 'update', 'quotation', req.params.id); send(res, { ok: true }); }));
app.delete('/api/quotations/:id', requireAuth, asyncHandler(async (req, res) => { const result = await pool.query('DELETE FROM quotations WHERE id=$1 AND owner_id=$2 RETURNING id', [req.params.id,owner(req)]); if (!result.rowCount) throw new HttpError(404, 'Quotation not found.'); await audit(req, 'delete', 'quotation', req.params.id); res.status(204).end(); }));

async function procurementRows(req) { return (await pool.query('SELECT id,purchase_order AS "po",supplier,description,order_date AS "orderDate",delivery_date AS "deliveryDate",status FROM procurement_items WHERE owner_id=$1 ORDER BY id', [owner(req)])).rows; }
app.get('/api/procurement', requireAuth, asyncHandler(async (req, res) => send(res, { procurement: await procurementRows(req) })));
app.put('/api/procurement', requireAuth, json(z.object({ procurement: z.array(procurementSchema).max(500) })), asyncHandler(async (req, res) => { const client = await pool.connect(); try { await client.query('BEGIN'); await client.query('DELETE FROM procurement_items WHERE owner_id=$1', [owner(req)]); for (const item of req.body.procurement) await client.query('INSERT INTO procurement_items (owner_id,project_id,purchase_order,supplier,description,order_date,delivery_date,status) VALUES ($1,(SELECT id FROM projects WHERE owner_id=$1 AND project_number=$2),$3,$4,$5,$6,$7,$8)', [owner(req),item.project || '',item.po,item.supplier,item.description,item.orderDate,item.deliveryDate,item.status]); await client.query('COMMIT'); await audit(req, 'replace', 'procurement', owner(req)); send(res, { ok: true }); } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } }));
app.post('/api/procurement', requireAuth, json(procurementSchema), asyncHandler(async (req, res) => { const item = req.body; const result = await pool.query('INSERT INTO procurement_items (owner_id,project_id,purchase_order,supplier,description,order_date,delivery_date,status) VALUES ($1,(SELECT id FROM projects WHERE owner_id=$1 AND project_number=$2),$3,$4,$5,$6,$7,$8) RETURNING id', [owner(req),item.project,item.po,item.supplier,item.description,item.orderDate,item.deliveryDate,item.status]); await audit(req, 'create', 'procurement', result.rows[0].id); send(res, { id: result.rows[0].id }, 201); }));
app.put('/api/procurement/:id', requireAuth, json(procurementSchema), asyncHandler(async (req, res) => { const item = req.body; const result = await pool.query('UPDATE procurement_items SET purchase_order=$1,supplier=$2,description=$3,order_date=$4,delivery_date=$5,status=$6,updated_at=NOW() WHERE id=$7 AND owner_id=$8 RETURNING id', [item.po,item.supplier,item.description,item.orderDate,item.deliveryDate,item.status,req.params.id,owner(req)]); if (!result.rowCount) throw new HttpError(404, 'Procurement item not found.'); await audit(req, 'update', 'procurement', req.params.id); send(res, { ok: true }); }));
app.delete('/api/procurement/:id', requireAuth, asyncHandler(async (req, res) => { const result = await pool.query('DELETE FROM procurement_items WHERE id=$1 AND owner_id=$2 RETURNING id', [req.params.id,owner(req)]); if (!result.rowCount) throw new HttpError(404, 'Procurement item not found.'); await audit(req, 'delete', 'procurement', req.params.id); res.status(204).end(); }));

app.post('/api/files', requireAuth, asyncHandler((req, res, next) => upload.single('file')(req, res, error => error ? next(error) : next())), asyncHandler(async (req, res) => { if (!req.file) throw new HttpError(400, 'Unsupported or missing file. Allowed files: PDF, XLS, XLSX, CSV.'); const saved = await storage.save(req.file); try { await pool.query('INSERT INTO files (storage_key,owner_id,original_name,mime_type,size_bytes) VALUES ($1,$2,$3,$4,$5)', [saved.key,owner(req),req.file.originalname,req.file.mimetype,req.file.size]); } catch (error) { await storage.remove(saved.key); throw error; } await audit(req, 'create', 'file', saved.key, { name: req.file.originalname }); send(res, { fileKey: saved.key, fileName: req.file.originalname, fileType: req.file.mimetype }, 201); }));
app.get('/api/files/:key', requireAuth, asyncHandler(async (req, res) => { if (!fileParam.safeParse(req.params).success) throw new HttpError(422, 'Invalid file key.'); const result = await pool.query('SELECT original_name,mime_type FROM files WHERE storage_key=$1 AND owner_id=$2', [req.params.key,owner(req)]); if (!result.rows[0]) throw new HttpError(404, 'File not found.'); res.type(result.rows[0].mime_type); res.setHeader('Content-Disposition', `attachment; filename="${result.rows[0].original_name.replace(/["\r\n]/g, '_')}"`); (await storage.stream(req.params.key)).pipe(res); }));
app.delete('/api/files/:key', requireAuth, asyncHandler(async (req, res) => { if (!fileParam.safeParse(req.params).success) throw new HttpError(422, 'Invalid file key.'); const result = await pool.query('DELETE FROM files WHERE storage_key=$1 AND owner_id=$2 RETURNING storage_key', [req.params.key,owner(req)]); if (!result.rowCount) throw new HttpError(404, 'File not found.'); await storage.remove(req.params.key); await audit(req, 'delete', 'file', req.params.key); res.status(204).end(); }));

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'sinyar_enterprise_procurement_and_quotation_tracker_suite (2).html')));
app.use(express.static(__dirname));
app.use((error, _req, res, _next) => { if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File exceeds the 25 MB limit.' }); const status = error.status || (error.code === '23505' ? 409 : 500); if (status >= 500) console.error(error); res.status(status).json({ error: status === 500 ? 'Internal server error.' : error.message }); });

async function start() { if (process.exitCode) return; try { await storage.init(); await pool.query('SELECT 1'); await ensureAdmin(); app.listen(port, () => console.log(`Sinyar Tracker backend listening on ${frontendUrl} (${nodeEnv})`)); } catch (error) { console.error(`Startup failed: unable to connect to PostgreSQL. ${error.message}`); process.exitCode = 1; } }
if (nodeEnv === 'production' && storageProvider !== 's3') throw new Error('STORAGE_PROVIDER=s3 is required in production.');
if (!env.VERCEL) await start();
export { app, pool };
