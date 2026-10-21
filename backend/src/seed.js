'use strict';
// Demo data: one insurer, two policyholders, five policies across four insurance categories,
// one adjuster, one auditor, and each category's standard rule set.
const bcrypt = require('bcryptjs');
const service = require('./claimService');
const { PRODUCTS } = require('./products');

const DEMO_PASSWORD = 'password123';
const isoDate = (d) => d.toISOString().slice(0, 10);
const shift = (now, days) => isoDate(new Date(now.getTime() + days * 86400000));

async function seedBase(db, now = new Date()) {
  const existing = await db.one('SELECT user_id FROM users LIMIT 1');
  if (existing) return false;
  const hash = bcrypt.hashSync(DEMO_PASSWORD, 8);
  const nextYearEnd = `${now.getFullYear() + 1}-12-31`;

  for (const p of PRODUCTS) {
    await db.query('INSERT INTO product_types (code, name, incident_label, fields, documents) VALUES ($1,$2,$3,$4,$5)', [
      p.code, p.name, p.incidentLabel, JSON.stringify(p.fields), JSON.stringify(p.documents),
    ]);
  }

  const rohan = await db.one("INSERT INTO claimants (name, email, phone) VALUES ('Rohan Mehta','rohan@example.com','+91-9876543210') RETURNING claimant_id");
  const anita = await db.one("INSERT INTO claimants (name, email, phone) VALUES ('Anita Desai','anita@example.com','+91-9811122233') RETURNING claimant_id");
  const priya = await db.one("INSERT INTO adjusters (name, email) VALUES ('Priya Nair','priya@insurer.com') RETURNING adjuster_id");

  const users = [
    ['Rohan Mehta', 'rohan@example.com', 'claimant', rohan.claimantId, null],
    ['Anita Desai', 'anita@example.com', 'claimant', anita.claimantId, null],
    ['Priya Nair', 'priya@insurer.com', 'adjuster', null, priya.adjusterId],
    ['Meera Shah', 'meera@insurer.com', 'auditor', null, null],
  ];
  for (const [name, email, role, claimantId, adjusterId] of users) {
    await db.query('INSERT INTO users (name, email, password_hash, role, claimant_id, adjuster_id) VALUES ($1,$2,$3,$4,$5,$6)', [name, email, hash, role, claimantId, adjusterId]);
  }

  const policies = [
    [rohan.claimantId, 'HEALTH', 'Self', 'HLTH-2026-00456', 500000, '2025-01-01', nextYearEnd],
    [rohan.claimantId, 'MOTOR', 'Maruti Swift (KA-01-AB-1234)', 'MOT-2026-01123', 400000, shift(now, -120), shift(now, 245)],
    [anita.claimantId, 'HEALTH', 'Self and spouse', 'HLTH-2026-00789', 300000, '2025-06-01', nextYearEnd],
    [anita.claimantId, 'HOME', 'Flat 4B, Green Heights, Pune', 'HOME-2026-00311', 2000000, shift(now, -200), shift(now, 165)],
    [anita.claimantId, 'TRAVEL', 'Europe trip', 'TRV-2026-00077', 500000, shift(now, -30), shift(now, 60)],
  ];
  for (const [claimantId, code, item, policyNo, sum, start, end] of policies) {
    const row = await db.one(
      'INSERT INTO policies (claimant_id, product_type, insured_item, policy_no, sum_insured, start_date, end_date) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING policy_id',
      [claimantId, code, item, policyNo, sum, start, end]
    );
    const product = PRODUCTS.find((p) => p.code === code);
    for (const [clause, cond, msg] of product.rules) {
      await db.query('INSERT INTO policy_rules (policy_id, clause_code, condition, reject_msg) VALUES ($1,$2,$3,$4)', [row.policyId, clause, JSON.stringify(cond), msg]);
    }
  }
  return true;
}

const daysAgo = (now, n) => isoDate(new Date(now.getTime() - n * 86400000));

async function seedDemo(db, now = new Date()) {
  const rohanRow = await db.one("SELECT * FROM users WHERE email = 'rohan@example.com'");
  const anitaRow = await db.one("SELECT * FROM users WHERE email = 'anita@example.com'");
  const rohan = { name: rohanRow.name, claimantId: rohanRow.claimantId };
  const anita = { name: anitaRow.name, claimantId: anitaRow.claimantId };
  const pol = async (claimantId, productType) =>
    (await db.one('SELECT policy_id FROM policies WHERE claimant_id = $1 AND product_type = $2', [claimantId, productType])).policyId;

  // health: approved
  await service.submitClaim(db, rohan, {
    policyId: await pol(rohan.claimantId, 'HEALTH'), amount: 60000, incidentDate: daysAgo(now, 12),
    hospital: 'Apollo Hospital', procedure: 'Appendectomy', documents: ['discharge_summary', 'hospital_bill'],
  }, now);
  // health: rejected (non-network hospital + missing discharge summary)
  await service.submitClaim(db, rohan, {
    policyId: await pol(rohan.claimantId, 'HEALTH'), amount: 75000, incidentDate: daysAgo(now, 10),
    hospital: 'City Care Clinic', procedure: 'Knee arthroscopy', documents: ['hospital_bill'],
  }, now);
  // health: rejected (amount above sum insured) with an appeal already filed
  const rejected = await service.submitClaim(db, anita, {
    policyId: await pol(anita.claimantId, 'HEALTH'), amount: 350000, incidentDate: daysAgo(now, 8),
    hospital: 'Fortis Hospital', procedure: 'Cardiac bypass', documents: ['discharge_summary', 'hospital_bill'],
  }, now);
  await service.fileAppeal(db, anita, rejected.claimId, {
    notes: 'The surgery was an emergency and the final bill was higher than the estimate; please reconsider.',
  }, now);
  // motor: approved
  await service.submitClaim(db, rohan, {
    policyId: await pol(rohan.claimantId, 'MOTOR'), amount: 85000, incidentDate: daysAgo(now, 6),
    garage: 'AutoCare Motors', cause: 'Collision', documents: ['repair_estimate', 'rc_book'],
  }, now);
  // home: rejected (excluded cause of loss)
  await service.submitClaim(db, anita, {
    policyId: await pol(anita.claimantId, 'HOME'), amount: 150000, incidentDate: daysAgo(now, 9),
    cause: 'Wear and tear', documents: ['damage_photos'],
  }, now);
}

module.exports = { seedBase, seedDemo, DEMO_PASSWORD };
