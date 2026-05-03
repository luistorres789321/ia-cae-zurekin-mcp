import 'dotenv/config';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import express from 'express';
import * as cheerio from 'cheerio';
import { chromium } from 'playwright';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE_URL = process.env.CAEZ_BASE_URL;
const LOGIN_URL = process.env.CAEZ_LOGIN_URL || BASE_URL;
const USERNAME = process.env.CAEZ_USERNAME;
const PASSWORD = process.env.CAEZ_PASSWORD;

const USERNAME_SELECTOR = process.env.CAEZ_USERNAME_SELECTOR || '#caez-usuario';
const PASSWORD_SELECTOR = process.env.CAEZ_PASSWORD_SELECTOR || '#caez-password';
const SUBMIT_SELECTOR = process.env.CAEZ_SUBMIT_SELECTOR || '#caez-login-submit';

const SEARCH_PATH = process.env.CAEZ_SEARCH_PATH || '/inicio/itinerarios';
const SEARCH_APPEND_QUERY = process.env.CAEZ_SEARCH_APPEND_QUERY === 'true';
const LOGIN_SUCCESS_URL = process.env.CAEZ_LOGIN_SUCCESS_URL || '**/inicio/itinerarios**';
const HEADLESS = process.env.CAEZ_HEADLESS !== 'false';
const TIMEOUT_MS = Number(process.env.CAEZ_TIMEOUT_MS || 30000);

const PORT = Number(process.env.PORT || 3000);
const MCP_PATH = process.env.MCP_PATH || '/mcp';

if (!BASE_URL) {
  throw new Error('Falta CAEZ_BASE_URL en las variables de entorno.');
}

const TRUSTED_ORIGINS = Array.from(new Set(
  [BASE_URL, LOGIN_URL].filter(Boolean).map((url) => new URL(url).origin)
));

let browser = null;
let browserContext = null;
let authenticated = false;
const transports = new Map();

function createDetailedError(code, message, details = {}) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  error.details = details;
  return error;
}

function summarizeText(text, maxLength = 500) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function normalizeUrl(input = '') {
  const base = new URL(BASE_URL);

  if (!input) return BASE_URL;

  if (/^https?:\/\//i.test(input)) {
    return new URL(input).toString();
  }

  if (input.startsWith('/')) {
    const basePath = trimTrailingSlash(base.pathname);
    return `${base.origin}${basePath}${input}`;
  }

  const baseWithSlash = BASE_URL.endsWith('/') ? BASE_URL : `${BASE_URL}/`;
  return new URL(input, baseWithSlash).toString();
}

function assertTrustedOrigin(url) {
  const origin = new URL(url).origin;
  if (!TRUSTED_ORIGINS.includes(origin)) {
    throw createDetailedError(
      'UNEXPECTED_ORIGIN',
      `respuesta desde origen no permitido: ${origin}`,
      { origin, trusted_origins: TRUSTED_ORIGINS }
    );
  }
}

async function getBrowserContext() {
  if (!browser) {
    browser = await chromium.launch({ headless: HEADLESS });
  }

  if (!browserContext) {
    browserContext = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1365, height: 900 }
    });
  }

  return browserContext;
}

async function newPage() {
  const context = await getBrowserContext();
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT_MS);
  return page;
}

async function safeGoto(page, urlOrPath, contextLabel) {
  const url = normalizeUrl(urlOrPath);
  const response = await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: TIMEOUT_MS
  });

  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  assertTrustedOrigin(page.url());

  if (response && !response.ok()) {
    const body = await response.text().catch(() => '');
    throw createDetailedError(
      'PAGE_HTTP_ERROR',
      `${contextLabel} devolvió ${response.status()}`,
      {
        status: response.status(),
        url: page.url(),
        body_excerpt: summarizeText(body)
      }
    );
  }

  return response;
}

