import Database from 'better-sqlite3';
import path from 'node:path';
import crypto from 'node:crypto';

export function initDb(dataDir) {
  const dbPath = path.join(dataDir, 'gapscout.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS scans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      domain TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'quick',
      sources TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      progress_pct INTEGER DEFAULT 0,
      progress_detail TEXT,
      config TEXT,
      pid INTEGER,
      scan_dir TEXT,
      error TEXT,
      created_by TEXT REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_scans_status ON scans(status);
    CREATE INDEX IF NOT EXISTS idx_scans_created_at ON scans(created_at);

    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      scan_id TEXT UNIQUE NOT NULL REFERENCES scans(id),
      claude_session_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES chat_sessions(id),
      user_id TEXT REFERENCES users(id),
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS team_connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_name TEXT NOT NULL,
      first_name TEXT,
      last_name TEXT,
      email TEXT,
      company TEXT,
      company_normalized TEXT,
      position TEXT,
      connected_on TEXT,
      uploaded_by_user_id TEXT REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_connections_member ON team_connections(member_name);
    CREATE INDEX IF NOT EXISTS idx_connections_company ON team_connections(company_normalized);

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      key_hash TEXT NOT NULL,
      key_prefix TEXT NOT NULL,
      name TEXT NOT NULL,
      bot_identity TEXT,
      scopes TEXT NOT NULL DEFAULT '*',
      rate_limit_rpm INTEGER DEFAULT 30,
      last_used_at TEXT,
      expires_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
    CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);

    CREATE TABLE IF NOT EXISTS api_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      api_key_id TEXT REFERENCES api_keys(id),
      user_id TEXT NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      status_code INTEGER,
      bot_identity TEXT,
      ip_address TEXT,
      user_agent TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_audit_created ON api_audit_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_key ON api_audit_log(api_key_id);

    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id TEXT PRIMARY KEY,
      scan_id TEXT NOT NULL,
      callback_url TEXT NOT NULL,
      payload TEXT NOT NULL,
      signature TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      status_code INTEGER,
      attempts INTEGER DEFAULT 0,
      max_attempts INTEGER DEFAULT 5,
      next_retry_at TEXT,
      delivered_at TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_scan ON webhook_deliveries(scan_id);
    CREATE INDEX IF NOT EXISTS idx_webhook_pending ON webhook_deliveries(status, next_retry_at);

    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key TEXT NOT NULL,
      user_id TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      response_status INTEGER,
      response_body TEXT,
      in_flight INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (key, user_id)
    );

    CREATE TABLE IF NOT EXISTS idea_cycles (
      id TEXT PRIMARY KEY,
      team_dna_hash TEXT,
      scans_mined INTEGER DEFAULT 0,
      signals_found INTEGER DEFAULT 0,
      ideas_generated INTEGER DEFAULT 0,
      ideas_passed INTEGER DEFAULT 0,
      idea_scanned_id INTEGER,
      status TEXT DEFAULT 'running',
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS ideas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cycle_id TEXT NOT NULL REFERENCES idea_cycles(id),
      title TEXT NOT NULL,
      slug TEXT NOT NULL,
      summary TEXT,
      problem_statement TEXT,
      demand_brief TEXT,
      team_fit_score REAL DEFAULT 0,
      demand_score REAL DEFAULT 0,
      overall_score REAL DEFAULT 0,
      office_hours_verdict TEXT,
      office_hours_scores TEXT,
      status TEXT DEFAULT 'generated',
      scan_id INTEGER REFERENCES scans(id),
      signals_json TEXT,
      team_fit_json TEXT,
      competitive_landscape TEXT,
      narrowest_wedge TEXT,
      market_for_scan TEXT,
      duplicate_of INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_ideas_cycle ON ideas(cycle_id);
    CREATE INDEX IF NOT EXISTS idx_ideas_status ON ideas(status);
  `);

  // Migration: add webhook columns to users table if missing
  const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (!userCols.includes('webhook_url')) {
    db.exec("ALTER TABLE users ADD COLUMN webhook_url TEXT");
  }
  if (!userCols.includes('webhook_secret')) {
    db.exec("ALTER TABLE users ADD COLUMN webhook_secret TEXT");
  }

  // Migration: add callback_url column to scans table if missing
  const scanCols = db.prepare("PRAGMA table_info(scans)").all().map(c => c.name);
  if (!scanCols.includes('callback_url')) {
    db.exec("ALTER TABLE scans ADD COLUMN callback_url TEXT");
  }

  return db;
}

export function createUser(db, { id, username, passwordHash }) {
  const stmt = db.prepare(
    'INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)'
  );
  stmt.run(id, username, passwordHash);
}

export function getUserByUsername(db, username) {
  const stmt = db.prepare('SELECT * FROM users WHERE username = ?');
  return stmt.get(username);
}

export function createSession(db, { id, userId, expiresAt }) {
  const stmt = db.prepare(
    'INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)'
  );
  stmt.run(id, userId, expiresAt);
}

export function getSession(db, id) {
  const stmt = db.prepare(`
    SELECT
      s.id AS session_id,
      s.user_id,
      s.expires_at,
      s.created_at AS session_created_at,
      u.id AS user_id,
      u.username,
      u.password_hash,
      u.created_at AS user_created_at
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.id = ?
  `);
  const row = stmt.get(id);
  if (!row) return null;
  return {
    session: {
      id: row.session_id,
      user_id: row.user_id,
      expires_at: row.expires_at,
      created_at: row.session_created_at,
    },
    user: {
      id: row.user_id,
      username: row.username,
      password_hash: row.password_hash,
      created_at: row.user_created_at,
    },
  };
}

export function deleteSession(db, id) {
  const stmt = db.prepare('DELETE FROM sessions WHERE id = ?');
  stmt.run(id);
}

export function cleanExpiredSessions(db) {
  const stmt = db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')");
  stmt.run();
}

export function createScan(db, { id, name, domain, mode, sources, config, scanDir, createdBy }) {
  const stmt = db.prepare(`
    INSERT INTO scans (id, name, domain, mode, sources, config, scan_dir, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(id, name, domain, mode || 'quick', sources || null, config || null, scanDir || null, createdBy || null);
}

export function getScan(db, id) {
  const stmt = db.prepare('SELECT * FROM scans WHERE id = ?');
  return stmt.get(id);
}

export function listScans(db, { status, limit = 50, offset = 0 } = {}) {
  let whereClause = '';
  const params = [];

  if (status) {
    whereClause = 'WHERE status = ?';
    params.push(status);
  }

  const countStmt = db.prepare(`SELECT COUNT(*) AS total FROM scans ${whereClause}`);
  const { total } = countStmt.get(...params);

  const dataStmt = db.prepare(
    `SELECT * FROM scans ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  );
  const scans = dataStmt.all(...params, limit, offset);

  return { scans, total };
}

export function updateScan(db, id, fields) {
  const allowed = ['status', 'progress_pct', 'progress_detail', 'pid', 'error', 'started_at', 'completed_at'];
  const columnMap = {
    status: 'status',
    progress_pct: 'progress_pct',
    progress_detail: 'progress_detail',
    pid: 'pid',
    error: 'error',
    started_at: 'started_at',
    completed_at: 'completed_at',
  };

  const setClauses = [];
  const values = [];

  for (const key of allowed) {
    if (key in fields) {
      setClauses.push(`${columnMap[key]} = ?`);
      values.push(fields[key]);
    }
  }

  if (setClauses.length === 0) return;

  values.push(id);
  const stmt = db.prepare(`UPDATE scans SET ${setClauses.join(', ')} WHERE id = ?`);
  stmt.run(...values);
}

export function getRunningScans(db) {
  const stmt = db.prepare("SELECT * FROM scans WHERE status = 'running'");
  return stmt.all();
}

export function getOrCreateChatSession(db, scanId) {
  let session = db.prepare('SELECT * FROM chat_sessions WHERE scan_id = ?').get(scanId);
  if (!session) {
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO chat_sessions (id, scan_id) VALUES (?, ?)').run(id, scanId);
    session = { id, scan_id: scanId, claude_session_id: null, created_at: new Date().toISOString() };
  }
  return session;
}

export function updateChatSessionClaudeId(db, sessionId, claudeSessionId) {
  db.prepare('UPDATE chat_sessions SET claude_session_id = ? WHERE id = ?').run(claudeSessionId, sessionId);
}

export function addChatMessage(db, { sessionId, userId, role, content }) {
  db.prepare('INSERT INTO chat_messages (session_id, user_id, role, content) VALUES (?, ?, ?, ?)').run(sessionId, userId, role, content);
}

export function getChatMessages(db, sessionId, limit = 100) {
  return db.prepare(`
    SELECT cm.*, u.username
    FROM chat_messages cm
    LEFT JOIN users u ON cm.user_id = u.id
    WHERE cm.session_id = ?
    ORDER BY cm.created_at ASC
    LIMIT ?
  `).all(sessionId, limit);
}

export function upsertConnections(db, memberName, connections, userId) {
  db.prepare('DELETE FROM team_connections WHERE member_name = ?').run(memberName);

  const stmt = db.prepare(`
    INSERT INTO team_connections (member_name, first_name, last_name, email, company, company_normalized, position, connected_on, uploaded_by_user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((rows) => {
    for (const r of rows) {
      stmt.run(
        memberName,
        r.firstName || null,
        r.lastName || null,
        r.email || null,
        r.company || null,
        (r.company || '').toLowerCase().trim(),
        r.position || null,
        r.connectedOn || null,
        userId
      );
    }
  });

  insertMany(connections);
}

export function getConnectionStats(db) {
  const members = db.prepare(`
    SELECT member_name, COUNT(*) as count, MAX(created_at) as last_upload
    FROM team_connections
    GROUP BY member_name
    ORDER BY member_name
  `).all();

  const total = db.prepare('SELECT COUNT(*) as total FROM team_connections').get();
  const uniqueCompanies = db.prepare("SELECT COUNT(DISTINCT company_normalized) as count FROM team_connections WHERE company_normalized != ''").get();

  return {
    members,
    totalConnections: total.total,
    uniqueCompanies: uniqueCompanies.count
  };
}

export function deleteConnectionsByMember(db, memberName) {
  db.prepare('DELETE FROM team_connections WHERE member_name = ?').run(memberName);
}

export function getAllConnections(db) {
  return db.prepare('SELECT * FROM team_connections ORDER BY member_name, last_name, first_name').all();
}

export function exportConnectionsForScan(db, memberName) {
  return db.prepare(
    'SELECT first_name, last_name, email, company, position, connected_on FROM team_connections WHERE member_name = ? ORDER BY last_name, first_name'
  ).all(memberName);
}

export function getConnectionMembers(db) {
  return db.prepare('SELECT DISTINCT member_name FROM team_connections ORDER BY member_name').all().map(r => r.member_name);
}

// ─── Idea Cycles ────────────────────────────────────────────────────────────

export function createIdeaCycle(db, id) {
  db.prepare('INSERT INTO idea_cycles (id) VALUES (?)').run(id);
}

export function updateIdeaCycle(db, id, data) {
  const allowed = ['team_dna_hash', 'scans_mined', 'signals_found', 'ideas_generated', 'ideas_passed', 'idea_scanned_id', 'status', 'completed_at', 'error'];
  const setClauses = [];
  const values = [];

  for (const key of allowed) {
    if (key in data) {
      setClauses.push(`${key} = ?`);
      values.push(data[key]);
    }
  }

  if (setClauses.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE idea_cycles SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
}

export function getIdeaCycles(db, limit = 20) {
  return db.prepare('SELECT * FROM idea_cycles ORDER BY started_at DESC LIMIT ?').all(limit);
}

export function getIdeaCycle(db, id) {
  return db.prepare('SELECT * FROM idea_cycles WHERE id = ?').get(id);
}

// ─── Ideas ──────────────────────────────────────────────────────────────────

export function createIdea(db, data) {
  const stmt = db.prepare(`
    INSERT INTO ideas (cycle_id, title, slug, summary, problem_statement, demand_brief,
      team_fit_score, demand_score, overall_score, office_hours_verdict, office_hours_scores,
      status, scan_id, signals_json, team_fit_json, competitive_landscape, narrowest_wedge,
      market_for_scan, duplicate_of)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    data.cycle_id, data.title, data.slug, data.summary || null, data.problem_statement || null,
    data.demand_brief || null, data.team_fit_score || 0, data.demand_score || 0,
    data.overall_score || 0, data.office_hours_verdict || null, data.office_hours_scores || null,
    data.status || 'generated', data.scan_id || null, data.signals_json || null,
    data.team_fit_json || null, data.competitive_landscape || null, data.narrowest_wedge || null,
    data.market_for_scan || null, data.duplicate_of || null
  );
  return result.lastInsertRowid;
}

export function updateIdea(db, id, data) {
  const allowed = ['title', 'slug', 'summary', 'problem_statement', 'demand_brief',
    'team_fit_score', 'demand_score', 'overall_score', 'office_hours_verdict', 'office_hours_scores',
    'status', 'scan_id', 'signals_json', 'team_fit_json', 'competitive_landscape', 'narrowest_wedge',
    'market_for_scan', 'duplicate_of'];
  const setClauses = [];
  const values = [];

  for (const key of allowed) {
    if (key in data) {
      setClauses.push(`${key} = ?`);
      values.push(data[key]);
    }
  }

  if (setClauses.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE ideas SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
}

export function getIdeas(db, { cycleId, status, limit = 50 } = {}) {
  let where = [];
  const params = [];

  if (cycleId) {
    where.push('cycle_id = ?');
    params.push(cycleId);
  }
  if (status) {
    where.push('status = ?');
    params.push(status);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM ideas ${whereClause} ORDER BY overall_score DESC, created_at DESC LIMIT ?`).all(...params, limit);
}

export function getIdea(db, id) {
  return db.prepare('SELECT * FROM ideas WHERE id = ?').get(id);
}

export function getRecentIdeas(db, days = 7) {
  return db.prepare(`SELECT * FROM ideas WHERE created_at >= datetime('now', '-' || ? || ' days') ORDER BY created_at DESC`).all(days);
}

export function dismissIdea(db, id) {
  db.prepare("UPDATE ideas SET status = 'dismissed' WHERE id = ?").run(id);
}

// ─── API Keys ────────────────────────────────────────────────────────────────

export function createApiKey(db, { userId, name, botIdentity, scopes, rateLimitRpm, expiresAt }) {
  const id = crypto.randomUUID();
  const rawKey = 'gsk_live_' + crypto.randomBytes(20).toString('hex'); // 40 hex chars
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const keyPrefix = rawKey.slice(0, 16); // "gsk_live_" + first 7 hex chars

  const stmt = db.prepare(`
    INSERT INTO api_keys (id, user_id, key_hash, key_prefix, name, bot_identity, scopes, rate_limit_rpm, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(id, userId, keyHash, keyPrefix, name, botIdentity || null, scopes || '*', rateLimitRpm || 30, expiresAt || null);

  return { id, key: rawKey, prefix: keyPrefix, name, scopes: scopes || '*', created_at: new Date().toISOString() };
}

export function getApiKeyByHash(db, hash) {
  const stmt = db.prepare(`
    SELECT
      ak.id AS key_id,
      ak.user_id,
      ak.key_hash,
      ak.key_prefix,
      ak.name AS key_name,
      ak.bot_identity,
      ak.scopes,
      ak.rate_limit_rpm,
      ak.last_used_at,
      ak.expires_at,
      ak.revoked_at,
      ak.created_at AS key_created_at,
      u.id AS uid,
      u.username,
      u.password_hash,
      u.created_at AS user_created_at
    FROM api_keys ak
    JOIN users u ON ak.user_id = u.id
    WHERE ak.key_hash = ?
  `);
  const row = stmt.get(hash);
  if (!row) return null;
  return {
    apiKey: {
      id: row.key_id,
      user_id: row.user_id,
      key_hash: row.key_hash,
      key_prefix: row.key_prefix,
      name: row.key_name,
      botIdentity: row.bot_identity,
      scopes: row.scopes,
      rateLimitRpm: row.rate_limit_rpm,
      lastUsedAt: row.last_used_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      createdAt: row.key_created_at,
    },
    user: {
      id: row.uid,
      username: row.username,
      password_hash: row.password_hash,
      created_at: row.user_created_at,
    },
  };
}

export function listApiKeys(db, userId) {
  return db.prepare(`
    SELECT id, key_prefix, name, bot_identity, scopes, rate_limit_rpm, last_used_at, expires_at, revoked_at, created_at
    FROM api_keys
    WHERE user_id = ? AND revoked_at IS NULL
    ORDER BY created_at DESC
  `).all(userId);
}

export function revokeApiKey(db, keyId, userId) {
  const stmt = db.prepare("UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ? AND user_id = ?");
  return stmt.run(keyId, userId);
}

export function touchApiKeyLastUsed(db, keyId) {
  db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(keyId);
}

export function logApiCall(db, { apiKeyId, userId, method, path, statusCode, botIdentity, ipAddress, userAgent }) {
  db.prepare(`
    INSERT INTO api_audit_log (api_key_id, user_id, method, path, status_code, bot_identity, ip_address, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(apiKeyId, userId, method, path, statusCode || null, botIdentity || null, ipAddress || null, userAgent || null);
}

export function cleanOldAuditLogs(db, daysOld) {
  db.prepare("DELETE FROM api_audit_log WHERE created_at < datetime('now', '-' || ? || ' days')").run(daysOld);
}

// ─── Webhook functions ─────────────────────────────────────────────────────

export function createWebhookDelivery(db, { id, scanId, callbackUrl, payload, signature }) {
  db.prepare(
    'INSERT INTO webhook_deliveries (id, scan_id, callback_url, payload, signature) VALUES (?, ?, ?, ?, ?)'
  ).run(id, scanId, callbackUrl, payload, signature || '');
}

export function getWebhookDelivery(db, id) {
  return db.prepare('SELECT * FROM webhook_deliveries WHERE id = ?').get(id);
}

export function getPendingWebhooks(db) {
  return db.prepare(
    "SELECT * FROM webhook_deliveries WHERE status = 'pending' OR (status = 'retrying' AND next_retry_at <= datetime('now'))"
  ).all();
}

export function updateWebhookDelivery(db, id, fields) {
  const allowed = ['status', 'status_code', 'attempts', 'next_retry_at', 'delivered_at', 'error'];
  const setClauses = [];
  const values = [];

  for (const key of allowed) {
    if (key in fields) {
      setClauses.push(`${key} = ?`);
      values.push(fields[key]);
    }
  }

  if (setClauses.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE webhook_deliveries SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
}

export function getUserWebhookConfig(db, userId) {
  const row = db.prepare('SELECT webhook_url, webhook_secret FROM users WHERE id = ?').get(userId);
  return row || { webhook_url: null, webhook_secret: null };
}

export function updateUserWebhookConfig(db, userId, { webhookUrl, webhookSecret }) {
  db.prepare('UPDATE users SET webhook_url = ?, webhook_secret = ? WHERE id = ?').run(webhookUrl || null, webhookSecret || null, userId);
}

export function getRecentWebhookDeliveries(db, limit = 10) {
  return db.prepare('SELECT * FROM webhook_deliveries ORDER BY created_at DESC LIMIT ?').all(limit);
}

// ─── Idempotency keys ──────────────────────────────────────────────────────

export function getIdempotencyKey(db, key, userId) {
  return db.prepare('SELECT * FROM idempotency_keys WHERE key = ? AND user_id = ?').get(key, userId);
}

export function createIdempotencyKey(db, { key, userId, endpoint }) {
  db.prepare(
    'INSERT INTO idempotency_keys (key, user_id, endpoint, in_flight) VALUES (?, ?, ?, 1)'
  ).run(key, userId, endpoint);
}

export function completeIdempotencyKey(db, key, userId, { responseStatus, responseBody }) {
  db.prepare(
    'UPDATE idempotency_keys SET response_status = ?, response_body = ?, in_flight = 0 WHERE key = ? AND user_id = ?'
  ).run(responseStatus, responseBody, key, userId);
}

export function cleanExpiredIdempotencyKeys(db) {
  db.prepare("DELETE FROM idempotency_keys WHERE created_at < datetime('now', '-24 hours')").run();
}
