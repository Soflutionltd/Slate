import { randomHex, randomToken, sha256Hex } from './crypto';
import type { Env } from './env';

const DEVICE_ID_PATTERN = /^[0-9a-f]{32}$/;

// Slate appelle ces routes depuis sa webview (tauri://localhost) ou depuis la version web :
// l'authentification passe par un jeton porteur, jamais par un cookie.
const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Authorization, Content-Type',
	'Access-Control-Max-Age': '86400'
};

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS_HEADERS }
	});
}

function hubFor(env: Env, deviceId: string) {
	return env.DEVICE_HUB.get(env.DEVICE_HUB.idFromName(deviceId));
}

async function authenticate(request: Request, env: Env): Promise<string | null> {
	const header = request.headers.get('Authorization') ?? '';
	const match = /^Bearer ([0-9a-f]{32})\.([A-Za-z0-9_-]{43})$/.exec(header);
	if (!match) return null;
	const [, deviceId, secret] = match;
	if (!deviceId || !secret) return null;
	return (await hubFor(env, deviceId).verify(secret)) ? deviceId : null;
}

async function listClients(env: Env, deviceId: string) {
	const clients: { id: string; name: string; connectedAt: number }[] = [];
	let cursor: string | undefined;
	do {
		const page = await env.OAUTH_PROVIDER.listUserGrants(deviceId, { cursor });
		for (const grant of page.items) {
			const name = typeof grant.metadata?.clientName === 'string' ? grant.metadata.clientName : grant.clientId;
			clients.push({ id: grant.id, name, connectedAt: grant.createdAt });
		}
		cursor = page.cursor;
	} while (cursor);
	return clients.sort((a, b) => b.connectedAt - a.connectedAt);
}

export async function handleDeviceApi(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

	if (url.pathname === '/device/register' && request.method === 'POST') {
		const deviceId = randomHex(16);
		const secret = randomToken(32);
		await hubFor(env, deviceId).register(await sha256Hex(secret));
		return json({ deviceId, secret }, 201);
	}

	// La WebSocket ne peut pas porter d'en-tête Authorization depuis un navigateur :
	// Slate obtient d'abord un ticket à usage unique, valable une minute.
	if (url.pathname === '/device/ws' && request.method === 'GET') {
		const deviceId = url.searchParams.get('device') ?? '';
		if (!DEVICE_ID_PATTERN.test(deviceId)) return new Response('Invalid device', { status: 400 });
		return hubFor(env, deviceId).fetch(request);
	}

	const deviceId = await authenticate(request, env);
	if (!deviceId) return json({ error: 'unauthorized' }, 401);

	if (url.pathname === '/device/ws-ticket' && request.method === 'POST') {
		const ticket = await hubFor(env, deviceId).issueTicket();
		const socketUrl = new URL('/device/ws', url);
		socketUrl.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
		socketUrl.searchParams.set('device', deviceId);
		socketUrl.searchParams.set('ticket', ticket);
		return json({ url: socketUrl.toString() });
	}

	if (url.pathname === '/device/pairing-code' && request.method === 'POST') {
		const registry = env.PAIRING.get(env.PAIRING.idFromName('global'));
		return json(await registry.create(deviceId));
	}

	if (url.pathname === '/device/clients' && request.method === 'GET') {
		return json({ clients: await listClients(env, deviceId) });
	}

	if (url.pathname === '/device/revoke' && request.method === 'POST') {
		let body: { clientId?: unknown };
		try {
			body = await request.json();
		} catch {
			return json({ error: 'invalid_json' }, 400);
		}
		const clients = await listClients(env, deviceId);
		const targets =
			body.clientId === 'all' ? clients : clients.filter((client) => client.id === body.clientId);
		if (!targets.length) return json({ error: 'not_found' }, 404);
		for (const client of targets) await env.OAUTH_PROVIDER.revokeGrant(client.id, deviceId);
		return json({ revoked: targets.length });
	}

	return json({ error: 'not_found' }, 404);
}
