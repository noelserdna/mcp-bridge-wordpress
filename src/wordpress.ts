/**
 * Todo lo que el puente sabe de WordPress: comprobar una contraseña de aplicación
 * y reenviar las peticiones MCP al plugin MCP Adapter.
 */

export interface UsuarioWordPress {
	id: number;
	usuario: string;
	nombre: string;
	puedeEditar: boolean;
}

/** Cabecera Basic con usuario y contraseña de aplicación. */
export function cabeceraBasic(usuario: string, clave: string): string {
	const bytes = new TextEncoder().encode(`${usuario}:${clave}`);
	let binario = '';
	for (const b of bytes) binario += String.fromCharCode(b);
	return btoa(binario);
}

/**
 * Pregunta a WordPress quién es el dueño de esa credencial.
 * WordPress solo acepta contraseñas de aplicación por Basic: la contraseña normal no vale.
 * Devuelve null si WordPress la rechaza.
 */
export async function comprobarCredencial(wpUrl: string, basic: string): Promise<UsuarioWordPress | null> {
	const respuesta = await fetch(`${wpUrl}/wp-json/wp/v2/users/me?context=edit&_fields=id,username,name,capabilities`, {
		headers: { Authorization: `Basic ${basic}`, Accept: 'application/json' },
		redirect: 'manual',
	});
	if (respuesta.status !== 200) {
		return null;
	}
	const datos = (await respuesta.json()) as { id: number; username?: string; name?: string; capabilities?: Record<string, boolean> };
	return {
		id: datos.id,
		usuario: datos.username ?? '',
		nombre: datos.name ?? datos.username ?? '',
		puedeEditar: Boolean(datos.capabilities?.edit_posts),
	};
}

// Cabeceras que viajan en ambos sentidos: estas y TODAS las que empiezan por «Mcp-».
// La especificación MCP 2026-07-28 añadió `Mcp-Method` (y puede añadir más): si el puente
// no las reenvía, WordPress responde «Header mismatch: Mcp-Method is missing».
const CABECERAS_IDA = ['content-type', 'accept', 'last-event-id'];
const CABECERAS_VUELTA = ['content-type', 'cache-control'];
const esMcp = (nombre: string) => nombre.toLowerCase().startsWith('mcp-');

/**
 * Reenvía una petición MCP al servidor por defecto del MCP Adapter con la credencial del usuario.
 */
export async function reenviarMcp(wpUrl: string, basic: string, peticion: Request, cambio?: { cuerpo: string; cabeceras: Record<string, string> }, ruta = '/wp-json/mcp/mcp-adapter-default-server'): Promise<Response> {
	const cabeceras = new Headers({ Authorization: `Basic ${basic}` });
	peticion.headers.forEach((valor, nombre) => {
		if (CABECERAS_IDA.includes(nombre.toLowerCase()) || esMcp(nombre)) cabeceras.set(nombre, valor);
	});
	if (cambio) {
		for (const [k, v] of Object.entries(cambio.cabeceras)) cabeceras.set(k, v);
	}
	const cuerpo = cambio ? cambio.cuerpo : peticion.method === 'GET' || peticion.method === 'HEAD' ? undefined : await peticion.arrayBuffer();
	const respuesta = await fetch(`${wpUrl}${ruta}`, {
		method: peticion.method,
		headers: cabeceras,
		body: cuerpo,
		redirect: 'manual',
	});
	const vuelta = new Headers();
	respuesta.headers.forEach((valor, nombre) => {
		if (CABECERAS_VUELTA.includes(nombre.toLowerCase()) || esMcp(nombre)) vuelta.set(nombre, valor);
	});
	return new Response(respuesta.body, { status: respuesta.status, headers: vuelta });
}
