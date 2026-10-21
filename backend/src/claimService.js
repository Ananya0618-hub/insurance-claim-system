'use strict';
// Business logic: claim life cycle (state machine), appeals, overrides, audit logging, reports.
const { evaluateClaim, validateCondition, daysBetween, addDays } = require('./ruleEngine');

const STATUS = {
  SUBMITTED: 'SUBMITTED',
  UNDER_REVIEW: 'UNDER_REVIEW',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  APPEAL_FILED: 'APPEAL_FILED',
  UNDER_APPEAL_REVIEW: 'UNDER_APPEAL_REVIEW',
  CLOSED: 'CLOSED',
};

// Allowed transitions - mirrors the state transition diagram (plus adjuster override).
const TRANSITIONS = {
  SUBMITTED: ['UNDER_REVIEW'],
  UNDER_REVIEW: ['APPROVED', 'REJECTED'],
  APPROVED: ['CLOSED', 'REJECTED'],
  REJECTED: ['APPEAL_FILED', 'CLOSED', 'APPROVED'],
  APPEAL_FILED: ['UNDER_APPEAL_REVIEW'],
  UNDER_APPEAL_REVIEW: ['APPROVED', 'CLOSED'],
  CLOSED: [],
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const appealWindowDays = () => Number(process.env.APPEAL_WINDOW_DAYS || 30);
const isoDate = (d) => d.toISOString().slice(0, 10);

function assertTransition(from, to) {
  if (!TRANSITIONS[from] || !TRANSITIONS[from].includes(to)) {
    throw new HttpError(409, `Invalid status change: ${from} -> ${to}`);
  }
}

async function log(db, { claimId = null, adjusterId = null, actor, action, now }) {
  await db.query(
    'INSERT INTO audit_logs (claim_id, adjuster_id, action, actor, logged_at) VALUES ($1,$2,$3,$4,$5)',
    [claimId, adjusterId, action, actor, now.toISOString()]
  );
}

async function moveClaim(db, claim, to, fields = {}) {
  assertTransition(claim.status, to);
  const sets = ['status = $1'];
  const params = [to];
  for (const [col, val] of Object.entries(fields)) {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  }
  params.push(claim.claimId);
  await db.query(`UPDATE claims SET ${sets.join(', ')} WHERE claim_id = $${params.length}`, params);
  claim.status = to;
}

async function getClaim(db, claimId) {
  const claim = await db.one('SELECT * FROM claims WHERE claim_id = $1', [claimId]);
  if (!claim) throw new HttpError(404, 'Claim not found');
  claim.details = JSON.parse(claim.details);
  return claim;
}

// ---------------------------------------------------------------- insurance categories
const parseProduct = (row) => ({
  code: row.code,
  name: row.name,
  incidentLabel: row.incidentLabel,
  fields: JSON.parse(row.fields),
  documents: JSON.parse(row.documents),
});

async function listProductTypes(db) {
  return (await db.query('SELECT * FROM product_types ORDER BY code')).map(parseProduct);
}

async function getProduct(db, code) {
  const row = await db.one('SELECT * FROM product_types WHERE code = $1', [code]);
  if (!row) throw new HttpError(500, `Unknown insurance category: ${code}`);
  return parseProduct(row);
}

const shown = (v) => (typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v ?? ''));

