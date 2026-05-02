# IA CAE Zurekin MCP Server

Servidor MCP en Node.js para consultar de forma autenticada la web interna de CAE Zurekin.

## Qué incluye

- `search_pages`: busca contenido en el sitio autenticado
- `get_page`: obtiene una página concreta
- `extract_page_content`: devuelve contenido estructurado
- `list_sections`: lista enlaces navegables desde una página raíz

## Requisitos

- Node.js 18+
- Un servidor o entorno donde ejecutar este proyecto fuera del editor
- Ajustar la lógica de login a la web real si el formulario no coincide con los valores por defecto

## Configuración

1. Copia `.env.example` a `.env`
2. Completa o ajusta las variables de entorno
3. Instala dependencias:
   - `npm install`
4. Arranca el servidor:
   - `npm start`

## Variables principales

- `CAEZ_BASE_URL`: URL base del sitio interno
- `CAEZ_USERNAME`: usuario de acceso
- `CAEZ_PASSWORD`: contraseña de acceso
- `CAEZ_LOGIN_URL`: URL exacta de login si es distinta de la base
- `CAEZ_LOGIN_USER_FIELD`: nombre real del campo usuario en el formulario
- `CAEZ_LOGIN_PASSWORD_FIELD`: nombre real del campo contraseña en el formulario
- `CAEZ_LOGIN_EXTRA_FIELDS`: JSON con campos extra del formulario, si existen
- `CAEZ_SEARCH_PATH`: ruta interna de búsqueda si el sitio tiene una URL específica para buscar
- `PORT`: puerto HTTP del servicio (por defecto `3000`)
- `MCP_PATH`: ruta del endpoint MCP (por defecto `/mcp`)

## Configuración precargada para tu caso

El ejemplo ya quedó ajustado con esta base:

- `CAEZ_BASE_URL=https://interna.caezurekin.biz/caezurekin`
- `CAEZ_LOGIN_URL=https://interna.caezurekin.biz/caezurekin`
- `CAEZ_LOGIN_USER_FIELD=username`
- `CAEZ_LOGIN_PASSWORD_FIELD=password`

## Ajustes probables

Es muy probable que todavía tengas que adaptar:

- el flujo de autenticación si hay redirecciones, tokens CSRF o SSO
- la lógica de búsqueda si el sitio no tiene un endpoint claro
- cualquier campo oculto adicional del formulario, si existe

## Endpoint remoto MCP

Este servidor ya no está pensado para funcionar solo por stdio. Ahora expone un endpoint HTTP remoto para el conector MCP:

- MCP: `POST /mcp`
- Healthcheck: `GET /health`

Si abres `/mcp` en el navegador, verás un mensaje indicando que debes usar `POST`, lo cual es esperado.

## Uso con tu MCP personalizado

Cuando lo despliegues, la conexión MCP del agente debe apuntar a:

- `https://tu-dominio-o-render.onrender.com/mcp`

No debe apuntar directamente a la web interna autenticada.

## Despliegue en Render

- Build command: `npm install`
- Start command: `npm start`

Después del despliegue, comprueba primero:

- `https://tu-dominio-o-render.onrender.com/health`
- `https://tu-dominio-o-render.onrender.com/mcp`

En `/mcp` es normal recibir un error de método si entras por navegador. Lo importante es que la ruta exista y que el conector MCP pueda hacer `POST`.

## Nota importante de despliegue

Si el MCP personalizado que ya está conectado al agente sigue desplegado con una versión anterior del código o con variables de entorno antiguas, el agente puede seguir fallando aunque este borrador ya esté corregido. En ese caso tendrás que redeplegar el servidor MCP real con este código y con la `CAEZ_BASE_URL` y `CAEZ_LOGIN_URL` correctas.