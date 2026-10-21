-- Schema for the Explainable Insurance Claim Rejection & Appeal Recommender System.
-- Dates are stored as ISO-8601 text (YYYY-MM-DD / full timestamp) so the same schema
-- runs on PostgreSQL and on the in-memory engine used for development and tests.

CREATE TABLE IF NOT EXISTS claimants (
  claimant_id SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  phone       TEXT
);

CREATE TABLE IF NOT EXISTS adjusters (
  adjuster_id SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  user_id       SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL,
  claimant_id   INT REFERENCES claimants (claimant_id),
  adjuster_id   INT REFERENCES adjusters (adjuster_id)
);

-- One row per insurance category (health, motor, home, travel, ...). The claim form fields and the
-- accepted documents are data, so a new line of business needs rows here, not code changes.
CREATE TABLE IF NOT EXISTS product_types (
  code           TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  incident_label TEXT NOT NULL,
  fields         TEXT NOT NULL,
  documents      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS policies (
  policy_id    SERIAL PRIMARY KEY,
  claimant_id  INT NOT NULL REFERENCES claimants (claimant_id),
  product_type TEXT NOT NULL REFERENCES product_types (code),
  insured_item TEXT,
  policy_no    TEXT UNIQUE NOT NULL,
  sum_insured  NUMERIC NOT NULL,
  start_date   TEXT NOT NULL,
  end_date     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS policy_rules (
  rule_id     SERIAL PRIMARY KEY,
  policy_id   INT NOT NULL REFERENCES policies (policy_id),
  clause_code TEXT NOT NULL,
  condition   TEXT NOT NULL,
  reject_msg  TEXT NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS claims (
  claim_id     SERIAL PRIMARY KEY,
  policy_id    INT NOT NULL REFERENCES policies (policy_id),
  claimant_id  INT NOT NULL REFERENCES claimants (claimant_id),
  adjuster_id  INT REFERENCES adjusters (adjuster_id),
  amount       NUMERIC NOT NULL,
  status       TEXT NOT NULL,
  submitted_on TEXT NOT NULL,
  decided_on   TEXT,
  details      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rejection_reasons (
  reason_id      SERIAL PRIMARY KEY,
  claim_id       INT NOT NULL REFERENCES claims (claim_id),
  rule_id        INT REFERENCES policy_rules (rule_id),
  rule_code      TEXT NOT NULL,
  description    TEXT NOT NULL,
  counterfactual TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS appeals (
  appeal_id   SERIAL PRIMARY KEY,
  claim_id    INT NOT NULL REFERENCES claims (claim_id),
  adjuster_id INT REFERENCES adjusters (adjuster_id),
  filed_on    TEXT NOT NULL,
  status      TEXT NOT NULL,
  notes       TEXT,
  resolution  TEXT,
  resolved_on TEXT
);

CREATE TABLE IF NOT EXISTS audit_logs (
  log_id      SERIAL PRIMARY KEY,
  claim_id    INT REFERENCES claims (claim_id),
  adjuster_id INT REFERENCES adjusters (adjuster_id),
  action      TEXT NOT NULL,
  actor       TEXT NOT NULL,
  logged_at   TEXT NOT NULL
);
