import test from 'node:test';
import assert from 'node:assert/strict';

import {
	pdfCharLines,
	pdfLinesText,
	pdfTextOffsetFromPoint,
	selectionOffsetsFromGlyphDrag,
	wordBoundsAtTextOffset,
	isHorizontalWhitespace,
	lineIndexAtTextOffset,
	rescaleBlockToViewport
} from '../src-tauri/frontend-dist/block-state.js';
import {
	stripTransientBlockFields,
	nativeTouchedRecord,
	mergeNativeTouchedEntry
} from '../src-tauri/frontend-dist/native-history.js';

function lineChars(text, y, startIndex, insertedAt = -1, widths = null) {
	const chars = [];
	let x = 20;
	for (let offset = 0; offset < text.length; offset += 1) {
		const width = widths?.[offset] ?? 7;
		chars.push({
			index: chars.length,
			text: text[offset],
			x,
			y,
			width,
			height: 12,
			maskX: x,
			maskY: y,
			maskWidth: width,
			maskHeight: 12,
			pageCharIndex: offset === insertedAt ? 999 : startIndex + offset
		});
		x += width;
	}
	return chars;
}

test('un glyphe multiligne inséré reste sur sa ligne visuelle', () => {
	const expected = [
		'Chez LA VILLAA',
		'Chemin Notre Dame de la Serra',
		'20260 CALVI',
		'France'
	].join('\n');
	const pdfChars = [
		...lineChars('Chez LA VILLAA', 20, 100, 13),
		...lineChars('Chemin Notre Dame de la Serra', 36, 200),
		...lineChars('20260 CALVI', 52, 300),
		...lineChars('France', 68, 400)
	];
	const block = {
		text: expected,
		pdfChars,
		hiddenCharIndexes: []
	};

	const visualText = pdfLinesText(pdfCharLines(block));
	const globalIndexText = [...pdfChars]
		.sort((left, right) => left.pageCharIndex - right.pageCharIndex)
		.map((character) => character.text)
		.join('');

	assert.equal(visualText, expected);
	assert.notEqual(globalIndexText.replaceAll(/\s/g, ''), expected.replaceAll(/\s/g, ''));
});

test('un glisser sur nov. sélectionne nov. malgré un grand espace avant', () => {
	// Mimique « Transaction datée du 6 nov. 2025 » : le « 6 » est large (fallback),
	// puis un grand blanc, puis « nov. » — une sélection WebKit HTML viserait 2025.
	const text = 'Transaction datée du 6 nov. 2025';
	const widths = Array.from(text, (ch) => {
		if (ch === '6') return 14;
		if (ch === ' ') return 4;
		return 7;
	});
	// Agrandit l'espace entre « 6 » et « n » comme sur le relevé Revolut édité.
	const sixIndex = text.indexOf('6');
	widths[sixIndex + 1] = 28;
	const pdfChars = lineChars(text, 40, 10, -1, widths);
	const lines = pdfCharLines({ text, pdfChars, hiddenCharIndexes: [] });
	const novStart = text.indexOf('nov.');
	const nChar = pdfChars[novStart];
	const dotChar = pdfChars[novStart + 3];
	assert.equal(nChar?.text, 'n');
	assert.equal(dotChar?.text, '.');

	const range = selectionOffsetsFromGlyphDrag(
		lines,
		nChar.x + 1,
		nChar.y + 6,
		dotChar.x + dotChar.width - 1,
		dotChar.y + 6
	);
	assert.deepEqual(range, { start: novStart, end: novStart + 4 });
	assert.equal(text.slice(range.start, range.end), 'nov.');

	// Un clic au début de « n » ne doit pas tomber dans « 2025 ».
	const atN = pdfTextOffsetFromPoint(lines, nChar.x + 1, nChar.y + 6);
	assert.equal(atN, novStart);
	const word = wordBoundsAtTextOffset(text, atN);
	assert.equal(word.start, novStart);
	assert.equal(text.slice(word.start, word.end), 'nov');
});

