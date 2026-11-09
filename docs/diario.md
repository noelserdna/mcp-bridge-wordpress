# Diario de construcción

Cada entrada: qué se hizo, qué se decidió y qué problema apareció. Hora de Madrid.

## 2026-10-21 — antes del puente (contexto)

- **13:00** Se instala en la web el plugin oficial **MCP Adapter 0.7.1** y se registran en el tema 14 capacidades propias (`inc/capacidades.php`). Probado en local con WordPress Playground y en la web real.
- **Problema 1: la contraseña de aplicación no aparecía en el perfil.** Causa: Wordfence tiene marcada por defecto «Desactivar las contraseñas de aplicación de WordPress». La desmarca el usuario, porque los ajustes de seguridad los decide él.
- **Problema 2: el comando para conectar Claude Code guardó una llave vacía.** El comando usaba `read -p` (sintaxis de bash), pero el Mac usa zsh, donde `-p` significa otra cosa («no coprocess»). En zsh hay que usar `read "U?Usuario: "` y `read -s "P?Contraseña: "`. Se borró la configuración vacía y se repitió.
- **13:06** Claude Code conectado: «sanroman ✔ Connected». La web registra el primer uso de la contraseña de aplicación.
- **Problema 3: ChatGPT, claude.ai, el móvil y los conectores de Claude Desktop no pueden conectarse.** Solo usan OAuth y no tienen campo para cabeceras. Ver `articulo-notas.md`.

## 2026-10-21 — el puente

- **15:00** Investigación:
  - La librería de Cloudflare para OAuth está en v1 (1.2.3).
  - Requisitos de los callbacks de Claude y ChatGPT.
  - wrangler ya tiene sesión en la cuenta de Cloudflare del usuario, con permisos de Workers y KV.
- **15:10** **Decisión de diseño del usuario:** validar en la pantalla de autorización con usuario de WordPress y contraseña de aplicación, sin secretos en el Worker.
- **15:15** Se crea el repositorio `mcp-bridge-wordpress`, privado de momento, con la librería y wrangler.
- **15:20** Lectura de la documentación de la v1. La librería recomienda dos Workers (servidor de autorización y servidor de recurso), pero mantiene `OAuthProvider` para un solo Worker que hace ambas cosas. **Elegimos un solo Worker:** solo hay un recurso (el MCP de una web) y es más sencillo de desplegar y de explicar.
- **15:24** Se empieza a documentar todo para el artículo.
- **15:40** Primer Worker escrito (`src/index.ts`, `src/wordpress.ts`, `src/pagina.ts`). Prueba local de punta a punta (`test/flujo.mjs`): WordPress Playground con el MCP Adapter y una contraseña de aplicación de prueba, y el puente con `wrangler dev`.
- **Problema 4: Playground va por http y WordPress solo permite contraseñas de aplicación con https o en entorno local.** Para la prueba se añade un mu-plugin local con `add_filter( 'wp_is_application_passwords_available', '__return_true' )`. En la web real no hace falta, porque va por https.
- **Problema 5: cabeceras anti-marco duplicadas** (`X-Frame-Options: DENY` dos veces). La librería ya devuelve en `beginConsent()` sus propias cabeceras (galleta `__Host-` y anti-marcos) y yo las añadía encima de las mías. Ahora las galletas se suman y el resto sustituye.
- **Problema 6 (evitado de antemano): la página de autorización no puede «gastar» el consentimiento si la contraseña es incorrecta.** El `handle` de la librería solo sirve una vez. Si se llamara a `approveConsent()` antes de comprobar la contraseña, un error obligaría a empezar de cero desde ChatGPT. Solución: comprobar primero con WordPress y llamar a `approveConsent()` solo si vale. Los datos que se enseñan en la página se guardan 10 minutos en KV, para volver a pintarla con el error.
- **Decisión: no hay CIMD**, solo registro dinámico (DCR) con lista de redirecciones permitidas (claude.ai, claude.com, chatgpt.com y localhost). Así un cliente desconocido no puede registrarse para mandar tokens a otro sitio. Claude y ChatGPT admiten DCR.
- **Decisión: freno de 5 intentos fallidos cada 15 minutos por IP**, guardado en KV, para que la página no sirva para adivinar contraseñas de aplicación.
- **15:50** Prueba del freno (`test/freno.mjs`): bloqueó al cuarto intento y no al sexto, porque los fallos de las pruebas anteriores ya contaban en la misma ventana de 15 minutos. Es el comportamiento buscado. Una vez bloqueado, ni la contraseña buena pasa hasta que acaba la ventana.
- **15:52** README, `.gitignore` y `package.json`.
- **15:55** Despliegue en Cloudflare.
  - **Problema 7: ya existía en la cuenta un KV llamado `OAUTH_KV`** (de otro proyecto). Reutilizarlo habría mezclado concesiones de dos servicios. Se crea uno propio, `mcp-bridge-wordpress-oauth`. El *binding* sigue llamándose `OAUTH_KV`, porque la librería lo exige con ese nombre.
  - **Problema 8: el primer `wrangler deploy` subió el código pero falló con «This Worker does not exist on your account» (código 10007).** Fue una carrera al crear un Worker nuevo. Repetir el despliegue unos segundos después funcionó.
  - Se desactivan las URL de vista previa (`preview_urls: false`): no hacen falta y serían otra dirección pública con el mismo puente.
