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

const ITINERARIOS_MENU_SELECTOR = process.env.CAEZ_ITINERARIOS_MENU_SELECTOR || '#caez-menu-itinerarios';
const ITINERARIOS_SEARCH_SELECTOR = process.env.CAEZ_ITINERARIOS_SEARCH_SELECTOR || '#caez-itinerarios-buscar';

const DEFAULT_SECTION = process.env.CAEZ_DEFAULT_SECTION || 'itinerarios';
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

const UI_SECTIONS = {
  itinerarios: {
    title: 'Itinerarios',
    menuSelector: ITINERARIOS_MENU_SELECTOR,
    readySelector: ITINERARIOS_SEARCH_SELECTOR,
    labels: [/itinerarios/i]
  },
  sugerencias: { title: 'Sugerencias', labels: [/sugerencias/i] },
  usuarios: { title: 'Claves', labels: [/claves/i] },
  vehiculos: { title: 'Vehiculos', labels: [/vehiculos/i] },
  'diagnostico-vehiculos': { title: 'Diagnostico', labels: [/diagnostico/i] },
  clientes: { title: 'Clientes', labels: [/clientes/i] },
  municipios: { title: 'Municipios', labels: [/municipios/i] },
  conductores: { title: 'Personal', labels: [/personal/i] },
  fichajes: { title: 'Fichajes', labels: [/fichajes/i] },
  estadistica: { title: 'Estadistica', labels: [/estadistica/i] },
  esporadicos: { title: 'Esporadicos', labels: [/esporadicos/i] },
  'usuarios-traslado': { title: 'Usuarios', labels: [/usuarios/i] },
  consola: { title: 'Asistente', labels: [/asistente/i] },
  arquetipos: { title: 'Arquetipos', labels: [/arquetipos/i] },
  inspeccion: { title: 'Inspeccion', labels: [/inspeccion/i] },
  siguebus: { title: 'Pwd siguebus', labels: [/pwd\s*siguebus/i, /siguebus/i] },
  alertas: { title: 'Alertas', labels: [/alertas/i] },
  'alertas-moviles': { title: 'Moviles alerta', labels: [/moviles\s*alerta/i, /moviles/i] }
};

const SECTION_ALIASES = new Map([
  ['inicio', 'itinerarios'],
  ['inicio/itinerarios', 'itinerarios'],
  ['itinerario', 'itinerarios'],
  ['claves', 'usuarios'],
  ['personal', 'conductores'],
  ['diagnostico', 'diagnostico-vehiculos'],
  ['moviles-alerta', 'alertas-moviles'],
  ['moviles', 'alertas-moviles'],
  ['pwd-siguebus', 'siguebus'],
  ['passwords-siguebus', 'siguebus'],
  ['asistente', 'consola']
]);

let browser = null;
let browserContext = null;
let appPage = null;
let authenticated = false;
let loginPromise = null;
let pageQueue = Promise.resolve();

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

function normalizeKey(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\s+/g, '-')
    .toLowerCase();
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

function hasSelector($, selector) {
  try {
    return $(selector).length > 0;
  } catch {
    return false;
  }
}

function looksLikeLoginPage(html) {
  const $ = cheerio.load(html);
  const text = $('body').text().toLowerCase();

  const hasConfiguredUser = hasSelector($, USERNAME_SELECTOR);
  const hasConfiguredPassword = hasSelector($, PASSWORD_SELECTOR);
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
  ].some((token) => text.includes(token));

  return (hasConfiguredUser && hasConfiguredPassword)
    || (hasPasswordInput && loginTextDetected);
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
      `el sitio devolvio una pantalla de acceso denegado (${pageUrl})`,
      { page_url: pageUrl }
    );
  }
}

async function getBrowserContext() {
  if (!browser) {
    browser = await chromium.launch({
      headless: HEADLESS,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--no-first-run',
        '--no-zygote'
      ]
    });
  }

  if (!browserContext) {
    browserContext = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 800 }
    });
  }

  return browserContext;
}

async function newPage() {
  const context = await getBrowserContext();
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT_MS);

  await page.route('**/*', async (route) => {
    const type = route.request().resourceType();

    if (['image', 'font', 'media'].includes(type)) {
      await route.abort().catch(() => {});
      return;
    }

    await route.continue().catch(() => {});
  }).catch(() => {});

  return page;
}

async function getAppPage() {
  if (appPage && !appPage.isClosed()) {
    return appPage;
  }

  appPage = await newPage();
  return appPage;
}

