// Catalogue des outils de Slate : une seule source (src-tauri/frontend-dist/ai-tools.json).
// Chaque Slate envoie le sien à la connexion, le relais sert donc aux IA les
// outils de la version installée ; celui embarqué ici ne sert qu'en secours.
import bundled from '../../src-tauri/frontend-dist/ai-tools.json';

export interface CatalogTool {
	name: string;
	title: string;
	description: string;
	risk: 'read' | 'edit' | 'destructive';
	confirm?: boolean;
	idempotent?: boolean;
	input_schema: Record<string, unknown>;
}

export interface ToolCatalog {
	version: number;
	instructions: string;
	tools: CatalogTool[];
}

const MAX_CATALOG_BYTES = 128 * 1024;
const MAX_TOOLS = 200;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const RISKS = new Set(['read', 'edit', 'destructive']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const isText = (value: unknown, max: number): value is string =>
	typeof value === 'string' && value.length > 0 && value.length <= max;

function parseTool(value: unknown): CatalogTool | null {
	if (!isRecord(value)) return null;
	const { name, title, description, risk, confirm, idempotent, input_schema: inputSchema } = value;
	if (typeof name !== 'string' || !TOOL_NAME.test(name)) return null;
	if (!isText(title, 120) || !isText(description, 4000) || typeof risk !== 'string' || !RISKS.has(risk)) return null;
	if (!isRecord(inputSchema) || inputSchema.type !== 'object') return null;
	return {
		name,
		title,
		description,
		risk: risk as CatalogTool['risk'],
		...(confirm === true ? { confirm: true } : {}),
		...(idempotent === true ? { idempotent: true } : {}),
		input_schema: inputSchema
	};
}

/** Catalogue validé, ou null s'il est malformé ou trop gros. */
export function parseCatalog(value: unknown): ToolCatalog | null {
	if (!isRecord(value) || typeof value.version !== 'number' || !isText(value.instructions, 8000)) return null;
	if (!Array.isArray(value.tools) || value.tools.length === 0 || value.tools.length > MAX_TOOLS) return null;
	if (JSON.stringify(value).length > MAX_CATALOG_BYTES) return null;
	const tools: CatalogTool[] = [];
	const names = new Set<string>();
	for (const entry of value.tools) {
		const tool = parseTool(entry);
		if (!tool || names.has(tool.name)) return null;
		names.add(tool.name);
		tools.push(tool);
	}
	return { version: value.version, instructions: value.instructions, tools };
}

const bundledCatalog = parseCatalog(bundled);
if (!bundledCatalog) throw new Error('ai-tools.json embarqué invalide');

export const BUNDLED_CATALOG: ToolCatalog = bundledCatalog;
