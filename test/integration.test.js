require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

process.env.VERCEL = '1';
const app = require('../server.js');
const adminUser = process.env.ADMIN_USERNAME || 'SALEEM';
const adminPassword = process.env.ADMIN_PASSWORD;

function client() {
  const agent = request.agent(app);
  return {
    async request(path, options = {}) {
      let call = agent[({ GET: 'get', POST: 'post', PUT: 'put', DELETE: 'delete' }[options.method || 'GET'])](path);
      if (options.body) call = call.send(options.body);
      return call;
    },
    json(path, body, options = {}) { return this.request(path, { ...options, method: options.method || 'POST', body }); }
  };
}

test('integration prerequisites and authenticated ownership workflow', async t => {
  let health;
  try { health = await request(app).get('/api/health'); } catch { t.skip('PostgreSQL-backed health check is unavailable.'); return; }
  if (!health.ok) { t.skip('PostgreSQL-backed health check is unavailable.'); return; }
  assert.equal(health.status, 200);
  if (!adminPassword) { t.skip('ADMIN_PASSWORD is not set for integration testing.'); return; }

  const admin = client();
  assert.equal((await admin.request('/api/projects')).status, 401);
  assert.equal((await admin.json('/api/auth/login', { userId: adminUser, password: 'wrong-password' })).status, 401);
  assert.equal((await admin.json('/api/auth/login', { userId: adminUser, password: adminPassword })).status, 200);
  assert.equal((await admin.request('/api/auth/me')).status, 200);
  assert.equal((await admin.request('/api/users')).status, 200);

  const testUser = `integration_${Date.now()}`;
  const editorUser = `editor_${Date.now()}`;
  assert.equal((await admin.json('/api/users', { userId: testUser, password: 'integration-password' })).status, 201);
  assert.equal((await admin.json('/api/users', { userId: editorUser, password: 'integration-password' })).status, 201);
  const user = client();
  assert.equal((await user.json('/api/auth/login', { userId: testUser, password: 'integration-password' })).status, 200);
  assert.equal((await user.request('/api/users')).status, 403);
  const editor = client();
  assert.equal((await editor.json('/api/auth/login', { userId: editorUser, password: 'integration-password' })).status, 200);

  const project = { number: `TEST-${Date.now()}`, name: 'Integration Project', client: 'Integration Client', week: 'Week 1', items: [{ sno: '1', desc: 'Steel', quote: 'Received', po: 'Y', adv: 'N', sample: '', clientApp: 'Approved', eta: '2026-10-30', remarks: '', cost: '100' }, { sno: '2', desc: 'Cable', quote: 'Pending', po: 'N', adv: 'N', sample: '', clientApp: '', eta: '', remarks: '', cost: '50' }, { sno: '3', desc: 'Valve', quote: 'Received', po: 'Y', adv: 'Y', sample: '', clientApp: 'Approved', eta: '', remarks: '', cost: '25' }] };
  let response = await user.json(`/api/projects/${project.number}`, project, { method: 'PUT' });
  assert.equal(response.status, 200);
  const saved = (await user.request(`/api/projects/by-number/${project.number}`)).body;
  assert.equal(saved.project.items.length, 3);
  response = await user.json(`/api/projects/${project.number}`, { ...project, name: 'Edited', version: saved.project.version }, { method: 'PUT' });
  assert.equal(response.status, 200);
  assert.equal((await user.json(`/api/projects/${project.number}`, { ...project, version: saved.project.version }, { method: 'PUT' })).status, 409);

  assert.equal((await user.json('/api/quotations', { ref: 'INT-1', project: project.number, vendor: 'Vendor', status: 'Pending' }, { method: 'POST' })).status, 201);
  assert.equal((await user.json('/api/procurement', { po: 'PO-1', project: project.number, supplier: 'Supplier' }, { method: 'POST' })).status, 201);
  assert.equal((await editor.request(`/api/projects/by-number/${project.number}`)).status, 200);
  const editorProject = (await editor.request(`/api/projects/by-number/${project.number}`)).body.project;
  assert.equal((await editor.json(`/api/projects/${project.number}`, { ...project, name: 'Edited by User B', version: editorProject.version }, { method: 'PUT' })).status, 200);
  assert.equal((await editor.json('/api/quotations', { ref: 'INT-2', project: project.number, vendor: 'Vendor B', status: 'Approved' }, { method: 'POST' })).status, 201);
  assert.equal((await editor.json('/api/procurement', { po: 'PO-2', project: project.number, supplier: 'Supplier B' }, { method: 'POST' })).status, 201);
  assert.equal((await editor.request(`/api/projects/${project.number}`, { method: 'DELETE' })).status, 403);
  assert.equal((await user.request(`/api/projects/${project.number}`, { method: 'DELETE' })).status, 204);
  assert.equal((await user.request('/api/auth/logout', { method: 'POST' })).status, 204);
  assert.equal((await user.request('/api/auth/me')).status, 401);

  const adminDelete = await admin.request(`/api/users/${encodeURIComponent(testUser)}`, { method: 'DELETE' });
  assert.equal(adminDelete.status, 204);
  assert.equal((await admin.request(`/api/users/${encodeURIComponent(editorUser)}`, { method: 'DELETE' })).status, 204);
  await editor.request('/api/auth/logout', { method: 'POST' });
  await admin.request('/api/auth/logout', { method: 'POST' });
});