async function closeBrowser() {
  if (appPage && !appPage.isClosed()) {
    await appPage.close().catch(() => {});
  }

  appPage = null;

  if (browserContext) {
    await browserContext.close().catch(() => {});
  }

  browserContext = null;

  if (browser) {
    await browser.close().catch(() => {});
  }

  browser = null;
  authenticated = false;
  loginPromise = null;
}

async function withPageLock(task) {
  const previous = pageQueue;
  let release;

  pageQueue = new Promise((resolve) => {
    release = resolve;
  });

  await previous.catch(() => {});

  try {
    return await task();
  } finally {
    release();
  }
}

async function waitAfterUiAction(page, delay = 1000) {
  await page.locator('body').waitFor({ state: 'attached', timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(delay);
}

function isLoginResponse(response) {
  const url = response.url();

  return url.includes('accion=comprueba_usuario_password')
    || url.includes('accion=obtener_itinerarios_externos');
}

async function isLoggedInPage(page) {
  const html = await page.content().catch(() => '');

  if (!html || looksLikeLoginPage(html) || looksLikeAccessDenied(html)) {
    return false;
  }

  const menuCount = await page.locator(ITINERARIOS_MENU_SELECTOR).count().catch(() => 0);
  return menuCount > 0;
}

async function clickSectionButton(page, sectionName) {
  const section = UI_SECTIONS[sectionName];

  if (!section) {
    throw createDetailedError(
      'INVALID_SECTION',
      `seccion no soportada: ${sectionName}`,
      { section: sectionName }
    );
  }

  if (section.menuSelector) {
    const locator = page.locator(section.menuSelector).first();
    const count = await locator.count().catch(() => 0);

    if (count > 0) {
      await locator.click({ timeout: TIMEOUT_MS });
      return;
    }
  }

  for (const label of section.labels || []) {
    const button = page.getByRole('button', { name: label }).first();
    const count = await button.count().catch(() => 0);

    if (count > 0) {
      await button.click({ timeout: TIMEOUT_MS });
      return;
    }
  }

  throw createDetailedError(
    'UI_NAVIGATION_FAILED',
    `no se encontro el boton de menu para ${sectionName}`,
    { section: sectionName, title: section.title }
  );
}

async function waitForSectionReady(page, sectionName) {
  const section = UI_SECTIONS[sectionName];

  if (section?.readySelector) {
    const ready = page.locator(section.readySelector).first();

    try {
      await ready.waitFor({ state: 'attached', timeout: 15000 });
      return;
    } catch {
      // Continua con espera por texto.
    }
  }

  if (section?.title) {
    await page.getByText(section.title, { exact: false }).first()
      .waitFor({ state: 'attached', timeout: 10000 })
      .catch(() => {});
  }

  await waitAfterUiAction(page, 1000);
}

async function goToSectionThroughUiUnlocked(page, sectionName = DEFAULT_SECTION) {
  await page.waitForSelector(ITINERARIOS_MENU_SELECTOR, { timeout: TIMEOUT_MS });

  await clickSectionButton(page, sectionName);
  await waitAfterUiAction(page, 1000);
  await waitForSectionReady(page, sectionName);

  const html = await page.content();
  assertAccessiblePage(html, page.url());
}

async function waitForLoggedShell(page) {
  const deadline = Date.now() + TIMEOUT_MS;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      if (await isLoggedInPage(page)) {
        await goToSectionThroughUiUnlocked(page, DEFAULT_SECTION);
        return;
      }
    } catch (error) {
      lastError = error;
    }

    await page.waitForTimeout(500);
  }

  throw createDetailedError(
    'AUTH_TIMEOUT',
    'no se detecto la interfaz autenticada despues del login',
    {
      current_url: page.url(),
      last_error: lastError instanceof Error ? lastError.message : null
    }
  );
}

async function performLoginUnlocked() {
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

  const page = await getAppPage();
  const attempts = [];

  try {
    const response = await page.goto(LOGIN_URL, {
      waitUntil: 'domcontentloaded',
      timeout: TIMEOUT_MS
    });

    await waitAfterUiAction(page, 1000);
    assertTrustedOrigin(page.url());

    if (response && !response.ok()) {
      throw createDetailedError(
        'LOGIN_PAGE_HTTP_ERROR',
        `la pagina de login devolvio ${response.status()}`,
        { status: response.status(), url: response.url() }
      );
    }

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
      isLoginResponse,
      { timeout: 15000 }
    ).catch(() => null);

    await page.click(SUBMIT_SELECTOR);

    const loginResponse = await loginResponsePromise;

    if (loginResponse && !loginResponse.ok()) {
      const body = await loginResponse.text().catch(() => '');

      throw createDetailedError(
        loginResponse.status() === 500 ? 'AUTH_HTTP_500' : 'AUTH_HTTP_ERROR',
        `la peticion interna de login devolvio ${loginResponse.status()}`,
        {
          status: loginResponse.status(),
          url: loginResponse.url(),
          body_excerpt: summarizeText(body)
        }
      );
    }

    await waitForLoggedShell(page);
    authenticated = true;
  } catch (error) {
    authenticated = false;

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
  }
}

