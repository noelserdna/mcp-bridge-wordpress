// Comprueba el freno: tras 5 contraseñas equivocadas, la página responde 429 aunque la siguiente sea buena.
import crypto from 'node:crypto';
const BRIDGE = process.env.BRIDGE ?? 'http://localhost:8787';
const CALLBACK = 'http://localhost:9999/callback';
const as = await (await fetch(`${BRIDGE}/.well-known/oauth-authorization-server`)).json();
const cliente = await (await fetch(as.registration_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Freno', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' }) })).json();
const reto = Buffer.from(crypto.createHash('sha256').update('x'.repeat(50)).digest()).toString('base64url');
const r0 = await fetch(`${as.authorization_endpoint}?` + new URLSearchParams({ response_type: 'code', client_id: cliente.client_id, redirect_uri: CALLBACK, code_challenge: reto, code_challenge_method: 'S256', state: 's', scope: 'mcp' }), { redirect: 'manual' });
const galleta = (r0.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
const handle = (await r0.text()).match(/name="handle" value="([^"]+)"/)[1];
const estados = [];
for (let i = 0; i < 7; i++) {
	const clave = i === 6 ? process.env.WP_APP_PASSWORD : 'mal' + i;
	const r = await fetch(as.authorization_endpoint, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: galleta }, body: new URLSearchParams({ handle, decision: 'approve', usuario: process.env.WP_USER, clave }) });
	estados.push(r.status);
}
console.log('intentos:', estados.join(' '), estados.slice(0, 5).every((s) => s === 401) && estados[5] === 429 && estados[6] === 429 ? '✓ freno correcto' : '✗ freno incorrecto');
