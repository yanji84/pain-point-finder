/**
 * Consistent API error envelope and error code constants.
 */

export const ErrorCodes = {
  SCAN_NOT_FOUND: 'SCAN_NOT_FOUND',
  IDEA_NOT_FOUND: 'IDEA_NOT_FOUND',
  CYCLE_NOT_FOUND: 'CYCLE_NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  INVALID_INPUT: 'INVALID_INPUT',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  SCAN_IN_PROGRESS: 'SCAN_IN_PROGRESS',
  REPORT_NOT_AVAILABLE: 'REPORT_NOT_AVAILABLE',
  IDEMPOTENT_CONFLICT: 'IDEMPOTENT_CONFLICT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  MESSAGE_REQUIRED: 'MESSAGE_REQUIRED',
};

/**
 * Send a structured JSON error response.
 *
 * @param {import('express').Response} res
 * @param {number} statusCode  HTTP status code
 * @param {string} code        Machine-readable error code from ErrorCodes
 * @param {string} message     Human-readable description
 * @param {string} requestId   The request ID for correlation
 */
export function apiError(res, statusCode, code, message, requestId) {
  return res.status(statusCode).json({
    error: { code, message, request_id: requestId },
  });
}
