'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDb } = require('../src/db');
const { seedBase } = require('../src/seed');
const s = require('../src/claimService');

const NOW = new Date('2026-10-21T10:00:00Z');
const plusDays = (n) => new Date(NOW.getTime() + n * 86400000);

async function setup() {
  const db = await createDb({ reset: true });
  await seedBase(db, NOW);
  const user = async (email) => db.one('SELECT * FROM users WHERE email = $1', [email]);
  const rohanRow = await user('rohan@example.com');
  const anitaRow = await user('anita@example.com');
  const priyaRow = await user('priya@insurer.com');
  const policyOf = async (claimantId, type) =>
    (await db.one('SELECT policy_id FROM policies WHERE claimant_id = $1 AND product_type = $2', [claimantId, type])).policyId;
  return {
    db,
    rohan: { name: rohanRow.name, claimantId: rohanRow.claimantId },
    anita: { name: anitaRow.name, claimantId: anitaRow.claimantId },
    priya: { name: priyaRow.name, adjusterId: priyaRow.adjusterId },
    health: await policyOf(rohanRow.claimantId, 'HEALTH'),
    motor: await policyOf(rohanRow.claimantId, 'MOTOR'),
    home: await policyOf(anitaRow.claimantId, 'HOME'),
    travel: await policyOf(anitaRow.claimantId, 'TRAVEL'),
  };
}
const goodHealth = (policyId, over = {}) => ({
  policyId, amount: 60000, incidentDate: '2026-10-10', hospital: 'Apollo Hospital',
  procedure: 'Appendectomy', documents: ['discharge_summary', 'hospital_bill'], ...over,
});
const rejectedClaim = (ctx, over = {}) =>
  s.submitClaim(ctx.db, ctx.rohan, goodHealth(ctx.health, { hospital: 'City Care Clinic', documents: ['hospital_bill'], ...over }), NOW);

// ------------------------------------------------------------------ health: evaluation
test('a clean claim is approved automatically and the decision is audited', async () => {
  const ctx = await setup();
  const c = await s.submitClaim(ctx.db, ctx.rohan, goodHealth(ctx.health), NOW);
  assert.equal(c.status, 'APPROVED');
  assert.equal(c.reasons.length, 0);
  assert.equal(c.productCode, 'HEALTH');
  const full = await s.getClaimDetail(ctx.db, c.claimId, { includeAudit: true, now: NOW });
  assert.deepEqual(full.auditTrail.map((a) => a.actor), ['Rohan Mehta', 'system']);
  assert.match(full.auditTrail[1].action, /APPROVED/);
});

test('a bad claim is rejected with one explained reason per failed clause', async () => {
  const ctx = await setup();
  const c = await rejectedClaim(ctx);
  assert.equal(c.status, 'REJECTED');
  assert.deepEqual(c.reasons.map((r) => r.ruleCode), ['C-3.2', 'C-4.1']);
  assert.ok(c.reasons.every((r) => r.counterfactual.length > 20));
  assert.equal(c.appealWindow.canAppeal, true);
  assert.equal(c.appealWindow.daysLeft, 30);
});

test('boundary: a claim exactly equal to the sum insured is approved', async () => {
  const ctx = await setup();
  assert.equal((await s.submitClaim(ctx.db, ctx.rohan, goodHealth(ctx.health, { amount: 500000 }), NOW)).status, 'APPROVED');
});

// ------------------------------------------------------------------ the same engine for other insurance lines
test('motor: unauthorised garage, no licence and a missing registration certificate are all explained', async () => {
  const ctx = await setup();
  const c = await s.submitClaim(ctx.db, ctx.rohan, {
    policyId: ctx.motor, amount: 90000, incidentDate: '2026-10-12', garage: 'Roadside Fix-It', cause: 'Collision',
    driverLicenseValid: false, documents: ['repair_estimate'],
  }, NOW);
  assert.equal(c.productName, 'Motor insurance');
  assert.equal(c.status, 'REJECTED');
  assert.deepEqual(c.reasons.map((r) => r.ruleCode), ['M-3.1', 'M-4.2', 'M-5.2']);
  assert.match(c.reasons[0].counterfactual, /an authorised garage.*AutoCare Motors/);
  assert.match(c.reasons[1].counterfactual, /valid driving licence/);
  assert.match(c.reasons[2].counterfactual, /vehicle registration certificate/);
});

