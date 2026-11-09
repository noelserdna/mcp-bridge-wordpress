/**
 * Página de autorización: la que ve la persona cuando ChatGPT o Claude piden conectarse.
 * Todo lo que viene del cliente (nombre, dominio) se escapa: lo elige quien se registra.
 */

export const escapar = (texto: string) => texto.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export interface DatosPagina {
	sitio: string;
	wpUrl: string;
	cliente: string;
	clienteVerificado?: string;
	destino: string;
	destinoLocal: boolean;
	handle: string;
	error?: string;
	usuario?: string;
}

const ESTILO = `
:root { --pizarra:#1E2A2F; --rojo:#A3242B; --oro:#B8862B; --granito:#F1EFEB; --gris:#4A5357; --linea:#DEDAD3; }
* { box-sizing: border-box; }
body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:16px; background:var(--granito); color:var(--pizarra); font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
main { width:100%; max-width:440px; background:#fff; border-radius:16px; border-top:6px solid var(--rojo); padding:28px 24px; box-shadow:0 10px 30px rgba(30,42,47,.12); }
.ante { margin:0; color:#7A5A12; font-size:13px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; }
h1 { margin:.25rem 0 1rem; font-size:24px; line-height:1.25; }
p { margin:0 0 1rem; }
.nota { font-size:14px; color:var(--gris); }
.aviso { padding:.75rem 1rem; border-radius:10px; background:#FBEAEA; color:#7E1A20; font-weight:600; }
.local { padding:.75rem 1rem; border-radius:10px; background:#FFF6DD; }
label { display:block; font-weight:700; margin:1rem 0 .35rem; }
input[type=text], input[type=password] { width:100%; min-height:48px; padding:0 12px; border:1.5px solid #8C8F94; border-radius:10px; font:inherit; font-size:17px; }
input:focus-visible, button:focus-visible, a:focus-visible { outline:3px solid var(--oro); outline-offset:2px; }
.ayuda { font-size:14px; color:var(--gris); margin:.35rem 0 0; }
.botones { display:flex; flex-wrap:wrap; gap:10px; margin-top:1.5rem; }
button { min-height:48px; padding:0 20px; border-radius:999px; font:inherit; font-weight:700; cursor:pointer; }
.si { background:var(--rojo); border:0; color:#fff; flex:1 1 auto; }
.no { background:#fff; border:1.5px solid var(--pizarra); color:var(--pizarra); }
a { color:var(--rojo); }
`;

export function paginaAutorizar(d: DatosPagina): string {
	const cliente = escapar(d.cliente);
	const origen = d.clienteVerificado
		? `Publicada por <strong>${escapar(d.clienteVerificado)}</strong>.`
		: 'Esta aplicación se ha registrado sola: su nombre no está verificado.';
	const perfil = `${escapar(d.wpUrl)}/wp-admin/profile.php#application-passwords-section`;
	return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Autorizar a ${cliente}</title>
<style>${ESTILO}</style>
</head>
<body>
<main>
	<p class="ante">${escapar(d.sitio)}</p>
	<h1>¿Dejar que ${cliente} gestione la web?</h1>
	<p>${origen} El acceso irá a <strong>${escapar(d.destino)}</strong>.</p>
	${d.destinoLocal ? '<p class="local"><strong>El acceso irá a un programa de este ordenador.</strong> Sigue solo si acabas de conectarlo tú.</p>' : ''}
	<p class="nota">Podrá hacer lo mismo que tu usuario de WordPress (publicar noticias, cambiar fichas…). Lo puedes cortar cuando quieras borrando la contraseña de aplicación en tu perfil.</p>
	${d.error ? `<p class="aviso" role="alert">${escapar(d.error)}</p>` : ''}
	<form method="post" autocomplete="off">
		<input type="hidden" name="handle" value="${escapar(d.handle)}">
		<label for="usuario">Usuario de WordPress</label>
		<input type="text" id="usuario" name="usuario" required autocapitalize="none" spellcheck="false" value="${escapar(d.usuario ?? '')}">
		<label for="clave">Contraseña de aplicación</label>
		<input type="password" id="clave" name="clave" required aria-describedby="clave-ayuda" autocomplete="off">
		<p class="ayuda" id="clave-ayuda">No es la contraseña con la que entras. Se crea en <a href="${perfil}" target="_blank" rel="noopener">tu perfil de WordPress → Contraseñas de aplicación</a>, una por aplicación (por ejemplo «ChatGPT»).</p>
		<div class="botones">
			<button class="si" type="submit" name="decision" value="approve">Autorizar</button>
			<button class="no" type="submit" name="decision" value="deny" formnovalidate>Cancelar</button>
		</div>
	</form>
</main>
</body>
</html>`;
}

export function paginaSimple(titulo: string, texto: string, status = 200): Response {
	const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapar(titulo)}</title><style>${ESTILO}</style></head><body><main><h1>${escapar(titulo)}</h1>${texto}</main></body></html>`;
	return new Response(html, { status, headers: cabecerasSeguras({ 'Content-Type': 'text/html; charset=utf-8' }) });
}

export function cabecerasSeguras(extra: Record<string, string> = {}): Headers {
	return new Headers({
		'X-Frame-Options': 'DENY',
		'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'; base-uri 'none'",
		'Referrer-Policy': 'no-referrer',
		'X-Content-Type-Options': 'nosniff',
		'Cache-Control': 'no-store',
		...extra,
	});
}
