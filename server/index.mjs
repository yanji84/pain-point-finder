#!/usr/bin/env node

/**
 * index.mjs — GapScout team web service entry point.
 *
 * Wires Express middleware, session auth, scan API, report serving,
 * and the web dashboard. Initializes SQLite + seeds admin user on first run.
 */

import express from 'express';
import crypto from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { initDb, createUser, getUserByUsername, createSession, deleteSession, listScans as dbListScans, cleanExpiredSessions, cleanExpiredIdempotencyKeys, createScan as dbCreateScan, getScan, getConnectionStats, getConnectionMembers, exportConnectionsForScan, listApiKeys, createApiKey, cleanOldAuditLogs, getUserWebhookConfig, updateUserWebhookConfig, getRecentWebhookDeliveries, getIdeas, getIdea, getIdeaCycles, logApiCall } from './db.mjs';
import { authMiddleware, hashPassword, verifyPassword, generateSessionId, SESSION_MAX_AGE_MS } from './auth.mjs';
import { cleanupStale, getActiveCount, getQueueLength, startScan, cancelScan, checkProgress } from './scanner.mjs';
import { startRetryLoop, validateCallbackUrl } from './webhooks.mjs';
import { createScansRouter } from './routes/scans.mjs';
import { createReportsRouter } from './routes/reports.mjs';
import { createChatRouter } from './routes/chat.mjs';
import { createConnectionsRouter } from './routes/connections.mjs';
import { createIdeasRouter } from './routes/ideas.mjs';
import { createKeysRouter } from './routes/keys.mjs';
import { createMcpHandler } from './mcp.mjs';
import { rateLimiter, securityHeaders, requestSizeLimiter, loginRateLimiter } from './middleware/security.mjs';
import { requestIdMiddleware } from './middleware/request-id.mjs';
import { idempotencyMiddleware } from './middleware/idempotency.mjs';
import { getOpenApiSpec } from './openapi.mjs';
import { apiError } from './middleware/errors.mjs';
import {
  renderLogin, renderDashboard, renderNewScan, renderScanDetail,
  renderSettings, renderConnections, renderIdeaDetailPage,
} from './views.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT) || 3000;
const DATA_DIR = resolve(process.env.DATA_DIR || './data');
const BASE_PATH = process.env.BASE_PATH || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

// ─── Ensure data directories ────────────────────────────────────────────────

mkdirSync(resolve(DATA_DIR, 'scans'), { recursive: true });

// ─── Initialize DB ──────────────────────────────────────────────────────────

const db = initDb(DATA_DIR);

// Cleanup expired sessions and idempotency keys on startup
cleanExpiredSessions(db);
cleanExpiredIdempotencyKeys(db);

// Prune old API audit logs (older than 90 days)
cleanOldAuditLogs(db, 90);

// Mark any stale "running" scans from a previous crash
cleanupStale(db);

// Start webhook retry loop for failed deliveries
startRetryLoop(db);

// ─── Seed admin user on first run ───────────────────────────────────────────

const existingAdmin = getUserByUsername(db, 'admin');
if (!existingAdmin) {
  const tempPassword = crypto.randomBytes(8).toString('hex');
  const hash = await hashPassword(tempPassword);
  createUser(db, { id: crypto.randomUUID(), username: 'admin', passwordHash: hash });
  console.log('');
  console.log('  ┌──────────────────────────────────────────┐');
  console.log('  │  GapScout — First Run Setup              │');
  console.log('  │                                          │');
  console.log(`  │  Admin username: admin                   │`);
  console.log(`  │  Admin password: ${tempPassword}         │`);
  console.log('  │                                          │');
  console.log('  │  Change this in Settings after login.    │');
  console.log('  └──────────────────────────────────────────┘');
  console.log('');
}

// ─── Express app ────────────────────────────────────────────────────────────

const app = express();

// Trust proxy (behind Caddy reverse proxy)
app.set('trust proxy', 1);

