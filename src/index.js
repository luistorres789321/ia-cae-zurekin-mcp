import 'dotenv/config';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import express from 'express';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { CookieJar } from 'tough-cookie';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE_URL = process.env.CAEZ_BASE_URL;
const USERNAME = process.env.CAEZ_USERNAME;
const PASSWORD = process.env.CAEZ_PASSWORD;
const LOGIN_URL = process.env.CAEZ_LOGIN_URL || BASE_URL;
const LOGIN_ENDPOINT = process.env.CAEZ_LOGIN_ENDPOINT || '/datos_servidor_CAE_ZUREKIN/inicio.aspx';
const DSN = process.env.CAEZ_DSN || 'CAE';
const LOGIN_USER_FIELD = process.env.CAEZ_LOGIN_USER_FIELD || 'username';
const LOGIN_PASSWORD_FIELD = process.env.CAEZ_LOGIN_PASSWORD_FIELD || 'password';
const LOGIN_EXTRA_FIELDS = safeParseJson(process.env.CAEZ_LOGIN_EXTRA_FIELDS, {});
const SEARCH_PATH = process.env.CAEZ_SEARCH_PATH || '';
const PORT = Number(process.env.PORT || 3000);
const MCP_PATH = process.env.MCP_PATH || '/mcp';

if (!BASE_URL) {
  throw new Error('Falta CAEZ_BASE_URL en las variables de entorno.');
}

const TRUSTED_ORIGINS = Array.from(new Set(
  [BASE_URL, LOGIN_URL]
    .filter(Boolean)
    .map((url) => new URL(url).origin)
));

const cookieJar = new CookieJar();
let authenticated = false;
const transports = new Map();

function safeParseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeUrl(input) {
  try {
    return new URL(input, BASE_URL).toString();
  } catch {
    throw new Error('INVALID_URL');
  }
}

function getPathname(input) {
  try {
    return new URL(input, BASE_URL).pathname.toLowerCase();
  } catch {
    return '';
  }
}

function isLikelyLoginUrl(url) {
  const pathname = getPathname(url);
  const loginPathname = getPathname(LOGIN_URL);
  const loginEndpointPathname = getPathname(LOGIN_ENDPOINT);

  return pathname === loginPathname
    || pathname === loginEndpointPathname
    || pathname.includes('login')
    || pathname.includes('signin')
    || pathname.includes('auth');
}

function assertTrustedOrigin(url) {
  const origin = new URL(url).origin;
  if (!TRUSTED_ORIGINS.includes(origin)) {
    throw new Error(
      `UNEXPECTED_ORIGIN: el servidor respondió desde ${origin}, pero este conector solo acepta ${TRUSTED_ORIGINS.join(', ')}`
    );
  }
}

async function getCookieHeader(url) {
  return cookieJar.getCookieString(url);
}

async function storeSetCookie(url, response) {
  const raw = response.headers.raw()['set-cookie'] || [];
  await Promise.all(raw.map((cookie) => cookieJar.setCookie(cookie, url)));
}

async function request(url, options = {}) {
  const finalUrl = normalizeUrl(url);
  const cookieHeader = await getCookieHeader(finalUrl);
  const headers = {
    ...(options.headers || {}),
    ...(cookieHeader ? { cookie: cookieHeader } : {})
  };

  const response = await fetch(finalUrl, {
    redirect: 'follow',
    ...options,
    headers
  });

  assertTrustedOrigin(response.url || finalUrl);
  await storeSetCookie(finalUrl, response);
  return response;
}

function looksLikeLoginPage(html, pageUrl = '') {
  const $ = cheerio.load(html);
  const text = $('body').text().toLowerCase();
  const hasPasswordInput = $('input[type="password"]').length > 0;
  const hasUserInput = $(`input[name="${LOGIN_USER_FIELD}"]`).length > 0
    || $('input[name*="user" i], input[name*="email" i]').length > 0;
  const loginTextDetected = [
    'login',
    'log in',
    'sign in',
    'iniciar sesi',
    'acceder',
    'usuario',
    'contrase',
    'password'
  ].some((token) => text.includes(token));

  return isLikelyLoginUrl(pageUrl) || (hasPasswordInput && (hasUserInput || loginTextDetected));
}

