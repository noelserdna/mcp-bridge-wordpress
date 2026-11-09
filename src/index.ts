/**
 * mcp-bridge-wordpress
 *
 * Puente OAuth 2.1 en Cloudflare Workers para el MCP oficial de WordPress (plugin MCP Adapter).
 * ChatGPT, claude.ai y la app móvil de Claude solo conectan servidores MCP con OAuth; WordPress
 * solo acepta contraseñas de aplicación. El puente hace de servidor OAuth y, al autorizar, pide
 * usuario y contraseña de aplicación de WordPress, los comprueba contra la propia web y los guarda
 * cifrados con el token. Después reenvía cada petición MCP a WordPress con esa credencial.
 *
 * No guarda ningún secreto propio: revocar = borrar la contraseña de aplicación en WordPress.
 */
import OAuthProvider, { AuthorizationError, CimdFetchError, type ClientRegistrationCallbackOptions, type OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { cabecerasSeguras, paginaAutorizar, paginaSimple, escapar, type DatosPagina } from './pagina';
import { cabeceraBasic, comprobarCredencial, reenviarMcp } from './wordpress';
import * as subir from './subir';

export interface Env {
	OAUTH_KV: KVNamespace;
	OAUTH_PROVIDER: OAuthHelpers;
	WP_URL: string;
	BRIDGE_URL: string;
	SITE_NAME: string;
	EXTRA_REDIRECTS?: string;
	/** Ruta del servidor MCP en WordPress (por defecto, el del MCP Adapter). */
	WP_MCP_PATH?: string;
	/** Capacidad de WordPress que guarda imágenes; si existe, el puente ofrece la herramienta subir_imagen. */
	UPLOAD_ABILITY?: string;
	/** Carpetas de Medios admitidas por esa capacidad, separadas por comas. */
	UPLOAD_FOLDERS?: string;
}

/** Lo que se guarda (cifrado) con cada concesión. */
interface Props {
	basic: string;
	usuario: string;
	nombre: string;
	wpId: number;
}

const ESCOPO = 'mcp';

// Redirecciones admitidas al registrarse (Claude, ChatGPT y programas locales como Claude Code o el Inspector MCP).
const REDIRECCIONES = [
	/^https:\/\/claude\.ai\/api\/mcp\/auth_callback$/,
	/^https:\/\/claude\.com\/api\/mcp\/auth_callback$/,
	/^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]+$/,
	/^https:\/\/chatgpt\.com\/connector_platform_oauth_redirect$/,
	/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/.*$/,
];

function redireccionPermitida(uri: string, env: Env): boolean {
	if (REDIRECCIONES.some((re) => re.test(uri))) return true;
	const extra = (env.EXTRA_REDIRECTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
	return extra.some((prefijo) => uri.startsWith(prefijo));
}

// ---------- /mcp: reenvío a WordPress ----------

const CORS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Expose-Headers': 'Mcp-Session-Id, MCP-Protocol-Version, Mcp-Method, WWW-Authenticate',
};

