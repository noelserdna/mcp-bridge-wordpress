# mcp-bridge-wordpress

Puente **OAuth 2.1** en **Cloudflare Workers** para usar el MCP oficial de WordPress (plugin [MCP Adapter](https://wordpress.org/plugins/mcp-adapter/)) desde **ChatGPT, claude.ai, la app móvil de Claude y los conectores de Claude Desktop**.

## El problema que resuelve

- El MCP Adapter de WordPress se autentica con **contraseñas de aplicación** (cabecera `Authorization: Basic`). Claude Code y otros programas que admiten cabeceras se conectan sin más.
- ChatGPT, claude.ai y el móvil **solo** conectan servidores MCP remotos con **OAuth 2.1** (PKCE + registro dinámico), y no tienen dónde poner una cabecera. WordPress no trae servidor OAuth.

Este Worker hace de servidor OAuth delante de tu WordPress:

```
ChatGPT / Claude ──OAuth 2.1──▶ Worker (puente) ──Basic + contraseña de aplicación──▶ WordPress /wp-json/mcp/…
```

1. El cliente se registra solo (DCR) y abre la página de autorización del puente.
2. Escribes tu **usuario de WordPress** y una **contraseña de aplicación** (no la de entrar).
3. El puente la comprueba contra tu web (`/wp-json/wp/v2/users/me`). Si vale, emite el token y guarda la credencial **cifrada con ese token**.
4. Cada petición MCP se reenvía a WordPress con esa credencial: el asistente hace exactamente lo que puede hacer tu usuario.

**Sin secretos en el Worker.** Para cortar el acceso, borra la contraseña de aplicación en tu perfil de WordPress: el puente responde `invalid_token` y el cliente tendría que volver a autorizar.

## Requisitos

- WordPress 6.9+ con el plugin **MCP Adapter** activo y algunas capacidades públicas para MCP.
- **Contraseñas de aplicación activadas.** Algunos plugins de seguridad las desactivan. En Wordfence: Todas las opciones → «Desactivar las contraseñas de aplicación de WordPress».
- Cuenta de Cloudflare (sirve el plan gratuito) y `wrangler`.

## Despliegue

```sh
npm install
cp wrangler.example.jsonc wrangler.jsonc   # tu configuración (no se sube al repo)
npx wrangler kv namespace create OAUTH_KV   # copia el id en wrangler.jsonc
# En wrangler.jsonc: WP_URL (tu web), BRIDGE_URL (la URL del Worker) y SITE_NAME
npx wrangler deploy
```

## Conectar

Dirección del conector: `https://<tu-worker>.workers.dev/mcp`

- **ChatGPT:** Ajustes → Aplicaciones y conectores → modo desarrollador → crear conector, con autenticación OAuth.
- **claude.ai / Claude Desktop / móvil:** Ajustes → Conectores → Añadir conector personalizado.

Al conectar se abre la página del puente: usuario de WordPress + contraseña de aplicación (crea una por aplicación, por ejemplo «ChatGPT» y «Claude»).

## Seguridad

- OAuth 2.1 con PKCE S256 obligatorio para clientes públicos. Tokens de acceso de 1 hora y de renovación de 30 días. Librería oficial [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider).
- Registro dinámico solo para redirecciones de claude.ai, claude.com, chatgpt.com y localhost (`src/index.ts`, `REDIRECCIONES`; se pueden añadir con la variable `EXTRA_REDIRECTS`).
- La credencial de WordPress se guarda solo dentro de la concesión, cifrada con una clave que deriva del token. Los tokens se guardan como hash.
- Freno: 5 intentos fallidos cada 15 minutos por IP en la página de autorización.
- La página de autorización no admite marcos y escapa todo lo que viene del cliente.

## Pruebas

`test/flujo.mjs` hace el recorrido completo de un cliente real: descubrimiento, registro, autorización con PKCE, token, `initialize`, `tools/list`, una llamada, renovación y revocación. `test/freno.mjs` prueba el límite de intentos.

```sh
BRIDGE=http://localhost:8787 WP_USER=admin WP_APP_PASSWORD='xxxx xxxx …' node test/flujo.mjs
```

## Historia

En `docs/diario.md` está cómo se construyó, y en `docs/articulo-notas.md` el porqué de cada decisión.

Hecho para la web del Ayuntamiento de San Román de los Montes (Toledo), octubre de 2026.