// Request ID — must be first so every response gets X-Request-Id
app.use(requestIdMiddleware());

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Security middleware
app.use(securityHeaders());
app.use(requestSizeLimiter());
app.use(rateLimiter({ windowMs: 60000, max: 60 }));

// Simple cookie parser (no dependency needed)
app.use((req, _res, next) => {
  req.cookies = {};
  const header = req.headers.cookie;
  if (header) {
    for (const pair of header.split(';')) {
      const [name, ...rest] = pair.trim().split('=');
      if (name) req.cookies[name.trim()] = decodeURIComponent(rest.join('=').trim());
    }
  }
  next();
});

// ─── Public API endpoints (no auth) ─────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    api_spec: '/api/openapi.json',
    mcp_endpoint: '/mcp',
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/openapi.json', (req, res) => {
  res.json(getOpenApiSpec());
});

app.get('/.well-known/mcp.json', (req, res) => {
  res.json({
    mcp_endpoint: '/mcp',
    transport: 'streamable-http',
    auth: {
      type: 'bearer',
      token_url: '/api/auth/token',
      key_management: '/api/keys',
      instructions: 'POST /api/auth/token with {"username","password"} to get a bearer token, or create an API key at /settings in the web UI.',
    },
    capabilities: ['tools'],
    tools_count: 7,
    server_info: { name: 'gapscout', version: '1.0.0' },
  });
});

app.post('/api/auth/token', loginRateLimiter(), async (req, res) => {
  const { username, password, key_name, bot_identity } = req.body;

  if (!username || !password) {
    return apiError(res, 400, 'INVALID_INPUT', 'username and password are required', req.requestId);
  }

  const user = getUserByUsername(db, username);
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return apiError(res, 401, 'UNAUTHORIZED', 'Invalid username or password', req.requestId);
  }

  // Create an API key for this bot
  const result = createApiKey(db, {
    userId: user.id,
    name: key_name || `bot-${Date.now()}`,
    botIdentity: bot_identity || null,
    scopes: '*',
    rateLimitRpm: 30,
    expiresAt: null,
  });

  res.status(201).json({
    token: result.key,
    token_type: 'bearer',
    key_id: result.id,
    key_prefix: result.prefix,
    scopes: '*',
    mcp_endpoint: '/mcp',
    usage: 'Set Authorization header: Bearer <token>',
  });
});

// ─── Public routes (no auth) ────────────────────────────────────────────────

app.get('/login', (req, res) => {
  res.type('html').send(renderLogin(null, { basePath: BASE_PATH }));
});

app.post('/login', loginRateLimiter(), async (req, res) => {
  const { username, password } = req.body;
  const user = getUserByUsername(db, username);

  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return res.type('html').send(renderLogin('Invalid username or password.', { basePath: BASE_PATH }));
  }

  const sessionId = generateSessionId();
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS).toISOString();
  createSession(db, { id: sessionId, userId: user.id, expiresAt });

  res.setHeader('Set-Cookie', `gapscout_sid=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_MS / 1000}`);
  res.redirect(BASE_PATH + '/');
});

app.post('/logout', (req, res) => {
  const sid = req.cookies?.gapscout_sid;
  if (sid) deleteSession(db, sid);
  res.setHeader('Set-Cookie', 'gapscout_sid=; Path=/; HttpOnly; Max-Age=0');
  res.redirect(BASE_PATH + '/login');
});

// ─── Auth wall ──────────────────────────────────────────────────────────────

app.use(authMiddleware(db));

// ─── API audit logging (only for API key auth) ─────────────────────────────

app.use('/api', (req, res, next) => {
  if (req.authMethod === 'api_key' && req.apiKey) {
    res.on('finish', () => {
      try {
        logApiCall(db, {
          apiKeyId: req.apiKey.id,
          userId: req.user.id,
          method: req.method,
          path: req.originalUrl,
          statusCode: res.statusCode,
          botIdentity: req.apiKey.botIdentity || null,
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'] || null,
        });
      } catch {}
    });
  }
  next();
});