function looksLikeAccessDenied(html) {
  const text = cheerio.load(html)('body').text().toLowerCase();
  return [
    'access denied',
    'forbidden',
    'unauthorized',
    'acceso denegado',
    'no autorizado',
    'permission denied'
  ].some((token) => text.includes(token));
}

function assertAccessiblePage(html, pageUrl) {
  if (looksLikeLoginPage(html, pageUrl)) {
    throw new Error(`AUTH_FAILED: el sitio sigue mostrando la pantalla de login (${pageUrl})`);
  }

  if (looksLikeAccessDenied(html)) {
    throw new Error(`AUTH_FAILED: el sitio devolvió una pantalla de acceso denegado (${pageUrl})`);
  }
}

function buildLoginActionUrl(action) {
  const params = new URLSearchParams({
    accion: action,
    DSN,
    usuario: USERNAME,
    password: PASSWORD,
    ...Object.fromEntries(Object.entries(LOGIN_EXTRA_FIELDS).map(([key, value]) => [key, String(value)]))
  });

  return `${LOGIN_ENDPOINT}?${params.toString()}`;
}

async function runLoginAction(action) {
  const response = await request(buildLoginActionUrl(action), { method: 'GET' });
  if (!response.ok) {
    throw new Error(`AUTH_FAILED: la llamada de login ${action} devolvió ${response.status}`);
  }
  return response.text();
}

async function verifyAuthenticatedBasePage() {
  const baseResponse = await request(BASE_URL, { method: 'GET' });
  if (!baseResponse.ok) {
    throw new Error(`AUTH_FAILED: la página base devolvió ${baseResponse.status}`);
  }

  const baseUrl = baseResponse.url || normalizeUrl(BASE_URL);
  const baseHtml = await baseResponse.text();
  assertAccessiblePage(baseHtml, baseUrl);
  return { baseUrl, baseHtml };
}

async function ensureAuthenticated() {
  if (authenticated) return;
  if (!USERNAME || !PASSWORD) {
    throw new Error('AUTH_FAILED: faltan credenciales en variables de entorno');
  }

  await request(LOGIN_URL, { method: 'GET' });
  await runLoginAction('comprueba_usuario_password');

  try {
    await verifyAuthenticatedBasePage();
    authenticated = true;
    return;
  } catch (primaryError) {
    await runLoginAction('obtener_itinerarios_externos');

    try {
      await verifyAuthenticatedBasePage();
      authenticated = true;
      return;
    } catch {
      throw primaryError;
    }
  }
}

function extractReadableContent(html, pageUrl) {
  const $ = cheerio.load(html);
  $('script, style, noscript').remove();

  const title = $('title').first().text().trim() || $('h1').first().text().trim() || pageUrl;
  const sections = [];

  $('h1, h2, h3').each((_, el) => {
    const heading = $(el).text().trim();
    const texts = [];
    let current = $(el).next();

    while (current.length && !['h1', 'h2', 'h3'].includes(current.get(0)?.tagName)) {
      const text = current.text().trim();
      if (text) texts.push(text);
      current = current.next();
    }

    if (heading || texts.length) {
      sections.push({ heading, text: texts.join('\n\n') });
    }
  });

  const links = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    const label = $(el).text().trim();
    if (!href) return;
    try {
      const url = new URL(href, pageUrl).toString();
      if (url.startsWith(BASE_URL)) {
        links.push({ label: label || url, url });
      }
    } catch {
      // ignore invalid hrefs
    }
  });

  const contentText = $('body').text().replace(/\s+\n/g, '\n').replace(/\n\s+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  return {
    title,
    contentText,
    sections,
    links: dedupeLinks(links)
  };
}

function dedupeLinks(links) {
  const seen = new Set();
  return links.filter((link) => {
    if (seen.has(link.url)) return false;
    seen.add(link.url);
    return true;
  });
}

