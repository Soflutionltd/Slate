import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import type { DeviceHub } from './device-hub';
import type { PairingRegistry } from './pairing';

export interface Env {
	OAUTH_KV: KVNamespace;
	DEVICE_HUB: DurableObjectNamespace<DeviceHub>;
	PAIRING: DurableObjectNamespace<PairingRegistry>;
	/** Injecté par OAuthProvider dans le defaultHandler. */
	OAUTH_PROVIDER: OAuthHelpers;
}

/** Données attachées à chaque autorisation OAuth (ctx.props côté /mcp). */
export interface GrantProps {
	deviceId: string;
	clientName: string;
}
