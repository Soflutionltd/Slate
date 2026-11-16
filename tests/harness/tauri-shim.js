// Remplace `window.__TAURI__` dans un navigateur : les commandes du moteur
// d'édition partent au pont Rust (examples/harness_bridge.rs, mêmes fonctions
// PDFium que l'app), le reste reçoit une réponse neutre. Les commandes non
// prévues sont listées dans `window.__harnessUnknownCommands` : une réponse
// neutre peut masquer un chemin non testé, la liste sert à le voir.
(() => {
	const BRIDGE = `http://127.0.0.1:${new URLSearchParams(location.search).get('bridge') || '18766'}`;
	const NATIVE = new Set([
		'stage_bytes',
		'repair_pdf_bytes',
		'generate_pdf',
		'take_staged_bytes',
		'cache_document',
		'cache_view_document',
		'drop_view_document',
		'render_view_page',
		'analyze_pdf_page_cached',
		'edit_pdf_text_cached',
		'restore_native_page',
		'render_pdf_page_cached',
		'render_pdf_thumbnail_cached',
		'get_cached_document',
		'extract_embedded_fonts_cached',
		'delete_pages',
		'delete_shapes'
	]);
	const NEUTRAL = {
		read_open_session: null,
		read_edit_history: null,
		take_pending_open_files: [],
		take_pending_print_files: [],
		take_detached_tab: null,
		list_system_fonts: [],
		is_default_pdf_handler: true,
		is_tab_drag_active: false,
		consume_update_relaunch: false,
		mcp_local_status: { enabled: false },
		acp_agents: [],
		llm_get_config: {},
		llm_detect_local: [],
		check_for_update: null,
		write_open_session: null,
		set_native_language: null,
		mcp_local_ready: null
	};
	const unknown = new Set();
	const nativeCalls = {};
	window.__harnessUnknownCommands = unknown;
	window.__harnessNativeCalls = nativeCalls;
	const debugLines = [];
	window.__harnessDebugLines = debugLines;

	// Appel d'outil IA par le même canal que le MCP local : événement
	// `mcp-local-call` vers la page, réponse par `mcp_local_reply`.
	const listeners = {};
	const replies = new Map();
	let nextCall = 1;
	window.__harnessCallTool = (tool, args = {}) =>
		new Promise((resolve, reject) => {
			const handlers = listeners['mcp-local-call'] || [];
			if (!handlers.length) return reject(new Error('mcp-local-call: no listener yet'));
			const id = `harness-${nextCall++}`;
			replies.set(id, (reply) => (reply.ok ? resolve(reply.result) : reject(new Error(reply.error))));
			for (const handler of handlers) handler({ payload: { id, tool, args, client: 'Harness' } });
		});

	async function invoke(command, args) {
		if (command === 'alto_debug') {
			debugLines.push(String(args?.line ?? ''));
			return null;
		}
		if (command === 'mcp_local_reply') {
			replies.get(args.id)?.(args.reply);
			replies.delete(args.id);
			return null;
		}
		if (NATIVE.has(command)) {
			nativeCalls[command] = (nativeCalls[command] || 0) + 1;
			const raw = args instanceof Uint8Array || args instanceof ArrayBuffer;
			const response = await fetch(`${BRIDGE}/${command}`, {
				method: 'POST',
				headers: { 'content-type': raw ? 'application/octet-stream' : 'application/json' },
				body: raw ? args : JSON.stringify(args ?? {})
			});
			if (!response.ok) throw await response.text();
			return (response.headers.get('content-type') || '').includes('octet-stream')
				? response.arrayBuffer()
				: response.json();
		}
		if (Object.hasOwn(NEUTRAL, command)) return structuredClone(NEUTRAL[command]);
		unknown.add(command);
		return null;
	}

	const handle = () =>
		new Proxy(
			{ label: 'main' },
			{
				get(target, key) {
					if (key in target) return target[key];
					if (key === 'then') return undefined;
					if (key === 'listen') {
						return (event, handler) => {
							(listeners[event] ||= []).push(handler);
							return Promise.resolve(() => {});
						};
					}
					return (...rest) =>
						Promise.resolve(/^(on|listen)/.test(String(key)) ? () => {} : null);
				}
			}
		);

	class Channel {
		onmessage = null;
	}

	window.__TAURI__ = {
		core: { invoke, Channel },
		event: { listen: async () => () => {}, once: async () => () => {}, emit: async () => {} },
		window: { getCurrentWindow: handle },
		webviewWindow: { getCurrentWebviewWindow: handle },
		app: { getVersion: async () => '0.0.0-harness' }
	};
})();
