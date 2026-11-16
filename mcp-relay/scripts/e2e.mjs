// Parcours complet contre `wrangler dev` : un faux Slate (WebSocket) et un faux client IA (OAuth + MCP).
// Usage : npm run dev (dans un autre terminal), puis npm run e2e [-- http://localhost:8787]
import { createHash, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';

const BASE = process.argv[2] ?? 'http://localhost:8787';
const REDIRECT_URI = 'http://localhost:9999/callback';

const base64url = (buffer) => buffer.toString('base64url');
const step = (label) => console.log(`\n▸ ${label}`);

async function api(path, { method = 'GET', token, body } = {}) {
	const response = await fetch(`${BASE}${path}`, {
		method,
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			...(body ? { 'Content-Type': 'application/json' } : {})
		},
		body: body ? JSON.stringify(body) : undefined
	});
	const text = await response.text();
	return { status: response.status, data: text ? JSON.parse(text) : null };
}

function cookieHeader(response, jar) {
	for (const cookie of response.headers.getSetCookie()) {
		const [pair] = cookie.split(';');
		const [name, ...rest] = pair.split('=');
		jar.set(name.trim(), rest.join('='));
	}
	return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

function formField(html, name) {
	const match = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
	assert.ok(match, `champ ${name} absent de la page`);
	return match[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

async function openConsent(authorizeUrl, jar) {
	const response = await fetch(authorizeUrl, { headers: { 'Accept-Language': 'fr-FR', Cookie: cookieHeader({ headers: new Headers() }, jar) } });
	cookieHeader(response, jar);
	const html = await response.text();
	assert.equal(response.status, 200, html);
	return { html, handle: formField(html, 'handle'), retry: formField(html, 'retry') };
}

async function submitConsent(consent, jar, fields) {
	return fetch(`${BASE}/authorize`, {
		method: 'POST',
		redirect: 'manual',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			'Accept-Language': 'fr-FR',
			Origin: BASE,
			Cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
		},
		body: new URLSearchParams({ handle: consent.handle, retry: consent.retry, ...fields })
	});
}

let rpcId = 0;
async function mcp(accessToken, method, params) {
	const response = await fetch(`${BASE}/mcp`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${accessToken}`,
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
			'MCP-Protocol-Version': '2025-06-18'
		},
		body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params })
	});
	const text = await response.text();
	if (response.status !== 200) return { status: response.status, text };
	const payload = response.headers.get('content-type')?.includes('text/event-stream')
		? text
				.split('\n')
				.filter((line) => line.startsWith('data:'))
				.map((line) => JSON.parse(line.slice(5)))
				.find((message) => message.id === rpcId)
		: JSON.parse(text);
	return { status: 200, payload };
}

// ── 1. Slate s'enregistre et ouvre sa WebSocket ───────────────────────────────
step('Slate : enregistrement de l’appareil');
const registered = await api('/device/register', { method: 'POST' });
assert.equal(registered.status, 201);
const deviceToken = `${registered.data.deviceId}.${registered.data.secret}`;
assert.equal((await api('/device/clients', { token: `${registered.data.deviceId}.${'A'.repeat(43)}` })).status, 401);

step('Slate : WebSocket');
const ticket = await api('/device/ws-ticket', { method: 'POST', token: deviceToken });
assert.equal(ticket.status, 200);
const received = [];
const socket = new WebSocket(ticket.data.url);
await new Promise((resolve, reject) => {
	socket.addEventListener('open', resolve, { once: true });
	socket.addEventListener('error', reject, { once: true });
});
socket.addEventListener('message', (event) => {
	const message = JSON.parse(event.data);
	received.push(message);
	if (message.type !== 'call') return;
	const reply =
		message.tool === 'list_documents'
			? { type: 'result', id: message.id, ok: true, result: { documents: [{ id: 'doc-1', name: 'Contrat.pdf', pages: 3, active: true }] } }
			: { type: 'result', id: message.id, ok: false, error: `Outil ${message.tool} non simulé` };
	socket.send(JSON.stringify(reply));
});
const reuse = await new Promise((resolve) => {
	const again = new WebSocket(ticket.data.url);
	again.addEventListener('error', () => resolve('refusé'));
	again.addEventListener('open', () => resolve('accepté'));
});
assert.equal(reuse, 'refusé', 'un ticket ne doit servir qu’une fois');

step('Slate : code de couplage');
const pairing = await api('/device/pairing-code', { method: 'POST', token: deviceToken });
assert.match(pairing.data.code, /^\d{6}$/);
console.log('  code', pairing.data.code);

// ── 2. Le client IA découvre le serveur et s'inscrit (DCR) ────────────────────
step('IA : découverte OAuth');
const unauthenticated = await fetch(`${BASE}/mcp`, { method: 'POST' });
assert.equal(unauthenticated.status, 401);
console.log('  WWW-Authenticate', unauthenticated.headers.get('www-authenticate'));
const resourceMeta = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
assert.equal(resourceMeta.resource, `${BASE}/mcp`);
const serverMeta = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();

step('IA : inscription dynamique');
const registration = await fetch(serverMeta.registration_endpoint, {
	method: 'POST',
	headers: { 'Content-Type': 'application/json' },
	body: JSON.stringify({
		client_name: 'Test <IA>',
		redirect_uris: [REDIRECT_URI],
		token_endpoint_auth_method: 'none',
		grant_types: ['authorization_code', 'refresh_token'],
		response_types: ['code']
	})
});
assert.equal(registration.status, 201, await registration.clone().text());
const { client_id: clientId } = await registration.json();

// ── 3. Page de consentement : mauvais code, puis bon code ─────────────────────
const verifier = base64url(randomBytes(32));
const challenge = base64url(createHash('sha256').update(verifier).digest());
const authorizeUrl = new URL(serverMeta.authorization_endpoint);
authorizeUrl.search = new URLSearchParams({
	response_type: 'code',
	client_id: clientId,
	redirect_uri: REDIRECT_URI,
	code_challenge: challenge,
	code_challenge_method: 'S256',
	state: 'etat-123',
	resource: `${BASE}/mcp`
}).toString();
const jar = new Map();

step('Consentement : page');
let consent = await openConsent(authorizeUrl, jar);
assert.ok(consent.html.includes('Connecter Test &lt;IA&gt; à Slate'), 'nom du client échappé');

step('Consentement : mauvais code');
const wrongCode = pairing.data.code === '000000' ? '111111' : '000000';
const rejected = await submitConsent(consent, jar, { decision: 'approve', code: wrongCode });
assert.equal(rejected.status, 303);
const retryUrl = rejected.headers.get('location');
assert.ok(retryUrl.includes('slate_error=invalid'));
consent = await openConsent(retryUrl, jar);
assert.ok(consent.html.includes('Code incorrect'), 'message d’erreur affiché');

step('Consentement : bon code');
const approved = await submitConsent(consent, jar, { decision: 'approve', code: pairing.data.code });
assert.equal(approved.status, 302, await approved.clone().text());
const callback = new URL(approved.headers.get('location'));
assert.equal(callback.origin + callback.pathname, REDIRECT_URI);
assert.equal(callback.searchParams.get('state'), 'etat-123');
const authorizationCode = callback.searchParams.get('code');
assert.ok(authorizationCode);

step('Consentement : le code de couplage ne sert qu’une fois');
const replay = await submitConsent(await openConsent(authorizeUrl, jar), jar, { decision: 'approve', code: pairing.data.code });
assert.equal(replay.status, 303);

step('IA : échange du code contre un jeton');
const tokenResponse = await fetch(serverMeta.token_endpoint, {
	method: 'POST',
	headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
	body: new URLSearchParams({
		grant_type: 'authorization_code',
		code: authorizationCode,
		redirect_uri: REDIRECT_URI,
		client_id: clientId,
		code_verifier: verifier,
		resource: `${BASE}/mcp`
	})
});
const tokens = await tokenResponse.json();
assert.equal(tokenResponse.status, 200, JSON.stringify(tokens));
assert.ok(tokens.access_token && tokens.refresh_token);

// ── 4. MCP : initialisation, liste d'outils, appel relayé jusqu'à Slate ───────
step('MCP : initialize');
const init = await mcp(tokens.access_token, 'initialize', {
	protocolVersion: '2025-06-18',
	capabilities: {},
	clientInfo: { name: 'e2e', version: '1.0.0' }
});
assert.equal(init.status, 200, init.text);
assert.equal(init.payload.result.serverInfo.name, 'slate');

step('MCP : tools/list');
const list = await mcp(tokens.access_token, 'tools/list', {});
const toolNames = list.payload.result.tools.map((tool) => tool.name);
console.log(' ', toolNames.join(', '));
assert.equal(toolNames.length, 11);

step('MCP : tools/call list_documents → Slate');
const call = await mcp(tokens.access_token, 'tools/call', { name: 'list_documents', arguments: {} });
const callResult = call.payload.result;
assert.ok(!callResult.isError, JSON.stringify(callResult));
assert.ok(callResult.content[0].text.includes('Contrat.pdf'));
const relayed = received.find((message) => message.type === 'call');
assert.equal(relayed.client, 'Test <IA>');

step('MCP : erreur remontée par Slate');
const failing = await mcp(tokens.access_token, 'tools/call', { name: 'undo', arguments: { steps: 2 } });
assert.equal(failing.payload.result.isError, true);

step('MCP : arguments invalides refusés par le relais');
const invalid = await mcp(tokens.access_token, 'tools/call', { name: 'get_page_layout', arguments: { page: 0 } });
assert.ok(invalid.payload.error || invalid.payload.result?.isError, JSON.stringify(invalid.payload));
assert.equal(received.filter((message) => message.tool === 'get_page_layout').length, 0);

// ── 5. Gestion des IA connectées depuis Slate ─────────────────────────────────
step('Slate : liste des IA connectées');
assert.ok(received.some((message) => message.type === 'clients_changed'), 'Slate prévenu de la nouvelle IA');
const clients = await api('/device/clients', { token: deviceToken });
assert.equal(clients.data.clients.length, 1);
assert.equal(clients.data.clients[0].name, 'Test <IA>');

step('Slate hors ligne : erreur claire');
socket.close();
await new Promise((resolve) => setTimeout(resolve, 300));
const offline = await mcp(tokens.access_token, 'tools/call', { name: 'list_documents', arguments: {} });
assert.equal(offline.payload.result.isError, true);
assert.ok(offline.payload.result.content[0].text.includes('Slate is not reachable'));

step('Slate : révocation');
const revoked = await api('/device/revoke', { method: 'POST', token: deviceToken, body: { clientId: 'all' } });
assert.equal(revoked.data.revoked, 1);
const afterRevoke = await mcp(tokens.access_token, 'tools/list', {});
assert.equal(afterRevoke.status, 401);

console.log('\n✓ Parcours complet OK');
