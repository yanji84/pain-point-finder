#!/usr/bin/env node

// Connection data is processed locally only. Never sent to external APIs.

/**
 * parse-linkedin-csv.mjs — Parse LinkedIn connection export CSVs from multiple
 * team members and produce a unified connection index.
 *
 * Usage:
 *   node scripts/parse-linkedin-csv.mjs --input <dir> --output <file>
 *
 * Example:
 *   node scripts/parse-linkedin-csv.mjs \
 *     --input /tmp/gapscout-abc123/team-connections/ \
 *     --output /tmp/gapscout-abc123/connection-index.json
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename, extname, dirname } from 'node:path';
import { createHash } from 'node:crypto';

// ─── arg parsing ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  let input = null;
  let output = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && i + 1 < args.length) {
      input = args[++i];
    } else if (args[i] === '--output' && i + 1 < args.length) {
      output = args[++i];
    }
  }

  if (!input || !output) {
    console.error('Usage: node parse-linkedin-csv.mjs --input <dir> --output <file>');
    process.exit(1);
  }

  return { input, output };
}

// ─── CSV parsing ────────────────────────────────────────────────────────────

/**
 * Parse a single CSV line respecting quoted fields.
 * Returns an array of field values.
 */
function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (inQuotes) {
      if (ch === '"') {
        // Escaped quote ("") or end of quoted field
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++; // skip next quote
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }

  fields.push(current);
  return fields;
}

/**
 * Parse CSV text into an array of objects keyed by header names.
 * Handles UTF-8 BOM and skips empty rows.
 */
function parseCsv(text) {
  // Strip UTF-8 BOM
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }

  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]).map(h => h.trim());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const fields = parseCsvLine(lines[i]);
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = (fields[j] || '').trim();
    }
    rows.push(row);
  }

  return rows;
}

// ─── normalization helpers ──────────────────────────────────────────────────

function normalizeCompany(company) {
  return (company || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizePosition(position) {
  return (position || '').trim();
}

/**
 * Extract meaningful keywords from a position title.
 * Strips common noise words and returns lowercase tokens.
 */
function extractPositionKeywords(position) {
  if (!position) return [];

  const noise = new Set([
    'at', 'of', 'the', 'and', 'in', 'for', 'a', 'an', 'to', 'with', 'on', '&', '-', '|',
  ]);

  return position
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !noise.has(w));
}

/**
 * Parse LinkedIn's "DD Mon YYYY" date format to ISO date string (YYYY-MM-DD).
 * Returns null if parsing fails.
 */
function parseLinkedInDate(dateStr) {
  if (!dateStr) return null;

  const months = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  };

  // Match patterns like "15 Jan 2024" or "Jan 15, 2024"
  const match1 = dateStr.match(/(\d{1,2})\s+(\w{3})\s+(\d{4})/);
  if (match1) {
    const [, day, mon, year] = match1;
    const m = months[mon.toLowerCase()];
    if (m) return `${year}-${m}-${day.padStart(2, '0')}`;
  }

  const match2 = dateStr.match(/(\w{3})\s+(\d{1,2}),?\s+(\d{4})/);
  if (match2) {
    const [, mon, day, year] = match2;
    const m = months[mon.toLowerCase()];
    if (m) return `${year}-${m}-${day.padStart(2, '0')}`;
  }

  return null;
}

/**
 * Generate a stable hash ID from name + company.
 */