async function ensureAuthenticatedUnlocked() {
  if (authenticated && appPage && !appPage.isClosed() && await isLoggedInPage(appPage)) {
    return;
  }

  authenticated = false;

  if (!loginPromise) {
    loginPromise = performLoginUnlocked().finally(() => {
      loginPromise = null;
    });
  }

  await loginPromise;
}

async function runUiSession(task) {
  return withPageLock(async () => {
    try {
      await ensureAuthenticatedUnlocked();
      return await task(await getAppPage());
    } finally {
      await closeBrowser();
    }
  });
}

function resolveSection(input) {
  if (!input) return DEFAULT_SECTION;

  let value = String(input || '').trim();

  try {
    if (/^https?:\/\//i.test(value)) {
      const url = new URL(value);
      value = url.hash?.startsWith('#/') ? url.hash.slice(2) : url.pathname;
    }
  } catch {
    // Usa value tal cual.
  }

  value = value.replace(/^#\/?/, '');
  value = value.replace(/^\/+|\/+$/g, '');

  const basePath = new URL(BASE_URL).pathname.replace(/^\/+|\/+$/g, '');

  if (basePath && value.startsWith(basePath)) {
    value = value.slice(basePath.length).replace(/^\/+/, '');
  }

  const key = normalizeKey(value);

  if (!key) return DEFAULT_SECTION;
  if (SECTION_ALIASES.has(key)) return SECTION_ALIASES.get(key);
  if (UI_SECTIONS[key]) return key;

  const parts = key.split('/').filter(Boolean);

  if (parts[0] === 'inicio' && parts[1]) {
    const second = normalizeKey(parts[1]);
    if (SECTION_ALIASES.has(second)) return SECTION_ALIASES.get(second);
    if (UI_SECTIONS[second]) return second;
  }

  if (parts[0] && UI_SECTIONS[parts[0]]) return parts[0];

  return DEFAULT_SECTION;
}

async function findSearchInput(page, sectionName) {
  const selectors = [];

  if (sectionName === 'itinerarios') {
    selectors.push(ITINERARIOS_SEARCH_SELECTOR);
  }

  selectors.push(
    'input[type="search"]',
    'input[placeholder*="buscar" i]',
    'input[aria-label*="buscar" i]',
    'input[placeholder*="filtrar" i]',
    'input[aria-label*="filtrar" i]',
    'mat-form-field input'
  );

  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);

    for (let index = 0; index < count; index += 1) {
      const input = locator.nth(index);
      const visible = await input.isVisible().catch(() => false);
      const enabled = await input.isEnabled().catch(() => false);

      if (visible && enabled) {
        return input;
      }
    }
  }

  return null;
}

async function applyInPageSearch(page, query, sectionName) {
  const input = await findSearchInput(page, sectionName);

  if (!input) {
    return false;
  }

  await input.fill('');
  await input.fill(query);
  await waitAfterUiAction(page, 1500);

  return true;
}

async function fetchPageThroughUi(urlOrPath, options = {}) {
  return runUiSession(async (page) => {
    const sectionName = resolveSection(urlOrPath || options.section || DEFAULT_SECTION);

    await goToSectionThroughUiUnlocked(page, sectionName);

    if (options.searchQuery) {
      await applyInPageSearch(page, options.searchQuery, sectionName);
    }

    const finalUrl = page.url();
    const html = await page.content();
    const visibleText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');

    assertAccessiblePage(html, finalUrl);

    return { html, finalUrl, visibleText, sectionName };
  });
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

function dedupeLinks(links) {
  const seen = new Set();

  return links.filter((link) => {
    if (!link?.url || seen.has(link.url)) return false;
    seen.add(link.url);
    return true;
  });
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

    if (!href || /^(javascript:|mailto:|tel:)/i.test(href)) return;

    try {
      const url = new URL(href, pageUrl).toString();
      const origin = new URL(url).origin;

      if (TRUSTED_ORIGINS.includes(origin)) {
        links.push({ label: label || url, url });
      }
    } catch {
      // Ignora enlaces invalidos.
    }
  });

  const contentText = visibleText
    || $('body').text()
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

