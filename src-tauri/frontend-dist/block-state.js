// @ts-check
// ============================================================================
// Machine à états des blocs de texte — SOURCE DE VÉRITÉ UNIQUE.
//
// Un bloc d'édition traverse des états EXCLUSIFS qui déterminent son rendu et
// les éditions qui lui sont permises :
//
//   image ───────────────────────────► (bitmap, déplaçable, jamais de texte)
//   logo ────────────────────────────► (bitmap exact, déplaçable, non éditable)
//   native ──── frappe validée ──────► reste native (strips PDFium)
//      │
//      ├── glyphe masqué (trim) ─────► native-trimmed (canvas natif + masques)
//      ├── déplacé / redimensionné ──► live-html (HTML, police substituée)
//      ├── texte édité hors natif ───► live-html
//      └── échec natif (_nativeStale)► live-html au prochain rendu
//
// Les prédicats ci-dessous sont PURS (aucun accès au DOM ni à l'état global,
// hormis window.__TAURI__ pour l'éligibilité native). isLogoBlock reste dans
// app.js (il dépend du catalogue de polices) et est injecté au démarrage.
// ============================================================================

/**
 * @typedef {Object} PdfCharBox
 * @property {string} text
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 * @property {number} index Index du caractère dans le bloc (ordre du texte).
 * @property {number} pageCharIndex Index dans la page texte PDFium (-1 si inconnu).
 */

/**
 * @typedef {Object} EditBlock
 * @property {string} id
 * @property {number} page
 * @property {string} [kind] 'image' pour les blocs image.
 * @property {boolean} [hidden]
 * @property {boolean} [added]
 * @property {string} [text]
 * @property {string} [originalText]
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 * @property {number} [originalX]
 * @property {number} [originalY]
 * @property {number} [originalWidth]
 * @property {number} [originalHeight]
 * @property {PdfCharBox[]} [pdfChars]
 * @property {string} [source] 'pdfium' | 'ocr' | ...
 * @property {boolean} [multiline]
 * @property {boolean} [textEdited] Converti en édition HTML (définitif).
 * @property {boolean} [htmlEdited]
 * @property {boolean} [inlineEditDirty]
 * @property {boolean} [glyphTrimOnly] Suppression en fin par masquage de glyphes.
 * @property {number[]} [hiddenCharIndexes] Glyphes masqués (suppr. locales).
 * @property {boolean} [boxResized]
 * @property {number} [rotation]
 * @property {string} [fontFamilyOverride]
 * @property {number} [fontSizeOverride]
 * @property {boolean|null} [boldOverride]
 * @property {boolean|null} [italicOverride]
 * @property {string} [colorOverride]
 * @property {boolean} [_nativeStale] Édition native devenue impossible.
 * @property {boolean} [_nativeBusy] Édition native en vol.
 * @property {boolean} [_nativeQueued] Édition native en file.
 * @property {boolean} [_detached] Retiré de state.editBlocks (état zombie).
 * @property {boolean} [_isLogo] Classification logo figée (sticky).
 * @property {boolean} [localGlyphEdited]
 * @property {number} [localCaretIndex]
 * @property {('prev'|'next')} [localCaretAffinity]
 * @property {string} [fontName]
 * @property {number} [pdfFontSize]
 */

/** États exclusifs d'un bloc (voir diagramme en tête de fichier). */
export const BlockState = Object.freeze({
	IMAGE: 'image',
	LOGO: 'logo',
	NATIVE: 'native',
	NATIVE_TRIMMED: 'native-trimmed',
	LIVE_HTML: 'live-html'
});

/** @type {{ isLogoBlock: (block: EditBlock) => boolean }} */
const deps = {
	isLogoBlock: () => false
};

/**
 * Injecte les dépendances qui ne peuvent pas vivre ici (catalogue de polices).
 * Appelé une fois au démarrage par app.js.
 * @param {Partial<typeof deps>} overrides
 */
export function configureBlockState(overrides) {
	Object.assign(deps, overrides);
}

/**
 * Classifie un bloc dans son état de rendu courant.
 * @param {EditBlock} block
 * @returns {string} Une valeur de BlockState.
 */
export function blockState(block) {
	if (!block || block.kind === 'image') return BlockState.IMAGE;
	if (deps.isLogoBlock(block)) return BlockState.LOGO;
	if (block.glyphTrimOnly || hasLocalGlyphEdits(block)) return BlockState.NATIVE_TRIMMED;
	if (isLiveTextBlock(block)) return BlockState.LIVE_HTML;
	return BlockState.NATIVE;
}

