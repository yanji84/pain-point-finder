/**
 * mcp.mjs — MCP (Model Context Protocol) server for GapScout.
 *
 * Exposes GapScout's core capabilities as MCP tools over Streamable HTTP transport.
 * Mounted on the Express app at /mcp — behind the auth wall so req.user is available.
 *
 * OpenClaw bots auto-discover these tools via the MCP protocol.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import {
  getScan,
  listScans as dbListScans,
} from './db.mjs';
import {
  cancelScan,
  checkProgress,
} from './scanner.mjs';

// ─── Helper: read report.json for a scan ────────────────────────────────────

function readReport(scanDir) {
  if (!scanDir) return null;
  const reportPath = join(scanDir, 'report.json');
  if (!existsSync(reportPath)) return null;
  try {
    return JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch {
    return null;
  }
}

// ─── Helper: spawn claude CLI for chat ───────────────────────────────────────

function chatWithClaude(prompt, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/claude', ['-p', '--output-format', 'json', '--verbose'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: '/tmp',
      env: { ...process.env, HOME: '/root' },
    });

    child.stdin.write(prompt);
    child.stdin.end();

    let stdout = '';
    let stderr = '';
    let done = false;

    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });

    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        child.kill('SIGTERM');
        reject(new Error('Chat timed out'));
      }
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (done) return;
      done = true;

      let result = '';
      try {
        const events = JSON.parse(stdout);
        const arr = Array.isArray(events) ? events : [events];
        for (const evt of arr) {
          if (evt.type === 'result' && evt.result) result = evt.result;
          if (evt.type === 'assistant' && evt.message?.content) {
            for (const block of evt.message.content) {
              if (block.type === 'text' && block.text) result += block.text;
            }
          }
        }
      } catch {
        result = stdout.trim();
      }

      resolve(result || 'No response.');
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (!done) { done = true; reject(err); }
    });
  });
}

// ─── Create MCP handler ─────────────────────────────────────────────────────

/**
 * Creates an Express request handler that serves the MCP endpoint.
 * Each request gets its own transport instance (stateless mode).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} dataDir
 * @returns {function} Express middleware
 */