// ---------------------------------------------------------------- queries
async function getClaimDetail(db, claimId, { includeAudit = false, now = new Date() } = {}) {
  const claim = await getClaim(db, claimId);
  const claimant = await db.one('SELECT name FROM claimants WHERE claimant_id = $1', [claim.claimantId]);
  const policy = await db.one('SELECT policy_no, sum_insured, product_type, insured_item FROM policies WHERE policy_id = $1', [claim.policyId]);
  const product = await getProduct(db, policy.productType);
  const reasons = await db.query(
    'SELECT reason_id, rule_code, description, counterfactual FROM rejection_reasons WHERE claim_id = $1 ORDER BY reason_id',
    [claimId]
  );
  const appeal = await db.one('SELECT * FROM appeals WHERE claim_id = $1 ORDER BY appeal_id DESC', [claimId]);

  let appealWindow = null;
  if (claim.status === STATUS.REJECTED && claim.decidedOn) {
    const deadline = addDays(claim.decidedOn, appealWindowDays());
    const daysLeft = daysBetween(isoDate(now), deadline);
    appealWindow = { deadline, daysLeft, canAppeal: daysLeft >= 0 };
  }

  const detail = {
    ...claim,
    claimantName: claimant.name,
    policyNo: policy.policyNo,
    sumInsured: policy.sumInsured,
    insuredItem: policy.insuredItem,
    productCode: product.code,
    productName: product.name,
    product: { incidentLabel: product.incidentLabel, fields: product.fields, documents: product.documents },
    reasons,
    appeal,
    appealWindow,
  };
  if (includeAudit) {
    detail.auditTrail = await db.query(
      'SELECT log_id, action, actor, logged_at FROM audit_logs WHERE claim_id = $1 ORDER BY log_id',
      [claimId]
    );
  }
  return detail;
}

async function listClaims(db, { claimantId = null, status = null } = {}) {
  const claims = await db.query('SELECT * FROM claims ORDER BY claim_id DESC');
  const claimants = new Map((await db.query('SELECT claimant_id, name FROM claimants')).map((c) => [c.claimantId, c.name]));
  const policies = new Map((await db.query('SELECT policy_id, policy_no, product_type FROM policies')).map((p) => [p.policyId, p]));
  const products = new Map((await listProductTypes(db)).map((p) => [p.code, p]));
  const appeals = new Map();
  for (const a of await db.query('SELECT claim_id, status, appeal_id FROM appeals ORDER BY appeal_id')) appeals.set(a.claimId, a.status);
  return claims
    .filter((c) => (claimantId ? c.claimantId === claimantId : true))
    .filter((c) => (status ? c.status === status : true))
    .map((c) => {
      const details = JSON.parse(c.details);
      const policy = policies.get(c.policyId);
      const product = products.get(policy.productType);
      const first = product.fields[0];
      return {
        claimId: c.claimId,
        claimantName: claimants.get(c.claimantId),
        policyNo: policy.policyNo,
        productCode: product.code,
        productName: product.name,
        headline: first ? shown(details[first.key]) : '',
        amount: c.amount,
        status: c.status,
        submittedOn: c.submittedOn,
        decidedOn: c.decidedOn,
        appealStatus: appeals.get(c.claimId) || null,
      };
    });
}

async function listPolicies(db, { claimantId = null } = {}) {
  const rows = await db.query('SELECT * FROM policies ORDER BY policy_id');
  const products = new Map((await listProductTypes(db)).map((p) => [p.code, p.name]));
  return rows
    .filter((p) => (claimantId ? p.claimantId === claimantId : true))
    .map((p) => ({ ...p, productName: products.get(p.productType) }));
}

// ---------------------------------------------------------------- claim submission
// Validates a submission against the insurance category's own field definitions.
function validateSubmission(product, input, now) {
  const errors = [];
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) errors.push('amount must be a positive number');

  const incidentDate = input.incidentDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(incidentDate || '') || Number.isNaN(Date.parse(incidentDate))) {
    errors.push(`${product.incidentLabel} must be a valid date (YYYY-MM-DD)`);
  } else if (incidentDate > isoDate(now)) {
    errors.push(`${product.incidentLabel} cannot be in the future`);
  }

  const details = { incidentDate };
  for (const f of product.fields) {
    const raw = input[f.key];
    if (f.type === 'boolean') {
      details[f.key] = raw === undefined ? Boolean(f.default) : Boolean(raw);
      continue;
    }
    const value = raw === undefined || raw === null ? '' : String(raw).trim();
    if (f.required && !value) errors.push(`${f.label} is required`);
    if (f.type === 'select' && value && !f.options.includes(value)) errors.push(`${f.label} must be one of: ${f.options.join(', ')}`);
    details[f.key] = value;
  }

  const documents = Array.isArray(input.documents) ? input.documents : [];
  for (const d of documents) if (!product.documents[d]) errors.push(`unknown document type: ${d}`);
  details.documents = documents;

  if (errors.length) throw new HttpError(400, errors.join('; '));
  return { amount, details };
}