// ─── MCP endpoint (Streamable HTTP transport for OpenClaw bots) ─────────────

const mcpHandler = createMcpHandler(db, DATA_DIR);
app.all('/mcp', mcpHandler);
app.all('/mcp/*', mcpHandler);

// ─── API routes ─────────────────────────────────────────────────────────────

app.use('/api', createChatRouter(db, DATA_DIR));  // Chat routes first (more specific: /scans/:id/chat)
app.use('/api/scans', rateLimiter({ windowMs: 60000, max: 10, keyFn: req => req.user?.id || req.ip }), idempotencyMiddleware(db), createScansRouter(db, DATA_DIR));
app.use('/api/reports', createReportsRouter(db, DATA_DIR));
app.use('/api/connections', createConnectionsRouter(db));
app.use('/api/ideas', idempotencyMiddleware(db), createIdeasRouter(db, DATA_DIR));
app.use('/api/keys', createKeysRouter(db));

// ─── Page routes ────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  const scans = dbListScans(db, { limit: 50 });
  const activeCount = getActiveCount();
  const queueLength = getQueueLength();

  // Merge live progress into running scans
  for (const scan of scans.scans) {
    if (scan.status === 'running' && scan.scan_dir) {
      const progress = checkProgress(scan.scan_dir);
      scan.progress_pct = progress.pct;
      scan.progress_detail = progress.detail;
    }
  }

  // Full ideas data for dashboard
  let ideas = [];
  let ideaCycles = [];
  try {
    ideas = getIdeas(db);
    ideaCycles = getIdeaCycles(db);
  } catch {}

  res.type('html').send(renderDashboard(scans, activeCount, queueLength, { user: req.user, basePath: BASE_PATH, ideas, ideaCycles }));
});

app.get('/scans/new', (req, res) => {
  res.type('html').send(renderNewScan({ user: req.user, basePath: BASE_PATH }));
});

app.post('/scans', (req, res) => {
  const { name, domain, sources, mode } = req.body;
  if (!domain) return res.redirect(BASE_PATH + '/scans/new');

  const id = crypto.randomUUID();
  const scanDir = resolve(DATA_DIR, 'scans', id);
  mkdirSync(scanDir, { recursive: true });

  // Auto-export team connections to scan directory
  const connMembers = getConnectionMembers(db);
  if (connMembers.length > 0) {
    const connDir = resolve(scanDir, 'team-connections');
    mkdirSync(connDir, { recursive: true });
    for (const memberName of connMembers) {
      const rows = exportConnectionsForScan(db, memberName);
      if (rows.length > 0) {
        const header = 'First Name,Last Name,Email Address,Company,Position,Connected On';
        const csvLines = rows.map(r =>
          [r.first_name, r.last_name, r.email, r.company, r.position, r.connected_on]
            .map(v => `"${(v || '').replace(/"/g, '""')}"`)
            .join(',')
        );
        writeFileSync(resolve(connDir, `${memberName}.csv`), header + '\n' + csvLines.join('\n') + '\n', 'utf8');
      }
    }
  }

  dbCreateScan(db, {
    id,
    name: name || domain,
    domain,
    mode: mode || 'full',
    sources: sources || null,
    config: null,
    scanDir,
    createdBy: req.user.id,
  });

  // Store user's default webhook URL on the scan for callback on completion
  const userWebhook = getUserWebhookConfig(db, req.user.id);
  if (userWebhook?.webhook_url) {
    db.prepare('UPDATE scans SET callback_url = ? WHERE id = ?').run(userWebhook.webhook_url, id);
  }

  startScan(db, { id, domain, sources: sources || undefined, scanDir, mode: mode || 'full' });

  res.redirect(`${BASE_PATH}/scans/${id}`);
});

