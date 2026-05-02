import 'dotenv/config';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { CookieJar } from 'tough-cookie';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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
const MAX_SEARCH_PAGES = Number.parseInt(process.env.CAEZ_MAX_SEARCH_PAGES || '25', 10);

if (!BASE_URL) {
  throw new Error('Falta CAEZ_BASE_URL en las variables de entorno.');
}

const BASE_ORIGIN = new URL(BASE_URL).origin;
const BASE_URL_OBJECT = new URL(BASE_URL);
const BASE_PATH_PREFIX = BASE_URL_OBJECT.pathname.replace(/\/$/, '').toLowerCase();
const BASE_DIRECTORY = BASE_URL_OBJECT.pathname.endsWith('/')
  ? BASE_URL_OBJECT.pathname
  : BASE_URL_OBJECT.pathname.replace(/[^/]+$/, '');
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

function normalizeSitePath(input) {
  if (!input) return '';
  if (/^https?:\/\//i.test(input)) return input;
  if (input.startsWith('/')) {
    return new URL(`${BASE_DIRECTORY}${input.slice(1)}`, BASE_URL).toString();
  }
  return new URL(input, BASE_URL).toString();
}

function getPathname(input) {
  try {
    return new URL(input, BASE_URL).pathname.toLowerCase();
  } catch {
    return '';
  }
}

function urlBelongsToSite(input) {
  try {
    const url = new URL(input, BASE_URL);
    const pathname = url.pathname.replace(/\/$/, '').toLowerCase();
    return url.origin === BASE_ORIGIN
      && (pathname === BASE_PATH_PREFIX || pathname.startsWith(`${BASE_PATH_PREFIX}/`));
  } catch {
    return false;
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

  return `${normalizeSitePath(LOGIN_ENDPOINT)}?${params.toString()}`;
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
      if (urlBelongsToSite(url)) {
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

function scoreSearchMatch(text, query) {
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase().trim();
  if (!needle) return 0;
  if (haystack.includes(needle)) return 1;

  const terms = needle.split(/\s+/).filter(Boolean);
  if (!terms.length) return 0;

  const matched = terms.filter((term) => haystack.includes(term)).length;
  return matched / terms.length;
}

function buildSnippet(text, query, maxLength = 240) {
  if (!text) return '';
  const normalizedText = text.replace(/\s+/g, ' ').trim();
  const index = normalizedText.toLowerCase().indexOf(query.toLowerCase());

  if (index === -1) {
    return normalizedText.slice(0, maxLength);
  }

  const start = Math.max(0, index - Math.floor(maxLength / 3));
  const end = Math.min(normalizedText.length, start + maxLength);
  return normalizedText.slice(start, end).trim();
}

async function searchByCrawling(rootTarget, query, limit) {
  const queue = [rootTarget];
  const visited = new Set();
  const results = [];

  while (queue.length && visited.size < MAX_SEARCH_PAGES && results.length < limit) {
    const target = queue.shift();
    const normalizedTarget = normalizeUrl(target);
    if (visited.has(normalizedTarget) || !urlBelongsToSite(normalizedTarget)) continue;
    visited.add(normalizedTarget);

    let page;
    try {
      page = await fetchPage(normalizedTarget);
    } catch {
      continue;
    }

    const extracted = extractReadableContent(page.html, page.finalUrl);
    const combinedText = [
      extracted.title,
      extracted.contentText,
      extracted.links.map((link) => link.label).join(' ')
    ].join(' ');
    const score = scoreSearchMatch(combinedText, query);

    if (score > 0) {
      results.push({
        title: extracted.title,
        url: page.finalUrl,
        path: new URL(page.finalUrl).pathname,
        snippet: buildSnippet(extracted.contentText, query),
        score
      });
    }

    for (const link of extracted.links) {
      if (!visited.has(link.url)) {
        queue.push(link.url);
      }
    }
  }

  return results
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, limit);
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
        ? `${normalizeSitePath(SEARCH_PATH)}${SEARCH_PATH.includes('?') ? '&' : '?'}q=${encodeURIComponent(query)}`
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
        if (!urlBelongsToSite(url)) return;
        if (!`${title} ${snippet}`.toLowerCase().includes(query.toLowerCase())) return;
        results.push({
          title,
          url,
          path: new URL(url).pathname,
          snippet,
          score: 0.5
        });
      });

      if (!results.length) {
        const crawledResults = await searchByCrawling(searchUrl, query, limit);
        results.push(...crawledResults);
      }

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
        if (!urlBelongsToSite(url)) return;
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

const transport = new StdioServerTransport();
await server.connect(transport);
