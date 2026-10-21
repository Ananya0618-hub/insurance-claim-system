'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDb } = require('../src/db');
const { createApp } = require('../src/app');
const { seedBase, DEMO_PASSWORD } = require('../src/seed');

let now = new Date('2026-10-21T10:00:00Z');
// a date a few days before the (movable) test clock, so claims are never filed late by accident
const recent = () => new Date(now.getTime() - 3 * 86400000).toISOString().slice(0, 10);
let server, base, db;

test.before(async () => {
  db = await createDb({ reset: true });
  await seedBase(db, now);
  server = createApp(db, { clock: () => now }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

async function call(method, path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, body: type.includes('json') ? await res.json() : await res.text(), type };
}
async function login(email) {
  const r = await call('POST', '/api/auth/login', { body: { email, password: DEMO_PASSWORD } });
  assert.equal(r.status, 200, `login failed for ${email}`);
  return r.body.token;
}
const claimBody = (policyId, over = {}) => ({
  policyId, amount: 75000, incidentDate: '2026-10-12', hospital: 'City Care Clinic',
  procedure: 'Knee arthroscopy', documents: ['hospital_bill'], ...over,
});
// Rohan's health policy (first) and motor policy (second)
const policiesOf = async (token) => (await call('GET', '/api/policies', { token })).body;
const healthOf = async (token) => (await policiesOf(token)).find((p) => p.productType === 'HEALTH').policyId;

test('login: wrong password and missing fields are refused, protected routes need a token', async () => {
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'rohan@example.com', password: 'nope' } })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'rohan@example.com' } })).status, 400);
  assert.equal((await call('GET', '/api/claims')).status, 401);
  assert.equal((await call('GET', '/api/claims', { token: 'garbage' })).status, 401);
  const ok = await call('POST', '/api/auth/login', { body: { email: 'ROHAN@example.com', password: DEMO_PASSWORD } });
  assert.equal(ok.body.user.role, 'claimant');
});

test('full journey over HTTP: submit -> rejected with reasons -> appeal -> review -> approved', async () => {
  const rohan = await login('rohan@example.com');
  const priya = await login('priya@insurer.com');

  const policies = await policiesOf(rohan);
  assert.deepEqual(policies.map((p) => p.productName), ['Health insurance', 'Motor insurance']);

  const created = await call('POST', '/api/claims', { token: rohan, body: claimBody(await healthOf(rohan)) });
  assert.equal(created.status, 201);
  assert.equal(created.body.status, 'REJECTED');
  assert.deepEqual(created.body.reasons.map((r) => r.ruleCode), ['C-3.2', 'C-4.1']);
  const claimId = created.body.claimId;

  // claimants never see the internal audit trail
  const mine = await call('GET', `/api/claims/${claimId}`, { token: rohan });
  assert.equal(mine.body.auditTrail, undefined);
  assert.ok((await call('GET', `/api/claims/${claimId}`, { token: priya })).body.auditTrail.length === 2);

  const appeal = await call('POST', `/api/claims/${claimId}/appeal`, { token: rohan, body: { notes: 'It was the closest hospital in an emergency.' } });
  assert.equal(appeal.status, 201);
  const appealId = appeal.body.appeal.appealId;

  const queue = await call('GET', '/api/appeals?status=FILED', { token: priya });
  assert.equal(queue.body.length, 1);
  assert.deepEqual(queue.body[0].rejectedClauses, ['C-3.2', 'C-4.1']);

  assert.equal((await call('POST', `/api/appeals/${appealId}/decision`, { token: priya, body: { decision: 'approve', justification: 'Emergency verified' } })).status, 409);
  assert.equal((await call('POST', `/api/appeals/${appealId}/start-review`, { token: priya })).status, 200);
  assert.equal((await call('POST', `/api/appeals/${appealId}/decision`, { token: priya, body: { decision: 'approve' } })).status, 400);
  const decided = await call('POST', `/api/appeals/${appealId}/decision`, { token: priya, body: { decision: 'approve', justification: 'Emergency verified with hospital records' } });
  assert.equal(decided.body.status, 'APPROVED');

  const after = await call('GET', `/api/claims/${claimId}`, { token: rohan });
  assert.equal(after.body.status, 'APPROVED');
  assert.equal(after.body.appeal.status, 'APPROVED');
});

