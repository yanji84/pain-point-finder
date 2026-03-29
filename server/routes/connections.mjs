import { Router } from 'express';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  upsertConnections,
  getConnectionStats,
  deleteConnectionsByMember,
  exportConnectionsForScan,
  getConnectionMembers,
} from '../db.mjs';
import { apiError, ErrorCodes } from '../middleware/errors.mjs';
import { requireScope } from '../auth.mjs';

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

function parseLinkedInCSV(csvContent) {
  const lines = csvContent.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];

  // Handle BOM
  if (lines[0].charCodeAt(0) === 0xFEFF) lines[0] = lines[0].slice(1);

  const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase().trim());
  const connections = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => { row[h] = values[idx] || ''; });

    connections.push({
      firstName: row['first name'] || '',
      lastName: row['last name'] || '',
      email: row['email address'] || row['email'] || '',
      company: row['company'] || '',
      position: row['position'] || row['title'] || '',
      connectedOn: row['connected on'] || '',
    });
  }

  return connections.filter(c => c.firstName || c.lastName || c.company);
}

export function createConnectionsRouter(db) {
  const router = Router();

  // POST /upload — Upload LinkedIn connections CSV for a team member
  router.post('/upload', requireScope('connections:write'), async (req, res) => {
    try {
      const { memberName, csvContent } = req.body;

      if (!memberName || typeof memberName !== 'string') {
        return apiError(res, 400, ErrorCodes.INVALID_INPUT, 'memberName is required', req.requestId);
      }

      if (!/^[a-zA-Z0-9_-]{1,50}$/.test(memberName)) {
        return apiError(res, 400, ErrorCodes.INVALID_INPUT, 'memberName must be alphanumeric with hyphens/underscores, max 50 chars', req.requestId);
      }

      if (!csvContent || typeof csvContent !== 'string') {
        return apiError(res, 400, ErrorCodes.INVALID_INPUT, 'csvContent is required', req.requestId);
      }

      const connections = parseLinkedInCSV(csvContent);
      if (connections.length === 0) {
        return apiError(res, 400, ErrorCodes.INVALID_INPUT, 'No valid connections found in CSV', req.requestId);
      }

      upsertConnections(db, memberName, connections, req.user.id);

      res.json({ ok: true, memberName, count: connections.length });
    } catch (err) {
      console.error('POST /connections/upload error:', err);
      apiError(res, 500, ErrorCodes.INTERNAL_ERROR, 'Internal server error', req.requestId);
    }
  });

  // GET / — List all team members with connection counts
  router.get('/', requireScope('connections:read'), async (req, res) => {
    try {
      const stats = getConnectionStats(db);
      res.json(stats);
    } catch (err) {
      console.error('GET /connections error:', err);
      apiError(res, 500, ErrorCodes.INTERNAL_ERROR, 'Internal server error', req.requestId);
    }
  });

  // DELETE /:memberName — Delete all connections for a team member
  router.delete('/:memberName', requireScope('connections:write'), async (req, res) => {
    try {
      const { memberName } = req.params;

      if (!/^[a-zA-Z0-9_-]{1,50}$/.test(memberName)) {
        return apiError(res, 400, ErrorCodes.INVALID_INPUT, 'Invalid memberName', req.requestId);
      }

      deleteConnectionsByMember(db, memberName);

      res.json({ ok: true, deleted: memberName });
    } catch (err) {
      console.error('DELETE /connections/:memberName error:', err);
      apiError(res, 500, ErrorCodes.INTERNAL_ERROR, 'Internal server error', req.requestId);
    }
  });

  // GET /export — Export connections as CSVs into a scan directory
  router.get('/export', requireScope('connections:read'), async (req, res) => {
    try {
      const { scanDir } = req.query;

      if (!scanDir) {
        return apiError(res, 400, ErrorCodes.INVALID_INPUT, 'scanDir query param is required', req.requestId);
      }

      const teamDir = join(scanDir, 'team-connections');
      mkdirSync(teamDir, { recursive: true });

      const members = getConnectionMembers(db);
      let totalExported = 0;

      for (const memberName of members) {
        const connections = exportConnectionsForScan(db, memberName);
        if (connections.length === 0) continue;

        const header = 'First Name,Last Name,Email Address,Company,Position,Connected On';
        const rows = connections.map(c =>
          [c.first_name, c.last_name, c.email, c.company, c.position, c.connected_on]
            .map(v => `"${(v || '').replace(/"/g, '""')}"`)
            .join(',')
        );

        writeFileSync(join(teamDir, `${memberName}.csv`), [header, ...rows].join('\n'), 'utf-8');
        totalExported += connections.length;
      }

      res.json({ ok: true, members: members.length, totalExported, dir: teamDir });
    } catch (err) {
      console.error('GET /connections/export error:', err);
      apiError(res, 500, ErrorCodes.INTERNAL_ERROR, 'Internal server error', req.requestId);
    }
  });

  return router;
}
