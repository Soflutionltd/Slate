/**
 * Pont PDF pour le navigateur : même API que les commandes Tauri, branchée sur
 * slate-pdf-wasm + PDFium WASM. Chargé uniquement en build web (pas sur desktop).
 */
(function initSlatePdfBridge(global) {
	const DOC_CACHE = new Map();
	let wasmApi = null;
	let initPromise = null;

	const WASM_BASE = global.SLATE_WASM_BASE || '/wasm';
	const PDFIUM_BASE = global.SLATE_PDFIUM_BASE || '/wasm/pdfium';

	function toUint8Array(value) {
		if (!value) return new Uint8Array(0);
		if (value instanceof Uint8Array) return value;
		if (value instanceof ArrayBuffer) return new Uint8Array(value);
		if (ArrayBuffer.isView(value)) {
			return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
		}
		if (Array.isArray(value)) return new Uint8Array(value);
		return new Uint8Array(0);
	}

	function toSources(sources) {
		return (sources || []).map((entry) => toUint8Array(entry));
	}

	function normalizePages(pages) {
		return (pages || []).map((page) => ({
			jpegBytes: Array.from(toUint8Array(page.jpegBytes || page.jpeg_bytes)),
			width: page.width,
			height: page.height
		}));
	}

	async function loadScript(src) {
		return new Promise((resolve, reject) => {
			const script = document.createElement('script');
			script.src = src;
			script.async = true;
			script.onload = () => resolve();
			script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
			document.head.append(script);
		});
	}

	async function ensureWasm() {
		if (wasmApi) return wasmApi;
		if (initPromise) return initPromise;

		initPromise = (async () => {
			await loadScript(`${PDFIUM_BASE}/pdfium.js`);
			const pdfiumModule = global.Module;
			if (!pdfiumModule) {
				throw new Error('PDFium WASM module failed to initialize.');
			}
			await new Promise((resolve) => {
				if (pdfiumModule.calledRun) {
					resolve();
					return;
				}
				const previous = pdfiumModule.onRuntimeInitialized;
				pdfiumModule.onRuntimeInitialized = () => {
					if (typeof previous === 'function') previous();
					resolve();
				};
			});

			const init = (await import(`${WASM_BASE}/slate_pdf_wasm.js`)).default;
			const slateModule = await init(`${WASM_BASE}/slate_pdf_wasm_bg.wasm`);
			if (typeof slateModule.initialize_pdfium_render === 'function') {
				slateModule.initialize_pdfium_render(pdfiumModule, slateModule);
			}

			wasmApi = slateModule;
			return wasmApi;
		})();

		return initPromise;
	}

	async function listBrowserFonts() {
		try {
			await document.fonts.ready;
			const families = new Set();
			for (const face of document.fonts) {
				if (face.family) families.add(face.family.replace(/^["']|["']$/g, ''));
			}
			return [...families].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
		} catch {
			return ['Arial', 'Helvetica', 'Times New Roman', 'Courier New'];
		}
	}

	function pickFiles(accept, multiple = false) {
		return new Promise((resolve) => {
			const input = document.createElement('input');
			input.type = 'file';
			input.accept = accept;
			input.multiple = multiple;
			input.style.display = 'none';
			document.body.append(input);
			input.addEventListener('change', () => {
				const files = input.files ? [...input.files] : [];
				input.remove();
				resolve(files);
			});
			input.addEventListener('cancel', () => {
				input.remove();
				resolve([]);
			});
			input.click();
		});
	}

	async function fileToResult(file) {
		const bytes = new Uint8Array(await file.arrayBuffer());
		return {
			path: file.name,
			file_name: file.name,
			fileName: file.name,
			bytes: Array.from(bytes)
		};
	}

	const BLANK_PDF = new Uint8Array([
		0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a, 0x31,
		0x20, 0x30, 0x20, 0x6f, 0x62, 0x6a, 0x3c, 0x3c, 0x2f, 0x54, 0x79, 0x70, 0x65, 0x2f, 0x43, 0x61,
		0x74, 0x61, 0x6c, 0x6f, 0x67, 0x2f, 0x50, 0x61, 0x67, 0x65, 0x73, 0x20, 0x32, 0x20, 0x30, 0x20,
		0x52, 0x3e, 0x3e, 0x65, 0x6e, 0x64, 0x6f, 0x62, 0x6a, 0x0a, 0x32, 0x20, 0x30, 0x20, 0x6f, 0x62,
		0x6a, 0x3c, 0x3c, 0x2f, 0x54, 0x79, 0x70, 0x65, 0x2f, 0x50, 0x61, 0x67, 0x65, 0x73, 0x2f, 0x4b,
		0x69, 0x64, 0x73, 0x5b, 0x33, 0x20, 0x30, 0x20, 0x52, 0x5d, 0x2f, 0x43, 0x6f, 0x75, 0x6e, 0x74,
		0x20, 0x31, 0x3e, 0x3e, 0x65, 0x6e, 0x64, 0x6f, 0x62, 0x6a, 0x0a, 0x33, 0x20, 0x30, 0x20, 0x6f,
		0x62, 0x6a, 0x3c, 0x3c, 0x2f, 0x54, 0x79, 0x70, 0x65, 0x2f, 0x50, 0x61, 0x67, 0x65, 0x2f, 0x4d,
		0x65, 0x64, 0x69, 0x61, 0x42, 0x6f, 0x78, 0x5b, 0x30, 0x20, 0x30, 0x20, 0x36, 0x31, 0x32, 0x20,
		0x37, 0x39, 0x32, 0x5d, 0x2f, 0x50, 0x61, 0x72, 0x65, 0x6e, 0x74, 0x20, 0x32, 0x20, 0x30, 0x20,
		0x52, 0x3e, 0x3e, 0x65, 0x6e, 0x64, 0x6f, 0x62, 0x6a, 0x0a, 0x78, 0x72, 0x65, 0x66, 0x0a, 0x30,
		0x20, 0x34, 0x0a, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x20, 0x36, 0x35,
		0x35, 0x33, 0x35, 0x20, 0x66, 0x20, 0x0a, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30,
		0x39, 0x20, 0x30, 0x30, 0x30, 0x30, 0x30, 0x20, 0x6e, 0x20, 0x0a, 0x30, 0x30, 0x30, 0x30, 0x30,
		0x30, 0x30, 0x30, 0x35, 0x38, 0x20, 0x30, 0x30, 0x30, 0x30, 0x30, 0x20, 0x6e, 0x20, 0x0a, 0x30,
		0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x31, 0x31, 0x35, 0x20, 0x30, 0x30, 0x30, 0x30, 0x30,
		0x20, 0x6e, 0x20, 0x0a, 0x74, 0x72, 0x61, 0x69, 0x6c, 0x65, 0x72, 0x3c, 0x3c, 0x2f, 0x53, 0x69,
		0x7a, 0x65, 0x20, 0x34, 0x2f, 0x52, 0x6f, 0x6f, 0x74, 0x20, 0x31, 0x20, 0x30, 0x20, 0x52, 0x3e,
		0x3e, 0x0a, 0x73, 0x74, 0x61, 0x72, 0x74, 0x78, 0x72, 0x65, 0x66, 0x0a, 0x31, 0x39, 0x30, 0x0a,
		0x25, 0x25, 0x45, 0x4f, 0x46, 0x0a
	]);

	async function downloadBlob(blob, filename) {
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement('a');
		anchor.href = url;
		anchor.download = filename;
		anchor.click();
		URL.revokeObjectURL(url);
		return filename;
	}

	const DESKTOP_ONLY = new Set([
		'ocr_page',
		'ocr_pdf_page',
		'ocr_searchable_pdf',
		'deskew_pdf',
		'sign_pdf_pades',
		'pick_certificate_file',
		'extract_images_to_folder',
		'print_pdf',
		'list_printers',
		'list_paper_sizes',
		'list_printer_options',
		'fit_label_to_media',
		'print_pdf_with_options',
		'set_default_pdf_handler',
		'is_default_pdf_handler',
		'read_pdf_path',
		'connect_claude_desktop',
		'mcp_binary_path',
		'llm_get_config',
		'llm_set_config',
		'llm_chat',
		'check_for_update',
		'install_update',
		'alto_debug'
	]);

	const handlers = {
		async cache_document({ id, bytes }) {
			DOC_CACHE.set(id, toUint8Array(bytes));
		},
		async analyze_pdf_page_cached({ id, page }) {
			const api = await ensureWasm();
			const bytes = DOC_CACHE.get(id);
			if (!bytes) throw new Error('cache_miss');
			return JSON.parse(api.analyze_pdf_page(bytes, page));
		},
		async analyze_pdf_page({ bytes, page }) {
			const api = await ensureWasm();
			return JSON.parse(api.analyze_pdf_page(toUint8Array(bytes), page));
		},
		async export_edited_pdf({ pages }) {
			const api = await ensureWasm();
			return api.export_edited_pdf(JSON.stringify(normalizePages(pages)));
		},
		async merge_pdfs({ sources }) {
			const api = await ensureWasm();
			return api.merge_pdfs(toSources(sources));
		},
		async encrypt_pdf({ bytes, userPassword, ownerPassword }) {
			const api = await ensureWasm();
			return api.encrypt_pdf(toUint8Array(bytes), userPassword, ownerPassword ?? null);
		},
		async compress_pdf({ bytes, level }) {
			const api = await ensureWasm();
			return api.compress_pdf(toUint8Array(bytes), level ?? null);
		},
		async repair_pdf({ bytes }) {
			const api = await ensureWasm();
			return api.repair_pdf(toUint8Array(bytes));
		},
		async remove_annotations({ bytes }) {
			const api = await ensureWasm();
			return api.remove_annotations(toUint8Array(bytes));
		},
		async remove_blank_pages({ bytes }) {
			const api = await ensureWasm();
			return JSON.parse(api.remove_blank_pages(toUint8Array(bytes)));
		},
		async watermark_pdf({ bytes, text, fontSize, opacity, rotation, color, bold }) {
			const api = await ensureWasm();
			return api.watermark_pdf(
				toUint8Array(bytes),
				text,
				fontSize,
				opacity,
				rotation,
				color ? Array.from(color) : null,
				Boolean(bold)
			);
		},
		async add_page_numbers({ bytes, position, startAt, fontSize, margin }) {
			const api = await ensureWasm();
			return api.add_page_numbers(toUint8Array(bytes), position, startAt, fontSize, margin);
		},
		async images_to_pdf({ images }) {
			const api = await ensureWasm();
			return api.images_to_pdf(toSources(images));
		},
		async crop_pdf({ bytes, left, top, right, bottom }) {
			const api = await ensureWasm();
			return api.crop_pdf(toUint8Array(bytes), left, top, right, bottom);
		},
		async flatten_pdf({ bytes }) {
			const api = await ensureWasm();
			return api.flatten_pdf(toUint8Array(bytes));
		},
		async sanitize_pdf({ bytes }) {
			const api = await ensureWasm();
			return api.sanitize_pdf(toUint8Array(bytes));
		},
		async auto_redact({ bytes, terms, matchCase }) {
			const api = await ensureWasm();
			return JSON.parse(api.auto_redact(toUint8Array(bytes), terms, Boolean(matchCase)));
		},
		async remove_password({ bytes, password }) {
			const api = await ensureWasm();
			return api.remove_password(toUint8Array(bytes), password);
		},
		async get_bookmarks({ bytes }) {
			const api = await ensureWasm();
			return JSON.parse(api.get_bookmarks(toUint8Array(bytes)));
		},
		async set_bookmarks({ bytes, items }) {
			const api = await ensureWasm();
			return api.set_bookmarks(toUint8Array(bytes), JSON.stringify(items || []));
		},
		async rotate_pages({ bytes, pageNumbers, angle }) {
			const api = await ensureWasm();
			return api.rotate_pages(toUint8Array(bytes), pageNumbers, angle);
		},
		async delete_pages({ bytes, pageNumbers }) {
			const api = await ensureWasm();
			return api.delete_pages(toUint8Array(bytes), pageNumbers);
		},
		async extract_pages({ bytes, pageNumbers }) {
			const api = await ensureWasm();
			return api.extract_pages(toUint8Array(bytes), pageNumbers);
		},
		async reorder_pages({ bytes, newOrder }) {
			const api = await ensureWasm();
			return api.reorder_pages(toUint8Array(bytes), newOrder);
		},
		async document_properties({ bytes }) {
			const api = await ensureWasm();
			return JSON.parse(api.document_properties(toUint8Array(bytes)));
		},
		async set_pdf_metadata({ bytes, title, author, subject, keywords }) {
			const api = await ensureWasm();
			if (typeof api.set_pdf_metadata !== 'function') {
				throw new Error('set_pdf_metadata indisponible dans ce build WASM.');
			}
			return api.set_pdf_metadata(
				toUint8Array(bytes),
				title ?? null,
				author ?? null,
				subject ?? null,
				keywords ?? null
			);
		},
		async list_form_fields({ bytes }) {
			const api = await ensureWasm();
			return JSON.parse(api.list_form_fields(toUint8Array(bytes)));
		},
		async fill_form_fields({ bytes, values }) {
			const api = await ensureWasm();
			return api.fill_form_fields(toUint8Array(bytes), JSON.stringify(values || {}));
		},
		async list_system_fonts() {
			return listBrowserFonts();
		},
		async open_file() {
			const files = await pickFiles('application/pdf,.pdf', false);
			if (!files.length) return null;
			return fileToResult(files[0]);
		},
		async pick_multiple_pdfs() {
			const files = await pickFiles('application/pdf,.pdf', true);
			if (!files.length) return [];
			return Promise.all(files.map((file) => fileToResult(file)));
		},
		async pick_images() {
			const files = await pickFiles('image/png,image/jpeg,image/jpg', true);
			if (!files.length) return [];
			const out = [];
			for (const file of files) {
				out.push(Array.from(new Uint8Array(await file.arrayBuffer())));
			}
			return out;
		},
		async save_file_dialog({ filename, extension, data }) {
			const ext = String(extension || 'pdf').replace(/^\./, '');
			const base = String(filename || 'document').replace(/\.[^.]+$/, '');
			const fullName = `${base}.${ext}`;
			const mime =
				ext === 'pdf'
					? 'application/pdf'
					: ext === 'json'
						? 'application/json'
						: 'application/octet-stream';
			const blob = new Blob([toUint8Array(data)], { type: mime });
			if (typeof global.showSaveFilePicker === 'function') {
				try {
					const handle = await global.showSaveFilePicker({
						suggestedName: fullName,
						types: [
							{
								description: ext.toUpperCase(),
								accept: { [mime]: [`.${ext}`] }
							}
						]
					});
					const writable = await handle.createWritable();
					await writable.write(blob);
					await writable.close();
					return handle.name;
				} catch (error) {
					if (error?.name === 'AbortError') return null;
				}
			}
			return downloadBlob(blob, fullName);
		},
		async create_blank_pdf() {
			return BLANK_PDF;
		},
		async take_pending_open_files() {
			return [];
		},
		async take_pending_print_files() {
			return [];
		},
		async open_external({ url }) {
			if (url) global.open(url, '_blank', 'noopener,noreferrer');
		},
		async is_default_pdf_handler() {
			return false;
		}
	};

	global.slatePdfBridge = {
		ready: ensureWasm,
		async invoke(command, args = {}) {
			if (DESKTOP_ONLY.has(command)) {
				throw new Error(`${command} n'est pas disponible dans le navigateur.`);
			}
			const handler = handlers[command];
			if (!handler) {
				throw new Error(`Commande PDF inconnue en mode web : ${command}`);
			}
			return handler(args);
		}
	};
})(window);