function extractTables(html) {
  const $ = cheerio.load(html);
  const tables = [];

  $('table').each((_, table) => {
    const headers = [];
    $(table).find('thead th').each((__, th) => headers.push($(th).text().trim()));

    const rows = [];
    $(table).find('tbody tr').each((__, tr) => {
      const row = [];
      $(tr).find('td').each((___, td) => row.push($(td).text().trim()));
      if (row.length) rows.push(row);
    });

    if (headers.length || rows.length) {
      tables.push({ title: null, headers, rows });
    }
  });

  return tables;
}

async function fetchPage(urlOrPath) {
  await ensureAuthenticated();
  const response = await request(urlOrPath, { method: 'GET' });
  if (!response.ok) {
    throw new Error(response.status === 404 ? 'PAGE_NOT_FOUND' : 'INTERNAL_ERROR');
  }
  const finalUrl = response.url || normalizeUrl(urlOrPath);
  const html = await response.text();
  assertAccessiblePage(html, finalUrl);
  return { html, finalUrl };
}

function mcpError(error) {
  const message = error instanceof Error ? error.message : 'INTERNAL_ERROR';
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          error: {
            code: message.split(':')[0],
            message
          }
        }, null, 2)
      }
    ],
    isError: true
  };
}

function createMcpServer() {
  const server = new McpServer({
    name: 'ia-cae-zurekin-mcp',
    version: '1.0.0'
  });

  server.tool(
    'search_pages',
    'Busca contenido dentro de la web interna autenticada.',
    {
      query: z.string(),
      limit: z.number().int().min(1).max(20).default(10),
      section: z.string().optional()
    },
    async ({ query, limit, section }) => {
      try {
        const searchUrl = SEARCH_PATH
          ? `${SEARCH_PATH}${SEARCH_PATH.includes('?') ? '&' : '?'}q=${encodeURIComponent(query)}`
          : section || '/';

        const { html, finalUrl } = await fetchPage(searchUrl);
        const $ = cheerio.load(html);
        const results = [];

        $('a[href]').each((_, el) => {
          if (results.length >= limit) return false;
          const title = $(el).text().trim();
          const href = $(el).attr('href');
          if (!title || !href) return;
          const snippet = $(el).parent().text().trim().slice(0, 240);
          const url = normalizeUrl(href);
          if (!url.startsWith(BASE_URL)) return;
          if (!`${title} ${snippet}`.toLowerCase().includes(query.toLowerCase())) return;
          results.push({
            title,
            url,
            path: new URL(url).pathname,
            snippet,
            score: 0.5
          });
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ results, total: results.length, searched_from: finalUrl }, null, 2)
            }
          ]
        };
      } catch (error) {
        return mcpError(error);
      }
    }
  );

  server.tool(
    'get_page',
    'Obtiene una página concreta del sitio.',
    {
      url: z.string().optional(),
      path: z.string().optional()
    },
    async ({ url, path }) => {
      try {
        if (!url && !path) throw new Error('INVALID_URL');
        const target = url || path;
        const { html, finalUrl } = await fetchPage(target);
        const extracted = extractReadableContent(html, finalUrl);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                title: extracted.title,
                url: finalUrl,
                path: new URL(finalUrl).pathname,
                content_text: extracted.contentText,
                content_markdown: `# ${extracted.title}\n\n${extracted.contentText}`,
                links: extracted.links
              }, null, 2)
            }
          ]
        };
      } catch (error) {
        return mcpError(error);
      }
    }
  );

  server.tool(
    'extract_page_content',
    'Extrae el contenido estructurado de una página.',
    {
      url: z.string(),
      include_tables: z.boolean().default(true),
      include_links: z.boolean().default(true)
    },
    async ({ url, include_tables, include_links }) => {
      try {
        const { html, finalUrl } = await fetchPage(url);
        const extracted = extractReadableContent(html, finalUrl);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                title: extracted.title,
                url: finalUrl,
                sections: extracted.sections,
                tables: include_tables ? extractTables(html) : [],
                links: include_links ? extracted.links : []
              }, null, 2)
            }
          ]
        };
      } catch (error) {
        return mcpError(error);
      }
    }
  );

  server.tool(
    'list_sections',
    'Lista secciones navegables del sitio.',
    {
      root_path: z.string().default('/')
    },
    async ({ root_path }) => {
      try {
        const { html } = await fetchPage(root_path);
        const $ = cheerio.load(html);
        const sections = [];

        $('a[href]').each((_, el) => {
          const title = $(el).text().trim();
          const href = $(el).attr('href');
          if (!title || !href) return;
          const url = normalizeUrl(href);
          if (!url.startsWith(BASE_URL)) return;
          sections.push({
            title,
            path: new URL(url).pathname,
            url
          });
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ sections: dedupeLinks(sections).slice(0, 100) }, null, 2)
            }
          ]
        };
      } catch (error) {
        return mcpError(error);
      }
    }
  );

  return server;
}

