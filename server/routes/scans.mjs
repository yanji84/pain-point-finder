import { Router } from 'express';
import crypto from 'node:crypto';
import { join } from 'node:path';
import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { createScan, getScan, listScans, updateScan, getUserWebhookConfig } from '../db.mjs';
import { startScan, cancelScan, checkProgress, getScanLogs } from '../scanner.mjs';
import { apiError, ErrorCodes } from '../middleware/errors.mjs';
import { validateCallbackUrl } from '../webhooks.mjs';
import { requireScope } from '../auth.mjs';

export function createScansRouter(db, dataDir) {
  const router = Router();

  // POST / — Create and start a scan
  router.post('/', requireScope('scans:write'), async (req, res) => {
    try {
      const { name, domain, sources, timeout, mode, callback_url } = req.body;
      const id = crypto.randomUUID();
      const scanDir = join(dataDir, 'scans', id);

      // Validate callback_url if provided
      if (callback_url && !validateCallbackUrl(callback_url)) {
        return apiError(res, 400, ErrorCodes.INVALID_INPUT, 'Invalid callback_url. Must be https:// (or http://localhost in dev).', req.requestId);
      }

      // Determine effective callback URL: explicit > user default
      const effectiveCallbackUrl = callback_url || getUserWebhookConfig(db, req.user.id)?.webhook_url || null;

      mkdirSync(scanDir, { recursive: true });

      await createScan(db, {
        id,
        name: name || domain,
        domain,
        sources: sources || 'all',
        mode: mode || 'full',
        scanDir,
        createdBy: req.user.id,
      });

      // Store callback_url on the scan record
      if (effectiveCallbackUrl) {
        db.prepare('UPDATE scans SET callback_url = ? WHERE id = ?').run(effectiveCallbackUrl, id);
      }

      await startScan(db, { id, domain, sources, scanDir, timeout, mode: mode || 'full' });

      res.status(201).json({ id, status: 'queued' });
    } catch (err) {
      console.error('POST /scans error:', err);
      apiError(res, 500, ErrorCodes.INTERNAL_ERROR, 'Internal server error', req.requestId);
    }
  });

  // GET / — List scans
  router.get('/', requireScope('scans:read'), async (req, res) => {
    try {
      const { status, limit = 20, offset = 0 } = req.query;
      const { scans, total } = await listScans(db, {
        status,
        limit: Number(limit),
        offset: Number(offset),
      });

      const enriched = scans.map((scan) => {
        if (scan.status === 'running') {
          try {
            const progress = checkProgress(scan.scan_dir);
            return { ...scan, progress };
          } catch {
            return scan;
          }
        }
        return scan;
      });

      res.json({ scans: enriched, total });
    } catch (err) {
      console.error('GET /scans error:', err);
      apiError(res, 500, ErrorCodes.INTERNAL_ERROR, 'Internal server error', req.requestId);
    }
  });

  // GET /:id — Get scan detail with live progress
  router.get('/:id', requireScope('scans:read'), async (req, res) => {
    try {
      const scan = await getScan(db, req.params.id);
      if (!scan) {
        return apiError(res, 404, ErrorCodes.SCAN_NOT_FOUND, 'Scan not found', req.requestId);
      }

      const result = { ...scan };
      if (scan.status === 'running') {
        try {
          const progress = checkProgress(scan.scan_dir);
          Object.assign(result, { progress });

          // Retry-After headers for bots polling a running scan
          const pct = progress.pct || 0;
          const retryAfter = pct < 50 ? 120 : 30;
          res.setHeader('Retry-After', String(retryAfter));
          // Rough estimate: assume started_at is known, extrapolate from progress
          if (scan.started_at && pct > 0) {
            const elapsed = Date.now() - new Date(scan.started_at).getTime();
            const totalEstimate = elapsed / (pct / 100);
            const eta = new Date(new Date(scan.started_at).getTime() + totalEstimate);
            res.setHeader('X-Estimated-Completion', eta.toISOString());
          }
        } catch {
          // progress unavailable, return scan without it
        }
      }

      res.json(result);
    } catch (err) {
      console.error('GET /scans/:id error:', err);
      apiError(res, 500, ErrorCodes.INTERNAL_ERROR, 'Internal server error', req.requestId);
    }
  });

  // DELETE /:id — Cancel a scan
  router.delete('/:id', requireScope('scans:write'), async (req, res) => {
    try {
      const scan = await getScan(db, req.params.id);
      if (!scan) {
        return apiError(res, 404, ErrorCodes.SCAN_NOT_FOUND, 'Scan not found', req.requestId);
      }

      await cancelScan(db, req.params.id);

      res.json({ status: 'cancelled' });
    } catch (err) {
      console.error('DELETE /scans/:id error:', err);
      apiError(res, 500, ErrorCodes.INTERNAL_ERROR, 'Internal server error', req.requestId);
    }
  });

  // GET /:id/logs — Get historical log lines for a scan
  router.get('/:id/logs', requireScope('scans:read'), (req, res) => {
    try {
      const scan = getScan(db, req.params.id);
      if (!scan) return apiError(res, 404, ErrorCodes.SCAN_NOT_FOUND, 'Scan not found', req.requestId);

      const fromCursor = parseInt(req.query.cursor) || 0;
      const logData = getScanLogs(req.params.id, fromCursor);
      res.json(logData);
    } catch (err) {
      apiError(res, 500, ErrorCodes.INTERNAL_ERROR, err.message, req.requestId);
    }
  });

  // GET /:id/events — SSE stream for live progress + log lines
  router.get('/:id/events', requireScope('scans:read'), (req, res) => {
    try {
      const scan = getScan(db, req.params.id);
      if (!scan) return apiError(res, 404, ErrorCodes.SCAN_NOT_FOUND, 'Scan not found', req.requestId);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('\n');

      let logCursor = 0;

      // Immediately flush existing logs on connect (don't wait for first interval tick)
      try {
        const initLogs = getScanLogs(req.params.id, 0);
        if (initLogs.lines.length > 0) {
          res.write(`event: logs\ndata: ${JSON.stringify({ lines: initLogs.lines, cursor: initLogs.cursor })}\n\n`);
          logCursor = initLogs.cursor;
        }
        // Also send initial progress
        if (scan.status === 'running' && scan.scan_dir) {
          const initProgress = checkProgress(scan.scan_dir);
          const progressData = { status: scan.status, pct: initProgress.pct, detail: initProgress.detail };
          if (initProgress.phases) progressData.phases = initProgress.phases;
          res.write(`event: progress\ndata: ${JSON.stringify(progressData)}\n\n`);
        }
      } catch {}

      const interval = setInterval(() => {
        try {
          const current = getScan(db, req.params.id);
          const status = current?.status || 'unknown';
          let pct = current?.progress_pct || 0;
          let detail = current?.progress_detail || '';
          let progress = null;

          if (status === 'running' && current?.scan_dir) {
            progress = checkProgress(current.scan_dir);
            pct = progress.pct;
            detail = progress.detail;
          }

          // Send progress event — include phases if available
          const progressData = { status, pct, detail };
          if (progress && progress.phases) {
            progressData.phases = progress.phases;
          }
          res.write(`event: progress\ndata: ${JSON.stringify(progressData)}\n\n`);

          // Send new log lines
          const logData = getScanLogs(req.params.id, logCursor);
          if (logData.lines.length > 0) {
            res.write(`event: logs\ndata: ${JSON.stringify({ lines: logData.lines, cursor: logData.cursor })}\n\n`);
            logCursor = logData.cursor;
          }

          if (['completed', 'failed', 'cancelled'].includes(status)) {
            // Send final logs flush
            const finalLogs = getScanLogs(req.params.id, logCursor);
            if (finalLogs.lines.length > 0) {
              res.write(`event: logs\ndata: ${JSON.stringify({ lines: finalLogs.lines, cursor: finalLogs.cursor })}\n\n`);
            }
            res.write(`event: done\ndata: ${JSON.stringify({ status })}\n\n`);
            clearInterval(interval);
            res.end();
          }
        } catch (err) {
          // ignore polling errors
        }
      }, 1000); // Poll every 1 second for more responsive updates

      req.on('close', () => {
        clearInterval(interval);
      });
    } catch (err) {
      apiError(res, 500, ErrorCodes.INTERNAL_ERROR, err.message, req.requestId);
    }
  });

  // GET /:id/artifacts — List scan output files
  router.get('/:id/artifacts', requireScope('scans:read'), async (req, res) => {
    try {
      const scan = await getScan(db, req.params.id);
      if (!scan) {
        return apiError(res, 404, ErrorCodes.SCAN_NOT_FOUND, 'Scan not found', req.requestId);
      }

      let entries;
      try {
        entries = readdirSync(scan.scan_dir);
      } catch {
        return res.json({ files: [] });
      }

      const files = entries.filter((f) => f.endsWith('.json'));
      res.json({ files });
    } catch (err) {
      console.error('GET /scans/:id/artifacts error:', err);
      apiError(res, 500, ErrorCodes.INTERNAL_ERROR, 'Internal server error', req.requestId);
    }
  });

  // GET /:id/artifacts/:filename — Download a specific artifact file
  router.get('/:id/artifacts/:filename', requireScope('scans:read'), async (req, res) => {
    try {
      const scan = await getScan(db, req.params.id);
      if (!scan) {
        return apiError(res, 404, ErrorCodes.SCAN_NOT_FOUND, 'Scan not found', req.requestId);
      }

      const { filename } = req.params;
      if (filename.includes('..') || filename.includes('/')) {
        return apiError(res, 400, ErrorCodes.INVALID_INPUT, 'Invalid filename', req.requestId);
      }

      const filePath = join(scan.scan_dir, filename);
      let content;
      try {
        content = readFileSync(filePath, 'utf-8');
      } catch {
        return apiError(res, 404, ErrorCodes.FILE_NOT_FOUND, 'File not found', req.requestId);
      }

      res.set('Content-Type', 'application/json');
      res.send(content);
    } catch (err) {
      console.error('GET /scans/:id/artifacts/:filename error:', err);
      apiError(res, 500, ErrorCodes.INTERNAL_ERROR, 'Internal server error', req.requestId);
    }
  });

  return router;
}