test('motor: a clean claim is approved, and the licence field defaults to valid when not sent', async () => {
  const ctx = await setup();
  const c = await s.submitClaim(ctx.db, ctx.rohan, {
    policyId: ctx.motor, amount: 85000, incidentDate: '2026-10-12', garage: 'AutoCare Motors', cause: 'Collision',
    documents: ['repair_estimate', 'rc_book'],
  }, NOW);
  assert.equal(c.status, 'APPROVED');
  assert.equal(c.details.driverLicenseValid, true);
});

test('motor: an FIR is only demanded for theft claims (conditional rule)', async () => {
  const ctx = await setup();
  const base = { policyId: ctx.motor, amount: 85000, incidentDate: '2026-10-12', garage: 'AutoCare Motors', documents: ['repair_estimate', 'rc_book'] };
  assert.equal((await s.submitClaim(ctx.db, ctx.rohan, { ...base, cause: 'Fire' }, NOW)).status, 'APPROVED');
  const theft = await s.submitClaim(ctx.db, ctx.rohan, { ...base, cause: 'Theft' }, NOW);
  assert.deepEqual(theft.reasons.map((r) => r.ruleCode), ['M-5.3']);
  assert.equal((await s.submitClaim(ctx.db, ctx.rohan, { ...base, cause: 'Theft', documents: [...base.documents, 'fir_copy'] }, NOW)).status, 'APPROVED');
});

test('home: an excluded cause of loss, an unoccupied property and a missing police report', async () => {
  const ctx = await setup();
  const base = { policyId: ctx.home, amount: 150000, incidentDate: '2026-10-12', documents: ['damage_photos'] };
  const wear = await s.submitClaim(ctx.db, ctx.anita, { ...base, cause: 'Wear and tear' }, NOW);
  assert.deepEqual(wear.reasons.map((r) => r.ruleCode), ['H-3.1']);
  const empty = await s.submitClaim(ctx.db, ctx.anita, { ...base, cause: 'Fire', unoccupied: true }, NOW);
  assert.deepEqual(empty.reasons.map((r) => r.ruleCode), ['H-3.2']);
  assert.match(empty.reasons[0].counterfactual, /not left unoccupied/);
  const burglary = await s.submitClaim(ctx.db, ctx.anita, { ...base, cause: 'Burglary' }, NOW);
  assert.deepEqual(burglary.reasons.map((r) => r.ruleCode), ['H-4.2']);
  assert.equal((await s.submitClaim(ctx.db, ctx.anita, { ...base, cause: 'Fire' }, NOW)).status, 'APPROVED');
});

test('travel: voluntary change of plans is excluded; a medical claim needs a medical report', async () => {
  const ctx = await setup();
  const base = { policyId: ctx.travel, amount: 40000, incidentDate: '2026-10-10', destination: 'Paris', documents: ['travel_tickets'] };
  const plans = await s.submitClaim(ctx.db, ctx.anita, { ...base, cause: 'Change of plans' }, NOW);
  assert.deepEqual(plans.reasons.map((r) => r.ruleCode), ['T-3.1']);
  const medical = await s.submitClaim(ctx.db, ctx.anita, { ...base, cause: 'Medical emergency abroad' }, NOW);
  assert.deepEqual(medical.reasons.map((r) => r.ruleCode), ['T-4.2']);
  assert.equal((await s.submitClaim(ctx.db, ctx.anita, { ...base, cause: 'Flight delay' }, NOW)).status, 'APPROVED');
});

test('insurance categories are data: each lists its own fields, documents and date label', async () => {
  const ctx = await setup();
  const types = await s.listProductTypes(ctx.db);
  assert.deepEqual(types.map((t) => t.code), ['HEALTH', 'HOME', 'MOTOR', 'TRAVEL']);
  const motor = types.find((t) => t.code === 'MOTOR');
  assert.equal(motor.incidentLabel, 'Date of accident');
  assert.deepEqual(motor.fields.map((f) => f.key), ['garage', 'cause', 'driverLicenseValid', 'underInfluence']);
  assert.ok(motor.documents.rc_book);
  const policies = await s.listPolicies(ctx.db, { claimantId: ctx.rohan.claimantId });
  assert.deepEqual(policies.map((p) => p.productName), ['Health insurance', 'Motor insurance']);
});

