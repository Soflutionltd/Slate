// Scénarios d'édition rejoués dans la page, sur le chemin natif (PDFium via
// le pont). Chaque scénario renvoie { ok, checks, measures } ; un check en
// échec porte la valeur mesurée pour diagnostiquer sans rejouer.
(() => {
	const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const errors = [];
	window.addEventListener('error', (event) => errors.push(String(event.message)));
	window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)));

	const pointer = (x, y, buttons = 1) => ({
		bubbles: true,
		cancelable: true,
		clientX: x,
		clientY: y,
		button: 0,
		buttons,
		pointerId: 1,
		pointerType: 'mouse',
		isPrimary: true
	});

	async function until(predicate, timeout = 8000) {
		const start = performance.now();
		while (performance.now() - start < timeout) {
			const value = predicate();
			if (value) return value;
			await wait(50);
		}
		throw new Error(`timeout: ${predicate}`);
	}

	const button = (id) => document.getElementById(id);

	const block = (label) =>
		[...document.querySelectorAll('.edit-block')].find((element) =>
			(element.getAttribute('aria-label') || '').startsWith(label)
		);

	function pageBox(element) {
		return element.closest('.page-wrapper').querySelector('canvas').getBoundingClientRect();
	}

	// Position du texte lui-même : la boîte change de padding selon l'état
	// (repos, sélection, édition) sans que le texte bouge.
	function relative(element) {
		const page = pageBox(element);
		const range = document.createRange();
		range.selectNodeContents(element);
		const text = range.getBoundingClientRect();
		const box = text.width > 0 ? text : element.getBoundingClientRect();
		return {
			x: (box.x - page.x) / page.width,
			y: (box.y - page.y) / page.height,
			width: box.width / page.width,
			height: box.height / page.height
		};
	}

	function textWidth(element) {
		const range = document.createRange();
		range.selectNodeContents(element);
		return range.getBoundingClientRect().width;
	}

	function frameRatio(element) {
		const style = getComputedStyle(element);
		const inner =
			element.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
		return inner / Math.max(1, textWidth(element));
	}

	const blockText = (element) => element?.getAttribute('aria-label') ?? '';

	async function click(element) {
		const box = element.getBoundingClientRect();
		const x = box.x + Math.min(10, box.width / 2);
		const y = box.y + box.height / 2;
		element.dispatchEvent(new PointerEvent('pointerdown', pointer(x, y)));
		window.dispatchEvent(new PointerEvent('pointerup', pointer(x, y, 0)));
		await wait(120);
	}

	async function drag(element, dx, dy) {
		const box = element.getBoundingClientRect();
		const x = box.x + Math.min(10, box.width / 2);
		const y = box.y + box.height / 2;
		element.dispatchEvent(new PointerEvent('pointerdown', pointer(x, y)));
		for (let step = 1; step <= 12; step += 1) {
			window.dispatchEvent(new PointerEvent('pointermove', pointer(x + (dx * step) / 12, y + (dy * step) / 12)));
			await wait(16);
		}
		window.dispatchEvent(new PointerEvent('pointerup', pointer(x + dx, y + dy, 0)));
		await wait(600);
	}

	async function openFixture(name) {
		const bytes = await (await fetch(`/fixtures/${name}`)).arrayBuffer();
		const transfer = new DataTransfer();
		transfer.items.add(new File([bytes], name, { type: 'application/pdf' }));
		const input = document.getElementById('file-input');
		input.files = transfer.files;
		input.dispatchEvent(new Event('change', { bubbles: true }));
		await until(() => document.querySelector('.page-wrapper canvas'));
		await wait(1500);
	}

	async function enterEdit(label) {
		button('modify-tab').click();
		return until(() => block(label));
	}

	const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance;

	function letterSpacing(element) {
		const style = getComputedStyle(element);
		return (parseFloat(style.letterSpacing) || 0) / parseFloat(style.fontSize);
	}

	async function doubleClick(label) {
		await click(block(label));
		await click(block(label));
		await wait(800);
		return document.querySelector('.edit-block.editing') || block(label);
	}

	async function typeAtEnd(element, key) {
		const caret = document.createRange();
		caret.selectNodeContents(element);
		caret.collapse(false);
		getSelection().removeAllRanges();
		getSelection().addRange(caret);
		element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
		await wait(2000);
		const current = document.querySelector('.edit-block.editing') || element;
		return {
			text: current.textContent,
			spacing: letterSpacing(current),
			frameRatio: frameRatio(current)
		};
	}

	async function backspaceAt(element, offset) {
		const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
		let remaining = offset;
		let node = walker.nextNode();
		while (node && remaining > node.textContent.length) {
			remaining -= node.textContent.length;
			node = walker.nextNode();
		}
		const caret = document.createRange();
		caret.setStart(node, remaining);
		caret.collapse(true);
		getSelection().removeAllRanges();
		getSelection().addRange(caret);
		element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
		await wait(1200);
		return document.querySelector('.edit-block.editing') || element;
	}

	const scenarios = {
		// Bloc natif déplacé puis zoomé, annulé, rétabli, puis double-cliqué :
		// position relative stable, cadre serré sur le texte, pas d'écartement.
		async moveZoomUndoEdit({ label = 'AG TEST', fixture = 'wire.pdf' } = {}) {
			await openFixture(fixture);
			await enterEdit(label);
			await click(block(label));
			const original = relative(block(label));
			await drag(block(label), 150, -60);
			const moved = relative(block(label));
			button('zoom-in').click();
			await wait(2500);
			const zoomed = relative(block(label));
			const element = block(label);
			const zoomedFrame = frameRatio(element);
			button('undo-button').click();
			await wait(1500);
			const undone = relative(block(label));
			button('redo-button').click();
			await wait(1500);
			const redone = relative(block(label));
			const editing = await doubleClick(label);
			const spacingRatio = letterSpacing(editing);
			const calls = window.__harnessNativeCalls;
			const typed = await typeAtEnd(editing, 'Z');
			const checks = {
				nativePath: (calls.analyze_pdf_page_cached || 0) > 0 && (calls.render_view_page || 0) > 0,
				typedLands: typed.text.includes('Z'),
				typedNoLetterGaps: Math.abs(typed.spacing) < 0.05,
				typedFrameHugsText: typed.frameRatio < 1.15,
				zoomKeepsPosition: near(zoomed.x, moved.x, 0.004) && near(zoomed.y, moved.y, 0.004),
				zoomKeepsSize: near(zoomed.height, moved.height, 0.004),
				frameHugsText: zoomedFrame < 1.15,
				undoRestores: near(undone.x, original.x, 0.004) && near(undone.y, original.y, 0.004),
				redoReapplies: near(redone.x, moved.x, 0.004) && near(redone.y, moved.y, 0.004),
				noLetterGaps: Math.abs(spacingRatio) < 0.05,
				noErrors: errors.length === 0
			};
			return {
				ok: Object.values(checks).every(Boolean),
				checks,
				measures: {
					original,
					moved,
					zoomed,
					undone,
					redone,
					zoomedFrame,
					spacingRatio,
					typed,
					nativeCalls: { ...calls },
					errors: [...errors]
				},
				unknownCommands: [...(window.__harnessUnknownCommands || [])]
			};
		},

		// Frappe sur un bloc vierge (édition native PDFium), zoom, annuler.
		async nativeTypeZoomUndo({ label = 'TESTFRPP', fixture = 'wire.pdf' } = {}) {
			await openFixture(fixture);
			await enterEdit(label);
			const calls = window.__harnessNativeCalls;
			const original = relative(block(label));
			const editing = await doubleClick(label);
			const spacingRatio = letterSpacing(editing);
			const editsBefore = calls.edit_pdf_text_cached || 0;
			const typed = await typeAtEnd(editing, 'Z');
			const nativeEdits = (calls.edit_pdf_text_cached || 0) - editsBefore;
			editing.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
			await wait(800);
			const edited = relative(block(label));
			button('zoom-in').click();
			await wait(2500);
			const zoomed = relative(block(label));
			const zoomedText = blockText(block(label));
			button('undo-button').click();
			await wait(2000);
			const undoneText = blockText(block(label));
			const undone = relative(block(label));
			const checks = {
				noLetterGapsOnOpen: Math.abs(spacingRatio) < 0.05,
				nativeEdit: nativeEdits > 0 && typed.text.includes('Z'),
				typedNoLetterGaps: Math.abs(typed.spacing) < 0.05,
				typedFrameHugsText: typed.frameRatio < 1.15,
				editKeepsPosition: near(edited.x, original.x, 0.004) && near(edited.y, original.y, 0.004),
				zoomKeepsPosition: near(zoomed.x, edited.x, 0.004) && near(zoomed.y, edited.y, 0.004),
				zoomKeepsText: zoomedText.includes('Z'),
				undoRestoresText: undoneText === label,
				undoKeepsPosition: near(undone.x, original.x, 0.004) && near(undone.y, original.y, 0.004),
				noErrors: errors.length === 0
			};
			return {
				ok: Object.values(checks).every(Boolean),
				checks,
				measures: { original, edited, zoomed, undone, spacingRatio, typed, nativeEdits, undoneText, nativeCalls: { ...calls }, errors: [...errors] },
				unknownCommands: [...(window.__harnessUnknownCommands || [])]
			};
		}
	};

	const QUOTE = [
		'#set page(paper: "a4", margin: 2cm)',
		'#set text(size: 11pt, lang: "fr")',
		'= Devis 2026-014',
		'Client : SASU Exemple',
		'',
		'#table(columns: (1fr, auto, auto), align: (left, right, right), stroke: 0.5pt + gray, inset: 6pt,',
		'  table.header([*Prestation*], [*Qté*], [*Prix HT*]),',
		'  [Site vitrine], [1], [2 400 €], [Maintenance mensuelle], [12], [90 €])',
		'',
		'Total HT : 3 480 €'
	].join('\n');

	// Document créé par l'outil IA (même canal que le MCP local), puis modifié
	// par l'IA (edit_text_block) et à la main (frappe native PDFium).
	scenarios.createThenEdit = async () => {
		const call = window.__harnessCallTool;
		await until(() => document.querySelector('#modify-tab'));
		await wait(1500);
		// Source unique par passage : Slate restaure les modifications non
		// enregistrées d'un document identique déjà ouvert.
		const source = `${QUOTE}\n// passage ${Date.now()}`;
		const created = await call('create_document', { source, name: 'Devis test' });
		await wait(1500);
		const layout = await call('get_page_layout', { page: 1 });
		const total = layout.blocks.find((candidate) => (candidate.text || '').startsWith('Total HT'));
		const edited = total ? await call('edit_text_block', { block_id: total.id, text: 'Total HT : 3 600 €' }) : null;
		await wait(1500);
		const afterAi = await call('read_text', { page: 1 });
		const pageText = JSON.stringify(afterAi);
		if (!button('modify-tab').classList.contains('active')) button('modify-tab').click();
		const label = 'Maintenance';
		await until(() => block(label));
		const calls = window.__harnessNativeCalls;
		const editsBefore = calls.edit_pdf_text_cached || 0;
		const editing = await doubleClick(label);
		const spacingRatio = letterSpacing(editing);
		const typed = await typeAtEnd(editing, 'Z');
		const checks = {
			created: created.name === 'Devis test.pdf' && created.pages === 1 && created.unsaved_changes === true,
			noWarnings: Array.isArray(created.warnings) && created.warnings.length === 0,
			layoutFindsGeneratedText: Boolean(total) && layout.blocks.some((candidate) => (candidate.text || '').includes('Site vitrine')),
			aiEditApplied: Boolean(edited) && pageText.includes('3 600') && !pageText.includes('3 480'),
			nativeEditOnGenerated: (calls.edit_pdf_text_cached || 0) > editsBefore && typed.text.includes('Z'),
			noLetterGaps: Math.abs(spacingRatio) < 0.05 && Math.abs(typed.spacing) < 0.05,
			frameHugsText: typed.frameRatio < 1.15,
			noErrors: errors.length === 0
		};
		return {
			ok: Object.values(checks).every(Boolean),
			checks,
			measures: {
				created,
				blocks: layout.blocks.map((candidate) => candidate.text),
				edited,
				spacingRatio,
				typed,
				nativeCalls: { ...calls },
				errors: [...errors]
			},
			unknownCommands: [...(window.__harnessUnknownCommands || [])]
		};
	};

	// Une ligne en deux objets texte, éditée dans les deux, puis annulée : le
	// rejeu depuis la page d'origine touche les deux objets à la fois.
	scenarios.undoAcrossTextObjects = async () => {
		const statuses = [];
		const warnings = [];
		const warn = console.warn;
		console.warn = (...args) => {
			warnings.push(args.map(String).join(' '));
			warn(...args);
		};
		const observer = new MutationObserver(() => statuses.push(document.getElementById('status').textContent));
		observer.observe(document.getElementById('status'), { childList: true, characterData: true, subtree: true });
		await openFixture('grid.pdf');
		const label = 'Facture';
		await enterEdit(label);
		let editing = await doubleClick(label);
		const original = editing.textContent;
		const at = (needle, shift) => editing.textContent.indexOf(needle) + shift;
		for (let k = 0; k < 3; k += 1) editing = await backspaceAt(editing, at('3542541'.slice(0, 7 - k), 7 - k));
		for (let k = 0; k < 2; k += 1) editing = await backspaceAt(editing, at(k ? '10Q65' : '100Q65', k ? 2 : 3));
		editing = await backspaceAt(editing, at('3542 ', 4));
		const typed = editing.textContent;
		editing.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		await wait(800);
		button('undo-button').click();
		await wait(3000);
		const afterOneUndo = blockText(block(label));
		for (let k = 0; k < 5; k += 1) {
			button('undo-button').click();
			await wait(2500);
		}
		const afterAllUndo = blockText(block(label));
		observer.disconnect();
		console.warn = warn;
		const refused = [
			...statuses.filter((text) => /refus|reject/i.test(text)),
			...warnings.filter((text) => /native|natif|natives?/i.test(text))
		];
		const checks = {
			typedBothObjects: typed === original.replace('3542541', '354').replace('100Q65', '1Q65'),
			oneUndoReplaysBothObjects: afterOneUndo === original.replace('3542541', '3542').replace('100Q65', '1Q65'),
			allUndoRestoresOriginal: afterAllUndo === original,
			noRefusal: refused.length === 0,
			noErrors: errors.length === 0
		};
		return {
			ok: Object.values(checks).every(Boolean),
			checks,
			measures: { original, typed, afterOneUndo, afterAllUndo, refused, nativeCalls: { ...window.__harnessNativeCalls }, errors: [...errors] },
			unknownCommands: [...(window.__harnessUnknownCommands || [])]
		};
	};

	window.__harness = { scenarios, openFixture, block, button, relative, wait };
})();
