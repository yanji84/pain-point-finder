import { Router } from 'express';
import crypto from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import {
  getIdeas, getIdea, updateIdea, dismissIdea,
  getIdeaCycles, getIdeaCycle,
  createScan, getScan,
} from '../db.mjs';
import { startScan } from '../scanner.mjs';
import { apiError, ErrorCodes } from '../middleware/errors.mjs';
import { requireScope } from '../auth.mjs';

export function createIdeasRouter(db, dataDir) {
  const router = Router();

  // GET /cycles — List idea cycles
  router.get('/cycles', requireScope('ideas:read'), (req, res) => {
    try {
      const cycles = getIdeaCycles(db);
      res.json({ cycles });
    } catch (err) {
      console.error('GET /ideas/cycles error:', err);
      apiError(res, 500, ErrorCodes.INTERNAL_ERROR, 'Internal server error', req.requestId);
    }
  });

  // GET /cycles/:id — Get cycle details with its ideas
  router.get('/cycles/:id', requireScope('ideas:read'), (req, res) => {
    try {
      const cycle = getIdeaCycle(db, req.params.id);
      if (!cycle) return apiError(res, 404, ErrorCodes.CYCLE_NOT_FOUND, 'Cycle not found', req.requestId);

      const ideas = getIdeas(db, { cycleId: cycle.id });
      res.json({ cycle, ideas });
    } catch (err) {
      console.error('GET /ideas/cycles/:id error:', err);
      apiError(res, 500, ErrorCodes.INTERNAL_ERROR, 'Internal server error', req.requestId);
    }
  });

  // GET / — List ideas
  router.get('/', requireScope('ideas:read'), (req, res) => {
    try {
      const { cycle_id, status, limit = 50 } = req.query;
      const ideas = getIdeas(db, {
        cycleId: cycle_id,
        status,
        limit: Number(limit),
      });
      res.json({ ideas });
    } catch (err) {
      console.error('GET /ideas error:', err);
      apiError(res, 500, ErrorCodes.INTERNAL_ERROR, 'Internal server error', req.requestId);
    }
  });

  // GET /:id — Get single idea
  router.get('/:id', requireScope('ideas:read'), (req, res) => {
    try {
      const idea = getIdea(db, req.params.id);
      if (!idea) return apiError(res, 404, ErrorCodes.IDEA_NOT_FOUND, 'Idea not found', req.requestId);
      res.json(idea);
    } catch (err) {
      console.error('GET /ideas/:id error:', err);
      apiError(res, 500, ErrorCodes.INTERNAL_ERROR, 'Internal server error', req.requestId);
    }
  });

  // POST /:id/dismiss — Dismiss an idea
  router.post('/:id/dismiss', requireScope('ideas:write'), (req, res) => {
    try {
      const idea = getIdea(db, req.params.id);
      if (!idea) return apiError(res, 404, ErrorCodes.IDEA_NOT_FOUND, 'Idea not found', req.requestId);

      dismissIdea(db, idea.id);
      res.json({ ok: true, id: idea.id, status: 'dismissed' });
    } catch (err) {
      console.error('POST /ideas/:id/dismiss error:', err);
      apiError(res, 500, ErrorCodes.INTERNAL_ERROR, 'Internal server error', req.requestId);
    }
  });

  // POST /:id/scan — Trigger a full GapScout scan for this idea
  router.post('/:id/scan', requireScope('ideas:write'), (req, res) => {
    try {
      const idea = getIdea(db, req.params.id);
      if (!idea) return apiError(res, 404, ErrorCodes.IDEA_NOT_FOUND, 'Idea not found', req.requestId);

      if (!idea.market_for_scan) {
        return apiError(res, 400, ErrorCodes.INVALID_INPUT, 'Idea has no market_for_scan defined', req.requestId);
      }

      const scanId = crypto.randomUUID();
      const scanDir = join(dataDir, 'scans', scanId);
      mkdirSync(scanDir, { recursive: true });

      createScan(db, {
        id: scanId,
        name: idea.title,
        domain: idea.market_for_scan,
        mode: 'full',
        sources: null,
        config: null,
        scanDir,
        createdBy: req.user.id,
      });

      updateIdea(db, idea.id, { status: 'scanning', scan_id: scanId });

      // Build idea context for the orchestrator
      const signals = idea.signals_json ? JSON.parse(idea.signals_json) : {};
      const ideaContext = {
        problem: idea.problem_statement || '',
        targetUser: signals.targetUser || signals.target_user || '',
        demandEvidence: signals.demandEvidence || signals.demand_evidence || '',
        competitiveGap: idea.competitive_landscape || '',
        narrowestWedge: idea.narrowest_wedge || '',
      };

      startScan(db, { id: scanId, domain: idea.market_for_scan, scanDir, mode: 'full' }, { ideaContext });

      res.json({ ok: true, ideaId: idea.id, scanId, status: 'scanning' });
    } catch (err) {
      console.error('POST /ideas/:id/scan error:', err);
      apiError(res, 500, ErrorCodes.INTERNAL_ERROR, 'Internal server error', req.requestId);
    }
  });

  return router;
}