// ---------------------------------------------------------------------------
// Prédicats d'état
// ---------------------------------------------------------------------------

/**
 * Bloc modifié d'une manière ou d'une autre (déplacé, redimensionné, édité).
 * @param {EditBlock} block
 */
export function isBlockDirty(block) {
	const moved = Math.abs(block.x - block.originalX) > 0.5 || Math.abs(block.y - block.originalY) > 0.5;
	const resized =
		Math.abs(block.width - (block.originalWidth ?? block.width)) > 0.5 ||
		Math.abs(block.height - (block.originalHeight ?? block.height)) > 0.5;
	const edited = (block.text || '') !== (block.originalText || '');
	return moved || resized || edited || Boolean(block.textEdited) || hasLocalGlyphEdits(block);
}

/**
 * Texte du bloc modifié (au sens « bascule en rendu HTML »).
 * @param {EditBlock} block
 */
export function isBlockTextEdited(block) {
	if (block.textEdited) return true;
	// Suppression « en fin » via masquage de glyphe natif : block.text est tronqué
	// mais on RESTE en rendu natif (pas de bascule HTML/substitution) → zéro reflow.
	if (block.glyphTrimOnly) return false;
	return (block.text || '') !== (block.originalText || '');
}

/**
 * Bloc portant des suppressions locales de glyphes (masquage natif).
 * @param {EditBlock} block
 */
export function hasLocalGlyphEdits(block) {
	return Boolean(block && Array.isArray(block.hiddenCharIndexes) && block.hiddenCharIndexes.length > 0);
}

/**
 * Bloc texte « vivant » : édité OU déplacé. On le rend en HTML (police métrique-
 * compatible) et on le déplace par translate3d, exactement comme les blocs déjà
 * édités. Plus AUCUN chemin bitmap pour le texte : la capture snapshot reste
 * réservée aux logos/images (non reproductibles en HTML). Les blocs « glyphe
 * trim / glyphe masqué » gardent leur chemin natif dédié (édge case inchangé).
 * @param {EditBlock} block
 */
export function isLiveTextBlock(block) {
	if (!block || block.kind === 'image') return false;
	if (block.glyphTrimOnly || hasLocalGlyphEdits(block)) return false;
	if (deps.isLogoBlock(block)) return false;
	if (isBlockTextEdited(block)) return true;
	return (
		Math.abs(block.x - (block.originalX ?? block.x)) > 0.5 ||
		Math.abs(block.y - (block.originalY ?? block.y)) > 0.5
	);
}

/**
 * Bloc éligible à l'édition native : bloc texte PDFium vierge, non
 * déplacé/retouché, dont chaque caractère est mappé sur la page texte PDFium.
 * @param {EditBlock} block
 */
export function nativeTextEditEligible(block) {
	if (!block || block.kind === 'image' || block.hidden || block.added) return false;
	if (block._nativeStale) return false;
	if (!window.__TAURI__ && !window.slatePdfBridge?.invoke) return false;
	if (!Array.isArray(block.pdfChars) || !block.pdfChars.length) return false;
	if (block.source && block.source !== 'pdfium') return false;
	if (isBlockTextEdited(block) || block.htmlEdited || block.inlineEditDirty) return false;
	if (hasLocalGlyphEdits(block) || block.glyphTrimOnly || block.localGlyphEdited) return false;
	// Multiligne : natif autorisé si la reconstruction ligne-par-ligne des
	// glyphes correspond exactement au texte du bloc (sinon le mapping
	// offset→glyphe serait ambigu). Pendant une session native EN VOL,
	// block.text est optimistement en avance sur les glyphes : l'alignement a
	// été validé au départ de la session.
	if (block.multiline || (block.text || '').includes('\n')) {
		if (!block._nativeBusy && !block._nativeQueued) {
			const lines = pdfCharLines(block);
			if (!lines.length || pdfLinesText(lines) !== (block.text || '')) return false;
		}
	}
	if (block.boxResized || block.rotation) return false;
	if (block.fontFamilyOverride || block.fontSizeOverride) return false;
	if (block.boldOverride !== undefined && block.boldOverride !== null) return false;
	if (block.italicOverride !== undefined && block.italicOverride !== null) return false;
	if (block.colorOverride) return false;
	const moved =
		Math.abs(block.x - (block.originalX ?? block.x)) > 0.5 ||
		Math.abs(block.y - (block.originalY ?? block.y)) > 0.5;
	if (moved) return false;
	// Chaque glyphe VISIBLE doit être mappé sur la page texte PDFium. Les
	// espaces « visuels » entre segments (deux objets texte fusionnés en une
	// ligne) n'ont PAS de caractère page correspondant (pageCharIndex = -1) :
	// ils sont tolérés — le diff natif les traite comme des entrées souples
	// (jamais d'ancre dessus, suppression → repli HTML).
	if (
		block.pdfChars.some(
			(ch) =>
				(!Number.isInteger(ch.pageCharIndex) || ch.pageCharIndex < 0) &&
				stripWhitespace(ch.text || '').length
		)
	) {
		return false;
	}
	return true;
}

