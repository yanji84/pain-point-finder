/**
 * OpenAPI 3.1 spec for the GapScout API.
 */

const errorSchema = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Machine-readable error code' },
        message: { type: 'string', description: 'Human-readable description' },
        request_id: { type: 'string', format: 'uuid', description: 'Correlation ID for this request' },
      },
      required: ['code', 'message', 'request_id'],
    },
  },
  required: ['error'],
};

const scanObject = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    domain: { type: 'string' },
    mode: { type: 'string', enum: ['quick', 'full'] },
    sources: { type: 'string', nullable: true },
    status: { type: 'string', enum: ['queued', 'running', 'completed', 'failed', 'cancelled'] },
    progress_pct: { type: 'integer', minimum: 0, maximum: 100 },
    progress_detail: { type: 'string', nullable: true },
    error: { type: 'string', nullable: true },
    created_at: { type: 'string', format: 'date-time' },
    started_at: { type: 'string', format: 'date-time', nullable: true },
    completed_at: { type: 'string', format: 'date-time', nullable: true },
  },
};

const reportSummary = {
  type: 'object',
  properties: {
    scan_id: { type: 'string', format: 'uuid' },
    market: { type: 'string' },
    generated_at: { type: 'string', format: 'date-time' },
    schema_version: { type: 'string' },
    competitors: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          trust_score: { type: 'number', nullable: true },
          weaknesses_count: { type: 'integer' },
        },
      },
    },
    opportunities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          rank: { type: 'integer' },
          title: { type: 'string' },
          score: { type: 'number', nullable: true },
          gap_type: { type: 'string' },
          evidence_count: { type: 'integer' },
        },
      },
    },
    top_gaps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          category: { type: 'string' },
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
          affected_competitors: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    meta: {
      type: 'object',
      properties: {
        sources_scanned: { type: 'integer', nullable: true },
        data_points: { type: 'integer', nullable: true },
        iteration_count: { type: 'integer', nullable: true },
      },
    },
  },
};

const ideaObject = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    title: { type: 'string' },
    problem_statement: { type: 'string', nullable: true },
    market_for_scan: { type: 'string', nullable: true },
    status: { type: 'string' },
    score: { type: 'number', nullable: true },
    created_at: { type: 'string', format: 'date-time' },
  },
};