test('soft-space horizontal : \\n n’est pas un blanc de run', () => {
	assert.equal(isHorizontalWhitespace(' '), true);
	assert.equal(isHorizontalWhitespace('\t'), true);
	assert.equal(isHorizontalWhitespace('\u00a0'), true);
	assert.equal(isHorizontalWhitespace('\n'), false);
	assert.equal(isHorizontalWhitespace('\r'), false);
	assert.equal(isHorizontalWhitespace('a'), false);
});

test('montants de facture empilés = 3 lignes visuelles distinctes', () => {
	// Mimique Air Corsica : 255.00 / 38.14 / 3.00 fusionnés en un bloc analyse.
	const pdfChars = [
		...lineChars('255.00', 420, 232),
		...lineChars('38.14', 442, 246),
		...lineChars('3.00', 464, 270)
	];
	const block = {
		text: '255.00\n38.14\n3.00',
		pdfChars,
		hiddenCharIndexes: []
	};
	const lines = pdfCharLines(block);
	assert.equal(lines.length, 3);
	assert.equal(pdfLinesText(lines), '255.00\n38.14\n3.00');
	assert.equal(lineIndexAtTextOffset(block.text, 0), 0);
	assert.equal(lineIndexAtTextOffset(block.text, 7), 1); // début de 38.14
	assert.equal(lineIndexAtTextOffset(block.text, 13), 2); // début de 3.00
	// Hit-test sur la 2ᵉ ligne → offset dans « 38.14 »
	const mid = pdfChars.find((ch) => ch.text === '8' && ch.y === 442);
	assert.ok(mid);
	const offset = pdfTextOffsetFromPoint(lines, mid.x + 1, mid.y + 6);
	assert.equal(block.text[offset], '8');
	assert.equal(lineIndexAtTextOffset(block.text, offset), 1);
});

test('snapshot undo/redo conserve _lineLocked et strippe les _* transitoires', () => {
	const out = stripTransientBlockFields({
		id: 'b1__L1',
		text: '38.14',
		_lineLocked: true,
		_splitFrom: 'b1',
		_mounted: true,
		_mountSig: 'x',
		_nativeBusy: true,
		_dragOriginX: 12
	});
	assert.equal(out._lineLocked, true);
	assert.equal(out._splitFrom, 'b1');
	assert.equal(out._mounted, undefined);
	assert.equal(out._mountSig, undefined);
	assert.equal(out._nativeBusy, undefined);
	assert.equal(out._dragOriginX, undefined);
	assert.equal(out.text, '38.14');
});

test('touched map : baseline figée, lastWritten avance (redo post-restore)', () => {
	const first = mergeNativeTouchedEntry(undefined, 'Marseile', 'Marseille');
	assert.deepEqual(first, { lastWritten: 'Marseile', baseline: 'Marseille' });
	const second = mergeNativeTouchedEntry(first, 'Marsei', 'Marseile');
	assert.equal(second.lastWritten, 'Marsei');
	assert.equal(second.baseline, 'Marseille');
	const legacy = nativeTouchedRecord('old');
	assert.deepEqual(legacy, { lastWritten: 'old', baseline: null });
	const fromLegacy = mergeNativeTouchedEntry('old', 'new', 'base');
	assert.deepEqual(fromLegacy, { lastWritten: 'new', baseline: 'base' });
});

test('zoom : glyphes partagés avec les snapshots undo re-scalés une seule fois', () => {
	const live = {
		id: 'b1',
		page: 1,
		x: 120,
		y: 80,
		width: 112,
		height: 12,
		originalX: 20,
		originalY: 240,
		pageWidth: 600,
		pageHeight: 800,
		pdfChars: lineChars('SG CALVI', 240, 0)
	};
	const snapshots = [stripTransientBlockFields(live), stripTransientBlockFields(live)];
	const zoomed = { viewportWidth: 750, viewportHeight: 1000 };
	const scaled = new WeakSet();
	for (const block of [live, ...snapshots]) rescaleBlockToViewport(block, zoomed, scaled);
	assert.equal(live.x, 150);
	assert.equal(live.y, 100);
	assert.equal(live.pdfChars[0].x, 25);
	assert.equal(live.pdfChars[0].y, 300);
	assert.equal(live.pdfChars[0].maskY, 300);
	assert.equal(snapshots[0].pdfChars, live.pdfChars);
	assert.equal(snapshots[1].originalY, 300);
});
