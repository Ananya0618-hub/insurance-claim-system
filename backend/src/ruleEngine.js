'use strict';
// Deterministic, domain-neutral policy rule engine. Every rule is a row in policy_rules whose
// `condition` column is JSON such as {"type":"MAX_AMOUNT"}. The engine knows nothing about
// hospitals, vehicles or houses: rules point at claim fields by key, so the same eight rule types
// serve every insurance category. A claim is approved only if every applicable, active rule passes.
// For each failed rule the engine also produces a counterfactual: what would need to change for
// that clause to pass.
//
// Any rule may carry  "appliesWhen": {"field": "cause", "equals": "Theft"}  - the rule is then only
// checked when that claim field has that value.

const MS_DAY = 86400000;

function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  if (!m) throw new Error(`Invalid date: ${s}`);
  return Date.UTC(+m[1], +m[2] - 1, +m[3]);
}
const daysBetween = (from, to) => Math.round((parseDate(to) - parseDate(from)) / MS_DAY);
const addDays = (s, n) => new Date(parseDate(s) + n * MS_DAY).toISOString().slice(0, 10);
const inr = (n) => '\u20b9' + Number(n).toLocaleString('en-IN');
const aOrAn = (s) => (/^[aeiou]/i.test(s) ? 'an ' : 'a ') + s;
const preview = (values, n = 3) => values.slice(0, n).join(', ') + (values.length > n ? ' and others' : '');
const fieldName = (cond) => cond.fieldLabel || cond.field;

const HANDLERS = {
  // The incident must fall inside the policy period.
  POLICY_ACTIVE({ claim, policy }) {
    const t = claim.details.incidentDate;
    const passed = t >= policy.startDate && t <= policy.endDate;
    if (passed) return { passed };
    return {
      passed,
      detail: `incident on ${t}, policy period ${policy.startDate} to ${policy.endDate}`,
      counterfactual: t < policy.startDate
        ? `This clause would pass if the incident had happened on or after the policy start date (${policy.startDate}).`
        : `This clause would pass if the policy had been active on the incident date (${t}); the policy ended on ${policy.endDate}.`,
    };
  },

  // Claim amount may not exceed the sum insured (or an explicit "limit").
  MAX_AMOUNT({ cond, claim, policy }) {
    const custom = cond.limit !== undefined;
    const limit = custom ? cond.limit : policy.sumInsured;
    const what = custom ? 'claim limit' : 'sum insured';
    const passed = claim.amount <= limit;
    if (passed) return { passed };
    return {
      passed,
      detail: `claimed ${inr(claim.amount)}, ${what} ${inr(limit)}`,
      counterfactual: `Reduce the claimed amount by ${inr(claim.amount - limit)} to ${inr(limit)} (the ${what}) or less and this clause would pass.`,
    };
  },

  // A claim field must be one of an approved list (network hospital, authorised garage, ...).
  FIELD_IN_LIST({ cond, claim }) {
    const raw = String(claim.details[cond.field] ?? '').trim();
    const passed = cond.values.some((v) => String(v).toLowerCase() === raw.toLowerCase());
    if (passed) return { passed };
    return {
      passed,
      detail: `${fieldName(cond)}: ${raw || 'not given'}`,
      counterfactual: `This clause would pass if the ${fieldName(cond)} had been ${aOrAn(cond.label || 'approved option')}, for example ${preview(cond.values)}.`,
    };
  },

  // A claim field must NOT be on an exclusion list (excluded procedure, excluded cause of loss, ...).
  FIELD_NOT_IN_LIST({ cond, claim }) {
    const raw = String(claim.details[cond.field] ?? '').trim();
    const passed = !cond.values.some((v) => String(v).toLowerCase() === raw.toLowerCase());
    if (passed) return { passed };
    return {
      passed,
      detail: `${fieldName(cond)}: ${raw}`,
      counterfactual: `"${raw}" is excluded from cover, so this clause only passes for a covered ${fieldName(cond)}. If the ${fieldName(cond)} was recorded incorrectly, or there were exceptional circumstances, attach evidence to an appeal.`,
    };
  },

  // A yes/no claim field must have a required value (valid licence, property occupied, ...).
  FIELD_FLAG({ cond, claim }) {
    const passed = Boolean(claim.details[cond.field]) === cond.mustBe;
    if (passed) return { passed };
    return {
      passed,
      detail: `requirement not met: ${cond.requirement}`,
      counterfactual: `This clause would pass only if ${cond.requirement}. If the claim form was filled in incorrectly, correct it in an appeal with supporting evidence.`,
    };
  },

  // A specific supporting document must be attached.
  REQUIRED_DOCUMENT({ cond, claim }) {
    const passed = (claim.details.documents || []).includes(cond.document);
    if (passed) return { passed };
    const label = cond.label || cond.document;
    return {
      passed,
      detail: `missing ${label}`,
      counterfactual: `Submit the missing ${label}. Once it is attached the claim can be re-evaluated and this clause would pass.`,
    };
  },

  // The claim must be filed within N days of the incident.
  FILING_DEADLINE({ cond, claim }) {
    const elapsed = daysBetween(claim.details.incidentDate, claim.submittedOn);
    const lateBy = elapsed - cond.days;
    const passed = lateBy <= 0;
    if (passed) return { passed };
    return {
      passed,
      detail: `filed ${elapsed} days after the incident, limit is ${cond.days} days`,
      counterfactual: `This clause would pass if the claim had been filed ${lateBy} day(s) earlier (within ${cond.days} days of the incident). If there was a documented reason for the delay, include it in an appeal.`,
    };
  },

  // Cover only starts N days after the policy start (use with appliesWhen for specific claim types).
  WAITING_PERIOD({ cond, claim, policy }) {
    const elapsed = daysBetween(policy.startDate, claim.details.incidentDate);
    const passed = elapsed >= cond.days;
    if (passed) return { passed };
    const eligibleFrom = addDays(policy.startDate, cond.days);
    return {
      passed,
      detail: `${cond.label || 'this claim'} arose ${elapsed} days after policy start, waiting period is ${cond.days} days`,
      counterfactual: `This clause would pass for an incident on or after ${eligibleFrom} (${cond.days - elapsed} day(s) later than this incident date).`,
    };
  },
};

