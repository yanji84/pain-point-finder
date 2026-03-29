import { Router } from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getScan } from '../db.mjs';
import { apiError, ErrorCodes } from '../middleware/errors.mjs';
import { requireScope } from '../auth.mjs';

function renderErrorPage(title, message, scanName, basePath) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — GapScout</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0a; color: #fafafa; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #111; border: 1px solid #222; border-radius: 12px; padding: 48px; max-width: 480px; text-align: center; }
  h1 { font-size: 20px; margin-bottom: 12px; font-weight: 700; }
  p { color: #888; font-size: 14px; line-height: 1.6; margin-bottom: 24px; }
  .scan-name { color: #3b82f6; }
  a { display: inline-block; padding: 8px 20px; background: #3b82f6; color: #fff; border-radius: 8px; text-decoration: none; font-size: 13px; font-weight: 500; }
  a:hover { background: #2563eb; }
</style></head><body><div class="card">
  <h1>${title}</h1>
  <p>${message}</p>
  <a href="${basePath || ''}/">Back to Dashboard</a>
</div></body></html>`;
}

export function createReportsRouter(db, dataDir) {
  const router = Router();
  const basePath = process.env.BASE_PATH || '';

  // GET /:id — Get report JSON for a scan
  router.get('/:id', requireScope('reports:read'), async (req, res) => {
    try {
      const scan = await getScan(db, req.params.id);
      if (!scan) {
        return apiError(res, 404, ErrorCodes.SCAN_NOT_FOUND, 'Scan not found', req.requestId);
      }

      if (!scan.scan_dir || !existsSync(scan.scan_dir)) {
        return apiError(res, 404, ErrorCodes.REPORT_NOT_AVAILABLE, 'Report not yet available', req.requestId);
      }

      const reportPath = join(scan.scan_dir, 'report.json');
      if (!existsSync(reportPath)) {
        return apiError(res, 404, ErrorCodes.REPORT_NOT_AVAILABLE, 'Report not yet available', req.requestId);
      }

      const raw = readFileSync(reportPath, 'utf-8');
      const report = JSON.parse(raw);
      res.json(report);
    } catch (err) {
      console.error('GET /reports/:id error:', err);
      apiError(res, 500, ErrorCodes.INTERNAL_ERROR, 'Internal server error', req.requestId);
    }
  });

  // GET /:id/html — Get report as HTML
  router.get('/:id/html', requireScope('reports:read'), async (req, res) => {
    try {
      const scan = await getScan(db, req.params.id);
      if (!scan) {
        return res.status(404).type('html').send(renderErrorPage(
          'Scan Not Found',
          'This scan does not exist or has been deleted.',
          null, basePath
        ));
      }

      if (!scan.scan_dir || !existsSync(scan.scan_dir)) {
        return res.status(404).type('html').send(renderErrorPage(
          'Report Not Available',
          `The scan <span class="scan-name">${scan.name || scan.domain}</span> completed but no report data was generated. The scan directory may be missing.`,
          scan.name, basePath
        ));
      }

      const htmlPath = join(scan.scan_dir, 'report.html');
      if (existsSync(htmlPath)) {
        const html = readFileSync(htmlPath, 'utf-8');
        res.set('Content-Type', 'text/html');
        return res.send(html);
      }

      const jsonPath = join(scan.scan_dir, 'report.json');
      if (existsSync(jsonPath)) {
        const raw = readFileSync(jsonPath, 'utf-8');
        const reportData = JSON.parse(raw);
        const data = reportData.data || reportData;

        // Check if report has the grouped format needed for HTML generation
        if (!data.groups || !data.groups.length) {
          return res.status(422).type('html').send(renderErrorPage(
            'Insufficient Data',
            `The scan <span class="scan-name">${scan.name || scan.domain}</span> completed but did not collect enough data to generate a visual report. This can happen when sources return no results or encounter errors. Try running the scan again.`,
            scan.name, basePath
          ));
        }

        try {
          const { generateHtml } = await import('../../scripts/web-report.mjs');
          const html = generateHtml(reportData);
          res.set('Content-Type', 'text/html');
          return res.send(html);
        } catch (htmlErr) {
          console.error('HTML generation error:', htmlErr.message);
          return res.status(500).type('html').send(renderErrorPage(
            'Report Generation Failed',
            `An error occurred while generating the HTML report for <span class="scan-name">${scan.name || scan.domain}</span>. The raw JSON data may still be available via the API.`,
            scan.name, basePath
          ));
        }
      }

      return res.status(404).type('html').send(renderErrorPage(
        'Report Not Available',
        `The scan <span class="scan-name">${scan.name || scan.domain}</span> completed but no report was generated. This may indicate the scan process failed silently. Try running the scan again.`,
        scan.name, basePath
      ));
    } catch (err) {
      console.error('GET /reports/:id/html error:', err);
      res.status(500).type('html').send(renderErrorPage(
        'Internal Error',
        'Something went wrong while loading this report. Please try again.',
        null, basePath
      ));
    }
  });

  // GET /:id/summary — Compact flattened summary of the report
  router.get('/:id/summary', requireScope('reports:read'), async (req, res) => {
    try {
      const scan = await getScan(db, req.params.id);
      if (!scan) {
        return apiError(res, 404, ErrorCodes.SCAN_NOT_FOUND, 'Scan not found', req.requestId);
      }

      if (!scan.scan_dir || !existsSync(scan.scan_dir)) {
        return apiError(res, 404, ErrorCodes.REPORT_NOT_AVAILABLE, 'Report not yet available', req.requestId);
      }

      const reportPath = join(scan.scan_dir, 'report.json');
      if (!existsSync(reportPath)) {
        return apiError(res, 404, ErrorCodes.REPORT_NOT_AVAILABLE, 'Report not yet available', req.requestId);
      }

      const raw = readFileSync(reportPath, 'utf-8');
      const report = JSON.parse(raw);
      const data = report.data || report;

      // Build compact summary — handle both deep-scan and quick-scan formats
      const summary = {
        scan_id: scan.id,
        market: scan.domain,
        generated_at: scan.completed_at || scan.created_at,
        schema_version: '1',
        competitors: [],
        opportunities: [],
        top_gaps: [],
        meta: {},
      };

      // Deep-scan format: competitiveMap/competitiveLandscape, opportunities/topOpportunities, gapMatrix
      const compSection = data.competitiveMap || data.competitiveLandscape || {};
      if (Object.keys(compSection).length > 0) {
        const competitors = compSection.competitors || compSection.players || [];
        summary.competitors = (Array.isArray(competitors) ? competitors : []).map(c => ({
          name: c.name || c.company || '',
          trust_score: c.trustScore ?? c.trust_score ?? null,
          weaknesses_count: Array.isArray(c.weaknesses) ? c.weaknesses.length : (c.weaknessCount ?? 0),
        }));
      }

      const rawOpps = data.opportunities || data.topOpportunities || [];
      if (rawOpps.length > 0 || (Array.isArray(rawOpps) && rawOpps.length > 0)) {
        const opps = Array.isArray(rawOpps) ? rawOpps : [];
        summary.opportunities = opps.map((o, i) => ({
          rank: o.rank ?? i + 1,
          title: o.title || o.gap || o.name || '',
          score: o.score ?? o.opportunityScore ?? null,
          gap_type: o.gapType || o.gap_type || o.category || '',
          evidence_count: o.evidenceCount ?? (Array.isArray(o.evidence) ? o.evidence.length : 0),
        }));
      }

      const gapMatrix = data.gapMatrix || compSection.gapMatrix || {};
      if (Object.keys(gapMatrix).length > 0) {
        const gaps = gapMatrix.gaps || gapMatrix.gapSummary || [];
        summary.top_gaps = (Array.isArray(gaps) ? gaps : []).slice(0, 10).map(g => ({
          category: g.category || g.name || '',
          severity: g.severity || g.level || '',
          affected_competitors: Array.isArray(g.affectedCompetitors || g.competitors) ? (g.affectedCompetitors || g.competitors) : [],
        }));
      }

      // Quick-scan format: groups
      if (data.groups && Array.isArray(data.groups) && summary.competitors.length === 0) {
        summary.top_gaps = data.groups.map(g => ({
          category: g.category || '',
          severity: g.depth > 7 ? 'high' : g.depth > 4 ? 'medium' : 'low',
          affected_competitors: g.sourceNames || [],
        }));
      }

      // Meta — handle both old format (sourcesScanned, dataPoints) and iterative-draft format (scanId, market, draftIteration, converged)
      const meta = data.meta || {};
      summary.meta = {
        sources_scanned: meta.sourcesScanned ?? meta.sources_scanned ?? null,
        data_points: meta.dataPoints ?? meta.data_points ?? meta.totalPosts ?? null,
        iteration_count: meta.iterationCount ?? meta.iteration_count ?? meta.draftIteration ?? null,
        converged: meta.converged ?? null,
      };

      res.json(summary);
    } catch (err) {
      console.error('GET /reports/:id/summary error:', err);
      apiError(res, 500, ErrorCodes.INTERNAL_ERROR, 'Internal server error', req.requestId);
    }
  });

  return router;
}