test('role-based access control', async () => {
  const rohan = await login('rohan@example.com');
  const anita = await login('anita@example.com');
  const priya = await login('priya@insurer.com');
  const meera = await login('meera@insurer.com');

  const claimId = (await call('POST', '/api/claims', { token: rohan, body: claimBody(await healthOf(rohan)) })).body.claimId;

  // another claimant cannot see or appeal it, and sees an empty list
  assert.equal((await call('GET', `/api/claims/${claimId}`, { token: anita })).status, 404);
  assert.equal((await call('POST', `/api/claims/${claimId}/appeal`, { token: anita, body: { notes: 'Not my claim, but trying.' } })).status, 404);
  assert.equal((await call('GET', '/api/claims', { token: anita })).body.length, 0);

  // claimants cannot use staff features
  for (const [m, p] of [['GET', '/api/reports/summary'], ['GET', '/api/rules'], ['GET', '/api/audit'], ['GET', '/api/appeals'], ['POST', `/api/claims/${claimId}/override`]]) {
    assert.equal((await call(m, p, { token: rohan })).status, 403, `${m} ${p} should be forbidden for a claimant`);
  }
  // auditor is read-only
  assert.equal((await call('POST', `/api/claims/${claimId}/override`, { token: meera, body: { decision: 'approve', justification: 'auditor should not do this' } })).status, 403);
  assert.equal((await call('PUT', '/api/rules/1', { token: meera, body: { active: false } })).status, 403);
  assert.equal((await call('POST', '/api/claims', { token: priya, body: {} })).status, 403);
  assert.equal((await call('GET', '/api/reports/summary', { token: meera })).status, 200);
  assert.equal((await call('GET', '/api/audit', { token: meera })).status, 200);
});

test('adjuster override and payout through the API, plus validation errors', async () => {
  const rohan = await login('rohan@example.com');
  const priya = await login('priya@insurer.com');
  const policyId = await healthOf(rohan);

  const bad = await call('POST', '/api/claims', { token: rohan, body: claimBody(policyId, { amount: 'lots', hospital: '' }) });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /amount/);
  assert.match(bad.body.error, /Hospital is required/);
  assert.equal((await call('GET', '/api/claims/abc', { token: priya })).status, 400);
  assert.equal((await call('GET', '/api/claims/99999', { token: priya })).status, 404);

  const good = await call('POST', '/api/claims', { token: rohan, body: claimBody(policyId, { hospital: 'Apollo Hospital', documents: ['discharge_summary', 'hospital_bill'] }) });
  assert.equal(good.body.status, 'APPROVED');
  const paid = await call('POST', `/api/claims/${good.body.claimId}/payout`, { token: priya });
  assert.equal(paid.body.status, 'CLOSED');

  const rej = await call('POST', '/api/claims', { token: rohan, body: claimBody(policyId) });
  const over = await call('POST', `/api/claims/${rej.body.claimId}/override`, { token: priya, body: { decision: 'approve', justification: 'Clinic joined the network last week' } });
  assert.equal(over.body.status, 'APPROVED');
});

test('rules can be listed and edited by an adjuster; expiry check closes stale rejections', async () => {
  const priya = await login('priya@insurer.com');
  const rohan = await login('rohan@example.com');
  const rules = (await call('GET', '/api/rules', { token: priya })).body;
  assert.ok(rules.length >= 30);
  assert.ok(new Set(rules.map((r) => r.productName)).size === 4, 'rules for all four insurance categories');
  const updated = await call('PUT', `/api/rules/${rules[0].ruleId}`, { token: priya, body: { rejectMsg: 'Treatment date is outside the policy period (edited)' } });
  assert.match(updated.body.rejectMsg, /edited/);
  assert.equal((await call('PUT', `/api/rules/${rules[0].ruleId}`, { token: priya, body: { condition: { type: 'MAGIC' } } })).status, 400);

  const policyId = await healthOf(rohan);
  const rej = await call('POST', '/api/claims', { token: rohan, body: claimBody(policyId) });
  now = new Date(now.getTime() + 40 * 86400000); // time passes
  assert.ok((await call('POST', '/api/claims/expire-check', { token: priya })).body.closed >= 1);
  assert.equal((await call('GET', `/api/claims/${rej.body.claimId}`, { token: rohan })).body.status, 'CLOSED');
});

