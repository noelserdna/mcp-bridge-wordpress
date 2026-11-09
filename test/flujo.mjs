// Prueba de punta a punta del puente, haciendo lo mismo que ChatGPT o Claude:
// descubrir, registrarse (DCR), autorizar con PKCE, canjear el código y usar el MCP.
// Uso: BRIDGE=http://localhost:8787 WP_USER=admin WP_APP_PASSWORD=... node test/flujo.mjs
import crypto from 'node:crypto';

const BRIDGE = process.env.BRIDGE ?? 'http://localhost:8787';
const USUARIO = process.env.WP_USER;
const CLAVE = process.env.WP_APP_PASSWORD;
const CALLBACK = 'http://localhost:9999/callback';
const b64url = (buf) => Buffer.from(buf).toString('base64url');
let fallos = 0;
const ok = (cond, texto) => { console.log((cond ? '✓ ' : '✗ ') + texto); if (!cond) fallos++; };

// Galletas mínimas (el consentimiento va ligado al navegador con una cookie __Host-).
let galletas = {};
const guardarGalletas = (r) => { for (const c of r.headers.getSetCookie?.() ?? []) { const [par] = c.split(';'); const [k, ...v] = par.split('='); galletas[k.trim()] = v.join('='); } };
const cabeceraGalletas = () => Object.entries(galletas).map(([k, v]) => `${k}=${v}`).join('; ');

// 1. Sin token: 401 con la pista para descubrir el servidor OAuth.
let r = await fetch(`${BRIDGE}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
const reto = r.headers.get('www-authenticate') ?? '';
ok(r.status === 401 && /resource_metadata=/.test(reto), `sin token → ${r.status} con WWW-Authenticate (${reto.slice(0, 80)}…)`);
const urlRecurso = reto.match(/resource_metadata="([^"]+)"/)?.[1];
const recurso = await (await fetch(urlRecurso)).json();
ok(recurso.resource === `${BRIDGE}/mcp`, `metadatos del recurso: ${recurso.resource}`);
const as = await (await fetch(`${recurso.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();
ok(as.registration_endpoint && as.code_challenge_methods_supported?.includes('S256'), `servidor OAuth: registro ${as.registration_endpoint}, PKCE ${as.code_challenge_methods_supported}`);

// 2. Registro dinámico: una redirección rara se rechaza; la local se acepta.
r = await fetch(as.registration_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Malo', redirect_uris: ['https://malicioso.example/cb'], token_endpoint_auth_method: 'none' }) });
ok(r.status === 400, `registro con redirección no permitida → ${r.status}`);
r = await fetch(as.registration_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Prueba local', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] }) });
const cliente = await r.json();
ok(r.status === 201 && cliente.client_id, `registro local → ${r.status} client_id ${String(cliente.client_id).slice(0, 8)}…`);

// 3. Autorizar con PKCE.
const verificador = b64url(crypto.randomBytes(32));
const reto256 = b64url(crypto.createHash('sha256').update(verificador).digest());
const estado = b64url(crypto.randomBytes(8));
const urlAut = `${as.authorization_endpoint}?` + new URLSearchParams({ response_type: 'code', client_id: cliente.client_id, redirect_uri: CALLBACK, code_challenge: reto256, code_challenge_method: 'S256', state: estado, scope: 'mcp', resource: `${BRIDGE}/mcp` });
r = await fetch(urlAut, { redirect: 'manual' });
guardarGalletas(r);
let html = await r.text();
const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
ok(r.status === 200 && handle && html.includes('Contraseña de aplicación'), `página de autorización → ${r.status}, pide usuario y contraseña de aplicación`);
ok((r.headers.get('x-frame-options') ?? '').toUpperCase() === 'DENY', 'la página no se puede meter en un marco');

const enviar = (campos) => fetch(as.authorization_endpoint, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cabeceraGalletas() }, body: new URLSearchParams({ handle, ...campos }) });
r = await enviar({ decision: 'approve', usuario: USUARIO, clave: 'esta no es' });
html = await r.text();
ok(r.status === 401 && html.includes('no acepta'), `contraseña equivocada → ${r.status} y mensaje de error, sin consumir la autorización`);
r = await enviar({ decision: 'approve', usuario: USUARIO, clave: CLAVE });
const destino = r.headers.get('location') ?? '';
const codigo = new URL(destino, BRIDGE).searchParams.get('code');
ok(r.status === 302 && destino.startsWith(CALLBACK) && codigo && new URL(destino).searchParams.get('state') === estado, `contraseña buena → ${r.status} a ${destino.slice(0, 40)}… con código y state`);

// 4. Canjear el código por tokens.
r = await fetch(as.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: codigo, redirect_uri: CALLBACK, client_id: cliente.client_id, code_verifier: verificador, resource: `${BRIDGE}/mcp` }) });
const tokens = await r.json();
ok(r.status === 200 && tokens.access_token && tokens.refresh_token, `token → ${r.status}, caduca en ${tokens.expires_in} s, con renovación`);