- **15:58** Comprobación del puente real (sin credenciales):
  - 401 con `WWW-Authenticate` y `resource_metadata`.
  - Metadatos RFC 9728 y RFC 8414 correctos.
  - Registro de claude.ai → 201; dirección desconocida → 400.
  - Dirección pública: `https://mcp-bridge-wordpress.<subdominio>.workers.dev/mcp`.
- **16:00** Repositorio privado en GitHub: `noelserdna/mcp-bridge-wordpress`.

## 2026-10-21 — primera prueba real con ChatGPT

- **18:30** El usuario crea en ChatGPT el conector «Ayuntamiento de San Roman de los Montes» y autoriza con su usuario de WordPress y una contraseña de aplicación «ChatGPT». **El OAuth funciona a la primera:** en el KV aparecen el cliente, la concesión y el token, y WordPress registra el uso de la contraseña.
- **18:36** **Problema 9: ChatGPT no ve ninguna herramienta.** La ficha del conector sale vacía, «Actualizar» da «No se ha podido actualizar la aplicación» y, en el chat, ChatGPT dice que no tiene acceso y busca en internet (devuelve noticias de 2024).
- **Diagnóstico.** Se añade al puente un registro mínimo por petición: método JSON-RPC, versión del protocolo, cabeceras `mcp-*` presentes y estado de WordPress, **nunca** tokens, credenciales ni argumentos. Con `wrangler tail` en directo, la secuencia de ChatGPT es:
  1. `POST /mcp` sin token → 401 (user-agent `Python aiohttp`, el servicio de ChatGPT).
  2. `GET /.well-known/oauth-protected-resource/mcp` → 200.
  3. `GET /.well-known/oauth-authorization-server` → 200 (también prueba `openid-configuration` → 404, sin problema).
  4. `POST /mcp` con token (user-agent `openai-mcp/1.0.0 (Codex)`): método **`server/discover`**, versión **`2026-07-28`** → WordPress **400**: `Header mismatch: Mcp-Method is missing or does not match the request body` (código -32020).
