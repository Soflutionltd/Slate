/**
 * Helpers purs pour l'historique undo/redo natif (testables hors app.js).
 */

/** Méta structurelles à conserver dans les snapshots undo/redo. */
export const PERSISTED_BLOCK_META = new Set(['_lineLocked', '_splitFrom']);

export function stripTransientBlockFields(block) {
	const copy = { ...block };
	for (const key of Object.keys(copy)) {
		if (key.startsWith('_') && !PERSISTED_BLOCK_META.has(key)) delete copy[key];
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
