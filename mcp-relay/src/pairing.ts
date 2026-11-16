import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';

interface PairingEntry {
	deviceId: string;
	expiresAt: number;
}

interface FailureEntry {
	count: number;
	since: number;
}

export type ConsumeResult = { deviceId: string } | { error: 'invalid' | 'rate_limited' };

const CODE_TTL_MS = 10 * 60_000;
const MAX_FAILURES = 8;
const FAILURE_WINDOW_MS = 15 * 60_000;

/**
 * Registre unique des codes de couplage à 6 chiffres. Un Durable Object (et non
 * KV) : le code écrit par Slate doit être lisible immédiatement par la page
 * d'autorisation, où qu'elle soit servie.
 */
export class PairingRegistry extends DurableObject<Env> {
	async create(deviceId: string): Promise<{ code: string; expiresAt: number }> {
		const now = Date.now();
		const codes = await this.ctx.storage.list<PairingEntry>({ prefix: 'code:' });
		const stale: string[] = [];
		for (const [key, entry] of codes) {
			if (entry.expiresAt < now || entry.deviceId === deviceId) stale.push(key);
		}
		const failures = await this.ctx.storage.list<FailureEntry>({ prefix: 'fail:' });
		for (const [key, entry] of failures) {
			if (now - entry.since >= FAILURE_WINDOW_MS) stale.push(key);
		}
		if (stale.length) await this.ctx.storage.delete(stale);

		let code: string;
		do {
			code = String((crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) % 1_000_000).padStart(6, '0');
		} while (codes.has(`code:${code}`) && !stale.includes(`code:${code}`));
		const expiresAt = now + CODE_TTL_MS;
		await this.ctx.storage.put(`code:${code}`, { deviceId, expiresAt } satisfies PairingEntry);
		return { code, expiresAt };
	}

	async consume(rawCode: string, clientKey: string): Promise<ConsumeResult> {
		const now = Date.now();
		const failKey = `fail:${clientKey}`;
		const failures = await this.ctx.storage.get<FailureEntry>(failKey);
		const windowOpen = failures !== undefined && now - failures.since < FAILURE_WINDOW_MS;
		if (windowOpen && failures.count >= MAX_FAILURES) return { error: 'rate_limited' };

		const code = rawCode.replace(/\D/g, '');
		const key = `code:${code}`;
		const entry = code.length === 6 ? await this.ctx.storage.get<PairingEntry>(key) : undefined;
		if (!entry || entry.expiresAt < now) {
			const next: FailureEntry = windowOpen
				? { count: failures.count + 1, since: failures.since }
				: { count: 1, since: now };
			await this.ctx.storage.put(failKey, next);
			return { error: 'invalid' };
		}
		await this.ctx.storage.delete(key);
		return { deviceId: entry.deviceId };
	}
}
