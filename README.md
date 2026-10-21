# Explainable Insurance Claim Rejection & Appeal Recommender System

CSE3132 Software Engineering Lab project. It works for **any line of insurance**: a claim is evaluated against
explicit policy clauses; if it is rejected, the claimant sees **which clause failed**, **what would change the
outcome** (a counterfactual), and can **file an appeal** that an adjuster reviews. Every decision is audited.

Health, motor, home and travel are set up out of the box. Each category is just data (its own claim-form
questions, accepted documents and policy rules) on top of one domain-neutral rule engine, so adding another
line of business needs no change to the engine or the screens.

| Role | What they can do |
|---|---|
| Claimant | Pick a policy, submit a claim (the form adapts to the policy's insurance type), see rejection reasons + counterfactuals, file and track an appeal |
| Claims adjuster | Review claims/appeals, override a decision (justification required), complete payouts, edit rules |
| Auditor | Read-only compliance dashboard (including a split by insurance type), audit log, CSV export |
| Rule engine (system) | Evaluates every claim automatically against the policy's rules |

## Run it

Requires Node.js 20+ (built and tested on 22).

```bash
npm run setup      # install backend + frontend dependencies
npm run build      # build the React UI
npm start          # API + UI on http://localhost:4000
```

With no `DATABASE_URL` the app uses an in-memory PostgreSQL emulator seeded with demo data, so it runs with
zero setup (data resets on restart). To use real PostgreSQL:

```bash
docker compose up --build        # PostgreSQL 16 + the app on http://localhost:4000
# or point any Postgres at the app:
DATABASE_URL=postgres://user:pass@localhost:5432/claims npm start
```

Development with hot reload: `npm run dev:api` in one terminal, `npm run dev:ui` in another (UI on :5173).

### Demo accounts (password `password123`)

| Email | Role | Policies |
|---|---|---|
| rohan@example.com | Claimant | Health HLTH-2026-00456 (sum insured 5,00,000), Motor MOT-2026-01123 (4,00,000) |
| anita@example.com | Claimant | Health HLTH-2026-00789 (3,00,000), Home HOME-2026-00311 (20,00,000), Travel TRV-2026-00077 (5,00,000) |
| priya@insurer.com | Claims adjuster | - |
| meera@insurer.com | Auditor | - |

Demo data has five claims across health, motor and home (approved, rejected, and one with an appeal filed);
set `SEED_DEMO=0` for an empty database.

## Insurance categories

| Category | Date label | Questions on the claim form | Example clauses |
|---|---|---|---|
| Health | Date of treatment | hospital, procedure, pre-existing condition? | network hospital, discharge summary, 2-year waiting period for pre-existing conditions, excluded procedures |
| Motor | Date of accident | repair garage, cause of damage, valid licence?, under influence? | authorised garage, valid driving licence, not under influence, FIR required for theft |
| Home | Date of loss | cause of loss, unoccupied > 30 days? | excluded cause (wear and tear), property occupied, photographs, police report for burglary |
| Travel | Date of incident | destination, reason for claim | voluntary change of plans excluded, tickets, medical report for medical claims |

Every category also gets: policy period check, sum-insured limit and a filing deadline.

## How the decision works

Rules live in the `policy_rules` table as data (`condition` is JSON), so a clause can be edited or switched off
without redeploying. A claim is approved only if **every applicable, active rule passes**. For each failed rule
the engine stores a rejection reason and a counterfactual. The eight rule types know nothing about hospitals or
vehicles - they point at claim fields by key:

| Rule type | Passes when | Counterfactual example |
|---|---|---|
| `POLICY_ACTIVE` | the incident date is inside the policy period | "...if the policy had been active on the incident date" |
| `MAX_AMOUNT` | amount <= sum insured (or an explicit `limit`) | "Reduce the claimed amount by Rs. X to Rs. Y or less" |
| `FIELD_IN_LIST` | a claim field is one of an approved list | "...if the repair garage had been an authorised garage, e.g. AutoCare Motors" |
| `FIELD_NOT_IN_LIST` | a claim field is not on an exclusion list | "'Wear and tear' is excluded from cover... attach evidence to an appeal" |
| `FIELD_FLAG` | a yes/no field has the required value | "...only if the driver held a valid driving licence" |
| `REQUIRED_DOCUMENT` | the document is attached | "Submit the missing repair estimate" |
| `FILING_DEADLINE` | filed within N days of the incident | "...if filed N day(s) earlier" |
| `WAITING_PERIOD` | N days have passed since the policy start | "...for an incident on or after <date>" |

Any rule can carry `"appliesWhen": {"field": "cause", "equals": "Theft"}` so it is only checked for that kind
of claim (this is how "an FIR is required for theft" works).

Claim life cycle (matches the state transition diagram; illegal changes are refused with HTTP 409):

```
SUBMITTED -> UNDER_REVIEW -> APPROVED -> CLOSED (payout done)
                          \-> REJECTED -> APPEAL_FILED -> UNDER_APPEAL_REVIEW -> APPROVED (upheld)
                                       \-> CLOSED (no appeal in 30 days)         \-> CLOSED (denied)
```
An adjuster override can also flip APPROVED <-> REJECTED (justification mandatory, always audited).
The appeal window is `APPEAL_WINDOW_DAYS` (default 30).

## Adding a new line of business (e.g. pet or cyber insurance)

Add one object to `backend/src/products.js` - or insert the same data into `product_types` and `policy_rules`:

```js
{
  code: 'PET',
  name: 'Pet insurance',
  incidentLabel: 'Date of illness',
  fields: [
    { key: 'vet', label: 'Veterinary clinic', type: 'text', required: true },
    { key: 'vaccinated', label: 'Pet was fully vaccinated', type: 'boolean', default: true },
  ],
  documents: { vet_bill: 'veterinary bill' },
  rules: [
    ['P-1.1', { type: 'POLICY_ACTIVE' }, 'Illness date is outside the policy period'],
    ['P-2.1', { type: 'MAX_AMOUNT' }, 'Claim amount exceeds the sum insured'],
    ['P-3.1', { type: 'FIELD_FLAG', field: 'vaccinated', mustBe: true, requirement: 'the pet was fully vaccinated' }, 'Pet was not fully vaccinated'],
    ['P-4.1', { type: 'REQUIRED_DOCUMENT', document: 'vet_bill', label: 'veterinary bill' }, 'Veterinary bill is required'],
  ],
}
```
then create a policy with `product_type = 'PET'`. The claim form, the explanation screens, the rules page and the
auditor dashboard pick it up automatically.

## Project layout

```
backend/   Express API  - src/ruleEngine.js (generic rules + counterfactuals), src/products.js (insurance categories),
           src/claimService.js (workflow), src/app.js (routes + role checks), src/schema.sql, src/seed.js, test/
frontend/  React + Vite - claimant, adjuster and auditor screens, test/ui-smoke.mjs
e2e/       Selenium end-to-end tests (Chrome)
Dockerfile, docker-compose.yml, .github/workflows/ci.yml
```

## API (all under `/api`, JWT bearer token except login)

| Method & path | Who | Purpose |
|---|---|---|
| `POST /auth/login` | anyone | get a token |
| `GET /policies`, `GET /product-types`, `GET /meta` | any | policies (own, for claimants), insurance categories with their form fields and documents |
| `POST /claims` | claimant | submit + evaluate a claim: `{policyId, amount, incidentDate, documents[], ...category fields}` |
| `GET /claims`, `GET /claims/:id` | any (claimants see only their own) | list / detail (staff also get the audit trail) |
| `POST /claims/:id/appeal` | claimant | file an appeal inside the window |
| `POST /claims/:id/override`, `/payout`, `POST /claims/expire-check` | adjuster | override, complete payout, close expired rejections |
| `GET /appeals`, `POST /appeals/:id/start-review`, `/decision` | adjuster (list: + auditor) | appeal queue and decisions |
| `GET /rules`, `PUT /rules/:id` | adjuster edits, auditor reads | policy rules |
| `GET /audit`, `GET /reports/summary`, `GET /reports/claims.csv` | adjuster, auditor | audit log, KPIs (incl. by insurance type), CSV |

## Tests

| Command | What it checks |
|---|---|
| `npm --prefix backend test` | 40 tests: every rule type and boundary, a clean rule set for each insurance category, the claim/appeal workflow and state rules for health, motor, home and travel, validation against each category's form definition, audit entries, reports, and the HTTP API including role-based access |
| `npm test` | the above + frontend build + an 18-step UI test that logs in as each role and drives the real screens, including a motor claim |
| `npm run test:e2e` | the Selenium suite below (needs Chrome and a running app) |

Selenium test cases (`e2e/e2e.test.mjs`) - start the app with `SEED_DEMO=0 npm start` first:

| ID | Scenario | Expected |
|---|---|---|
| TC-01 | Login with a wrong password | Error message shown, stays on login |
| TC-02 | Claimant submits a non-network health claim missing the discharge summary | Rejected, 2 reasons, each with a counterfactual; no staff sections visible |
| TC-03 | Claimant files an appeal | Appeal status "Filed", claim "Appeal filed", form disappears |
| TC-04 | Adjuster starts review and upholds the appeal | Claim "Approved", >= 5 audit rows |
| TC-05 | Adjuster completes payout | Claim "Closed" |
| TC-06 | Boundary: amount = sum insured vs. one rupee more | Approved vs. Rejected with "Reduce the claimed amount" |
| TC-07 | Adjuster overrides a rejection with a justification | Claim "Approved", override in audit trail |
| TC-08 | Claimant switches to the motor policy and files a claim with an unauthorised garage and no licence | Form swaps to motor questions; Rejected with 3 motor reasons |
| TC-09 | Auditor opens dashboard and rules | 4 claims, split by Health / Motor; rules cannot be edited |

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 4000 | HTTP port |
| `DATABASE_URL` | (unset) | PostgreSQL connection string; unset = in-memory database |
| `JWT_SECRET` | `dev-secret-change-me` | **change before any real use** |
| `APPEAL_WINDOW_DAYS` | 30 | days after a rejection in which an appeal can be filed |
| `SEED_DEMO` | on | set to `0` to skip demo claims |

## Differences from the design documents

- `product_types` (insurance categories) and `policies.product_type / insured_item` were added so the system is not tied to one line of business.
- `claims.details` (JSON text) holds the category-specific inputs the rules need (incident date, the category's own answers, documents).
- `rejection_reasons.counterfactual`, `policy_rules.active`, `claims.decided_on`, `appeals.notes/resolved_on` and a `users` table (logins) were added.
- Claim statuses follow the state transition diagram (`APPEAL_FILED`, `UNDER_APPEAL_REVIEW` included); appeal status adds `UNDER_REVIEW`.
- Dates and timestamps are stored as ISO-8601 text so the same schema runs on PostgreSQL and the in-memory engine.

## Known limitations

- Documents are *declared* (checkboxes), not uploaded; there is no file storage.
- There is no screen for creating a new insurance category; it is added as data (see above).
- Notifications (email/SMS) are out of scope; status changes are visible in the UI and audit log.
- Multi-step updates are not wrapped in database transactions.
- Demo passwords and the default JWT secret are for local use only.
