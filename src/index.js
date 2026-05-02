import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { CookieJar } from 'tough-cookie';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';

const PORT = Number(process.env.PORT || 3000);

const BASE_URL = process.env.CAEZ_BASE_URL;
const USERNAME = process.env.CAEZ_USERNAME;
const PASSWORD = process.env.CAEZ_PASSWORD;
const LOGIN_URL = process.env.CAEZ_LOGIN_URL || BASE_URL;
const LOGIN_USER_FIELD = process.env.CAEZ_LOGIN_USER_FIELD || 'username';
const LOGIN_PASSWORD_FIELD = process.env.CAEZ_LOGIN_PASSWORD_FIELD || 'password';
const LOGIN_EXTRA_FIELDS = safeParseJson(process.env.CAEZ_LOGIN_EXTRA_FIELDS, {});
const SEARCH_PATH = process.env.CAEZ_SEARCH_PATH || '';

if (!BASE_URL) {
  throw new Error('Falta CAEZ_BASE_URL en las variables de entorno.');
}

const cookieJar = new CookieJar();
let authenticated = false;

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

  await storeSetCookie(finalUrl, response);
  return response;
}

async function ensureAuthenticated() {
  if (authenticated) return;

  if (!USERNAME || !PASSWORD) {
    throw new Error('AUTH_FAILED: faltan credenciales en variables de entorno');
  }

  const loginPageResponse = await request(LOGIN_URL, { method: 'GET' });
  const loginPageHtml = await loginPageResponse.text();
  const $ = cheerio.load(loginPageHtml);

  const csrfFields = {};
  $('input[type="hidden"]').each((_, el) => {
    const name = $(el).attr('name');
    const value = $(el).attr('value') || '';
    if (name) csrfFields[name] = value;
  });

  const formData = new URLSearchParams({
    ...csrfFields,
    ...LOGIN_EXTRA_FIELDS,
    [LOGIN_USER_FIELD]: USERNAME,
    [LOGIN_PASSWORD_FIELD]: PASSWORD
  });

  const loginResponse = await request(LOGIN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: formData.toString()
  });

  const finalHtml = await loginResponse.text();
  if (looksLikeLoginPage(finalHtml)) {
    throw new Error('AUTH_FAILED: el sitio sigue mostrando la pantalla de login');
  }

  authenticated = true;
}

function looksLikeLoginPage(html) {
  const text = html.toLowerCase();
  return text.includes('password') && text.includes('login');
}

function extractReadableContent(html, pageUrl) {
  const $ = cheerio.load(html);
  $('script, style, noscript').remove();

  const title =
    $('title').first().text().trim() ||
    $('h1').first().text().trim() ||
    pageUrl;

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

  const contentText = $('body')
    .text()
    .replace(/\s+\n/g, '\n')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

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
  return { html, finalUrl };
}

function mcpError(error) {
  const message = error instanceof Error ? error.message : 'INTERNAL_ERROR';
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            error: {
              code: message.split(':')[0],
              message
            }
          },
          null,
          2
        )
      }
    ],
    isError: true
  };
}

function buildServer() {
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
              text: JSON.stringify(
                { results, total: results.length, searched_from: finalUrl },
                null,
                2
              )
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
              text: JSON.stringify(
                {
                  title: extracted.title,
                  url: finalUrl,
                  path: new URL(finalUrl).pathname,
                  content_text: extracted.contentText,
                  content_markdown: `# ${extracted.title}\n\n${extracted.contentText}`,
                  links: extracted.links
                },
                null,
                2
              )
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
              text: JSON.stringify(
                {
                  title: extracted.title,
                  url: finalUrl,
                  sections: extracted.sections,
                  tables: include_tables ? extractTables(html) : [],
                  links: include_links ? extracted.links : []
                },
                null,
                2
              )
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
              text: JSON.stringify(
                { sections: dedupeLinks(sections).slice(0, 100) },
                null,
                2
              )
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

const app = express();
app.use(express.json({ limit: '2mb' }));

const transports = new Map();

app.get('/', (_req, res) => {
  res.status(200).json({
    ok: true,
    service: 'ia-cae-zurekin-mcp',
    transport: 'sse',
    endpoints: {
      health: '/health',
      sse: '/sse',
      messages: '/messages?sessionId=...'
    }
  });
});

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true });
});

app.get('/sse', async (_req, res) => {
  try {
    const server = buildServer();
    const transport = new SSEServerTransport('/messages', res);

    transports.set(transport.sessionId, transport);

    res.on('close', () => {
      transports.delete(transport.sessionId);
    });

    await server.connect(transport);
  } catch (error) {
    console.error('SSE connection error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to establish SSE connection' });
    }
  }
});

app.post('/messages', async (req, res) => {
  const sessionId = req.query.sessionId;

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'Missing sessionId' });
  }

  const transport = transports.get(sessionId);

  if (!transport) {
    return res.status(404).json({ error: 'Unknown sessionId' });
  }

  try {
    await transport.handlePostMessage(req, res, req.body);
  } catch (error) {
    console.error('POST /messages error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to handle MCP message' });
    }
  }
});

app.listen(PORT, () => {
  console.log(`IA CAE Zurekin MCP listening on port ${PORT}`);
});