function looksLikeLoginPage(html) {
  const $ = cheerio.load(html);
  const bodyText = $('body').text().toLowerCase();

  const hasConfiguredUser = USERNAME_SELECTOR.startsWith('#')
    ? $(USERNAME_SELECTOR).length > 0
    : false;

  const hasConfiguredPassword = PASSWORD_SELECTOR.startsWith('#')
    ? $(PASSWORD_SELECTOR).length > 0
    : false;

  const hasPasswordInput = $('input[type="password"]').length > 0;
  const loginTextDetected = [
    'login',
    'log in',
    'sign in',
    'iniciar sesi',
    'acceder',
    'usuario',
    'contrase',
    'password'
  ].some((token) => bodyText.includes(token));

  return (hasConfiguredUser && hasConfiguredPassword) || (hasPasswordInput && loginTextDetected);
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
  if (looksLikeLoginPage(html)) {
    throw createDetailedError(
      'AUTH_FAILED',
      `el sitio sigue mostrando la pantalla de login (${pageUrl})`,
      { page_url: pageUrl }
    );
  }

  if (looksLikeAccessDenied(html)) {
    throw createDetailedError(
      'AUTH_FAILED',
      `el sitio devolvió una pantalla de acceso denegado (${pageUrl})`,
      { page_url: pageUrl }
    );
  }
}

async function ensureAuthenticated() {
  if (authenticated) return;

  if (!USERNAME || !PASSWORD) {
    throw createDetailedError(
      'AUTH_FAILED',
      'faltan credenciales en variables de entorno',
      {
        username_present: Boolean(USERNAME),
        password_present: Boolean(PASSWORD)
      }
    );
  }

  const page = await newPage();
  const attempts = [];

  try {
    await safeGoto(page, LOGIN_URL, 'la página de login');

    attempts.push({
      step: 'open_login_page',
      url: page.url()
    });

    await page.waitForSelector(USERNAME_SELECTOR, { timeout: TIMEOUT_MS });
    await page.waitForSelector(PASSWORD_SELECTOR, { timeout: TIMEOUT_MS });
    await page.waitForSelector(SUBMIT_SELECTOR, { timeout: TIMEOUT_MS });

    await page.fill(USERNAME_SELECTOR, USERNAME);
    await page.fill(PASSWORD_SELECTOR, PASSWORD);

    const loginResponsePromise = page.waitForResponse(
      (response) => {
        const url = response.url();
        return url.includes('accion=comprueba_usuario_password')
          || url.includes('accion=obtener_itinerarios_externos');
      },
      { timeout: 15000 }
    ).catch(() => null);

    await page.click(SUBMIT_SELECTOR);

    const loginResponse = await loginResponsePromise;
    if (loginResponse && !loginResponse.ok()) {
      const body = await loginResponse.text().catch(() => '');
      throw createDetailedError(
        loginResponse.status() === 500 ? 'AUTH_HTTP_500' : 'AUTH_HTTP_ERROR',
        `la petición interna de login devolvió ${loginResponse.status()}`,
        {
          status: loginResponse.status(),
          url: loginResponse.url(),
          body_excerpt: summarizeText(body)
        }
      );
    }

    await page.waitForURL(LOGIN_SUCCESS_URL, { timeout: TIMEOUT_MS }).catch(async () => {
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    });

    const html = await page.content();
    assertAccessiblePage(html, page.url());

    authenticated = true;
  } catch (error) {
    attempts.push({
      step: 'form_login',
      result: 'error',
      error: error instanceof Error ? error.message : 'INTERNAL_ERROR'
    });

    throw createDetailedError(
      error?.code || 'AUTH_FAILED',
      'no se pudo completar el login por formulario',
      {
        login_url: LOGIN_URL,
        username_selector: USERNAME_SELECTOR,
        password_selector: PASSWORD_SELECTOR,
        submit_selector: SUBMIT_SELECTOR,
        attempts,
        upstream: error?.details || null
      }
    );
  } finally {
    await page.close().catch(() => {});
  }
}

async function fetchPage(urlOrPath) {
  await ensureAuthenticated();

  const page = await newPage();

  try {
    await safeGoto(page, urlOrPath || BASE_URL, 'la página solicitada');

    const finalUrl = page.url();
    const html = await page.content();
    const visibleText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');

    assertAccessiblePage(html, finalUrl);

    return { html, finalUrl, visibleText };
  } finally {
    await page.close().catch(() => {});
  }
}

function getSnippetAround(text, query, maxLength = 260) {
  const normalizedText = String(text || '');
  const normalizedQuery = String(query || '').toLowerCase();
  const index = normalizedText.toLowerCase().indexOf(normalizedQuery);

  if (index < 0) {
    return summarizeText(normalizedText, maxLength);
  }

  const start = Math.max(0, index - 90);
  const end = Math.min(normalizedText.length, index + normalizedQuery.length + 170);
  return summarizeText(normalizedText.slice(start, end), maxLength);
}

