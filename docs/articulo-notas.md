# Notas para el artículo: cómo conectamos ChatGPT y Claude a un WordPress municipal

> Material de trabajo, no el artículo final. Recoge el problema, lo que se investigó, lo que se descartó y por qué.

## El problema

La web del Ayuntamiento de San Román de los Montes (sanromandelosmontes.org) es un WordPress con tema propio. Quien la gestiona quería **publicar noticias, avisos y fichas hablando con una IA**: «publica esta noticia con este cartel», «añade esta empresa», «pon un aviso del corte de agua».

WordPress ya tiene una pieza oficial para eso: el plugin **MCP Adapter** (WordPress.org, versión 0.7.1 en octubre de 2026). Expone las «abilities» (capacidades) de la web como herramientas MCP. En la web definimos 14 capacidades propias:
- noticias, avisos emergentes y fiestas;
- empresas, teléfonos, proyectos cofinanciados y accesos;
- datos del Ayuntamiento y redes;
- retirar fichas a la papelera.

Funcionó a la primera en **Claude Code**: se añade el servidor con una cabecera `Authorization: Basic` hecha con una **contraseña de aplicación** de WordPress.

Pero el usuario quería usarlo también en **ChatGPT, claude.ai y el móvil**, y ahí no se puede:
- Esos clientes solo conectan servidores MCP remotos con **OAuth 2.1** (con PKCE y registro dinámico de clientes).
- No tienen ningún campo para escribir una cabecera o una contraseña.
- WordPress no trae servidor OAuth, y el MCP Adapter tampoco lo añade. Su propia documentación lo dice.

Con Claude Desktop pasa lo mismo: sus «conectores personalizados» solo admiten OAuth. Se puede conectar con un puente local (`npx @automattic/mcp-wordpress-remote`), pero eso exige editar un JSON con la contraseña dentro y solo funciona en ese ordenador.

## Las opciones que se miraron

| Opción | Por qué no (o sí) |
|---|---|
| Plugin de OAuth dentro de WordPress | Otro plugin con superficie de ataque en una web pública municipal. Además, habría que revisar que convive con Wordfence y el MCP Adapter. |
| Leer directamente el canal de WhatsApp | No hay API oficial de Channels. Las pasarelas no oficiales arriesgan el bloqueo del número del canal. (Otro hilo del proyecto, pero motivó todo esto.) |
| MCP oficial de Meta para WhatsApp Business (15/09/2026) | Sirve para configurar WhatsApp Business: plantillas, números, webhooks. No incluye canales. |
| WebMCP | Borrador del W3C, solo en Chrome experimental. No sirve hoy para ChatGPT ni para claude.ai. |
| **Puente OAuth en Cloudflare Workers** | **Elegida.** Gratis, fuera de la web municipal, y con la librería oficial de Cloudflare. |

## La idea clave (aportación del usuario)

¿Cómo sabe el puente que quien autoriza es alguien de la web? En vez de inventar un login nuevo (GitHub, una clave propia, Cloudflare Access), **el usuario propuso reutilizar las contraseñas de aplicación de WordPress como «inicio de sesión» del puente**:

1. ChatGPT o Claude abren la página de autorización del puente.
2. La persona escribe su **usuario de WordPress** y una **contraseña de aplicación** creada para ese cliente, por ejemplo «ChatGPT».
3. El puente pregunta a la propia web si esos datos valen (`/wp-json/wp/v2/users/me`). WordPress solo acepta contraseñas de aplicación por `Basic`, así que la contraseña normal de entrar **no** sirve. Eso es bueno.
4. Si valen, el puente emite el token OAuth para ChatGPT o Claude y guarda la credencial **cifrada** con ese token. La librería cifra las «props» con una clave que solo se deriva del token.
5. En cada llamada MCP, el puente reenvía la petición al MCP Adapter con esa credencial.

Consecuencias:
- **Ningún secreto fijo en el Worker.** Si alguien robara el código o la configuración, no tendría acceso a nada.
- **Cada conexión trabaja con los permisos de su cuenta de WordPress.** Un editor no puede cambiar lo que solo puede un administrador.
- **Revocar es lo que ya conoce quien gestiona WordPress:** borrar la contraseña de aplicación en su perfil. El puente deja de funcionar al instante con esa cuenta.
- **Sirve para cualquier WordPress** con el MCP Adapter: la dirección de la web es una variable.

## Datos técnicos verificados (octubre de 2026)

- `@cloudflare/workers-oauth-provider` 1.2.3:
  - Servidor OAuth 2.1 con DCR (RFC 7591), CIMD, PKCE (solo S256) y metadatos RFC 8414 y RFC 9728.
  - Pone `WWW-Authenticate` en los 401 y alinea con la especificación MCP 2026-07-28.
  - Guarda tokens y códigos solo como hash, y las props cifradas.
- Claude (claude.ai, Desktop, móvil): callback `https://claude.ai/api/mcp/auth_callback` (en el futuro también `claude.com`), con DCR o CIMD. Un reporte en GitHub indica que claude.ai exige `WWW-Authenticate` en el 401.
- ChatGPT: callback `https://chatgpt.com/connector/oauth/{id}` (y el heredado `connector_platform_oauth_redirect`), con DCR o CIMD, PKCE y parámetro `resource` en la autorización y el token.
- MCP Adapter: tras `initialize`, exige la cabecera `MCP-Protocol-Version` además de `Mcp-Session-Id`. Lo descubrimos probando: sin ella devuelve 400.
