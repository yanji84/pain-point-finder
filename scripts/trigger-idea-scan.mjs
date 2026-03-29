#!/usr/bin/env node
/**
 * Trigger a full GapScout scan for an idea by ID.
 * Usage: node scripts/trigger-idea-scan.mjs <idea-id>
 */
import { initDb, getIdea, updateIdea, createScan } from '../server/db.mjs';
import { startScan } from '../server/scanner.mjs';
import crypto from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

const ideaId = parseInt(process.argv[2]);
if (!ideaId) {
  console.error('Usage: node scripts/trigger-idea-scan.mjs <idea-id>');
  process.exit(1);
}

const dataDir = process.env.DATA_DIR || './data';
const db = initDb(dataDir);

const idea = getIdea(db, ideaId);
if (!idea) {
  console.error('Idea not found:', ideaId);
  process.exit(1);
}

if (idea.status === 'scanning' || idea.status === 'scanned') {
  console.log('Idea already', idea.status, '— skipping');
  process.exit(0);
}

const scanId = crypto.randomUUID();
const scanDir = join(dataDir, 'scans', scanId);
mkdirSync(scanDir, { recursive: true });

// Get first user ID for createdBy
const user = db.prepare('SELECT id FROM users LIMIT 1').get();
const userId = user ? user.id : 1;

createScan(db, {
  id: scanId,
  name: idea.title,
  domain: idea.market_for_scan,
  mode: 'full',
  sources: null,
  config: null,
  scanDir,
  createdBy: userId,
});

updateIdea(db, idea.id, { status: 'scanning', scan_id: scanId });

// Write PID file so the web server can kill this process on cancel
import { writeFileSync } from 'node:fs';
writeFileSync(join(scanDir, '.scan-pid'), String(process.pid));

console.log(`Scan started: ${scanId}`);
console.log(`  Idea: ${idea.title}`);
console.log(`  Market: ${idea.market_for_scan}`);
console.log(`  Scan dir: ${scanDir}`);
console.log(`  PID: ${process.pid}`);

// Build idea context for the orchestrator
const signals = idea.signals_json ? JSON.parse(idea.signals_json) : {};
const teamFit = idea.team_fit_json ? JSON.parse(idea.team_fit_json) : {};
const ideaContext = {
  problem: idea.problem_statement || '',
  targetUser: signals.targetUser || signals.target_user || '',
  demandEvidence: signals.demandEvidence || signals.demand_evidence || '',
  competitiveGap: idea.competitive_landscape || '',
  narrowestWedge: idea.narrowest_wedge || '',
};

startScan(db, { id: scanId, domain: idea.market_for_scan, scanDir, mode: 'full' }, { ideaContext });