// ---------------------------------------------------------------------------
// Glyphes et lignes
// ---------------------------------------------------------------------------

/**
 * Indices des glyphes masqués par une suppression locale.
 * @param {EditBlock} block
 * @returns {Set<number>}
 */
export function hiddenCharSet(block) {
	return new Set(Array.isArray(block?.hiddenCharIndexes) ? block.hiddenCharIndexes : []);
}

/**
 * Glyphes du bloc encore visibles (suppressions locales exclues).
 * @param {EditBlock} block
 * @returns {PdfCharBox[]}
 */
export function visiblePdfChars(block) {
	const hidden = hiddenCharSet(block);
	return (Array.isArray(block?.pdfChars) ? block.pdfChars : []).filter((ch) => !hidden.has(ch.index));
}

/**
 * Texte reconstruit depuis les glyphes visibles, dans l'ordre du texte.
 * @param {EditBlock} block
 */
export function visiblePdfText(block) {
	return visiblePdfChars(block)
		.sort((a, b) => a.index - b.index)
		.map((ch) => ch.text || '')
		.join('') || block.text || '';
}

/**
 * Regroupe les glyphes visibles en lignes visuelles (proximité verticale),
 * lignes triées haut→bas et caractères gauche→droite.
 * @param {EditBlock} block
 * @returns {{ y: number, height: number, chars: PdfCharBox[] }[]}
 */
export function pdfCharLines(block) {
	const chars = visiblePdfChars(block);
	const lines = [];
	for (const ch of chars) {
		let line = lines.find((candidate) => {
			const center = candidate.y + candidate.height / 2;
			const chCenter = ch.y + ch.height / 2;
			return Math.abs(center - chCenter) <= Math.max(candidate.height, ch.height) * 0.45;
		});
		if (!line) {
			line = { y: ch.y, height: ch.height, chars: [] };
			lines.push(line);
		}
		line.chars.push(ch);
	}
	lines.sort((a, b) => a.y - b.y);
	for (const line of lines) {
		line.chars.sort((a, b) => a.x - b.x);
	}
	return lines;
}

/**
 * Texte multiligne reconstruit depuis les lignes de pdfCharLines.
 * @param {{ chars: PdfCharBox[] }[]} lines
 */
export function pdfLinesText(lines) {
	return lines.map((line) => line.chars.map((ch) => ch.text).join('')).join('\n');
}

/**
 * Offset texte du caret dans la reconstruction ligne par ligne. L'affinité
 * 'prev' ancre le caret APRÈS le dernier caractère qui précède (fin de ligne),
 * sinon AVANT le premier caractère qui suit — la différence compte aux
 * frontières de ligne, où un '\n' est inséré entre les deux.
 * @param {EditBlock} block
 * @param {{ chars: PdfCharBox[] }[]} lines
 * @param {number} caretIndex
 */
export function pdfCaretTextOffset(block, lines, caretIndex) {
	let text = '';
	let nextOffset = -1;
	let prevOffset = 0;
	for (const line of lines) {
		if (text) text += '\n';
		for (const ch of line.chars) {
			if (nextOffset < 0 && ch.index >= caretIndex) nextOffset = text.length;
			text += ch.text;
			if (ch.index < caretIndex) prevOffset = text.length;
		}
	}
	if (block.localCaretAffinity === 'prev') return prevOffset;
	return nextOffset < 0 ? text.length : nextOffset;
}

/**
 * Convertit un point de page en offset texte à partir des boîtes natives.
 * Caret ET sélection à la souris doivent utiliser cette géométrie, jamais
 * celle de la police HTML transparente qui peut diverger après une édition PDF.
 * @param {{ y: number, height: number, chars: PdfCharBox[] }[]} lines
 * @param {number} pageX
 * @param {number} pageY
 * @returns {number|null}
 */
