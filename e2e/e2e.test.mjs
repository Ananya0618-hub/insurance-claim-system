// Selenium end-to-end tests (Chrome). They drive the real UI of a running instance.
//
//   1. Start the app with a clean database:   SEED_DEMO=0 npm start        (from the repo root, after npm run build)
//   2. Run the tests:                         npm --prefix e2e install && npm run test:e2e
//
// Optional: BASE_URL (default http://localhost:4000), HEADED=1 to watch the browser.
// The tests run in order and share state (TC-02 creates the claim that TC-03 and TC-04 use).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Builder, By, until } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome.js';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const TIMEOUT = 10000;
let driver;

before(async () => {
  const options = new chrome.Options();
  if (process.env.HEADED !== '1') options.addArguments('--headless=new');
  options.addArguments('--window-size=1280,900', '--no-sandbox');
  driver = await new Builder().forBrowser('chrome').setChromeOptions(options).build();
});
after(async () => { if (driver) await driver.quit(); });

// ---------- helpers
const by = (id) => By.css(`[data-testid="${id}"]`);
const poll = (fn, message) => driver.wait(async () => { try { return await fn(); } catch { return false; } }, TIMEOUT, message);
const find = (id) => driver.wait(until.elementLocated(by(id)), TIMEOUT, `element ${id} not found`);
const exists = async (id) => (await driver.findElements(by(id))).length > 0;
const text = async (id) => (await (await find(id)).getText()).trim();
const waitText = (id, expected) => poll(async () => (await text(id)) === expected, `${id} should read "${expected}"`);
async function click(id) {
  const el = await find(id);
  await driver.wait(until.elementIsEnabled(el), TIMEOUT);
  await el.click();
}
// Sets a value on React-controlled inputs (text, number, date, textarea, select).
async function setValue(id, value) {
  const el = await find(id);
  await driver.executeScript(`
    const el = arguments[0], value = arguments[1];
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
      : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));`, el, value);
}
async function freshBrowser() {
  await driver.get(BASE);
  await driver.executeScript('window.localStorage.clear()');
  await driver.get(BASE);
}
async function login(demoKey) {
  await freshBrowser();
  await click(`demo-${demoKey}`);
  await click('login-submit');
  await find('whoami');
}
const logout = async () => { await click('logout'); await find('login-email'); };
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

// Picks the policy whose label starts with `prefix` (e.g. 'HLTH-', 'MOT-'); the form then re-draws itself.
async function choosePolicy(prefix, waitForField) {
  const select = await find('claim-policy');
  for (const option of await select.findElements(By.css('option'))) {
    if ((await option.getText()).startsWith(prefix)) await setValue('claim-policy', await option.getAttribute('value'));
  }
  await poll(async () => await exists(`field-${waitForField}`), `form for ${prefix} policy`);
}

// fields: { key: value } for the category's own questions; flip: boolean fields to toggle; documents: document keys
async function submitClaim({ policy, amount, fields, flip = [], documents = [], date = daysAgo(5) }) {
  await click('nav-new');
  await poll(async () => (await (await find('claim-policy')).findElements(By.css('option'))).length > 0, 'policy list');
  await choosePolicy(policy, Object.keys(fields)[0]);
  await setValue('claim-amount', String(amount));
  await setValue('claim-date', date);
  for (const [key, value] of Object.entries(fields)) await setValue(`field-${key}`, value);
  for (const key of flip) await click(`field-${key}`);
  for (const d of documents) await click(`doc-${d}`);
  await click('claim-submit');
  await find('claim-status');
}

// ---------- test cases
test('TC-01 login: wrong password is refused with a message', async () => {
  await freshBrowser();
  await setValue('login-email', 'rohan@example.com');
  await setValue('login-password', 'wrong-password');
  await click('login-submit');
  assert.match(await text('notice-error'), /Incorrect email or password/);
  assert.equal(await exists('whoami'), false);
});

test('TC-02 claimant: a non-network claim with a missing document is rejected with reasons and counterfactuals', async () => {
  await login('rohan');
  assert.equal(await exists('nav-appeals'), false, 'claimant must not see staff navigation');
  await submitClaim({ policy: 'HLTH-', amount: 75000, fields: { hospital: 'City Care Clinic', procedure: 'Knee arthroscopy' }, documents: ['hospital_bill'] });
  assert.equal(await text('claim-status'), 'Rejected');
  const reasons = await driver.findElements(by('reason-item'));
  assert.equal(reasons.length, 2);
  const counterfactuals = await driver.findElements(by('counterfactual'));
  assert.match(await counterfactuals[0].getText(), /network hospital/);
  assert.match(await counterfactuals[1].getText(), /discharge summary/);
  assert.equal(await exists('staff-actions'), false, 'claimant must not see adjuster actions');
});