app.get('/scans/:id', (req, res) => {
  const scan = getScan(db, req.params.id);
  if (!scan) return res.status(404).type('html').send('Not found');

  let progress = { pct: 0, detail: 'Waiting...' };
  if (scan.status === 'running' && scan.scan_dir) {
    progress = checkProgress(scan.scan_dir);
  } else if (scan.status === 'completed') {
    progress = { pct: 100, detail: 'Complete' };
  }

  res.type('html').send(renderScanDetail(scan, progress, { user: req.user, basePath: BASE_PATH }));
});

// ─── Cancel scan route ──────────────────────────────────────────────────────

app.post('/scans/:id/cancel', async (req, res) => {
  try {
    const scan = getScan(db, req.params.id);
    if (!scan) return res.redirect(BASE_PATH + '/');

    // Try in-process cancel first (works for scans started by this server)
    cancelScan(db, req.params.id);

    // Also kill any external process via PID file (e.g. trigger-idea-scan.mjs)
    if (scan.scan_dir) {
      try {
        const { readFileSync, existsSync } = await import('node:fs');
        const { join } = await import('node:path');
        const pidFile = join(scan.scan_dir, '.scan-pid');
        if (existsSync(pidFile)) {
          const pid = Number(readFileSync(pidFile, 'utf8').trim());
          if (pid > 0) {
            try { process.kill(pid, 'SIGTERM'); } catch {}
            // Also kill child processes (the claude process)
            try {
              const { execSync } = await import('node:child_process');
              execSync(`pkill -TERM -P ${pid} 2>/dev/null || true`);
            } catch {}
          }
        }
      } catch {}
    }

    // Ensure DB status is updated regardless
    const { updateScan } = await import('./db.mjs');
    updateScan(db, req.params.id, { status: 'cancelled', completed_at: new Date().toISOString() });

    res.redirect(BASE_PATH + '/');
  } catch (err) {
    console.error('Cancel scan error:', err);
    res.redirect(BASE_PATH + '/');
  }
});

// ─── Ideas detail route ─────────────────────────────────────────────────────

app.get('/ideas/:id', (req, res) => {
  const idea = getIdea(db, req.params.id);
  if (!idea) return res.status(404).type('html').send('Not found');
  res.type('html').send(renderIdeaDetailPage(idea, { user: req.user, basePath: BASE_PATH }));
});

// ─── Settings routes ────────────────────────────────────────────────────────

app.get('/settings', (req, res) => {
  const users = db.prepare('SELECT id, username, created_at FROM users ORDER BY created_at').all();
  const apiKeys = listApiKeys(db, req.user.id);
  const webhookConfig = getUserWebhookConfig(db, req.user.id);
  const recentDeliveries = getRecentWebhookDeliveries(db, 10);
  res.type('html').send(renderSettings(users, req.user, { apiKeys, basePath: BASE_PATH, webhookConfig, recentDeliveries }));
});

app.post('/settings/users', async (req, res) => {
  const { username, password } = req.body;
  const users = db.prepare('SELECT id, username, created_at FROM users ORDER BY created_at').all();
  const apiKeys = listApiKeys(db, req.user.id);
  const webhookConfig = getUserWebhookConfig(db, req.user.id);
  const recentDeliveries = getRecentWebhookDeliveries(db, 10);

  if (!username || !password) {
    return res.type('html').send(renderSettings(users, req.user, { apiKeys, error: 'Username and password required.', basePath: BASE_PATH, webhookConfig, recentDeliveries }));
  }

  if (password.length < 6) {
    return res.type('html').send(renderSettings(users, req.user, { apiKeys, error: 'Password must be at least 6 characters.', basePath: BASE_PATH, webhookConfig, recentDeliveries }));
  }

  const existing = getUserByUsername(db, username);
  if (existing) {
    return res.type('html').send(renderSettings(users, req.user, { apiKeys, error: `User "${username}" already exists.`, basePath: BASE_PATH, webhookConfig, recentDeliveries }));
  }

  const hash = await hashPassword(password);
  createUser(db, { id: crypto.randomUUID(), username, passwordHash: hash });

  const updatedUsers = db.prepare('SELECT id, username, created_at FROM users ORDER BY created_at').all();
  res.type('html').send(renderSettings(updatedUsers, req.user, { apiKeys, message: `User "${username}" created.`, basePath: BASE_PATH, webhookConfig, recentDeliveries }));
});

