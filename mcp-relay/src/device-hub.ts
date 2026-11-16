import { DurableObject } from 'cloudflare:workers';
import { parseCatalog, type ToolCatalog } from './catalog';
import { constantTimeEqual, randomToken, sha256Hex } from './crypto';
import type { Env } from './env';

export interface CallOutcome {
	ok: boolean;
	result?: unknown;
	error?: string;
}

interface PendingCall {
	resolve: (outcome: CallOutcome) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface StoredTicket {
	hash: string;
	expiresAt: number;
}

// Le traitement d'un gros PDF (OCR, ré-analyse de page) peut dépasser la minute.
const CALL_TIMEOUT_MS = 120_000;
const TICKET_TTL_MS = 60_000;

/**
 * Un Slate (appareil) = une instance. Elle garde la WebSocket ouverte par Slate
 * et y relaie les appels d'outils des IA autorisées pour cet appareil.
 */
export class DeviceHub extends DurableObject<Env> {
	private pending = new Map<string, PendingCall>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// Le battement de cœur de Slate ne réveille pas l'objet hiberné.
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
	}

	async register(secretHash: string): Promise<void> {
		if (await this.ctx.storage.get('secretHash')) throw new Error('device_exists');
		await this.ctx.storage.put({ secretHash, createdAt: Date.now() });
	}

	async verify(secret: string): Promise<boolean> {
		const stored = await this.ctx.storage.get<string>('secretHash');
		if (!stored) return false;
		return constantTimeEqual(await sha256Hex(secret), stored);
	}

	async issueTicket(): Promise<string> {
		const ticket = randomToken();
		const record: StoredTicket = { hash: await sha256Hex(ticket), expiresAt: Date.now() + TICKET_TTL_MS };
		await this.ctx.storage.put('ticket', record);
		return ticket;
	}

	async isOnline(): Promise<boolean> {
		return this.openSocket() !== null;
	}

	/** Outils annoncés par la dernière connexion de Slate (null avant la première). */
	async catalog(): Promise<ToolCatalog | null> {
		return (await this.ctx.storage.get<ToolCatalog>('catalog')) ?? null;
	}

	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
			return new Response('Expected WebSocket', { status: 426 });
		}
		const ticket = new URL(request.url).searchParams.get('ticket') ?? '';
		const stored = await this.ctx.storage.get<StoredTicket>('ticket');
		await this.ctx.storage.delete('ticket');
		if (!stored || stored.expiresAt < Date.now() || !constantTimeEqual(await sha256Hex(ticket), stored.hash)) {
			return new Response('Invalid ticket', { status: 401 });
		}
		for (const socket of this.ctx.getWebSockets()) socket.close(4001, 'replaced');
		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];
		this.ctx.acceptWebSocket(server);
		return new Response(null, { status: 101, webSocket: client });
	}

	override async webSocketMessage(_socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
		if (typeof message !== 'string') return;
		let data: { type?: unknown; id?: unknown; ok?: unknown; result?: unknown; error?: unknown; catalog?: unknown };
		try {
			data = JSON.parse(message);
		} catch {
			return;
		}
		if (data.type === 'catalog') {
			const catalog = parseCatalog(data.catalog);
			if (catalog) await this.ctx.storage.put('catalog', catalog);
			return;
		}
		if (data.type !== 'result' || typeof data.id !== 'string') return;
		const call = this.pending.get(data.id);
		if (!call) return;
		clearTimeout(call.timer);
		this.pending.delete(data.id);
		call.resolve(
			data.ok === true
				? { ok: true, result: data.result }
				: { ok: false, error: typeof data.error === 'string' ? data.error : 'slate_error' }
		);
	}

	override async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
		try {
			socket.close(code, reason);
		} catch {
			/* déjà fermée */
		}
		this.failPendingIfOffline();
	}

	override async webSocketError(): Promise<void> {
		this.failPendingIfOffline();
	}

	async call(tool: string, args: unknown, client: string): Promise<CallOutcome> {
		const socket = this.openSocket();
		if (!socket) return { ok: false, error: 'slate_offline' };
		const id = crypto.randomUUID();
		return new Promise<CallOutcome>((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				resolve({ ok: false, error: 'timeout' });
			}, CALL_TIMEOUT_MS);
			this.pending.set(id, { resolve, timer });
			try {
				socket.send(JSON.stringify({ type: 'call', id, tool, args, client }));
			} catch {
				clearTimeout(timer);
				this.pending.delete(id);
				resolve({ ok: false, error: 'slate_offline' });
			}
		});
	}

	async notify(payload: Record<string, unknown>): Promise<void> {
		this.openSocket()?.send(JSON.stringify(payload));
	}

	private openSocket(): WebSocket | null {
		return this.ctx.getWebSockets().find((socket) => socket.readyState === WebSocket.OPEN) ?? null;
	}

	private failPendingIfOffline(): void {
		if (this.openSocket()) return;
		for (const [id, call] of this.pending) {
			clearTimeout(call.timer);
			call.resolve({ ok: false, error: 'slate_disconnected' });
			this.pending.delete(id);
		}
	}
}