test('TC-03 claimant: files an appeal inside the window', async () => {
  assert.match(await text('appeal-window'), /30 day\(s\) left/);
  await setValue('appeal-notes', 'It was the nearest hospital during an emergency admission.');
  await click('appeal-submit');
  await waitText('appeal-status', 'Filed');
  assert.equal(await text('claim-status'), 'Appeal filed');
  assert.equal(await exists('appeal-submit'), false, 'the appeal form disappears once filed');
  await logout();
});

test('TC-04 adjuster: reviews the appeal, upholds it, and the decision is audited', async () => {
  await login('priya');
  await click('nav-appeals');
  await click('appeal-row-1');
  await click('appeal-start');
  await find('appeal-decide');
  assert.equal(await text('claim-status'), 'Under appeal review');
  await setValue('appeal-decision', 'approve');
  await setValue('appeal-justification', 'Emergency exception verified with hospital records');
  await click('appeal-decide');
  await waitText('claim-status', 'Approved');
  const rows = await driver.findElements(By.css('[data-testid="audit-trail"] tbody tr'));
  assert.ok(rows.length >= 5, `expected at least 5 audit rows, got ${rows.length}`);
});

test('TC-05 adjuster: completes the payout and the claim is closed', async () => {
  await click('payout-submit');
  await waitText('claim-status', 'Closed');
  await logout();
});

test('TC-06 boundary: a claim equal to the sum insured is approved, one rupee more is rejected', async () => {
  await login('rohan');
  const docs = ['discharge_summary', 'hospital_bill'];
  await submitClaim({ policy: 'HLTH-', amount: 500000, fields: { hospital: 'Apollo Hospital', procedure: 'Cardiac surgery' }, documents: docs });
  assert.equal(await text('claim-status'), 'Approved');
  await click('nav-claims');
  await submitClaim({ policy: 'HLTH-', amount: 500001, fields: { hospital: 'Apollo Hospital', procedure: 'Cardiac surgery' }, documents: docs });
  assert.equal(await text('claim-status'), 'Rejected');
  assert.match(await text('counterfactual'), /Reduce the claimed amount/);
  await logout();
});

test('TC-07 adjuster: overriding a decision requires a justification and is logged', async () => {
  await login('priya');
  await click('claim-row-3');                       // the 500001 claim rejected in TC-06
  await waitText('claim-status', 'Rejected');
  await setValue('override-decision', 'approve');
  await setValue('override-justification', 'Sum insured was enhanced by a mid-term endorsement');
  await click('override-submit');
  await waitText('claim-status', 'Approved');
  const trail = await (await find('audit-trail')).getText();
  assert.match(trail, /Override: REJECTED -> APPROVED/);
  await logout();
});

test('TC-08 other lines of business: a motor claim gets motor questions and motor reasons', async () => {
  await login('rohan');
  await click('nav-new');
  await poll(async () => (await (await find('claim-policy')).findElements(By.css('option'))).length === 2, 'two policies');
  assert.equal(await exists('field-hospital'), true, 'health policy shows hospital questions');
  await choosePolicy('MOT-', 'garage');
  assert.equal(await exists('field-hospital'), false, 'hospital question disappears for a motor policy');
  assert.match(await text('claim-type'), /Motor insurance/);
  await submitClaim({
    policy: 'MOT-', amount: 90000, fields: { garage: 'Roadside Fix-It', cause: 'Collision' },
    flip: ['driverLicenseValid'], documents: ['repair_estimate'],
  });
  assert.equal(await text('claim-product'), 'Motor insurance');
  assert.equal(await text('claim-status'), 'Rejected');
  const reasons = await driver.findElements(by('reason-item'));
  assert.equal(reasons.length, 3);
  const joined = (await Promise.all(reasons.map((r) => r.getText()))).join(' | ');
  assert.match(joined, /M-3\.1/);
  assert.match(joined, /authorised garage/);
  assert.match(joined, /valid driving licence/);
  await logout();
});

test('TC-09 auditor: sees the dashboard split by insurance type and cannot edit rules', async () => {
  await login('meera');
  await find('stat-total');
  assert.equal(await text('stat-total'), '4');
  const split = await text('by-product');
  assert.match(split, /Health insurance/);
  assert.match(split, /Motor insurance/);
  assert.equal(await exists('download-csv'), true);
  await click('nav-rules');
  await poll(async () => (await driver.findElements(By.css('[data-testid^="rule-row-"]'))).length >= 16, 'rules table');
  const boxes = await driver.findElements(By.css('[data-testid^="rule-active-"]'));
  assert.equal(await boxes[0].isEnabled(), false, 'auditor must not be able to switch rules');
  await logout();
});