const apiHandler = {
	async fetch(request: Request, env: Env, ctx: ExecutionContext & { props: Props }): Promise<Response> {
		const props = ctx.props;
		// Registro de diagnóstico: qué pide el cliente y qué responde WordPress. Nunca el token, la credencial ni los argumentos.
		const inicio = Date.now();
		const ruta = env.WP_MCP_PATH || '/wp-json/mcp/mcp-adapter-default-server';
		let rpc = '-';
		type Rpc = { jsonrpc: string; id: unknown; method?: string; params?: { name?: string; protocolVersion?: string; arguments?: Record<string, unknown> } };
		let cuerpo: Rpc | Rpc[] | null = null;
		if (request.method === 'POST') {
			try {
				cuerpo = (await request.clone().json()) as Rpc | Rpc[];
				rpc = Array.isArray(cuerpo) ? `lote(${cuerpo.map((c) => c.method).join(',')})` : `${cuerpo.method ?? '?'}${cuerpo.params?.name ? ' ' + cuerpo.params.name : ''}${cuerpo.params?.protocolVersion ? ' v' + cuerpo.params.protocolVersion : ''}`;
			} catch {
				rpc = 'cuerpo no JSON';
			}
		}
		const unico = cuerpo && !Array.isArray(cuerpo) ? cuerpo : null;

		// Herramienta propia: subir_imagen se traduce a la capacidad de WordPress que guarda imágenes.
		let cambio: { cuerpo: string; cabeceras: Record<string, string> } | undefined;
		if (env.UPLOAD_ABILITY && unico?.method === 'tools/call' && unico.params?.name === subir.NOMBRE) {
			const traducido = await subir.traducir(unico as never, env.UPLOAD_ABILITY);
			if ('error' in traducido) {
				console.log(JSON.stringify({ mcp: rpc, error: traducido.error }));
				return Response.json({ jsonrpc: '2.0', id: unico.id, result: { content: [{ type: 'text', text: traducido.error }], isError: true } }, { headers: CORS });
			}
			cambio = { cuerpo: JSON.stringify(traducido.cuerpo), cabeceras: { 'Mcp-Name': 'mcp-adapter-execute-ability', 'Content-Type': 'application/json' } };
		}
		let respuesta = await reenviarMcp(env.WP_URL, props.basic, request, cambio, ruta);

		// En la lista de herramientas de WordPress se añade subir_imagen.
		if (env.UPLOAD_ABILITY && unico?.method === 'tools/list' && respuesta.status === 200 && (respuesta.headers.get('content-type') ?? '').includes('application/json')) {
			const datos = (await respuesta.json()) as { result?: { tools?: unknown[] } };
			if (datos.result && Array.isArray(datos.result.tools)) {
				const carpetas = (env.UPLOAD_FOLDERS ?? '').split(',').map((c) => c.trim()).filter(Boolean);
				datos.result.tools.push(subir.definicion(carpetas));
			}
			const h = new Headers(respuesta.headers);
			h.delete('content-length');
			respuesta = new Response(JSON.stringify(datos), { status: 200, headers: h });
		}
		let detalle = '';
		if (respuesta.status >= 400) {
			detalle = (await respuesta.clone().text()).slice(0, 300);
		}
		console.log(JSON.stringify({
			mcp: rpc,
			http: request.method,
			version: request.headers.get('mcp-protocol-version'),
			cabecerasMcp: [...request.headers.keys()].filter((k) => k.startsWith('mcp-')),
			sesion: request.headers.has('mcp-session-id'),
			accept: request.headers.get('accept'),
			usuario: props.usuario,
			wp: respuesta.status,
			tipo: respuesta.headers.get('content-type'),
			ms: Date.now() - inicio,
			detalle,
		}));
		if (respuesta.status === 401) {
			// La contraseña de aplicación se ha revocado en WordPress: que el cliente vuelva a autorizar.
			return new Response(JSON.stringify({ error: 'invalid_token', error_description: 'WordPress ya no acepta esta contraseña de aplicación. Vuelve a autorizar.' }), {
				status: 401,
				headers: {
					'Content-Type': 'application/json',
					'WWW-Authenticate': `Bearer error="invalid_token", error_description="WordPress ha revocado la contraseña de aplicación", resource_metadata="${env.BRIDGE_URL}/.well-known/oauth-protected-resource/mcp"`,
					...CORS,
				},
			});
		}
		for (const [k, v] of Object.entries(CORS)) respuesta.headers.set(k, v);
		return respuesta;
	},
};

// ---------- /authorize y páginas propias ----------

/** Freno: 5 intentos fallidos cada 15 minutos por IP. */
const MAX_FALLOS = 5;
const VENTANA = 15 * 60;
async function fallosDe(env: Env, ip: string): Promise<number> {
	return Number((await env.OAUTH_KV.get(`freno:${ip}`)) ?? 0);
}
async function sumarFallo(env: Env, ip: string): Promise<void> {
	const n = (await fallosDe(env, ip)) + 1;
	await env.OAUTH_KV.put(`freno:${ip}`, String(n), { expirationTtl: VENTANA });
}

async function mostrarAutorizar(datos: DatosPagina, headers?: Headers, status = 200): Promise<Response> {
	const h = cabecerasSeguras({ 'Content-Type': 'text/html; charset=utf-8' });
	// Las cabeceras del consentimiento (galleta que ata la página al navegador, anti-marcos) se suman
	// a las nuestras sin duplicar: las galletas se añaden; el resto sustituye.
	headers?.forEach((valor, nombre) => (nombre.toLowerCase() === 'set-cookie' ? h.append(nombre, valor) : h.set(nombre, valor)));
	h.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'; base-uri 'none'");
	return new Response(paginaAutorizar(datos), { status, headers: h });
}

