/**
 * Herramienta propia del puente: `subir_imagen`.
 *
 * El MCP de WordPress no puede recibir un archivo adjuntado en el chat: ChatGPT solo entrega
 * archivos a herramientas que lo declaran con `_meta["openai/fileParams"]`, y da un enlace
 * temporal (`download_url`). El puente añade esta herramienta a la lista de WordPress; al
 * llamarla, descarga el archivo, lo pasa a base64 y llama a la capacidad de WordPress que
 * guarda imágenes (variable UPLOAD_ABILITY, por ejemplo `sanroman/subir-imagen`).
 * Claude u otros clientes pueden pasar `url` o `datos_base64` en su lugar.
 */

export const NOMBRE = 'subir_imagen';
const MAX_BYTES = 10 * 1024 * 1024;

export function definicion(carpetas: string[]) {
	return {
		name: NOMBRE,
		title: 'Subir una imagen a la web',
		description:
			'Sube a la biblioteca de Medios de la web una imagen que la persona ha adjuntado en el chat (logo, cartel, foto), ordenada en su carpeta y con nombre limpio. Devuelve imagen_id: úsalo después en las capacidades que aceptan imagen_id (por ejemplo, guardar una empresa con su logo o publicar una noticia con su cartel). Si la imagen ya está en internet, pasa su url en vez del archivo.',
		inputSchema: {
			type: 'object',
			properties: {
				archivo: {
					type: 'object',
					description: 'La imagen adjuntada en el chat.',
					properties: {
						download_url: { type: 'string' },
						file_id: { type: 'string' },
						file_name: { type: 'string' },
						mime_type: { type: 'string' },
					},
					required: ['download_url', 'file_id'],
				},
				url: { type: 'string', description: 'O una dirección https de la imagen.' },
				datos_base64: { type: 'string', description: 'O la imagen en base64.' },
				titulo: { type: 'string', description: 'Título claro, por ejemplo «Logo de Panadería Ejemplo».' },
				alt: { type: 'string', description: 'Qué se ve en la imagen, para quien no puede verla.' },
				...(carpetas.length ? { carpeta: { type: 'string', enum: carpetas, description: 'Carpeta de Medios donde guardarla.' } } : {}),
			},
			required: ['titulo', ...(carpetas.length ? ['carpeta'] : [])],
		},
		annotations: { title: 'Subir una imagen a la web', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		_meta: { 'openai/fileParams': ['archivo'] },
	};
}

function aBase64(bytes: Uint8Array): string {
	let binario = '';
	const trozo = 0x8000;
	for (let i = 0; i < bytes.length; i += trozo) {
		binario += String.fromCharCode(...bytes.subarray(i, i + trozo));
	}
	return btoa(binario);
}

/**
 * Convierte la llamada a `subir_imagen` en una llamada a la capacidad de WordPress.
 * Devuelve el cuerpo JSON-RPC nuevo o un error para el cliente.
 */
export async function traducir(
	cuerpo: { jsonrpc: string; id: unknown; params: { arguments?: Record<string, unknown> } },
	habilidad: string
): Promise<{ cuerpo: unknown } | { error: string }> {
	const args = cuerpo.params.arguments ?? {};
	const parametros: Record<string, unknown> = {
		titulo: args.titulo,
		alt: args.alt,
		carpeta: args.carpeta,
	};
	const archivo = args.archivo as { download_url?: string; file_name?: string } | undefined;
	if (archivo?.download_url) {
		if (!/^https:\/\//.test(archivo.download_url)) {
			return { error: 'El enlace del archivo no es https.' };
		}
		const r = await fetch(archivo.download_url, { redirect: 'follow' });
		if (!r.ok) {
			return { error: `No se ha podido descargar el archivo adjunto (${r.status}).` };
		}
		const largo = Number(r.headers.get('content-length') ?? 0);
		if (largo > MAX_BYTES) {
			return { error: 'La imagen pasa de 10 MB.' };
		}
		const bytes = new Uint8Array(await r.arrayBuffer());
		if (bytes.length > MAX_BYTES) {
			return { error: 'La imagen pasa de 10 MB.' };
		}
		parametros.datos_base64 = aBase64(bytes);
		parametros.nombre_archivo = archivo.file_name;
	} else if (typeof args.url === 'string' && args.url) {
		parametros.url = args.url;
	} else if (typeof args.datos_base64 === 'string' && args.datos_base64) {
		parametros.datos_base64 = args.datos_base64;
	} else {
		return { error: 'Falta la imagen: adjúntala en el chat o da una url.' };
	}
	return {
		cuerpo: {
			jsonrpc: cuerpo.jsonrpc ?? '2.0',
			id: cuerpo.id,
			method: 'tools/call',
			params: { name: 'mcp-adapter-execute-ability', arguments: { ability_name: habilidad, parameters: parametros } },
		},
	};
}
