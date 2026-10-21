'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateClaim, validateCondition, daysBetween, addDays } = require('../src/ruleEngine');
const { PRODUCTS } = require('../src/products');

const policy = { sumInsured: 500000, startDate: '2025-01-01', endDate: '2027-12-31' };
const rule = (clauseCode, condition, ruleId = 1) => ({ ruleId, clauseCode, condition: JSON.stringify(condition), rejectMsg: `${clauseCode} failed`, active: true });
const claim = (over = {}, details = {}) => ({
  amount: 100000,
  submittedOn: '2026-10-21',
  ...over,
  details: { incidentDate: '2026-10-15', documents: ['bill', 'photos'], hospital: 'Apollo Hospital', ...details },
});
const run = (r, c, p = policy) => evaluateClaim({ claim: c, policy: p, rules: [r] });

test('date helpers', () => {
  assert.equal(daysBetween('2026-10-01', '2026-10-31'), 30);
  assert.equal(addDays('2026-10-01', 30), '2026-10-31');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('MAX_AMOUNT: exactly the sum insured passes, one rupee over fails; an explicit limit overrides it', () => {
  const r = rule('X-2.1', { type: 'MAX_AMOUNT' });
  assert.equal(run(r, claim({ amount: 500000 })).approved, true);
  const over = run(r, claim({ amount: 500001 }));
  assert.equal(over.approved, false);
  assert.match(over.failures[0].counterfactual, /Reduce the claimed amount by .*1/);
  assert.match(over.failures[0].counterfactual, /5,00,000/);

  const capped = rule('X-2.2', { type: 'MAX_AMOUNT', limit: 25000 });
  assert.equal(run(capped, claim({ amount: 25000 })).approved, true);
  const out = run(capped, claim({ amount: 30000 }));
  assert.match(out.failures[0].description, /claim limit/);
  assert.match(out.failures[0].counterfactual, /5,000/);
});

test('FIELD_IN_LIST works for any field: a hospital, a garage, anything', () => {
  const hospital = rule('C-3.2', { type: 'FIELD_IN_LIST', field: 'hospital', fieldLabel: 'hospital', label: 'network hospital', values: ['Apollo Hospital', 'Fortis Hospital'] });
  assert.equal(run(hospital, claim({}, { hospital: 'apollo hospital' })).approved, true);
  const out = run(hospital, claim({}, { hospital: 'City Care Clinic' }));
  assert.equal(out.approved, false);
  assert.match(out.failures[0].description, /\[C-3\.2\].*hospital: City Care Clinic/);
  assert.match(out.failures[0].counterfactual, /the hospital had been a network hospital.*Apollo Hospital/);

  const garage = rule('M-3.1', { type: 'FIELD_IN_LIST', field: 'garage', fieldLabel: 'repair garage', label: 'authorised garage', values: ['AutoCare Motors'] });
  assert.equal(run(garage, claim({}, { garage: 'AutoCare Motors' })).approved, true);
  const g = run(garage, claim({}, { garage: '' }));
  assert.match(g.failures[0].description, /repair garage: not given/);
  assert.match(g.failures[0].counterfactual, /an authorised garage/);
});

test('FIELD_NOT_IN_LIST: an excluded value fails, anything else passes', () => {
  const r = rule('H-3.1', { type: 'FIELD_NOT_IN_LIST', field: 'cause', fieldLabel: 'cause of loss', values: ['Wear and tear'] });
  assert.equal(run(r, claim({}, { cause: 'Fire' })).approved, true);
  assert.equal(run(r, claim({}, { cause: '' })).approved, true);
  const out = run(r, claim({}, { cause: 'wear and tear' }));
  assert.equal(out.approved, false);
  assert.match(out.failures[0].counterfactual, /excluded from cover.*cause of loss/);
});

test('FIELD_FLAG: a yes/no field must have the required value (both directions)', () => {
  const licence = rule('M-4.2', { type: 'FIELD_FLAG', field: 'driverLicenseValid', mustBe: true, requirement: 'the driver held a valid driving licence' });
  assert.equal(run(licence, claim({}, { driverLicenseValid: true })).approved, true);
  const bad = run(licence, claim({}, { driverLicenseValid: false }));
  assert.equal(bad.approved, false);
  assert.match(bad.failures[0].counterfactual, /only if the driver held a valid driving licence/);

  const sober = rule('M-4.3', { type: 'FIELD_FLAG', field: 'underInfluence', mustBe: false, requirement: 'the driver was not under the influence' });
  assert.equal(run(sober, claim({}, { underInfluence: false })).approved, true);
  assert.equal(run(sober, claim({}, { underInfluence: true })).approved, false);
});

test('REQUIRED_DOCUMENT names the missing document', () => {
  const r = rule('D-1', { type: 'REQUIRED_DOCUMENT', document: 'estimate', label: 'repair estimate' });
  assert.equal(run(r, claim({}, { documents: ['estimate'] })).approved, true);
  const out = run(r, claim());
  assert.equal(out.approved, false);
  assert.match(out.failures[0].counterfactual, /Submit the missing repair estimate/);
});

test('appliesWhen: a rule is only checked when the claim field has that value', () => {
  const fir = rule('H-4.2', { type: 'REQUIRED_DOCUMENT', document: 'fir', label: 'FIR', appliesWhen: { field: 'cause', equals: 'Burglary' } });
  const fire = run(fir, claim({}, { cause: 'Fire', documents: [] }));
  assert.equal(fire.approved, true);
  assert.equal(fire.results[0].applicable, false);
  assert.equal(run(fir, claim({}, { cause: 'Burglary', documents: [] })).approved, false);
  assert.equal(run(fir, claim({}, { cause: 'Burglary', documents: ['fir'] })).approved, true);
});

test('FILING_DEADLINE: day 30 passes, day 31 fails and says how late', () => {
  const r = rule('F-1', { type: 'FILING_DEADLINE', days: 30 });
  assert.equal(run(r, claim({ submittedOn: '2026-10-31' }, { incidentDate: '2026-10-01' })).approved, true);
  const late = run(r, claim({ submittedOn: '2026-11-01' }, { incidentDate: '2026-10-01' }));
  assert.equal(late.approved, false);
  assert.match(late.failures[0].counterfactual, /1 day\(s\) earlier/);
});

test('WAITING_PERIOD with appliesWhen: boundary at 730 days, and not checked for other claims', () => {
  const r = rule('C-6.2', { type: 'WAITING_PERIOD', days: 730, label: 'pre-existing condition', appliesWhen: { field: 'preExisting', equals: true } });
  assert.equal(run(r, claim({}, { incidentDate: '2025-02-01', preExisting: false })).approved, true);
  const day730 = addDays(policy.startDate, 730);
  assert.equal(run(r, claim({ submittedOn: '2027-01-10' }, { incidentDate: day730, preExisting: true })).approved, true);
  const early = run(r, claim({ submittedOn: '2027-01-10' }, { incidentDate: addDays(policy.startDate, 729), preExisting: true }));
  assert.equal(early.approved, false);
  assert.match(early.failures[0].description, /pre-existing condition arose 729 days/);
  assert.match(early.failures[0].counterfactual, new RegExp(day730));
});

test('POLICY_ACTIVE: incident must fall inside the policy period', () => {
  const r = rule('P-1', { type: 'POLICY_ACTIVE' });
  assert.equal(run(r, claim({}, { incidentDate: '2025-01-01' })).approved, true);
  assert.equal(run(r, claim({}, { incidentDate: '2024-12-31' })).approved, false);
  assert.equal(run(r, claim({}, { incidentDate: '2028-01-01' })).approved, false);
});

test('one reason per failed clause, and inactive rules are ignored', () => {
  const rules = [
    rule('C-2.1', { type: 'MAX_AMOUNT' }, 1),
    rule('C-3.2', { type: 'FIELD_IN_LIST', field: 'hospital', label: 'network hospital', values: ['Apollo Hospital'] }, 2),
    { ...rule('C-4.1', { type: 'REQUIRED_DOCUMENT', document: 'prescription' }, 3), active: false },
  ];
  const out = evaluateClaim({ claim: claim({ amount: 900000 }, { hospital: 'Nowhere Clinic' }), policy, rules });
  assert.equal(out.approved, false);
  assert.deepEqual(out.failures.map((f) => f.clauseCode), ['C-2.1', 'C-3.2']);
  assert.equal(out.results.length, 2);
});

test('bad rule definitions are rejected instead of silently passing', () => {
  assert.throws(() => run(rule('X-1', { type: 'NOPE' }), claim()), /Unknown rule type/);
  assert.throws(() => validateCondition({ type: 'FIELD_IN_LIST', field: 'x', values: [] }), /non-empty/);
  assert.throws(() => validateCondition({ type: 'FIELD_FLAG', field: 'x', requirement: 'y' }), /mustBe/);
  assert.throws(() => validateCondition({ type: 'FILING_DEADLINE' }), /days/);
  assert.throws(() => validateCondition({ type: 'REQUIRED_DOCUMENT', document: 'd', appliesWhen: { field: 'a' } }), /appliesWhen/);
});

test('every insurance category ships a valid rule set that approves a clean claim', () => {
  const clean = {
    HEALTH: { hospital: 'Apollo Hospital', procedure: 'Appendectomy', preExisting: false, documents: ['discharge_summary', 'hospital_bill'] },
    MOTOR: { garage: 'AutoCare Motors', cause: 'Collision', driverLicenseValid: true, underInfluence: false, documents: ['repair_estimate', 'rc_book'] },
    HOME: { cause: 'Fire', unoccupied: false, documents: ['damage_photos'] },
    TRAVEL: { destination: 'Paris', cause: 'Lost baggage', documents: ['travel_tickets', 'airline_report'] },
  };
  assert.deepEqual(PRODUCTS.map((p) => p.code).sort(), Object.keys(clean).sort());
  for (const p of PRODUCTS) {
    const rules = p.rules.map(([code, cond, msg], i) => ({ ruleId: i + 1, clauseCode: code, condition: JSON.stringify(cond), rejectMsg: msg, active: true }));
    const out = evaluateClaim({ claim: claim({ amount: 10000 }, { incidentDate: '2026-10-15', ...clean[p.code] }), policy, rules });
    assert.equal(out.approved, true, `${p.code} should approve a clean claim: ${out.failures.map((f) => f.description)}`);
    assert.ok(rules.length >= 6, `${p.code} should have a full rule set`);
  }
});