function parseCondition(rule) {
  return typeof rule.condition === 'string' ? JSON.parse(rule.condition) : rule.condition;
}

function validateCondition(cond) {
  if (!cond || !HANDLERS[cond.type]) throw new Error(`Unknown rule type: ${cond && cond.type}`);
  const need = (ok, msg) => { if (!ok) throw new Error(msg); };
  switch (cond.type) {
    case 'FIELD_IN_LIST':
    case 'FIELD_NOT_IN_LIST':
      need(cond.field, 'field is required');
      need(Array.isArray(cond.values) && cond.values.length > 0, 'values must be a non-empty list');
      break;
    case 'FIELD_FLAG':
      need(cond.field, 'field is required');
      need(typeof cond.mustBe === 'boolean', 'mustBe must be true or false');
      need(cond.requirement, 'requirement text is required');
      break;
    case 'REQUIRED_DOCUMENT':
      need(cond.document, 'document is required');
      break;
    case 'FILING_DEADLINE':
    case 'WAITING_PERIOD':
      need(cond.days >= 0, 'days must be a number');
      break;
    case 'MAX_AMOUNT':
      need(cond.limit === undefined || cond.limit >= 0, 'limit must be a number');
      break;
    default:
  }
  if (cond.appliesWhen) need(cond.appliesWhen.field && 'equals' in cond.appliesWhen, 'appliesWhen needs field and equals');
  return cond;
}

const applies = (cond, claim) => !cond.appliesWhen || claim.details[cond.appliesWhen.field] === cond.appliesWhen.equals;

/**
 * claim:  { amount, submittedOn, details: { incidentDate, documents[], ...category fields } }
 * policy: { sumInsured, startDate, endDate }
 * rules:  rows from policy_rules ({ ruleId, clauseCode, condition, rejectMsg, active })
 */
function evaluateClaim({ claim, policy, rules }) {
  const results = rules
    .filter((r) => r.active !== false)
    .map((rule) => {
      const cond = validateCondition(parseCondition(rule));
      const base = { ruleId: rule.ruleId, clauseCode: rule.clauseCode, type: cond.type };
      if (!applies(cond, claim)) return { ...base, passed: true, applicable: false, description: null, counterfactual: null };
      const out = HANDLERS[cond.type]({ cond, claim, policy });
      return {
        ...base,
        applicable: true,
        passed: out.passed,
        description: out.passed ? null : `[${rule.clauseCode}] ${rule.rejectMsg}${out.detail ? ` (${out.detail})` : ''}`,
        counterfactual: out.passed ? null : out.counterfactual,
      };
    });
  const failures = results.filter((r) => !r.passed);
  return { approved: failures.length === 0, results, failures };
}

module.exports = { evaluateClaim, validateCondition, parseDate, daysBetween, addDays };
