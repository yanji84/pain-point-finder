import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { getSession, getApiKeyByHash, touchApiKeyLastUsed } from './db.mjs';
import { apiError, ErrorCodes } from './middleware/errors.mjs';

export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

export function generateSessionId() {
  return crypto.randomUUID();
}

export function authMiddleware(db) {
  return (req, res, next) => {
    // 1. Check for API key in Authorization header
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer gsk_')) {
      const token = authHeader.slice(7); // strip "Bearer "
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const result = getApiKeyByHash(db, tokenHash);

      if (!result) {
        return res.status(401).json({ error: 'Invalid API key' });
      }

      const { apiKey, user } = result;

      if (apiKey.revokedAt) {
        return res.status(401).json({ error: 'API key has been revoked' });
      }

      if (apiKey.expiresAt && new Date(apiKey.expiresAt) <= new Date()) {
        return res.status(401).json({ error: 'API key has expired' });
      }

      req.user = user;
      req.apiKey = {
        id: apiKey.id,
        name: apiKey.name,
        botIdentity: apiKey.botIdentity,
        scopes: apiKey.scopes,
      };
      req.authMethod = 'api_key';

      // Touch last_used_at, debounced (only if >60s old)
      const lastUsed = apiKey.lastUsedAt ? new Date(apiKey.lastUsedAt).getTime() : 0;
      if (Date.now() - lastUsed > 60_000) {
        try { touchApiKeyLastUsed(db, apiKey.id); } catch (_) { /* non-critical */ }
      }

      return next();
    }

    // 2. Fall back to cookie-based session auth
    const sid = req.cookies?.gapscout_sid;

    if (!sid) {
      return deny(req, res);
    }

    const result = getSession(db, sid);

    if (!result) {
      return deny(req, res);
    }

    const { session, user } = result;

    if (new Date(session.expires_at) <= new Date()) {
      return deny(req, res);
    }

    req.user = user;
    req.authMethod = 'cookie';
    next();
  };
}

export function requireScope(scope) {
  return (req, res, next) => {
    if (req.authMethod === 'cookie') return next(); // humans have full access
    if (!req.apiKey) return res.status(403).json({ error: 'API key required' });
    const scopes = req.apiKey.scopes.split(',').map(s => s.trim());
    if (scopes.includes('*') || scopes.includes(scope)) return next();
    return res.status(403).json({ error: `Missing scope: ${scope}` });
  };
}

function deny(req, res) {
  const acceptsHtml =
    req.headers.accept && req.headers.accept.includes('text/html');

  if (acceptsHtml) {
    const basePath = process.env.BASE_PATH || '';
    return res.redirect(basePath + '/login');
  }

  return apiError(res, 401, ErrorCodes.UNAUTHORIZED, 'Unauthorized', req.requestId);
}