async function submitClaim(db, user, input, now = new Date()) {
  const policy = await db.one('SELECT * FROM policies WHERE policy_id = $1', [Number(input.policyId)]);
  if (!policy || policy.claimantId !== user.claimantId) throw new HttpError(404, 'Policy not found');
  const product = await getProduct(db, policy.productType);
  const { amount, details } = validateSubmission(product, input, now);
  const submittedOn = isoDate(now);

  const inserted = await db.one(
    'INSERT INTO claims (policy_id, claimant_id, amount, status, submitted_on, details) VALUES ($1,$2,$3,$4,$5,$6) RETURNING claim_id',
    [policy.policyId, user.claimantId, amount, STATUS.SUBMITTED, submittedOn, JSON.stringify(details)]
  );
  const claimId = inserted.claimId;
  await log(db, { claimId, actor: user.name, action: `Claim submitted for ${amount} (${product.name})`, now });

  const claim = await getClaim(db, claimId);
  await moveClaim(db, claim, STATUS.UNDER_REVIEW);

  const rules = await db.query('SELECT * FROM policy_rules WHERE policy_id = $1 ORDER BY rule_id', [policy.policyId]);
  const result = evaluateClaim({ claim: { amount, submittedOn, details }, policy, rules });

  if (result.approved) {
    await moveClaim(db, claim, STATUS.APPROVED, { decided_on: submittedOn });
    await log(db, { claimId, actor: 'system', action: 'Automated evaluation: APPROVED (all clauses passed)', now });
  } else {
    await moveClaim(db, claim, STATUS.REJECTED, { decided_on: submittedOn });
    for (const f of result.failures) {
      await db.query(
        'INSERT INTO rejection_reasons (claim_id, rule_id, rule_code, description, counterfactual) VALUES ($1,$2,$3,$4,$5)',
        [claimId, f.ruleId, f.clauseCode, f.description, f.counterfactual]
      );
    }
    await log(db, {
      claimId,
      actor: 'system',
      action: `Automated evaluation: REJECTED (${result.failures.length} clause(s) failed: ${result.failures.map((f) => f.clauseCode).join(', ')})`,
      now,
    });
  }
  return getClaimDetail(db, claimId, { now });
}

// ---------------------------------------------------------------- adjuster actions
function requireJustification(text) {
  if (!text || String(text).trim().length < 5) throw new HttpError(400, 'A justification of at least 5 characters is required');
  return String(text).trim();
}

async function overrideClaim(db, adjuster, claimId, decision, justification, now = new Date()) {
  if (!['approve', 'reject'].includes(decision)) throw new HttpError(400, "decision must be 'approve' or 'reject'");
  const why = requireJustification(justification);
  const claim = await getClaim(db, claimId);
  if (![STATUS.APPROVED, STATUS.REJECTED].includes(claim.status)) {
    throw new HttpError(409, `A claim in status ${claim.status} cannot be overridden`);
  }
  const target = decision === 'approve' ? STATUS.APPROVED : STATUS.REJECTED;
  if (claim.status === target) throw new HttpError(409, `Claim is already ${target}`);
  const from = claim.status;
  await moveClaim(db, claim, target, { adjuster_id: adjuster.adjusterId, decided_on: isoDate(now) });
  if (target === STATUS.REJECTED) {
    await db.query(
      'INSERT INTO rejection_reasons (claim_id, rule_id, rule_code, description, counterfactual) VALUES ($1,$2,$3,$4,$5)',
      [claimId, null, 'MANUAL', `Manual decision by adjuster: ${why}`, 'Contact your claims adjuster, or file an appeal with additional supporting evidence.']
    );
  }
  await log(db, { claimId, adjusterId: adjuster.adjusterId, actor: adjuster.name, action: `Override: ${from} -> ${target} - ${why}`, now });
  return getClaimDetail(db, claimId, { includeAudit: true, now });
}