export function createMcpHandler(db, dataDir) {
  // We create one McpServer instance and register all tools on it.
  // For each incoming HTTP request, we create a new transport and connect it.

  function buildMcpServer() {
    const mcp = new McpServer(
      {
        name: 'gapscout',
        version: '4.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // ── Tool: get_scan_status ─────────────────────────────────────────────

    mcp.tool(
      'get_scan_status',
      'Check the progress and status of a GapScout scan.',
      {
        scan_id: z.string().describe('The scan ID returned by create_scan'),
      },
      async (args) => {
        const scan = getScan(db, args.scan_id);
        if (!scan) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'Scan not found' }) }],
            isError: true,
          };
        }

        let progressPct = scan.progress_pct || 0;
        let progressPhase = scan.progress_detail || '';

        if (scan.status === 'running' && scan.scan_dir) {
          const progress = checkProgress(scan.scan_dir);
          progressPct = progress.pct;
          progressPhase = progress.detail;
        } else if (scan.status === 'completed') {
          progressPct = 100;
          progressPhase = 'Complete';
        }

        // Estimate completion based on mode and progress
        let estimatedCompletion = null;
        if (scan.status === 'running' && scan.started_at && progressPct > 0) {
          const elapsed = Date.now() - new Date(scan.started_at).getTime();
          const totalEstimate = (elapsed / progressPct) * 100;
          const remaining = totalEstimate - elapsed;
          estimatedCompletion = new Date(Date.now() + remaining).toISOString();
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              scan_id: scan.id,
              status: scan.status,
              progress_pct: progressPct,
              progress_phase: progressPhase,
              started_at: scan.started_at,
              estimated_completion: estimatedCompletion,
            }),
          }],
        };
      }
    );

    // ── Tool: list_scans ──────────────────────────────────────────────────

    mcp.tool(
      'list_scans',
      'List recent GapScout scans with their status.',
      {
        status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']).optional().describe('Filter by scan status'),
        limit: z.number().int().min(1).max(100).optional().describe('Max results to return (default: 20)'),
      },
      async (args) => {
        const { scans, total } = dbListScans(db, {
          status: args.status,
          limit: args.limit || 20,
        });

        const enriched = scans.map(scan => {
          const result = {
            id: scan.id,
            name: scan.name,
            domain: scan.domain,
            mode: scan.mode,
            status: scan.status,
            created_at: scan.created_at,
            started_at: scan.started_at,
            completed_at: scan.completed_at,
          };

          if (scan.status === 'running' && scan.scan_dir) {
            try {
              const progress = checkProgress(scan.scan_dir);
              result.progress_pct = progress.pct;
              result.progress_phase = progress.detail;
            } catch {}
          }

          return result;
        });

        return {
          content: [{ type: 'text', text: JSON.stringify({ scans: enriched, total }) }],
        };
      }
    );

    // ── Tool: cancel_scan ─────────────────────────────────────────────────

    mcp.tool(
      'cancel_scan',
      'Cancel a running or queued GapScout scan.',
      {
        scan_id: z.string().describe('The scan ID to cancel'),
      },
      async (args) => {
        const scan = getScan(db, args.scan_id);
        if (!scan) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'Scan not found' }) }],
            isError: true,
          };
        }

        if (!['running', 'queued'].includes(scan.status)) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: `Scan is ${scan.status}, cannot cancel` }) }],
            isError: true,
          };
        }

        cancelScan(db, args.scan_id);

        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 'cancelled' }) }],
        };
      }
    );

    // ── Tool: get_report ──────────────────────────────────────────────────

    mcp.tool(
      'get_report',
      'Get the full report JSON for a completed GapScout scan. Contains competitor map, pain analysis, opportunities, and more.',
      {
        scan_id: z.string().describe('The scan ID to get the report for'),
      },
      async (args) => {
        const scan = getScan(db, args.scan_id);
        if (!scan) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'Scan not found' }) }],
            isError: true,
          };
        }

        if (scan.status !== 'completed') {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: `Scan is ${scan.status}, report not yet available` }) }],
            isError: true,
          };
        }

        const report = readReport(scan.scan_dir);
        if (!report) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'Report file not found in scan directory' }) }],
            isError: true,
          };
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(report) }],
        };
      }
    );

    // ── Tool: get_report_summary ──────────────────────────────────────────

    mcp.tool(
      'get_report_summary',
      'Get a compact summary of a completed GapScout report: competitors, top opportunities, and key metrics.',
      {
        scan_id: z.string().describe('The scan ID to summarize'),
      },
      async (args) => {
        const scan = getScan(db, args.scan_id);
        if (!scan) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'Scan not found' }) }],
            isError: true,
          };
        }

        if (scan.status !== 'completed') {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: `Scan is ${scan.status}, report not yet available` }) }],
            isError: true,
          };
        }

        const report = readReport(scan.scan_dir);
        if (!report) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'Report file not found' }) }],
            isError: true,
          };
        }

        const data = report.data || report;

        // Extract competitors — handle both competitiveMap and competitiveLandscape
        const competitors = [];
        const compMap = data.competitiveMap || data.competitiveLandscape || data.competitors || {};
        const compList = compMap.competitors || compMap.companies || (Array.isArray(compMap) ? compMap : []);
        for (const c of (Array.isArray(compList) ? compList : [])) {
          competitors.push({
            name: c.name || c.company || 'Unknown',
            trust_score: c.trustScore ?? c.trust_score ?? null,
            weaknesses_count: Array.isArray(c.weaknesses) ? c.weaknesses.length : (c.weaknesses_count ?? 0),
          });
        }

        // Extract opportunities — handle both opportunities and topOpportunities
        const opportunities = [];
        const opps = data.opportunities || data.topOpportunities || data.gapMatrix?.opportunities || [];
        const oppList = Array.isArray(opps) ? opps : (opps.items || opps.ranked || []);
        for (let i = 0; i < oppList.length; i++) {
          const o = oppList[i];
          opportunities.push({
            rank: o.rank ?? i + 1,
            title: o.title || o.gap || o.name || o.opportunity || 'Untitled',
            score: o.score ?? o.opportunityScore ?? o.gap_score ?? null,
            gap_type: o.gapType || o.gap_type || o.type || null,
            evidence_count: o.evidenceCount ?? (Array.isArray(o.evidence) ? o.evidence.length : 0),
          });
        }

        // Count meta stats — handle iterative-draft format (draftIteration, converged) too
        let sourcesScanned = 0;
        let dataPoints = 0;
        if (data.meta) {
          sourcesScanned = data.meta.sourcesScanned ?? data.meta.sources_scanned ?? 0;
          dataPoints = data.meta.dataPoints ?? data.meta.data_points ?? data.meta.totalPosts ?? 0;
        }

        // For quick scan format, extract from groups
        if (competitors.length === 0 && data.groups) {
          for (const g of data.groups) {
            if (g.sourceNames) sourcesScanned = Math.max(sourcesScanned, g.sourceNames.length);
            dataPoints += g.postCount || 0;
          }
        }

        const summary = {
          market: scan.domain,
          competitors,
          opportunities,
          meta: {
            sources_scanned: sourcesScanned,
            data_points: dataPoints,
          },
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(summary) }],
        };
      }
    );

    // ── Tool: chat_with_report ────────────────────────────────────────────

    mcp.tool(
      'chat_with_report',
      'Ask a natural-language question about a completed GapScout scan report. Uses AI to analyze the report data and answer.',
      {
        scan_id: z.string().describe('The scan ID whose report to query'),
        question: z.string().describe('Your question about the report (e.g. "What are the top 3 weaknesses of Jira?")'),
      },
      async (args) => {
        const scan = getScan(db, args.scan_id);
        if (!scan) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'Scan not found' }) }],
            isError: true,
          };
        }

        if (scan.status !== 'completed') {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: `Scan is ${scan.status}, report not yet available` }) }],
            isError: true,
          };
        }

        const report = readReport(scan.scan_dir);
        if (!report) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'Report file not found' }) }],
            isError: true,
          };
        }

        // Build a context string from the report (trimmed to 50KB)
        const data = report.data || report;
        let reportContext = JSON.stringify({
          domain: scan.domain,
          executiveSummary: data.executiveSummary,
          competitiveMap: data.competitiveMap,
          painAnalysis: data.painAnalysis,
          opportunities: Array.isArray(data.opportunities) ? data.opportunities.slice(0, 8) : data.opportunities,
          unmetNeeds: data.unmetNeeds,
          switchingAnalysis: data.switchingAnalysis,
          gapSummary: data.gapMatrix?.gapSummary || data.gapMatrix?.gaps,
        }, null, 0);

        if (reportContext.length > 50000) {
          reportContext = reportContext.slice(0, 50000) + '..."}}';
        }

        const prompt = `You are a market intelligence analyst. Here is a GapScout scan report for the "${scan.domain}" market:

${reportContext}

Answer the following question concisely, citing specific data from the report:
${args.question}`;

        try {
          const answer = await chatWithClaude(prompt);
          return {
            content: [{ type: 'text', text: JSON.stringify({ answer }) }],
          };
        } catch (err) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'Chat failed: ' + err.message }) }],
            isError: true,
          };
        }
      }
    );

    // ── Tool: list_ideas ──────────────────────────────────────────────────

    mcp.tool(
      'list_ideas',
      'List generated business ideas from the GapScout ideas pipeline.',
      {
        status: z.string().optional().describe('Filter by idea status'),
        limit: z.number().int().min(1).max(50).optional().describe('Max results (default: 20)'),
      },
      async (args) => {
        const ideasDir = join(dataDir, 'ideas');
        let ideas = [];

        if (existsSync(ideasDir)) {
          try {
            const files = readdirSync(ideasDir).filter(f => f.endsWith('.json'));
            for (const f of files) {
              try {
                const data = JSON.parse(readFileSync(join(ideasDir, f), 'utf8'));
                ideas.push({ id: f.replace('.json', ''), ...data });
              } catch {}
            }
          } catch {}
        }

        // Also check for ideas.json in data root (alternate location)
        const rootIdeasPath = join(dataDir, 'ideas.json');
        if (existsSync(rootIdeasPath) && ideas.length === 0) {
          try {
            const data = JSON.parse(readFileSync(rootIdeasPath, 'utf8'));
            if (Array.isArray(data)) {
              ideas = data.map((item, i) => ({ id: item.id || `idea-${i}`, ...item }));
            } else if (data.ideas) {
              ideas = data.ideas.map((item, i) => ({ id: item.id || `idea-${i}`, ...item }));
            }
          } catch {}
        }

        if (args.status) {
          ideas = ideas.filter(i => i.status === args.status);
        }

        const limit = args.limit || 20;
        ideas = ideas.slice(0, limit);

        return {
          content: [{ type: 'text', text: JSON.stringify({ ideas, total: ideas.length }) }],
        };
      }
    );

    return mcp;
  }

  // ─── Express handler ─────────────────────────────────────────────────────

  return async (req, res) => {
    try {
      // Create a fresh MCP server + transport per request (stateless mode)
      const mcp = buildMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless mode
      });

      // Connect the MCP server to this transport
      await mcp.connect(transport);

      // Let the transport handle the HTTP request
      await transport.handleRequest(req, res, req.body);

      // After response is sent, clean up
      res.on('finish', () => {
        transport.close().catch(() => {});
        mcp.close().catch(() => {});
      });
    } catch (err) {
      console.error('[mcp] Error handling request:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'MCP server error: ' + err.message });
      }
    }
  };
}
