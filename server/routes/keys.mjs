import { Router } from 'express';
import { createApiKey, listApiKeys, revokeApiKey } from '../db.mjs';

export function createKeysRouter(db) {
  const router = Router();

  // POST / — Create new API key
  router.post('/', (req, res) => {
    try {
      const { name, botIdentity, scopes, rateLimitRpm, expiresAt } = req.body;

      if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'Key name is required' });
      }

      const result = createApiKey(db, {
        userId: req.user.id,
        name: name.trim(),
        botIdentity: botIdentity || null,
        scopes: scopes || '*',
        rateLimitRpm: rateLimitRpm || 30,
        expiresAt: expiresAt || null,
      });

      return res.json({
        id: result.id,
        key: result.key,
        name: result.name,
        prefix: result.prefix,
        scopes: result.scopes,
        created_at: result.created_at,
      });
    } catch (err) {
      console.error('Error creating API key:', err);
      return res.status(500).json({ error: 'Failed to create API key' });
    }
  });

  // GET / — List keys for current user
  router.get('/', (req, res) => {
    try {
      const keys = listApiKeys(db, req.user.id);
      return res.json({
        keys: keys.map(k => ({
          id: k.id,
          prefix: k.key_prefix,
          name: k.name,
          botIdentity: k.bot_identity,
          scopes: k.scopes,
          rateLimitRpm: k.rate_limit_rpm,
          lastUsedAt: k.last_used_at,
          createdAt: k.created_at,
        })),
      });
    } catch (err) {
      console.error('Error listing API keys:', err);
      return res.status(500).json({ error: 'Failed to list API keys' });
    }
  });

  // DELETE /:id — Revoke a key
  router.delete('/:id', (req, res) => {
    try {
      const result = revokeApiKey(db, req.params.id, req.user.id);
      if (result.changes === 0) {
        return res.status(404).json({ error: 'API key not found' });
      }
      return res.json({ ok: true });
    } catch (err) {
      console.error('Error revoking API key:', err);
      return res.status(500).json({ error: 'Failed to revoke API key' });
    }
  });

  return router;
}