async function completePayout(db, adjuster, claimId, now = new Date()) {
  const claim = await getClaim(db, claimId);
  if (claim.status !== STATUS.APPROVED) throw new HttpError(409, 'Only approved claims can be paid out');
  await moveClaim(db, claim, STATUS.CLOSED, { adjuster_id: adjuster.adjusterId });
  await log(db, { claimId, adjusterId: adjuster.adjusterId, actor: adjuster.name, action: 'Payout completed - claim closed', now });
  return getClaimDetail(db, claimId, { includeAudit: true, now });
}

// ---------------------------------------------------------------- appeals
async function fileAppeal(db, user, claimId, input, now = new Date()) {
  const claim = await getClaim(db, claimId);
  if (claim.claimantId !== user.claimantId) throw new HttpError(404, 'Claim not found');
  if (claim.status !== STATUS.REJECTED) throw new HttpError(409, 'Only rejected claims can be appealed');
  const notes = input && input.notes ? String(input.notes).trim() : '';
  if (notes.length < 10) throw new HttpError(400, 'Please explain your appeal in at least 10 characters');
  const deadline = addDays(claim.decidedOn, appealWindowDays());
  if (isoDate(now) > deadline) throw new HttpError(409, `The appeal window closed on ${deadline}`);

  await db.query('INSERT INTO appeals (claim_id, filed_on, status, notes) VALUES ($1,$2,$3,$4)', [
    claimId, isoDate(now), 'FILED', notes,
  ]);
  await moveClaim(db, claim, STATUS.APPEAL_FILED);
  await log(db, { claimId, actor: user.name, action: 'Appeal filed by claimant', now });
  return getClaimDetail(db, claimId, { now });
}

async function getAppeal(db, appealId) {
  const appeal = await db.one('SELECT * FROM appeals WHERE appeal_id = $1', [appealId]);
  if (!appeal) throw new HttpError(404, 'Appeal not found');
  return appeal;
}

async function listAppeals(db, { status = null } = {}) {
  const appeals = await db.query('SELECT * FROM appeals ORDER BY appeal_id DESC');
  const out = [];
  for (const a of appeals) {
    if (status && a.status !== status) continue;
    const claim = await getClaim(db, a.claimId);
    const claimant = await db.one('SELECT name FROM claimants WHERE claimant_id = $1', [claim.claimantId]);
    const reasons = await db.query('SELECT rule_code FROM rejection_reasons WHERE claim_id = $1', [a.claimId]);
    out.push({ ...a, claimAmount: claim.amount, claimantName: claimant.name, claimStatus: claim.status, rejectedClauses: reasons.map((r) => r.ruleCode) });
  }
  return out;
}

async function startAppealReview(db, adjuster, appealId, now = new Date()) {
  const appeal = await getAppeal(db, appealId);
  if (appeal.status !== 'FILED') throw new HttpError(409, 'Only newly filed appeals can be picked up for review');
  const claim = await getClaim(db, appeal.claimId);
  await moveClaim(db, claim, STATUS.UNDER_APPEAL_REVIEW, { adjuster_id: adjuster.adjusterId });
  await db.query('UPDATE appeals SET status = $1, adjuster_id = $2 WHERE appeal_id = $3', ['UNDER_REVIEW', adjuster.adjusterId, appealId]);
  await log(db, { claimId: claim.claimId, adjusterId: adjuster.adjusterId, actor: adjuster.name, action: 'Appeal review started', now });
  return getAppeal(db, appealId);
}

