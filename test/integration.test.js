import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';

const baseUrl = process.env.TEST_BASE_URL || 'http://localhost:3000';
const adminUser = process.env.ADMIN_USERNAME || 'SALEEM';
const adminPassword = process.env.ADMIN_PASSWORD;

function client() {
  let cookie = '';
  return {
    async request(path, options = {}) {
      const headers = { ...(options.headers || {}) };
      if (cookie) headers.cookie = cookie;
      const response = await fetch(`${baseUrl}${path}`, { ...options, headers, redirect: 'manual' });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      return response;
    },
    json(path, body, options = {}) { return this.request(path, { method: options.method || 'POST', ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) }, body: JSON.stringify(body) }); }
  };
}

test('integration prerequisites and authenticated ownership workflow', async t => {
  let health;
  try { health = await fetch(`${baseUrl}/api/health`); } catch { t.skip('Backend is not running. Start PostgreSQL, migrate, and run npm start.'); return; }
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
  assert.equal((await admin.json('/api/users', { userId: testUser, password: 'integration-password' })).status, 201);
  const user = client();
  assert.equal((await user.json('/api/auth/login', { userId: testUser, password: 'integration-password' })).status, 200);
  assert.equal((await user.request('/api/users')).status, 403);

  const project = { number: 'TEST-001', name: 'Integration Project', client: 'Integration Client', week: 'Week 1', items: [{ sno: '1', desc: 'Steel', quote: 'Received', po: 'Y', adv: 'N', sample: '', clientApp: 'Approved', eta: '2026-10-30', remarks: '', cost: '100' }, { sno: '2', desc: 'Cable', quote: 'Pending', po: 'N', adv: 'N', sample: '', clientApp: '', eta: '', remarks: '', cost: '50' }, { sno: '3', desc: 'Valve', quote: 'Received', po: 'Y', adv: 'Y', sample: '', clientApp: 'Approved', eta: '', remarks: '', cost: '25' }] };
  let response = await user.json('/api/projects/TEST-001', project, { method: 'PUT' });
  assert.equal(response.status, 200);
  const saved = await (await user.request('/api/projects/by-number/TEST-001')).json();
  assert.equal(saved.project.items.length, 3);
  response = await user.json('/api/projects/TEST-001', { ...project, name: 'Edited', version: saved.project.version }, { method: 'PUT' });
  assert.equal(response.status, 200);
  assert.equal((await user.json('/api/projects/TEST-001', { ...project, version: saved.project.version }, { method: 'PUT' })).status, 409);

  assert.equal((await user.json('/api/quotations', { ref: 'INT-1', project: 'TEST-001', vendor: 'Vendor', status: 'Pending' }, { method: 'POST' })).status, 201);
  assert.equal((await user.json('/api/procurement', { po: 'PO-1', project: 'TEST-001', supplier: 'Supplier' }, { method: 'POST' })).status, 201);
  assert.equal((await user.request('/api/projects/TEST-001', { method: 'DELETE' })).status, 204);
  assert.equal((await user.request('/api/auth/logout', { method: 'POST' })).status, 204);
  assert.equal((await user.request('/api/auth/me')).status, 401);

  const adminDelete = await admin.request(`/api/users/${encodeURIComponent(testUser)}`, { method: 'DELETE' });
  assert.equal(adminDelete.status, 204);
  await admin.request('/api/auth/logout', { method: 'POST' });
});
