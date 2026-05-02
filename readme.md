# IA CAE Zurekin MCP Server

Servidor MCP en Node.js para consultar de forma autenticada la web interna de CAEZ Urekin.

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

## Configuración precargada para tu caso

El ejemplo ya quedó ajustado con esta base:

- `CAEZ_LOGIN_URL=https://interna.caezurekin.biz/caezurekin`
- `CAEZ_LOGIN_USER_FIELD=username`
- `CAEZ_LOGIN_PASSWORD_FIELD=password`

## Ajustes probables

Es muy probable que todavía tengas que adaptar:

- el flujo de autenticación si hay redirecciones, tokens CSRF o SSO
- la lógica de búsqueda si el sitio no tiene un endpoint claro
- cualquier campo oculto adicional del formulario, si existe

## Uso con tu MCP personalizado

Cuando lo despliegues, la conexión MCP debe apuntar a este servidor, no directamente a la web interna.