async function authorize(request: Request, env: Env): Promise<Response> {
	const oauth = env.OAUTH_PROVIDER;
	const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
	try {
		if (request.method === 'GET') {
			const peticion = await oauth.parseAuthRequest(request);
			const info = await oauth.describeConsent(peticion);
			const consentimiento = await oauth.beginConsent(peticion);
			const datos: DatosPagina = {
				sitio: env.SITE_NAME,
				wpUrl: env.WP_URL,
				cliente: info.clientName || 'Una aplicación',
				clienteVerificado: info.clientDomain,
				destino: info.redirectHost,
				destinoLocal: info.redirectIsLoopback,
				handle: consentimiento.handle,
			};
			// Para volver a pintar la página si la contraseña no vale (sin consumir el consentimiento).
			await env.OAUTH_KV.put(`pagina:${consentimiento.handle}`, JSON.stringify(datos), { expirationTtl: 600 });
			return mostrarAutorizar(datos, consentimiento.headers);
		}

		if (request.method === 'POST') {
			const form = await request.formData();
			const handle = String(form.get('handle') ?? '');
			if (form.get('decision') !== 'approve') {
				const denegado = await oauth.denyConsent(request, handle);
				return new Response(null, { status: 302, headers: denegado.headers });
			}
			const guardada = await env.OAUTH_KV.get(`pagina:${handle}`);
			if (!guardada) {
				return paginaSimple('La página ha caducado', '<p>Han pasado más de diez minutos. Vuelve a la aplicación y empieza de nuevo la conexión.</p>', 400);
			}
			const datos = JSON.parse(guardada) as DatosPagina;
			const usuario = String(form.get('usuario') ?? '').trim();
			const clave = String(form.get('clave') ?? '').trim();
			datos.usuario = usuario;

			if ((await fallosDe(env, ip)) >= MAX_FALLOS) {
				return mostrarAutorizar({ ...datos, error: 'Demasiados intentos fallidos. Espera 15 minutos y vuelve a probar.' }, undefined, 429);
			}
			const basic = cabeceraBasic(usuario, clave);
			const quien = usuario && clave ? await comprobarCredencial(env.WP_URL, basic) : null;
			if (!quien) {
				await sumarFallo(env, ip);
				return mostrarAutorizar({ ...datos, error: 'WordPress no acepta ese usuario con esa contraseña de aplicación. Recuerda: no es la contraseña de entrar, sino una de «Contraseñas de aplicación».' }, undefined, 401);
			}
			if (!quien.puedeEditar) {
				return mostrarAutorizar({ ...datos, error: 'Ese usuario de WordPress no puede editar contenidos.' }, undefined, 403);
			}

			const aprobado = await oauth.approveConsent(request, handle, { scope: [ESCOPO] });
			await env.OAUTH_KV.delete(`pagina:${handle}`);
			const props: Props = { basic, usuario: quien.usuario, nombre: quien.nombre, wpId: quien.id };
			const { redirectTo } = await oauth.completeAuthorization({
				request: aprobado.request,
				userId: `wp-${quien.id}`,
				metadata: { usuario: quien.usuario, cliente: datos.cliente, fecha: new Date().toISOString() },
				scope: [ESCOPO],
				props,
			});
			aprobado.headers.set('Location', redirectTo);
			return new Response(null, { status: 302, headers: aprobado.headers });
		}
		return new Response('Método no permitido', { status: 405 });
	} catch (error) {
		if (error instanceof AuthorizationError && error.redirectTo) {
			return Response.redirect(error.redirectTo, 302);
		}
		if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
			const texto = error instanceof AuthorizationError ? error.description : 'No se ha podido verificar la aplicación.';
			return paginaSimple('No se puede continuar', `<p>${escapar(texto || 'Petición no válida.')}</p><p class="nota">Vuelve a la aplicación y empieza de nuevo la conexión.</p>`, 400);
		}
		throw error;
	}
}

const defaultHandler = {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/authorize') {
			return authorize(request, env);
		}
		if (url.pathname === '/' && request.method === 'GET') {
			return paginaSimple(
				'Puente MCP de WordPress',
				`<p class="ante">${escapar(env.SITE_NAME)}</p><p>Este servicio deja que ChatGPT y Claude usen el MCP de <strong>${escapar(env.WP_URL)}</strong> con una contraseña de aplicación de WordPress.</p><p>Dirección para el conector: <code>${escapar(env.BRIDGE_URL)}/mcp</code></p>`
			);
		}
		return new Response('No encontrado', { status: 404 });
	},
};

// El proveedor necesita su propia URL pública, que llega como variable: se crea con el primer `env`.
let proveedor: OAuthProvider<Env> | null = null;
function obtenerProveedor(env: Env): OAuthProvider<Env> {
	if (proveedor) return proveedor;
	proveedor = new OAuthProvider<Env>({
		apiRoute: '/mcp',
		apiHandler: apiHandler as never,
		defaultHandler: defaultHandler as never,
		authorizeEndpoint: '/authorize',
		tokenEndpoint: '/token',
		clientRegistrationEndpoint: '/register',
		scopesSupported: [ESCOPO, 'offline_access'],
		requiredScopes: [ESCOPO],
		accessTokenTTL: 60 * 60,
		refreshTokenTTL: 30 * 24 * 60 * 60,
		resourceMetadata: {
			resource: `${env.BRIDGE_URL}/mcp`,
			authorization_servers: [env.BRIDGE_URL],
			resource_name: `MCP de ${env.SITE_NAME}`,
		},
		clientRegistrationCallback: ({ clientMetadata }: ClientRegistrationCallbackOptions) => {
			const uris = Array.isArray(clientMetadata.redirect_uris) ? (clientMetadata.redirect_uris as string[]) : [];
			if (!uris.length || !uris.every((u) => typeof u === 'string' && redireccionPermitida(u, env))) {
				return { code: 'invalid_redirect_uri', description: 'Este puente solo admite ChatGPT, Claude y programas locales.', status: 400 };
			}
		},
	});
	return proveedor;
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		if (request.method === 'OPTIONS' && new URL(request.url).pathname === '/mcp') {
			return Promise.resolve(new Response(null, { status: 204, headers: { ...CORS, 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Last-Event-ID' } }));
		}
		return obtenerProveedor(env).fetch(request, env, ctx);
	},
};