export function pdfTextOffsetFromPoint(lines, pageX, pageY) {
	if (!Array.isArray(lines) || !lines.length) return null;
	let bestLine = null;
	let bestDistance = Infinity;
	let bestStart = 0;
	let textOffset = 0;
	for (const line of lines) {
		const lineLength = line.chars.reduce((sum, character) => sum + (character.text || '').length, 0);
		const distance = Math.abs(pageY - (line.y + line.height / 2));
		if (distance < bestDistance) {
			bestDistance = distance;
			bestLine = line;
			bestStart = textOffset;
		}
		textOffset += lineLength + 1;
	}
	if (!bestLine) return null;
	let offset = bestStart;
	for (const character of bestLine.chars) {
		if (pageX < character.x + character.width / 2) return offset;
		offset += (character.text || '').length;
	}
	return offset;
}

/**
 * Bornes [start, end) d'un glisser de sélection exprimées en offsets texte,
 * calculées uniquement sur la géométrie des glyphes PDF.
 * @param {{ y: number, height: number, chars: PdfCharBox[] }[]} lines
 * @param {number} startX
 * @param {number} startY
 * @param {number} endX
 * @param {number} endY
 * @returns {{ start: number, end: number }|null}
 */
export function selectionOffsetsFromGlyphDrag(lines, startX, startY, endX, endY) {
	const anchor = pdfTextOffsetFromPoint(lines, startX, startY);
	const focus = pdfTextOffsetFromPoint(lines, endX, endY);
	if (anchor == null || focus == null) return null;
	return { start: Math.min(anchor, focus), end: Math.max(anchor, focus) };
}

/**
 * Bornes de mot autour d'un offset (double-clic), en Unicode letter/number.
 * @param {string} text
 * @param {number} offset
 * @returns {{ start: number, end: number }}
 */
export function wordBoundsAtTextOffset(text, offset) {
	const value = text || '';
	const clamped = Math.max(0, Math.min(offset, value.length));
	const isWord = (ch) => /[\p{L}\p{N}_]/u.test(ch || '');
	let start = clamped;
	let end = clamped;
	while (start > 0 && isWord(value[start - 1])) start -= 1;
	while (end < value.length && isWord(value[end])) end += 1;
	if (start === end && end < value.length) end += 1;
	return { start, end };
}

// ---------------------------------------------------------------------------
// Texte
// ---------------------------------------------------------------------------

/**
 * Comparaison de textes insensible aux blancs : les espaces « visuels » de
 * l'analyse (écarts de crénage/colonnes) peuvent apparaître ou disparaître
 * sans que le CONTENU du document ait changé.
 * @param {string|null|undefined} value
 */
export function stripWhitespace(value) {
	return (value || '').replace(/\s+/g, '');
}

/**
 * Blancs horizontaux seulement (espace, tab, NBSP…). Les sauts de ligne ne
 * sont PAS des soft-spaces PDF : les traiter comme `\s` faisait remonter le
 * diff natif au-dessus d'un `\n` virtuel et corrompait les frappes multiligne.
 * @param {string|null|undefined} ch
 */
export function isHorizontalWhitespace(ch) {
	return typeof ch === 'string' && /[ \t\f\v\u00a0\u202f\u2007\u2009]/u.test(ch);
}

/**
 * Index de ligne (0-based) contenant l'offset texte, pour un texte joint par `\n`.
 * @param {string} text
 * @param {number} offset
 */
export function lineIndexAtTextOffset(text, offset) {
	const value = text || '';
	const clamped = Math.max(0, Math.min(offset, value.length));
	let line = 0;
	for (let i = 0; i < clamped; i += 1) {
		if (value[i] === '\n') line += 1;
	}
	return line;
}

