import crypto from 'node:crypto';

/**
 * Attaches a unique request ID to every request.
 * If the client sends X-Request-Id, that value is reused for correlation.
 */
export function requestIdMiddleware() {
  return (req, res, next) => {
    req.requestId = req.headers['x-request-id'] || crypto.randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    next();
  };
}
