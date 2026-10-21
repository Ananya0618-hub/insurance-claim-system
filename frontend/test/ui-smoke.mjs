// UI smoke test: loads the production build into jsdom and drives it like a user would,
// against a real backend instance (in-memory database, no demo data).
// Usage: npm run build && npm run test:ui
import { JSDOM } from 'jsdom';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const PORT = 4010;
const ORIGIN = `http://127.0.0.1:${PORT}`;

const server = spawn(process.execPath, [path.join(here, '..', '..', 'backend', 'src', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), SEED_DEMO: '0' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
const stop = () => server.kill();
process.on('exit', stop);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, timeout = 4000) {
  const start = Date.now();
  for (;;) {
    try {
      const v = fn();
      if (v) return v;
    } catch { /* keep waiting */ }
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for: ${what}`);
    await sleep(25);
  }
}
let passed = 0;
const step = (name) => { passed += 1; console.log(`  ok ${passed} - ${name}`); };

async function main() {
  await waitFor(async () => false, 'noop', 1).catch(() => {});
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${ORIGIN}/api/health`)).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }

  // production mode: the backend serves the built UI
  const root = await (await fetch(ORIGIN + '/')).text();
  if (!root.includes('<div id="root">')) throw new Error('Backend did not serve the built frontend');
  step('backend serves the built frontend');

  const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  const bundle = fs.readFileSync(path.join(dist, 'assets', /src="\/assets\/(.*?\.js)"/.exec(html)[1]), 'utf8');

  let dom;
  function boot() {
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
    dom.window.fetch = (u, o) => fetch(new URL(u, ORIGIN), o);
    dom.window.eval(bundle);
  }
  boot();
  const win = () => dom.window;
  const doc = () => dom.window.document;
  const q = (id) => doc().querySelector(`[data-testid="${id}"]`);
  const all = (id) => [...doc().querySelectorAll(`[data-testid="${id}"]`)];
  const has = (id) => !!q(id);

  function setValue(el, value) {
    const W = win();
    const proto = el instanceof W.HTMLTextAreaElement ? W.HTMLTextAreaElement.prototype
      : el instanceof W.HTMLSelectElement ? W.HTMLSelectElement.prototype : W.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new W.Event(el instanceof W.HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  }
  const type = (id, v) => setValue(q(id), v);
  const click = (id) => q(id).click();
  const text = (id) => q(id).textContent.trim();
  async function login(demoKey) {
    await waitFor(() => has('login-email'), 'login form');
    click(`demo-${demoKey}`);
    await waitFor(() => q('login-email').value, 'demo credentials filled');
    click('login-submit');
    await waitFor(() => has('whoami'), 'logged in');
  }
  async function logout() { click('logout'); await waitFor(() => has('login-email'), 'login form after logout'); }

  // ---- login screen
  await waitFor(() => has('login-email'), 'login form');
  type('login-email', 'rohan@example.com');
  type('login-password', 'wrong-password');
  click('login-submit');
  await waitFor(() => has('notice-error'), 'login error');
  if (!/Incorrect email or password/.test(text('notice-error'))) throw new Error('Unexpected login error: ' + text('notice-error'));
  step('wrong password shows an error and stays on the login screen');

  // ---- claimant: submit a claim that will be rejected
  await login('rohan');
  if (!/Rohan Mehta/.test(text('whoami')) || has('nav-appeals')) throw new Error('Claimant navigation wrong');
  await waitFor(() => has('no-claims'), 'empty claim list');
  step('claimant logs in and sees an empty claim list (no staff navigation)');

  click('nav-new');
  await waitFor(() => has('claim-amount') && q('claim-policy').options.length > 0 && has('doc-hospital_bill'), 'claim form');
  const d = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
  type('claim-amount', '75000');
  type('claim-date', d);
  type('field-hospital', 'City Care Clinic');
  type('field-procedure', 'Knee arthroscopy');
  click('doc-hospital_bill');
  click('claim-submit');
  await waitFor(() => has('claim-status'), 'claim detail after submit');
  if (text('claim-status') !== 'Rejected') throw new Error('Expected Rejected, got ' + text('claim-status'));
  const reasons = all('reason-item');
  if (reasons.length !== 2) throw new Error(`Expected 2 reasons, got ${reasons.length}`);
  if (!/network hospital/.test(all('counterfactual')[0].textContent)) throw new Error('Counterfactual missing');
  if (has('staff-actions') || has('audit-trail')) throw new Error('Claimant can see staff-only sections');
  step('rejected claim shows 2 clause reasons, each with a counterfactual, and no staff-only sections');

  // ---- claimant: appeal
  if (!/30 day\(s\) left/.test(text('appeal-window'))) throw new Error('Appeal window text wrong: ' + text('appeal-window'));
  type('appeal-notes', 'It was the closest hospital during an emergency admission.');
  click('appeal-submit');
  await waitFor(() => has('appeal-status'), 'appeal info');
  if (text('appeal-status') !== 'Filed' || text('claim-status') !== 'Appeal filed') throw new Error('Appeal state wrong');
  if (has('appeal-submit')) throw new Error('Appeal form should disappear after filing');
  step('claimant files an appeal; claim moves to "Appeal filed"');
  await logout();

  // ---- adjuster
  await login('priya');
  if (!has('nav-appeals') || !has('nav-rules')) throw new Error('Adjuster navigation wrong');
  await waitFor(() => has('claim-row-1'), 'claims table');
  step('adjuster sees the claim queue');
  click('nav-appeals');
  await waitFor(() => has('appeal-row-1'), 'appeals table');
  if (!/C-3\.2, C-4\.1/.test(q('appeal-row-1').textContent)) throw new Error('Appeals queue should list rejected clauses');
  q('appeal-row-1').click();
  await waitFor(() => has('appeal-start'), 'start review button');
  if (!has('audit-trail')) throw new Error('Adjuster should see the audit trail');
  click('appeal-start');
  await waitFor(() => has('appeal-decide'), 'decision form');
  if (text('claim-status') !== 'Under appeal review') throw new Error('Expected Under appeal review');
  step('adjuster opens the appeal and starts the review');

  click('appeal-decide'); // empty justification must not go through (form has "required")
  await sleep(150);
  if (text('claim-status') !== 'Under appeal review') throw new Error('Decision went through without a justification');
  type('appeal-justification', 'Emergency exception verified with hospital records');
  click('appeal-decide');
  await waitFor(() => text('claim-status') === 'Approved', 'claim approved after appeal upheld');
  if (text('appeal-status') !== 'Approved') throw new Error('Appeal should be Approved');
  const trail = q('audit-trail').querySelectorAll('tbody tr').length;
  if (trail < 5) throw new Error(`Expected at least 5 audit rows, got ${trail}`);
  step('adjuster upholds the appeal with a justification; claim approved; audit trail has ' + trail + ' entries');

  click('payout-submit');
  await waitFor(() => text('claim-status') === 'Closed', 'claim closed after payout');
  step('adjuster completes the payout; claim is closed');

  click('nav-rules');
  await waitFor(() => doc().querySelectorAll('[data-testid^="rule-row-"]').length >= 16, 'rules table');
  const box = doc().querySelector('[data-testid^="rule-active-"]');
  const id = box.getAttribute('data-testid');
  if (!box.checked) throw new Error('Rule should start active');
  box.click();
  await waitFor(() => doc().querySelector(`[data-testid="${id}"]`).checked === false, 'rule switched off');
  step('adjuster switches a rule off and the change is saved');
  await logout();

  // ---- auditor
  await login('meera');
  await waitFor(() => has('stat-total'), 'dashboard');
  if (text('stat-total') !== '1' || text('stat-rejection-rate') !== '100%') throw new Error('Dashboard numbers wrong');
  if (text('stat-appeal-approval') !== '100%') throw new Error('Appeal approval rate wrong');
  if (!has('download-csv') || !has('top-clauses')) throw new Error('Dashboard parts missing');
  step('auditor dashboard shows the claim, rejection rate, appeal approval rate and top clauses');
  click('nav-audit');
  await waitFor(() => has('audit-table') && q('audit-table').querySelectorAll('tbody tr').length >= 7, 'audit log');
  if (!/Rule C-1\.1.*active=false|Rule .* active=false/.test(q('audit-table').textContent)) throw new Error('Rule change missing from audit log');
  step('auditor sees the audit log, including the rule change');
  click('nav-rules');
  await waitFor(() => doc().querySelectorAll('[data-testid^="rule-row-"]').length >= 16, 'rules (read-only)');
  if (doc().querySelector('[data-testid^="rule-msg-"]') || !doc().querySelector('[data-testid^="rule-active-"]').disabled) throw new Error('Auditor must not be able to edit rules');
  step('auditor sees rules read-only');
  await logout();

  // ---- boundary + override (same flows as Selenium TC-06 / TC-07)
  async function submitClaimUI({ amount, hospital, procedure, docs }) {
    click('nav-new');
    await waitFor(() => has('claim-amount') && q('claim-policy').options.length > 0 && has('doc-hospital_bill'), 'claim form');
    type('claim-amount', String(amount));
    type('claim-date', new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10));
    type('field-hospital', hospital);
    type('field-procedure', procedure);
    for (const d of docs) click(`doc-${d}`);
    click('claim-submit');
    await waitFor(() => has('claim-status'), 'claim result');
  }
  await login('rohan');
  const docs = ['discharge_summary', 'hospital_bill'];
  await submitClaimUI({ amount: 500000, hospital: 'Apollo Hospital', procedure: 'Cardiac surgery', docs });
  if (text('claim-status') !== 'Approved') throw new Error('A claim equal to the sum insured should be approved, got ' + text('claim-status'));
  click('nav-claims');
  await submitClaimUI({ amount: 500001, hospital: 'Apollo Hospital', procedure: 'Cardiac surgery', docs });
  if (text('claim-status') !== 'Rejected') throw new Error('A claim one rupee over the sum insured should be rejected');
  if (!/Reduce the claimed amount/.test(text('counterfactual'))) throw new Error('Counterfactual should say how much to reduce the amount');
  step('boundary: claim equal to the sum insured is approved, one rupee more is rejected with a counterfactual');
  await logout();

  await login('priya');
  await waitFor(() => has('claim-row-3'), 'claim 3 in queue');
  q('claim-row-3').click();
  await waitFor(() => has('override-submit') && text('claim-status') === 'Rejected', 'override form');
  type('override-decision', 'approve');
  type('override-justification', 'Sum insured was enhanced by a mid-term endorsement');
  click('override-submit');
  await waitFor(() => text('claim-status') === 'Approved', 'claim approved after override');
  if (!/Override: REJECTED -> APPROVED/.test(q('audit-trail').textContent)) throw new Error('Override missing from audit trail');
  step('adjuster overrides a rejection with a justification and it is audited');
  await logout();

  // ---- a different line of business: motor insurance, same screens, different questions
  await login('rohan');
  click('nav-new');
  await waitFor(() => has('claim-policy') && q('claim-policy').options.length === 2, 'policy list with two policies');
  if (!has('field-hospital') || has('field-garage')) throw new Error('Health policy should show hospital questions');
  const motorOption = [...q('claim-policy').options].find((o) => /^MOT-/.test(o.textContent));
  setValue(q('claim-policy'), motorOption.value);
  await waitFor(() => has('field-garage'), 'motor questions after choosing the motor policy');
  if (has('field-hospital') || has('doc-hospital_bill')) throw new Error('Health questions must disappear for a motor policy');
  if (!/Motor insurance/.test(text('claim-type')) || !/Date of accident/.test(doc().body.textContent)) throw new Error('Form should be labelled for motor insurance');
  if (!q('field-driverLicenseValid').checked) throw new Error('Licence declaration should default to yes');
  step('choosing a motor policy swaps the form to motor questions, documents and date label');

  type('claim-amount', '90000');
  type('claim-date', new Date(Date.now() - 4 * 86400000).toISOString().slice(0, 10));
  type('field-garage', 'Roadside Fix-It');
  type('field-cause', 'Collision');
  click('field-driverLicenseValid'); // untick: no valid licence
  click('doc-repair_estimate');
  click('claim-submit');
  await waitFor(() => has('claim-status'), 'motor claim result');
  if (text('claim-status') !== 'Rejected' || text('claim-product') !== 'Motor insurance') throw new Error('Motor claim should be rejected');
  const motorReasons = all('reason-item').map((n) => n.textContent);
  if (motorReasons.length !== 3 || !/M-3\.1/.test(motorReasons[0]) || !/M-4\.2/.test(motorReasons[1]) || !/M-5\.2/.test(motorReasons[2])) throw new Error('Unexpected motor reasons: ' + motorReasons.join(' | '));
  if (!/authorised garage/.test(motorReasons[0]) || !/valid driving licence/.test(motorReasons[1])) throw new Error('Motor counterfactuals missing');
  step('motor claim: 3 clause reasons (garage, licence, registration certificate) each with a counterfactual');
  await logout();

  await login('meera');
  await waitFor(() => has('by-product'), 'dashboard by-product table');
  const split = q('by-product').textContent;
  if (!/Health insurance/.test(split) || !/Motor insurance/.test(split)) throw new Error('Dashboard should split claims by insurance type');
  step('auditor dashboard splits claims by insurance type');
  await logout();

  console.log(`\nUI smoke test passed (${passed} checks)`);
}

main().then(() => { stop(); process.exit(0); }).catch((e) => { console.error('\nUI smoke test FAILED:', e.message); stop(); process.exit(1); });