function extractTables(html) {
  const $ = cheerio.load(html);
  const tables = [];

  $('table').each((_, table) => {
    const headers = [];
    const rows = [];

    $(table).find('tr').each((__, tr) => {
      const headerCells = [];
      const rowCells = [];

      $(tr).find('th').each((___, th) => {
        headerCells.push($(th).text().trim());
      });

      $(tr).find('td').each((___, td) => {
        rowCells.push($(td).text().trim());
      });

      if (headerCells.length && !headers.length) {
        headers.push(...headerCells);
      }

      if (rowCells.length) {
        rows.push(rowCells);
      }
    });

    if (headers.length || rows.length) {
      tables.push({ title: null, headers, rows });
    }
  });

  return tables;
}

function mcpError(error) {
  const message = error instanceof Error ? error.message : 'INTERNAL_ERROR';
  const code = error?.code || message.split(':')[0] || 'INTERNAL_ERROR';

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
    'Busca contenido dentro de la web interna autenticada navegando por la interfaz.',
    {
      query: z.string(),
      limit: z.number().int().min(1).max(20).default(10),
      section: z.string().optional()
    },
    async ({ query, limit, section }) => {
      try {
        const { html, finalUrl, visibleText, sectionName } = await fetchPageThroughUi(
          section || DEFAULT_SECTION,
          { searchQuery: query, section }
        );

        const extracted = extractReadableContent(html, finalUrl, visibleText);
        const results = [];

        if (extracted.contentText.toLowerCase().includes(query.toLowerCase())) {
          results.push({
            title: UI_SECTIONS[sectionName]?.title || extracted.title,
            url: finalUrl,
            path: sectionName,
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
                searched_from: finalUrl,
                section: sectionName,
                navigation_mode: 'ui'
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
    'Obtiene una pantalla concreta navegando por la interfaz.',
    {
      url: z.string().optional(),
      path: z.string().optional()
    },
    async ({ url, path }) => {
      try {
        const target = url || path || DEFAULT_SECTION;
        const { html, finalUrl, visibleText, sectionName } = await fetchPageThroughUi(target);
        const extracted = extractReadableContent(html, finalUrl, visibleText);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                title: UI_SECTIONS[sectionName]?.title || extracted.title,
                url: finalUrl,
                path: sectionName,
                content_text: extracted.contentText,
                content_markdown: `# ${UI_SECTIONS[sectionName]?.title || extracted.title}\n\n${extracted.contentText}`,
                links: extracted.links,
                navigation_mode: 'ui'
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
    'Extrae contenido estructurado de una pantalla navegando por la interfaz.',
    {
      url: z.string(),
      include_tables: z.boolean().default(true),
      include_links: z.boolean().default(true)
    },
    async ({ url, include_tables, include_links }) => {
      try {
        const { html, finalUrl, visibleText, sectionName } = await fetchPageThroughUi(url);
        const extracted = extractReadableContent(html, finalUrl, visibleText);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                title: UI_SECTIONS[sectionName]?.title || extracted.title,
                url: finalUrl,
                path: sectionName,
                sections: extracted.sections,
                tables: include_tables ? extractTables(html) : [],
                links: include_links ? extracted.links : [],
                navigation_mode: 'ui'
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
    'Lista secciones navegables de la interfaz.',
    {
      root_path: z.string().default('/')
    },
    async () => {
      try {
        const sections = Object.entries(UI_SECTIONS).map(([path, section]) => ({
          title: section.title,
          path,
          navigation: 'menu_button'
        }));

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                sections,
                navigation_mode: 'ui'
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
      const result = await runUiSession(async (page) => {
        await goToSectionThroughUiUnlocked(page, DEFAULT_SECTION);

        return {
          current_url: page.url()
        };
      });

      res.json({
        ok: true,
        authenticated: true,
        base_url: BASE_URL,
        login_url: LOGIN_URL,
        current_url: result.current_url,
        default_section: DEFAULT_SECTION,
        navigation_mode: 'ui',
        mcp_path: MCP_PATH
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : 'INTERNAL_ERROR',
        details: error?.details || null,
        base_url: BASE_URL,
        login_url: LOGIN_URL,
        default_section: DEFAULT_SECTION,
        navigation_mode: 'ui',
        mcp_path: MCP_PATH
      });
    }
  });

  app.get('/', (_req, res) => {
    res.json({
      name: 'ia-cae-zurekin-mcp',
      status: 'ok',
      endpoint: MCP_PATH,
      healthcheck: '/health',
      navigation_mode: 'ui'
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
              message: 'La sesion MCP no existe o ha caducado.'
            }
          });
          return;
        }

        if (!isInitializeRequest(req.body)) {
          res.status(400).json({
            error: {
              code: 'INVALID_REQUEST',
              message: 'La primera peticion MCP debe ser initialize.'
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
            message: 'No se encontro la sesion MCP indicada.'
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