- **Causa.** La especificación MCP **2026-07-28** añade la cabecera **`Mcp-Method`**, que debe coincidir con el método del cuerpo. ChatGPT la envía y el MCP Adapter la exige, pero el puente solo reenviaba una lista fija de cabeceras (`content-type`, `accept`, `mcp-session-id`, `mcp-protocol-version`, `last-event-id`) y se la comía.
- **Arreglo.** El puente reenvía, en ambos sentidos, **todas** las cabeceras que empiezan por `Mcp-`, además de las básicas. Así también aguanta las que añadan versiones futuras.
- **Lección para el artículo.** Un proxy de MCP no debe filtrar cabeceras con lista blanca estricta: el protocolo cambia rápido (2025-06-18, 2025-11-25, 2026-07-28) y cada versión ha añadido cabeceras. Claude Code usaba 2025-11-25 y por eso no lo detectamos en las pruebas locales: nuestro script de prueba tampoco mandaba `Mcp-Method`.
- **19:05** **ChatGPT ya funciona.** Los registros muestran `server/discover`, `tools/list` y varias llamadas `tools/call` (`discover-abilities`, `get-ability-info`, `execute-ability`), todas con 200.
- **19:10** **Problema 10: ChatGPT no puede subir el logo de una empresa.** Se lo pasan como PNG adjunto en el chat, pero la capacidad de WordPress solo acepta una URL pública o el id de una imagen ya subida. ChatGPT responde: «Si subes este PNG a la biblioteca de medios y me pasas su URL, podré incorporarlo».
  - **Cómo entrega ChatGPT los archivos a una herramienta MCP:** solo a las herramientas que declaran el argumento en `_meta["openai/fileParams"]`, y lo hace como objeto `{ download_url, file_id }` con un enlace temporal. El servidor tiene que descargarlo él mismo. (Fuentes: foro de desarrolladores de OpenAI; un *issue* indica que ~1 de cada 10 llamadas llega sin el archivo.)
  - **Por qué no basta con WordPress:** las herramientas que ve ChatGPT son las genéricas del MCP Adapter (`execute-ability`), y no se les puede poner ese `_meta` por capacidad.
  - **Solución en dos partes:**
    1. **WordPress (tema 2.27.0):** capacidad `sanroman/subir-imagen` (base64 o URL https, máximo 10 MB, solo JPG/PNG/WebP/GIF comprobando el contenido real). Guarda la imagen **ordenada**: taxonomía de adjuntos «Carpetas» (`sr_carpeta`: Noticias, Empresas, Avisos emergentes, Proyectos, Fiestas, Otros), nombre `carpeta-titulo.ext`, título y texto alternativo. Además, toda imagen que se pone como destacada en una ficha se clasifica sola, y al activar se clasificaron las existentes (28 en Noticias, 3 en Proyectos). En Medios hay un filtro por carpeta.
    2. **Puente:** herramienta propia `subir_imagen`, que se añade a la lista que devuelve WordPress, con `_meta: {"openai/fileParams": ["archivo"]}`. Al llamarla, el Worker descarga el `download_url`, lo pasa a base64 y lo convierte en una llamada a `execute-ability` con `sanroman/subir-imagen`, cambiando también la cabecera `Mcp-Name` (MCP 2026-07-28). Claude, que no usa `fileParams`, puede pasar `url` o `datos_base64`. Es configurable y genérico: variables `UPLOAD_ABILITY` y `UPLOAD_FOLDERS`; sin ellas, el puente no añade la herramienta.
  - Prueba local imitando a ChatGPT (protocolo 2026-07-28, `Mcp-Method`, `Mcp-Name` y archivo como `download_url`): imagen guardada como `empresas-logo-de-prueba-del-puente.png` en «Empresas (logos)» con su texto alternativo. Sin archivo, la herramienta da un error claro.