async function decideAppeal(db, adjuster, appealId, decision, justification, now = new Date()) {
  if (!['approve', 'deny'].includes(decision)) throw new HttpError(400, "decision must be 'approve' or 'deny'");
  const why = requireJustification(justification);
  const appeal = await getAppeal(db, appealId);
  if (appeal.status !== 'UNDER_REVIEW') throw new HttpError(409, 'Appeal must be under review before a decision can be made');
  const claim = await getClaim(db, appeal.claimId);
  const upheld = decision === 'approve';
  await moveClaim(db, claim, upheld ? STATUS.APPROVED : STATUS.CLOSED, { adjuster_id: adjuster.adjusterId });
  await db.query('UPDATE appeals SET status = $1, resolution = $2, resolved_on = $3 WHERE appeal_id = $4', [
    upheld ? 'APPROVED' : 'DENIED', why, isoDate(now), appealId,
  ]);
  await log(db, {
    claimId: claim.claimId,
    adjusterId: adjuster.adjusterId,
    actor: adjuster.name,
    action: `Appeal ${upheld ? 'APPROVED (claim approved)' : 'DENIED (claim closed)'} - ${why}`,
    now,
  });
  return getAppeal(db, appealId);
}

// Rejected claims with no appeal inside the window are closed automatically.
async function closeExpired(db, now = new Date()) {
  const rejected = await db.query('SELECT * FROM claims WHERE status = $1', [STATUS.REJECTED]);
  let closed = 0;
  for (const row of rejected) {
    if (row.decidedOn && daysBetween(row.decidedOn, isoDate(now)) > appealWindowDays()) {
      await moveClaim(db, row, STATUS.CLOSED);
      await log(db, { claimId: row.claimId, actor: 'system', action: `Closed automatically: no appeal within ${appealWindowDays()} days`, now });
      closed += 1;
    }
  }
  return closed;
}

// ---------------------------------------------------------------- rules (adjuster-managed)
async function listRules(db) {
  const rules = await db.query('SELECT * FROM policy_rules ORDER BY policy_id, rule_id');
  const policies = new Map((await listPolicies(db)).map((p) => [p.policyId, p]));
  return rules.map((r) => ({
    ...r,
    policyNo: policies.get(r.policyId).policyNo,
    productName: policies.get(r.policyId).productName,
    condition: JSON.parse(r.condition),
  }));
}

async function updateRule(db, adjuster, ruleId, patch, now = new Date()) {
  const rule = await db.one('SELECT * FROM policy_rules WHERE rule_id = $1', [ruleId]);
  if (!rule) throw new HttpError(404, 'Rule not found');
  const changes = [];
  const next = { rejectMsg: rule.rejectMsg, active: rule.active, condition: rule.condition };
  if (typeof patch.rejectMsg === 'string' && patch.rejectMsg.trim()) {
    next.rejectMsg = patch.rejectMsg.trim();
    changes.push('message changed');
  }
  if (typeof patch.active === 'boolean') {
    next.active = patch.active;
    changes.push(`active=${patch.active}`);
  }
  if (patch.condition !== undefined) {
    try {
      next.condition = JSON.stringify(validateCondition(patch.condition));
    } catch (e) {
      throw new HttpError(400, e.message);
    }
    changes.push('condition changed');
  }
  if (!changes.length) throw new HttpError(400, 'Nothing to update');
  await db.query('UPDATE policy_rules SET reject_msg = $1, active = $2, condition = $3 WHERE rule_id = $4', [
    next.rejectMsg, next.active, next.condition, ruleId,
  ]);
  await log(db, { adjusterId: adjuster.adjusterId, actor: adjuster.name, action: `Rule ${rule.clauseCode} (policy ${rule.policyId}) updated: ${changes.join(', ')}`, now });
  return (await listRules(db)).find((r) => r.ruleId === ruleId);
}

