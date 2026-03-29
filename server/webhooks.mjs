/**
 * webhooks.mjs — Outbound webhook delivery system for GapScout.
 *
 * Fires HTTP POST callbacks when scans reach terminal states (completed, failed, cancelled).
 * Supports HMAC-SHA256 signing, exponential backoff retries, and a background retry loop.
 */

import crypto from 'node:crypto';
import {
  createWebhookDelivery,
  getWebhookDelivery,
  getPendingWebhooks,
  updateWebhookDelivery,
  getUserWebhookConfig,
} from './db.mjs';

/**
 * Sign a payload string with HMAC-SHA256.
 */
function signPayload(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Validate that a callback URL is acceptable.
 * In production, rejects private/internal IPs. In dev, allows localhost.
 */
function validateCallbackUrl(url) {
  if (!url || typeof url !== 'string') return false;

  try {
    const parsed = new URL(url);

    // Must be http or https
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

    const hostname = parsed.hostname;

    // Allow localhost in dev
    const isDev = process.env.NODE_ENV !== 'production';
    if (isDev && (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1')) {
      return true;
    }

    // In production, require https (except localhost for dev)
    if (!isDev && parsed.protocol !== 'https:') return false;

    // Block private IPs in production
    if (!isDev) {
      // Block common private ranges
      if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return false;
      if (hostname.startsWith('10.')) return false;
      if (hostname.startsWith('192.168.')) return false;
      if (hostname.startsWith('172.') && /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return false;
      if (hostname === '0.0.0.0' || hostname.startsWith('169.254.')) return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Build the webhook payload for a scan event.
 */
function buildScanPayload(scan, reportSummary) {
  return {
    event: scan.status === 'completed' ? 'scan.completed'
         : scan.status === 'failed' ? 'scan.failed'
         : 'scan.cancelled',
    scan_id: scan.id,
    status: scan.status,
    market: scan.domain,
    name: scan.name,
    completed_at: scan.completed_at,
    report_url: `/api/reports/${scan.id}`,
    summary: reportSummary || null,
  };
}

/**
 * Schedule an exponential backoff retry for a failed delivery.
 */
function scheduleRetry(db, delivery, error) {
  const attempts = delivery.attempts + 1;
  if (attempts >= delivery.max_attempts) {
    updateWebhookDelivery(db, delivery.id, {
      status: 'failed',
      attempts,
      error: error || 'Max attempts exceeded',
    });
    return;
  }

  // Backoff: 10s, 30s, 2m, 10m
  const delays = [10, 30, 120, 600];
  const delaySec = delays[Math.min(attempts - 1, delays.length - 1)];
  const nextRetry = new Date(Date.now() + delaySec * 1000).toISOString();

  updateWebhookDelivery(db, delivery.id, {
    status: 'retrying',
    attempts,
    next_retry_at: nextRetry,
    error: error || null,
  });
}

/**
 * Attempt to deliver a single webhook.
 */
async function attemptDelivery(db, deliveryId) {
  const delivery = getWebhookDelivery(db, deliveryId);
  if (!delivery) return;

  try {
    const event = (() => {
      try { return JSON.parse(delivery.payload).event; } catch { return 'scan.completed'; }
    })();

    const headers = {
      'Content-Type': 'application/json',
      'X-GapScout-Delivery-Id': delivery.id,
      'X-GapScout-Event': event,
      'User-Agent': 'GapScout-Webhook/1.0',
    };

    if (delivery.signature) {
      headers['X-GapScout-Signature'] = delivery.signature;
    }

    const resp = await fetch(delivery.callback_url, {
      method: 'POST',
      headers,
      body: delivery.payload,
      signal: AbortSignal.timeout(10000),
    });

    if (resp.ok) {
      updateWebhookDelivery(db, deliveryId, {
        status: 'delivered',
        status_code: resp.status,
        delivered_at: new Date().toISOString(),
        attempts: delivery.attempts + 1,
      });
    } else {
      scheduleRetry(db, delivery, `HTTP ${resp.status}`);
    }
  } catch (err) {
    scheduleRetry(db, delivery, err.message);
  }
}

/**
 * Fire a webhook for a scan that reached a terminal state.
 * Determines the callback URL from the scan or user config.
 */
export async function fireWebhook(db, scan, reportSummary) {
  // Determine callback URL: scan-level override > user default
  const callbackUrl = scan.callback_url || getUserWebhookConfig(db, scan.created_by)?.webhook_url;
  if (!callbackUrl) return; // No webhook configured

  if (!validateCallbackUrl(callbackUrl)) {
    console.warn(`[webhooks] Invalid callback URL for scan ${scan.id}: ${callbackUrl}`);
    return;
  }

  const payload = JSON.stringify(buildScanPayload(scan, reportSummary));
  const userConfig = getUserWebhookConfig(db, scan.created_by);
  const secret = userConfig?.webhook_secret || '';
  const signature = secret ? signPayload(payload, secret) : '';
  const deliveryId = crypto.randomUUID();

  createWebhookDelivery(db, {
    id: deliveryId,
    scanId: scan.id,
    callbackUrl,
    payload,
    signature,
  });

  // Attempt delivery immediately
  await attemptDelivery(db, deliveryId);
}

/**
 * Start the background retry loop. Call once on server startup.
 * Checks for pending/retrying deliveries every 15 seconds.
 */
export function startRetryLoop(db) {
  const interval = setInterval(async () => {
    try {
      const pending = getPendingWebhooks(db);
      for (const d of pending) {
        await attemptDelivery(db, d.id);
      }
    } catch (err) {
      console.error('[webhooks] Retry loop error:', err.message);
    }
  }, 15000);

  interval.unref(); // Don't prevent process exit
  return interval;
}

export { validateCallbackUrl };
