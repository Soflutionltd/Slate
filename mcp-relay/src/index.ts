import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { handleAuthorize } from './authorize';
import { BUNDLED_CATALOG } from './catalog';
import { handleDeviceApi } from './device-api';
import type { Env, GrantProps } from './env';
import { buildServer } from './mcp';

export { DeviceHub } from './device-hub';
export { PairingRegistry } from './pairing';

const mcpApiHandler = {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const props = ctx.props as GrantProps | undefined;
		if (!props?.deviceId) return new Response('Unauthorized', { status: 401 });
		const hub = env.DEVICE_HUB.get(env.DEVICE_HUB.idFromName(props.deviceId));
		const catalog = (await hub.catalog()) ?? BUNDLED_CATALOG;
		return createMcpHandler(() => buildServer(env, props, catalog)).fetch(request);
	}
};

const defaultHandler = {
	async fetch(request: Request, env: Env): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (pathname === '/authorize') return handleAuthorize(request, env);
		if (pathname.startsWith('/device/')) return handleDeviceApi(request, env);
		if (pathname === '/') {
			return new Response('Slate MCP relay. Add this URL to your AI: /mcp', {
				headers: { 'Content-Type': 'text/plain; charset=utf-8' }
			});
		}
		return new Response('Not Found', { status: 404 });
	}
};

const providers = new Map<string, OAuthProvider<Env>>();

// Les métadonnées OAuth doivent annoncer l'origine réelle (domaine de prod ou wrangler dev).
function providerFor(origin: string): OAuthProvider<Env> {
	let provider = providers.get(origin);
	if (!provider) {
		provider = new OAuthProvider<Env>({
			apiRoute: '/mcp',
			apiHandler: mcpApiHandler,
			defaultHandler,
			authorizeEndpoint: '/authorize',
			tokenEndpoint: '/oauth/token',
			clientRegistrationEndpoint: '/oauth/register',
			clientIdMetadataDocumentEnabled: true,
			accessTokenTTL: 3600,
			refreshTokenTTL: 180 * 24 * 3600,
			resourceMetadata: {
				resource: `${origin}/mcp`,
				authorization_servers: [origin],
				resource_name: 'Slate'
			}
		});
		providers.set(origin, provider);
	}
	return provider;
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		return providerFor(new URL(request.url).origin).fetch(request, env, ctx);
	}
};
