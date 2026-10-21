'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const service = require('./claimService');
const { signToken, authenticate, requireRole } = require('./auth');

const { HttpError } = service;
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const id = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Invalid id');
  return n;
};

function createApp(db, { clock = () => new Date() } = {}) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // ---------------------------------------------------------------- public
  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

  app.post('/api/auth/login', wrap(async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) throw new HttpError(400, 'Email and password are required');
    const user = await db.one('SELECT * FROM users WHERE email = $1', [String(email).toLowerCase()]);
    if (!user || !bcrypt.compareSync(String(password), user.passwordHash)) throw new HttpError(401, 'Incorrect email or password');
    res.json({ token: signToken(user), user: { name: user.name, email: user.email, role: user.role } });
  }));

  // ---------------------------------------------------------------- everything below needs a login
  app.use('/api', authenticate);

  app.get('/api/me', (req, res) => res.json({ name: req.user.name, role: req.user.role }));

  app.get('/api/meta', (req, res) => res.json({ appealWindowDays: Number(process.env.APPEAL_WINDOW_DAYS || 30) }));

  // Insurance categories with their claim-form fields and accepted documents.
  app.get('/api/product-types', wrap(async (req, res) => res.json(await service.listProductTypes(db))));

  app.get('/api/policies', wrap(async (req, res) => {
    const claimantId = req.user.role === 'claimant' ? req.user.claimantId : null;
    res.json(await service.listPolicies(db, { claimantId }));
  }));

  // ---------------------------------------------------------------- claims
  app.post('/api/claims', requireRole('claimant'), wrap(async (req, res) => {
    res.status(201).json(await service.submitClaim(db, req.user, req.body || {}, clock()));
  }));

  app.get('/api/claims', wrap(async (req, res) => {
    const claimantId = req.user.role === 'claimant' ? req.user.claimantId : null;
    res.json(await service.listClaims(db, { claimantId, status: req.query.status || null }));
  }));

  app.get('/api/claims/:id', wrap(async (req, res) => {
    const staff = req.user.role !== 'claimant';
    const detail = await service.getClaimDetail(db, id(req.params.id), { includeAudit: staff, now: clock() });
    if (!staff && detail.claimantId !== req.user.claimantId) throw new HttpError(404, 'Claim not found');
    res.json(detail);
  }));

  app.post('/api/claims/:id/override', requireRole('adjuster'), wrap(async (req, res) => {
    const { decision, justification } = req.body || {};
    res.json(await service.overrideClaim(db, req.user, id(req.params.id), decision, justification, clock()));
  }));

  app.post('/api/claims/:id/payout', requireRole('adjuster'), wrap(async (req, res) => {
    res.json(await service.completePayout(db, req.user, id(req.params.id), clock()));
  }));

  app.post('/api/claims/:id/appeal', requireRole('claimant'), wrap(async (req, res) => {
    res.status(201).json(await service.fileAppeal(db, req.user, id(req.params.id), req.body || {}, clock()));
  }));

  app.post('/api/claims/expire-check', requireRole('adjuster'), wrap(async (req, res) => {
    res.json({ closed: await service.closeExpired(db, clock()) });
  }));

  // ---------------------------------------------------------------- appeals
  app.get('/api/appeals', requireRole('adjuster', 'auditor'), wrap(async (req, res) => {
    res.json(await service.listAppeals(db, { status: req.query.status || null }));
  }));

  app.post('/api/appeals/:id/start-review', requireRole('adjuster'), wrap(async (req, res) => {
    res.json(await service.startAppealReview(db, req.user, id(req.params.id), clock()));
  }));

  app.post('/api/appeals/:id/decision', requireRole('adjuster'), wrap(async (req, res) => {
    const { decision, justification } = req.body || {};
    res.json(await service.decideAppeal(db, req.user, id(req.params.id), decision, justification, clock()));
  }));

  // ---------------------------------------------------------------- rules
  app.get('/api/rules', requireRole('adjuster', 'auditor'), wrap(async (req, res) => res.json(await service.listRules(db))));

  app.put('/api/rules/:id', requireRole('adjuster'), wrap(async (req, res) => {
    res.json(await service.updateRule(db, req.user, id(req.params.id), req.body || {}, clock()));
  }));

  // ---------------------------------------------------------------- audit + reports
  app.get('/api/audit', requireRole('adjuster', 'auditor'), wrap(async (req, res) => {
    res.json(await service.listAudit(db, Math.min(Number(req.query.limit) || 100, 500)));
  }));

  app.get('/api/reports/summary', requireRole('adjuster', 'auditor'), wrap(async (req, res) => res.json(await service.summaryReport(db))));

  app.get('/api/reports/claims.csv', requireRole('auditor', 'adjuster'), wrap(async (req, res) => {
    res.type('text/csv').set('Content-Disposition', 'attachment; filename="claims.csv"').send(await service.claimsCsv(db));
  }));

  app.use('/api', (req, res, next) => next(new HttpError(404, 'Not found')));

  // ---------------------------------------------------------------- built frontend (production)
  const dist = path.join(__dirname, '..', '..', 'frontend', 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: status === 500 ? 'Something went wrong' : err.message });
  });

  return app;
}

module.exports = { createApp };