// ------------------------------------------------------------------ validation
test('submission is validated against the category definition and ownership', async () => {
  const ctx = await setup();
  const submit = (user, body) => s.submitClaim(ctx.db, user, body, NOW);
  await assert.rejects(submit(ctx.rohan, goodHealth(ctx.health, { incidentDate: '2026-12-01' })), /Date of treatment cannot be in the future/);
  await assert.rejects(submit(ctx.rohan, goodHealth(ctx.health, { amount: -5 })), /positive/);
  await assert.rejects(submit(ctx.rohan, goodHealth(ctx.health, { hospital: '  ' })), /Hospital is required/);
  await assert.rejects(submit(ctx.rohan, goodHealth(ctx.health, { documents: ['selfie'] })), /unknown document/);
  await assert.rejects(submit(ctx.rohan, goodHealth(ctx.health, { documents: ['rc_book'] })), /unknown document/); // a motor document on a health policy
  await assert.rejects(submit(ctx.rohan, { policyId: ctx.motor, amount: 1000, incidentDate: '2026-10-10', garage: 'AutoCare Motors', cause: 'Meteor strike' }), /Cause of damage must be one of/);
  await assert.rejects(submit(ctx.rohan, { policyId: ctx.motor, amount: 1000, incidentDate: '2026-10-10', cause: 'Fire' }), /Repair garage is required/);
  await assert.rejects(submit(ctx.anita, goodHealth(ctx.health)), (e) => e.status === 404); // not her policy
});

// ------------------------------------------------------------------ appeals (any category)
test('appeal: allowed on day 30, refused on day 31, and only once', async () => {
  const ctx = await setup();
  const c1 = await rejectedClaim(ctx);
  const ok = await s.fileAppeal(ctx.db, ctx.rohan, c1.claimId, { notes: 'The clinic was the nearest emergency facility.' }, plusDays(30));
  assert.equal(ok.status, 'APPEAL_FILED');
  assert.equal(ok.appeal.status, 'FILED');
  await assert.rejects(s.fileAppeal(ctx.db, ctx.rohan, c1.claimId, { notes: 'Trying again please.' }, plusDays(30)), /Only rejected/);
  const c2 = await rejectedClaim(ctx);
  await assert.rejects(s.fileAppeal(ctx.db, ctx.rohan, c2.claimId, { notes: 'Late appeal for this claim.' }, plusDays(31)), /window closed/);
});

test('appeal validation and ownership', async () => {
  const ctx = await setup();
  const c = await rejectedClaim(ctx);
  await assert.rejects(s.fileAppeal(ctx.db, ctx.rohan, c.claimId, { notes: 'short' }, NOW), /at least 10/);
  await assert.rejects(s.fileAppeal(ctx.db, ctx.anita, c.claimId, { notes: 'This is not my claim at all.' }, NOW), (e) => e.status === 404);
  const approved = await s.submitClaim(ctx.db, ctx.rohan, goodHealth(ctx.health), NOW);
  await assert.rejects(s.fileAppeal(ctx.db, ctx.rohan, approved.claimId, { notes: 'Appealing an approved claim.' }, NOW), /Only rejected/);
});

