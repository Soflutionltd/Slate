// Connexion de Slate au relais MCP distant (apps/mcp-relay) : les IA (ChatGPT,
// Claude, Le Chat…) appellent le relais, qui transmet chaque appel d'outil à
// Slate par cette WebSocket. Slate exécute dans le document ouvert et répond.

const DEFAULT_RELAY_ORIGIN = 'https://slate-mcp.antoinep-templates.workers.dev';
const ORIGIN_OVERRIDE_KEY = 'slate-ai-relay-origin';
const CREDENTIALS_KEY = 'slate-ai-relay-device';
const ENABLED_KEY = 'slate-ai-relay-enabled';
const HEARTBEAT_MS = 25_000;
const RECONNECT_MAX_MS = 30_000;
// Fermeture 4001 : une autre fenêtre Slate a pris la connexion de cet appareil.
const REPLACED_CLOSE_CODE = 4001;
const REPLACED_RETRY_MS = 60_000;

function relayOrigin() {
	try {
		const override = localStorage.getItem(ORIGIN_OVERRIDE_KEY);
		if (override && /^https?:\/\/[^/]+$/.test(override)) return override;
	} catch (_err) {
		/* stockage indisponible */
	}
	return DEFAULT_RELAY_ORIGIN;
}

function readCredentials() {
	try {
		const parsed = JSON.parse(localStorage.getItem(CREDENTIALS_KEY) || 'null');
		if (parsed?.origin === relayOrigin() && parsed.deviceId && parsed.secret) return parsed;
	} catch (_err) {
		/* identifiants illisibles : on en recrée */
	}
	return null;
}

export function isAiRelayEnabled() {
	try {
		return localStorage.getItem(ENABLED_KEY) === '1';
	} catch (_err) {
		return false;
	}
}

function setEnabledFlag(enabled) {
	try {
		if (enabled) localStorage.setItem(ENABLED_KEY, '1');
		else localStorage.removeItem(ENABLED_KEY);
	} catch (_err) {
		/* stockage indisponible */
	}
}

export class RelayError extends Error {
	constructor(code, status) {
		super(code);
		this.code = code;
		this.status = status;
	}
}

/**
 * @param {{
 *   execute: (tool: string, args: Record<string, unknown>, client: string) => Promise<unknown>,
 *   getCatalog: () => Promise<{ version: number, instructions: string, tools: object[] }>,
 *   onStatusChange?: (status: 'off' | 'connecting' | 'online' | 'offline') => void,
 *   onClientsChanged?: () => void
 * }} handlers
 */