function isInitializeRequest(body) {
  return body?.method === 'initialize';
}

async function createTransportSession() {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      transports.set(sessionId, { transport, server });
    }
  });

  transport.onclose = async () => {
    if (transport.sessionId) {
      transports.delete(transport.sessionId);
    }
    await server.close();
  };

  await server.connect(transport);
  return { transport, server };
}

function getSessionId(req) {
  return req.header('mcp-session-id') || req.header('Mcp-Session-Id') || null;
}

async function startHttpServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', async (_req, res) => {
    try {
      await ensureAuthenticated();
      res.json({ ok: true, authenticated: true, base_url: BASE_URL, mcp_path: MCP_PATH });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : 'INTERNAL_ERROR',
        base_url: BASE_URL,
        mcp_path: MCP_PATH
      });
    }
  });

  app.get('/', (_req, res) => {
    res.json({
      name: 'ia-cae-zurekin-mcp',
      status: 'ok',
      endpoint: MCP_PATH,
      healthcheck: '/health'
    });
  });

  app.get(MCP_PATH, (_req, res) => {
    res.status(405).json({
      error: {
        code: 'METHOD_NOT_ALLOWED',
        message: `Usa POST ${MCP_PATH} para las peticiones MCP.`
      }
    });
  });

  app.post(MCP_PATH, async (req, res) => {
    try {
      const sessionId = getSessionId(req);
      let session = sessionId ? transports.get(sessionId) : null;

      if (!session) {
        if (sessionId) {
          res.status(404).json({
            error: {
              code: 'SESSION_NOT_FOUND',
              message: 'La sesión MCP no existe o ha caducado.'
            }
          });
          return;
        }

        if (!isInitializeRequest(req.body)) {
          res.status(400).json({
            error: {
              code: 'INVALID_REQUEST',
              message: 'La primera petición MCP debe ser initialize.'
            }
          });
          return;
        }

        session = await createTransportSession();
      }

      await session.transport.handleRequest(req, res, req.body);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'INTERNAL_ERROR';
      if (!res.headersSent) {
        res.status(500).json({
          error: {
            code: 'INTERNAL_ERROR',
            message
          }
        });
      }
    }
  });

  app.delete(MCP_PATH, async (req, res) => {
    try {
      const sessionId = getSessionId(req);
      const session = sessionId ? transports.get(sessionId) : null;

      if (!session) {
        res.status(404).json({
          error: {
            code: 'SESSION_NOT_FOUND',
            message: 'No se encontró la sesión MCP indicada.'
          }
        });
        return;
      }

      await session.transport.handleRequest(req, res);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'INTERNAL_ERROR';
      if (!res.headersSent) {
        res.status(500).json({
          error: {
            code: 'INTERNAL_ERROR',
            message
          }
        });
      }
    }
  });

  app.use((_req, res) => {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: `Ruta no encontrada. Usa ${MCP_PATH} para MCP y /health para comprobar el servidor.`
      }
    });
  });

  const httpServer = http.createServer(app);
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`IA CAE Zurekin MCP escuchando en http://0.0.0.0:${PORT}${MCP_PATH}`);
  });
}

async function start() {
  if (process.env.PORT) {
    await startHttpServer();
    return;
  }

  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

await start();