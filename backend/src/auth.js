'use strict';
const jwt = require('jsonwebtoken');
const { HttpError } = require('./claimService');

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

function signToken(user) {
  return jwt.sign(
    { userId: user.userId, name: user.name, role: user.role, claimantId: user.claimantId, adjusterId: user.adjusterId },
    SECRET,
    { expiresIn: '8h' }
  );
}

function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(new HttpError(401, 'Please log in'));
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch (e) {
    next(new HttpError(401, 'Session expired - please log in again'));
  }
}

const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : next(new HttpError(403, 'You do not have permission to do that'));

module.exports = { signToken, authenticate, requireRole };