export function createAiRelay({ execute, getCatalog, onStatusChange, onClientsChanged }) {
	let socket = null;
	let status = 'off';
	let running = false;
	let reconnectTimer = null;
	let heartbeatTimer = null;
	let attempt = 0;
	let queue = Promise.resolve();

	const setStatus = (next) => {
		if (status === next) return;
		status = next;
		onStatusChange?.(next);
	};

	async function request(path, { method = 'GET', body, auth = true } = {}) {
		const headers = {};
		if (body !== undefined) headers['Content-Type'] = 'application/json';
		if (auth) {
			const credentials = await ensureCredentials();
			headers.Authorization = `Bearer ${credentials.deviceId}.${credentials.secret}`;
		}
		const response = await fetch(`${relayOrigin()}${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body)
		});
		const payload = await response.json().catch(() => null);
		if (!response.ok) throw new RelayError(payload?.error || `http_${response.status}`, response.status);
		return payload;
	}

	async function ensureCredentials() {
		const existing = readCredentials();
		if (existing) return existing;
		const registered = await request('/device/register', { method: 'POST', auth: false });
		const credentials = { origin: relayOrigin(), deviceId: registered.deviceId, secret: registered.secret };
		localStorage.setItem(CREDENTIALS_KEY, JSON.stringify(credentials));
		return credentials;
	}

	// Appareil inconnu du relais (identifiants perdus côté serveur) : on repart
	// d'un appareil neuf, les IA devront être reconnectées avec un nouveau code.
	async function authed(path, options) {
		try {
			return await request(path, options);
		} catch (error) {
			if (!(error instanceof RelayError) || error.status !== 401) throw error;
			localStorage.removeItem(CREDENTIALS_KEY);
			return request(path, options);
		}
	}

	function clearTimers() {
		window.clearTimeout(reconnectTimer);
		window.clearInterval(heartbeatTimer);
		reconnectTimer = null;
		heartbeatTimer = null;
	}

	function scheduleReconnect(delay) {
		if (!running) return;
		window.clearTimeout(reconnectTimer);
		const backoff = delay ?? Math.min(RECONNECT_MAX_MS, 1000 * 2 ** attempt) * (0.75 + Math.random() * 0.5);
		attempt += 1;
		reconnectTimer = window.setTimeout(() => void connect(), backoff);
	}

	function send(payload) {
		if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
	}

	function handleCall(message) {
		const args = message.args && typeof message.args === 'object' ? message.args : {};
		const client = typeof message.client === 'string' ? message.client : 'IA';
		// Un appel à la fois : deux modifications concurrentes du même document
		// se marcheraient dessus (historique, file d'édition native).
		queue = queue.then(async () => {
			try {
				const result = await execute(message.tool, args, client);
				send({ type: 'result', id: message.id, ok: true, result: result ?? null });
			} catch (error) {
				send({
					type: 'result',
					id: message.id,
					ok: false,
					error: error instanceof Error ? error.message : String(error)
				});
			}
		});
	}

	async function connect() {
		if (!running) return;
		if (socket && socket.readyState <= WebSocket.OPEN) return;
		setStatus('connecting');
		let url;
		try {
			({ url } = await authed('/device/ws-ticket', { method: 'POST' }));
		} catch (error) {
			console.warn('Relais IA injoignable.', error);
			setStatus('offline');
			scheduleReconnect();
			return;
		}
		if (!running) return;
		const next = new WebSocket(url);
		socket = next;
		next.addEventListener('open', () => {
			if (socket !== next) return;
			attempt = 0;
			setStatus('online');
			// Le relais sert aux IA les outils de CETTE version de Slate.
			getCatalog()
				.then((catalog) => {
					if (socket === next) send({ type: 'catalog', catalog });
				})
				.catch((error) => console.warn('Catalogue des outils IA illisible.', error));
			window.clearInterval(heartbeatTimer);
			heartbeatTimer = window.setInterval(() => {
				if (next.readyState === WebSocket.OPEN) next.send('ping');
			}, HEARTBEAT_MS);
		});
		next.addEventListener('message', (event) => {
			if (socket !== next || typeof event.data !== 'string' || event.data === 'pong') return;
			let message;
			try {
				message = JSON.parse(event.data);
			} catch (_err) {
				return;
			}
			if (message?.type === 'call' && typeof message.id === 'string' && typeof message.tool === 'string') {
				handleCall(message);
			} else if (message?.type === 'clients_changed') {
				onClientsChanged?.();
			}
		});
		next.addEventListener('close', (event) => {
			if (socket !== next) return;
			socket = null;
			window.clearInterval(heartbeatTimer);
			if (!running) return;
			setStatus('offline');
			scheduleReconnect(event.code === REPLACED_CLOSE_CODE ? REPLACED_RETRY_MS : undefined);
		});
	}

	const reconnectNow = () => {
		if (!running || socket) return;
		attempt = 0;
		scheduleReconnect(0);
	};

	return {
		get status() {
			return status;
		},
		get mcpUrl() {
			return `${relayOrigin()}/mcp`;
		},
		start() {
			setEnabledFlag(true);
			if (running) return;
			running = true;
			window.addEventListener('online', reconnectNow);
			void connect();
		},
		stop() {
			setEnabledFlag(false);
			running = false;
			window.removeEventListener('online', reconnectNow);
			clearTimers();
			const current = socket;
			socket = null;
			current?.close(1000, 'disabled');
			setStatus('off');
		},
		async createPairingCode() {
			return authed('/device/pairing-code', { method: 'POST' });
		},
		async listClients() {
			const { clients } = await authed('/device/clients');
			return clients;
		},
		async revoke(clientId) {
			return authed('/device/revoke', { method: 'POST', body: { clientId } });
		}
	};
}