test('appeal upheld on a non-health claim: approved and the whole path is audited', async () => {
  const ctx = await setup();
  const c = await s.submitClaim(ctx.db, ctx.anita, { policyId: ctx.home, amount: 150000, incidentDate: '2026-10-12', cause: 'Wear and tear', documents: ['damage_photos'] }, NOW);
  const appeal = (await s.fileAppeal(ctx.db, ctx.anita, c.claimId, { notes: 'The damage came from a burst pipe, not gradual wear.' }, NOW)).appeal;
  await assert.rejects(s.decideAppeal(ctx.db, ctx.priya, appeal.appealId, 'approve', 'looks fine to me', NOW), /under review/);
  await s.startAppealReview(ctx.db, ctx.priya, appeal.appealId, NOW);
  assert.equal((await s.getClaimDetail(ctx.db, c.claimId, { now: NOW })).status, 'UNDER_APPEAL_REVIEW');
  await assert.rejects(s.decideAppeal(ctx.db, ctx.priya, appeal.appealId, 'approve', '', NOW), /justification/);
  const done = await s.decideAppeal(ctx.db, ctx.priya, appeal.appealId, 'approve', 'Plumber report confirms a sudden burst pipe', plusDays(2));
  assert.equal(done.status, 'APPROVED');
  const full = await s.getClaimDetail(ctx.db, c.claimId, { includeAudit: true, now: NOW });
  assert.equal(full.status, 'APPROVED');
  assert.equal(full.appeal.resolvedOn, '2026-10-23');
  assert.deepEqual(full.auditTrail.map((a) => a.actor), ['Anita Desai', 'system', 'Anita Desai', 'Priya Nair', 'Priya Nair']);
});

test('appeal denied: claim is closed', async () => {
  const ctx = await setup();
  const c = await rejectedClaim(ctx);
  const appeal = (await s.fileAppeal(ctx.db, ctx.rohan, c.claimId, { notes: 'Please reconsider this decision.' }, NOW)).appeal;
  await s.startAppealReview(ctx.db, ctx.priya, appeal.appealId, NOW);
  const done = await s.decideAppeal(ctx.db, ctx.priya, appeal.appealId, 'deny', 'Network clause is not waived for non-emergency care', NOW);
  assert.equal(done.status, 'DENIED');
  assert.equal((await s.getClaimDetail(ctx.db, c.claimId, { now: NOW })).status, 'CLOSED');
});

// ------------------------------------------------------------------ adjuster actions
test('override: needs a justification, flips the decision, and is logged', async () => {
  const ctx = await setup();
  const c = await rejectedClaim(ctx);
  await assert.rejects(s.overrideClaim(ctx.db, ctx.priya, c.claimId, 'approve', '', NOW), /justification/);
  await assert.rejects(s.overrideClaim(ctx.db, ctx.priya, c.claimId, 'maybe', 'because I said so', NOW), /decision must be/);
  await assert.rejects(s.overrideClaim(ctx.db, ctx.priya, c.claimId, 'reject', 'already rejected', NOW), /already REJECTED/);
  const over = await s.overrideClaim(ctx.db, ctx.priya, c.claimId, 'approve', 'Hospital is in the network under its new name', NOW);
  assert.equal(over.status, 'APPROVED');
  assert.match(over.auditTrail.at(-1).action, /Override: REJECTED -> APPROVED - Hospital is in the network/);
  const back = await s.overrideClaim(ctx.db, ctx.priya, c.claimId, 'reject', 'Fraud flag raised by investigations', NOW);
  assert.equal(back.status, 'REJECTED');
  assert.ok(back.reasons.some((r) => r.ruleCode === 'MANUAL'));
});

test('payout closes only approved claims; closed claims cannot be changed', async () => {
  const ctx = await setup();
  const ok = await s.submitClaim(ctx.db, ctx.rohan, goodHealth(ctx.health), NOW);
  const rej = await rejectedClaim(ctx);
  await assert.rejects(s.completePayout(ctx.db, ctx.priya, rej.claimId, NOW), /Only approved/);
  assert.equal((await s.completePayout(ctx.db, ctx.priya, ok.claimId, NOW)).status, 'CLOSED');
  await assert.rejects(s.overrideClaim(ctx.db, ctx.priya, ok.claimId, 'reject', 'too late to change this', NOW), /cannot be overridden/);
});

test('rejected claims with no appeal are closed automatically after the window', async () => {
  const ctx = await setup();
  const c = await rejectedClaim(ctx);
  assert.equal(await s.closeExpired(ctx.db, plusDays(30)), 0);
  assert.equal(await s.closeExpired(ctx.db, plusDays(31)), 1);
  const full = await s.getClaimDetail(ctx.db, c.claimId, { includeAudit: true, now: NOW });
  assert.equal(full.status, 'CLOSED');
  assert.match(full.auditTrail.at(-1).action, /no appeal within 30 days/);
});