async function listAudit(db, limit = 100) {
  const rows = await db.query('SELECT * FROM audit_logs ORDER BY log_id DESC');
  return rows.slice(0, limit);
}

// ---------------------------------------------------------------- reports (auditor)
async function summaryReport(db) {
  const claims = await db.query('SELECT * FROM claims');
  const appeals = await db.query('SELECT * FROM appeals');
  const reasons = await db.query('SELECT claim_id, rule_code FROM rejection_reasons');
  const audit = await db.query('SELECT action FROM audit_logs');
  const policies = new Map((await listPolicies(db)).map((p) => [p.policyId, p]));

  const byStatus = {};
  for (const s of Object.values(STATUS)) byStatus[s] = 0;
  for (const c of claims) byStatus[c.status] += 1;

  const autoRejected = new Set(reasons.filter((r) => r.ruleCode !== 'MANUAL').map((r) => r.claimId));
  const clauseCounts = {};
  for (const r of reasons) if (r.ruleCode !== 'MANUAL') clauseCounts[r.ruleCode] = (clauseCounts[r.ruleCode] || 0) + 1;

  const byProduct = {};
  for (const c of claims) {
    const pol = policies.get(c.policyId);
    const entry = (byProduct[pol.productType] = byProduct[pol.productType] || { code: pol.productType, name: pol.productName, claims: 0, rejected: 0 });
    entry.claims += 1;
    if (autoRejected.has(c.claimId)) entry.rejected += 1;
  }

  const resolved = appeals.filter((a) => a.resolvedOn);
  const approved = appeals.filter((a) => a.status === 'APPROVED').length;
  const denied = appeals.filter((a) => a.status === 'DENIED').length;
  const avgDays = resolved.length ? resolved.reduce((s, a) => s + daysBetween(a.filedOn, a.resolvedOn), 0) / resolved.length : null;
  const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);

  return {
    totalClaims: claims.length,
    byStatus,
    byProduct: Object.values(byProduct).sort((a, b) => b.claims - a.claims),
    autoRejected: autoRejected.size,
    rejectionRate: pct(autoRejected.size, claims.length),
    totalAmountClaimed: claims.reduce((s, c) => s + c.amount, 0),
    appeals: {
      total: appeals.length,
      open: appeals.filter((a) => ['FILED', 'UNDER_REVIEW'].includes(a.status)).length,
      approved,
      denied,
      approvalRate: pct(approved, approved + denied),
      avgResolutionDays: avgDays === null ? null : Math.round(avgDays * 10) / 10,
    },
    overrides: audit.filter((a) => a.action.startsWith('Override')).length,
    topRejectionClauses: Object.entries(clauseCounts)
      .map(([clauseCode, count]) => ({ clauseCode, count }))
      .sort((a, b) => b.count - a.count),
  };
}

async function claimsCsv(db) {
  const claims = await listClaims(db);
  const reasons = await db.query('SELECT claim_id, rule_code FROM rejection_reasons ORDER BY reason_id');
  const clauses = new Map();
  for (const r of reasons) clauses.set(r.claimId, [...(clauses.get(r.claimId) || []), r.ruleCode]);
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = ['claimId', 'claimant', 'policyNo', 'type', 'amount', 'status', 'submittedOn', 'decidedOn', 'rejectionClauses', 'appealStatus'];
  const lines = claims.map((c) =>
    [c.claimId, c.claimantName, c.policyNo, c.productName, c.amount, c.status, c.submittedOn, c.decidedOn, (clauses.get(c.claimId) || []).join(' '), c.appealStatus].map(esc).join(',')
  );
  return [header.join(','), ...lines].join('\n');
}

module.exports = {
  STATUS, TRANSITIONS, HttpError,
  submitClaim, getClaimDetail, listClaims, listPolicies, listProductTypes,
  overrideClaim, completePayout,
  fileAppeal, listAppeals, startAppealReview, decideAppeal, closeExpired,
  listRules, updateRule, listAudit, summaryReport, claimsCsv,
};