// 5. Usar el MCP a través del puente.
let sesion = null, id = 0;
const rpc = async (method, params) => {
	const h = { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
	if (sesion) { h['Mcp-Session-Id'] = sesion; h['MCP-Protocol-Version'] = '2025-11-25'; }
	h['Mcp-Method'] = method;
	if (method === 'tools/call') h['Mcp-Name'] = params.name;
	const res = await fetch(`${BRIDGE}/mcp`, { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
	sesion = sesion || res.headers.get('mcp-session-id');
	const t = await res.text();
	return { status: res.status, json: t ? JSON.parse(t) : null };
};
let x = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'prueba-puente', version: '1' } });
ok(x.status === 200 && x.json?.result?.serverInfo && sesion, `initialize → ${x.status}, servidor «${x.json?.result?.serverInfo?.name}», sesión ${sesion ? 'sí' : 'no'}`);
await rpc('notifications/initialized', {});
x = await rpc('tools/list', {});
ok(['mcp-adapter-discover-abilities', 'mcp-adapter-get-ability-info', 'mcp-adapter-execute-ability'].every((n) => (x.json?.result?.tools ?? []).some((t) => t.name === n)), `tools/list → ${(x.json?.result?.tools ?? []).map((t) => t.name).join(', ')}`);
x = await rpc('tools/call', { name: 'mcp-adapter-execute-ability', arguments: { ability_name: 'sanroman/ver-noticias', parameters: { numero: 2 } } });
const noticias = x.json?.result?.structuredContent?.data?.noticias ?? [];
ok(x.status === 200 && noticias.length > 0, `ver-noticias → ${noticias.map((n) => n.titulo).join(' | ').slice(0, 90)}`);

// 5b. Subir una imagen adjunta (como la entrega ChatGPT: enlace de descarga), si el puente ofrece subir_imagen.
const herramientas = (await rpc('tools/list', {})).json?.result?.tools ?? [];
const subir = herramientas.find((t) => t.name === 'subir_imagen');
if (subir) {
	ok(JSON.stringify(subir._meta?.['openai/fileParams']) === '["archivo"]', 'subir_imagen declara openai/fileParams = archivo');
	x = await rpc('tools/call', { name: 'subir_imagen', arguments: { archivo: { download_url: process.env.IMAGEN_URL ?? 'https://sanromandelosmontes.org/wp-content/themes/sanroman/assets/escudo.png', file_id: 'file-prueba', file_name: 'escudo.png', mime_type: 'image/png' }, titulo: 'Logo de prueba del puente', alt: 'Escudo del Ayuntamiento', carpeta: 'empresas' } });
	const subida = x.json?.result?.structuredContent?.data ?? {};
	ok(x.status === 200 && subida.imagen_id && /empresas-logo-de-prueba-del-puente/.test(subida.url ?? ''), `subir_imagen → imagen ${subida.imagen_id} en «${subida.carpeta}»: ${subida.url}`);
	x = await rpc('tools/call', { name: 'subir_imagen', arguments: { titulo: 'Sin imagen', carpeta: 'otros' } });
	ok(x.json?.result?.isError === true, `subir_imagen sin archivo → error claro: ${x.json?.result?.content?.[0]?.text}`);
}

// 6. Renovar el token.
r = await fetch(as.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: cliente.client_id, resource: `${BRIDGE}/mcp` }) });
const nuevos = await r.json();
ok(r.status === 200 && nuevos.access_token && nuevos.access_token !== tokens.access_token, `renovación → ${r.status}, token nuevo`);
tokens.access_token = nuevos.access_token;

// 7. Si se revoca la contraseña de aplicación en WordPress, el puente responde invalid_token.
if (process.env.REVOCAR_URL) {
	await fetch(process.env.REVOCAR_URL);
	x = await rpc('tools/list', {});
	ok(x.status === 401 && x.json?.error === 'invalid_token', `tras revocar en WordPress → ${x.status} ${x.json?.error}`);
}

console.log(fallos ? `\n${fallos} comprobaciones fallidas` : '\nTodo correcto');
process.exit(fallos ? 1 : 0);