- **19:40** **Primer logo real subido desde ChatGPT** (el de una empresa del municipio), ya puesto en su ficha. **Problema 11: se veía diminuto (54 × 23 px).** El recuadro del logo era de 64 × 64 y el logo es apaisado; además, la ficha usaba el tamaño `thumbnail` (150 px).
  - Arreglo en la web (tema 2.27.1): el logo va en una franja propia arriba de la tarjeta, de altura fija y ancho flexible (hasta 64 × 220 px), con el tamaño `medium`. Los logos que entran por «Subir imagen» en la carpeta Empresas se recortan solos sin márgenes vacíos (Imagick `trimImage`, o GD de reserva), dejando un 4 % de aire.
  - **Fallo propio en el recorte:** para no recortar imágenes en blanco, al principio se descartaba el resultado si quedaba menos del 10 % del lienzo. Pero un logo pequeño en un lienzo grande ocupa ~5 %, justo el caso que se quería arreglar. El límite se bajó al 1 %.
  - Resultado real: el logo pasa de 54 × 23 a 192 × 64 px.

## 2026-10-21 · Instalaciones municipales (tema 2.28.0)

- El Ayuntamiento pide una sección «Instalaciones» dentro de Municipio: Ayuntamiento, Biblioteca, Gimnasio, Colegio y Piscina, cada una con descripción, horario, tarifas, contacto y hasta 5 fotos en carrusel.
- En WordPress: tipo de contenido `sr_instalacion` y una nueva capacidad, `sanroman/guardar-instalacion`. Con ella, ChatGPT o Claude pueden rellenar los datos y poner las fotos. Con `fotos` se sustituyen todas y con `anadir_fotos` se añaden a las que haya.
- En el puente solo hubo que añadir `instalaciones` a `UPLOAD_FOLDERS`, para que `subir_imagen` admita esa carpeta. El resto de la herramienta nueva lo descubre el cliente por sí solo a través del MCP de WordPress, sin tocar el Worker. Es una prueba de que el diseño «puente fino» escala bien.

## 2026-10-21 · Asociaciones y noticias relacionadas (tema 2.29.0)

- Después de Instalaciones llegó Asociaciones, con la misma idea: logo, hasta 5 fotos, descripción, actividades, cuándo se reúnen, cómo hacerse socio y contacto. Ambas fichas, además, muestran sus «noticias relacionadas».
- En lugar de copiar Instalaciones, se convirtió en un motor común de «fichas» (`inc/fichas.php`), con un array de configuración por tipo: campos, carpeta de medios, si lleva logo y textos. Una sección nueva es ahora una entrada más de ese array.
- La relación se guarda en la noticia (`sr_relacion`, un valor por ficha). Desde el escritorio, cada noticia tiene una caja «Relacionada con» con casillas. Por MCP, `publicar-noticia` acepta `relacionadas` y `guardar-instalacion` / `guardar-asociacion` aceptan `anadir_noticias` y `quitar_noticias`. Así, un asistente puede decir «esta noticia va también en la ficha del Tintero» sin tocar el editor.
- Incidente en las pruebas: en el primer intento automatizado, una ficha se quedó vacía. No se pudo reproducir por ningún camino (formulario, borrador → publicar, MCP, guardar una noticia). Aun así, el guardado del formulario pasó a cambiar solo los campos que llegan en la petición, para que un envío incompleto nunca pueda vaciar una ficha.
- En el puente: una palabra más en `UPLOAD_FOLDERS` (`asociaciones`). Ninguna línea de código.

## 2026-10-21 · Vídeos en el carrusel y un fallo de zona horaria (tema 2.30.1)

- El carrusel de las fichas ahora también admite vídeos (MP4), mezclados con las fotos. Por accesibilidad no se reproducen solos y se paran al cambiar de elemento.
- Al publicar noticias con fecha pasada salió un fallo: «2026-09-11 09:00» se guardaba como 11:00. `strtotime()` interpretaba la cadena en UTC y `wp_date()` la convertía a la hora de Madrid. Se arregló leyendo la fecha con `date_create_immutable( $fecha, wp_timezone() )`. Una lección para el artículo: si una IA pasa fechas «humanas», hay que decidir de forma explícita en qué zona horaria se interpretan.