function connectionId(firstName, lastName, company) {
  const key = `${(firstName || '').toLowerCase()}|${(lastName || '').toLowerCase()}|${normalizeCompany(company)}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

// ─── column name resolution ─────────────────────────────────────────────────

/**
 * Resolve a row's field by trying multiple possible column names.
 * LinkedIn exports can vary in column naming.
 */
function resolveField(row, candidates) {
  for (const key of candidates) {
    if (row[key] !== undefined && row[key] !== '') return row[key];
  }
  return '';
}

function getFirstName(row) {
  return resolveField(row, ['First Name', 'first name', 'FirstName', 'firstname', 'First name']);
}

function getLastName(row) {
  return resolveField(row, ['Last Name', 'last name', 'LastName', 'lastname', 'Last name']);
}

function getEmail(row) {
  return resolveField(row, ['Email Address', 'email address', 'Email', 'email', 'EmailAddress']);
}

function getCompany(row) {
  return resolveField(row, ['Company', 'company', 'Organization', 'organization']);
}

function getPosition(row) {
  return resolveField(row, ['Position', 'position', 'Title', 'title', 'Job Title', 'job title']);
}

function getConnectedOn(row) {
  return resolveField(row, ['Connected On', 'connected on', 'ConnectedOn', 'Date', 'date']);
}

// ─── main pipeline ──────────────────────────────────────────────────────────

async function main() {
  const { input, output } = parseArgs(process.argv);

  // Discover CSV files in input directory
  const files = readdirSync(input)
    .filter(f => extname(f).toLowerCase() === '.csv')
    .sort();

  if (files.length === 0) {
    console.error(`No CSV files found in ${input}`);
    process.exit(1);
  }

  const teamMembers = [];
  const connectionsPerMember = {};

  // Keyed by merge key → connection object
  const merged = new Map();
  // Track email-based merges: email → merge key
  const emailIndex = new Map();

  for (const file of files) {
    const memberName = basename(file, extname(file));
    teamMembers.push(memberName);

    const filePath = join(input, file);
    const text = readFileSync(filePath, 'utf-8');
    const rows = parseCsv(text);

    let memberCount = 0;

    for (const row of rows) {
      const firstName = getFirstName(row);
      const lastName = getLastName(row);
      const email = getEmail(row).toLowerCase();
      const company = getCompany(row);
      const position = normalizePosition(getPosition(row));
      const connectedOn = parseLinkedInDate(getConnectedOn(row));

      if (!firstName && !lastName) continue;

      const nameCompanyKey = `${firstName.toLowerCase()}|${lastName.toLowerCase()}|${normalizeCompany(company)}`;

      // Determine the canonical merge key — prefer email-based dedup if available
      let mergeKey = nameCompanyKey;
      if (email && emailIndex.has(email)) {
        mergeKey = emailIndex.get(email);
      } else if (merged.has(nameCompanyKey)) {
        mergeKey = nameCompanyKey;
      }

      if (merged.has(mergeKey)) {
        // Existing connection — add this team member
        const conn = merged.get(mergeKey);
        if (!conn.connectedVia.includes(memberName)) {
          conn.connectedVia.push(memberName);
          conn.sharedConnections = conn.connectedVia.length;
        }
        // Fill in missing email
        if (!conn.email && email) {
          conn.email = email;
        }
        // Use earliest connected date
        if (connectedOn && (!conn.connectedOn || connectedOn < conn.connectedOn)) {
          conn.connectedOn = connectedOn;
        }
      } else {
        // New connection
        const conn = {
          id: connectionId(firstName, lastName, company),
          firstName,
          lastName,
          email: email || '',
          company,
          companyNormalized: normalizeCompany(company),
          position,
          positionKeywords: extractPositionKeywords(position),
          connectedVia: [memberName],
          sharedConnections: 1,
          connectedOn: connectedOn || null,
        };
        merged.set(mergeKey, conn);
      }

      // Register email for future dedup
      if (email) {
        emailIndex.set(email, mergeKey);
      }

      memberCount++;
    }

    connectionsPerMember[memberName] = memberCount;
  }

  // Build the connections array sorted by sharedConnections desc, then name
  const connections = Array.from(merged.values()).sort((a, b) => {
    if (b.sharedConnections !== a.sharedConnections) return b.sharedConnections - a.sharedConnections;
    const nameA = `${a.lastName} ${a.firstName}`.toLowerCase();
    const nameB = `${b.lastName} ${b.firstName}`.toLowerCase();
    return nameA.localeCompare(nameB);
  });

  // Build indexes
  const byCompany = {};
  const byTitle = {};
  const byTeamMember = {};

  for (let i = 0; i < connections.length; i++) {
    const conn = connections[i];

    // byCompany
    if (conn.companyNormalized) {
      if (!byCompany[conn.companyNormalized]) byCompany[conn.companyNormalized] = [];
      byCompany[conn.companyNormalized].push(i);
    }

    // byTitle
    for (const kw of conn.positionKeywords) {
      if (!byTitle[kw]) byTitle[kw] = [];
      byTitle[kw].push(i);
    }

    // byTeamMember
    for (const member of conn.connectedVia) {
      if (!byTeamMember[member]) byTeamMember[member] = [];
      byTeamMember[member].push(i);
    }
  }

  // Compute stats
  const companyCounts = {};
  for (const conn of connections) {
    if (conn.company) {
      const key = conn.company;
      companyCounts[key] = (companyCounts[key] || 0) + 1;
    }
  }

  const topCompanies = Object.entries(companyCounts)
    .map(([company, count]) => ({ company, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  const totalConnections = Object.values(connectionsPerMember).reduce((s, n) => s + n, 0);
  const multipleIntrosPossible = connections.filter(c => c.sharedConnections > 1).length;

  const result = {
    generatedAt: new Date().toISOString(),
    teamMembers,
    totalConnections,
    uniqueConnections: connections.length,
    connections,
    indexes: {
      byCompany,
      byTitle,
      byTeamMember,
    },
    stats: {
      connectionsPerMember,
      topCompanies,
      multipleIntrosPossible,
    },
  };

  // Ensure output directory exists
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(result, null, 2), 'utf-8');

  console.log(`Connection index written to ${output}`);
  console.log(`  Team members: ${teamMembers.join(', ')}`);
  console.log(`  Total connections (across all files): ${totalConnections}`);
  console.log(`  Unique connections: ${connections.length}`);
  console.log(`  Multiple intro paths: ${multipleIntrosPossible}`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