export function getOpenApiSpec() {
  return {
    openapi: '3.1.0',
    info: {
      title: 'GapScout API',
      description: 'Market intelligence engine API. Maps competitors, mines weaknesses, identifies whitespace, and scores opportunities.',
      version: '1.0.0',
    },
    servers: [{ url: '/' }],
    security: [{ bearerAuth: [] }, { cookieAuth: [] }],
    paths: {
      '/api/health': {
        get: {
          summary: 'Health check',
          operationId: 'getHealth',
          security: [],
          tags: ['System'],
          responses: {
            200: {
              description: 'Service is healthy',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      status: { type: 'string', example: 'ok' },
                      version: { type: 'string', example: '1.0.0' },
                      api_spec: { type: 'string', example: '/api/openapi.json' },
                      mcp_endpoint: { type: 'string', example: '/mcp' },
                      timestamp: { type: 'string', format: 'date-time' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/.well-known/mcp.json': {
        get: {
          summary: 'MCP server discovery',
          operationId: 'getMcpDiscovery',
          security: [],
          tags: ['System'],
          responses: {
            200: {
              description: 'MCP server metadata for bot onboarding',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      mcp_endpoint: { type: 'string', example: '/mcp' },
                      transport: { type: 'string', example: 'streamable-http' },
                      auth: {
                        type: 'object',
                        properties: {
                          type: { type: 'string', example: 'bearer' },
                          token_url: { type: 'string', example: '/api/auth/token' },
                          key_management: { type: 'string', example: '/api/keys' },
                          instructions: { type: 'string' },
                        },
                      },
                      capabilities: { type: 'array', items: { type: 'string' } },
                      tools_count: { type: 'integer' },
                      server_info: {
                        type: 'object',
                        properties: {
                          name: { type: 'string' },
                          version: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/api/auth/token': {
        post: {
          summary: 'Machine login — exchange credentials for a bearer token',
          operationId: 'createToken',
          security: [],
          tags: ['Auth'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['username', 'password'],
                  properties: {
                    username: { type: 'string' },
                    password: { type: 'string' },
                    key_name: { type: 'string', description: 'Optional human-readable name for the API key' },
                    bot_identity: { type: 'string', nullable: true, description: 'Optional bot identity label' },
                  },
                },
              },
            },
          },
          responses: {
            201: {
              description: 'Bearer token created',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      token: { type: 'string', description: 'Bearer token (API key)' },
                      token_type: { type: 'string', example: 'bearer' },
                      key_id: { type: 'string', format: 'uuid' },
                      key_prefix: { type: 'string' },
                      scopes: { type: 'string', example: '*' },
                      mcp_endpoint: { type: 'string', example: '/mcp' },
                      usage: { type: 'string' },
                    },
                  },
                },
              },
            },
            400: { description: 'Missing username or password', content: { 'application/json': { schema: errorSchema } } },
            401: { description: 'Invalid credentials', content: { 'application/json': { schema: errorSchema } } },
          },
        },
      },
      '/api/scans': {
        post: {
          summary: 'Create and start a scan',
          operationId: 'createScan',
          tags: ['Scans'],
          parameters: [
            { name: 'Idempotency-Key', in: 'header', schema: { type: 'string' }, description: 'Idempotency key to prevent duplicate scan creation' },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['domain'],
                  properties: {
                    name: { type: 'string', description: 'Display name for the scan' },
                    domain: { type: 'string', description: 'Market or domain to scan', example: 'project management tools' },
                    sources: { type: 'string', description: 'Comma-separated source list, or "all"', example: 'all' },
                    mode: { type: 'string', enum: ['quick', 'full'], default: 'full', description: 'quick (~5 min CLI) or full (~1-4h orchestrator)' },
                    timeout: { type: 'integer', description: 'Timeout in ms' },
                  },
                },
              },
            },
          },
          responses: {
            201: {
              description: 'Scan created',
              content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, status: { type: 'string', example: 'queued' } } } } },
            },
            409: { description: 'Idempotent conflict', content: { 'application/json': { schema: errorSchema } } },
            500: { description: 'Internal error', content: { 'application/json': { schema: errorSchema } } },
          },
        },
        get: {
          summary: 'List scans',
          operationId: 'listScans',
          tags: ['Scans'],
          parameters: [
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['queued', 'running', 'completed', 'failed', 'cancelled'] } },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
            { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
          ],
          responses: {
            200: {
              description: 'Scan list',
              content: { 'application/json': { schema: { type: 'object', properties: { scans: { type: 'array', items: scanObject }, total: { type: 'integer' } } } } },
            },
            500: { description: 'Internal error', content: { 'application/json': { schema: errorSchema } } },
          },
        },
      },
      '/api/scans/{id}': {
        get: {
          summary: 'Get scan detail with live progress',
          operationId: 'getScan',
          tags: ['Scans'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            200: {
              description: 'Scan detail. When status is "running", Retry-After and X-Estimated-Completion headers are set.',
              headers: {
                'Retry-After': { schema: { type: 'integer' }, description: 'Seconds to wait before polling again (120 if < 50%, 30 if >= 50%)' },
                'X-Estimated-Completion': { schema: { type: 'string', format: 'date-time' }, description: 'Estimated completion time' },
              },
              content: { 'application/json': { schema: scanObject } },
            },
            404: { description: 'Scan not found', content: { 'application/json': { schema: errorSchema } } },
          },
        },
        delete: {
          summary: 'Cancel a running or queued scan',
          operationId: 'cancelScan',
          tags: ['Scans'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            200: { description: 'Scan cancelled', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string', example: 'cancelled' } } } } } },
            404: { description: 'Scan not found', content: { 'application/json': { schema: errorSchema } } },
          },
        },
      },
      '/api/scans/{id}/events': {
        get: {
          summary: 'SSE stream for live scan progress and log lines',
          operationId: 'scanEvents',
          tags: ['Scans'],
          'x-bot-recommended': false,
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            200: {
              description: 'Server-Sent Events stream. Events: progress, logs, done.',
              content: { 'text/event-stream': { schema: { type: 'string' } } },
            },
            404: { description: 'Scan not found', content: { 'application/json': { schema: errorSchema } } },
          },
        },
      },
      '/api/scans/{id}/logs': {
        get: {
          summary: 'Get historical log lines for a scan',
          operationId: 'getScanLogs',
          tags: ['Scans'],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'cursor', in: 'query', schema: { type: 'integer', default: 0 }, description: 'Start from this log cursor position' },
          ],
          responses: {
            200: {
              description: 'Log lines',
              content: { 'application/json': { schema: { type: 'object', properties: { lines: { type: 'array', items: { type: 'object', properties: { ts: { type: 'integer' }, text: { type: 'string' } } } }, cursor: { type: 'integer' } } } } },
            },
            404: { description: 'Scan not found', content: { 'application/json': { schema: errorSchema } } },
          },
        },
      },
      '/api/scans/{id}/artifacts': {
        get: {
          summary: 'List scan output files (JSON artifacts)',
          operationId: 'listArtifacts',
          tags: ['Scans'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            200: { description: 'Artifact list', content: { 'application/json': { schema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } } } } } } },
            404: { description: 'Scan not found', content: { 'application/json': { schema: errorSchema } } },
          },
        },
      },
      '/api/scans/{id}/artifacts/{filename}': {
        get: {
          summary: 'Download a specific scan artifact',
          operationId: 'getArtifact',
          tags: ['Scans'],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'filename', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            200: { description: 'Artifact content', content: { 'application/json': { schema: { type: 'object' } } } },
            400: { description: 'Invalid filename', content: { 'application/json': { schema: errorSchema } } },
            404: { description: 'Scan or file not found', content: { 'application/json': { schema: errorSchema } } },
          },
        },
      },
      '/api/reports/{id}': {
        get: {
          summary: 'Get full report JSON for a scan',
          operationId: 'getReport',
          tags: ['Reports'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            200: { description: 'Full report data', content: { 'application/json': { schema: { type: 'object', description: 'Report structure varies by scan mode (quick vs full)' } } } },
            404: { description: 'Scan or report not found', content: { 'application/json': { schema: errorSchema } } },
          },
        },
      },
      '/api/reports/{id}/html': {
        get: {
          summary: 'Get report as a rendered HTML page',
          operationId: 'getReportHtml',
          tags: ['Reports'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            200: { description: 'HTML report', content: { 'text/html': { schema: { type: 'string' } } } },
            404: { description: 'Scan or report not found', content: { 'text/html': { schema: { type: 'string' } } } },
            422: { description: 'Insufficient data for HTML generation', content: { 'text/html': { schema: { type: 'string' } } } },
          },
        },
      },
      '/api/reports/{id}/summary': {
        get: {
          summary: 'Get a compact, flattened report summary',
          operationId: 'getReportSummary',
          tags: ['Reports'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            200: { description: 'Report summary', content: { 'application/json': { schema: reportSummary } } },
            404: { description: 'Scan or report not found', content: { 'application/json': { schema: errorSchema } } },
          },
        },
      },
      '/api/scans/{scanId}/chat': {
        post: {
          summary: 'Send a chat message about a scan',
          operationId: 'sendChatMessage',
          tags: ['Chat'],
          parameters: [{ name: 'scanId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['message'], properties: { message: { type: 'string' } } } } },
          },
          responses: {
            200: {
              description: 'AI response',
              content: { 'application/json': { schema: { type: 'object', properties: { role: { type: 'string', example: 'assistant' }, content: { type: 'string' }, ok: { type: 'boolean' } } } } },
            },
            400: { description: 'Message required', content: { 'application/json': { schema: errorSchema } } },
            404: { description: 'Scan not found', content: { 'application/json': { schema: errorSchema } } },
          },
        },
        get: {
          summary: 'Get chat history for a scan',
          operationId: 'getChatHistory',
          tags: ['Chat'],
          parameters: [{ name: 'scanId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            200: {
              description: 'Chat history',
              content: { 'application/json': { schema: { type: 'object', properties: { session: { type: 'object' }, messages: { type: 'array', items: { type: 'object', properties: { role: { type: 'string' }, content: { type: 'string' }, created_at: { type: 'string', format: 'date-time' } } } } } } } },
            },
            404: { description: 'Scan not found', content: { 'application/json': { schema: errorSchema } } },
          },
        },
      },
      '/api/connections/upload': {
        post: {
          summary: 'Upload LinkedIn connections CSV for a team member',
          operationId: 'uploadConnections',
          tags: ['Connections'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['memberName', 'csvContent'],
                  properties: {
                    memberName: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,50}$' },
                    csvContent: { type: 'string', description: 'Raw CSV content from LinkedIn export' },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'Upload successful', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, memberName: { type: 'string' }, count: { type: 'integer' } } } } } },
            400: { description: 'Invalid input', content: { 'application/json': { schema: errorSchema } } },
          },
        },
      },
      '/api/connections': {
        get: {
          summary: 'List team members with connection counts',
          operationId: 'listConnections',
          tags: ['Connections'],
          responses: {
            200: {
              description: 'Connection stats',
              content: { 'application/json': { schema: { type: 'object', properties: { members: { type: 'array', items: { type: 'object', properties: { member_name: { type: 'string' }, count: { type: 'integer' }, last_upload: { type: 'string', format: 'date-time' } } } }, totalConnections: { type: 'integer' }, uniqueCompanies: { type: 'integer' } } } } },
            },
          },
        },
      },
      '/api/connections/{memberName}': {
        delete: {
          summary: 'Delete all connections for a team member',
          operationId: 'deleteConnections',
          tags: ['Connections'],
          parameters: [{ name: 'memberName', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'Deleted', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, deleted: { type: 'string' } } } } } },
            400: { description: 'Invalid memberName', content: { 'application/json': { schema: errorSchema } } },
          },
        },
      },
      '/api/ideas': {
        get: {
          summary: 'List ideas',
          operationId: 'listIdeas',
          tags: ['Ideas'],
          parameters: [
            { name: 'cycle_id', in: 'query', schema: { type: 'string' } },
            { name: 'status', in: 'query', schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
          ],
          responses: {
            200: { description: 'Idea list', content: { 'application/json': { schema: { type: 'object', properties: { ideas: { type: 'array', items: ideaObject } } } } } },
          },
        },
      },
      '/api/ideas/{id}': {
        get: {
          summary: 'Get a single idea',
          operationId: 'getIdea',
          tags: ['Ideas'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            200: { description: 'Idea detail', content: { 'application/json': { schema: ideaObject } } },
            404: { description: 'Idea not found', content: { 'application/json': { schema: errorSchema } } },
          },
        },
      },
      '/api/ideas/{id}/dismiss': {
        post: {
          summary: 'Dismiss an idea',
          operationId: 'dismissIdea',
          tags: ['Ideas'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            200: { description: 'Idea dismissed', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, id: { type: 'string' }, status: { type: 'string', example: 'dismissed' } } } } } },
            404: { description: 'Idea not found', content: { 'application/json': { schema: errorSchema } } },
          },
        },
      },
      '/api/ideas/{id}/scan': {
        post: {
          summary: 'Trigger a full GapScout scan for an idea',
          operationId: 'scanIdea',
          tags: ['Ideas'],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'Idempotency-Key', in: 'header', schema: { type: 'string' }, description: 'Idempotency key to prevent duplicate scan triggers' },
          ],
          responses: {
            200: { description: 'Scan triggered', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, ideaId: { type: 'string' }, scanId: { type: 'string' }, status: { type: 'string', example: 'scanning' } } } } } },
            400: { description: 'Idea has no market_for_scan', content: { 'application/json': { schema: errorSchema } } },
            404: { description: 'Idea not found', content: { 'application/json': { schema: errorSchema } } },
            409: { description: 'Idempotent conflict', content: { 'application/json': { schema: errorSchema } } },
          },
        },
      },
      '/api/keys': {
        post: {
          summary: 'Create a new API key',
          operationId: 'createApiKey',
          tags: ['Keys'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name'],
                  properties: {
                    name: { type: 'string', description: 'Human-readable name for the key' },
                    botIdentity: { type: 'string', nullable: true, description: 'Optional bot identity label' },
                    scopes: { type: 'string', default: '*', description: 'Comma-separated scopes (e.g. "scans:read,reports:read") or "*" for all' },
                    rateLimitRpm: { type: 'integer', default: 30, description: 'Rate limit in requests per minute' },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: 'API key created. The `key` field is only returned once.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      id: { type: 'string', format: 'uuid' },
                      key: { type: 'string', description: 'The full API key (only shown once)' },
                      name: { type: 'string' },
                      prefix: { type: 'string' },
                      scopes: { type: 'string' },
                      created_at: { type: 'string', format: 'date-time' },
                    },
                  },
                },
              },
            },
            400: { description: 'Invalid input', content: { 'application/json': { schema: errorSchema } } },
          },
        },
        get: {
          summary: 'List API keys for the current user',
          operationId: 'listApiKeys',
          tags: ['Keys'],
          responses: {
            200: {
              description: 'List of API keys (secrets are not included)',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      keys: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            id: { type: 'string', format: 'uuid' },
                            prefix: { type: 'string' },
                            name: { type: 'string' },
                            botIdentity: { type: 'string', nullable: true },
                            scopes: { type: 'string' },
                            rateLimitRpm: { type: 'integer' },
                            lastUsedAt: { type: 'string', format: 'date-time', nullable: true },
                            createdAt: { type: 'string', format: 'date-time' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/api/keys/{id}': {
        delete: {
          summary: 'Revoke an API key',
          operationId: 'revokeApiKey',
          tags: ['Keys'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            200: { description: 'Key revoked', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } } },
            404: { description: 'API key not found', content: { 'application/json': { schema: errorSchema } } },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Bearer token authentication',
        },
        cookieAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: 'gapscout_sid',
          description: 'Session cookie set after login',
        },
      },
      schemas: {
        Error: errorSchema,
        Scan: scanObject,
        ReportSummary: reportSummary,
        Idea: ideaObject,
      },
    },
  };
}