test('CSV export and summary report for the auditor', async () => {
  const meera = await login('meera@insurer.com');
  const csv = await call('GET', '/api/reports/claims.csv', { token: meera });
  assert.equal(csv.status, 200);
  assert.match(csv.type, /text\/csv/);
  assert.match(csv.body.split('\n')[0], /claimId,claimant,policyNo,type,amount,status/);
  const summary = (await call('GET', '/api/reports/summary', { token: meera })).body;
  assert.ok(summary.totalClaims >= 4);
  assert.ok(summary.byProduct.length >= 1);
  assert.ok(summary.topRejectionClauses.length >= 1);
});

test('insurance categories are served to the UI, and other lines of business work over HTTP', async () => {
  const rohan = await login('rohan@example.com');
  const anita = await login('anita@example.com');

  const types = (await call('GET', '/api/product-types', { token: rohan })).body;
  assert.deepEqual(types.map((t) => t.code), ['HEALTH', 'HOME', 'MOTOR', 'TRAVEL']);
  assert.ok(types.every((t) => t.fields.length >= 2 && Object.keys(t.documents).length >= 3 && t.incidentLabel));
  assert.equal((await call('GET', '/api/product-types')).status, 401);

  const motor = (await policiesOf(rohan)).find((p) => p.productType === 'MOTOR');
  assert.equal(motor.insuredItem, 'Maruti Swift (KA-01-AB-1234)');
  const rejected = await call('POST', '/api/claims', { token: rohan, body: {
    policyId: motor.policyId, amount: 90000, incidentDate: recent(), garage: 'Roadside Fix-It', cause: 'Collision',
    driverLicenseValid: false, documents: ['repair_estimate'],
  } });
  assert.equal(rejected.status, 201);
  assert.equal(rejected.body.productName, 'Motor insurance');
  assert.deepEqual(rejected.body.reasons.map((r) => r.ruleCode), ['M-3.1', 'M-4.2', 'M-5.2']);
  assert.equal(rejected.body.product.incidentLabel, 'Date of accident');

  const bad = await call('POST', '/api/claims', { token: rohan, body: { policyId: motor.policyId, amount: 1000, incidentDate: recent(), garage: 'AutoCare Motors', cause: 'Meteor strike' } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /Cause of damage must be one of/);

  const home = (await policiesOf(anita)).find((p) => p.productType === 'HOME');
  const wear = await call('POST', '/api/claims', { token: anita, body: { policyId: home.policyId, amount: 150000, incidentDate: recent(), cause: 'Wear and tear', documents: ['damage_photos'] } });
  assert.deepEqual(wear.body.reasons.map((r) => r.ruleCode), ['H-3.1']);

  // the auditor's report now splits claims by insurance category
  const meera = await login('meera@insurer.com');
  const byProduct = (await call('GET', '/api/reports/summary', { token: meera })).body.byProduct;
  assert.deepEqual(byProduct.map((p) => p.code).sort(), ['HEALTH', 'HOME', 'MOTOR']);

  // a claimant cannot file against someone else's policy
  assert.equal((await call('POST', '/api/claims', { token: anita, body: claimBody(motor.policyId) })).status, 404);
  // claim list shows the category and a one-line headline per claim
  const list = (await call('GET', '/api/claims', { token: rohan })).body;
  assert.ok(list.some((c) => c.productName === 'Motor insurance' && c.headline === 'Roadside Fix-It'));
});