app.post('/settings/password', async (req, res) => {
  const { current_password, new_password } = req.body;
  const users = db.prepare('SELECT id, username, created_at FROM users ORDER BY created_at').all();
  const apiKeys = listApiKeys(db, req.user.id);
  const webhookConfig = getUserWebhookConfig(db, req.user.id);
  const recentDeliveries = getRecentWebhookDeliveries(db, 10);

  if (!current_password || !new_password) {
    return res.type('html').send(renderSettings(users, req.user, { apiKeys, error: 'Both fields required.', basePath: BASE_PATH, webhookConfig, recentDeliveries }));
  }

  const user = getUserByUsername(db, req.user.username);
  if (!(await verifyPassword(current_password, user.password_hash))) {
    return res.type('html').send(renderSettings(users, req.user, { apiKeys, error: 'Current password is incorrect.', basePath: BASE_PATH, webhookConfig, recentDeliveries }));
  }

  if (new_password.length < 6) {
    return res.type('html').send(renderSettings(users, req.user, { apiKeys, error: 'New password must be at least 6 characters.', basePath: BASE_PATH, webhookConfig, recentDeliveries }));
  }

  const hash = await hashPassword(new_password);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);

  res.type('html').send(renderSettings(users, req.user, { apiKeys, message: 'Password updated.', basePath: BASE_PATH, webhookConfig, recentDeliveries }));
});

app.post('/settings/webhook', (req, res) => {
  const { webhook_url, webhook_secret } = req.body;
  const users = db.prepare('SELECT id, username, created_at FROM users ORDER BY created_at').all();
  const apiKeys = listApiKeys(db, req.user.id);

  // Validate URL if provided
  if (webhook_url && !validateCallbackUrl(webhook_url)) {
    const webhookConfig = getUserWebhookConfig(db, req.user.id);
    const recentDeliveries = getRecentWebhookDeliveries(db, 10);
    return res.type('html').send(renderSettings(users, req.user, {
      apiKeys, error: 'Invalid webhook URL. Must be https:// (or http://localhost in dev).',
      basePath: BASE_PATH, webhookConfig, recentDeliveries,
    }));
  }

  // If secret is blank, keep the existing one
  const currentConfig = getUserWebhookConfig(db, req.user.id);
  const effectiveSecret = webhook_secret || currentConfig?.webhook_secret || null;

  updateUserWebhookConfig(db, req.user.id, {
    webhookUrl: webhook_url || null,
    webhookSecret: effectiveSecret,
  });

  const webhookConfig = getUserWebhookConfig(db, req.user.id);
  const recentDeliveries = getRecentWebhookDeliveries(db, 10);
  res.type('html').send(renderSettings(users, req.user, {
    apiKeys, message: 'Webhook settings saved.',
    basePath: BASE_PATH, webhookConfig, recentDeliveries,
  }));
});

// ─── Connections routes ──────────────────────────────────────────────────────

app.get('/connections', (req, res) => {
  const stats = getConnectionStats(db);
  res.type('html').send(renderConnections(stats, { user: req.user, basePath: BASE_PATH }));
});

// ─── Start server ───────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`GapScout server running at http://localhost:${PORT}`);
  if (BASE_PATH) console.log(`Base path: ${BASE_PATH}`);
  console.log(`Data directory: ${DATA_DIR}`);
  console.log(`Max concurrent scans: ${parseInt(process.env.MAX_CONCURRENT_SCANS) || 3}`);
});