function buildSearchUrl(query, section) {
  const baseSearch = section || SEARCH_PATH || '/';

  if (baseSearch.includes('{query}')) {
    return baseSearch.replace('{query}', encodeURIComponent(query));
  }

  if (!SEARCH_APPEND_QUERY) {
    return baseSearch;
  }

  const separator = baseSearch.includes('?') ? '&' : '?';
  return `${baseSearch}${separator}q=${encodeURIComponent(query)}`;
}

function extractReadableContent(html, pageUrl, visibleText = '') {
  const $ = cheerio.load(html);
  $('script, style, noscript').remove();

  const title = $('title').first().text().trim()
    || $('h1').first().text().trim()
    || pageUrl;

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
      const url = normalizeUrl(href);
      if (url.startsWith(trimTrailingSlash(BASE_URL))) {
        links.push({ label: label || url, url });
      }
    } catch {
      // Ignora enlaces inválidos.
    }
  });

  const contentText = visibleText
    || $('body').text().replace(/\s+\n/g, '\n').replace(/\n\s+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  return {
    title,
    contentText,
    sections,
    links: dedupeLinks(links)
  };
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

function dedupeLinks(links) {
  const seen = new Set();

  return links.filter((link) => {
    if (!link?.url || seen.has(link.url)) return false;
    seen.add(link.url);
    return true;
  });
}

function mcpError(error) {
  const message = error instanceof Error ? error.message : 'INTERNAL_ERROR';
  const code = error?.code || message.split(':')[0];

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          error: {
            code,
            message,
            details: error?.details || null
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
        const searchUrl = buildSearchUrl(query, section);
        const { html, finalUrl, visibleText } = await fetchPage(searchUrl);
        const extracted = extractReadableContent(html, finalUrl, visibleText);
        const results = [];

        if (extracted.contentText.toLowerCase().includes(query.toLowerCase())) {
          results.push({
            title: extracted.title,
            url: finalUrl,
            path: new URL(finalUrl).pathname,
            snippet: getSnippetAround(extracted.contentText, query),
            score: 1
          });
        }

        for (const link of extracted.links) {
          if (results.length >= limit) break;

          const haystack = `${link.label} ${link.url}`.toLowerCase();
          if (!haystack.includes(query.toLowerCase())) continue;

          results.push({
            title: link.label,
            url: link.url,
            path: new URL(link.url).pathname,
            snippet: link.label,
            score: 0.5
          });
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                results: results.slice(0, limit),
                total: Math.min(results.length, limit),
                searched_from: finalUrl
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
    'get_page',
    'Obtiene una página concreta del sitio.',
    {
      url: z.string().optional(),
      path: z.string().optional()
    },
    async ({ url, path }) => {
      try {
        if (!url && !path) throw new Error('INVALID_URL');

        const { html, finalUrl, visibleText } = await fetchPage(url || path);
        const extracted = extractReadableContent(html, finalUrl, visibleText);

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
        const { html, finalUrl, visibleText } = await fetchPage(url);
        const extracted = extractReadableContent(html, finalUrl, visibleText);

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
      root_path: z.string().default('/inicio/itinerarios')
    },
    async ({ root_path }) => {
      try {
        const { html, finalUrl, visibleText } = await fetchPage(root_path);
        const extracted = extractReadableContent(html, finalUrl, visibleText);

        const sections = extracted.links.map((link) => ({
          title: link.label,
          path: new URL(link.url).pathname,
          url: link.url
        }));

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                root_url: finalUrl,
                sections: dedupeLinks(sections).slice(0, 100)
              }, null, 2)
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

      res.json({
        ok: true,
        authenticated: true,
        base_url: BASE_URL,
        login_url: LOGIN_URL,
        mcp_path: MCP_PATH
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : 'INTERNAL_ERROR',
        details: error?.details || null,
        base_url: BASE_URL,
        login_url: LOGIN_URL,
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

async function closeBrowser() {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
    browserContext = null;
    authenticated = false;
  }
}

process.on('SIGINT', async () => {
  await closeBrowser();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await closeBrowser();
  process.exit(0);
});

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
