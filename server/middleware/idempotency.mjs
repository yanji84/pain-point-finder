import { apiError, ErrorCodes } from './errors.mjs';
import {
  getIdempotencyKey,
  createIdempotencyKey,
  completeIdempotencyKey,
} from '../db.mjs';

/**
 * Idempotency middleware for POST endpoints.
 *
 * When a client sends an `Idempotency-Key` header on a POST request:
 * 1. If the key was already used and the response is stored, replay it.
 * 2. If the key is currently in-flight, return 409.
 * 3. Otherwise mark the key as in-flight and capture the response.
 *
 * Only applies to POST requests with an authenticated user.
 */
export function idempotencyMiddleware(db) {
  return (req, res, next) => {
    const key = req.headers['idempotency-key'];
    if (!key || req.method !== 'POST') return next();

    const userId = req.user?.id;
    if (!userId) return next();

    const existing = getIdempotencyKey(db, key, userId);
    if (existing) {
      if (existing.in_flight) {
        return apiError(
          res,
          409,
          ErrorCodes.IDEMPOTENT_CONFLICT,
          'Request with this idempotency key is still being processed',
          req.requestId,
        );
      }
      // Replay stored response
      res.status(existing.response_status);
      res.setHeader('X-Idempotent-Replayed', 'true');
      return res.json(JSON.parse(existing.response_body));
    }

    // Mark in-flight
    createIdempotencyKey(db, { key, userId, endpoint: req.path });

    // Intercept res.json to capture the response
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      completeIdempotencyKey(db, key, userId, {
        responseStatus: res.statusCode,
        responseBody: JSON.stringify(body),
      });
      return originalJson(body);
    };

    next();
  };
}
