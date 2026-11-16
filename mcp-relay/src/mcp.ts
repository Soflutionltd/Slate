import { McpServer, fromJsonSchema, type CallToolResult, type JsonSchemaType } from '@modelcontextprotocol/server';
import type { CatalogTool, ToolCatalog } from './catalog';
import type { CallOutcome } from './device-hub';
import type { Env, GrantProps } from './env';

const ERROR_MESSAGES: Record<string, string> = {
	slate_offline:
		'Slate is not reachable: the app is closed on the user\'s computer, or "Connect an AI" is turned off in Slate settings. Ask the user to open Slate and try again.',
	slate_disconnected: 'Slate disconnected while running the tool. Ask the user to check that Slate is open, then retry.',
	timeout: 'Slate did not answer within 2 minutes. The document may be very large, or the user has not answered a confirmation in Slate yet.'
};

const ANNOTATIONS: Record<CatalogTool['risk'], Record<string, boolean>> = {
	read: { readOnlyHint: true, openWorldHint: false },
	edit: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
	destructive: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
};

type ImageBlock = { type: 'image'; data: string; mimeType: string };

// Slate joint les images (rendu de page) sous _mcpContent : elles deviennent des
// blocs image MCP, le reste du résultat part en JSON texte.
function splitResult(result: unknown): { json: unknown; images: ImageBlock[] } {
	if (typeof result !== 'object' || result === null || !('_mcpContent' in result)) return { json: result, images: [] };
	const { _mcpContent: extra, ...json } = result as Record<string, unknown>;
	const images = (Array.isArray(extra) ? extra : []).filter(
		(block): block is ImageBlock =>
			block?.type === 'image' &&
			typeof block.data === 'string' &&
			typeof block.mimeType === 'string' &&
			block.mimeType.startsWith('image/')
	);
	return { json, images };
}

export function buildServer(env: Env, props: GrantProps, catalog: ToolCatalog): McpServer {
	const server = new McpServer(
		{ name: 'slate', title: 'Slate PDF', version: String(catalog.version) },
		{ instructions: catalog.instructions }
	);
	const hub = env.DEVICE_HUB.get(env.DEVICE_HUB.idFromName(props.deviceId));

	const forward = async (tool: string, args: unknown): Promise<CallToolResult> => {
		const outcome: CallOutcome = await hub.call(tool, args, props.clientName);
		if (!outcome.ok) {
			const error = outcome.error ?? 'slate_error';
			return { isError: true, content: [{ type: 'text', text: ERROR_MESSAGES[error] ?? error }] };
		}
		const { json, images } = splitResult(outcome.result);
		return {
			content: [
				{ type: 'text', text: JSON.stringify(json, null, 2) },
				...images.map((image) => ({ type: 'image' as const, data: image.data, mimeType: image.mimeType }))
			]
		};
	};

	for (const tool of catalog.tools) {
		server.registerTool(
			tool.name,
			{
				title: tool.title,
				description: tool.description,
				annotations: { ...ANNOTATIONS[tool.risk], ...(tool.idempotent ? { idempotentHint: true } : {}) },
				inputSchema: fromJsonSchema<Record<string, unknown>>(tool.input_schema as JsonSchemaType)
			},
			(args) => forward(tool.name, args)
		);
	}

	return server;
}
