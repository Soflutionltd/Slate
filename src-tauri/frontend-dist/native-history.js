/**
 * Helpers purs pour l'historique undo/redo natif (testables hors app.js).
 */

/** Méta structurelles à conserver dans les snapshots undo/redo. */
export const PERSISTED_BLOCK_META = new Set(['_lineLocked', '_splitFrom']);

// Copie profonde des tableaux et objets simples (glyphes, fontMatch…) : un
// snapshot ne doit partager aucun objet modifiable avec le bloc vivant, sinon
// toute mutation en place (zoom, réindexation) altère l'historique en silence.
function clonePlainData(value) {
	if (Array.isArray(value)) return value.map(clonePlainData);
	if (value && typeof value === 'object') {
		const proto = Object.getPrototypeOf(value);
		if (proto !== Object.prototype && proto !== null) return value;
		const copy = {};
		for (const key of Object.keys(value)) copy[key] = clonePlainData(value[key]);
		return copy;
	}
	return value;
}

export function stripTransientBlockFields(block) {
	const copy = {};
	for (const key of Object.keys(block)) {
		if (key.startsWith('_') && !PERSISTED_BLOCK_META.has(key)) continue;
		copy[key] = clonePlainData(block[key]);
	}
	return copy;
}

export function nativeTouchedRecord(value) {
	if (value == null) return null;
	if (typeof value === 'string') return { lastWritten: value, baseline: null };
	return {
		lastWritten: typeof value.lastWritten === 'string' ? value.lastWritten : '',
		baseline: typeof value.baseline === 'string' ? value.baseline : null
	};
}

/**
 * Fusionne une entrée touched : baseline figée à la 1ʳᵉ édition, lastWritten
 * toujours le dernier texte écrit dans le document.
 */
export function mergeNativeTouchedEntry(prevValue, lastWritten, baseline) {
	const prev = nativeTouchedRecord(prevValue);
	return {
		lastWritten,
		baseline: prev?.baseline ?? (typeof baseline === 'string' ? baseline : null)
	};
}