// Les blocs d'édition sont stockés en px viewport AU ZOOM où ils ont été détectés
// (avec pageWidth/pageHeight du viewport mémorisés). Quand le zoom change, on
// re-scale leurs coordonnées proportionnellement, sinon ils se retrouvent
// désalignés du texte affiché → impossibles à cliquer/modifier.
// `scaled` : les snapshots undo/redo partagent les objets glyphes du bloc vivant
// (copie superficielle) ; chacun ne doit être re-scalé qu'une fois par zoom.
export function rescaleBlockToViewport(block, data, scaled) {
	if (!data || !block.pageWidth || !block.pageHeight) return;
	const rx = data.viewportWidth / block.pageWidth;
	const ry = data.viewportHeight / block.pageHeight;
	if (Math.abs(rx - 1) < 1e-4 && Math.abs(ry - 1) < 1e-4) return;

	block.x *= rx;
	block.width *= rx;
	if (typeof block.originalX === 'number') block.originalX *= rx;
	if (typeof block.originalWidth === 'number') block.originalWidth *= rx;
	block.y *= ry;
	block.height *= ry;
	if (typeof block.originalY === 'number') block.originalY *= ry;
	if (typeof block.originalHeight === 'number') block.originalHeight *= ry;
	if (block.pdfFontSize) block.pdfFontSize *= ry;
	if (block.baseFontSize) block.baseFontSize *= ry;
	if (block.fontSizeOverride) block.fontSizeOverride *= ry;
	if (block.fontMatch?.fontSize && !scaled.has(block.fontMatch)) {
		scaled.add(block.fontMatch);
		block.fontMatch.fontSize *= ry;
	}
	// Espacement inter-lettres capturé en px à l'échelle précédente.
	if (Number.isFinite(block.editLetterSpacing)) block.editLetterSpacing *= rx;

	const glyphs = [
		...(Array.isArray(block.pdfChars) ? block.pdfChars : []),
		...(Array.isArray(block._nativePristine?.chars) ? block._nativePristine.chars : [])
	];
	for (const ch of glyphs) {
		if (scaled.has(ch)) continue;
		scaled.add(ch);
		ch.x *= rx;
		ch.width *= rx;
		if (typeof ch.maskX === 'number') ch.maskX *= rx;
		if (typeof ch.maskWidth === 'number') ch.maskWidth *= rx;
		ch.y *= ry;
		ch.height *= ry;
		if (typeof ch.maskY === 'number') ch.maskY *= ry;
		if (typeof ch.maskHeight === 'number') ch.maskHeight *= ry;
	}

	// Le snapshot bitmap a été capturé à l'ancienne échelle : on l'invalide.
	block.snapshotDataUrl = null;
	block.inkSnapshotDataUrl = null;
	block.pageWidth = data.viewportWidth;
	block.pageHeight = data.viewportHeight;

	// Origines de montage/drag et caches d'encre périmés à la nouvelle échelle :
	// on force un remontage propre du node (left/top/font-size recalculés au
	// prochain rendu), au lieu de compter sur le changement de signature via
	// baseFontSize — qui n'est pas toujours renseigné.
	delete block._mounted;
	delete block._mountX;
	delete block._mountY;
	delete block._mountLeft;
	delete block._mountTop;
	delete block._mountSig;
	delete block._dragOriginX;
	delete block._dragOriginY;
	delete block._dragVisualLeft;
	delete block._dragVisualTop;
	delete block._inkRatio;
	delete block._dragForceHtml;
	delete block._compSuffixSnap;
}

/**
 * Étapes d'une édition découpée en modifications MINIMALES (alignement par plus
 * longue sous-séquence commune), appliquées de droite à gauche pour que les
 * positions à gauche restent valides. Chaque étape est un texte complet ; la
 * dernière vaut `target`. Vide si une seule modification suffit : le moteur
 * refuse une édition à cheval sur deux objets texte (« 3542541 - 100Q65 » →
 * « 3542 - 1Q65 »), mais accepte « retirer 00 » puis « retirer 541 ».
 * @param {string} base
 * @param {string} target
 * @returns {string[]}
 */
export function textEditSteps(base, target) {
	const a = [...base];
	const b = [...target];
	if (a.length * b.length > 250000) return [];
	const width = b.length + 1;
	const lcs = new Uint16Array((a.length + 1) * width);
	for (let i = a.length - 1; i >= 0; i -= 1) {
		for (let j = b.length - 1; j >= 0; j -= 1) {
			lcs[i * width + j] =
				a[i] === b[j]
					? lcs[(i + 1) * width + j + 1] + 1
					: Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
		}
	}
	/** @type {{ start: number, end: number, text: string }[]} */
	const hunks = [];
	let i = 0;
	let j = 0;
	while (i < a.length || j < b.length) {
		if (i < a.length && j < b.length && a[i] === b[j]) {
			i += 1;
			j += 1;
			continue;
		}
		const start = i;
		let text = '';
		while (i < a.length || j < b.length) {
			if (i < a.length && j < b.length && a[i] === b[j]) break;
			if (j < b.length && (i === a.length || lcs[i * width + j + 1] >= lcs[(i + 1) * width + j])) {
				text += b[j];
				j += 1;
			} else {
				i += 1;
			}
		}
		hunks.push({ start, end: i, text });
	}
	if (hunks.length < 2) return [];
	const steps = [];
	let current = a;
	for (let k = hunks.length - 1; k >= 0; k -= 1) {
		const { start, end, text } = hunks[k];
		current = [...current.slice(0, start), ...text, ...current.slice(end)];
		steps.push(current.join(''));
	}
	return steps;
}