// ------------------------------------------------------------------ rules + reports
test('rules are data: switching a clause off changes the outcome and is audited', async () => {
  const ctx = await setup();
  const rules = await s.listRules(ctx.db);
  const network = rules.find((r) => r.policyId === ctx.health && r.clauseCode === 'C-3.2');
  assert.equal(network.productName, 'Health insurance');
  await assert.rejects(s.updateRule(ctx.db, ctx.priya, network.ruleId, { condition: { type: 'MAGIC' } }, NOW), /Unknown rule type/);
  await assert.rejects(s.updateRule(ctx.db, ctx.priya, network.ruleId, {}, NOW), /Nothing to update/);
  await s.updateRule(ctx.db, ctx.priya, network.ruleId, { active: false }, NOW);
  const c = await s.submitClaim(ctx.db, ctx.rohan, goodHealth(ctx.health, { hospital: 'City Care Clinic' }), NOW);
  assert.equal(c.status, 'APPROVED');
  assert.ok((await s.listAudit(ctx.db)).some((a) => /Rule C-3.2 .* active=false/.test(a.action)));
});

test('a rule can be edited for one category without touching another', async () => {
  const ctx = await setup();
  const rules = await s.listRules(ctx.db);
  const garages = rules.find((r) => r.policyId === ctx.motor && r.clauseCode === 'M-3.1');
  const updated = await s.updateRule(ctx.db, ctx.priya, garages.ruleId, { condition: { ...garages.condition, values: ['Roadside Fix-It'] } }, NOW);
  assert.deepEqual(updated.condition.values, ['Roadside Fix-It']);
  const c = await s.submitClaim(ctx.db, ctx.rohan, { policyId: ctx.motor, amount: 85000, incidentDate: '2026-10-12', garage: 'Roadside Fix-It', cause: 'Collision', documents: ['repair_estimate', 'rc_book'] }, NOW);
  assert.equal(c.status, 'APPROVED');
  const health = (await s.listRules(ctx.db)).find((r) => r.policyId === ctx.health && r.clauseCode === 'C-3.2');
  assert.ok(health.condition.values.includes('Apollo Hospital'));
});

test('report summary breaks claims down by insurance category, and the CSV carries the type', async () => {
  const ctx = await setup();
  await s.submitClaim(ctx.db, ctx.rohan, goodHealth(ctx.health), NOW);
  const rej = await rejectedClaim(ctx);
  await s.submitClaim(ctx.db, ctx.rohan, { policyId: ctx.motor, amount: 85000, incidentDate: '2026-10-12', garage: 'AutoCare Motors', cause: 'Collision', documents: ['repair_estimate', 'rc_book'] }, NOW);
  const appeal = (await s.fileAppeal(ctx.db, ctx.rohan, rej.claimId, { notes: 'Nearest hospital in an emergency.' }, NOW)).appeal;
  await s.startAppealReview(ctx.db, ctx.priya, appeal.appealId, NOW);
  await s.decideAppeal(ctx.db, ctx.priya, appeal.appealId, 'approve', 'Emergency exception verified', plusDays(4));

  const r = await s.summaryReport(ctx.db);
  assert.equal(r.totalClaims, 3);
  assert.equal(r.autoRejected, 1);
  assert.equal(r.rejectionRate, 33.3);
  assert.equal(r.appeals.approved, 1);
  assert.equal(r.appeals.approvalRate, 100);
  assert.equal(r.appeals.avgResolutionDays, 4);
  assert.deepEqual(r.byProduct.map((p) => [p.code, p.claims, p.rejected]), [['HEALTH', 2, 1], ['MOTOR', 1, 0]]);
  assert.deepEqual(r.topRejectionClauses.map((c) => c.clauseCode).sort(), ['C-3.2', 'C-4.1']);

  const lines = (await s.claimsCsv(ctx.db)).split('\n');
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^claimId,claimant,policyNo,type,amount/);
  assert.ok(lines.some((l) => /"Motor insurance"/.test(l)));
});
