import * as pdfjsLib from './vendor/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).toString();

const STANDARD_FONT_DATA_URL = new URL('./vendor/standard_fonts/', import.meta.url).toString();

function pdfDocumentOptions(extra) {
	const options = {
		standardFontDataUrl: STANDARD_FONT_DATA_URL,
		fontExtraProperties: true,
		...extra
	};
	// PDF.js transfère (et détache) le buffer fourni dans `data` vers son worker.
	// On lui passe TOUJOURS une copie pour que le buffer source (state.fileBytes)
	// reste intact et utilisable par PDFium côté Rust.
	if (options.data instanceof Uint8Array) {
		options.data = options.data.slice();
	} else if (options.data instanceof ArrayBuffer) {
		options.data = options.data.slice(0);
	}
	return options;
}

window.addEventListener('unhandledrejection', (event) => {
	console.error('Unhandled rejection', event.reason);
});

const SETTINGS_KEY = 'alto-pdf-settings:v1';
const CSS_UNITS = 96 / 72;
const EDIT_BLOCK_PAD_X = 4;
const EDIT_BLOCK_PAD_Y = 0;

function pageViewport(page, zoom = state.zoom) {
	return page.getViewport({ scale: zoom * CSS_UNITS });
}

const defaultSettings = {
	settingsVersion: 4,
	language: 'auto',
	defaultZoom: 1,
	fitWidth: false,
	pageLayout: 'continuous',
	showTools: true,
	showRail: true,
	showPageNotes: true,
	showAlignmentGuides: true,
	highlightColor: '#f5c542',
	identityName: '',
	identityEmail: ''
};

const state = {
	tabs: [],
	activeTabId: null,
	pendingCloseTabId: null,
	fileName: null,
	fileBytes: null,
	pdf: null,
	fingerprint: null,
	page: 1,
	zoom: defaultSettings.defaultZoom,
	// Mode d'ajustement actif du rail : 'page' (page entière), 'width' (largeur),
	// ou null (zoom manuel). Sert à allumer/éteindre le bouton « ajuster ».
	fitMode: null,
	// Accueil affiché par-dessus les documents ouverts (bouton maison), sans fermer
	// les onglets. Cliquer un onglet revient au document.
	viewingHome: false,
	// Affichage des récents sur l'accueil : 'grid' (cartes + vignettes) ou 'list'.
	homeView: (() => {
		try {
			return localStorage.getItem('alto-home-view') === 'list' ? 'list' : 'grid';
		} catch (_err) {
			return 'grid';
		}
	})(),
	pageSize: { width: 0, height: 0 },
	annotations: [],
	search: {
		query: '',
		results: [],
		activeIndex: -1
	},
	editMode: false,
	editBlocks: [],
	selectedBlockId: null,
	// Sélection multiple (rectangle/marquee). `selectedBlockId` reste le bloc
	// « primaire » (panneau de gauche) ; `selectedBlockIds` contient TOUS les blocs
	// sélectionnés, y compris le primaire.
	selectedBlockIds: [],
	editingBlockId: null,
	signaturePlacements: [],
	pendingSignature: null,
	selectedSignatureId: null,
	createSource: 'file',
	activeDrawer: 'search',
	renderToken: 0,
	pageElements: new Map(),
	pageObserver: null,
	settings: loadSettings()
};

const elements = {
	app: document.getElementById('app'),
	fileInput: document.getElementById('file-input'),
	tabList: document.getElementById('document-tabs'),
	tabsViewport: document.getElementById('document-tabs-viewport'),
	tabsScrollLeft: document.getElementById('tabs-scroll-left'),
	tabsScrollRight: document.getElementById('tabs-scroll-right'),
	createTabButton: document.getElementById('create-tab-button'),
	openButton: document.getElementById('open-button'),
	chooseEmpty: document.getElementById('choose-empty'),
	homeOpen: document.getElementById('home-open'),
	homeCreate: document.getElementById('home-create'),
	homeDropzone: document.getElementById('home-dropzone'),
	homeGreeting: document.getElementById('home-greeting'),
	homeSub: document.getElementById('home-sub'),
	homeRecentsBody: document.getElementById('home-recents-body'),
	homeClearRecents: document.getElementById('home-clear-recents'),
	homeViewButtons: Array.from(document.querySelectorAll('[data-home-view]')),
	profileAvatar: document.getElementById('profile-avatar'),
	homeButton: document.getElementById('home-button'),
	dropZone: document.getElementById('drop-zone'),
	emptyState: document.getElementById('empty-state'),
	pagesStack: document.getElementById('pages-stack'),
	status: document.getElementById('status'),
	pageLabel: document.getElementById('page-label'),
	docSize: document.getElementById('doc-size'),
	zoomLabel: document.getElementById('zoom-label'),
	prevPage: document.getElementById('prev-page'),
	nextPage: document.getElementById('next-page'),
	railZoomOut: document.getElementById('rail-zoom-out'),
	railZoomIn: document.getElementById('rail-zoom-in'),
	railFitWidth: document.getElementById('rail-fit-width'),
	railLayoutSingle: document.getElementById('rail-layout-single'),
	undoButton: document.getElementById('undo-button'),
	redoButton: document.getElementById('redo-button'),
	downloadOriginal: document.getElementById('download-original'),
	exportAnnotations: document.getElementById('export-annotations'),
	exportEditedPdf: document.getElementById('export-edited-pdf'),
	saveButton: document.getElementById('save-button'),
	searchForm: document.getElementById('search-form'),
	searchInput: document.getElementById('search-input'),
	searchButton: document.getElementById('search-button'),
	results: document.getElementById('results'),
	annotationText: document.getElementById('annotation-text'),
	highlightButton: document.getElementById('highlight-button'),
	commentButton: document.getElementById('comment-button'),
	notes: document.getElementById('notes'),
	drawer: document.getElementById('side-drawer'),
	drawerClose: document.getElementById('drawer-close'),
	drawerKicker: document.getElementById('drawer-kicker'),
	drawerTitle: document.getElementById('drawer-title'),
	pageSummaryTitle: document.getElementById('page-summary-title'),
	pageSummaryMeta: document.getElementById('page-summary-meta'),
	modifyTab: document.getElementById('modify-tab'),
	allToolsTab: document.querySelector('.top-tabs [data-open-panel="tools"]'),
	modifyTool: document.getElementById('modify-tool'),
	exitEditMode: document.getElementById('exit-edit-mode'),
	moreTools: document.getElementById('more-tools'),
	toggleMoreTools: document.getElementById('toggle-more-tools'),
	scanEditBlocks: document.getElementById('scan-edit-blocks'),
	ocrCurrentPage: document.getElementById('ocr-current-page'),
	editText: document.getElementById('edit-text'),
	editTextPanel: document.getElementById('edit-text-panel'),
	applyEditText: document.getElementById('apply-edit-text'),
	deleteEditBlock: document.getElementById('delete-edit-block'),
	applyEditTextPanel: document.getElementById('apply-edit-text-panel'),
	deleteEditBlockPanel: document.getElementById('delete-edit-block-panel'),
	formatPanel: document.getElementById('format-panel'),
	fontCombo: document.getElementById('font-combo'),
	fontComboTrigger: document.getElementById('font-combo-trigger'),
	fontComboValue: document.getElementById('font-combo-value'),
	fontComboPopover: document.getElementById('font-combo-popover'),
	fontComboSearch: document.getElementById('font-combo-search'),
	fontComboList: document.getElementById('font-combo-list'),
	formatSize: document.getElementById('format-size'),
	formatColor: document.getElementById('format-color'),
	formatBold: document.getElementById('format-bold'),
	formatItalic: document.getElementById('format-italic'),
	formatUnderline: document.getElementById('format-underline'),
	formatAlignButtons: Array.from(document.querySelectorAll('.format-align [data-align]')),
	settingsButton: document.getElementById('settings-button'),
	settingsBackdrop: document.getElementById('settings-backdrop'),
	settingsModal: document.getElementById('settings-modal'),
	settingsClose: document.getElementById('settings-close'),
	settingsDone: document.getElementById('settings-done'),
	settingLanguage: document.getElementById('setting-language'),
	settingDefaultZoom: document.getElementById('setting-default-zoom'),
	settingPageLayout: document.getElementById('setting-page-layout'),
	settingIdentityName: document.getElementById('setting-identity-name'),
	settingIdentityEmail: document.getElementById('setting-identity-email'),
	settingAiProvider: document.getElementById('setting-ai-provider'),
	settingAiModel: document.getElementById('setting-ai-model'),
	settingAiKey: document.getElementById('setting-ai-key'),
	settingAiBaseurl: document.getElementById('setting-ai-baseurl'),
	settingFitWidth: document.getElementById('setting-fit-width'),
	settingShowTools: document.getElementById('setting-show-tools'),
	settingShowRail: document.getElementById('setting-show-rail'),
	settingShowNotes: document.getElementById('setting-show-notes'),
	settingShowGuides: document.getElementById('setting-show-guides'),
	settingHighlightColor: document.getElementById('setting-highlight-color'),
	connectClaude: document.getElementById('connect-claude'),
	settingClaudeLabel: document.getElementById('setting-claude-label'),
	settingClaudeDesc: document.getElementById('setting-claude-desc'),
	copyMcpPath: document.getElementById('copy-mcp-path'),
	settingMcpLabel: document.getElementById('setting-mcp-label'),
	settingMcpDesc: document.getElementById('setting-mcp-desc'),
	settingsTabGeneral: document.getElementById('settings-tab-general'),
	settingsTabDisplay: document.getElementById('settings-tab-display'),
	settingsTabIdentity: document.getElementById('settings-tab-identity'),
	settingsTabAi: document.getElementById('settings-tab-ai'),
	settingsTabConnectors: document.getElementById('settings-tab-connectors'),
	createView: document.getElementById('create-view'),
	createClose: document.getElementById('create-close'),
	createSources: document.getElementById('create-sources'),
	createPick: document.getElementById('create-pick'),
	createHint: document.getElementById('create-hint'),
	createConfirm: document.getElementById('create-confirm'),
	clearLocalData: document.getElementById('clear-local-data'),
	saveChangesBackdrop: document.getElementById('save-changes-backdrop'),
	saveChangesModal: document.getElementById('save-changes-modal'),
	saveChangesMessage: document.getElementById('save-changes-message'),
	saveChangesFilename: document.getElementById('save-changes-filename'),
	saveConfirmClose: document.getElementById('save-confirm-close'),
	saveDiscardClose: document.getElementById('save-discard-close'),
	saveCancelClose: document.getElementById('save-cancel-close'),
	protectModal: document.getElementById('protect-modal'),
	protectBackdrop: document.getElementById('protect-backdrop'),
	protectTitle: document.getElementById('protect-title'),
	protectHelp: document.getElementById('protect-help'),
	protectPasswordInput: document.getElementById('protect-password'),
	protectConfirmInput: document.getElementById('protect-confirm'),
	protectConfirmButton: document.getElementById('protect-confirm-button'),
	protectCancelButton: document.getElementById('protect-cancel-button'),
	protectError: document.getElementById('protect-error'),
	toolOptionsModal: document.getElementById('tool-options-modal'),
	toolOptionsBackdrop: document.getElementById('tool-options-backdrop'),
	toolOptionsTitle: document.getElementById('tool-options-title'),
	toolOptionsHelp: document.getElementById('tool-options-help'),
	toolOptionsBody: document.getElementById('tool-options-body'),
	toolOptionsError: document.getElementById('tool-options-error'),
	toolOptionsCancel: document.getElementById('tool-options-cancel'),
	toolOptionsConfirm: document.getElementById('tool-options-confirm'),
	bookmarksModal: document.getElementById('bookmarks-modal'),
	bookmarksBackdrop: document.getElementById('bookmarks-backdrop'),
	bookmarksList: document.getElementById('bookmarks-list'),
	bookmarksAdd: document.getElementById('bookmarks-add'),
	bookmarksError: document.getElementById('bookmarks-error'),
	bookmarksCancel: document.getElementById('bookmarks-cancel'),
	bookmarksSave: document.getElementById('bookmarks-save'),
	thumbsGrid: document.getElementById('thumbs-grid'),
	outlineTree: document.getElementById('outline-tree'),
	outlineEmpty: document.getElementById('outline-empty'),
	formsEmpty: document.getElementById('forms-empty'),
	formsFields: document.getElementById('forms-fields'),
	formsApply: document.getElementById('forms-apply'),
	defaultAppModal: document.getElementById('default-app-modal'),
	defaultAppBackdrop: document.getElementById('default-app-backdrop'),
	defaultAppYes: document.getElementById('default-app-yes'),
	defaultAppLater: document.getElementById('default-app-later'),
	defaultAppNever: document.getElementById('default-app-never'),
	propertiesModal: document.getElementById('properties-modal'),
	propertiesBackdrop: document.getElementById('properties-backdrop'),
	propertiesList: document.getElementById('properties-list'),
	propertiesCloseButton: document.getElementById('properties-close-button'),
	recentModal: document.getElementById('recent-modal'),
	recentBackdrop: document.getElementById('recent-backdrop'),
	recentList: document.getElementById('recent-list'),
	recentClearButton: document.getElementById('recent-clear-button'),
	recentCloseButton: document.getElementById('recent-close-button'),
	compareModal: document.getElementById('compare-modal'),
	compareBackdrop: document.getElementById('compare-backdrop'),
	compareClose: document.getElementById('compare-close'),
	comparePickA: document.getElementById('compare-pick-a'),
	comparePickB: document.getElementById('compare-pick-b'),
	compareNameA: document.getElementById('compare-name-a'),
	compareNameB: document.getElementById('compare-name-b'),
	comparePageLabel: document.getElementById('compare-page-label'),
	comparePrev: document.getElementById('compare-prev'),
	compareNext: document.getElementById('compare-next'),
	compareCanvasA: document.getElementById('compare-canvas-a'),
	compareCanvasB: document.getElementById('compare-canvas-b'),
	compareCanvasDiff: document.getElementById('compare-canvas-diff')
};

const translations = {
	en: {
		allTools: 'All tools',
		modify: 'Modify',
		convert: 'Convert',
		sign: 'Sign electronically',
		searchPlaceholder: 'Search text or tools',
		search: 'Search',
		open: 'Open',
		openAnother: 'Open',
		exportNotes: 'Export notes',
		exportEditedPdf: 'Export',
		saveDocument: 'Save',
		settings: 'Settings',
		closeTools: 'Close tools',
		openPdf: 'Open a PDF',
		saveCopy: 'Save a copy',
		findText: 'Find text',
		addComments: 'Add comments',
		modifyPdf: 'Modify a PDF',
		exportPdf: 'Export a PDF',
		combineFiles: 'Combine files',
		organizePages: 'Organize pages',
		fillSign: 'Fill and sign',
		scanOcr: 'Scan and OCR',
		protectPdf: 'Protect a PDF',
		redactPdf: 'Redact a PDF',
		compressPdf: 'Compress a PDF',
		deskewPdf: 'Straighten a scan',
		exportImage: 'Export page to image',
		docProperties: 'Document properties',
		recentFiles: 'Recent files',
		prepareForm: 'Prepare a form',
		convertToPdf: 'Convert to PDF',
		addStamp: 'Add a stamp',
		useCertificate: 'Use a certificate',
		usePrepress: 'Use prepress',
		measureObjects: 'Measure objects',
		compareFiles: 'Compare files',
		addMultimedia: 'Add multimedia content',
		sendComments: 'Send for comments',
		guidedActions: 'Use guided actions',
		prepareAccessibility: 'Prepare accessibility',
		applyPdfStandards: 'Apply PDF standards',
		addSearchIndex: 'Add a search index',
		useJavascript: 'Use JavaScript',
		customTool: 'Create a custom tool',
		stylePdf: 'Style this PDF',
		translatePdf: 'Translate this PDF',
		showMore: 'Show more',
		showLess: 'Show less',
		localOnly: 'Local only',
		localOnlyDesc: 'PDF files and notes stay on this Mac.',
		noPdfOpen: 'No PDF open',
		dropPdf: 'Drop a PDF anywhere.',
		previous: 'Previous',
		next: 'Next',
		fitWidth: 'Fit width',
		emptyTitle: 'Open a PDF',
		emptyDesc: 'Drop a file here or choose one from your computer.',
		choosePdf: 'Choose PDF',
		notes: 'Notes',
		annotations: 'Annotations',
		notePlaceholder: 'Write a note or select a search result...',
		highlight: 'Highlight',
		comment: 'Comment',
		noAnnotations: 'No annotations on this page.',
		pages: 'Pages',
		document: 'Document',
		noDocument: 'No document',
		pageSummaryEmpty: 'Open a PDF to see page controls.',
		scanBlocks: 'Scan editable blocks',
		ocrPage: 'OCR current page',
		selectedText: 'Selected text',
		editTextPlaceholder: 'Select a detected text block...',
		applyText: 'Apply text',
		hideBlock: 'Hide block',
		nativeEditing: 'Native editing MVP',
		nativeEditingDesc: 'Detected text blocks can be edited and moved, then exported as a flattened PDF.',
		defaultZoom: 'Default zoom',
		defaultZoomDesc: 'Applied when opening a PDF unless fit width is enabled.',
		language: 'Language',
		languageDesc: 'Use the Mac language automatically or force one language.',
		fitWidthSetting: 'Open documents in fit width',
		fitWidthDesc: 'Makes pages larger and easier to read by default.',
		showTools: 'Show tools panel',
		showToolsDesc: 'Keep the Acrobat-style tools panel visible on the left.',
		showRail: 'Show quick rail',
		showRailDesc: 'Keep the right-side quick actions visible.',
		showNotes: 'Show page notes',
		showNotesDesc: 'Display annotation chips on top of the PDF page.',
		highlightColor: 'Highlight color',
		highlightColorDesc: 'Default color for new highlights.',
		clearLocalNotes: 'Clear local notes',
		done: 'Done',
		resultsEmpty: 'Search results will appear here.',
		pdfLoaded: 'PDF loaded locally.',
		openingPdf: 'Opening PDF...',
		onlyPdf: 'Only PDF files are supported.',
		searching: 'Searching...',
		noResults: 'No results.',
		resultsFound: (count) => `${count} result(s) found.`,
		annotationSaved: 'Annotation saved locally.',
		textUpdated: 'Text block updated.',
		blockHidden: 'Block hidden for edited export.',
		editEnabled: 'Edit mode enabled.',
		editDisabled: 'Edit mode disabled.',
		scanningBlocks: 'Scanning editable text blocks...',
		blocksDetected: (count) => `${count} editable text block(s) detected.`,
		ocrRunning: 'Running local OCR...',
		ocrDetected: (count) => `${count} OCR block(s) detected locally.`,
		exportingEdited: 'Flattening edited PDF...',
		exportedEdited: 'Edited PDF exported.',
		localNotesCleared: 'Local notes cleared.',
		fileSaved: 'File saved.',
		fontsWebGroup: 'Online fonts',
		fontsCatSans: 'Online · Sans-serif',
		fontsCatSerif: 'Online · Serif',
		fontsCatMono: 'Online · Monospace',
		fontsCatDisplay: 'Online · Display',
		fontsCatScript: 'Online · Handwriting',
		fontsSystemGroup: 'Fonts on this computer',
		createTab: '+ Create',
		saveChangesTitle: 'Save changes?',
		saveChangesMessage: 'This PDF contains unsaved changes.',
		saveChangesConfirm: 'Save',
		saveChangesDiscard: "Don't save",
		saveChangesCancel: 'Cancel',
		untitledPdf: 'Untitled PDF',
		combineTitle: 'Combine PDF files',
		combineHelp: 'Pick several PDFs to merge into one. The new file will keep all pages in order.',
		combineCta: 'Select files',
		combineProcessing: 'Combining files...',
		combineDone: 'PDFs combined.',
		combineNeedTwo: 'Select at least two PDFs.',
		protectTitle: 'Protect this PDF',
		protectHelp: 'Set a password (AES-256). Required to open the file.',
		protectPassword: 'Password',
		protectConfirm: 'Confirm password',
		protectCta: 'Protect',
		protectMismatch: 'Passwords do not match.',
		protectEmpty: 'Enter a password.',
		protectProcessing: 'Encrypting PDF...',
		protectDone: 'PDF protected.',
		compressProcessing: 'Compressing PDF...',
		compressDone: (saved) => `PDF compressed (${saved} smaller).`,
		compressHelp: 'Downsamples and re-encodes embedded images. Higher quality keeps more detail; lower quality shrinks more.',
		compressQuality: 'Quality',
		compressLow: 'Small file (screen)',
		compressMedium: 'Balanced',
		compressHigh: 'High quality (print)',
		deskewProcessing: 'Analyzing and straightening scan...',
		deskewDone: (pages) => `Scan straightened: ${pages}.`,
		deskewNone: 'No skew detected in this document.',
		connectClaude: 'Connect',
		connectClaudeDesc: 'Connect Slate to Claude Desktop (local MCP server) so Claude can edit your PDFs itself.',
		connectClaudeDone: 'Claude Desktop connected. Restart Claude Desktop to see the "alto-pdf" tools.',
		settingsTabGeneral: 'General',
		settingsTabDisplay: 'Display',
		settingsTabIdentity: 'Identity',
		settingsTabAi: 'AI',
		settingsTabConnectors: 'Connectors',
		pageLayoutSetting: 'Page layout',
		pageLayoutDesc: 'Continuous scrolling or one page at a time.',
		pageLayoutContinuous: 'Continuous',
		pageLayoutSingle: 'Single page',
		identityNameLabel: 'Name',
		identityNameDesc: 'Used to sign your notes and comments.',
		identityEmailLabel: 'Email',
		identityEmailDesc: 'Linked to your identity in documents.',
		aiProviderLabel: 'Provider',
		aiProviderDesc: 'The model assisting your documents.',
		aiModelLabel: 'Model',
		aiModelDesc: 'Leave empty for the recommended model.',
		aiKeyLabel: 'API key',
		aiKeyDesc: 'Stored only on this Mac.',
		aiBaseUrlLabel: 'Local URL',
		aiBaseUrlDesc: 'For a local model or compatible endpoint.',
		aiConfigSaved: 'AI configuration saved.',
		mcpClientsLabel: 'ChatGPT, Cursor & other MCP clients',
		mcpClientsDesc: "Copy the path of Slate's MCP server to paste into any compatible client.",
		copyMcpPath: 'Copy path',
		mcpPathCopied: 'MCP server path copied to clipboard.',
		smartGuides: 'Smart alignment guides',
		smartGuidesDesc: 'Show red lines when a block aligns with another while dragging.',
		rotateProcessing: 'Rotating page...',
		rotateDone: 'Page rotated.',
		deleteProcessing: 'Deleting page...',
		deleteDone: 'Page deleted.',
		cancel: 'Cancel',
		needPdfOpen: 'Open a PDF first.',
		outlineTitle: 'Bookmarks',
		sign: 'Sign',
		signTitle: 'Fill & Sign',
		aiKicker: 'AI',
		aiTitle: 'AI assistant',
		options: 'Options',
		apply: 'Apply',
		processing: 'Processing…',
		position: 'Position',
		startAt: 'Start at',
		fontSize: 'Font size',
		margin: 'Margin (pt)',
		matchCase: 'Match case',
		posBottomCenter: 'Bottom center',
		posBottomRight: 'Bottom right',
		posBottomLeft: 'Bottom left',
		posTopCenter: 'Top center',
		posTopRight: 'Top right',
		posTopLeft: 'Top left',
		watermark: 'Add watermark',
		watermarkHelp: 'A diagonal watermark is added to every page.',
		watermarkText: 'Text',
		watermarkSize: 'Size',
		watermarkOpacity: 'Opacity',
		watermarkRotation: 'Rotation (°)',
		watermarkColor: 'Color',
		watermarkBold: 'Bold',
		watermarkEmpty: 'Enter watermark text.',
		watermarkDone: 'Watermark added.',
		pageNumbers: 'Add page numbers',
		pageNumbersDone: 'Page numbers added.',
		imagesToPdf: 'Images to PDF',
		imagesToPdfDone: 'PDF created from images.',
		cropPages: 'Crop pages',
		cropHelp: 'Margins (in points) removed from each side.',
		cropTop: 'Top',
		cropRight: 'Right',
		cropBottom: 'Bottom',
		cropLeft: 'Left',
		cropDone: 'Pages cropped.',
		autoRedact: 'Auto-redact',
		autoRedactHelp: 'Comma-separated terms. Matching text is permanently removed.',
		autoRedactTerms: 'Terms',
		autoRedactEmpty: 'Enter at least one term.',
		autoRedactNone: 'No match found.',
		autoRedactDone: (n) => `${n} area(s) redacted.`,
		redactCta: 'Redact',
		flatten: 'Flatten',
		flattenDone: 'PDF flattened.',
		extractImages: 'Extract images',
		extractImagesDone: (n) => `${n} image(s) extracted.`,
		unlockPdf: 'Unlock (remove password)',
		unlockHelp: 'Enter the current password to remove protection.',
		unlockCta: 'Unlock',
		unlockEmpty: 'Enter the password.',
		unlockDone: 'Password removed.',
		sanitize: 'Sanitize',
		sanitizeDone: 'Scripts and triggers removed.',
		repairPdf: 'Repair PDF',
		repairProcessing: 'Repairing PDF...',
		repairDone: 'PDF repaired and rebuilt.',
		fillForms: 'Fill forms',
		formsTitle: 'Form fields',
		formsEmpty: 'This PDF has no fillable form.',
		formsProcessing: 'Filling form...',
		formsDone: 'Form filled and saved.',
		removeAnnotations: 'Remove annotations',
		removeAnnotationsDone: 'Annotations removed.',
		removeBlankPages: 'Remove blank pages',
		blankProcessing: 'Looking for blank pages...',
		blankNone: 'No blank page found.',
		blankDone: (count) => `${count} blank page${count > 1 ? 's' : ''} removed.`,
		ocrSearchable: 'Make searchable (OCR)',
		ocrLayerProcessing: 'Running OCR and adding a searchable text layer...',
		ocrLayerDone: 'Searchable text layer added.',
		signPdf: 'Sign with a certificate',
		signHelp: 'Applies an invisible PAdES digital signature using your PKCS#12 certificate (.p12 / .pfx).',
		signPassword: 'Certificate password',
		signReason: 'Reason (optional)',
		signLocation: 'Location (optional)',
		signCta: 'Sign',
		signProcessing: 'Signing the document...',
		signDone: 'Document signed (PAdES).',
		editBookmarks: 'Edit bookmarks',
		bookmarkTitle: 'Title',
		bookmarksDone: 'Bookmarks saved.'
	},
	fr: {
		allTools: 'Tous les outils',
		modify: 'Modifier',
		convert: 'Convertir',
		sign: 'Signer électroniquement',
		searchPlaceholder: 'Rechercher du texte ou des outils',
		search: 'Rechercher',
		open: 'Ouvrir',
		openAnother: 'Ouvrir',
		exportNotes: 'Exporter les notes',
		exportEditedPdf: 'Exporter',
		saveDocument: 'Enregistrer',
		settings: 'Paramètres',
		closeTools: 'Fermer les outils',
		openPdf: 'Ouvrir un PDF',
		saveCopy: 'Enregistrer une copie',
		findText: 'Rechercher du texte',
		addComments: 'Ajouter des commentaires',
		modifyPdf: 'Modifier un PDF',
		exportPdf: 'Exporter un PDF',
		combineFiles: 'Combiner des fichiers',
		organizePages: 'Organiser les pages',
		fillSign: 'Remplir et signer',
		scanOcr: 'Scan et OCR',
		protectPdf: 'Protéger un PDF',
		redactPdf: 'Biffer un PDF',
		compressPdf: 'Compresser un PDF',
		deskewPdf: 'Redresser un scan',
		exportImage: 'Exporter la page en image',
		docProperties: 'Propriétés du document',
		recentFiles: 'Fichiers récents',
		prepareForm: 'Préparer un formulaire',
		convertToPdf: 'Convertir en PDF',
		addStamp: 'Ajouter un tampon',
		useCertificate: 'Utiliser un certificat',
		usePrepress: 'Utiliser le prépresse',
		measureObjects: 'Mesurer des objets',
		compareFiles: 'Comparer des fichiers',
		addMultimedia: 'Ajouter du contenu multimédia',
		sendComments: 'Envoyer pour commentaires',
		guidedActions: 'Utiliser des actions guidées',
		prepareAccessibility: "Préparer l'accessibilité",
		applyPdfStandards: 'Appliquer les normes PDF',
		addSearchIndex: 'Ajouter un index de recherche',
		useJavascript: 'Utiliser JavaScript',
		customTool: 'Créer un outil personnalisé',
		stylePdf: 'Styliser ce PDF',
		translatePdf: 'Traduire ce PDF',
		showMore: 'Afficher plus',
		showLess: 'Afficher moins',
		localOnly: 'Local uniquement',
		localOnlyDesc: 'Les PDF et les notes restent sur ce Mac.',
		noPdfOpen: 'Aucun PDF ouvert',
		dropPdf: 'Dépose un PDF n’importe où.',
		previous: 'Précédent',
		next: 'Suivant',
		fitWidth: 'Largeur page',
		emptyTitle: 'Ouvrir un PDF',
		emptyDesc: 'Dépose un fichier ici ou choisis-en un depuis ton ordinateur.',
		choosePdf: 'Choisir un PDF',
		notes: 'Notes',
		annotations: 'Annotations',
		notePlaceholder: 'Écris une note ou sélectionne un résultat...',
		highlight: 'Surligner',
		comment: 'Commenter',
		noAnnotations: 'Aucune annotation sur cette page.',
		pages: 'Pages',
		document: 'Document',
		noDocument: 'Aucun document',
		pageSummaryEmpty: 'Ouvre un PDF pour voir les contrôles de page.',
		scanBlocks: 'Scanner les blocs modifiables',
		ocrPage: 'OCR de la page',
		selectedText: 'Texte sélectionné',
		editTextPlaceholder: 'Sélectionne un bloc de texte détecté...',
		applyText: 'Appliquer',
		hideBlock: 'Masquer',
		nativeEditing: 'Édition native MVP',
		nativeEditingDesc: 'Les blocs détectés peuvent être modifiés et déplacés, puis exportés dans un PDF aplati.',
		defaultZoom: 'Zoom par défaut',
		defaultZoomDesc: 'Appliqué à l’ouverture sauf si la largeur page est activée.',
		language: 'Langue',
		languageDesc: 'Utilise automatiquement la langue du Mac ou force une langue.',
		fitWidthSetting: 'Ouvrir les documents en largeur page',
		fitWidthDesc: 'Rend les pages plus grandes et plus lisibles par défaut.',
		showTools: 'Afficher le panneau outils',
		showToolsDesc: 'Garder le panneau façon Acrobat visible à gauche.',
		showRail: 'Afficher la barre rapide',
		showRailDesc: 'Garder les actions rapides visibles à droite.',
		showNotes: 'Afficher les notes sur la page',
		showNotesDesc: 'Affiche les bulles d’annotation au-dessus du PDF.',
		highlightColor: 'Couleur de surlignage',
		highlightColorDesc: 'Couleur par défaut des nouveaux surlignages.',
		clearLocalNotes: 'Effacer les notes locales',
		done: 'Terminé',
		resultsEmpty: 'Les résultats apparaîtront ici.',
		pdfLoaded: 'PDF chargé localement.',
		openingPdf: 'Ouverture du PDF...',
		onlyPdf: 'Seuls les fichiers PDF sont pris en charge.',
		searching: 'Recherche...',
		noResults: 'Aucun résultat.',
		resultsFound: (count) => `${count} résultat(s) trouvé(s).`,
		annotationSaved: 'Annotation enregistrée localement.',
		textUpdated: 'Bloc de texte mis à jour.',
		blockHidden: 'Bloc masqué pour l’export modifié.',
		editEnabled: 'Mode modification activé.',
		editDisabled: 'Mode modification désactivé.',
		scanningBlocks: 'Scan des blocs de texte modifiables...',
		blocksDetected: (count) => `${count} bloc(s) de texte modifiable(s) détecté(s).`,
		ocrRunning: 'OCR local en cours...',
		ocrDetected: (count) => `${count} bloc(s) OCR détecté(s) localement.`,
		exportingEdited: 'Aplatissement du PDF modifié...',
		exportedEdited: 'PDF modifié exporté.',
		localNotesCleared: 'Notes locales effacées.',
		fileSaved: 'Fichier enregistré.',
		fontsWebGroup: 'Polices en ligne',
		fontsCatSans: 'En ligne · Sans-serif',
		fontsCatSerif: 'En ligne · Serif',
		fontsCatMono: 'En ligne · Monospace',
		fontsCatDisplay: 'En ligne · Display',
		fontsCatScript: 'En ligne · Manuscrites',
		fontsSystemGroup: 'Polices de cet ordinateur',
		createTab: '+ Créer',
		saveChangesTitle: 'Enregistrer les modifications ?',
		saveChangesMessage: 'Ce PDF contient des modifications non enregistrées.',
		saveChangesConfirm: 'Enregistrer',
		saveChangesDiscard: 'Ne pas enregistrer',
		saveChangesCancel: 'Annuler',
		untitledPdf: 'PDF sans titre',
		combineTitle: 'Combiner des fichiers PDF',
		combineHelp: 'Sélectionne plusieurs PDF à fusionner en un seul. Les pages garderont leur ordre.',
		combineCta: 'Choisir les fichiers',
		combineProcessing: 'Fusion des fichiers...',
		combineDone: 'PDF combinés.',
		combineNeedTwo: 'Sélectionne au moins deux PDF.',
		protectTitle: 'Protéger ce PDF',
		protectHelp: 'Définis un mot de passe (AES-256). Il sera demandé à l’ouverture.',
		protectPassword: 'Mot de passe',
		protectConfirm: 'Confirmer le mot de passe',
		protectCta: 'Protéger',
		protectMismatch: 'Les mots de passe ne correspondent pas.',
		protectEmpty: 'Saisis un mot de passe.',
		protectProcessing: 'Chiffrement du PDF...',
		protectDone: 'PDF protégé.',
		compressProcessing: 'Compression du PDF...',
		compressDone: (saved) => `PDF compressé (${saved} en moins).`,
		compressHelp: 'Ré-échantillonne et ré-encode les images du PDF. Une qualité élevée conserve plus de détail ; une qualité basse réduit davantage le poids.',
		compressQuality: 'Qualité',
		compressLow: 'Fichier léger (écran)',
		compressMedium: 'Équilibré',
		compressHigh: 'Haute qualité (impression)',
		deskewProcessing: 'Analyse et redressement du scan...',
		deskewDone: (pages) => `Scan redressé : ${pages}.`,
		deskewNone: 'Aucune inclinaison détectée dans ce document.',
		connectClaude: 'Connecter',
		connectClaudeDesc: 'Connecte Slate à Claude Desktop (serveur MCP local) pour que Claude modifie tes PDF lui-même.',
		connectClaudeDone: 'Claude Desktop connecté. Redémarre Claude Desktop pour voir les outils « alto-pdf ».',
		settingsTabGeneral: 'Général',
		settingsTabDisplay: 'Affichage',
		settingsTabIdentity: 'Identité',
		settingsTabAi: 'IA',
		settingsTabConnectors: 'Connecteurs',
		pageLayoutSetting: 'Mise en page',
		pageLayoutDesc: 'Défilement continu ou page par page.',
		pageLayoutContinuous: 'Continu',
		pageLayoutSingle: 'Page par page',
		identityNameLabel: 'Nom',
		identityNameDesc: 'Utilisé pour signer tes notes et commentaires.',
		identityEmailLabel: 'E-mail',
		identityEmailDesc: 'Associé à ton identité dans les documents.',
		aiProviderLabel: 'Fournisseur',
		aiProviderDesc: 'Le modèle qui assiste tes documents.',
		aiModelLabel: 'Modèle',
		aiModelDesc: 'Laisser vide pour le modèle recommandé.',
		aiKeyLabel: 'Clé API',
		aiKeyDesc: 'Stockée uniquement sur ce Mac.',
		aiBaseUrlLabel: 'URL locale',
		aiBaseUrlDesc: 'Pour un modèle local ou un endpoint compatible.',
		aiConfigSaved: 'Configuration IA enregistrée.',
		mcpClientsLabel: 'ChatGPT, Cursor et autres clients MCP',
		mcpClientsDesc: "Copie le chemin du serveur MCP de Slate pour le coller dans n'importe quel client compatible.",
		copyMcpPath: 'Copier le chemin',
		mcpPathCopied: 'Chemin du serveur MCP copié dans le presse-papiers.',
		smartGuides: "Guides d'alignement intelligents",
		smartGuidesDesc: "Affiche des lignes rouges quand un bloc s'aligne avec un autre pendant le drag.",
		rotateProcessing: 'Rotation de la page...',
		rotateDone: 'Page tournée.',
		deleteProcessing: 'Suppression de la page...',
		deleteDone: 'Page supprimée.',
		cancel: 'Annuler',
		needPdfOpen: 'Ouvre d’abord un PDF.',
		outlineTitle: 'Marque-pages',
		sign: 'Signer',
		signTitle: 'Remplir et signer',
		aiKicker: 'IA',
		aiTitle: 'Assistant IA',
		options: 'Options',
		apply: 'Appliquer',
		processing: 'Traitement…',
		position: 'Position',
		startAt: 'Commencer à',
		fontSize: 'Taille de police',
		margin: 'Marge (pt)',
		matchCase: 'Respecter la casse',
		posBottomCenter: 'Bas centre',
		posBottomRight: 'Bas droite',
		posBottomLeft: 'Bas gauche',
		posTopCenter: 'Haut centre',
		posTopRight: 'Haut droite',
		posTopLeft: 'Haut gauche',
		watermark: 'Ajouter un filigrane',
		watermarkHelp: 'Un filigrane en diagonale est ajouté sur chaque page.',
		watermarkText: 'Texte',
		watermarkSize: 'Taille',
		watermarkOpacity: 'Opacité',
		watermarkRotation: 'Rotation (°)',
		watermarkColor: 'Couleur',
		watermarkBold: 'Gras',
		watermarkEmpty: 'Saisis le texte du filigrane.',
		watermarkDone: 'Filigrane ajouté.',
		pageNumbers: 'Numéros de page',
		pageNumbersDone: 'Numéros de page ajoutés.',
		imagesToPdf: 'Images → PDF',
		imagesToPdfDone: 'PDF créé à partir des images.',
		cropPages: 'Rogner les pages',
		cropHelp: 'Marges (en points) retirées de chaque côté.',
		cropTop: 'Haut',
		cropRight: 'Droite',
		cropBottom: 'Bas',
		cropLeft: 'Gauche',
		cropDone: 'Pages rognées.',
		autoRedact: 'Caviardage auto',
		autoRedactHelp: 'Termes séparés par des virgules. Le texte trouvé est supprimé définitivement.',
		autoRedactTerms: 'Termes',
		autoRedactEmpty: 'Saisis au moins un terme.',
		autoRedactNone: 'Aucune occurrence trouvée.',
		autoRedactDone: (n) => `${n} zone(s) caviardée(s).`,
		redactCta: 'Caviarder',
		flatten: 'Aplatir',
		flattenDone: 'PDF aplati.',
		extractImages: 'Extraire les images',
		extractImagesDone: (n) => `${n} image(s) extraite(s).`,
		unlockPdf: 'Déverrouiller (retirer le mot de passe)',
		unlockHelp: 'Saisis le mot de passe actuel pour retirer la protection.',
		unlockCta: 'Déverrouiller',
		unlockEmpty: 'Saisis le mot de passe.',
		unlockDone: 'Mot de passe retiré.',
		sanitize: 'Nettoyer (sanitize)',
		sanitizeDone: 'Scripts et déclencheurs retirés.',
		repairPdf: 'Réparer le PDF',
		repairProcessing: 'Réparation du PDF...',
		repairDone: 'PDF réparé et reconstruit.',
		fillForms: 'Remplir les formulaires',
		formsTitle: 'Champs du formulaire',
		formsEmpty: 'Ce PDF ne contient pas de formulaire à remplir.',
		formsProcessing: 'Remplissage du formulaire...',
		formsDone: 'Formulaire rempli et enregistré.',
		removeAnnotations: 'Supprimer les annotations',
		removeAnnotationsDone: 'Annotations supprimées.',
		removeBlankPages: 'Supprimer les pages blanches',
		blankProcessing: 'Recherche des pages blanches...',
		blankNone: 'Aucune page blanche détectée.',
		blankDone: (count) => `${count} page${count > 1 ? 's' : ''} blanche${count > 1 ? 's' : ''} supprimée${count > 1 ? 's' : ''}.`,
		ocrSearchable: 'Rendre recherchable (OCR)',
		ocrLayerProcessing: 'OCR en cours, ajout du calque de texte recherchable...',
		ocrLayerDone: 'Calque de texte recherchable ajouté.',
		signPdf: 'Signer avec un certificat',
		signHelp: 'Appose une signature numérique PAdES invisible à partir de ton certificat PKCS#12 (.p12 / .pfx).',
		signPassword: 'Mot de passe du certificat',
		signReason: 'Motif (optionnel)',
		signLocation: 'Lieu (optionnel)',
		signCta: 'Signer',
		signProcessing: 'Signature du document...',
		signDone: 'Document signé (PAdES).',
		editBookmarks: 'Éditer les marque-pages',
		bookmarkTitle: 'Titre',
		bookmarksDone: 'Marque-pages enregistrés.'
	}
};

const iconNames = [
	'open',
	'save',
	'search',
	'comment',
	'edit',
	'export',
	'merge',
	'pages',
	'sign',
	'ocr',
	'lock',
	'redact',
	'compress',
	'form',
	'convert',
	'stamp',
	'certificate',
	'prepress',
	'measure',
	'compare',
	'media',
	'review',
	'actions',
	'accessibility',
	'standards',
	'index',
	'code',
	'custom',
	'style',
	'translate'
];

// IMPORTANT : doit correspondre 1:1 et dans l'ordre aux .rail-button du HTML.
// (search, notes, pages, marque-pages, ajuster, zoom+, zoom-, page unique, rotation, réglages)
const railIconNames = [
	'search',
	'comment',
	'pages',
	'bookmark',
	'fit',
	'plus',
	'minus',
	'singlePage',
	'rotate',
	'settings'
];

const icons = {
	open: '<path d="M12 5v14M5 12h14"/>',
	save: '<path d="M5 5h12l2 2v12H5z"/><path d="M8 5v6h8V5M8 19v-5h8v5"/>',
	search: '<circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/>',
	comment: '<path d="M5 6h14v10H9l-4 4z"/>',
	edit: '<path d="M4 20h4l11-11-4-4L4 16z"/><path d="m13 7 4 4"/>',
	export: '<path d="M12 4v12"/><path d="m7 9 5-5 5 5"/><path d="M5 20h14"/>',
	merge: '<path d="M7 4v7a5 5 0 0 0 5 5h5"/><path d="M17 12v4h-4"/><path d="M17 4v4a4 4 0 0 1-4 4H7"/>',
	pages: '<path d="M7 4h9l3 3v13H7z"/><path d="M16 4v4h4"/><path d="M4 8v12h3"/>',
	sign: '<path d="M4 17c4-6 5 5 8-1 2-4 4 0 8-3"/><path d="M15 5l4 4"/>',
	ocr: '<path d="M5 5h14v14H5z"/><path d="M8 12h8M12 8v8"/>',
	lock: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V8a4 4 0 0 1 8 0v2"/>',
	redact: '<path d="M4 7h16M4 12h16M4 17h10"/><path d="M15 15h5v5h-5z"/>',
	compress: '<path d="M8 4v6H4M16 20v-6h4M4 10l4-4M20 14l-4 4"/>',
	form: '<path d="M6 4h12v16H6z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
	convert: '<path d="M7 7h9l3 3v10H7z"/><path d="M16 7v4h4"/><path d="M4 4h9"/>',
	stamp: '<path d="M9 4h6v6l3 4v2H6v-2l3-4z"/><path d="M5 20h14"/>',
	certificate: '<path d="M6 4h12v12H6z"/><path d="m9 20 3-3 3 3"/><path d="M9 9h6"/>',
	prepress: '<path d="M4 6h16v12H4z"/><path d="M8 6v12M16 6v12M4 10h16M4 14h16"/>',
	measure: '<path d="m4 17 13-13 3 3L7 20z"/><path d="m8 13 2 2M11 10l2 2M14 7l2 2"/>',
	compare: '<path d="M7 4h9l3 3v11H7z"/><path d="M4 7h9l3 3v10H4z"/>',
	media: '<path d="M5 5h14v14H5z"/><path d="m10 9 5 3-5 3z"/>',
	review: '<path d="M5 6h14v9H8l-3 3z"/><path d="M9 10h6"/>',
	actions: '<path d="M12 4v16M4 12h16"/><path d="m8 8 4-4 4 4M8 16l4 4 4-4"/>',
	accessibility: '<circle cx="12" cy="5" r="2"/><path d="M5 10h14M12 10v10M8 20l4-6 4 6"/>',
	standards: '<path d="M6 4h12v16H6z"/><path d="m9 12 2 2 4-5"/>',
	index: '<path d="M5 5h14v14H5z"/><path d="M8 9h8M8 13h8M8 17h5"/>',
	clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
	code: '<path d="m9 8-4 4 4 4M15 8l4 4-4 4"/>',
	custom: '<path d="M12 3v5M12 16v5M4.8 7.2l3.5 3.5M15.7 15.7l3.5 3.5M3 12h5M16 12h5M4.8 16.8l3.5-3.5M15.7 8.3l3.5-3.5"/>',
	style: '<path d="M5 19c6 0 12-4 14-12-8 2-12 8-14 12z"/><path d="M12 12 5 19"/>',
	translate: '<path d="M4 5h9M8 5c0 5-2 8-5 10M6 10c2 3 4 5 7 6M14 20l4-10 4 10M16 16h4"/>',
	fit: '<path d="M5 9V5h4M15 5h4v4M19 15v4h-4M9 19H5v-4"/>',
	plus: '<path d="M12 5v14M5 12h14"/>',
	minus: '<path d="M5 12h14"/>',
	rotate: '<path d="M19 12a7 7 0 1 1-2-5"/><path d="M19 4v6h-6"/>',
	settings: '<path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"/><path d="M12 2v3M12 19v3M4.9 4.9 7 7M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1"/>',
	singlePage: '<path d="M8 4h7l3 3v13H8z"/><path d="M15 4v4h4"/><path d="M12 10v7"/><path d="m9.5 14.5 2.5 2.5 2.5-2.5"/><path d="M10 10h4"/>',
	watermark: '<path d="M12 3c3 4 5 6.5 5 9a5 5 0 0 1-10 0c0-2.5 2-5 5-9z"/>',
	number: '<path d="M5 5h14v14H5z"/><path d="M9 9h2v6M9 15h4"/>',
	image: '<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m5 17 4-4 3 3 3-3 4 4"/>',
	crop: '<path d="M7 2v15h15"/><path d="M2 7h15v15"/>',
	flatten: '<path d="M4 8h16M4 12h16M4 16h16"/><path d="M9 4l3 2 3-2"/>',
	unlock: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V8a4 4 0 0 1 7-2.5"/>',
	shield: '<path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z"/><path d="m9 12 2 2 4-4"/>',
	bookmark: '<path d="M7 4h10v16l-5-4-5 4z"/>'
};

function currentLocale() {
	if (state.settings.language && state.settings.language !== 'auto') return state.settings.language;
	return navigator.language?.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

function t(key, ...args) {
	const value = translations[currentLocale()][key] ?? translations.en[key] ?? key;
	return typeof value === 'function' ? value(...args) : value;
}

function setText(target, key) {
	const element = typeof target === 'string' ? document.querySelector(target) : target;
	if (element) element.textContent = t(key);
}

function setPlaceholder(target, key) {
	const element = typeof target === 'string' ? document.querySelector(target) : target;
	if (element) element.placeholder = t(key);
}

function svgIcon(name) {
	return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${icons[name] || icons.custom}</svg>`;
}

function applyIcon(element, name) {
	if (!element) return;
	element.innerHTML = svgIcon(name);
}

function localizeUi() {
	document.documentElement.lang = currentLocale();
	document.title = 'Slate';

	setText('.top-tabs [data-open-panel="tools"]', 'allTools');
	setText(elements.modifyTab, 'modify');
	setText('.top-tabs [data-tool-disabled*="Convert"]', 'convert');
	setText('#sign-tab', 'sign');
	setText(elements.createTabButton, 'createTab');
	for (const button of document.querySelectorAll('[data-tool-disabled]')) {
		button.disabled = true;
		button.title =
			currentLocale() === 'fr'
				? 'Cette fonction sera câblée dans une prochaine passe.'
				: button.dataset.toolDisabled;
	}
	setPlaceholder(elements.searchInput, 'searchPlaceholder');
	setText(elements.searchButton, 'search');
	setText(elements.exportAnnotations, 'exportNotes');
	setText(elements.exportEditedPdf, 'exportEditedPdf');
	setText('#save-button span', 'saveDocument');
	setText(elements.settingsButton, 'settings');
	setText('.panel-heading strong', 'allTools');
	document.querySelector('[data-close-panel]')?.setAttribute('aria-label', t('closeTools'));

	// Libellés par clé explicite (jamais par index : tout décalage de ligne
	// désynchroniserait les libellés de toute la liste).
	document.querySelectorAll('.tool-row[data-label-key]').forEach((row) => {
		const label = row.querySelector('span:last-child');
		if (label) label.textContent = t(row.dataset.labelKey);
	});

	setText(elements.toggleMoreTools, elements.moreTools.classList.contains('hidden') ? 'showMore' : 'showLess');
	setText('.panel-note strong', 'localOnly');
	setText('.panel-note span', 'localOnlyDesc');
	setText('.empty-card h1', 'emptyTitle');
	setText('.empty-card p', 'emptyDesc');
	setText(elements.drawerKicker, state.activeDrawer);
	const drawerTitleKeys = { search: 'findText', notes: 'annotations', pages: 'document', edit: 'modify' };
	setText(elements.drawerTitle, drawerTitleKeys[state.activeDrawer] || 'findText');
	setPlaceholder(elements.annotationText, 'notePlaceholder');
	setText(elements.highlightButton, 'highlight');
	setText(elements.commentButton, 'comment');
	setText(elements.scanEditBlocks, 'scanBlocks');
	setText(elements.ocrCurrentPage, 'ocrPage');
	setText('.edit-field span', 'selectedText');
	setText('.modifier-edit-field span', 'selectedText');
	setPlaceholder(elements.editText, 'editTextPlaceholder');
	setPlaceholder(elements.editTextPanel, 'editTextPlaceholder');
	setText(elements.applyEditText, 'applyText');
	setText(elements.deleteEditBlock, 'hideBlock');
	setText(elements.applyEditTextPanel, 'applyText');
	setText(elements.deleteEditBlockPanel, 'hideBlock');
	setText('.edit-help strong', 'nativeEditing');
	setText('.edit-help span', 'nativeEditingDesc');
	setText('#settings-title', 'settings');
	const settingTitles = [
		['defaultZoom', 'defaultZoomDesc'],
		['language', 'languageDesc'],
		['pageLayoutSetting', 'pageLayoutDesc'],
		['fitWidthSetting', 'fitWidthDesc'],
		['showTools', 'showToolsDesc'],
		['showRail', 'showRailDesc'],
		['showNotes', 'showNotesDesc'],
		['smartGuides', 'smartGuidesDesc'],
		['highlightColor', 'highlightColorDesc'],
		['identityNameLabel', 'identityNameDesc'],
		['identityEmailLabel', 'identityEmailDesc'],
		['aiProviderLabel', 'aiProviderDesc'],
		['aiModelLabel', 'aiModelDesc'],
		['aiKeyLabel', 'aiKeyDesc'],
		['aiBaseUrlLabel', 'aiBaseUrlDesc']
	];
	document.querySelectorAll('[data-settings-pane] .setting-row').forEach((row, index) => {
		const [titleKey, descKey] = settingTitles[index] || [];
		if (!titleKey) return;
		setText(row.querySelector('strong'), titleKey);
		setText(row.querySelector('small'), descKey);
	});
	setText(elements.settingsTabGeneral, 'settingsTabGeneral');
	setText(elements.settingsTabDisplay, 'settingsTabDisplay');
	setText(elements.settingsTabIdentity, 'settingsTabIdentity');
	setText(elements.settingsTabAi, 'settingsTabAi');
	setText(elements.settingsTabConnectors, 'settingsTabConnectors');
	if (elements.settingPageLayout) {
		const layoutOptions = elements.settingPageLayout.querySelectorAll('option');
		if (layoutOptions[0]) layoutOptions[0].textContent = t('pageLayoutContinuous');
		if (layoutOptions[1]) layoutOptions[1].textContent = t('pageLayoutSingle');
	}
	setText(elements.clearLocalData, 'clearLocalNotes');
	setText(elements.connectClaude, 'connectClaude');
	setText(elements.settingClaudeDesc, 'connectClaudeDesc');
	setText(elements.settingMcpLabel, 'mcpClientsLabel');
	setText(elements.settingMcpDesc, 'mcpClientsDesc');
	setText(elements.copyMcpPath, 'copyMcpPath');
	setText(elements.settingsDone, 'done');
	setText('#save-changes-title', 'saveChangesTitle');
	setText(elements.saveChangesMessage, 'saveChangesMessage');
	setText(elements.protectTitle, 'protectTitle');
	setText(elements.protectHelp, 'protectHelp');
	if (elements.protectConfirmButton) elements.protectConfirmButton.textContent = t('protectCta');
	if (elements.protectCancelButton) elements.protectCancelButton.textContent = t('cancel');
	if (elements.protectPasswordInput) elements.protectPasswordInput.placeholder = t('protectPassword');
	if (elements.protectConfirmInput) elements.protectConfirmInput.placeholder = t('protectConfirm');
	setText(elements.saveConfirmClose, 'saveChangesConfirm');
	setText(elements.saveDiscardClose, 'saveChangesDiscard');
	setText(elements.saveCancelClose, 'saveChangesCancel');
	renderTabs();
	updateUi();
}

function applyIcons() {
	let homeIndex = 0;
	document.querySelectorAll('.tool-icon').forEach((element) => {
		const explicit = element.dataset.icon;
		if (explicit) {
			applyIcon(element, explicit);
			return;
		}
		applyIcon(element, iconNames[homeIndex] || 'custom');
		homeIndex += 1;
	});
	document.querySelectorAll('.rail-button').forEach((element, index) => {
		applyIcon(element, railIconNames[index] || 'custom');
	});
}

function loadSettings() {
	try {
		const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
		const settings = { ...defaultSettings, ...parsed };
		if (parsed.settingsVersion !== defaultSettings.settingsVersion) {
			settings.defaultZoom = defaultSettings.defaultZoom;
			settings.fitWidth = defaultSettings.fitWidth;
			settings.settingsVersion = defaultSettings.settingsVersion;
		}
		return settings;
	} catch {
		return { ...defaultSettings };
	}
}

function saveSettings() {
	localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
}

function getInvoke() {
	return window.__TAURI__?.core?.invoke || window.__TAURI__?.tauri?.invoke || null;
}

async function invokeCommand(command, args) {
	const invoke = getInvoke();
	if (!invoke) {
		throw new Error('Native Tauri commands are unavailable in this window.');
	}
	return invoke(command, args);
}

// Pour les commandes qui renvoient des octets bruts (PDF, fichiers) : côté Rust
// elles utilisent `tauri::ipc::Response` -> le JS reçoit un ArrayBuffer (zéro JSON).
// On normalise toujours en Uint8Array pour que le code aval reste inchangé,
// que Tauri renvoie un ArrayBuffer, un Uint8Array, ou (au pire) un number[].
async function invokeBytes(command, args) {
	const out = await invokeCommand(command, args);
	if (out instanceof Uint8Array) return out;
	if (out instanceof ArrayBuffer) return new Uint8Array(out);
	if (ArrayBuffer.isView(out)) return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
	return new Uint8Array(out || []);
}

function setStatus(message, tone = 'info') {
	elements.status.textContent = message;
	elements.status.dataset.tone = tone;
	if (message) {
		window.clearTimeout(setStatus.timeout);
		setStatus.timeout = window.setTimeout(() => {
			elements.status.textContent = '';
		}, 3800);
	}
}

function bytesToMb(bytes) {
	return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function storageKey() {
	return state.fingerprint ? `alto-pdf-reader:${state.fingerprint}` : null;
}

function currentTab() {
	return state.tabs.find((tab) => tab.id === state.activeTabId) || null;
}

function snapshotActiveState() {
	return {
		fileName: state.fileName,
		fileBytes: state.fileBytes,
		pdf: state.pdf,
		fingerprint: state.fingerprint,
		page: state.page,
		zoom: state.zoom,
		pageSize: { ...state.pageSize },
		annotations: state.annotations.map((annotation) => ({ ...annotation })),
		search: {
			query: state.search.query,
			results: state.search.results.map((result) => ({ ...result })),
			activeIndex: state.search.activeIndex
		},
		editMode: state.editMode,
		editBlocks: state.editBlocks.map((block) => ({ ...block })),
		selectedBlockId: state.selectedBlockId,
		signaturePlacements: state.signaturePlacements.map((p) => ({ ...p })),
		activeDrawer: state.activeDrawer
	};
}

function persistCurrentTabState() {
	const tab = currentTab();
	if (!tab || !state.pdf) return;
	Object.assign(tab, snapshotActiveState());
	saveDocView(state.fingerprint, state.page, state.zoom);
}

// Dernière position de lecture par document, restaurée silencieusement à la
// réouverture (comportement Aperçu/Acrobat, sans réglage).
const DOC_VIEWS_KEY = 'alto-doc-views';
const DOC_VIEWS_MAX = 200;

function loadDocViews() {
	try {
		const parsed = JSON.parse(localStorage.getItem(DOC_VIEWS_KEY) || '{}');
		return parsed && typeof parsed === 'object' ? parsed : {};
	} catch {
		return {};
	}
}

function saveDocView(fingerprint, page, zoom) {
	if (!fingerprint) return;
	try {
		const views = loadDocViews();
		views[fingerprint] = { page, zoom, at: Date.now() };
		const keys = Object.keys(views);
		if (keys.length > DOC_VIEWS_MAX) {
			keys
				.sort((a, b) => (views[a].at || 0) - (views[b].at || 0))
				.slice(0, keys.length - DOC_VIEWS_MAX)
				.forEach((key) => delete views[key]);
		}
		localStorage.setItem(DOC_VIEWS_KEY, JSON.stringify(views));
	} catch {
		/* stockage indisponible */
	}
}

function getDocView(fingerprint) {
	if (!fingerprint) return null;
	const view = loadDocViews()[fingerprint];
	return view && Number.isFinite(view.page) ? view : null;
}

function createDocumentTab({ fileName, fileBytes, pdf, fingerprint, annotations }) {
	return {
		id: createId(),
		fileName,
		fileBytes,
		pdf,
		fingerprint,
		page: 1,
		zoom: state.settings.defaultZoom,
		pageSize: { width: 0, height: 0 },
		annotations,
		search: { query: '', results: [], activeIndex: -1 },
		editMode: false,
		editBlocks: [],
		selectedBlockId: null,
		signaturePlacements: [],
		undoStack: [],
		redoStack: [],
		activeDrawer: 'search',
		dirty: false
	};
}

function loadTabIntoState(tab) {
	state.fileName = tab.fileName;
	state.fileBytes = tab.fileBytes;
	state.pdf = tab.pdf;
	state.fingerprint = tab.fingerprint;
	state.page = tab.page;
	state.zoom = tab.zoom;
	state.fitMode = null;
	state.pageSize = { ...tab.pageSize };
	state.annotations = tab.annotations.map((annotation) => ({ ...annotation }));
	state.search = {
		query: tab.search.query,
		results: tab.search.results.map((result) => ({ ...result })),
		activeIndex: tab.search.activeIndex
	};
	state.editMode = tab.editMode;
	state.editBlocks = tab.editBlocks.map((block) => ({ ...block }));
	state.selectedBlockId = tab.selectedBlockId;
	state.signaturePlacements = (tab.signaturePlacements || []).map((p) => ({ ...p }));
	state.selectedSignatureId = null;
	if (!Array.isArray(tab.undoStack)) tab.undoStack = [];
	if (!Array.isArray(tab.redoStack)) tab.redoStack = [];
	state.activeDrawer = tab.activeDrawer;
	updateUndoRedoButtons();
	elements.app.classList.toggle('editing', state.editMode);
	elements.modifyTab.classList.toggle('active', state.editMode);
	elements.allToolsTab?.classList.toggle('active', !state.editMode);
	elements.modifyTool.classList.toggle('active', state.editMode);
}

function clearActiveDocumentState() {
	state.fileName = null;
	state.fileBytes = null;
	state.pdf = null;
	state.fingerprint = null;
	state.page = 1;
	state.zoom = state.settings.defaultZoom;
	state.pageSize = { width: 0, height: 0 };
	state.annotations = [];
	state.search = { query: '', results: [], activeIndex: -1 };
	state.editMode = false;
	state.editBlocks = [];
	state.selectedBlockId = null;
	state.selectedBlockIds = [];
	state.signaturePlacements = [];
	state.selectedSignatureId = null;
	state.activeDrawer = 'search';
	elements.app.classList.remove('editing');
	elements.modifyTab.classList.remove('active');
	elements.allToolsTab?.classList.add('active');
	elements.modifyTool.classList.remove('active');
	disposePagesStack();
}

function markDirty() {
	const tab = currentTab();
	if (!tab) return;
	tab.dirty = true;
	persistCurrentTabState();
	renderTabs();
}

function readSavedAnnotations() {
	const key = storageKey();
	if (!key) return [];
	try {
		const parsed = JSON.parse(localStorage.getItem(key) || '[]');
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function saveAnnotations() {
	const key = storageKey();
	if (!key) return;
	localStorage.setItem(key, JSON.stringify(state.annotations));
}

async function openFile(file) {
	if (!file.name.toLowerCase().endsWith('.pdf')) {
		setStatus(t('onlyPdf'), 'error');
		return;
	}

	const bytes = new Uint8Array(await file.arrayBuffer());
	await openPdfFromBytes(bytes, file.name);
	await rememberRecentFile('', file.name);
}

async function openPdfFromBytes(bytes, fileName, options = {}) {
	try {
		const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
		const loadingTask = pdfjsLib.getDocument(pdfDocumentOptions({ data }));
		const pdf = await loadingTask.promise;
		const fingerprint = Array.isArray(pdf.fingerprints) ? pdf.fingerprints.find(Boolean) : null;

		// Pas de doublon : si ce document (même contenu) est déjà ouvert, on active
		// l'onglet existant au lieu d'en créer un second. La déduplication est
		// désactivée pour les rechargements internes (rotation, désinclinaison,
		// réordonnancement, suppression de page) dont le contenu change.
		if (options.dedupe !== false && fingerprint) {
			const existing = state.tabs.find((candidate) => candidate.fingerprint === fingerprint);
			if (existing) {
				await activateTab(existing.id);
				setStatus('Ce document est déjà ouvert.');
				return;
			}
		}

		persistCurrentTabState();
		const safeName = fileName || 'document.pdf';
		const tab = createDocumentTab({
			fileName: safeName,
			fileBytes: data,
			pdf,
			fingerprint: fingerprint || `${safeName}-${data.length}-${Date.now()}`,
			annotations: []
		});
		state.tabs.push(tab);
		state.activeTabId = tab.id;
		loadTabIntoState(tab);
		state.annotations = readSavedAnnotations();
		tab.annotations = state.annotations.map((annotation) => ({ ...annotation }));
		// On restaure uniquement la page, jamais le zoom : le zoom d'ouverture
		// reste celui des réglages (100 % = 96 DPI), garant de la netteté.
		const savedView = getDocView(tab.fingerprint);
		if (savedView) {
			state.page = Math.min(Math.max(Math.round(savedView.page), 1), pdf.numPages);
			tab.page = state.page;
		}
		state.viewingHome = false;
		renderTabs();
		elements.createView.classList.add('hidden');
		elements.emptyState.classList.add('hidden');
		elements.pagesStack.classList.remove('hidden');
		updateHomeButtonState();
		if (state.settings.pageLayout === 'single') {
			await fitSinglePageToViewport(false);
		} else if (state.settings.fitWidth) {
			await fitPageWidth(false);
		}
		updateUi();
		await mountPagesStack();
		if (state.page > 1) {
			goToPage(state.page);
		}
		setTimeout(maybePromptDefaultApp, 600);
	} catch (error) {
		console.error(error);
		setStatus(error instanceof Error ? error.message : 'Failed to open PDF.', 'error');
	}
}

function renderTabs() {
	elements.tabList.innerHTML = '';
	for (const tab of state.tabs) {
		const tabButton = document.createElement('button');
		tabButton.type = 'button';
		const isActiveTab = tab.id === state.activeTabId && !state.viewingHome;
		tabButton.className = `document-tab ${isActiveTab ? 'active' : ''}`;
		tabButton.dataset.tabId = tab.id;
		tabButton.innerHTML = `
			<span class="document-tab-title">${escapeHtml(tab.fileName || t('untitledPdf'))}</span>
			${tab.dirty ? '<span class="document-tab-dirty" aria-label="Unsaved changes"></span>' : ''}
			<span class="document-tab-close" aria-label="Close tab">×</span>
		`;
		tabButton.addEventListener('click', () => {
			void activateTab(tab.id);
		});
		tabButton.querySelector('.document-tab-close')?.addEventListener('click', (event) => {
			event.stopPropagation();
			void requestCloseTab(tab.id);
		});
		tabButton.draggable = true;
		tabButton.addEventListener('dragstart', (event) => {
			tabButton.classList.add('dragging');
			if (event.dataTransfer) {
				event.dataTransfer.effectAllowed = 'move';
				event.dataTransfer.setData('text/plain', tab.id);
			}
		});
		tabButton.addEventListener('dragend', () => {
			tabButton.classList.remove('dragging');
			commitTabOrderFromDom();
		});
		elements.tabList.append(tabButton);
	}
	updateTabsScrollButtons();
	scrollActiveTabIntoView();
	updateHomeButtonState();
}

// Réordonne les onglets pendant le glissement (l'onglet suit la souris,
// comme dans Chrome), puis synchronise state.tabs à la dépose.
function initTabDragAndDrop() {
	elements.tabList.addEventListener('dragover', (event) => {
		const dragging = elements.tabList.querySelector('.document-tab.dragging');
		if (!dragging) return;
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
		const siblings = [...elements.tabList.querySelectorAll('.document-tab:not(.dragging)')];
		const next = siblings.find((sibling) => {
			const rect = sibling.getBoundingClientRect();
			return event.clientX < rect.left + rect.width / 2;
		});
		if (next) {
			if (next.previousElementSibling !== dragging) elements.tabList.insertBefore(dragging, next);
		} else if (elements.tabList.lastElementChild !== dragging) {
			elements.tabList.append(dragging);
		}
	});
	elements.tabList.addEventListener('drop', (event) => {
		if (elements.tabList.querySelector('.document-tab.dragging')) event.preventDefault();
	});
}

function commitTabOrderFromDom() {
	const orderedIds = [...elements.tabList.querySelectorAll('.document-tab')].map(
		(element) => element.dataset.tabId
	);
	if (orderedIds.length !== state.tabs.length) return;
	state.tabs.sort((a, b) => orderedIds.indexOf(a.id) - orderedIds.indexOf(b.id));
	updateTabsScrollButtons();
}

function updateTabsScrollButtons() {
	if (!elements.tabsViewport || !elements.tabsScrollLeft || !elements.tabsScrollRight) return;
	const viewport = elements.tabsViewport;
	const overflow = viewport.scrollWidth > viewport.clientWidth + 1;
	if (!overflow) {
		elements.tabsScrollLeft.classList.add('hidden');
		elements.tabsScrollRight.classList.add('hidden');
		return;
	}
	elements.tabsScrollLeft.classList.remove('hidden');
	elements.tabsScrollRight.classList.remove('hidden');
	elements.tabsScrollLeft.disabled = viewport.scrollLeft <= 0;
	elements.tabsScrollRight.disabled =
		viewport.scrollLeft + viewport.clientWidth >= viewport.scrollWidth - 1;
}

function scrollActiveTabIntoView() {
	if (!elements.tabsViewport) return;
	const active = elements.tabList.querySelector('.document-tab.active');
	if (!active) return;
	const viewport = elements.tabsViewport;
	const tabRect = active.getBoundingClientRect();
	const viewportRect = viewport.getBoundingClientRect();
	if (tabRect.left < viewportRect.left) {
		viewport.scrollBy({ left: tabRect.left - viewportRect.left - 12, behavior: 'smooth' });
	} else if (tabRect.right > viewportRect.right) {
		viewport.scrollBy({ left: tabRect.right - viewportRect.right + 12, behavior: 'smooth' });
	}
}

const SIGNATURES_KEY = 'alto-saved-signatures';
const SIGNATURE_FONTS = [
	{ label: 'Cursive', css: '"Snell Roundhand", "Apple Chancery", cursive' },
	{ label: 'Élégant', css: '"Zapfino", "Apple Chancery", cursive' },
	{ label: 'Manuscrit', css: '"Bradley Hand", "Segoe Script", cursive' }
];

const signElements = {};

function cacheSignElements() {
	signElements.signList = document.getElementById('sign-list');
	signElements.signCreate = document.getElementById('sign-create-button');
	signElements.modal = document.getElementById('signature-modal');
	signElements.backdrop = document.getElementById('signature-backdrop');
	signElements.close = document.getElementById('signature-close');
	signElements.cancel = document.getElementById('signature-cancel');
	signElements.save = document.getElementById('signature-save');
	signElements.tabs = Array.from(document.querySelectorAll('.signature-tab'));
	signElements.paneDraw = document.getElementById('sig-pane-draw');
	signElements.paneType = document.getElementById('sig-pane-type');
	signElements.paneImport = document.getElementById('sig-pane-import');
	signElements.canvas = document.getElementById('signature-canvas');
	signElements.color = document.getElementById('signature-color');
	signElements.clear = document.getElementById('signature-clear');
	signElements.typed = document.getElementById('signature-typed');
	signElements.fontRow = document.getElementById('signature-font-row');
	signElements.typedPreview = document.getElementById('signature-typed-preview');
	signElements.file = document.getElementById('signature-file');
	signElements.importPreview = document.getElementById('signature-import-preview');
}

let _signMode = 'draw';
let _signTypedFont = SIGNATURE_FONTS[0].css;
let _signImportDataUrl = null;
let _drawing = false;
let _drawHasInk = false;
let _drawLast = null;

function loadSavedSignatures() {
	try {
		const raw = localStorage.getItem(SIGNATURES_KEY);
		const items = raw ? JSON.parse(raw) : [];
		return Array.isArray(items) ? items : [];
	} catch (_err) {
		return [];
	}
}

function persistSavedSignatures(items) {
	try {
		localStorage.setItem(SIGNATURES_KEY, JSON.stringify(items.slice(0, 12)));
	} catch (_err) {
		/* noop */
	}
}

function renderSignaturesPanel() {
	if (!signElements.signList) return;
	const items = loadSavedSignatures();
	signElements.signList.innerHTML = '';
	if (!items.length) {
		const empty = document.createElement('p');
		empty.className = 'sign-empty';
		empty.textContent =
			currentLocale() === 'fr'
				? 'Aucune signature enregistrée.'
				: 'No saved signature yet.';
		signElements.signList.append(empty);
		return;
	}
	for (const sig of items) {
		const row = document.createElement('div');
		row.className = 'sign-item';
		if (state.pendingSignature?.id === sig.id) row.classList.add('armed');
		const img = document.createElement('img');
		img.src = sig.dataUrl;
		img.alt = 'signature';
		const useBtn = document.createElement('button');
		useBtn.type = 'button';
		useBtn.className = 'sign-item-use';
		useBtn.append(img);
		useBtn.addEventListener('click', () => armSignature(sig));
		const del = document.createElement('button');
		del.type = 'button';
		del.className = 'sign-item-delete';
		del.setAttribute('aria-label', 'Supprimer');
		del.textContent = '×';
		del.addEventListener('click', (event) => {
			event.stopPropagation();
			const next = loadSavedSignatures().filter((s) => s.id !== sig.id);
			persistSavedSignatures(next);
			if (state.pendingSignature?.id === sig.id) disarmSignature();
			renderSignaturesPanel();
		});
		row.append(useBtn, del);
		signElements.signList.append(row);
	}
}

function armSignature(sig) {
	state.pendingSignature = sig;
	document.body.classList.add('sign-arming');
	setStatus(
		currentLocale() === 'fr'
			? 'Clique sur la page pour poser ta signature.'
			: 'Click on the page to place your signature.'
	);
	renderSignaturesPanel();
}

function disarmSignature() {
	state.pendingSignature = null;
	document.body.classList.remove('sign-arming');
	renderSignaturesPanel();
}

function onPageClickForSignature(event) {
	if (!state.pendingSignature) return;
	const signLayer = event.currentTarget;
	const pageNumber = Number(signLayer.dataset.page);
	const rect = signLayer.getBoundingClientRect();
	const localX = event.clientX - rect.left;
	const localY = event.clientY - rect.top;
	const sig = state.pendingSignature;
	const targetW = Math.min(rect.width * 0.28, 220);
	const ratio = sig.height && sig.width ? sig.height / sig.width : 0.4;
	const wFrac = targetW / rect.width;
	const hFrac = (targetW * ratio) / rect.height;
	const placement = {
		id: `sig-${Date.now()}-${Math.random().toString(16).slice(2)}`,
		page: pageNumber,
		dataUrl: sig.dataUrl,
		ratio,
		xFrac: Math.max(0, Math.min(1 - wFrac, localX / rect.width - wFrac / 2)),
		yFrac: Math.max(0, Math.min(1 - hFrac, localY / rect.height - hFrac / 2)),
		wFrac,
		hFrac,
		rotation: 0
	};
	pushHistory();
	state.signaturePlacements.push(placement);
	persistSignaturePlacements();
	renderSignaturePlacementsForPage(pageNumber);
	disarmSignature();
	markDirty();
}

function persistSignaturePlacements() {
	const tab = currentTab();
	if (tab) tab.signaturePlacements = state.signaturePlacements.map((p) => ({ ...p }));
}

function renderSignaturePlacementsForPage(pageNumber) {
	const data = getPageData(pageNumber);
	if (!data || !data.signLayer) return;
	data.signLayer.innerHTML = '';
	const placements = state.signaturePlacements.filter((p) => p.page === pageNumber);
	const w = data.viewportWidth;
	const h = data.viewportHeight;
	for (const placement of placements) {
		const el = buildSignaturePlacementElement(placement, w, h);
		data.signLayer.append(el);
	}
}

function renderAllSignaturePlacements() {
	for (const data of state.pageElements.values()) {
		renderSignaturePlacementsForPage(data.pageNumber);
	}
}

function buildSignaturePlacementElement(placement, layerW, layerH) {
	const box = document.createElement('div');
	box.className = 'sign-placement';
	box.dataset.id = placement.id;
	const px = placement.xFrac * layerW;
	const py = placement.yFrac * layerH;
	const pw = placement.wFrac * layerW;
	const ph = placement.hFrac * layerH;
	box.style.left = `${px}px`;
	box.style.top = `${py}px`;
	box.style.width = `${pw}px`;
	box.style.height = `${ph}px`;
	box.style.transform = `rotate(${placement.rotation}deg)`;
	if (state.selectedSignatureId === placement.id) box.classList.add('selected');

	const img = document.createElement('img');
	img.src = placement.dataUrl;
	img.alt = 'signature';
	img.draggable = false;
	box.append(img);

	const rotateHandle = document.createElement('div');
	rotateHandle.className = 'sign-handle sign-rotate';
	const resizeHandle = document.createElement('div');
	resizeHandle.className = 'sign-handle sign-resize';
	const delHandle = document.createElement('div');
	delHandle.className = 'sign-handle sign-del';
	delHandle.textContent = '×';
	box.append(rotateHandle, resizeHandle, delHandle);

	box.addEventListener('pointerdown', (event) => {
		if (event.target === rotateHandle || event.target === resizeHandle || event.target === delHandle) {
			return;
		}
		event.preventDefault();
		selectSignature(placement.id);
		startSignatureDrag(event, placement, box);
	});
	rotateHandle.addEventListener('pointerdown', (event) => {
		event.preventDefault();
		event.stopPropagation();
		selectSignature(placement.id);
		startSignatureRotate(event, placement, box);
	});
	resizeHandle.addEventListener('pointerdown', (event) => {
		event.preventDefault();
		event.stopPropagation();
		selectSignature(placement.id);
		startSignatureResize(event, placement, box);
	});
	delHandle.addEventListener('pointerdown', (event) => {
		event.preventDefault();
		event.stopPropagation();
		pushHistory();
		state.signaturePlacements = state.signaturePlacements.filter((p) => p.id !== placement.id);
		persistSignaturePlacements();
		renderSignaturePlacementsForPage(placement.page);
		markDirty();
	});

	return box;
}

function selectSignature(id) {
	state.selectedSignatureId = id;
	for (const el of document.querySelectorAll('.sign-placement')) {
		el.classList.toggle('selected', el.dataset.id === id);
	}
}

function startSignatureDrag(event, placement, box) {
	const layer = box.parentElement;
	const rect = layer.getBoundingClientRect();
	const startX = event.clientX;
	const startY = event.clientY;
	const originX = placement.xFrac * rect.width;
	const originY = placement.yFrac * rect.height;
	const snap = captureEditableSnapshot();
	let changed = false;
	const move = (e) => {
		const nx = originX + (e.clientX - startX);
		const ny = originY + (e.clientY - startY);
		placement.xFrac = Math.max(0, Math.min(1 - placement.wFrac, nx / rect.width));
		placement.yFrac = Math.max(0, Math.min(1 - placement.hFrac, ny / rect.height));
		box.style.left = `${placement.xFrac * rect.width}px`;
		box.style.top = `${placement.yFrac * rect.height}px`;
		changed = true;
	};
	const up = () => {
		window.removeEventListener('pointermove', move);
		window.removeEventListener('pointerup', up);
		if (changed) {
			commitSnapshot(snap);
			persistSignaturePlacements();
			markDirty();
		}
	};
	window.addEventListener('pointermove', move);
	window.addEventListener('pointerup', up);
}

function startSignatureResize(event, placement, box) {
	const layer = box.parentElement;
	const rect = layer.getBoundingClientRect();
	const startX = event.clientX;
	const startW = placement.wFrac * rect.width;
	const snap = captureEditableSnapshot();
	let changed = false;
	const move = (e) => {
		const newW = Math.max(28, startW + (e.clientX - startX));
		const newH = newW * placement.ratio;
		placement.wFrac = Math.min(1 - placement.xFrac, newW / rect.width);
		placement.hFrac = Math.min(1 - placement.yFrac, newH / rect.height);
		box.style.width = `${placement.wFrac * rect.width}px`;
		box.style.height = `${placement.hFrac * rect.height}px`;
		changed = true;
	};
	const up = () => {
		window.removeEventListener('pointermove', move);
		window.removeEventListener('pointerup', up);
		if (changed) {
			commitSnapshot(snap);
			persistSignaturePlacements();
			markDirty();
		}
	};
	window.addEventListener('pointermove', move);
	window.addEventListener('pointerup', up);
}

function startSignatureRotate(event, placement, box) {
	const rect = box.getBoundingClientRect();
	const cx = rect.left + rect.width / 2;
	const cy = rect.top + rect.height / 2;
	const snap = captureEditableSnapshot();
	let changed = false;
	const move = (e) => {
		const angle = Math.atan2(e.clientY - cy, e.clientX - cx) * (180 / Math.PI) + 90;
		placement.rotation = Math.round(angle);
		box.style.transform = `rotate(${placement.rotation}deg)`;
		changed = true;
	};
	const up = () => {
		window.removeEventListener('pointermove', move);
		window.removeEventListener('pointerup', up);
		if (changed) {
			commitSnapshot(snap);
			persistSignaturePlacements();
			markDirty();
		}
	};
	window.addEventListener('pointermove', move);
	window.addEventListener('pointerup', up);
}

function openSignatureModal() {
	cacheSignElements();
	_signMode = 'draw';
	_signImportDataUrl = null;
	switchSignatureMode('draw');
	clearSignatureCanvas();
	if (signElements.typed) signElements.typed.value = '';
	if (signElements.typedPreview) signElements.typedPreview.innerHTML = '';
	if (signElements.importPreview) signElements.importPreview.innerHTML = '';
	if (signElements.file) signElements.file.value = '';
	signElements.backdrop?.classList.remove('hidden');
	signElements.modal?.classList.remove('hidden');
}

function closeSignatureModal() {
	signElements.backdrop?.classList.add('hidden');
	signElements.modal?.classList.add('hidden');
}

function switchSignatureMode(mode) {
	_signMode = mode;
	for (const tab of signElements.tabs) {
		tab.classList.toggle('active', tab.dataset.sigMode === mode);
	}
	signElements.paneDraw?.classList.toggle('hidden', mode !== 'draw');
	signElements.paneType?.classList.toggle('hidden', mode !== 'type');
	signElements.paneImport?.classList.toggle('hidden', mode !== 'import');
}

function clearSignatureCanvas() {
	const canvas = signElements.canvas;
	if (!canvas) return;
	const ctx = canvas.getContext('2d');
	ctx?.clearRect(0, 0, canvas.width, canvas.height);
	_drawHasInk = false;
}

function setupSignatureCanvasDrawing() {
	const canvas = signElements.canvas;
	if (!canvas) return;
	const ctx = canvas.getContext('2d');
	if (!ctx) return;
	const pos = (e) => {
		const rect = canvas.getBoundingClientRect();
		return {
			x: (e.clientX - rect.left) * (canvas.width / rect.width),
			y: (e.clientY - rect.top) * (canvas.height / rect.height)
		};
	};
	canvas.addEventListener('pointerdown', (e) => {
		_drawing = true;
		_drawLast = pos(e);
		canvas.setPointerCapture(e.pointerId);
	});
	canvas.addEventListener('pointermove', (e) => {
		if (!_drawing) return;
		const p = pos(e);
		ctx.strokeStyle = signElements.color?.value || '#0a3a8c';
		ctx.lineWidth = 2.6;
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		ctx.beginPath();
		ctx.moveTo(_drawLast.x, _drawLast.y);
		ctx.lineTo(p.x, p.y);
		ctx.stroke();
		_drawLast = p;
		_drawHasInk = true;
	});
	const stop = () => {
		_drawing = false;
		_drawLast = null;
	};
	canvas.addEventListener('pointerup', stop);
	canvas.addEventListener('pointerleave', stop);
}

function renderTypedPreview() {
	if (!signElements.typedPreview) return;
	signElements.typedPreview.style.fontFamily = _signTypedFont;
	signElements.typedPreview.textContent = signElements.typed?.value || '';
}

function trimCanvasToDataUrl(canvas) {
	const ctx = canvas.getContext('2d');
	if (!ctx) return null;
	const { width, height } = canvas;
	const data = ctx.getImageData(0, 0, width, height).data;
	let minX = width;
	let minY = height;
	let maxX = 0;
	let maxY = 0;
	let found = false;
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const alpha = data[(y * width + x) * 4 + 3];
			if (alpha > 10) {
				found = true;
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
			}
		}
	}
	if (!found) return null;
	const pad = 8;
	minX = Math.max(0, minX - pad);
	minY = Math.max(0, minY - pad);
	maxX = Math.min(width, maxX + pad);
	maxY = Math.min(height, maxY + pad);
	const cw = maxX - minX;
	const ch = maxY - minY;
	const out = document.createElement('canvas');
	out.width = cw;
	out.height = ch;
	const octx = out.getContext('2d');
	octx?.drawImage(canvas, minX, minY, cw, ch, 0, 0, cw, ch);
	return { dataUrl: out.toDataURL('image/png'), width: cw, height: ch };
}

function buildTypedSignature() {
	const text = (signElements.typed?.value || '').trim();
	if (!text) return null;
	const canvas = document.createElement('canvas');
	canvas.width = 900;
	canvas.height = 300;
	const ctx = canvas.getContext('2d');
	if (!ctx) return null;
	ctx.fillStyle = '#0a3a8c';
	ctx.font = `120px ${_signTypedFont}`;
	ctx.textBaseline = 'middle';
	ctx.fillText(text, 20, 150);
	return trimCanvasToDataUrl(canvas);
}

async function buildImportSignature() {
	if (!_signImportDataUrl) return null;
	return new Promise((resolve) => {
		const img = new Image();
		img.onload = () => {
			const canvas = document.createElement('canvas');
			canvas.width = img.naturalWidth;
			canvas.height = img.naturalHeight;
			const ctx = canvas.getContext('2d');
			ctx?.drawImage(img, 0, 0);
			resolve({ dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height });
		};
		img.onerror = () => resolve(null);
		img.src = _signImportDataUrl;
	});
}

async function saveSignatureFromModal() {
	let result = null;
	if (_signMode === 'draw') {
		if (!_drawHasInk) {
			setStatus(currentLocale() === 'fr' ? 'Dessine ta signature.' : 'Draw your signature.', 'error');
			return;
		}
		result = trimCanvasToDataUrl(signElements.canvas);
	} else if (_signMode === 'type') {
		result = buildTypedSignature();
	} else {
		result = await buildImportSignature();
	}
	if (!result) {
		setStatus(currentLocale() === 'fr' ? 'Signature vide.' : 'Empty signature.', 'error');
		return;
	}
	const items = loadSavedSignatures();
	items.unshift({
		id: `sg-${Date.now()}-${Math.random().toString(16).slice(2)}`,
		dataUrl: result.dataUrl,
		width: result.width,
		height: result.height
	});
	persistSavedSignatures(items);
	closeSignatureModal();
	renderSignaturesPanel();
	setStatus(currentLocale() === 'fr' ? 'Signature enregistrée.' : 'Signature saved.');
}

function setupSignFeature() {
	cacheSignElements();
	if (signElements.fontRow) {
		signElements.fontRow.innerHTML = '';
		for (const font of SIGNATURE_FONTS) {
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'signature-font-button';
			btn.textContent = font.label;
			btn.style.fontFamily = font.css;
			if (font.css === _signTypedFont) btn.classList.add('active');
			btn.addEventListener('click', () => {
				_signTypedFont = font.css;
				for (const el of signElements.fontRow.children) el.classList.remove('active');
				btn.classList.add('active');
				renderTypedPreview();
			});
			signElements.fontRow.append(btn);
		}
	}
	setupSignatureCanvasDrawing();
	signElements.signCreate?.addEventListener('click', openSignatureModal);
	signElements.close?.addEventListener('click', closeSignatureModal);
	signElements.cancel?.addEventListener('click', closeSignatureModal);
	signElements.backdrop?.addEventListener('click', closeSignatureModal);
	signElements.save?.addEventListener('click', () => void saveSignatureFromModal());
	signElements.clear?.addEventListener('click', clearSignatureCanvas);
	for (const tab of signElements.tabs) {
		tab.addEventListener('click', () => switchSignatureMode(tab.dataset.sigMode));
	}
	signElements.typed?.addEventListener('input', renderTypedPreview);
	signElements.file?.addEventListener('change', (event) => {
		const file = event.target.files?.[0];
		if (!file) return;
		const reader = new FileReader();
		reader.onload = () => {
			_signImportDataUrl = reader.result;
			if (signElements.importPreview) {
				signElements.importPreview.innerHTML = `<img src="${_signImportDataUrl}" alt="aperçu" />`;
			}
		};
		reader.readAsDataURL(file);
	});

	document.addEventListener('keydown', (event) => {
		if (event.key === 'Escape' && state.pendingSignature) {
			disarmSignature();
		}
		if (
			(event.key === 'Delete' || event.key === 'Backspace') &&
			state.selectedSignatureId &&
			document.activeElement === document.body
		) {
			const sel = state.signaturePlacements.find((p) => p.id === state.selectedSignatureId);
			if (sel) {
				pushHistory();
				state.signaturePlacements = state.signaturePlacements.filter((p) => p.id !== sel.id);
				persistSignaturePlacements();
				renderSignaturePlacementsForPage(sel.page);
				state.selectedSignatureId = null;
				markDirty();
			}
		}
	});
}

function bindSignatureLayerClicks() {
	for (const data of state.pageElements.values()) {
		if (data.signLayer && !data.signLayer._signBound) {
			data.signLayer.addEventListener('click', onPageClickForSignature);
			data.signLayer._signBound = true;
		}
	}
}

function captureEditableSnapshot() {
	return {
		signaturePlacements: state.signaturePlacements.map((p) => ({ ...p })),
		editBlocks: state.editBlocks.map((b) => ({ ...b })),
		page: state.page
	};
}

function commitSnapshot(snap) {
	const tab = currentTab();
	if (!tab || !snap) return;
	if (!Array.isArray(tab.undoStack)) tab.undoStack = [];
	tab.undoStack.push(snap);
	if (tab.undoStack.length > 50) tab.undoStack.shift();
	tab.redoStack = [];
	updateUndoRedoButtons();
}

function pushHistory() {
	commitSnapshot(captureEditableSnapshot());
}

function applyEditableSnapshot(snap) {
	if (!snap) return;
	state.signaturePlacements = snap.signaturePlacements.map((p) => ({ ...p }));
	state.editBlocks = snap.editBlocks.map((b) => ({ ...b }));
	state.selectedBlockId = null;
	state.selectedBlockIds = [];
	state.selectedSignatureId = null;
	persistSignaturePlacements();
	persistCurrentTabState();
	renderEditBlocks();
	renderAllSignaturePlacements();
	updateSelectedEditField();
	markDirty();
}

function undoEdit() {
	const tab = currentTab();
	if (!tab || !Array.isArray(tab.undoStack) || !tab.undoStack.length) return;
	if (!Array.isArray(tab.redoStack)) tab.redoStack = [];
	tab.redoStack.push(captureEditableSnapshot());
	applyEditableSnapshot(tab.undoStack.pop());
	updateUndoRedoButtons();
}

function redoEdit() {
	const tab = currentTab();
	if (!tab || !Array.isArray(tab.redoStack) || !tab.redoStack.length) return;
	if (!Array.isArray(tab.undoStack)) tab.undoStack = [];
	tab.undoStack.push(captureEditableSnapshot());
	applyEditableSnapshot(tab.redoStack.pop());
	updateUndoRedoButtons();
}

function updateUndoRedoButtons() {
	const tab = currentTab();
	const canUndo = Boolean(tab && Array.isArray(tab.undoStack) && tab.undoStack.length);
	const canRedo = Boolean(tab && Array.isArray(tab.redoStack) && tab.redoStack.length);
	if (elements.undoButton) elements.undoButton.disabled = !canUndo;
	if (elements.redoButton) elements.redoButton.disabled = !canRedo;
}

const DEFAULT_APP_PREF_KEY = 'alto-default-prompt';

async function maybePromptDefaultApp() {
	if (!window.__TAURI__) return;
	if (!elements.defaultAppModal || !elements.defaultAppBackdrop) return;

	let alreadyDefault = false;
	try {
		alreadyDefault = Boolean(await invokeCommand('is_default_pdf_handler'));
	} catch (_err) {
		alreadyDefault = false;
	}
	if (alreadyDefault) {
		setDefaultAppPref('done');
		return;
	}

	let pref = '';
	try {
		pref = localStorage.getItem(DEFAULT_APP_PREF_KEY) || '';
	} catch (_err) {
		pref = '';
	}
	if (pref === 'never') return;
	if (pref === 'done') {
		try {
			localStorage.removeItem(DEFAULT_APP_PREF_KEY);
		} catch (_err) {
			/* noop */
		}
	} else if (pref.startsWith('later:')) {
		const ts = Number(pref.slice(6));
		if (Number.isFinite(ts) && Date.now() - ts < 3 * 24 * 60 * 60 * 1000) return;
	}

	elements.defaultAppBackdrop.classList.remove('hidden');
	elements.defaultAppModal.classList.remove('hidden');
}

function closeDefaultAppModal() {
	elements.defaultAppBackdrop?.classList.add('hidden');
	elements.defaultAppModal?.classList.add('hidden');
}

function setDefaultAppPref(value) {
	try {
		localStorage.setItem(DEFAULT_APP_PREF_KEY, value);
	} catch (_err) {
		/* noop */
	}
}

const aiState = {
	config: { provider: 'claude', model: '', apiKey: '', baseUrl: '' },
	history: [],
	busy: false
};

const AI_DEFAULT_MODELS = {
	claude: 'claude-3-5-sonnet-latest',
	openai: 'gpt-4o-mini',
	local: 'llama3.1'
};

const aiElements = {};

function focusAiInput() {
	if (aiElements.input) requestAnimationFrame(() => aiElements.input.focus());
}

async function setupAiAssistant() {
	aiElements.provider = document.getElementById('ai-provider');
	aiElements.model = document.getElementById('ai-model');
	aiElements.key = document.getElementById('ai-key');
	aiElements.baseUrl = document.getElementById('ai-baseurl');
	aiElements.baseUrlField = document.getElementById('ai-baseurl-field');
	aiElements.saveButton = document.getElementById('ai-save-config');
	aiElements.configStatus = document.getElementById('ai-config-status');
	aiElements.settings = document.getElementById('ai-settings');
	aiElements.chat = document.getElementById('ai-chat');
	aiElements.form = document.getElementById('ai-form');
	aiElements.input = document.getElementById('ai-input');
	aiElements.send = document.getElementById('ai-send');

	if (!aiElements.form) return;

	try {
		const saved = await invokeCommand('llm_get_config');
		if (saved && saved.provider) {
			aiState.config = {
				provider: saved.provider || 'claude',
				model: saved.model || '',
				apiKey: saved.api_key || '',
				baseUrl: saved.base_url || ''
			};
		}
	} catch (_err) {
		/* config unavailable */
	}

	aiElements.provider.value = aiState.config.provider;
	aiElements.model.value = aiState.config.model || AI_DEFAULT_MODELS[aiState.config.provider] || '';
	aiElements.key.value = aiState.config.apiKey;
	aiElements.baseUrl.value = aiState.config.baseUrl;
	updateAiProviderUi();

	if (!aiState.config.apiKey && aiState.config.provider !== 'local') {
		aiElements.settings.open = true;
	}

	aiElements.provider.addEventListener('change', () => {
		const p = aiElements.provider.value;
		if (!aiElements.model.value || Object.values(AI_DEFAULT_MODELS).includes(aiElements.model.value)) {
			aiElements.model.value = AI_DEFAULT_MODELS[p] || '';
		}
		updateAiProviderUi();
	});

	aiElements.saveButton.addEventListener('click', async () => {
		aiState.config = {
			provider: aiElements.provider.value,
			model: aiElements.model.value.trim() || AI_DEFAULT_MODELS[aiElements.provider.value] || '',
			apiKey: aiElements.key.value.trim(),
			baseUrl: aiElements.baseUrl.value.trim()
		};
		try {
			await invokeCommand('llm_set_config', {
				config: {
					provider: aiState.config.provider,
					api_key: aiState.config.apiKey,
					model: aiState.config.model,
					base_url: aiState.config.baseUrl
				}
			});
			aiElements.configStatus.textContent = 'Connexion enregistrée.';
			aiElements.settings.open = false;
		} catch (error) {
			aiElements.configStatus.textContent = String(error);
		}
	});

	aiElements.form.addEventListener('submit', (event) => {
		event.preventDefault();
		const text = aiElements.input.value.trim();
		if (text) void sendAiMessage(text);
	});

	aiElements.input.addEventListener('keydown', (event) => {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			aiElements.form.requestSubmit();
		}
	});
}

function updateAiProviderUi() {
	const isLocal = aiElements.provider.value === 'local';
	aiElements.baseUrlField.style.display = isLocal || aiElements.provider.value === 'openai' ? 'flex' : 'none';
	aiElements.key.parentElement.style.display = isLocal ? 'none' : 'flex';
	if (isLocal && !aiElements.baseUrl.value) aiElements.baseUrl.placeholder = 'http://localhost:11434';
}

function appendAiBubble(role, text) {
	const msg = document.createElement('div');
	msg.className = `ai-msg ${role}`;
	const bubble = document.createElement('div');
	bubble.className = 'ai-bubble';
	bubble.textContent = text;
	msg.append(bubble);
	aiElements.chat.append(msg);
	aiElements.chat.scrollTop = aiElements.chat.scrollHeight;
	return msg;
}

async function buildAiSystemPrompt() {
	const lines = [
		"Tu es l'assistant intégré de Slate, un éditeur PDF. Tu réponds en français, de façon concise.",
		"Tu peux proposer des modifications du document. Pour cela, termine ta réponse par un bloc de code délimité ```alto-actions contenant un tableau JSON d'actions.",
		'Actions disponibles :',
		'- {"action":"replace_text","find":"texte exact actuel","replace":"nouveau texte","page":N}',
		'- {"action":"redact","find":"texte à masquer","page":N}',
		'- {"action":"rotate_page","page":N,"angle":90|180|-90}',
		'- {"action":"delete_page","page":N}',
		'- {"action":"goto_page","page":N}',
		"\"page\" est optionnel pour replace_text/redact (défaut: page courante). N'invente jamais un texte qui n'existe pas dans le document. Si aucune modification n'est demandée, ne mets pas de bloc d'actions."
	];
	if (state.pdf) {
		lines.push(`\nDocument : « ${state.fileName} », ${state.pdf.numPages} pages, page courante ${state.page}.`);
		try {
			const text = await extractPageText(state.page);
			if (text) lines.push(`Texte de la page ${state.page} :\n"""${text.slice(0, 4000)}"""`);
		} catch (_err) {
			/* noop */
		}
	} else {
		lines.push('\nAucun document ouvert actuellement.');
	}
	return lines.join('\n');
}

function parseAiActions(text) {
	const match = text.match(/```alto-actions\s*([\s\S]*?)```/);
	if (!match) return { clean: text, actions: [] };
	let actions = [];
	try {
		const parsed = JSON.parse(match[1].trim());
		actions = Array.isArray(parsed) ? parsed : [parsed];
	} catch (_err) {
		actions = [];
	}
	const clean = text.replace(match[0], '').trim();
	return { clean, actions };
}

async function sendAiMessage(text) {
	if (aiState.busy) return;
	if (aiState.config.provider !== 'local' && !aiState.config.apiKey) {
		appendAiBubble('system', 'Configure d’abord ta clé API dans « Connexion au modèle ».');
		aiElements.settings.open = true;
		return;
	}

	appendAiBubble('user', text);
	aiState.history.push({ role: 'user', content: text });
	aiElements.input.value = '';
	aiState.busy = true;
	aiElements.send.disabled = true;
	const typing = appendAiBubble('assistant', '…');
	typing.querySelector('.ai-bubble').classList.add('ai-typing');

	try {
		const system = await buildAiSystemPrompt();
		const reply = await invokeCommand('llm_chat', {
			provider: aiState.config.provider,
			baseUrl: aiState.config.baseUrl,
			apiKey: aiState.config.apiKey,
			model: aiState.config.model || AI_DEFAULT_MODELS[aiState.config.provider] || '',
			system,
			messages: aiState.history
		});
		typing.remove();
		const { clean, actions } = parseAiActions(reply || '');
		aiState.history.push({ role: 'assistant', content: reply || '' });
		if (clean) appendAiBubble('assistant', clean);
		if (actions.length) renderAiActionCards(actions);
	} catch (error) {
		typing.remove();
		appendAiBubble('system', String(error));
	} finally {
		aiState.busy = false;
		aiElements.send.disabled = false;
		focusAiInput();
	}
}

function describeAiAction(action) {
	switch (action.action) {
		case 'replace_text':
			return `Remplacer « ${action.find} » par « ${action.replace} »${action.page ? ` (page ${action.page})` : ''}`;
		case 'redact':
			return `Masquer « ${action.find} »${action.page ? ` (page ${action.page})` : ''}`;
		case 'rotate_page':
			return `Pivoter la page ${action.page} de ${action.angle}°`;
		case 'delete_page':
			return `Supprimer la page ${action.page}`;
		case 'goto_page':
			return `Aller à la page ${action.page}`;
		default:
			return `Action inconnue : ${action.action}`;
	}
}

function renderAiActionCards(actions) {
	const wrap = document.createElement('div');
	wrap.className = 'ai-msg assistant';
	const container = document.createElement('div');
	container.className = 'ai-actions';

	const cards = [];
	for (const action of actions) {
		const card = document.createElement('div');
		card.className = 'ai-action-card';
		const desc = document.createElement('div');
		desc.className = 'ai-action-desc';
		desc.textContent = describeAiAction(action);
		const buttons = document.createElement('div');
		buttons.className = 'ai-action-buttons';
		const apply = document.createElement('button');
		apply.type = 'button';
		apply.className = 'ai-apply-button';
		apply.textContent = 'Appliquer';
		const skip = document.createElement('button');
		skip.type = 'button';
		skip.className = 'ai-skip-button';
		skip.textContent = 'Ignorer';
		apply.addEventListener('click', async () => {
			apply.disabled = true;
			const ok = await applyAiAction(action);
			if (ok) {
				apply.classList.add('done');
				apply.textContent = 'Appliqué';
				skip.remove();
			} else {
				apply.disabled = false;
			}
		});
		skip.addEventListener('click', () => card.remove());
		buttons.append(apply, skip);
		card.append(desc, buttons);
		container.append(card);
		cards.push(apply);
	}

	if (actions.length > 1) {
		const all = document.createElement('button');
		all.type = 'button';
		all.className = 'ai-apply-all';
		all.textContent = 'Tout appliquer';
		all.addEventListener('click', () => {
			cards.forEach((btn) => {
				if (!btn.disabled) btn.click();
			});
			all.remove();
		});
		container.append(all);
	}

	wrap.append(container);
	aiElements.chat.append(wrap);
	aiElements.chat.scrollTop = aiElements.chat.scrollHeight;
}

async function ensureEditBlocksForPage(pageNumber) {
	if (pageNumber !== state.page) {
		goToPage(pageNumber);
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	if (!state.editMode) toggleEditMode(true);
	if (!state.editBlocks.some((block) => block.page === state.page)) {
		await scanEditableBlocks();
		if (!state.editBlocks.some((block) => block.page === state.page)) {
			await runOcrForCurrentPage(false);
		}
	}
}

function findAiBlock(find, pageNumber) {
	const needle = (find || '').trim().toLowerCase();
	if (!needle) return null;
	const candidates = state.editBlocks.filter((block) => block.page === pageNumber && !block.hidden);
	return (
		candidates.find((block) => (block.text || '').trim().toLowerCase() === needle) ||
		candidates.find((block) => (block.text || '').trim().toLowerCase().includes(needle)) ||
		null
	);
}

async function applyAiAction(action) {
	try {
		switch (action.action) {
			case 'goto_page': {
				goToPage(Number(action.page) || 1);
				return true;
			}
			case 'rotate_page': {
				goToPage(Number(action.page) || state.page);
				await new Promise((resolve) => setTimeout(resolve, 200));
				await handleRotateCurrentPage(Number(action.angle) || 90);
				return true;
			}
			case 'delete_page': {
				goToPage(Number(action.page) || state.page);
				await new Promise((resolve) => setTimeout(resolve, 200));
				await handleDeleteCurrentPage();
				return true;
			}
			case 'replace_text': {
				const page = Number(action.page) || state.page;
				await ensureEditBlocksForPage(page);
				const block = findAiBlock(action.find, state.page);
				if (!block) {
					appendAiBubble('system', `Texte « ${action.find} » introuvable sur la page ${state.page}.`);
					return false;
				}
				pushHistory();
				block.text = action.replace || '';
				block.textEdited = true;
				block.snapshotDataUrl = null;
				markDirty();
				renderEditBlocks();
				updateSelectedEditField();
				return true;
			}
			case 'redact': {
				const page = Number(action.page) || state.page;
				await ensureEditBlocksForPage(page);
				const block = findAiBlock(action.find, state.page);
				if (!block) {
					appendAiBubble('system', `Texte « ${action.find} » introuvable sur la page ${state.page}.`);
					return false;
				}
				pushHistory();
				block.hidden = true;
				markDirty();
				renderEditBlocks();
				return true;
			}
			default:
				appendAiBubble('system', `Action non supportée : ${action.action}`);
				return false;
		}
	} catch (error) {
		appendAiBubble('system', String(error));
		return false;
	}
}

const TOOLS_WIDTH_KEY = 'alto-tools-width';
const TOOLS_WIDTH_MIN = 220;
const TOOLS_WIDTH_MAX = 560;
const TOOLS_WIDTH_DEFAULT = 296;

function setupToolsResize() {
	let width = TOOLS_WIDTH_DEFAULT;
	try {
		const saved = parseInt(localStorage.getItem(TOOLS_WIDTH_KEY) || '', 10);
		if (Number.isFinite(saved)) width = Math.min(TOOLS_WIDTH_MAX, Math.max(TOOLS_WIDTH_MIN, saved));
	} catch (_err) {
		/* noop */
	}

	const handle = document.createElement('div');
	handle.className = 'tools-resize-handle';
	handle.setAttribute('role', 'separator');
	handle.setAttribute('aria-label', 'Redimensionner le panneau');
	document.body.append(handle);

	const apply = (value) => {
		width = Math.min(TOOLS_WIDTH_MAX, Math.max(TOOLS_WIDTH_MIN, value));
		document.documentElement.style.setProperty('--tools-width', `${width}px`);
		handle.style.left = `${width}px`;
	};
	apply(width);
	window.addEventListener('resize', () => {
		handle.style.left = `${width}px`;
	});

	handle.addEventListener('pointerdown', (event) => {
		event.preventDefault();
		handle.classList.add('dragging');
		handle.setPointerCapture(event.pointerId);
		const onMove = (moveEvent) => apply(moveEvent.clientX);
		const onUp = () => {
			handle.classList.remove('dragging');
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
			try {
				localStorage.setItem(TOOLS_WIDTH_KEY, String(Math.round(width)));
			} catch (_err) {
				/* noop */
			}
		};
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
	});

	handle.addEventListener('dblclick', () => {
		apply(TOOLS_WIDTH_DEFAULT);
		try {
			localStorage.setItem(TOOLS_WIDTH_KEY, String(TOOLS_WIDTH_DEFAULT));
		} catch (_err) {
			/* noop */
		}
	});
}

function setupDefaultAppPrompt() {
	elements.defaultAppYes?.addEventListener('click', async () => {
		try {
			await invokeCommand('set_default_pdf_handler');
			setDefaultAppPref('done');
			setStatus(
				currentLocale() === 'fr'
					? 'Slate est maintenant ton lecteur PDF par défaut.'
					: 'Slate is now your default PDF reader.'
			);
		} catch (error) {
			console.error(error);
			setStatus(error instanceof Error ? error.message : String(error), 'error');
		}
		closeDefaultAppModal();
	});
	elements.defaultAppLater?.addEventListener('click', () => {
		setDefaultAppPref(`later:${Date.now()}`);
		closeDefaultAppModal();
	});
	elements.defaultAppNever?.addEventListener('click', () => {
		setDefaultAppPref('never');
		closeDefaultAppModal();
	});
}

let _selectionOverlay = null;
let _selectionRafToken = 0;

function setupPreciseSelectionOverlay() {
	if (_selectionOverlay) return;
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.classList.add('precise-selection-overlay');
	svg.setAttribute('aria-hidden', 'true');
	document.body.append(svg);
	_selectionOverlay = svg;

	const queueUpdate = () => {
		if (_selectionRafToken) return;
		_selectionRafToken = requestAnimationFrame(() => {
			_selectionRafToken = 0;
			updatePreciseSelection();
		});
	};

	document.addEventListener('selectionchange', queueUpdate);
	window.addEventListener('scroll', queueUpdate, { passive: true, capture: true });
	window.addEventListener('resize', queueUpdate, { passive: true });
}

function updatePreciseSelection() {
	if (!_selectionOverlay) return;
	const selection = window.getSelection();
	_selectionOverlay.innerHTML = '';
	if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
		_selectionOverlay.style.display = 'none';
		return;
	}

	const fragments = [];
	for (let i = 0; i < selection.rangeCount; i += 1) {
		const range = selection.getRangeAt(i);
		if (range.collapsed) continue;
		if (!isRangeInsideTextLayer(range)) continue;
		const rects = range.getClientRects();
		for (const rect of rects) {
			if (rect.width <= 0 || rect.height <= 0) continue;
			fragments.push(rect);
		}
	}

	if (!fragments.length) {
		_selectionOverlay.style.display = 'none';
		return;
	}

	_selectionOverlay.style.display = 'block';
	const merged = mergePreciseSelectionRects(fragments);
	const ns = 'http://www.w3.org/2000/svg';
	for (const rect of merged) {
		const node = document.createElementNS(ns, 'rect');
		node.setAttribute('x', String(rect.left));
		node.setAttribute('y', String(rect.top));
		node.setAttribute('width', String(rect.width));
		node.setAttribute('height', String(rect.height));
		node.setAttribute('rx', '1.5');
		_selectionOverlay.append(node);
	}
}

function isRangeInsideTextLayer(range) {
	let node = range.commonAncestorContainer;
	if (node.nodeType !== 1) node = node.parentElement;
	while (node) {
		if (node.classList && node.classList.contains('textLayer')) return true;
		node = node.parentElement;
	}
	return false;
}

function mergePreciseSelectionRects(rects) {
	const sorted = rects
		.map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }))
		.sort((a, b) => a.top - b.top || a.left - b.left);

	const lines = [];
	for (const rect of sorted) {
		const line = lines.find((l) => Math.abs(l.midY - (rect.top + rect.bottom) / 2) < 4);
		if (line) {
			line.left = Math.min(line.left, rect.left);
			line.right = Math.max(line.right, rect.right);
			line.top = Math.min(line.top, rect.top);
			line.bottom = Math.max(line.bottom, rect.bottom);
			line.midY = (line.top + line.bottom) / 2;
		} else {
			lines.push({
				left: rect.left,
				right: rect.right,
				top: rect.top,
				bottom: rect.bottom,
				midY: (rect.top + rect.bottom) / 2
			});
		}
	}

	return lines.map((l) => ({
		left: l.left,
		top: l.top,
		width: l.right - l.left,
		height: l.bottom - l.top
	}));
}

function setupTabsScrolling() {
	if (!elements.tabsViewport) return;
	const viewport = elements.tabsViewport;
	const step = () => Math.max(180, viewport.clientWidth * 0.6);
	elements.tabsScrollLeft?.addEventListener('click', () => {
		viewport.scrollBy({ left: -step(), behavior: 'smooth' });
	});
	elements.tabsScrollRight?.addEventListener('click', () => {
		viewport.scrollBy({ left: step(), behavior: 'smooth' });
	});
	viewport.addEventListener('scroll', updateTabsScrollButtons, { passive: true });
	window.addEventListener('resize', updateTabsScrollButtons, { passive: true });
	viewport.addEventListener(
		'wheel',
		(event) => {
			if (event.deltaY !== 0 && Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
				viewport.scrollLeft += event.deltaY;
				event.preventDefault();
			}
		},
		{ passive: false }
	);
	initTabDragAndDrop();
}

async function activateTab(tabId) {
	const tab = state.tabs.find((candidate) => candidate.id === tabId);
	if (!tab) return;

	// La vue "Créer" est un calque affiché par-dessus le document : on la ferme
	// toujours avant de (ré)afficher un onglet, sinon cliquer sur l'onglet du
	// fichier ouvert laisse la fenêtre "Créer" visible.
	const createViewOpen = !elements.createView.classList.contains('hidden');
	if (createViewOpen) {
		elements.createView.classList.add('hidden');
	}

	// Déjà sur ce document et pas en accueil → ré-afficher la pile de pages
	// (utile quand on ne fait que fermer la vue "Créer" par-dessus).
	if (tabId === state.activeTabId && !state.viewingHome) {
		if (createViewOpen) {
			elements.emptyState.classList.add('hidden');
			elements.pagesStack.classList.remove('hidden');
			renderTabs();
			updateUi();
			updateHomeButtonState();
		}
		return;
	}

	// On revient d'un accueil affiché par-dessus le document déjà chargé : pas besoin
	// de tout recharger, on ré-affiche simplement la pile de pages.
	if (tabId === state.activeTabId && state.viewingHome) {
		state.viewingHome = false;
		elements.emptyState.classList.add('hidden');
		elements.pagesStack.classList.remove('hidden');
		renderTabs();
		updateUi();
		updateHomeButtonState();
		return;
	}

	persistCurrentTabState();
	state.viewingHome = false;
	state.activeTabId = tab.id;
	loadTabIntoState(tab);
	renderTabs();
	elements.emptyState.classList.add('hidden');
	elements.pagesStack.classList.remove('hidden');
	closeDrawer();
	updateUi();
	await mountPagesStack();
	updateHomeButtonState();
}

function getPageData(pageNumber) {
	return state.pageElements.get(pageNumber) || null;
}

function getActivePageData() {
	return getPageData(state.page);
}

function getActiveCanvas() {
	return getActivePageData()?.canvas || null;
}

function getActiveEditLayer() {
	return getActivePageData()?.editLayer || null;
}

function getEditLayerForPage(pageNumber) {
	return getPageData(pageNumber)?.editLayer || null;
}

function getActivePageSize() {
	const data = getActivePageData();
	if (!data) return { width: 0, height: 0 };
	return { width: data.viewportWidth, height: data.viewportHeight };
}

async function mountPagesStack() {
	disposePagesStack();
	if (!state.pdf) return;

	elements.pagesStack.classList.remove('hidden');
	const ratio = window.devicePixelRatio || 1;

	for (let pageNumber = 1; pageNumber <= state.pdf.numPages; pageNumber += 1) {
		const page = await state.pdf.getPage(pageNumber);
		const viewport = pageViewport(page);

		const wrapper = document.createElement('div');
		wrapper.className = 'page-wrapper';
		wrapper.dataset.page = String(pageNumber);
		wrapper.style.width = `${viewport.width}px`;
		wrapper.style.height = `${viewport.height}px`;

		const canvas = document.createElement('canvas');
		canvas.setAttribute('aria-label', `PDF page ${pageNumber}`);
		canvas.width = Math.floor(viewport.width * ratio);
		canvas.height = Math.floor(viewport.height * ratio);
		canvas.style.width = `${viewport.width}px`;
		canvas.style.height = `${viewport.height}px`;

		const textLayer = document.createElement('div');
		textLayer.className = 'textLayer';
		textLayer.tabIndex = 0;
		textLayer.style.width = `${viewport.width}px`;
		textLayer.style.height = `${viewport.height}px`;

		const editLayer = document.createElement('div');
		editLayer.className = 'edit-layer';
		editLayer.dataset.page = String(pageNumber);
		editLayer.style.width = `${viewport.width}px`;
		editLayer.style.height = `${viewport.height}px`;
		if (state.editMode) editLayer.classList.add('active');

		const overlay = document.createElement('div');
		overlay.className = 'page-notes-overlay';
		overlay.style.width = `${viewport.width}px`;
		overlay.style.height = `${viewport.height}px`;

		const signLayer = document.createElement('div');
		signLayer.className = 'sign-layer';
		signLayer.dataset.page = String(pageNumber);
		signLayer.style.width = `${viewport.width}px`;
		signLayer.style.height = `${viewport.height}px`;

		const mask = document.createElement('div');
		mask.className = 'render-mask';
		mask.textContent = '…';

		const badge = document.createElement('div');
		badge.className = 'page-badge';
		badge.textContent = String(pageNumber);

		wrapper.append(canvas, textLayer, editLayer, overlay, signLayer, mask, badge);
		elements.pagesStack.append(wrapper);

		state.pageElements.set(pageNumber, {
			pageNumber,
			wrapper,
			canvas,
			textLayer,
			editLayer,
			overlay,
			signLayer,
			mask,
			viewportWidth: viewport.width,
			viewportHeight: viewport.height,
			rendered: false,
			renderToken: 0
		});
	}

	setupPageObserver();
	renderEditBlocks();
	renderPageNotes();
	bindSignatureLayerClicks();
	renderAllSignaturePlacements();
	applyPageLayout();
	const initial = getActivePageData();
	if (initial) {
		initial.wrapper.scrollIntoView({ block: 'start', behavior: 'auto' });
	}
	requestAnimationFrame(() => detectActivePageFromScroll());
	void renderPagesAround(state.page, 1);
}

function disposePagesStack() {
	if (state.pageObserver) {
		state.pageObserver.disconnect();
		state.pageObserver = null;
	}
	for (const data of state.pageElements.values()) {
		if (data.textLayerInstance) {
			try {
				data.textLayerInstance.cancel();
			} catch (_err) {
				/* noop */
			}
			data.textLayerInstance = null;
		}
	}
	state.pageElements.clear();
	elements.pagesStack.innerHTML = '';
	elements.pagesStack.classList.add('hidden');
}

function setupPageObserver() {
	if (!state.pageElements.size) return;
	if (state.pageObserver) state.pageObserver.disconnect();

	const stage = elements.dropZone;
	const observer = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				const pageNumber = Number(entry.target.dataset.page);
				if (pageNumber && entry.isIntersecting) {
					void renderPage(pageNumber);
				}
			}
		},
		{
			root: stage,
			rootMargin: '600px 0px 600px 0px',
			threshold: 0
		}
	);

	for (const data of state.pageElements.values()) {
		observer.observe(data.wrapper);
	}
	state.pageObserver = observer;
}

function detectActivePageFromScroll() {
	if (!state.pageElements.size) return;
	if (state.settings.pageLayout === 'single') return;
	const stage = elements.dropZone;
	const stageRect = stage.getBoundingClientRect();
	const focusY = stageRect.top + stageRect.height / 2;

	let bestPage = state.page;
	let bestDistance = Infinity;
	for (const data of state.pageElements.values()) {
		const rect = data.wrapper.getBoundingClientRect();
		if (rect.bottom < stageRect.top || rect.top > stageRect.bottom) continue;
		const center = (rect.top + rect.bottom) / 2;
		const distance = Math.abs(center - focusY);
		if (distance < bestDistance) {
			bestDistance = distance;
			bestPage = data.pageNumber;
		}
	}
	if (bestPage !== state.page) {
		state.page = bestPage;
		highlightActivePage();
		persistCurrentTabState();
		updateUi(false);
	}
}

function highlightActivePage() {
	for (const data of state.pageElements.values()) {
		data.wrapper.classList.toggle('active', data.pageNumber === state.page);
	}
}

function applyPageLayout() {
	const layout = state.settings.pageLayout === 'single' ? 'single' : 'continuous';
	elements.pagesStack.classList.toggle('layout-single', layout === 'single');
	elements.pagesStack.classList.toggle('layout-continuous', layout === 'continuous');
	elements.railLayoutSingle.classList.toggle('active', layout === 'single');

	if (!state.pageElements.size) return;

	if (layout === 'single') {
		for (const data of state.pageElements.values()) {
			data.wrapper.style.display = data.pageNumber === state.page ? '' : 'none';
		}
		if (state.pageObserver) {
			state.pageObserver.disconnect();
			state.pageObserver = null;
		}
		void renderPage(state.page);
	} else {
		for (const data of state.pageElements.values()) {
			data.wrapper.style.display = '';
		}
		if (!state.pageObserver) setupPageObserver();
		void renderPagesAround(state.page, 1);
	}
}

async function toggleSinglePageLayout() {
	const next = state.settings.pageLayout === 'single' ? 'continuous' : 'single';
	state.settings.pageLayout = next;
	saveSettings();
	await transitionPageLayout();
}

async function transitionPageLayout() {
	state.settings.fitWidth = false;
	elements.settingFitWidth.checked = false;
	if (state.settings.pageLayout === 'single') {
		await fitSinglePageToViewport(false);
		await relayoutPagesStack();
	} else {
		state.zoom = 1;
		await relayoutPagesStack();
	}
	saveSettings();
	applyPageLayout();
	// Le zoom a pu changer (ajustement page unique) sans passer par updateUi :
	// on rafraîchit l'indicateur de pourcentage pour qu'il reflète le zoom réel.
	updateUi();
	const data = getActivePageData();
	if (data) {
		data.wrapper.scrollIntoView({ block: 'start', behavior: 'auto' });
	}
}

async function renderPagesAround(centerPage, radius = 1) {
	if (!state.pdf) return;
	const tasks = [];
	const start = Math.max(1, centerPage - radius);
	const end = Math.min(state.pdf.numPages, centerPage + radius);
	for (let i = start; i <= end; i += 1) {
		tasks.push(renderPage(i));
	}
	await Promise.all(tasks);
}

async function renderPage(pageNumber) {
	if (!state.pdf) return;
	const data = getPageData(pageNumber);
	if (!data || data.rendered) return;
	data.rendered = true;
	const token = ++data.renderToken;
	data.mask.classList.remove('hidden');

	try {
		const page = await state.pdf.getPage(pageNumber);
		if (token !== data.renderToken) return;

		const viewport = pageViewport(page);
		const ratio = Math.max(1, window.devicePixelRatio || 1);
		const cssWidth = Math.floor(viewport.width);
		const cssHeight = Math.floor(viewport.height);
		const pixelWidth = Math.floor(cssWidth * ratio);
		const pixelHeight = Math.floor(cssHeight * ratio);

		data.viewportWidth = cssWidth;
		data.viewportHeight = cssHeight;
		data.canvas.width = pixelWidth;
		data.canvas.height = pixelHeight;
		data.canvas.style.width = `${cssWidth}px`;
		data.canvas.style.height = `${cssHeight}px`;
		data.wrapper.style.width = `${cssWidth}px`;
		data.wrapper.style.height = `${cssHeight}px`;
		data.textLayer.style.width = `${cssWidth}px`;
		data.textLayer.style.height = `${cssHeight}px`;
		data.editLayer.style.width = `${cssWidth}px`;
		data.editLayer.style.height = `${cssHeight}px`;
		data.overlay.style.width = `${cssWidth}px`;
		data.overlay.style.height = `${cssHeight}px`;
		if (data.signLayer) {
			data.signLayer.style.width = `${cssWidth}px`;
			data.signLayer.style.height = `${cssHeight}px`;
		}

		const context = data.canvas.getContext('2d', { alpha: false });
		if (!context) throw new Error('Canvas context is unavailable.');
		context.imageSmoothingEnabled = false;
		context.fillStyle = '#ffffff';
		context.fillRect(0, 0, pixelWidth, pixelHeight);
		await page.render({
			canvasContext: context,
			viewport,
			transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null,
			renderForms: true
		}).promise;
		if (token !== data.renderToken) return;

		try {
			await renderOfficialTextLayer(page, viewport, data);
		} catch (textLayerError) {
			console.warn('Text layer rendering skipped.', textLayerError);
		}

		renderEditBlocksForPage(pageNumber);
		renderPageNotesForPage(pageNumber);
		renderSignaturePlacementsForPage(pageNumber);

		if (
			state.editMode &&
			pageNumber === state.page &&
			!state.editBlocks.some((block) => block.page === state.page)
		) {
			void autoDetectEditableContent();
		}
	} catch (error) {
		data.rendered = false;
		console.error(error);
	} finally {
		if (token === data.renderToken) {
			data.mask.classList.add('hidden');
		}
	}
}

async function renderCurrentPage() {
	if (!state.pdf) return;
	await renderPage(state.page);
}

function invalidateAllPages() {
	for (const data of state.pageElements.values()) {
		data.rendered = false;
		data.renderToken += 1;
	}
}

// Les blocs d'édition sont stockés en px viewport AU ZOOM où ils ont été détectés
// (avec pageWidth/pageHeight du viewport mémorisés). Quand le zoom change, on
// re-scale leurs coordonnées proportionnellement, sinon ils se retrouvent
// désalignés du texte affiché → impossibles à cliquer/modifier.
function rescaleEditBlocksForZoom() {
	if (!state.editBlocks.length) return;
	for (const block of state.editBlocks) {
		const data = getPageData(block.page);
		if (!data || !block.pageWidth || !block.pageHeight) continue;
		const rx = data.viewportWidth / block.pageWidth;
		const ry = data.viewportHeight / block.pageHeight;
		if (Math.abs(rx - 1) < 1e-4 && Math.abs(ry - 1) < 1e-4) continue;

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

		if (Array.isArray(block.pdfChars)) {
			for (const ch of block.pdfChars) {
				ch.x *= rx;
				ch.width *= rx;
				if (typeof ch.maskX === 'number') ch.maskX *= rx;
				if (typeof ch.maskWidth === 'number') ch.maskWidth *= rx;
				ch.y *= ry;
				ch.height *= ry;
				if (typeof ch.maskY === 'number') ch.maskY *= ry;
				if (typeof ch.maskHeight === 'number') ch.maskHeight *= ry;
			}
		}

		// Le snapshot bitmap a été capturé à l'ancienne échelle : on l'invalide.
		block.snapshotDataUrl = null;
		block.pageWidth = data.viewportWidth;
		block.pageHeight = data.viewportHeight;
	}
}

async function relayoutPagesStack() {
	if (!state.pdf || !state.pageElements.size) return;
	const ratio = window.devicePixelRatio || 1;
	for (const data of state.pageElements.values()) {
		const page = await state.pdf.getPage(data.pageNumber);
		const viewport = pageViewport(page);
		data.viewportWidth = viewport.width;
		data.viewportHeight = viewport.height;
		data.wrapper.style.width = `${viewport.width}px`;
		data.wrapper.style.height = `${viewport.height}px`;
		data.canvas.style.width = `${viewport.width}px`;
		data.canvas.style.height = `${viewport.height}px`;
		data.canvas.width = Math.floor(viewport.width * ratio);
		data.canvas.height = Math.floor(viewport.height * ratio);
		data.textLayer.style.width = `${viewport.width}px`;
		data.textLayer.style.height = `${viewport.height}px`;
		data.editLayer.style.width = `${viewport.width}px`;
		data.editLayer.style.height = `${viewport.height}px`;
		data.overlay.style.width = `${viewport.width}px`;
		data.overlay.style.height = `${viewport.height}px`;
		if (data.signLayer) {
			data.signLayer.style.width = `${viewport.width}px`;
			data.signLayer.style.height = `${viewport.height}px`;
		}
		data.rendered = false;
	}
	// Aligner les blocs d'édition sur le nouveau zoom AVANT de re-rendre les pages.
	rescaleEditBlocksForZoom();
	await renderPagesAround(state.page, 1);
}

async function fitPageWidth(shouldRender = true) {
	if (!state.pdf) return;
	const page = await state.pdf.getPage(state.page);
	const viewport = page.getViewport({ scale: 1 });
	const stageWidth = Math.max(360, elements.dropZone.clientWidth - 72);
	state.zoom = Math.max(0.7, Math.min(2.5, stageWidth / (viewport.width * CSS_UNITS)));
	if (shouldRender) {
		updateUi();
		await relayoutPagesStack();
	}
}

async function fitSinglePageToViewport(shouldRender = true) {
	if (!state.pdf) return;
	const page = await state.pdf.getPage(state.page);
	const viewport = page.getViewport({ scale: 1 });
	const stageWidth = Math.max(360, elements.dropZone.clientWidth - 72);
	const stageHeight = Math.max(360, elements.dropZone.clientHeight - 64);
	const fitWidthZoom = stageWidth / (viewport.width * CSS_UNITS);
	const fitHeightZoom = stageHeight / (viewport.height * CSS_UNITS);
	state.zoom = Math.max(0.35, Math.min(2.75, Math.min(fitWidthZoom, fitHeightZoom)));
	if (shouldRender) {
		updateUi();
		await relayoutPagesStack();
	}
}

async function safeGetTextContent(page) {
	try {
		return await page.getTextContent({ includeMarkedContent: false, disableNormalization: true });
	} catch (error) {
		console.warn('PDF.js getTextContent failed; returning empty text content.', error);
		return { items: [] };
	}
}

async function extractPageText(pageNumber) {
	const page = await state.pdf.getPage(pageNumber);
	const content = await safeGetTextContent(page);
	return content.items
		.map((item) => item.str || '')
		.join(' ')
		.replace(/\s+/g, ' ')
		.trim();
}

async function renderOfficialTextLayer(page, viewport, data) {
	const container = data.textLayer;
	if (!container) return;

	if (data.textLayerInstance) {
		try {
			data.textLayerInstance.cancel();
		} catch (_err) {
			/* noop */
		}
		data.textLayerInstance = null;
	}

	container.className = 'textLayer';
	container.innerHTML = '';
	container.style.width = `${viewport.width}px`;
	container.style.height = `${viewport.height}px`;

	if (typeof pdfjsLib.setLayerDimensions === 'function') {
		pdfjsLib.setLayerDimensions(container, viewport);
	} else {
		container.style.setProperty('--scale-factor', String(viewport.scale));
		container.style.setProperty('--total-scale-factor', String(viewport.scale));
	}

	if (!pdfjsLib.TextLayer) {
		console.warn('pdfjsLib.TextLayer indisponible — sélection de texte désactivée.');
		return;
	}

	const textContentSource =
		typeof page.streamTextContent === 'function'
			? page.streamTextContent({
					includeMarkedContent: true,
					disableNormalization: true
			  })
			: await page.getTextContent({
					includeMarkedContent: true,
					disableNormalization: true
			  });

	const textLayer = new pdfjsLib.TextLayer({
		textContentSource,
		container,
		viewport
	});
	data.textLayerInstance = textLayer;
	await textLayer.render();
	data.textDivs = textLayer.textDivs || [];

	if (!container.querySelector('.endOfContent')) {
		const endOfContent = document.createElement('div');
		endOfContent.className = 'endOfContent';
		container.append(endOfContent);
	}

	if (state.search.query) {
		applySearchHighlightsToPage(data.pageNumber);
	}
}

function clearSearchHighlightsOnPage(pageNumber) {
	const data = getPageData(pageNumber);
	if (!data || !Array.isArray(data.textDivs)) return;
	for (const div of data.textDivs) {
		if (!div) continue;
		const originalText = div.dataset.altoOriginalText;
		if (originalText !== undefined) {
			div.textContent = originalText;
			delete div.dataset.altoOriginalText;
		}
	}
}

function clearAllSearchHighlights() {
	for (const data of state.pageElements.values()) {
		clearSearchHighlightsOnPage(data.pageNumber);
	}
}

// Repli accent-insensible : chaque caractère est remplacé par sa base sans
// diacritique (é→e) en conservant la longueur, pour que les index restent alignés.
function foldSearchText(value) {
	let out = '';
	for (const ch of value) {
		if (ch.codePointAt(0) > 0xffff) {
			out += ch;
			continue;
		}
		const stripped = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
		const base = stripped.length === 1 ? stripped : ch;
		const lower = base.toLowerCase();
		out += lower.length === 1 ? lower : base;
	}
	return out.length === value.length ? out : value.toLowerCase();
}

function findFoldedMatches(text, needle) {
	const ranges = [];
	if (!needle) return ranges;
	const haystack = foldSearchText(text);
	const folded = foldSearchText(needle);
	let index = haystack.indexOf(folded);
	while (index !== -1) {
		ranges.push([index, index + folded.length]);
		index = haystack.indexOf(folded, index + folded.length);
	}
	return ranges;
}

function applySearchHighlightsToPage(pageNumber) {
	const query = state.search.query;
	if (!query) {
		clearSearchHighlightsOnPage(pageNumber);
		return;
	}
	const data = getPageData(pageNumber);
	if (!data || !Array.isArray(data.textDivs)) return;
	const needle = query.trim();
	if (!needle) {
		clearSearchHighlightsOnPage(pageNumber);
		return;
	}
	for (const div of data.textDivs) {
		if (!div) continue;
		const original = div.dataset.altoOriginalText ?? div.textContent ?? '';
		if (!original) continue;
		const matches = findFoldedMatches(original, needle);
		if (!matches.length) {
			if (div.dataset.altoOriginalText !== undefined) {
				div.textContent = original;
				delete div.dataset.altoOriginalText;
			}
			continue;
		}
		div.dataset.altoOriginalText = original;
		div.innerHTML = '';
		let cursor = 0;
		for (const [start, end] of matches) {
			if (start > cursor) {
				div.append(document.createTextNode(original.slice(cursor, start)));
			}
			const mark = document.createElement('mark');
			mark.className = 'alto-search-hit';
			mark.textContent = original.slice(start, end);
			div.append(mark);
			cursor = end;
		}
		if (cursor < original.length) {
			div.append(document.createTextNode(original.slice(cursor)));
		}
	}
	updateCurrentSearchMark();
}

function updateCurrentSearchMark() {
	document
		.querySelectorAll('.alto-search-hit.alto-search-hit-current')
		.forEach((el) => el.classList.remove('alto-search-hit-current'));
	const active = state.search.results[state.search.activeIndex];
	if (!active) return;
	const data = getPageData(active.page);
	if (!data) return;
	const hits = data.wrapper.querySelectorAll('.alto-search-hit');
	const target = hits[active.matchIndex];
	if (target) {
		target.classList.add('alto-search-hit-current');
		target.scrollIntoView({ block: 'center', behavior: 'smooth' });
	}
}

async function searchDocument(query) {
	const needle = query.trim();
	const results = [];
	if (!state.pdf || !needle) return results;

	for (let pageNumber = 1; pageNumber <= state.pdf.numPages; pageNumber += 1) {
		const text = await extractPageText(pageNumber);
		const matches = findFoldedMatches(text, needle);
		let matchIndex = 0;

		for (const [index, endIndex] of matches) {
			const start = Math.max(0, index - 72);
			const end = Math.min(text.length, endIndex + 96);
			results.push({
				id: `${pageNumber}-${matchIndex}-${index}`,
				page: pageNumber,
				matchIndex,
				text: text.slice(index, endIndex),
				snippet: text.slice(start, end).trim()
			});
			matchIndex += 1;
		}
	}

	return results;
}

function goToPage(pageNumber) {
	if (!state.pdf) return;
	const next = Math.min(Math.max(pageNumber, 1), state.pdf.numPages);
	if (next === state.page && state.pageElements.size && getPageData(next)) {
		const data = getPageData(next);
		data.wrapper.scrollIntoView({ block: 'start', behavior: 'auto' });
		return;
	}
	state.page = next;
	highlightActivePage();
	persistCurrentTabState();
	updateUi(false);
	const data = getPageData(next);
	if (!data) return;
	if (state.settings.pageLayout === 'single') {
		for (const item of state.pageElements.values()) {
			item.wrapper.style.display = item.pageNumber === next ? '' : 'none';
		}
		void (async () => {
			await fitSinglePageToViewport(false);
			await relayoutPagesStack();
			applyPageLayout();
			const active = getPageData(next);
			if (active) {
				active.wrapper.scrollIntoView({ block: 'start', behavior: 'auto' });
				elements.dropZone.scrollTo({ top: active.wrapper.offsetTop - 24, behavior: 'auto' });
			}
			updateUi(false);
		})();
	} else {
		void renderPagesAround(next, 1);
		data.wrapper.scrollIntoView({ block: 'start', behavior: 'smooth' });
	}
}

function goToResult(result, index) {
	state.search.activeIndex = index;
	elements.annotationText.value = result.text;
	openDrawer('search');
	goToPage(result.page);
	for (const data of state.pageElements.values()) {
		applySearchHighlightsToPage(data.pageNumber);
	}
	updateCurrentSearchMark();
	renderResults();
}

function createAnnotation(type) {
	if (!state.pdf) return;
	const active = state.search.results[state.search.activeIndex] || null;
	const text = elements.annotationText.value.trim() || active?.text || '';

	if (!text) {
		setStatus(t('notePlaceholder'), 'error');
		return;
	}

	const now = Date.now();
	state.annotations.unshift({
		id: createId(),
		page: state.page,
		type,
		text,
		author: (state.settings.identityName || '').trim(),
		color: type === 'highlight' ? state.settings.highlightColor : '#e5483f',
		createdAt: now,
		updatedAt: now
	});
	elements.annotationText.value = '';
	saveAnnotations();
	markDirty();
	renderPageNotes();
	renderNotes();
	updateUi();
	setStatus(t('annotationSaved'));
}

function deleteAnnotation(id) {
	state.annotations = state.annotations.filter((annotation) => annotation.id !== id);
	saveAnnotations();
	markDirty();
	renderPageNotes();
	renderNotes();
	updateUi();
}

function renderPageNotes() {
	for (const data of state.pageElements.values()) {
		renderPageNotesForPage(data.pageNumber);
	}
}

function renderPageNotesForPage(pageNumber) {
	const data = getPageData(pageNumber);
	if (!data) return;
	data.overlay.innerHTML = '';
	if (!state.settings.showPageNotes) return;
	const notesForPage = state.annotations.filter((annotation) => annotation.page === pageNumber);
	notesForPage.forEach((annotation, index) => {
		const chip = document.createElement('div');
		chip.className = 'note-chip';
		chip.style.top = `${24 + index * 58}px`;
		chip.style.setProperty('--note-color', annotation.color);
		const chipMeta = annotation.author
			? `${annotation.type} · ${escapeHtml(annotation.author)}`
			: annotation.type;
		chip.innerHTML = `<small>${chipMeta}</small>${escapeHtml(annotation.text)}`;
		data.overlay.append(chip);
	});
}

function renderResults() {
	elements.results.innerHTML = '';

	if (!state.search.results.length) {
		elements.results.innerHTML = `<div class="note-card">${escapeHtml(t('resultsEmpty'))}</div>`;
		return;
	}

	state.search.results.forEach((result, index) => {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = `result-button ${index === state.search.activeIndex ? 'active' : ''}`;
		button.innerHTML = `<strong>Page ${result.page}</strong>${escapeHtml(result.snippet)}`;
		button.addEventListener('click', () => goToResult(result, index));
		elements.results.append(button);
	});
}

function renderNotes() {
	elements.notes.innerHTML = '';
	const currentNotes = state.annotations.filter((annotation) => annotation.page === state.page);

	if (!currentNotes.length) {
		elements.notes.innerHTML = `<div class="note-card">${escapeHtml(t('noAnnotations'))}</div>`;
		return;
	}

	currentNotes.forEach((annotation) => {
		const card = document.createElement('div');
		card.className = 'note-card';
		card.innerHTML = `
			<button class="delete-note" type="button" data-id="${annotation.id}">Delete</button>
			<strong>${annotation.type} · Page ${annotation.page}${annotation.author ? ` · ${escapeHtml(annotation.author)}` : ''}</strong>
			${escapeHtml(annotation.text)}
		`;
		card.querySelector('button')?.addEventListener('click', () => deleteAnnotation(annotation.id));
		elements.notes.append(card);
	});
}

async function scanEditableBlocks() {
	if (!state.pdf || !state.fileBytes) return;

	const page = await state.pdf.getPage(state.page);
	const viewport = pageViewport(page);
	let blocks = await pdfiumEditBlocks(viewport);

	if (!blocks.length) {
		blocks = await pdfJsEditBlocks(page, viewport);
	}

	detectBoldByInkDensity(blocks);
	// Polices décoratives / logos (gros corps) : les bounds PDFium sous-estiment
	// l'encre réelle (débords italiques, empattements). On élargit le bloc à
	// l'encre mesurée pour que la sélection ET le bitmap couvrent tout le logo.
	const inkData = getActivePageData() || getPageData(state.page);
	for (const block of blocks) {
		if (block.kind !== 'image' && (block.pdfFontSize || 0) >= 22) {
			expandBlockToInk(block, inkData);
		}
	}
	state.editBlocks = state.editBlocks.filter((block) => block.page !== state.page).concat(blocks);
	state.selectedBlockId = null;
	state.selectedBlockIds = [];
	renderEditBlocks();
	updateSelectedEditField();
	return blocks.length;
}

function measureBlockInkRatio(block, data) {
	const canvas = data && data.canvas;
	if (!canvas || !canvas.width || !data.viewportWidth || !data.viewportHeight) return null;
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	if (!ctx) return null;
	const sx = canvas.width / data.viewportWidth;
	const sy = canvas.height / data.viewportHeight;
	const px = Math.max(0, Math.round(block.originalX * sx));
	const py = Math.max(0, Math.round(block.originalY * sy));
	const pw = Math.min(canvas.width - px, Math.round(block.width * sx));
	const ph = Math.min(canvas.height - py, Math.round(block.height * sy));
	if (pw < 2 || ph < 2) return null;
	let imageData;
	try {
		imageData = ctx.getImageData(px, py, pw, ph).data;
	} catch (_err) {
		return null;
	}
	let dark = 0;
	const total = pw * ph;
	for (let i = 0; i < imageData.length; i += 4) {
		const lum = 0.299 * imageData[i] + 0.587 * imageData[i + 1] + 0.114 * imageData[i + 2];
		if (lum < 140) dark += 1;
	}
	return dark / total;
}

// Élargit un bloc à la boîte englobante de l'encre réelle mesurée sur le canvas
// rendu, dans une fenêtre bornée autour du bloc. Ne fait QUE grandir (union avec
// les bounds PDFium d'origine) pour ne jamais rogner. Réservé aux gros blocs
// (logos/titres) afin de ne pas fusionner des lignes de corps de texte voisines.
function expandBlockToInk(block, data) {
	const canvas = data && data.canvas;
	if (!canvas || !canvas.width || !data.viewportWidth || !data.viewportHeight) return;
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	if (!ctx) return;
	const sx = canvas.width / data.viewportWidth;
	const sy = canvas.height / data.viewportHeight;
	// Marge de recherche bornée : on cherche l'encre un peu au-delà des bounds.
	const mx = Math.min(Math.max(block.width * 0.3, 4), 24);
	const my = Math.min(Math.max(block.height * 0.5, 4), 24);
	const wx0 = Math.max(0, Math.floor((block.originalX - mx) * sx));
	const wy0 = Math.max(0, Math.floor((block.originalY - my) * sy));
	const wx1 = Math.min(canvas.width, Math.ceil((block.originalX + block.width + mx) * sx));
	const wy1 = Math.min(canvas.height, Math.ceil((block.originalY + block.height + my) * sy));
	const ww = wx1 - wx0;
	const wh = wy1 - wy0;
	if (ww < 2 || wh < 2) return;
	let img;
	try {
		img = ctx.getImageData(wx0, wy0, ww, wh).data;
	} catch (_err) {
		return;
	}
	let minX = ww;
	let minY = wh;
	let maxX = -1;
	let maxY = -1;
	for (let py = 0; py < wh; py += 1) {
		for (let px = 0; px < ww; px += 1) {
			const i = (py * ww + px) * 4;
			const lum = 0.299 * img[i] + 0.587 * img[i + 1] + 0.114 * img[i + 2];
			if (lum < 150) {
				if (px < minX) minX = px;
				if (px > maxX) maxX = px;
				if (py < minY) minY = py;
				if (py > maxY) maxY = py;
			}
		}
	}
	if (maxX < minX || maxY < minY) return;
	const inkLeft = (wx0 + minX) / sx;
	const inkTop = (wy0 + minY) / sy;
	const inkRight = (wx0 + maxX + 1) / sx;
	const inkBottom = (wy0 + maxY + 1) / sy;
	// Union encre ∪ bounds PDFium : on n'agrandit jamais en dessous de l'existant.
	const left = Math.min(block.originalX, inkLeft);
	const top = Math.min(block.originalY, inkTop);
	const right = Math.max(block.originalX + block.width, inkRight);
	const bottom = Math.max(block.originalY + block.height, inkBottom);
	const dx = left - block.originalX;
	const dy = top - block.originalY;
	block.originalX = left;
	block.originalY = top;
	block.x += dx;
	block.y += dy;
	block.width = right - left;
	block.height = bottom - top;
	block.originalWidth = block.width;
	block.originalHeight = block.height;
	block.snapshotDataUrl = null;
}

function detectBoldByInkDensity(blocks) {
	const data = getActivePageData() || getPageData(state.page);

	const textBlocks = blocks.filter((b) => b.kind !== 'image' && b.text && b.width > 4 && b.height > 4);
	const measures = [];
	for (const block of textBlocks) {
		const ink = measureBlockInkRatio(block, data);
		block._ink = ink;
		if (ink != null) measures.push(ink);
	}
	if (measures.length < 2) {
		for (const block of textBlocks) delete block._ink;
		return;
	}
	measures.sort((a, b) => a - b);
	const median = measures[Math.floor(measures.length / 2)];
	for (const block of textBlocks) {
		if (block._ink != null && median > 0 && block._ink >= median * 1.45) {
			block.bold = true;
		}
		delete block._ink;
	}
}

// Identifiant stable du document courant (pour le cache d'octets côté Rust).
function currentDocId() {
	return state.fingerprint || state.fileName || 'doc';
}

// Analyse de page via le cache Rust : on n'envoie les octets du PDF (gros payload
// JSON) qu'UNE fois par document. Les scans suivants ne transmettent que l'id.
async function analyzePageCached(page) {
	const id = currentDocId();
	try {
		return await invokeCommand('analyze_pdf_page_cached', { id, page });
	} catch (error) {
		if (String(error).includes('cache_miss')) {
			await invokeCommand('cache_document', { id, bytes: Array.from(state.fileBytes) });
			return await invokeCommand('analyze_pdf_page_cached', { id, page });
		}
		throw error;
	}
}

async function pdfiumEditBlocks(viewport) {
	try {
		const analysis = await analyzePageCached(state.page);
		const pageWidth = analysis?.pageWidth || viewport.width / state.zoom;
		const pageHeight = analysis?.pageHeight || viewport.height / state.zoom;
		const scaleX = viewport.width / pageWidth;
		const scaleY = viewport.height / pageHeight;
		return (Array.isArray(analysis?.blocks) ? analysis.blocks : [])
			.map((block, index) => {
				const x = block.x * scaleX;
				const y = block.y * scaleY;
				const width = block.width * scaleX;
				const height = block.height * scaleY;
				const pdfFontSize = block.fontSize > 0 ? block.fontSize * scaleY : 0;
				const pdfChars = Array.isArray(block.chars)
					? block.chars.map((ch, charIndex) => ({
						index: charIndex,
						text: ch.text || '',
						x: (ch.x || 0) * scaleX,
						y: (ch.y || 0) * scaleY,
						width: Math.max(0.5, (ch.width || 0) * scaleX),
						height: Math.max(0.5, (ch.height || 0) * scaleY),
						maskX: (ch.maskX ?? ch.x ?? 0) * scaleX,
						maskY: (ch.maskY ?? ch.y ?? 0) * scaleY,
						maskWidth: Math.max(0.5, (ch.maskWidth ?? ch.width ?? 0) * scaleX),
						maskHeight: Math.max(0.5, (ch.maskHeight ?? ch.height ?? 0) * scaleY)
					}))
					: [];
				return {
					id: block.id || `pdfium-${state.page}-${index}`,
					kind: block.kind || 'text',
					page: state.page,
					text: block.text || (block.kind === 'image' ? 'Image' : ''),
					originalText: block.text || '',
					x,
					y,
					originalX: x,
					originalY: y,
					width,
					height,
					originalWidth: width,
					originalHeight: height,
					pdfFontSize,
					baseFontSize: pdfFontSize > 0 ? pdfFontSize : undefined,
					pageWidth: viewport.width,
					pageHeight: viewport.height,
					hidden: false,
					bold: Boolean(block.bold),
					italic: Boolean(block.italic),
					serif: Boolean(block.serif),
					justified: Boolean(block.justified),
					pdfChars,
					fontName: block.fontName || '',
					source: analysis?.engine || 'pdfium'
				};
			})
			.filter((block) => block.width > 2 && block.height > 2 && (block.text || block.kind !== 'text'));
	} catch (error) {
		console.warn('PDFium analysis failed; using PDF.js text geometry.', error);
		return [];
	}
}

async function pdfJsEditBlocks(page, viewport) {
	return (await safeGetTextContent(page)).items
		.map((item, index) => {
			const transform = multiplyPdfTransform(viewport.transform, item.transform);
			const text = (item.str || '').trim();
			const width = Math.max(8, (item.width || text.length * 6) * state.zoom * CSS_UNITS);
			const height = Math.max(10, Math.hypot(transform[2], transform[3]) || 14);
			const x = transform[4];
			const y = transform[5] - height;
			return {
				id: `text-${state.page}-${index}`,
				kind: 'text',
				page: state.page,
				text,
				originalText: text,
				x,
				y,
				originalX: x,
				originalY: y,
				width,
				height,
				originalWidth: width,
				originalHeight: height,
				pageWidth: viewport.width,
				pageHeight: viewport.height,
				hidden: false,
				source: 'pdf-text'
			};
		})
		.filter((block) => block.text && block.width > 2 && block.height > 2);
}

function visibleBlockRatio(blocks, viewport) {
	if (!blocks.length) return 0;
	const visible = blocks.filter(
		(block) =>
			block.x + block.width > 0 &&
			block.y + block.height > 0 &&
			block.x < viewport.width &&
			block.y < viewport.height
	);
	return visible.length / blocks.length;
}

async function runOcrForCurrentPage(openPanel = false) {
	if (!state.pdf) return;

	try {
		const data = getActivePageData();
		const canvas = getActiveCanvas();
		if (!data || !canvas) return 0;

		let ocrResult = null;
		if (state.fileBytes) {
			try {
				ocrResult = await invokeCommand('ocr_pdf_page', {
					bytes: Array.from(state.fileBytes),
					page: state.page,
					language: 'eng+fra'
				});
			} catch (nativeError) {
				console.warn('Native PDF OCR failed; falling back to rendered canvas.', nativeError);
			}
		}

		if (!ocrResult) {
			const imageBytes = await canvasToPngBytes(canvas);
			const ocrBlocks = await invokeCommand('ocr_page', {
				imageBytes: Array.from(imageBytes),
				language: 'eng+fra'
			});
			ocrResult = {
				blocks: ocrBlocks,
				imageWidth: canvas.width,
				imageHeight: canvas.height,
				pageWidth: data.viewportWidth,
				pageHeight: data.viewportHeight,
				deskewAngle: 0
			};
		}

		const blocks = mapOcrBlocksToPage(ocrResult, data);
		renderOcrTextLayer(data, blocks);

		state.editBlocks = state.editBlocks
			.filter((block) => !(block.page === state.page && block.source === 'ocr'))
			.concat(blocks);
		state.selectedBlockId = null;
		state.selectedBlockIds = [];
		renderEditBlocks();
		updateSelectedEditField();
		if (openPanel) {
			openDrawer('edit');
		}
		return blocks.length;
	} catch (error) {
		console.error(error);
		setStatus(error instanceof Error ? error.message : 'Local OCR failed.', 'error');
		return 0;
	}
}

function mapOcrBlocksToPage(ocrResult, data) {
	const imageWidth = Math.max(1, ocrResult?.imageWidth || data.canvas.width || data.viewportWidth);
	const imageHeight = Math.max(1, ocrResult?.imageHeight || data.canvas.height || data.viewportHeight);
	const cssScaleX = data.viewportWidth / imageWidth;
	const cssScaleY = data.viewportHeight / imageHeight;
	return (Array.isArray(ocrResult?.blocks) ? ocrResult.blocks : [])
		.filter((block) => block?.text && (block.confidence ?? 100) >= 30)
		.map((block, index) => {
			const x = block.x * cssScaleX;
			const y = block.y * cssScaleY;
			const width = Math.max(8, block.width * cssScaleX);
			const height = Math.max(10, block.height * cssScaleY);
			return {
				id: `ocr-${state.page}-${index}-${Date.now()}`,
				kind: 'text',
				page: state.page,
				text: block.text,
				originalText: block.text,
				x,
				y,
				originalX: x,
				originalY: y,
				width,
				height,
				originalWidth: width,
				originalHeight: height,
				pageWidth: data.viewportWidth,
				pageHeight: data.viewportHeight,
				hidden: false,
				source: 'ocr',
				confidence: block.confidence ?? 100
			};
		});
}

function renderOcrTextLayer(data, blocks) {
	if (!data?.textLayer) return;
	data.textLayer.querySelectorAll('.alto-ocr-text').forEach((node) => node.remove());
	const textDivs = Array.isArray(data.textDivs) ? data.textDivs : [];
	for (const block of blocks) {
		const span = document.createElement('span');
		span.className = 'alto-ocr-text';
		span.textContent = block.text;
		span.style.position = 'absolute';
		span.style.left = `${block.x}px`;
		span.style.top = `${block.y}px`;
		span.style.width = `${block.width}px`;
		span.style.height = `${block.height}px`;
		span.style.fontSize = `${Math.max(8, block.height * 0.78)}px`;
		span.style.lineHeight = '1';
		span.style.color = 'transparent';
		span.style.whiteSpace = 'pre';
		span.style.transformOrigin = '0 0';
		span.style.userSelect = 'text';
		span.style.webkitUserSelect = 'text';
		data.textLayer.append(span);
		textDivs.push(span);
	}
	data.textDivs = textDivs;
}

function isBlockDirty(block) {
	const moved = Math.abs(block.x - block.originalX) > 0.5 || Math.abs(block.y - block.originalY) > 0.5;
	const resized =
		Math.abs(block.width - (block.originalWidth ?? block.width)) > 0.5 ||
		Math.abs(block.height - (block.originalHeight ?? block.height)) > 0.5;
	const edited = (block.text || '') !== (block.originalText || '');
	return moved || resized || edited || Boolean(block.textEdited) || hasLocalGlyphEdits(block);
}

function isBlockTextEdited(block) {
	return Boolean(block.textEdited) || (block.text || '') !== (block.originalText || '');
}

function hasLocalGlyphEdits(block) {
	return Boolean(block && Array.isArray(block.hiddenCharIndexes) && block.hiddenCharIndexes.length > 0);
}

function hiddenCharSet(block) {
	return new Set(Array.isArray(block?.hiddenCharIndexes) ? block.hiddenCharIndexes : []);
}

function visiblePdfChars(block) {
	const hidden = hiddenCharSet(block);
	return (Array.isArray(block?.pdfChars) ? block.pdfChars : []).filter((ch) => !hidden.has(ch.index));
}

function getBlockOriginalSnapshot(block, data) {
	const canvas = data && data.canvas;
	if (!canvas || !canvas.width || !data.viewportWidth) return null;
	const sx = canvas.width / data.viewportWidth;
	const sy = canvas.height / data.viewportHeight;
	// On capture TOUJOURS l'étendue D'ORIGINE du contenu (originalWidth/Height) :
	// c'est un bitmap fixe du logo/image. L'élément <img> sera ensuite redimensionné
	// à block.width/height par le rendu, ce qui met le bitmap à l'échelle proprement
	// (sinon, en redimensionnant, on lirait un autre cadrage au lieu d'agrandir).
	const srcW = Math.max(1, block.originalWidth || block.width);
	const srcH = Math.max(1, block.originalHeight || block.height);
	const w = Math.max(1, Math.round(srcW));
	const h = Math.max(1, Math.round(srcH));
	if (block.snapshotDataUrl && block.snapshotW === w && block.snapshotH === h) {
		return block.snapshotDataUrl;
	}
	try {
		const off = document.createElement('canvas');
		off.width = Math.max(1, Math.round(srcW * sx));
		off.height = Math.max(1, Math.round(srcH * sy));
		const octx = off.getContext('2d');
		octx.drawImage(
			canvas,
			block.originalX * sx,
			block.originalY * sy,
			srcW * sx,
			srcH * sy,
			0,
			0,
			off.width,
			off.height
		);
		block.snapshotDataUrl = off.toDataURL('image/png');
		block.snapshotW = w;
		block.snapshotH = h;
		return block.snapshotDataUrl;
	} catch (error) {
		console.warn('Block snapshot failed', error);
		return null;
	}
}

let _lastBlockClick = { id: null, time: 0 };

function renderEditBlocks() {
	for (const data of state.pageElements.values()) {
		renderEditBlocksForPage(data.pageNumber);
	}
}

function cleanFontName(raw) {
	if (!raw) return '';
	let name = raw.replace(/^[A-Z]{6}\+/, '');
	name = name.replace(/[-_,]+/g, ' ');
	name = name.replace(/\b(MT|PS|Identity|Std|Pro|H|W\d+)\b/gi, ' ');
	name = name.replace(/\s+/g, ' ').trim();
	return name;
}

function baseFamilyName(clean) {
	return clean
		.replace(/\b(bold|black|heavy|semibold|demi|extrabold|light|thin|italic|oblique|condensed|medium|book|regular)\b/gi, '')
		.replace(/\s+/g, ' ')
		.trim();
}

const _loadedCloudFonts = new Set();
const _localFontStack =
	'Helvetica,Arial,"Times New Roman",Times,Georgia,"Courier New",Verdana,"Trebuchet MS"'.toLowerCase();

function ensureCloudFont(family) {
	if (!family || family.length < 3) return;
	const key = family.toLowerCase();
	if (_loadedCloudFonts.has(key)) return;
	// Skip families that are already available locally / as standard fonts.
	if (_localFontStack.includes(key)) return;
	_loadedCloudFonts.add(key);
	const link = document.createElement('link');
	link.rel = 'stylesheet';
	link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:ital,wght@0,400;0,700;1,400;1,700&display=swap`;
	link.addEventListener('error', () => _loadedCloudFonts.delete(key));
	document.head.append(link);
}

// Polices "en ligne" proposées dans le sélecteur (catalogue Google Fonts, toutes
// OFL). Aucune n'est embarquée dans l'app : elles sont chargées à la demande via
// ensureCloudFont() à la sélection → zéro poids ajouté au binaire.
const WEB_FONT_CATEGORIES = [
	{
		key: 'fontsCatSans',
		families: [
			'Inter', 'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Poppins', 'Source Sans 3',
			'Noto Sans', 'Nunito', 'Nunito Sans', 'Raleway', 'Work Sans', 'Mulish', 'Manrope',
			'Rubik', 'Karla', 'DM Sans', 'Space Grotesk', 'Quicksand', 'Josefin Sans', 'PT Sans',
			'Fira Sans', 'Cabin', 'Oxygen', 'Hind', 'Heebo', 'Barlow', 'Barlow Condensed',
			'Archivo', 'Archivo Narrow', 'Assistant', 'Titillium Web', 'Kanit', 'Prompt',
			'Sarabun', 'Dosis', 'Exo 2', 'Maven Pro', 'Catamaran', 'Be Vietnam Pro', 'Figtree',
			'Plus Jakarta Sans', 'Outfit', 'Sora', 'Albert Sans', 'Lexend', 'Public Sans',
			'Red Hat Display', 'Red Hat Text', 'Urbanist', 'Epilogue', 'Hanken Grotesk', 'Jost',
			'Questrial', 'Varela Round', 'Asap', 'Chivo', 'Overpass', 'Mukta', 'Cairo', 'Almarai',
			'IBM Plex Sans', 'Libre Franklin', 'Readex Pro', 'Saira', 'Signika', 'Mukta',
			'Schibsted Grotesk', 'Onest', 'Instrument Sans', 'Bricolage Grotesque'
		]
	},
	{
		key: 'fontsCatSerif',
		families: [
			'Merriweather', 'Lora', 'Playfair Display', 'PT Serif', 'Noto Serif', 'Source Serif 4',
			'EB Garamond', 'Libre Baskerville', 'Crimson Text', 'Crimson Pro', 'Cormorant',
			'Cormorant Garamond', 'Bitter', 'Domine', 'Roboto Slab', 'Zilla Slab', 'Arvo',
			'Vollkorn', 'Spectral', 'Frank Ruhl Libre', 'Cardo', 'Alegreya', 'Old Standard TT',
			'Tinos', 'Bodoni Moda', 'Marcellus', 'Cinzel', 'DM Serif Display', 'DM Serif Text',
			'Newsreader', 'Fraunces', 'Petrona', 'Gelasio', 'Lustria', 'Literata',
			'Noticia Text', 'Rozha One', 'Yeseva One', 'Prata', 'Sorts Mill Goudy', 'Italiana',
			'IBM Plex Serif', 'Besley', 'Faustina', 'Suranna'
		]
	},
	{
		key: 'fontsCatMono',
		families: [
			'JetBrains Mono', 'Fira Code', 'IBM Plex Mono', 'Roboto Mono', 'Source Code Pro',
			'Space Mono', 'Inconsolata', 'Ubuntu Mono', 'PT Mono', 'Cousine', 'Anonymous Pro',
			'DM Mono', 'Overpass Mono', 'Red Hat Mono', 'Martian Mono', 'Spline Sans Mono',
			'Azeret Mono', 'Fragment Mono', 'Nova Mono'
		]
	},
	{
		key: 'fontsCatDisplay',
		families: [
			'Bebas Neue', 'Oswald', 'Anton', 'Archivo Black', 'Abril Fatface', 'Righteous',
			'Bungee', 'Fjalla One', 'Alfa Slab One', 'Passion One', 'Staatliches', 'Teko',
			'Russo One', 'Black Ops One', 'Bangers', 'Comfortaa', 'Fredoka', 'Baloo 2',
			'Titan One', 'Concert One', 'Luckiest Guy', 'Shrikhand', 'Ultra', 'Monoton',
			'Audiowide', 'Orbitron', 'Press Start 2P', 'Rye', 'Cinzel Decorative', 'Unbounded',
			'Big Shoulders Display', 'Syne', 'Chango'
		]
	},
	{
		key: 'fontsCatScript',
		families: [
			'Dancing Script', 'Pacifico', 'Caveat', 'Satisfy', 'Great Vibes', 'Sacramento',
			'Shadows Into Light', 'Indie Flower', 'Permanent Marker', 'Kalam', 'Patrick Hand',
			'Amatic SC', 'Courgette', 'Cookie', 'Allura', 'Parisienne', 'Yellowtail',
			'Marck Script', 'Homemade Apple', 'Gloria Hallelujah', 'Architects Daughter',
			'Lobster', 'Lobster Two', 'Damion', 'Tangerine', 'Pinyon Script'
		]
	}
];
const WEB_FONT_CHOICES = WEB_FONT_CATEGORIES.flatMap((category) => category.families);
const _webFontSet = new Set(WEB_FONT_CHOICES.map((family) => family.toLowerCase()));
// Rempli par ensureFontSelectPopulated() avec les familles réellement installées.
const _systemFontSet = new Set();

function isWebFontChoice(family) {
	return Boolean(family) && _webFontSet.has(family.toLowerCase());
}

// Une police doit être chargée depuis le cloud uniquement si elle n'est PAS déjà
// installée localement (sinon on utilise la version système, plus fidèle).
function needsCloudFont(family) {
	return isWebFontChoice(family) && !_systemFontSet.has(family.toLowerCase());
}

// Extrait le nom de famille principal d'une valeur CSS font-family
// (ex: '"Bricolage Grotesque", sans-serif' -> 'Bricolage Grotesque').
function primaryFamilyName(cssFamily) {
	if (!cssFamily) return '';
	const first = cssFamily.split(',')[0].trim();
	return first.replace(/^["']|["']$/g, '');
}

// Fusionne + déduplique + trie (A→Z) une liste de familles avec le catalogue web.
function _mergeFontFamilies(families) {
	const merged = new Map();
	for (const family of families) {
		const key = family.toLowerCase();
		_systemFontSet.add(key);
		merged.set(key, family);
	}
	for (const family of WEB_FONT_CHOICES) {
		const key = family.toLowerCase();
		if (!merged.has(key)) merged.set(key, family);
	}
	return [...merged.values()].sort((a, b) =>
		a.localeCompare(b, undefined, { sensitivity: 'base' })
	);
}

// ─── Combobox de police (remplace le <select> natif WKWebView, non contenable) ───
// Liste complète des familles (système + web, triées A→Z), valeur courante, et
// libellé "auto" (police détectée du bloc).
let _fontComboFamilies = [];
let _fontComboValue = '';
let _fontComboAutoLabel = 'Police du document';
// Plage de texte mémorisée à l'ouverture du combobox (si on éditait en inline avec
// une sous-sélection). Permet d'appliquer la police aux SEULS caractères choisis,
// car ouvrir/chercher dans le popover détruit la sélection native.
let _fontComboSavedRange = null;

function isFontComboOpen() {
	return Boolean(elements.fontComboPopover) && !elements.fontComboPopover.hidden;
}

// Met à jour le libellé du déclencheur (sans déclencher de changement de bloc).
function setFontComboValue(value) {
	_fontComboValue = value || '';
	if (!elements.fontComboValue) return;
	const label = _fontComboValue || _fontComboAutoLabel || 'Police du document';
	elements.fontComboValue.textContent = label;
	elements.fontComboValue.style.fontFamily = _fontComboValue
		? `"${_fontComboValue}", sans-serif`
		: '';
}

// Construit la liste déroulante (ligne "auto" + familles filtrées par la recherche).
function renderFontComboList(filter) {
	const list = elements.fontComboList;
	if (!list) return;
	const query = (filter || '').trim().toLowerCase();
	const rows = [];
	const autoLabel = _fontComboAutoLabel || 'Police du document';
	if (!query || autoLabel.toLowerCase().includes(query)) {
		rows.push({ value: '', label: autoLabel });
	}
	for (const family of _fontComboFamilies) {
		if (!query || family.toLowerCase().includes(query)) {
			rows.push({ value: family, label: family });
		}
	}

	list.innerHTML = '';
	if (!rows.length) {
		const empty = document.createElement('div');
		empty.className = 'font-combo-empty';
		empty.textContent = 'Aucune police trouvée';
		list.append(empty);
		return;
	}

	const fragment = document.createDocumentFragment();
	for (const row of rows) {
		const option = document.createElement('button');
		option.type = 'button';
		option.className = 'font-combo-option';
		option.setAttribute('role', 'option');
		if (row.value === _fontComboValue) {
			option.classList.add('selected');
			option.setAttribute('aria-selected', 'true');
		}
		option.textContent = row.label;
		if (row.value) option.style.fontFamily = `"${row.value}", sans-serif`;
		option.addEventListener('click', () => onFontComboSelect(row.value));
		fragment.append(option);
	}
	list.append(fragment);
}

// Positionne le popover sous le déclencheur, calé sur sa largeur (reste dans la
// colonne d'édition) ; hauteur bornée pour rester dans la fenêtre + scroll interne.
function positionFontComboPopover() {
	const trigger = elements.fontComboTrigger;
	const pop = elements.fontComboPopover;
	if (!trigger || !pop) return;
	const rect = trigger.getBoundingClientRect();
	pop.style.left = `${Math.round(rect.left)}px`;
	pop.style.top = `${Math.round(rect.bottom + 4)}px`;
	pop.style.width = `${Math.round(rect.width)}px`;
	const available = window.innerHeight - rect.bottom - 16;
	pop.style.maxHeight = `${Math.max(160, Math.min(360, available))}px`;
}

function openFontCombo() {
	const trigger = elements.fontComboTrigger;
	const pop = elements.fontComboPopover;
	if (!trigger || !pop || trigger.disabled || isFontComboOpen()) return;
	void ensureFontSelectPopulated();
	// Mémorise une éventuelle sous-sélection de texte AVANT que le popover ne vole
	// le focus (ce qui effacerait la sélection native du contenteditable).
	_fontComboSavedRange = captureInlineSelectionRange();
	if (elements.fontComboSearch) elements.fontComboSearch.value = '';
	renderFontComboList('');
	positionFontComboPopover();
	pop.hidden = false;
	trigger.setAttribute('aria-expanded', 'true');
	if (elements.fontComboSearch) {
		requestAnimationFrame(() => elements.fontComboSearch.focus());
	}
	const selected = elements.fontComboList?.querySelector('.font-combo-option.selected');
	if (selected) selected.scrollIntoView({ block: 'center' });
}

function closeFontCombo() {
	const pop = elements.fontComboPopover;
	if (!pop || pop.hidden) return;
	pop.hidden = true;
	elements.fontComboTrigger?.setAttribute('aria-expanded', 'false');
}

// Capture la plage de texte sélectionnée DANS le bloc en cours d'édition inline.
// Renvoie { blockId, range } ou null si pas de vraie sous-sélection.
function captureInlineSelectionRange() {
	if (!state.editingBlockId) return null;
	const editing = elements.pagesStack.querySelector(
		`.edit-block.editing[data-block-id="${state.editingBlockId}"]`
	);
	if (!editing) return null;
	const selection = window.getSelection();
	if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
	if (!editing.contains(selection.anchorNode) || !editing.contains(selection.focusNode)) return null;
	return { blockId: state.editingBlockId, range: selection.getRangeAt(0).cloneRange() };
}

// Applique la police UNIQUEMENT à la plage mémorisée (texte riche par run).
// Renvoie true si appliqué, false si on doit retomber sur l'application globale.
function applyFontToSavedRange(value) {
	const saved = _fontComboSavedRange;
	_fontComboSavedRange = null;
	if (!saved || state.editingBlockId !== saved.blockId) return false;
	const block = state.editBlocks.find((b) => b.id === saved.blockId);
	if (!block || block.kind === 'image') return false;
	const editing = elements.pagesStack.querySelector(
		`.edit-block.editing[data-block-id="${saved.blockId}"]`
	);
	if (!editing) return false;

	// Restaure le focus du contenteditable PUIS la sélection native sur la plage
	// mémorisée (execCommand agit sur la sélection de l'élément focalisé).
	editing.focus();
	const selection = window.getSelection();
	try {
		selection.removeAllRanges();
		selection.addRange(saved.range);
	} catch (_err) {
		return false;
	}
	if (selection.isCollapsed || !editing.contains(selection.anchorNode)) return false;

	pushHistory();
	// styleWithCSS -> la police s'applique en font-family (lisible via getComputedStyle).
	try {
		document.execCommand('styleWithCSS', false, 'true');
	} catch (_err) {}
	const applied = document.execCommand('fontName', false, value || 'inherit');
	if (!applied) {
		// Repli : enveloppe manuellement la sélection dans un span.
		try {
			const range = selection.getRangeAt(0);
			const span = document.createElement('span');
			span.style.fontFamily = value ? `"${value}", sans-serif` : '';
			span.appendChild(range.extractContents());
			range.insertNode(span);
		} catch (_err) {
			return false;
		}
	}

	editing.classList.remove('editing-pristine');
	editing.style.letterSpacing = '0px';
	ensureEditMask(editing, block);
	resizeEditingElementToContent(editing, block);

	block.html = editing.innerHTML;
	block.text = editing.innerText;
	block.htmlEdited = true;
	block.textEdited = true;
	block.inlineEditDirty = true;
	block.snapshotDataUrl = null;
	markDirty();
	updateFormatPanel(block);
	editing.focus();
	return true;
}

// Recale la géométrie d'un bloc texte sélectionné (non édité) sur la largeur réelle
// de son contenu : sans ça, changer de police laisse l'encadré à l'ancienne taille
// et le texte déborde. Renvoie true si la géométrie a changé.
function refitBlockToContent(block) {
	if (!block || block.kind === 'image') return false;
	const element = elements.pagesStack.querySelector(
		`.edit-block[data-block-id="${block.id}"]:not(.editing)`
	);
	if (!element) return false;

	const prev = {
		width: element.style.width,
		height: element.style.height,
		whiteSpace: element.style.whiteSpace,
		maxWidth: element.style.maxWidth
	};
	element.style.maxWidth = 'none';
	element.style.width = 'auto';
	element.style.height = 'auto';
	if (!block.multiline) element.style.whiteSpace = 'pre';
	const contentWidth = Math.ceil(element.scrollWidth);
	const contentHeight = Math.ceil(element.scrollHeight);
	element.style.width = prev.width;
	element.style.height = prev.height;
	element.style.whiteSpace = prev.whiteSpace;
	element.style.maxWidth = prev.maxWidth;

	let changed = false;
	if (!block.multiline) {
		// Ligne simple : on recale la LARGEUR (la hauteur reste calée sur l'encre).
		const maxW = Math.max(18, (block.pageWidth || block.width) - block.x - 2);
		const nextW = Math.min(maxW, Math.max(18, contentWidth));
		if (Math.abs(nextW - block.width) > 1) {
			block.width = nextW;
			changed = true;
		}
	} else {
		// Paragraphe : largeur fixe (wrap), on recale la HAUTEUR.
		const nextH = Math.max(6, contentHeight);
		if (Math.abs(nextH - block.height) > 1) {
			block.height = nextH;
			changed = true;
		}
	}
	return changed;
}

// Après un changement de police global : recale tout de suite, puis à nouveau une
// fois la webfont réellement chargée (la largeur n'est correcte qu'à ce moment).
function refitSelectedBlockToFont(value) {
	const block = selectedEditBlock();
	if (!block || block.kind === 'image') return;
	const doFit = () => {
		if (refitBlockToContent(block)) {
			markDirty();
			renderEditBlocks();
		}
	};
	doFit();
	const fam = primaryFamilyName(value) || value;
	if (fam && document.fonts?.load) {
		const px = block.fontSizeOverride || block.baseFontSize || 16;
		try {
			document.fonts.load(`${px}px "${fam}"`).then(doFit).catch(() => {});
		} catch (_err) { /* noop */ }
	}
}

// Sélection d'une police. Si une sous-sélection a été mémorisée à l'ouverture, on
// applique la police À CES SEULS caractères ; sinon on l'applique au bloc entier.
function onFontComboSelect(value) {
	if (needsCloudFont(value)) ensureCloudFont(value);
	if (_fontComboSavedRange && applyFontToSavedRange(value)) {
		closeFontCombo();
		return;
	}
	setFontComboValue(value);
	applyFormatChange((block) => {
		block.fontFamilyOverride = value || null;
	});
	refitSelectedBlockToFont(value);
	closeFontCombo();
}

// Peuple (une seule fois) la liste de polices. Étape 1 : catalogue en ligne
// IMMÉDIATEMENT (jamais de liste vide). Étape 2 : fusion des polices installées
// dès qu'elles arrivent, avec timeout de sécurité.
let _fontSelectPopulated = false;
async function ensureFontSelectPopulated() {
	if (_fontSelectPopulated) return;
	_fontSelectPopulated = true;

	_fontComboFamilies = [...WEB_FONT_CHOICES].sort((a, b) =>
		a.localeCompare(b, undefined, { sensitivity: 'base' })
	);
	if (isFontComboOpen()) renderFontComboList(elements.fontComboSearch?.value);

	let families = [];
	try {
		families = await Promise.race([
			invokeCommand('list_system_fonts'),
			new Promise((_resolve, reject) =>
				setTimeout(() => reject(new Error('list_system_fonts timeout')), 6000)
			)
		]);
	} catch (_err) {
		families = [];
	}
	if (!Array.isArray(families) || !families.length) return;

	_fontComboFamilies = _mergeFontFamilies(families);
	if (isFontComboOpen()) renderFontComboList(elements.fontComboSearch?.value);
}

// Câblage des interactions du combobox (une seule fois au chargement).
function setupFontCombo() {
	const trigger = elements.fontComboTrigger;
	const search = elements.fontComboSearch;
	if (!trigger) return;
	trigger.addEventListener('click', (event) => {
		event.stopPropagation();
		if (isFontComboOpen()) closeFontCombo();
		else openFontCombo();
	});
	search?.addEventListener('input', () => renderFontComboList(search.value));
	search?.addEventListener('keydown', (event) => {
		if (event.key === 'Escape') {
			event.stopPropagation();
			closeFontCombo();
			trigger.focus();
		} else if (event.key === 'Enter') {
			event.preventDefault();
			const first = elements.fontComboList?.querySelector('.font-combo-option');
			if (first) first.click();
		}
	});
	// Fermeture au clic à l'extérieur.
	document.addEventListener('click', (event) => {
		if (!isFontComboOpen()) return;
		if (!elements.fontCombo?.contains(event.target) && !elements.fontComboPopover?.contains(event.target)) {
			closeFontCombo();
		}
	});
	// Le popover est en position: fixed → on le ferme si la mise en page bouge.
	// MAIS surtout pas quand on scrolle À L'INTÉRIEUR de la liste (molette).
	window.addEventListener('resize', () => closeFontCombo());
	window.addEventListener('scroll', (event) => {
		if (!isFontComboOpen()) return;
		if (elements.fontComboPopover?.contains(event.target)) return;
		closeFontCombo();
	}, true);
}

function applyBlockFontStyle(element, block) {
	element.style.fontWeight = block.bold ? '700' : '400';
	element.style.fontStyle = block.italic ? 'italic' : 'normal';
	element.style.fontFamily = block.serif
		? 'Georgia, "Times New Roman", "Noto Serif", serif'
		: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif';
}

function detectBoldFromFontName(value) {
	return /\b(bold|black|heavy|semibold|demi|extrabold|700|800|900)\b/i.test(value || '');
}

function markBlockBoldFromPixels(block, data) {
	if (!block || block.kind === 'image') return false;
	const ink = measureBlockInkRatio(block, data);
	// Absolute fallback for fonts that are bold by glyph design but report font-weight: 400.
	// PDF block bounds are tight, so bold display text generally crosses this density.
	if (ink != null && ink >= 0.16) {
		block.bold = true;
		block.visualBold = true;
		return true;
	}
	return false;
}

function applyMatchedTextStyle(element, block) {
	const match = block.fontMatch;
	if (!match) return false;
	element.style.fontFamily = match.family;
	element.style.fontWeight = match.weight;
	element.style.fontStyle = match.style;
	return true;
}

function findTextLayerFontMatch(block, data) {
	const layer = data && data.textLayer;
	if (!layer) return null;
	const spans = layer.querySelectorAll('span');
	if (!spans.length) return null;

	const layerRect = layer.getBoundingClientRect();
	if (!layerRect.width || !layerRect.height) return null;
	const sx = layerRect.width / data.viewportWidth;
	const sy = layerRect.height / data.viewportHeight;
	const target = {
		left: layerRect.left + block.originalX * sx,
		top: layerRect.top + block.originalY * sy,
		right: layerRect.left + (block.originalX + block.width) * sx,
		bottom: layerRect.top + (block.originalY + block.height) * sy
	};

	let best = null;
	let bestScore = -Infinity;
	for (const span of spans) {
		if (!span.textContent.trim()) continue;
		const r = span.getBoundingClientRect();
		if (!r.width || !r.height) continue;
		const overlapX = Math.max(0, Math.min(target.right, r.right) - Math.max(target.left, r.left));
		const overlapY = Math.max(0, Math.min(target.bottom, r.bottom) - Math.max(target.top, r.top));
		const overlap = overlapX * overlapY;
		const dx = (target.left + target.right - r.left - r.right) / 2;
		const dy = (target.top + target.bottom - r.top - r.bottom) / 2;
		const distancePenalty = Math.sqrt(dx * dx + dy * dy) * 0.01;
		const textBonus =
			block.text && span.textContent && block.text.includes(span.textContent.trim()) ? r.width * r.height * 0.15 : 0;
		const score = overlap + textBonus - distancePenalty;
		if (score > bestScore) {
			bestScore = score;
			best = span;
		}
	}
	if (!best || bestScore <= 0) return null;

	const cs = getComputedStyle(best);
	const family = cs.fontFamily;
	if (!family) return null;
	// On respecte le poids RÉEL rapporté par le text layer PDF.js (fidèle à l'original).
	// Le nom de police PDFium ("...-Bold") sert seulement de repli si le poids calculé
	// est resté à 400 alors que la police est grasse par design.
	const familyLooksBold = detectBoldFromFontName(family) || detectBoldFromFontName(block.fontName);
	const computedWeight = parseInt(cs.fontWeight, 10) || 400;
	// Gras = poids réel calculé, OU flag bold fiable de PDFium, OU nom de police "...-Bold".
	const isBold = computedWeight >= 600 || block.bold === true || familyLooksBold;
	const weight = isBold ? '700' : String(computedWeight);
	const style = cs.fontStyle && cs.fontStyle !== 'normal' ? cs.fontStyle : block.italic ? 'italic' : 'normal';
	const fontSize = parseFloat(cs.fontSize) || 0;
	const letterSpacing = cs.letterSpacing && cs.letterSpacing !== 'normal' ? cs.letterSpacing : null;
	return { family, weight, style, fontSize, letterSpacing };
}

function matchFontFromTextLayer(element, block, data) {
	if (!block.fontMatch) {
		block.fontMatch = findTextLayerFontMatch(block, data);
	}
	if (!block.fontMatch) return false;
	applyMatchedTextStyle(element, block);
	const { family, weight, style, fontSize } = block.fontMatch;
	// On privilégie le VRAI nom de police du document (donné par PDFium, ex.
	// "Helvetica", "Arial", "Times New Roman") : s'il est installé sur l'ordinateur
	// OU chargeable via Google Fonts, l'édition utilise la police d'origine et
	// supprimer/éditer ne change RIEN. On NE met PAS la police PDF.js (g_d0_f1) :
	// elle est remappée en zone PUA et inutilisable pour de la saisie. Repli sur
	// une générique cohérente (serif/sans) si la police n'est pas disponible.
	const pdfBase = baseFamilyName(cleanFontName(block.fontName));
	const generic = block.serif
		? 'Georgia, "Times New Roman", "Noto Serif", serif'
		: 'Helvetica, Arial, "Segoe UI", "Noto Sans", sans-serif';
	if (pdfBase) {
		ensureCloudFont(pdfBase);
		element.style.fontFamily = `"${pdfBase}", ${generic}`;
	} else {
		element.style.fontFamily = family || generic;
	}
	element.style.fontWeight = weight;
	element.style.fontStyle = style;
	if (!block.fontSizeOverride) {
		if (block.pdfFontSize > 0) {
			element.style.fontSize = `${block.pdfFontSize}px`;
		} else if (fontSize) {
			element.style.fontSize = `${fontSize}px`;
		}
	}
	if ((parseInt(weight, 10) || 400) >= 600) block.bold = true;
	if (style && style !== 'normal') block.italic = true;
	return true;
}

function refreshBlockFontInfo(block) {
	// Détecte police/gras/italique/taille réels depuis le text layer PDF.js.
	// N'écrase JAMAIS le gras/italique à false : on ne fait qu'ajouter un signal.
	if (!block || block.kind === 'image') return;
	const data = getPageData(block.page);
	const match = findTextLayerFontMatch(block, data);
	if (match) {
		block.fontMatch = match;
		if ((parseInt(match.weight, 10) || 400) >= 600) block.bold = true;
		if (match.style && match.style !== 'normal') block.italic = true;
		// La taille de police vient de PDFium (scaled_font_size, fiable). On ne
		// retombe sur la mesure du text layer PDF.js que si PDFium ne l'a pas fournie.
		if (!block.fontSizeOverride) {
			if (block.pdfFontSize > 0) {
				block.baseFontSize = block.pdfFontSize;
			} else if (match.fontSize) {
				block.baseFontSize = match.fontSize;
			}
		}
	}
	// Fallback : polices grasses « par design » que PDFium rapporte en poids 400.
	if (!block.bold) detectBoldByInkFallback(block, data);
}

function detectBoldByInkFallback(block, data) {
	// Compare la densité d'encre du bloc à la médiane de la page (canvas rendu).
	// Relatif => insensible à la taille de police et sans faux positif sur les
	// lignes de chiffres (qui restent proches de la médiane).
	if (!data || !data.canvas) return;
	if (data._inkMedian === undefined) {
		const textBlocks = state.editBlocks.filter(
			(b) => b.page === block.page && b.kind !== 'image' && b.text && b.width > 4 && b.height > 4
		);
		const measures = [];
		for (const b of textBlocks) {
			const ink = measureBlockInkRatio(b, data);
			if (ink != null) {
				b._inkRatio = ink;
				measures.push(ink);
			}
		}
		if (measures.length >= 3) {
			measures.sort((a, b) => a - b);
			data._inkMedian = measures[Math.floor(measures.length / 2)];
		} else {
			data._inkMedian = 0;
		}
	}
	if (data._inkMedian > 0) {
		const ink = block._inkRatio != null ? block._inkRatio : measureBlockInkRatio(block, data);
		if (ink != null && ink >= data._inkMedian * 1.45) {
			block.bold = true;
			block.visualBold = true;
		}
	}
}

// Boîte d'encre RÉELLE d'un bloc texte, calculée à partir des bornes "tight" des
// glyphes (mask*). Les bornes du bloc viennent des "loose bounds" PDFium qui
// incluent toute la hauteur d'em (ascente + descente) : pour du texte capital
// sans jambage, ça laisse un vide visible SOUS la ligne. On resserre donc la
// boîte de sélection sur l'encre. Retourne null si indisponible/non pertinent.
function textInkBox(block) {
	if (!Array.isArray(block.pdfChars) || !block.pdfChars.length) return null;
	let top = Infinity;
	let bottom = -Infinity;
	for (const ch of block.pdfChars) {
		if (!ch.text || !ch.text.trim()) continue;
		const h = ch.maskHeight > 0 ? ch.maskHeight : ch.height;
		const t = typeof ch.maskY === 'number' ? ch.maskY : ch.y;
		if (!(h > 0)) continue;
		if (t < top) top = t;
		if (t + h > bottom) bottom = t + h;
	}
	if (!isFinite(top) || bottom <= top) return null;
	// On ne dépasse jamais les bornes lâches du bloc (sécurité).
	top = Math.max(top, block.y);
	bottom = Math.min(bottom, block.y + block.height);
	const height = bottom - top;
	if (!(height > 1)) return null;
	return { top, height };
}

// Canvas réutilisé pour mesurer l'encre réelle d'un texte rendu.
let _inkMeasureCanvas = null;
function inkMeasureCanvas() {
	if (!_inkMeasureCanvas) _inkMeasureCanvas = document.createElement('canvas');
	return _inkMeasureCanvas;
}

// Mesure l'encre RÉELLE d'un texte par scan de pixels (fiable quelle que soit la
// police, contrairement à actualBoundingBox* qui varie selon les implémentations).
// Renvoie ascent/descent par rapport à la ligne de base alphabétique, en px CSS.
function measureTextInk(text, fontStr) {
	const trimmed = (text || '').trim();
	if (!trimmed) return null;
	const canvas = inkMeasureCanvas();
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	ctx.font = fontStr;
	const m = ctx.measureText(trimmed);
	const fAsc = m.fontBoundingBoxAscent || m.actualBoundingBoxAscent || 0;
	const fDesc = m.fontBoundingBoxDescent || m.actualBoundingBoxDescent || 0;
	const w = Math.max(1, Math.ceil(m.width) + 4);
	const h = Math.max(1, Math.ceil(fAsc + fDesc) + 6);
	const baselineY = Math.ceil(fAsc) + 3;
	canvas.width = w;
	canvas.height = h;
	// width/height réinitialise le contexte → reposer font + baseline.
	ctx.font = fontStr;
	ctx.textBaseline = 'alphabetic';
	ctx.fillStyle = '#000';
	ctx.clearRect(0, 0, w, h);
	ctx.fillText(trimmed, 2, baselineY);
	let data;
	try {
		data = ctx.getImageData(0, 0, w, h).data;
	} catch (_err) {
		return null;
	}
	let top = -1;
	let bottom = -1;
	for (let y = 0; y < h; y++) {
		let rowHasInk = false;
		const rowStart = y * w * 4;
		for (let x = 0; x < w; x++) {
			if (data[rowStart + x * 4 + 3] > 16) {
				rowHasInk = true;
				break;
			}
		}
		if (rowHasInk) {
			if (top < 0) top = y;
			bottom = y;
		}
	}
	if (top < 0) return null;
	return {
		ascent: baselineY - top, // px au-dessus de la ligne de base
		descent: bottom - baselineY + 1, // px sous la ligne de base
		height: bottom - top + 1
	};
}

// Recale la boîte d'un bloc texte ré-écrit (police/texte changés) APRÈS rendu.
// On mesure l'ENCRE RÉELLE (scan de pixels) de la police affichée + la ligne de base
// réelle dans le DOM. La boîte épouse l'encre, ancrée sur la LIGNE DE BASE d'origine
// (bas de l'encre PDF) : le texte ne saute pas en changeant de police, ni col en
// haut ni vide en bas, quelle que soit la police. Re-mesuré quand la webfont charge.
function recenterDirtyTextBox(element, block) {
	const apply = () => {
		if (!element.isConnected) return;
		const text = (element.textContent || '').trim();
		if (!text) return;

		// Enveloppe le contenu pour pouvoir le remonter SANS bouger la boîte.
		let wrap = element.querySelector(':scope > .ink-shift');
		if (!wrap) {
			wrap = document.createElement('span');
			wrap.className = 'ink-shift';
			wrap.style.display = 'block';
			while (element.firstChild) wrap.appendChild(element.firstChild);
			element.appendChild(wrap);
		}
		wrap.style.lineHeight = 'normal';
		wrap.style.transform = 'none';
		element.style.lineHeight = 'normal';
		element.style.overflow = 'visible';
		element.style.height = 'auto';

		const cs = getComputedStyle(element);
		const fontStr = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize}/normal ${cs.fontFamily}`;
		const ink = measureTextInk(text, fontStr);
		if (!ink || !(ink.height > 0)) return;

		// Ligne de base réelle dans le DOM (strut inline-block aligné baseline).
		const strut = document.createElement('span');
		strut.style.cssText =
			'display:inline-block;width:0;height:0;vertical-align:baseline;overflow:hidden';
		wrap.appendChild(strut);
		const wrapRect = wrap.getBoundingClientRect();
		const strutRect = strut.getBoundingClientRect();
		const ratio = element.offsetWidth > 0 ? element.offsetWidth / Math.max(1, element.getBoundingClientRect().width) : 1;
		const baselineOffset = (strutRect.top - wrapRect.top) * ratio; // px CSS depuis le haut du wrap
		strut.remove();

		const pdfInk = textInkBox(block);
		// Ligne de base d'origine ≈ bas de l'encre (caps) ; fallback : bas du bloc lâche.
		const baseline = pdfInk ? pdfInk.top + pdfInk.height : block.y + Math.max(block.height, 14);

		// On remonte le contenu pour que le haut de l'encre touche le haut de la boîte.
		const shift = baselineOffset - ink.ascent;
		wrap.style.transform = `translateY(${-shift}px)`;
		element.style.height = `${ink.height}px`;
		element.style.top = `${baseline - ink.ascent}px`;
	};
	apply();
	// La hauteur dépend de la police : si c'est une webfont pas encore chargée, ses
	// métriques arriveront plus tard → on re-mesure une fois prête.
	const fam = primaryFamilyName(block.fontFamilyOverride || '');
	const px = block.fontSizeOverride || block.baseFontSize || 16;
	if (fam && document.fonts?.load && !document.fonts.check(`${px}px "${fam}"`)) {
		document.fonts.load(`${px}px "${fam}"`).then(apply).catch(() => {});
	}
}

function renderEditBlocksForPage(pageNumber) {
	const data = getPageData(pageNumber);
	if (!data) return;
	const editLayer = data.editLayer;
	editLayer.innerHTML = '';
	editLayer.classList.toggle('active', state.editMode);
	editLayer.style.width = `${data.viewportWidth}px`;
	editLayer.style.height = `${data.viewportHeight}px`;
	if (!state.editMode) return;

	// Blocs supprimés (hidden) : on peint un masque blanc sur leur emplacement
	// d'origine pour que le texte PDF disparaisse réellement à l'écran (sinon il
	// reste rasterisé sous l'overlay, donnant l'impression d'un bloc « figé »).
	// Identique au masquage fait à l'export dans renderFlattenedPage.
	state.editBlocks
		.filter((block) => block.page === pageNumber && block.hidden)
		.forEach((block) => {
			const mask = document.createElement('div');
			mask.className = 'edit-block-mask';
			mask.style.left = `${(block.originalX ?? block.x) - 1.5}px`;
			mask.style.top = `${(block.originalY ?? block.y) - 1.5}px`;
			mask.style.width = `${Math.max(block.width, block.originalWidth || block.width, 18) + 3}px`;
			mask.style.height = `${Math.max(block.height, block.originalHeight || block.height, 14) + 3}px`;
			editLayer.append(mask);
		});

	state.editBlocks
		.filter((block) => block.page === pageNumber && !block.hidden)
		.forEach((block) => {
			const dirty = isBlockDirty(block);
			const isEditing = block.id === state.editingBlockId;
			// Édition « vierge » : on vient d'entrer en saisie sans rien modifier.
			// On NE masque PAS le texte PDF et on n'affiche pas notre rendu opaque,
			// pour qu'il n'y ait AUCUN mouvement à l'entrée (juste cadre + curseur).
			const editTouched = block.inlineEditDirty || isBlockTextEdited(block);
			const localGlyphEdited = hasLocalGlyphEdits(block);
			const lineCount = Math.max(1, (block.text || '').split('\n').length);
			const multiline = lineCount > 1 || block.multiline === true;
			block.multiline = multiline;

			if ((dirty && !localGlyphEdited) || (isEditing && block.kind !== 'image' && editTouched)) {
				const mask = document.createElement('div');
				mask.className = 'edit-block-mask';
				// Marge de 1.5px : couvre l'anti-aliasing et les couches de texte
				// estampées avec un léger décalage (faux gras des logos).
				mask.style.left = `${block.originalX - 1.5}px`;
				mask.style.top = `${block.originalY - 1.5}px`;
				// Le masque doit couvrir l'étendue D'ORIGINE du texte PDF (sinon, si le
				// texte édité est plus étroit, l'ancien glyphe dépasse et laisse un résidu).
				mask.style.width = `${Math.max(block.width, block.originalWidth || block.width, 18) + 3}px`;
				mask.style.height = `${Math.max(block.height, block.originalHeight || block.height, 14) + 3}px`;
				editLayer.append(mask);
			}

			if (localGlyphEdited && Array.isArray(block.pdfChars)) {
				const hidden = hiddenCharSet(block);
				for (const ch of block.pdfChars) {
					if (!hidden.has(ch.index)) continue;
					// Boîte serrée du glyphe + très fine marge anti-aliasing : ne mord
					// pas sur les lettres voisines.
					const mx = ch.maskX ?? ch.x;
					const my = ch.maskY ?? ch.y;
					const mw = ch.maskWidth ?? ch.width;
					const mh = ch.maskHeight ?? ch.height;
					const glyphMask = document.createElement('div');
					glyphMask.className = 'edit-block-mask glyph-mask';
					glyphMask.style.left = `${Math.max(0, mx - 0.4)}px`;
					glyphMask.style.top = `${Math.max(0, my - 0.4)}px`;
					glyphMask.style.width = `${mw + 0.8}px`;
					glyphMask.style.height = `${mh + 0.8}px`;
					editLayer.append(glyphMask);
				}
			}

			const element = document.createElement('div');
			const isSelected = isBlockSelected(block);
			// Bloc dont SEULS des glyphes ont été masqués (aucune frappe) : hors
			// édition il ne rend aucun contenu, donc le fond blanc de `.dirty`
			// peindrait un carré vide sur le PDF. On le laisse transparent.
			const glyphOnlyIdle = localGlyphEdited && !isEditing && !isBlockTextEdited(block);
			element.className = `edit-block ${block.kind || 'text'}${isSelected ? ' selected' : ''}${dirty && !glyphOnlyIdle ? ' dirty' : ''}${isEditing ? ' editing' : ''}`;
			if (isEditing && Array.isArray(block.pdfChars) && block.pdfChars.length && !isBlockTextEdited(block)) {
				element.classList.add('pdf-glyph-editing');
			}
			element.dataset.blockId = block.id;
			if (block.bold || block.visualBold || block.boldOverride === true) {
				element.dataset.bold = 'true';
			}
			element.style.left = `${block.x}px`;
			element.style.top = `${block.y}px`;
			element.tabIndex = 0;
			element.setAttribute('role', 'button');
			element.setAttribute('aria-label', block.text || (block.kind === 'image' ? 'Image' : 'Bloc'));
			element.title = block.text;

			// Bloc-paragraphe : interligne = pas entre lignes d'origine.
			let multilineHalfLeading = 0;
			if (multiline) {
				element.classList.add('multiline');
				// Interligne. Pour un paragraphe NATIF non modifié, originalHeight couvre
				// déjà ses N lignes → originalHeight/lineCount = pas réel. Mais si on a
				// COLLÉ/édité du texte (lignes ajoutées), originalHeight ne correspond plus
				// au nombre de lignes (ex: 12 lignes collées dans un bloc d'1 ligne → pas
				// minuscule → lignes empilées). Dans ce cas on dérive l'interligne de la
				// taille de police.
				const contentEdited = block.inlineEditDirty || isBlockTextEdited(block);
				let lh;
				if (!contentEdited && block.originalHeight) {
					lh = block.originalHeight / lineCount;
				} else {
					const fs =
						block.fontSizeOverride ||
						(block.pdfFontSize > 0
							? block.pdfFontSize
							: block.baseFontSize ||
								Math.max(8, Math.min(48, Math.round((block.originalHeight || 14) * 0.78))));
					lh = fs * 1.32;
				}
				if (lh > 0) {
					element.style.lineHeight = `${lh}px`;
					// CSS centre chaque ligne dans sa boîte => une demi-marge (lh - police)/2
					// se glisse AU-DESSUS de la 1re ligne (trou en haut + curseur décalé).
					// On la mesure pour remonter le contenu et coller la 1re ligne au PDF.
					const fs = block.pdfFontSize > 0 ? block.pdfFontSize : lh * 0.82;
					multilineHalfLeading = Math.max(0, (lh - fs) / 2);
					// Hors édition aussi : on remonte la 1re ligne pour qu'elle colle au
					// PDF (sinon un "trou" réapparaît en haut une fois la saisie finie).
					if (!isEditing) element.style.top = `${block.y - multilineHalfLeading}px`;
				}
			}

			const minWidth = Math.max(block.width, 18);
			const minHeight = Math.max(block.height, 14);

			element.style.width = `${minWidth}px`;
			element.style.height = `${minHeight}px`;
			// État repos (ni en édition, ni déplacé) : resserrer le cadre sur l'encre
			// réelle pour supprimer le vide sous le texte (loose bounds). On ne touche
			// PAS à block.y/height (géométrie d'édition préservée → aucun mouvement au
			// double-clic), seulement à l'affichage de la boîte. Les blocs ré-écrits
			// (texte/police modifiés) sont recalés APRÈS rendu par recenterDirtyTextBox,
			// à partir des métriques RÉELLES de la police choisie (pas de l'ancienne).
			if (block.kind !== 'image' && !isEditing && !dirty && !multiline) {
				const inkBox = textInkBox(block);
				if (inkBox) {
					element.style.top = `${inkBox.top}px`;
					element.style.height = `${Math.max(inkBox.height, 6)}px`;
				}
			}
			if (isEditing && block.kind !== 'image') {
				// Padding symétrique pour laisser de la place au curseur en début/fin de texte.
				// On décale la boîte d'autant pour que le texte reste aligné sur le PDF dessous.
				const padX = EDIT_BLOCK_PAD_X;
				const padY = EDIT_BLOCK_PAD_Y;
				// On resserre la hauteur sur l'encre réelle (comme au repos) pour que le
				// cadre ne grossisse pas vers le bas en entrant en édition.
				const inkBox = !multiline ? textInkBox(block) : null;
				const baseTop = inkBox ? inkBox.top : block.y;
				const baseHeight = inkBox ? Math.max(inkBox.height, 6) : minHeight;
				const boxWidth = minWidth + padX * 2;
				const boxHeight = baseHeight + padY * 2;
				element.style.padding = `${padY}px ${padX}px`;
				element.style.left = `${block.x - padX}px`;
				// Pour un paragraphe, on remonte la boîte de la demi-marge d'interligne
				// pour que la 1re ligne soit pile sur le PDF (pas de "ligne vide" en haut).
				element.style.top = `${baseTop - padY - multilineHalfLeading}px`;
				element.style.width = `${boxWidth}px`;
				element.style.height = `${boxHeight}px`;
				element.style.minWidth = `${boxWidth}px`;
				element.style.minHeight = `${boxHeight}px`;
				const maxWidth = Math.max(boxWidth, (block.pageWidth || data.viewportWidth) - block.x - 4 + padX * 2);
				element.style.maxWidth = `${maxWidth}px`;
			}

			const textEdited = isBlockTextEdited(block);
			// Mode pristine : au double-clic, on ne peint pas de texte HTML opaque.
			// Le PDF reste visuellement intact ; on ne masque/révèle notre rendu
			// éditable qu'à la première modification réelle.
			const pristineInlineEdit = isEditing && block.kind !== 'image' && !editTouched;
			const showAsText = block.kind !== 'image' && (isEditing || (dirty && textEdited));
			const showAsSnapshot = dirty && !isEditing && !showAsText && !localGlyphEdited;

			if (showAsText) {
				if (block.htmlEdited && block.html) element.innerHTML = block.html;
				else element.textContent = block.text;
				if (!block.baseFontSize) {
					block.baseFontSize = block.pdfFontSize > 0
						? block.pdfFontSize
						: Math.max(8, Math.min(48, Math.round(block.height * 0.78)));
				}
				element.style.fontSize = `${block.baseFontSize}px`;
				applyBlockFontStyle(element, block);
				// En édition vierge, on rend notre texte invisible : le texte PDF
				// reste affiché dessous, donc rien ne bouge. Le curseur reste visible.
				if (pristineInlineEdit) element.classList.add('editing-pristine');
			} else if (showAsSnapshot) {
				// Bloc déplacé non ré-écrit (texte décoratif/logo OU texte standard) :
				// on rend le BITMAP d'origine pour préserver EXACTEMENT l'aspect (police
				// décorative type "Scott", logo vectoriel...). On dimensionne l'image à la
				// taille RÉELLE du bloc (pas 100% de la boîte) pour ne jamais l'étirer :
				// la boîte a une hauteur minimale (14px) qui déformait les petits textes.
				const snap = getBlockOriginalSnapshot(block, data);
				if (snap) {
					const img = document.createElement('img');
					img.src = snap;
					img.draggable = false;
					img.alt = '';
					img.style.width = `${Math.max(1, Math.round(block.width))}px`;
					img.style.height = `${Math.max(1, Math.round(block.height))}px`;
					img.style.display = 'block';
					img.style.pointerEvents = 'none';
					element.append(img);
				} else if (block.kind !== 'image') {
					element.textContent = block.text;
					if (!block.baseFontSize) {
						block.baseFontSize = block.pdfFontSize > 0
							? block.pdfFontSize
							: Math.max(8, Math.min(48, Math.round(block.height * 0.78)));
					}
					element.style.fontSize = `${block.baseFontSize}px`;
					applyBlockFontStyle(element, block);
				}
			}

			if (isEditing) {
				element.contentEditable = 'true';
				element.spellcheck = false;
				element.addEventListener('pointerdown', (event) => event.stopPropagation());
				element.addEventListener('click', (event) => {
					event.stopPropagation();
					if (Array.isArray(block.pdfChars) && block.pdfChars.length && !isBlockTextEdited(block)) {
						// Plage sélectionnée (clic de fin de glisser) : ne pas replacer le
						// caret, sinon le re-render annulerait la sélection avant suppression.
						if (selectionTextRange(element)) return;
						setPdfCaretFromPointer(event, block);
					}
				});
				element.addEventListener('keydown', (event) => {
					const glyphMode =
						Array.isArray(block.pdfChars) && block.pdfChars.length && !isBlockTextEdited(block);
					// Plage de texte sélectionnée + Suppr/Retour : on efface tout d'un coup.
					if (glyphMode && (event.key === 'Backspace' || event.key === 'Delete')) {
						const sel = selectionTextRange(element);
						if (sel) {
							event.preventDefault();
							event.stopPropagation();
							deletePdfTextRange(block, sel.start, sel.end);
							return;
						}
					}
					if (glyphMode && event.key === 'Backspace') {
						event.preventDefault();
						event.stopPropagation();
						deletePdfTextBeforeCaret(block);
						return;
					}
					if (glyphMode && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
						event.preventDefault();
						event.stopPropagation();
						movePdfCaret(block, event.key === 'ArrowLeft' ? -1 : 1);
						return;
					}
					// Frappe d'un caractère en mode glyphe : on bascule le bloc en
					// édition texte complète (le texte reconstruit inclut les
					// suppressions locales, et la lettre tapée est insérée au caret).
					if (
						glyphMode &&
						!event.metaKey &&
						!event.ctrlKey &&
						!event.altKey &&
						(event.key.length === 1 || event.key === 'Enter')
					) {
						event.preventDefault();
						event.stopPropagation();
						const typed = event.key === 'Enter' ? '\n' : event.key;
						// Si du texte est sélectionné, la frappe le REMPLACE (comme un
						// traitement de texte) au lieu de s'insérer après la sélection.
						const range = selectionTextRange(element);
						if (range) {
							replacePdfTextRange(block, range.start, range.end, typed);
						} else {
							insertPdfTextAtCaret(block, typed);
						}
						return;
					}
					if (event.key === 'Escape') {
						event.preventDefault();
						element.blur();
					}
				});
				// Collage : on insère du TEXTE BRUT (le HTML/styles de la source — Word,
				// PDF, navigateur — empilaient les lignes et imposaient des interlignes
				// nuls). Les sauts de ligne deviennent de vrais <br>.
				element.addEventListener('paste', (event) => {
					event.preventDefault();
					event.stopPropagation();
					const raw =
						(event.clipboardData && event.clipboardData.getData('text/plain')) || '';
					if (!raw) return;
					const clean = raw.replace(/\r\n?/g, '\n');
					const glyphMode =
						Array.isArray(block.pdfChars) && block.pdfChars.length && !isBlockTextEdited(block);
					if (glyphMode) {
						// Mode glyphe (texte PDF non ré-écrit) : on reconstruit via le pipeline
						// texte. Si du texte est sélectionné, on le REMPLACE (coller par-dessus) ;
						// sinon on insère au caret.
						const range = selectionTextRange(element);
						if (range) {
							replacePdfTextRange(block, range.start, range.end, clean);
						} else {
							insertPdfTextAtCaret(block, clean);
						}
						return;
					}
					const selection = window.getSelection();
					if (!selection || !selection.rangeCount) return;
					const range = selection.getRangeAt(0);
					range.deleteContents();
					const fragment = document.createDocumentFragment();
					clean.split('\n').forEach((line, index) => {
						if (index > 0) fragment.appendChild(document.createElement('br'));
						if (line) fragment.appendChild(document.createTextNode(line));
					});
					const lastNode = fragment.lastChild;
					range.insertNode(fragment);
					if (lastNode) {
						const after = document.createRange();
						after.setStartAfter(lastNode);
						after.collapse(true);
						selection.removeAllRanges();
						selection.addRange(after);
					}
					if (clean.includes('\n')) block.multiline = true;
					if (!block.inlineEditDirty) {
						ensureEditMask(element, block);
						element.classList.remove('editing-pristine');
					}
					block.inlineEditDirty = true;
					resizeEditingElementToContent(element, block);
				});
				element.addEventListener('input', () => {
					const firstEdit = !block.inlineEditDirty;
					block.inlineEditDirty = true;
					if (firstEdit) {
						// Première frappe : on masque le PDF et on rend notre texte opaque.
						// On garde le letter-spacing calé sur la largeur du PDF pour que
						// l'apparence reste identique (sinon le texte "bouge" en éditant).
						ensureEditMask(element, block);
						element.classList.remove('editing-pristine');
					}
					resizeEditingElementToContent(element, block);
				});
				element.addEventListener('blur', () => finishInlineEdit(block.id, element.innerText));
			} else {
				element.addEventListener('click', (event) => {
					event.stopPropagation();
					const now = Date.now();
					if (_lastBlockClick.id === block.id && now - _lastBlockClick.time < 320) {
						_lastBlockClick = { id: null, time: 0 };
						if (block.kind !== 'image') startInlineEdit(block.id);
					} else {
						_lastBlockClick = { id: block.id, time: now };
						selectEditBlock(block.id);
					}
				});
				element.addEventListener('pointerdown', (event) => startBlockDrag(event, block.id));
			}

			editLayer.append(element);

			// Images + logos non éditables : cadre CARRÉ dès le survol (classe posée
			// même hors sélection). Les poignées de redimensionnement (4 coins
			// proportionnels + 4 arêtes) n'apparaissent qu'une fois le bloc sélectionné.
			if (!isEditing && isResizableBlock(block)) {
				element.classList.add('resizable');
				if (isSelected) appendBlockResizeHandles(editLayer, block);
			}

			if (
				isEditing &&
				block.kind !== 'image' &&
				Array.isArray(block.pdfChars) &&
				block.pdfChars.length &&
				!textEdited
			) {
				const caret = caretBoxForBlock(block);
				if (caret) {
					// Clamp dans le cadre du bloc : les loose bounds d'un glyphe
					// (ascendantes/descendantes) peuvent dépasser la boîte du paragraphe.
					const frameTop = block.y - 1;
					const frameBottom = block.y + Math.max(block.height, 14) + 1;
					const top = Math.max(caret.y, frameTop);
					const bottom = Math.min(caret.y + Math.max(8, caret.height), frameBottom);
					const caretNode = document.createElement('div');
					caretNode.className = 'alto-pdf-caret';
					caretNode.style.left = `${caret.x}px`;
					caretNode.style.top = `${top}px`;
					caretNode.style.height = `${Math.max(8, bottom - top)}px`;
					editLayer.append(caretNode);
				}
			}

			if ((showAsText || (showAsSnapshot && element.textContent)) && block.kind !== 'image') {
				matchFontFromTextLayer(element, block, data);
				applyBlockFormatOverrides(element, block);
			}

			// Bloc texte ré-écrit (police/texte modifiés) : recaler la boîte sur la
			// hauteur RÉELLE de la police choisie, ancrée à la ligne de base d'origine.
			if (showAsText && !isEditing && !multiline && block.kind !== 'image') {
				recenterDirtyTextBox(element, block);
			}
		});
}

function applyBlockFormatOverrides(element, block) {
	if (block.fontFamilyOverride) {
		element.style.fontFamily = block.fontFamilyOverride;
	} else if (block.fontName) {
		const base = baseFamilyName(cleanFontName(block.fontName));
		if (base) {
			ensureCloudFont(base);
			// Le vrai nom de police EN PREMIER (installée / Google Fonts), puis le
			// repli déjà calculé par matchFontFromTextLayer.
			const current = element.style.fontFamily;
			element.style.fontFamily = current && !current.toLowerCase().includes(base.toLowerCase())
				? `"${base}", ${current}`
				: `"${base}"`;
		}
	}
	if (block.fontSizeOverride) element.style.fontSize = `${block.fontSizeOverride}px`;
	// La police copiée depuis le text layer PDF.js porte déjà le vrai gras/italique.
	// On ne force le poids/style que si l'utilisateur les a explicitement basculés.
	if (block.boldOverride === true) element.style.fontWeight = '700';
	else if (block.boldOverride === false) element.style.fontWeight = '400';
	if (block.italicOverride === true) element.style.fontStyle = 'italic';
	else if (block.italicOverride === false) element.style.fontStyle = 'normal';
	element.style.textDecoration = block.underline ? 'underline' : 'none';
	if (block.color) element.style.color = block.color;
	if (block.align) element.style.textAlign = block.align;
}

function fitEditTextWidth(element, block) {
	// Espacement NATUREL : on n'étire plus le texte avec letter-spacing (ça créait
	// des trous visibles entre les lettres). Avec la vraie police, la largeur colle
	// déjà au PDF ; sur du texte justifié on assume un bord droit non aligné (comme
	// Acrobat) plutôt que des espaces inter-lettres parasites.
	if (!element) return;
	element.style.letterSpacing = '0px';
}

function resizeEditingElementToContent(element, block) {
	if (!element || !block) return;
	const padX = EDIT_BLOCK_PAD_X;
	const padY = EDIT_BLOCK_PAD_Y;
	// Hauteur mini calée sur l'encre réelle (pas les bornes lâches du bloc) pour
	// que le cadre d'édition ne grossisse pas vers le bas comme au repos.
	const inkBox = !block.multiline ? textInkBox(block) : null;
	const baseHeight = inkBox ? Math.max(inkBox.height, 6) : block.height;
	const minBoxHeight = baseHeight + padY * 2;
	if (block.multiline) {
		// Espacement naturel, pas de reflow (les lignes ne cassent que sur les \n
		// d'origine), largeur = largeur naturelle de notre texte.
		element.style.letterSpacing = '0px';
		element.style.whiteSpace = 'pre';
		element.style.width = 'auto';
		const naturalWidth = Math.ceil(element.scrollWidth);
		element.style.width = `${Math.max(naturalWidth, block.width + padX * 2)}px`;
		element.style.height = 'auto';
		element.style.height = `${Math.max(minBoxHeight, Math.ceil(element.scrollHeight))}px`;
		return;
	}
	const minBoxWidth = block.width + padX * 2;
	// Mesure la taille réelle du contenu en libérant la largeur, sinon scrollWidth
	// reste bridé par la largeur déjà fixée et la boîte ne grandit jamais.
	element.style.width = 'auto';
	element.style.height = 'auto';
	const contentWidth = Math.ceil(element.scrollWidth);
	const contentHeight = Math.ceil(element.scrollHeight);
	const maxWidth = Math.max(minBoxWidth, (block.pageWidth || block.width) - block.x - 4 + padX * 2);
	const nextWidth = Math.min(maxWidth, Math.max(minBoxWidth, contentWidth));
	const nextHeight = Math.max(minBoxHeight, contentHeight);
	element.style.width = `${nextWidth}px`;
	element.style.height = `${nextHeight}px`;
}

function placeCaretAtEnd(element) {
	const range = document.createRange();
	range.selectNodeContents(element);
	range.collapse(false);
	const selection = window.getSelection();
	selection.removeAllRanges();
	selection.addRange(range);
}

function shouldStartSnapshotTextEdit(event) {
	if (event.metaKey || event.ctrlKey || event.altKey) return false;
	return event.key.length === 1 || event.key === 'Backspace' || event.key === 'Enter';
}

function ensureEditMask(element, block) {
	// Couvre le texte PDF d'origine dès qu'on bascule en saisie réelle.
	const editLayer = element.parentElement;
	if (!editLayer || editLayer.querySelector(`.edit-block-mask[data-mask-for="${block.id}"]`)) {
		return;
	}
	const mask = document.createElement('div');
	mask.className = 'edit-block-mask';
	mask.dataset.maskFor = block.id;
	mask.style.left = `${block.originalX - 1.5}px`;
	mask.style.top = `${block.originalY - 1.5}px`;
	mask.style.width = `${Math.max(block.width, block.originalWidth || block.width, 18) + 3}px`;
	mask.style.height = `${Math.max(block.height, block.originalHeight || block.height, 14) + 3}px`;
	editLayer.insertBefore(mask, editLayer.firstChild);
}

// Retourne { index, affinity }. L'affinité indique de quel côté le caret se
// rattache : 'prev' = après le caractère précédent (fin de ligne), 'next' =
// avant le caractère suivant. Indispensable en fin de ligne : sans elle, un
// caret placé après le dernier caractère se dessinerait au début de la ligne
// suivante.
function hitTestPdfCaret(block, pageX, pageY) {
	const chars = Array.isArray(block?.pdfChars) ? block.pdfChars : [];
	if (!chars.length) return { index: 0, affinity: 'next' };

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
	for (const line of lines) {
		line.chars.sort((a, b) => a.x - b.x);
	}
	const activeLine = lines
		.sort((a, b) => Math.abs(pageY - (a.y + a.height / 2)) - Math.abs(pageY - (b.y + b.height / 2)))[0];
	if (activeLine?.chars?.length) {
		const first = activeLine.chars[0];
		const last = activeLine.chars[activeLine.chars.length - 1];
		if (pageX <= first.x) return { index: first.index, affinity: 'next' };
		if (pageX >= last.x + last.width) return { index: last.index + 1, affinity: 'prev' };
	}

	let best = null;
	let bestScore = Infinity;
	for (const ch of activeLine?.chars || chars) {
		const cy = ch.y + ch.height / 2;
		const dy = Math.abs(pageY - cy);
		const withinY = pageY >= ch.y - ch.height * 0.4 && pageY <= ch.y + ch.height * 1.4;
		const dx = pageX < ch.x ? ch.x - pageX : pageX > ch.x + ch.width ? pageX - (ch.x + ch.width) : 0;
		const score = dy * (withinY ? 1 : 4) + dx * 0.35;
		if (score < bestScore) {
			bestScore = score;
			best = ch;
		}
	}
	if (!best) return { index: chars[chars.length - 1].index + 1, affinity: 'prev' };
	return pageX <= best.x + best.width / 2
		? { index: best.index, affinity: 'next' }
		: { index: best.index + 1, affinity: 'prev' };
}

function setPdfCaretFromPointer(event, block) {
	const data = getPageData(block.page);
	const rect = data?.editLayer?.getBoundingClientRect();
	if (!rect) return;
	const pageX = event.clientX - rect.left;
	const pageY = event.clientY - rect.top;
	const hit = hitTestPdfCaret(block, pageX, pageY);
	block.localCaretIndex = hit.index;
	block.localCaretAffinity = hit.affinity;
	renderEditBlocks();
	requestAnimationFrame(() => {
		const next = elements.pagesStack.querySelector(`.edit-block.editing[data-block-id="${block.id}"]`);
		if (next) next.focus({ preventScroll: true });
	});
}

function caretBoxForBlock(block) {
	const chars = Array.isArray(block?.pdfChars) ? block.pdfChars : [];
	if (!chars.length) return null;
	const caretIndex = Number.isFinite(block.localCaretIndex) ? block.localCaretIndex : chars[chars.length - 1].index + 1;
	const next = chars.find((ch) => ch.index >= caretIndex);
	const prev = [...chars].reverse().find((ch) => ch.index < caretIndex);
	// Affinité 'prev' : le caret se dessine en fin de ligne, après le caractère
	// précédent — jamais au début de la ligne suivante.
	if (block.localCaretAffinity === 'prev' && prev) {
		return { x: prev.x + prev.width, y: prev.y, height: prev.height };
	}
	if (next) return { x: next.x, y: next.y, height: next.height };
	if (prev) return { x: prev.x + prev.width, y: prev.y, height: prev.height };
	return null;
}

// Décalages [start, end) de la sélection courante DANS le texte de l'élément
// éditable (null si aucune sélection ou sélection vide). Sert à supprimer
// plusieurs caractères d'un coup en mode glyphe.
function selectionTextRange(element) {
	const sel = window.getSelection();
	if (!sel || sel.rangeCount === 0) return null;
	const range = sel.getRangeAt(0);
	if (range.collapsed) return null;
	if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return null;
	const pre = range.cloneRange();
	pre.selectNodeContents(element);
	pre.setEnd(range.startContainer, range.startOffset);
	const start = pre.toString().length;
	const end = start + range.toString().length;
	if (end <= start) return null;
	return { start, end };
}

// Suppression d'une PLAGE sélectionnée en mode glyphe : on bascule en édition
// texte (comme la suppression au caret) en retirant tout l'intervalle d'un coup.
function deletePdfTextRange(block, start, end) {
	if (!block || !Array.isArray(block.pdfChars) || !block.pdfChars.length) return false;
	const lines = pdfCharLines(block);
	if (!lines.length) return false;
	const text = pdfLinesText(lines);
	const from = Math.max(0, Math.min(start, text.length));
	const to = Math.max(from, Math.min(end, text.length));
	if (to <= from) return false;
	pushHistory();
	block.text = text.slice(0, from) + text.slice(to);
	block.textEdited = true;
	block.inlineEditDirty = true;
	block.hiddenCharIndexes = [];
	block.localGlyphEdited = false;
	block.localCaretIndex = null;
	block.snapshotDataUrl = null;
	state.selectedBlockId = block.id;
	elements.editText.value = block.text;
	elements.editTextPanel.value = block.text;
	markDirty();
	renderEditBlocks();
	requestAnimationFrame(() => {
		const next = elements.pagesStack.querySelector(`.edit-block.editing[data-block-id="${block.id}"]`);
		if (!next) return;
		next.focus({ preventScroll: true });
		placeCaretAtTextOffset(next, from);
	});
	return true;
}

// Remplacement d'une PLAGE sélectionnée par du texte (collage « par-dessus »)
// en mode glyphe : on retire l'intervalle et on insère le texte à la place, en
// basculant le bloc en édition texte (comme deletePdfTextRange).
function replacePdfTextRange(block, start, end, insertText) {
	if (!block || !Array.isArray(block.pdfChars) || !block.pdfChars.length) return false;
	const lines = pdfCharLines(block);
	if (!lines.length) return false;
	const text = pdfLinesText(lines);
	const from = Math.max(0, Math.min(start, text.length));
	const to = Math.max(from, Math.min(end, text.length));
	const inserted = insertText || '';
	pushHistory();
	block.text = text.slice(0, from) + inserted + text.slice(to);
	block.textEdited = true;
	block.inlineEditDirty = true;
	block.hiddenCharIndexes = [];
	block.localGlyphEdited = false;
	block.localCaretIndex = null;
	block.snapshotDataUrl = null;
	state.selectedBlockId = block.id;
	elements.editText.value = block.text;
	elements.editTextPanel.value = block.text;
	markDirty();
	renderEditBlocks();
	requestAnimationFrame(() => {
		const next = elements.pagesStack.querySelector(`.edit-block.editing[data-block-id="${block.id}"]`);
		if (!next) return;
		next.focus({ preventScroll: true });
		placeCaretAtTextOffset(next, from + inserted.length);
	});
	return true;
}

// Suppression en mode glyphe : comme un traitement de texte, le bloc bascule
// en édition texte HTML pour que le texte situé après la suppression se
// recolle naturellement (reflow), au lieu de laisser un blanc.
function deletePdfTextBeforeCaret(block) {
	if (!block || !Array.isArray(block.pdfChars) || !block.pdfChars.length) return false;
	const lines = pdfCharLines(block);
	if (!lines.length) return false;
	const caretIndex = Number.isFinite(block.localCaretIndex)
		? block.localCaretIndex
		: block.pdfChars[block.pdfChars.length - 1].index + 1;
	const caretOffset = pdfCaretTextOffset(block, lines, caretIndex);
	const text = pdfLinesText(lines);
	if (caretOffset === 0) return false;
	const deletePos = caretOffset - 1;
	pushHistory();
	block.text = text.slice(0, deletePos) + text.slice(deletePos + 1);
	block.textEdited = true;
	block.inlineEditDirty = true;
	block.hiddenCharIndexes = [];
	block.localGlyphEdited = false;
	block.localCaretIndex = null;
	block.snapshotDataUrl = null;
	state.selectedBlockId = block.id;
	elements.editText.value = block.text;
	elements.editTextPanel.value = block.text;
	markDirty();
	renderEditBlocks();
	requestAnimationFrame(() => {
		const next = elements.pagesStack.querySelector(`.edit-block.editing[data-block-id="${block.id}"]`);
		if (!next) return;
		next.focus({ preventScroll: true });
		placeCaretAtTextOffset(next, deletePos);
	});
	return true;
}

// Déplacement du caret personnalisé aux flèches gauche/droite en mode glyphe.
function movePdfCaret(block, direction) {
	const ordered = [...visiblePdfChars(block)].sort((a, b) => a.index - b.index);
	if (!ordered.length) return;
	const caretIndex = Number.isFinite(block.localCaretIndex)
		? block.localCaretIndex
		: ordered[ordered.length - 1].index + 1;
	if (direction < 0) {
		const prev = [...ordered].reverse().find((ch) => ch.index < caretIndex);
		if (!prev) return;
		block.localCaretIndex = prev.index;
		block.localCaretAffinity = 'next';
	} else {
		const next = ordered.find((ch) => ch.index >= caretIndex);
		if (!next) return;
		block.localCaretIndex = next.index + 1;
		block.localCaretAffinity = 'prev';
	}
	renderEditBlocks();
	requestAnimationFrame(() => {
		const el = elements.pagesStack.querySelector(`.edit-block.editing[data-block-id="${block.id}"]`);
		if (el) el.focus({ preventScroll: true });
	});
}

function pdfCharLines(block) {
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

function pdfLinesText(lines) {
	return lines.map((line) => line.chars.map((ch) => ch.text).join('')).join('\n');
}

// Offset texte du caret dans la reconstruction ligne par ligne. L'affinité
// 'prev' ancre le caret APRÈS le dernier caractère qui précède (fin de ligne),
// sinon AVANT le premier caractère qui suit — la différence compte aux
// frontières de ligne, où un '\n' est inséré entre les deux.
function pdfCaretTextOffset(block, lines, caretIndex) {
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

// Frappe en mode glyphe : reconstruit le texte du bloc à partir des glyphes
// VISIBLES (suppressions locales incluses), insère le texte tapé au caret, et
// bascule le bloc en édition texte HTML classique avec le caret natif placé
// au bon endroit.
function insertPdfTextAtCaret(block, insertText) {
	const lines = pdfCharLines(block);
	if (!lines.length || !insertText) return false;
	const caretIndex = Number.isFinite(block.localCaretIndex)
		? block.localCaretIndex
		: block.pdfChars[block.pdfChars.length - 1].index + 1;
	const caretOffset = pdfCaretTextOffset(block, lines, caretIndex);
	const text = pdfLinesText(lines);
	pushHistory();
	block.text = `${text.slice(0, caretOffset)}${insertText}${text.slice(caretOffset)}`;
	block.textEdited = true;
	block.inlineEditDirty = true;
	block.hiddenCharIndexes = [];
	block.localGlyphEdited = false;
	block.localCaretIndex = null;
	block.snapshotDataUrl = null;
	state.selectedBlockId = block.id;
	elements.editText.value = block.text;
	elements.editTextPanel.value = block.text;
	markDirty();
	renderEditBlocks();
	requestAnimationFrame(() => {
		const next = elements.pagesStack.querySelector(`.edit-block.editing[data-block-id="${block.id}"]`);
		if (!next) return;
		next.focus({ preventScroll: true });
		placeCaretAtTextOffset(next, caretOffset + insertText.length);
	});
	return true;
}

function placeCaretAtTextOffset(element, offset) {
	const selection = window.getSelection();
	if (!selection) return;
	const range = document.createRange();
	let remaining = Math.max(0, offset);
	const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
	let node = walker.nextNode();
	let placed = false;
	while (node) {
		const length = node.textContent.length;
		if (remaining <= length) {
			range.setStart(node, remaining);
			range.collapse(true);
			placed = true;
			break;
		}
		remaining -= length;
		node = walker.nextNode();
	}
	if (!placed) {
		range.selectNodeContents(element);
		range.collapse(false);
	}
	selection.removeAllRanges();
	selection.addRange(range);
}

function startSnapshotTextEdit(element, block, event) {
	block.inlineEditDirty = true;
	element.classList.remove('snapshot-editing');
	element.style.backgroundImage = '';
	element.contentEditable = 'true';
	ensureEditMask(element, block);
	element.focus();
	placeCaretAtEnd(element);

	if (event.key === 'Backspace') {
		element.textContent = (element.textContent || '').slice(0, -1);
	} else if (event.key === 'Enter') {
		element.textContent = `${element.textContent || ''}\n`;
	} else if (event.key.length === 1) {
		element.textContent = `${element.textContent || ''}${event.key}`;
	}
	placeCaretAtEnd(element);
	resizeEditingElementToContent(element, block);
}

// Un "logo" = gros bloc d'affichage dont la police décorative n'est NI installée
// NI chargeable (ex. "Scott"). L'éditer en HTML retomberait sur une police
// générique => le glyphe change d'aspect (carré blanc / texte différent). On le
// laisse donc déplaçable mais NON éditable.
function isLogoBlock(block) {
	if (!block || block.kind === 'image') return false;
	if ((block.pdfFontSize || 0) < 22) return false;
	const base = baseFamilyName(cleanFontName(block.fontName));
	if (!base) return false;
	return !isFontInstalled(base);
}

function startInlineEdit(id) {
	const block = state.editBlocks.find((candidate) => candidate.id === id);
	if (!block || block.kind === 'image') return;
	if (isLogoBlock(block)) {
		const base = baseFamilyName(cleanFontName(block.fontName)) || '';
		setStatus(
			base
				? `Logo non éditable (police « ${base} » non détectée). Vous pouvez le déplacer.`
				: 'Logo non éditable. Vous pouvez le déplacer.',
			'info'
		);
		selectEditBlock(id);
		return;
	}
	block.inlineEditDirty = false;
	if (Array.isArray(block.pdfChars) && block.pdfChars.length && !Number.isFinite(block.localCaretIndex)) {
		block.localCaretIndex = block.pdfChars[block.pdfChars.length - 1].index + 1;
	}
	refreshBlockFontInfo(block);
	state.editingBlockId = id;
	state.selectedBlockId = id;
	renderEditBlocks();
	requestAnimationFrame(() => {
		const element = elements.pagesStack.querySelector(`.edit-block.editing[data-block-id="${id}"]`);
		if (!element) return;
		// Le letter-spacing ne sert QUE pour un bloc vierge (caler le texte invisible
		// sur le PDF dessous). Pour un bloc déjà édité, on garde l'espacement naturel,
		// sinon on ré-applique un décalage/rétrécissement à chaque entrée en édition.
		const pristine = !isBlockTextEdited(block);
		if (pristine && !block.multiline) {
			fitEditTextWidth(element, block);
		} else {
			element.style.letterSpacing = '0px';
		}
		resizeEditingElementToContent(element, block);
		element.focus();
		placeCaretAtEnd(element);
	});
}

function finishInlineEdit(id, newText) {
	if (state.editingBlockId !== id) return;
	const element = elements.pagesStack.querySelector(`.edit-block.editing[data-block-id="${id}"]`);
	state.editingBlockId = null;
	const editSnapshot = captureEditableSnapshot();
	const block = state.editBlocks.find((candidate) => candidate.id === id);
	if (block) {
		// Une "vraie" frappe a-t-elle eu lieu ? En mode glyphe (suppression locale),
		// l'utilisateur n'a jamais tapé : innerText peut diverger de block.text par
		// simple normalisation d'espaces, et on basculait à tort le bloc en rendu
		// HTML opaque (carré blanc vide). On ne diff le texte que si frappe réelle.
		const typed = Boolean(block.inlineEditDirty || block.htmlEdited);
		block.inlineEditDirty = false;
		const trimmed = (newText || '')
			.replace(/\r\n?/g, '\n')
			.split('\n')
			.map((line) => line.replace(/[\t ]+/g, ' ').trimEnd())
			.join('\n')
			.replace(/^\n+|\n+$/g, '');
		const textChanged = typed && trimmed && trimmed !== block.text;
		// On ne touche JAMAIS la géométrie du bloc si le texte n'a pas changé,
		// sinon le padding d'édition ferait grossir le bloc à chaque entrée/sortie.
		if (textChanged) {
			block.text = trimmed;
			block.textEdited = true;
			block.snapshotDataUrl = null;
			elements.editText.value = block.text;
			elements.editTextPanel.value = block.text;
			if (element) {
				const nextHeight = Math.max(14, Math.ceil(element.scrollHeight) - EDIT_BLOCK_PAD_Y * 2);
				if (!block.multiline) {
					const nextWidth = Math.max(40, Math.ceil(element.scrollWidth) - EDIT_BLOCK_PAD_X * 2);
					block.width = Math.min(block.pageWidth - block.x, nextWidth);
				}
				block.height = Math.min(block.pageHeight - block.y, nextHeight);
			}
			commitSnapshot(editSnapshot);
			markDirty();
		}
		// Capture des runs de formatage partiel (gras/italique/souligné sur un
		// morceau du texte) si l'utilisateur en a appliqué pendant l'édition.
		if (typed && element && (block.htmlEdited || element.querySelector('span,b,i,u,strong,em,font'))) {
			block.html = element.innerHTML;
			block.htmlEdited = true;
			block.textEdited = true;
			block.text = (element.innerText || block.text)
				.replace(/\r\n?/g, '\n')
				.replace(/[\t ]+/g, ' ')
				.replace(/^\n+|\n+$/g, '');
			const nextHeight = Math.max(14, Math.ceil(element.scrollHeight) - EDIT_BLOCK_PAD_Y * 2);
			if (!block.multiline) {
				const nextWidth = Math.max(40, Math.ceil(element.scrollWidth) - EDIT_BLOCK_PAD_X * 2);
				block.width = Math.min(block.pageWidth - block.x, nextWidth);
			}
			block.height = Math.min(block.pageHeight - block.y, nextHeight);
			markDirty();
		}
	}
	renderEditBlocks();
	updateSelectedEditField();
}

function selectEditBlock(id) {
	state.selectedBlockId = id;
	state.selectedBlockIds = id ? [id] : [];
	const block = state.editBlocks.find((candidate) => candidate.id === id);
	if (block) refreshBlockFontInfo(block);
	renderEditBlocks();
	updateSelectedEditField();
	closeDrawer();
	state.settings.showTools = true;
	elements.settingShowTools.checked = true;
	saveSettings();
	updateUi(false);
}

function selectedEditBlock() {
	return state.editBlocks.find((block) => block.id === state.selectedBlockId) || null;
}

// Un bloc est sélectionné s'il est le primaire OU dans la sélection multiple.
function isBlockSelected(block) {
	if (!block) return false;
	return (
		block.id === state.selectedBlockId ||
		(Array.isArray(state.selectedBlockIds) && state.selectedBlockIds.includes(block.id))
	);
}

// Vide toute la sélection (primaire + multiple). Retourne true si quelque chose
// a changé.
function clearBlockSelection() {
	const had = state.selectedBlockId || (state.selectedBlockIds && state.selectedBlockIds.length);
	state.selectedBlockId = null;
	state.selectedBlockIds = [];
	return Boolean(had);
}

function updateSelectedEditField() {
	const block = selectedEditBlock();
	const value = block?.text || '';
	const canEditText = Boolean(block && block.kind !== 'image');
	for (const field of [elements.editText, elements.editTextPanel]) {
		field.value = value;
		field.disabled = !canEditText;
	}
	for (const button of [elements.applyEditText, elements.applyEditTextPanel]) {
		button.disabled = !canEditText;
	}
	for (const button of [elements.deleteEditBlock, elements.deleteEditBlockPanel]) {
		button.disabled = !block;
	}
	updateFormatPanel(block);
}

function updateFormatPanel(block) {
	const panel = elements.formatPanel;
	if (!panel) return;
	void ensureFontSelectPopulated();
	const active = Boolean(block && block.kind !== 'image');
	panel.dataset.empty = active ? 'false' : 'true';

	const controls = [
		elements.fontComboTrigger,
		elements.formatSize,
		elements.formatColor,
		elements.formatBold,
		elements.formatItalic,
		elements.formatUnderline,
		...elements.formatAlignButtons
	];
	for (const control of controls) {
		if (control) control.disabled = !active;
	}
	if (!active) {
		closeFontCombo();
		return;
	}

	const detected = cleanFontName(block.fontName);
	_fontComboAutoLabel = detected ? `Auto : ${detected}` : 'Police détectée';
	if (detected) ensureCloudFont(baseFamilyName(detected));

	setFontComboValue(block.fontFamilyOverride || '');
	if (isFontComboOpen()) renderFontComboList(elements.fontComboSearch?.value);
	updateFontWarning(detected);
	const size = block.fontSizeOverride || block.baseFontSize || (block.pdfFontSize > 0 ? Math.round(block.pdfFontSize) : Math.max(8, Math.round(block.height * 0.78)));
	elements.formatSize.value = Math.round(size * 10) / 10;
	elements.formatColor.value = block.color || '#161616';
	const effBold = block.boldOverride !== undefined ? block.boldOverride : Boolean(block.bold);
	const effItalic = block.italicOverride !== undefined ? block.italicOverride : Boolean(block.italic);
	elements.formatBold.classList.toggle('active', effBold);
	elements.formatItalic.classList.toggle('active', effItalic);
	elements.formatUnderline.classList.toggle('active', Boolean(block.underline));
	const align = block.align || 'left';
	for (const button of elements.formatAlignButtons) {
		button.classList.toggle('active', button.dataset.align === align);
	}
}

function ensureFontWarningNode() {
	let node = document.getElementById('format-font-warning');
	if (node) return node;
	const panel = elements.formatPanel;
	if (!panel) return null;
	node = document.createElement('div');
	node.id = 'format-font-warning';
	node.className = 'format-font-warning';
	node.hidden = true;
	const fontField = elements.fontCombo || elements.fontComboTrigger?.parentElement;
	if (fontField && fontField.parentElement) {
		fontField.insertAdjacentElement('afterend', node);
	} else {
		panel.append(node);
	}
	return node;
}

function isFontAvailable(family) {
	if (!family) return true;
	try {
		return document.fonts.check(`16px "${family}"`);
	} catch (_err) {
		return true;
	}
}

// Détection FIABLE d'une police réellement disponible (installée système OU
// webfont chargée). `document.fonts.check()` renvoie `true` pour n'importe quel
// nom inconnu (il ne traque que les @font-face), donc inutilisable pour savoir
// si une police décorative type "Scott" existe. Technique canvas : on mesure la
// largeur d'un texte témoin avec la police demandée en repli sur 3 génériques.
// Si la largeur diffère du générique pour AU MOINS un repli, la police est bien
// présente ; sinon elle n'existe pas (le navigateur est retombé sur le repli).
const _fontInstalledCache = new Map();
function isFontInstalled(family) {
	if (!family) return true;
	const key = family.toLowerCase();
	if (_fontInstalledCache.has(key)) return _fontInstalledCache.get(key);
	let result = false;
	try {
		const canvas = document.createElement('canvas');
		const ctx = canvas.getContext('2d');
		const text = 'mmmmmmmmmmlli Wjgq SERVITEC 0123';
		const size = '72px';
		const bases = ['monospace', 'serif', 'sans-serif'];
		for (const base of bases) {
			ctx.font = `${size} ${base}`;
			const baseW = ctx.measureText(text).width;
			ctx.font = `${size} "${family}", ${base}`;
			const testW = ctx.measureText(text).width;
			if (Math.abs(testW - baseW) > 0.5) {
				result = true;
				break;
			}
		}
	} catch (_err) {
		result = true;
	}
	// On ne met en cache QUE les résultats positifs : une webfont peut se charger
	// en différé, donc un "non installé" doit pouvoir être réévalué plus tard.
	if (result) _fontInstalledCache.set(key, result);
	return result;
}

function updateFontWarning(detected) {
	const node = ensureFontWarningNode();
	if (!node) return;
	const base = detected ? baseFamilyName(detected) : '';
	if (!base) {
		node.hidden = true;
		return;
	}
	const reveal = () => {
		if (isFontAvailable(base)) {
			node.hidden = true;
			return;
		}
		const query = encodeURIComponent(base);
		node.innerHTML = '';
		const icon = document.createElement('span');
		icon.className = 'format-font-warning-icon';
		icon.textContent = '!';
		const label = document.createElement('span');
		label.className = 'format-font-warning-label';
		label.textContent = `Police « ${base} » non installée`;
		const link = document.createElement('button');
		link.type = 'button';
		link.className = 'format-font-warning-link';
		link.textContent = 'Télécharger';
		link.addEventListener('click', () => {
			invokeCommand('open_external', { url: `https://fonts.google.com/?query=${query}` }).catch(() => {});
		});
		node.append(icon, label, link);
		node.hidden = false;
	};
	// La police cloud peut arriver de façon asynchrone : on revérifie après chargement.
	reveal();
	if (!node.hidden && document.fonts?.ready) {
		setTimeout(reveal, 900);
	}
}

function applyFormatChange(mutator) {
	const block = selectedEditBlock();
	if (!block || block.kind === 'image') return;
	const wasEditing = state.editingBlockId === block.id;
	pushHistory();
	mutator(block);
	block.textEdited = true;
	block.snapshotDataUrl = null;
	markDirty();
	renderEditBlocks();
	updateSelectedEditField();
	// Si on était en édition, le re-render recrée l'élément : on rétablit le focus
	// et le curseur pour ne pas sortir du mode saisie en cliquant sur B/I/U.
	if (wasEditing && state.editingBlockId === block.id) {
		requestAnimationFrame(() => {
			const element = elements.pagesStack.querySelector(
				`.edit-block.editing[data-block-id="${block.id}"]`
			);
			if (element) {
				element.focus();
				placeCaretAtEnd(element);
			}
		});
	}
}

// Applique un style (gras/italique/souligné) UNIQUEMENT à la portion de texte
// sélectionnée dans le bloc en cours d'édition, via execCommand. Renvoie true si
// l'opération a porté sur une vraie sélection (sinon on retombe sur le toggle global).
function applyInlineStyleToSelection(command) {
	if (!state.editingBlockId) return false;
	const block = state.editBlocks.find((candidate) => candidate.id === state.editingBlockId);
	if (!block || block.kind === 'image') return false;
	const editing = elements.pagesStack.querySelector(
		`.edit-block.editing[data-block-id="${state.editingBlockId}"]`
	);
	if (!editing) return false;
	const selection = window.getSelection();
	if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
	if (!editing.contains(selection.anchorNode) || !editing.contains(selection.focusNode)) return false;

	pushHistory();
	// styleWithCSS : produit des <span style="font-weight:...">, plus simple à
	// reparser pour l'export que des <b>/<font>.
	try {
		document.execCommand('styleWithCSS', false, 'true');
	} catch (_err) {}
	document.execCommand(command, false, null);

	// Espacement naturel : le letter-spacing servait à caler le texte vierge sur le
	// PDF ; une fois le formatage modifié, on évite qu'il déforme/rogne les runs.
	editing.classList.remove('editing-pristine');
	editing.style.letterSpacing = '0px';
	ensureEditMask(editing, block);
	resizeEditingElementToContent(editing, block);

	block.html = editing.innerHTML;
	block.text = editing.innerText;
	block.htmlEdited = true;
	block.textEdited = true;
	block.inlineEditDirty = true;
	block.snapshotDataUrl = null;
	markDirty();
	updateFormatPanel(block);
	editing.focus();
	return true;
}

function applySelectedText() {
	const block = selectedEditBlock();
	if (!block || block.kind === 'image') return;
	const activePanelText = state.editMode && state.settings.showTools ? elements.editTextPanel.value : elements.editText.value;
	const nextText = activePanelText.trim();
	if (!nextText || nextText === block.text) return;
	pushHistory();
	block.text = nextText;
	block.textEdited = true;
	block.snapshotDataUrl = null;
	elements.editText.value = block.text;
	elements.editTextPanel.value = block.text;
	markDirty();
	renderEditBlocks();
}

function hideSelectedBlock() {
	// Réunit le primaire + la sélection multiple (sans doublon).
	const ids = new Set(state.selectedBlockIds || []);
	if (state.selectedBlockId) ids.add(state.selectedBlockId);
	const targets = state.editBlocks.filter((block) => ids.has(block.id));
	if (!targets.length) return;
	pushHistory();
	for (const block of targets) block.hidden = true;
	clearBlockSelection();
	markDirty();
	renderEditBlocks();
	updateSelectedEditField();
}

function startBlockDrag(event, id) {
	if (!state.editMode) return;
	if (state.editingBlockId === id) return;
	const block = state.editBlocks.find((candidate) => candidate.id === id);
	if (!block) return;

	const startX = event.clientX;
	const startY = event.clientY;
	const initialX = block.x;
	const initialY = block.y;
	const dragSnapshot = captureEditableSnapshot();
	let dragging = false;

	const onMove = (moveEvent) => {
		if (!dragging) {
			const dx = moveEvent.clientX - startX;
			const dy = moveEvent.clientY - startY;
			if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
			dragging = true;
			selectEditBlock(id);
		}
		let nextX = Math.max(0, Math.min(block.pageWidth - block.width, initialX + moveEvent.clientX - startX));
		let nextY = Math.max(0, Math.min(block.pageHeight - block.height, initialY + moveEvent.clientY - startY));
		const result = state.settings.showAlignmentGuides
			? computeAlignmentGuides(block, nextX, nextY)
			: { x: nextX, y: nextY, guides: [] };
		block.x = result.x;
		block.y = result.y;
		renderEditBlocksForPage(block.page);
		renderAlignmentGuides(result.guides, block.page);
	};
	const onUp = () => {
		window.removeEventListener('pointermove', onMove);
		window.removeEventListener('pointerup', onUp);
		clearAlignmentGuides();
		if (dragging && (block.x !== initialX || block.y !== initialY)) {
			commitSnapshot(dragSnapshot);
			markDirty();
		}
	};

	window.addEventListener('pointermove', onMove);
	window.addEventListener('pointerup', onUp);
}

// Un bloc est redimensionnable s'il s'agit d'une image, ou d'un logo (texte dont la
// police n'est pas installée → non éditable, manipulé comme un visuel).
function isResizableBlock(block) {
	if (!block) return false;
	return block.kind === 'image' || isLogoBlock(block);
}

const RESIZE_HANDLE_DIRS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

function appendBlockResizeHandles(editLayer, block) {
	const left = block.x;
	const top = block.y;
	const w = Math.max(block.width, 8);
	const h = Math.max(block.height, 8);
	for (const dir of RESIZE_HANDLE_DIRS) {
		const handle = document.createElement('div');
		handle.className = `block-resize-handle handle-${dir}`;
		let hx = left + w / 2;
		if (dir.includes('e')) hx = left + w;
		else if (dir.includes('w')) hx = left;
		let hy = top + h / 2;
		if (dir.includes('s')) hy = top + h;
		else if (dir.includes('n')) hy = top;
		handle.style.left = `${hx}px`;
		handle.style.top = `${hy}px`;
		handle.dataset.dir = dir;
		handle.addEventListener('pointerdown', (event) => startBlockResize(event, block.id, dir));
		editLayer.append(handle);
	}
}

function startBlockResize(event, id, dir) {
	if (!state.editMode) return;
	event.preventDefault();
	event.stopPropagation();
	const block = state.editBlocks.find((candidate) => candidate.id === id);
	if (!block) return;

	selectEditBlock(id);
	const startX = event.clientX;
	const startY = event.clientY;
	const initX = block.x;
	const initY = block.y;
	const initW = Math.max(8, block.width);
	const initH = Math.max(8, block.height);
	const aspect = initW / initH;
	const isCorner = dir.length === 2;
	const minSize = 8;
	const resizeSnapshot = captureEditableSnapshot();

	const onMove = (moveEvent) => {
		const dx = moveEvent.clientX - startX;
		const dy = moveEvent.clientY - startY;
		let x = initX;
		let y = initY;
		let w = initW;
		let h = initH;

		if (isCorner) {
			// Diagonale : on conserve les proportions. La largeur est pilotée par le
			// déplacement horizontal (signé selon le côté), la hauteur en découle.
			const signX = dir.includes('e') ? 1 : -1;
			w = Math.max(minSize, initW + signX * dx);
			h = Math.max(minSize, w / aspect);
			w = h * aspect;
			if (dir.includes('w')) x = initX + (initW - w);
			if (dir.includes('n')) y = initY + (initH - h);
		} else if (dir === 'e') {
			w = Math.max(minSize, initW + dx);
		} else if (dir === 'w') {
			w = Math.max(minSize, initW - dx);
			x = initX + (initW - w);
		} else if (dir === 's') {
			h = Math.max(minSize, initH + dy);
		} else if (dir === 'n') {
			h = Math.max(minSize, initH - dy);
			y = initY + (initH - h);
		}

		block.x = Math.max(0, x);
		block.y = Math.max(0, y);
		block.width = w;
		block.height = h;
		renderEditBlocksForPage(block.page);
	};

	const onUp = () => {
		window.removeEventListener('pointermove', onMove);
		window.removeEventListener('pointerup', onUp);
		if (
			Math.abs(block.width - initW) > 0.5 ||
			Math.abs(block.height - initH) > 0.5 ||
			Math.abs(block.x - initX) > 0.5 ||
			Math.abs(block.y - initY) > 0.5
		) {
			commitSnapshot(resizeSnapshot);
			markDirty();
		}
	};

	window.addEventListener('pointermove', onMove);
	window.addEventListener('pointerup', onUp);
}

function computeAlignmentGuides(block, proposedX, proposedY) {
	const snapThreshold = 5;
	const minWidth = 40;
	const minHeight = 10;
	const others = state.editBlocks.filter(
		(candidate) =>
			candidate.page === block.page &&
			!candidate.hidden &&
			candidate.id !== block.id &&
			candidate.width >= minWidth &&
			candidate.height >= minHeight
	);
	const guides = [];
	let x = proposedX;
	let y = proposedY;

	const xEdges = [
		{ value: proposedX, label: 'left' },
		{ value: proposedX + block.width / 2, label: 'center' },
		{ value: proposedX + block.width, label: 'right' }
	];
	const yEdges = [
		{ value: proposedY, label: 'top' },
		{ value: proposedY + block.height / 2, label: 'middle' },
		{ value: proposedY + block.height, label: 'bottom' }
	];

	let bestX = null;
	for (const other of others) {
		const targets = [other.x, other.x + other.width / 2, other.x + other.width];
		for (const edge of xEdges) {
			for (const target of targets) {
				const delta = target - edge.value;
				if (Math.abs(delta) <= snapThreshold) {
					if (!bestX || Math.abs(delta) < Math.abs(bestX.delta)) {
						bestX = { delta, position: target, target: other };
					}
				}
			}
		}
	}
	if (bestX) {
		x = proposedX + bestX.delta;
		const movedTop = y;
		const movedBottom = y + block.height;
		const target = bestX.target;
		const spanStart = Math.min(movedTop, target.y);
		const spanEnd = Math.max(movedBottom, target.y + target.height);
		let distance = null;
		if (movedBottom < target.y) {
			distance = { axis: 'vertical', start: movedBottom, end: target.y, value: Math.round(target.y - movedBottom) };
		} else if (target.y + target.height < movedTop) {
			distance = { axis: 'vertical', start: target.y + target.height, end: movedTop, value: Math.round(movedTop - (target.y + target.height)) };
		}
		guides.push({ type: 'vertical', position: bestX.position, span: { start: spanStart, end: spanEnd }, distance });
	}

	let bestY = null;
	for (const other of others) {
		const targets = [other.y, other.y + other.height / 2, other.y + other.height];
		for (const edge of yEdges) {
			for (const target of targets) {
				const delta = target - edge.value;
				if (Math.abs(delta) <= snapThreshold) {
					if (!bestY || Math.abs(delta) < Math.abs(bestY.delta)) {
						bestY = { delta, position: target, target: other };
					}
				}
			}
		}
	}
	if (bestY) {
		y = proposedY + bestY.delta;
		const movedLeft = x;
		const movedRight = x + block.width;
		const target = bestY.target;
		const spanStart = Math.min(movedLeft, target.x);
		const spanEnd = Math.max(movedRight, target.x + target.width);
		let distance = null;
		if (movedRight < target.x) {
			distance = { axis: 'horizontal', start: movedRight, end: target.x, value: Math.round(target.x - movedRight) };
		} else if (target.x + target.width < movedLeft) {
			distance = { axis: 'horizontal', start: target.x + target.width, end: movedLeft, value: Math.round(movedLeft - (target.x + target.width)) };
		}
		guides.push({ type: 'horizontal', position: bestY.position, span: { start: spanStart, end: spanEnd }, distance });
	}

	return { x, y, guides };
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const GUIDE_COLOR = '#e0245e';

function renderAlignmentGuides(guides, pageNumber) {
	clearAlignmentGuides();
	if (!guides.length) return;
	const data = getPageData(pageNumber);
	if (!data) return;

	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.classList.add('alignment-overlay');
	svg.setAttribute('width', data.viewportWidth);
	svg.setAttribute('height', data.viewportHeight);
	svg.setAttribute('viewBox', `0 0 ${data.viewportWidth} ${data.viewportHeight}`);

	for (const guide of guides) {
		const line = document.createElementNS(SVG_NS, 'line');
		if (guide.type === 'vertical') {
			line.setAttribute('x1', guide.position);
			line.setAttribute('x2', guide.position);
			line.setAttribute('y1', guide.span.start);
			line.setAttribute('y2', guide.span.end);
		} else {
			line.setAttribute('y1', guide.position);
			line.setAttribute('y2', guide.position);
			line.setAttribute('x1', guide.span.start);
			line.setAttribute('x2', guide.span.end);
		}
		line.setAttribute('stroke', GUIDE_COLOR);
		line.setAttribute('stroke-width', '1');
		line.setAttribute('shape-rendering', 'crispEdges');
		svg.append(line);

		if (guide.distance) {
			svg.append(createDistanceMarker(guide, data));
		}
	}

	data.editLayer.append(svg);
}

function createDistanceMarker(guide, pageData) {
	const { distance } = guide;
	const g = document.createElementNS(SVG_NS, 'g');

	if (distance.axis === 'vertical') {
		const xOffset = guide.position + 12;
		const x = Math.min(pageData.viewportWidth - 14, xOffset);
		const stem = document.createElementNS(SVG_NS, 'line');
		stem.setAttribute('x1', x);
		stem.setAttribute('x2', x);
		stem.setAttribute('y1', distance.start);
		stem.setAttribute('y2', distance.end);
		stem.setAttribute('stroke', GUIDE_COLOR);
		stem.setAttribute('stroke-width', '1');
		stem.setAttribute('shape-rendering', 'crispEdges');
		g.append(stem);
		g.append(makeArrow(x, distance.start, 'up'));
		g.append(makeArrow(x, distance.end, 'down'));
		g.append(makeLabel(x + 14, (distance.start + distance.end) / 2, `${distance.value}px`));
	} else {
		const yOffset = guide.position + 12;
		const y = Math.min(pageData.viewportHeight - 14, yOffset);
		const stem = document.createElementNS(SVG_NS, 'line');
		stem.setAttribute('y1', y);
		stem.setAttribute('y2', y);
		stem.setAttribute('x1', distance.start);
		stem.setAttribute('x2', distance.end);
		stem.setAttribute('stroke', GUIDE_COLOR);
		stem.setAttribute('stroke-width', '1');
		stem.setAttribute('shape-rendering', 'crispEdges');
		g.append(stem);
		g.append(makeArrow(distance.start, y, 'left'));
		g.append(makeArrow(distance.end, y, 'right'));
		g.append(makeLabel((distance.start + distance.end) / 2, y - 12, `${distance.value}px`));
	}
	return g;
}

function makeArrow(x, y, dir) {
	const size = 4;
	const poly = document.createElementNS(SVG_NS, 'polygon');
	let points;
	if (dir === 'up') points = `${x},${y} ${x - size},${y + size} ${x + size},${y + size}`;
	else if (dir === 'down') points = `${x},${y} ${x - size},${y - size} ${x + size},${y - size}`;
	else if (dir === 'left') points = `${x},${y} ${x + size},${y - size} ${x + size},${y + size}`;
	else points = `${x},${y} ${x - size},${y - size} ${x - size},${y + size}`;
	poly.setAttribute('points', points);
	poly.setAttribute('fill', GUIDE_COLOR);
	return poly;
}

function makeLabel(cx, cy, text) {
	const g = document.createElementNS(SVG_NS, 'g');
	const width = text.length * 5.6 + 10;
	const height = 14;
	const rect = document.createElementNS(SVG_NS, 'rect');
	rect.setAttribute('x', cx - width / 2);
	rect.setAttribute('y', cy - height / 2);
	rect.setAttribute('width', width);
	rect.setAttribute('height', height);
	rect.setAttribute('rx', 4);
	rect.setAttribute('fill', GUIDE_COLOR);
	g.append(rect);
	const txt = document.createElementNS(SVG_NS, 'text');
	txt.setAttribute('x', cx);
	txt.setAttribute('y', cy + 0.5);
	txt.setAttribute('text-anchor', 'middle');
	txt.setAttribute('dominant-baseline', 'central');
	txt.setAttribute('fill', '#ffffff');
	txt.setAttribute('font-size', '9.5');
	txt.setAttribute('font-family', '-apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif');
	txt.setAttribute('font-weight', '600');
	txt.textContent = text;
	g.append(txt);
	return g;
}

function clearAlignmentGuides() {
	elements.pagesStack.querySelectorAll('.alignment-overlay').forEach((node) => node.remove());
}

function toggleEditMode(force) {
	state.editMode = typeof force === 'boolean' ? force : !state.editMode;
	elements.app.classList.toggle('editing', state.editMode);
	elements.modifyTab.classList.toggle('active', state.editMode);
	elements.allToolsTab?.classList.toggle('active', !state.editMode);
	elements.modifyTool.classList.toggle('active', state.editMode);
	if (state.editMode) {
		state.settings.showTools = true;
		elements.settingShowTools.checked = true;
		saveSettings();
	}
	closeDrawer();
	renderEditBlocks();
	updateUi();
	if (state.editMode && state.pdf && !state.editBlocks.some((block) => block.page === state.page)) {
		void autoDetectEditableContent();
	}
}

function exitEditMode() {
	state.editMode = false;
	state.selectedBlockId = null;
	state.selectedBlockIds = [];
	elements.app.classList.remove('editing');
	elements.modifyTab.classList.remove('active');
	elements.allToolsTab?.classList.add('active');
	elements.modifyTool.classList.remove('active');
	closeDrawer();
	renderEditBlocks();
	updateSelectedEditField();
	updateUi();
}

async function autoDetectEditableContent() {
	if (!state.pdf) return;
	const detected = await scanEditableBlocks();
	if (detected) return;
	const text = await extractPageText(state.page);
	if (!text) {
		await runOcrForCurrentPage(false);
	}
}

function updateUi(renderPanels = true) {
	const hasPdf = Boolean(state.pdf);
	elements.app.classList.toggle('has-pdf', hasPdf);
	elements.app.classList.toggle('tools-hidden', !state.settings.showTools);
	elements.app.classList.toggle('rail-hidden', !state.settings.showRail);
	elements.openButton.textContent = hasPdf ? t('openAnother') : t('open');
	elements.openButton.setAttribute('aria-label', hasPdf ? 'Open another PDF' : 'Open PDF');
	elements.chooseEmpty.querySelector('span:last-child').textContent = hasPdf ? t('openAnother') : t('openPdf');
	elements.pageLabel.textContent = hasPdf ? `${state.page}/${state.pdf.numPages}` : '0/0';
	if (elements.docSize) elements.docSize.textContent = hasPdf ? bytesToMb(state.fileBytes.byteLength) : '';
	elements.zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
	elements.pageSummaryTitle.textContent = hasPdf ? state.fileName : t('noDocument');
	elements.pageSummaryMeta.textContent = hasPdf
		? `Page ${state.page} of ${state.pdf.numPages}. Current zoom: ${Math.round(state.zoom * 100)}%.`
		: t('pageSummaryEmpty');
	persistCurrentTabState();
	renderTabs();

	for (const control of [
		elements.prevPage,
		elements.nextPage,
		elements.railZoomOut,
		elements.railZoomIn,
		elements.railFitWidth,
		elements.railLayoutSingle,
		elements.downloadOriginal,
		elements.exportAnnotations,
		elements.exportEditedPdf,
		elements.searchInput,
		elements.searchButton,
		elements.annotationText,
		elements.highlightButton,
		elements.commentButton,
		elements.scanEditBlocks,
		elements.ocrCurrentPage
	]) {
		control.disabled = !hasPdf;
	}
	document.querySelectorAll('[data-tool-action]').forEach((button) => {
		button.disabled = !hasPdf;
	});

	elements.prevPage.disabled = !hasPdf || state.page <= 1;
	elements.nextPage.disabled = !hasPdf || state.page >= state.pdf.numPages;
	elements.exportAnnotations.disabled = !hasPdf || state.annotations.length === 0;
	elements.exportEditedPdf.disabled = !hasPdf;
	if (elements.saveButton) elements.saveButton.disabled = !hasPdf;
	const layout = state.settings.pageLayout === 'single' ? 'single' : 'continuous';
	elements.railLayoutSingle.classList.toggle('active', layout === 'single');
	elements.railFitWidth.classList.toggle('active', state.fitMode === 'page');
	if (renderPanels) {
		renderResults();
		renderNotes();
	}
}

function downloadOriginal() {
	if (!state.fileBytes || !state.fileName) return;
	void saveNativeFile(state.fileName, 'pdf', state.fileBytes);
}

function exportAnnotations() {
	if (!state.fileName) return;
	const payload = {
		document: {
			name: state.fileName,
			fingerprint: state.fingerprint,
			pageCount: state.pdf?.numPages || 0
		},
		annotations: state.annotations
	};
	const bytes = new TextEncoder().encode(JSON.stringify(payload, null, 2));
	void saveNativeFile(
		`${state.fileName.replace(/\.pdf$/i, '')}-alto-notes.json`,
		'json',
		bytes
	);
}

async function exportEditedPdf(suggestedName) {
	if (!state.pdf) return;

	try {
		// Document non modifié : on exporte les octets D'ORIGINE (texte/vectoriel
		// intact) au lieu de rasteriser inutilement la page → aucune perte de qualité.
		const tab = currentTab();
		let bytes;
		if (!tab || !tab.dirty) {
			bytes = Array.from(state.fileBytes);
		} else {
			// Avant d'aplatir en image : on s'assure que toutes les polices en ligne
			// utilisées par les blocs édités sont bien chargées, sinon le canvas
			// dessinerait avec une police de repli dans le JPEG exporté.
			for (const block of state.editBlocks) {
				if (needsCloudFont(block.fontFamilyOverride)) {
					ensureCloudFont(block.fontFamilyOverride);
				}
				// Polices appliquées sur des sous-sélections (runs HTML).
				if (block.htmlEdited && block.html) {
					const runs = extractRunsFromHtml(block.html, block.bold, block.italic, block.underline, '');
					for (const run of runs) {
						const fam = primaryFamilyName(run.fontFamily);
						if (fam && needsCloudFont(fam)) ensureCloudFont(fam);
					}
				}
			}
			if (document.fonts?.ready) {
				try { await document.fonts.ready; } catch (_err) { /* non bloquant */ }
			}
			const pages = [];
			for (let pageNumber = 1; pageNumber <= state.pdf.numPages; pageNumber += 1) {
				pages.push(await renderFlattenedPage(pageNumber));
			}
			bytes = await invokeBytes('export_edited_pdf', { pages });
		}

		const fallback = state.fileName
			? `${state.fileName.replace(/\.pdf$/i, '')}-modifie.pdf`
			: 'alto-modifie.pdf';
		const filename = sanitizeFilename(suggestedName, fallback);
		const savedPath = await saveNativeFile(filename, 'pdf', bytes);
		if (savedPath) {
			// L'onglet (et le titre du document) héritent du nom réellement enregistré.
			applySavedDocumentName(savedPath);
			const tab = currentTab();
			if (tab) {
				tab.dirty = false;
			}
			persistCurrentTabState();
			renderTabs();
			updateUi();
			rememberSavedFile(savedPath, bytes.length);
		}
		return Boolean(savedPath);
	} catch (error) {
		console.error(error);
		setStatus(error instanceof Error ? error.message : 'Edited PDF export failed.', 'error');
		return false;
	}
}

// Après un « Enregistrer sous » (dialogue natif), on propage le nom du fichier
// réellement choisi vers l'onglet et le titre — comme tout éditeur : l'onglet
// reflète toujours le dernier enregistrement.
function applySavedDocumentName(savedPath) {
	const name = (savedPath || '').split('/').pop();
	if (!name) return;
	state.fileName = name;
	const tab = currentTab();
	if (tab) tab.fileName = name;
}

// Enregistrement « simple » (⌘S) : on écrit le document tel quel sur disque via le
// dialogue natif (tu choisis le Bureau, etc.). Qualité préservée — si aucune
// modification, on sauve les octets D'ORIGINE (vectoriel parfait) ; sinon la version
// aplatie. Sert à enregistrer une copie d'un document juste ouvert.
async function handleSaveDocument() {
	if (!state.pdf) return false;
	try {
		const tab = currentTab();
		if (tab && tab.dirty) {
			setStatus(currentLocale() === 'fr' ? 'Enregistrement…' : 'Saving…');
		}
		const bytes = new Uint8Array(await currentDocumentBytes());
		const filename = sanitizeFilename(state.fileName, 'document.pdf');
		const savedPath = await saveNativeFile(filename, 'pdf', bytes);
		if (savedPath) {
			// L'onglet (et le titre du document) héritent du nom réellement enregistré.
			applySavedDocumentName(savedPath);
			if (tab) tab.dirty = false;
			persistCurrentTabState();
			renderTabs();
			updateUi();
			// Le fichier sur le disque contient désormais les modifications : on relie
			// l'entrée « Récents » au chemin enregistré et on régénère sa vignette
			// depuis ce fichier (donc avec les modifications visibles).
			rememberSavedFile(savedPath, bytes.length);
		}
		return Boolean(savedPath);
	} catch (error) {
		console.error(error);
		setStatus(error instanceof Error ? error.message : 'Enregistrement impossible.', 'error');
		return false;
	}
}

function suggestFileName(baseSuffix, defaultName = 'alto.pdf') {
	if (!state.fileName) return defaultName;
	const stem = state.fileName.replace(/\.pdf$/i, '');
	return `${stem}-${baseSuffix}.pdf`;
}

function humanFileSize(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function handleCombineFiles() {
	try {
		const picked = await invokeCommand('pick_multiple_pdfs');
		if (!picked || picked.length === 0) return;
		const sources = [];
		if (state.fileBytes && state.fileName) {
			sources.push(Array.from(state.fileBytes));
		}
		for (const file of picked) {
			sources.push(Array.from(new Uint8Array(file.bytes)));
		}
		if (sources.length < 2) {
			setStatus(t('combineNeedTwo'), 'error');
			return;
		}
		setStatus(t('combineProcessing'));
		const merged = await invokeBytes('merge_pdfs', { sources });
		const bytes = new Uint8Array(merged);
		const filename = suggestFileName('combine', 'alto-combine.pdf');
		const saved = await saveNativeFile(filename, 'pdf', bytes);
		if (saved) setStatus(t('combineDone'));
	} catch (error) {
		console.error(error);
		setStatus(error instanceof Error ? error.message : String(error), 'error');
	}
}

async function handleProtectPdf() {
	if (!state.fileBytes) {
		setStatus(t('needPdfOpen'), 'error');
		return;
	}
	const credentials = await openProtectModal();
	if (!credentials) return;
	try {
		setStatus(t('protectProcessing'));
		const encrypted = await invokeBytes('encrypt_pdf', {
			bytes: Array.from(state.fileBytes),
			userPassword: credentials.password,
			ownerPassword: credentials.password
		});
		const filename = suggestFileName('protege', 'alto-protege.pdf');
		const saved = await saveNativeFile(filename, 'pdf', new Uint8Array(encrypted));
		if (saved) setStatus(t('protectDone'));
	} catch (error) {
		console.error(error);
		setStatus(error instanceof Error ? error.message : String(error), 'error');
	}
}

async function handleCompressPdf() {
	if (!state.fileBytes) {
		setStatus(t('needPdfOpen'), 'error');
		return;
	}
	const opts = await openToolOptionsModal({
		title: t('compressPdf'),
		help: t('compressHelp'),
		confirm: t('apply'),
		fields: [
			{
				id: 'level',
				label: t('compressQuality'),
				type: 'select',
				value: 'medium',
				options: [
					{ value: 'low', label: t('compressLow') },
					{ value: 'medium', label: t('compressMedium') },
					{ value: 'high', label: t('compressHigh') }
				]
			}
		]
	});
	if (!opts) return;
	try {
		setStatus(t('compressProcessing'));
		const originalSize = state.fileBytes.length;
		const compressed = await invokeBytes('compress_pdf', {
			bytes: Array.from(state.fileBytes),
			level: opts.level
		});
		const bytes = new Uint8Array(compressed);
		const reduction = Math.max(0, originalSize - bytes.length);
		const percent = originalSize > 0 ? Math.round((reduction / originalSize) * 100) : 0;
		const filename = suggestFileName('compresse', 'alto-compresse.pdf');
		const saved = await saveNativeFile(filename, 'pdf', bytes);
		if (saved) {
			const fmt = t('compressDone');
			const detail = `${humanFileSize(reduction)} · ${percent}%`;
			const message = typeof fmt === 'function' ? fmt(detail) : fmt;
			setStatus(message);
		}
	} catch (error) {
		console.error(error);
		setStatus(error instanceof Error ? error.message : String(error), 'error');
	}
}

// Octets du PDF courant : version aplatie si des éditions sont en cours,
// sinon les octets d'origine. Sert aux outils Stirling-like.
async function currentDocumentBytes() {
	const tab = currentTab();
	if (tab && tab.dirty && state.pdf) {
		const pages = [];
		for (let pageNumber = 1; pageNumber <= state.pdf.numPages; pageNumber += 1) {
			pages.push(await renderFlattenedPage(pageNumber));
		}
		const flattened = await invokeBytes('export_edited_pdf', { pages });
		return Array.from(flattened);
	}
	return Array.from(state.fileBytes);
}

function hexToRgb(hex) {
	const value = String(hex || '').replace('#', '');
	if (value.length !== 6) return [0, 0, 0];
	return [
		parseInt(value.slice(0, 2), 16),
		parseInt(value.slice(2, 4), 16),
		parseInt(value.slice(4, 6), 16)
	];
}

// Modal d'options générique piloté par configuration.
// config: { title, help, confirm, fields: [{id,label,type,value,options,min,max,step,suffix}] }
function openToolOptionsModal(config) {
	return new Promise((resolve) => {
		const modal = elements.toolOptionsModal;
		if (!modal) {
			resolve(null);
			return;
		}
		elements.toolOptionsTitle.textContent = config.title || t('options');
		elements.toolOptionsHelp.textContent = config.help || '';
		elements.toolOptionsHelp.style.display = config.help ? '' : 'none';
		elements.toolOptionsConfirm.textContent = config.confirm || t('apply');
		elements.toolOptionsCancel.textContent = t('cancel');
		elements.toolOptionsError.textContent = '';
		elements.toolOptionsBody.innerHTML = '';

		const fields = config.fields || [];
		for (const field of fields) {
			const row = document.createElement('label');
			row.className = 'tool-option-row';
			const label = document.createElement('span');
			label.textContent = field.label;
			row.appendChild(label);

			let input;
			if (field.type === 'select') {
				input = document.createElement('select');
				for (const opt of field.options || []) {
					const option = document.createElement('option');
					option.value = opt.value;
					option.textContent = opt.label;
					if (opt.value === field.value) option.selected = true;
					input.appendChild(option);
				}
			} else if (field.type === 'checkbox') {
				input = document.createElement('input');
				input.type = 'checkbox';
				input.checked = Boolean(field.value);
				row.classList.add('tool-option-checkbox');
			} else {
				input = document.createElement('input');
				input.type = field.type || 'text';
				if (field.value !== undefined && field.value !== null) input.value = field.value;
				if (field.type === 'number' || field.type === 'range') {
					if (field.min !== undefined) input.min = field.min;
					if (field.max !== undefined) input.max = field.max;
					if (field.step !== undefined) input.step = field.step;
				}
				if (field.placeholder) input.placeholder = field.placeholder;
			}
			input.dataset.fieldId = field.id;
			input.dataset.fieldType = field.type || 'text';
			row.appendChild(input);
			elements.toolOptionsBody.appendChild(row);
		}

		modal.classList.remove('hidden');
		elements.toolOptionsBackdrop.classList.remove('hidden');
		setTimeout(() => {
			const first = elements.toolOptionsBody.querySelector('input, select');
			if (first) first.focus();
		}, 50);

		const cleanup = () => {
			modal.classList.add('hidden');
			elements.toolOptionsBackdrop.classList.add('hidden');
			elements.toolOptionsConfirm.removeEventListener('click', onConfirm);
			elements.toolOptionsCancel.removeEventListener('click', onCancel);
			elements.toolOptionsBackdrop.removeEventListener('click', onCancel);
		};
		const onCancel = () => {
			cleanup();
			resolve(null);
		};
		const onConfirm = () => {
			const values = {};
			for (const input of elements.toolOptionsBody.querySelectorAll('[data-field-id]')) {
				const id = input.dataset.fieldId;
				const type = input.dataset.fieldType;
				if (type === 'checkbox') values[id] = input.checked;
				else if (type === 'number' || type === 'range') values[id] = Number(input.value);
				else values[id] = input.value;
			}
			cleanup();
			resolve(values);
		};
		elements.toolOptionsConfirm.addEventListener('click', onConfirm);
		elements.toolOptionsCancel.addEventListener('click', onCancel);
		elements.toolOptionsBackdrop.addEventListener('click', onCancel);
	});
}

async function handleWatermark() {
	if (!state.fileBytes) {
		setStatus(t('needPdfOpen'), 'error');
		return;
	}
	const opts = await openToolOptionsModal({
		title: t('watermark'),
		help: t('watermarkHelp'),
		confirm: t('apply'),
		fields: [
			{ id: 'text', label: t('watermarkText'), type: 'text', value: 'CONFIDENTIEL' },
			{ id: 'fontSize', label: t('watermarkSize'), type: 'number', value: 56, min: 8, max: 200, step: 1 },
			{ id: 'opacity', label: t('watermarkOpacity'), type: 'range', value: 0.2, min: 0.05, max: 1, step: 0.05 },
			{ id: 'rotation', label: t('watermarkRotation'), type: 'number', value: 45, min: -180, max: 180, step: 5 },
			{ id: 'color', label: t('watermarkColor'), type: 'color', value: '#c81e1e' },
			{ id: 'bold', label: t('watermarkBold'), type: 'checkbox', value: true }
		]
	});
	if (!opts) return;
	if (!opts.text.trim()) {
		setStatus(t('watermarkEmpty'), 'error');
		return;
	}
	try {
		setStatus(t('processing'));
		const bytes = await currentDocumentBytes();
		const out = await invokeBytes('watermark_pdf', {
			bytes,
			text: opts.text,
			fontSize: opts.fontSize,
			opacity: opts.opacity,
			rotation: opts.rotation,
			color: hexToRgb(opts.color),
			bold: opts.bold
		});
		const saved = await saveNativeFile(suggestFileName('filigrane'), 'pdf', new Uint8Array(out));
		if (saved) setStatus(t('watermarkDone'));
		else setStatus('');
	} catch (error) {
		console.error(error);
		setStatus(error instanceof Error ? error.message : String(error), 'error');
	}
}

async function handlePageNumbers() {
	if (!state.fileBytes) {
		setStatus(t('needPdfOpen'), 'error');
		return;
	}
	const opts = await openToolOptionsModal({
		title: t('pageNumbers'),
		confirm: t('apply'),
		fields: [
			{
				id: 'position',
				label: t('position'),
				type: 'select',
				value: 'bottom-center',
				options: [
					{ value: 'bottom-center', label: t('posBottomCenter') },
					{ value: 'bottom-right', label: t('posBottomRight') },
					{ value: 'bottom-left', label: t('posBottomLeft') },
					{ value: 'top-center', label: t('posTopCenter') },
					{ value: 'top-right', label: t('posTopRight') },
					{ value: 'top-left', label: t('posTopLeft') }
				]
			},
			{ id: 'startAt', label: t('startAt'), type: 'number', value: 1, min: 0, step: 1 },
			{ id: 'fontSize', label: t('fontSize'), type: 'number', value: 11, min: 6, max: 48, step: 1 },
			{ id: 'margin', label: t('margin'), type: 'number', value: 28, min: 4, max: 120, step: 1 }
		]
	});
	if (!opts) return;
	try {
		setStatus(t('processing'));
		const bytes = await currentDocumentBytes();
		const out = await invokeBytes('add_page_numbers', {
			bytes,
			position: opts.position,
			startAt: opts.startAt,
			fontSize: opts.fontSize,
			margin: opts.margin
		});
		const saved = await saveNativeFile(suggestFileName('numerote'), 'pdf', new Uint8Array(out));
		if (saved) setStatus(t('pageNumbersDone'));
		else setStatus('');
	} catch (error) {
		console.error(error);
		setStatus(error instanceof Error ? error.message : String(error), 'error');
	}
}

async function handleImagesToPdf() {
	try {
		const images = await invokeCommand('pick_images');
		if (!images || images.length === 0) return;
		setStatus(t('processing'));
		const out = await invokeBytes('images_to_pdf', { images });
		const bytes = new Uint8Array(out);
		const saved = await saveNativeFile('alto-images.pdf', 'pdf', bytes);
		if (saved) {
			setStatus(t('imagesToPdfDone'));
			await openPdfFromBytes(bytes, 'alto-images.pdf');
		} else {
			setStatus('');
		}
	} catch (error) {
		console.error(error);
		setStatus(error instanceof Error ? error.message : String(error), 'error');
	}
}

async function handleCrop() {
	if (!state.fileBytes) {
		setStatus(t('needPdfOpen'), 'error');
		return;
	}
	const opts = await openToolOptionsModal({
		title: t('cropPages'),
		help: t('cropHelp'),
		confirm: t('apply'),
		fields: [
			{ id: 'top', label: t('cropTop'), type: 'number', value: 24, min: 0, step: 1 },
			{ id: 'right', label: t('cropRight'), type: 'number', value: 24, min: 0, step: 1 },
			{ id: 'bottom', label: t('cropBottom'), type: 'number', value: 24, min: 0, step: 1 },
			{ id: 'left', label: t('cropLeft'), type: 'number', value: 24, min: 0, step: 1 }
		]
	});
	if (!opts) return;
	try {
		setStatus(t('processing'));
		const bytes = await currentDocumentBytes();
		const out = await invokeBytes('crop_pdf', {
			bytes,
			left: opts.left,
			top: opts.top,
			right: opts.right,
			bottom: opts.bottom
		});
		const saved = await saveNativeFile(suggestFileName('rogne'), 'pdf', new Uint8Array(out));
		if (saved) setStatus(t('cropDone'));
		else setStatus('');
	} catch (error) {
		console.error(error);
		setStatus(error instanceof Error ? error.message : String(error), 'error');
	}
}

async function handleAutoRedact() {
	if (!state.fileBytes) {
		setStatus(t('needPdfOpen'), 'error');
		return;
	}
	const opts = await openToolOptionsModal({
		title: t('autoRedact'),
		help: t('autoRedactHelp'),
		confirm: t('redactCta'),
		fields: [
			{ id: 'terms', label: t('autoRedactTerms'), type: 'text', placeholder: 'Dupont, 06 12 34 56 78' },
			{ id: 'matchCase', label: t('matchCase'), type: 'checkbox', value: false }
		]
	});
	if (!opts) return;
	const terms = String(opts.terms || '')
		.split(',')
		.map((term) => term.trim())
		.filter(Boolean);
	if (terms.length === 0) {
		setStatus(t('autoRedactEmpty'), 'error');
		return;
	}
	try {
		setStatus(t('processing'));
		const bytes = await currentDocumentBytes();
		const result = await invokeCommand('auto_redact', { bytes, terms, matchCase: opts.matchCase });
		if (!result || result.count === 0) {
			setStatus(t('autoRedactNone'));
			return;
		}
		const saved = await saveNativeFile(suggestFileName('caviarde'), 'pdf', new Uint8Array(result.bytes));
		if (saved) {
			const fmt = t('autoRedactDone');
			setStatus(typeof fmt === 'function' ? fmt(result.count) : fmt);
		} else {
			setStatus('');
		}
	} catch (error) {
		console.error(error);
		setStatus(error instanceof Error ? error.message : String(error), 'error');
	}
}

async function handleFlatten() {
	if (!state.fileBytes) {
		setStatus(t('needPdfOpen'), 'error');
		return;
	}
	try {
		setStatus(t('processing'));
		const bytes = await currentDocumentBytes();
		const out = await invokeBytes('flatten_pdf', { bytes });
		const saved = await saveNativeFile(suggestFileName('aplati'), 'pdf', new Uint8Array(out));
		if (saved) setStatus(t('flattenDone'));
		else setStatus('');
	} catch (error) {
		console.error(error);
		setStatus(error instanceof Error ? error.message : String(error), 'error');
	}
}

async function handleSanitize() {
	if (!state.fileBytes) {
		setStatus(t('needPdfOpen'), 'error');
		return;
	}
	try {
		setStatus(t('processing'));
		const bytes = await currentDocumentBytes();
		const out = await invokeBytes('sanitize_pdf', { bytes });
		const saved = await saveNativeFile(suggestFileName('nettoye'), 'pdf', new Uint8Array(out));
		if (saved) setStatus(t('sanitizeDone'));
		else setStatus('');
	} catch (error) {
		console.error(error);
		setStatus(error instanceof Error ? error.message : String(error), 'error');
	}
}

async function handleRepairPdf() {
	if (!state.fileBytes) {
		setStatus(t('needPdfOpen'), 'error');
		return;
	}
	try {
		setStatus(t('repairProcessing'));
		const out = await invokeBytes('repair_pdf', { bytes: Array.from(state.fileBytes) });
		const saved = await saveNativeFile(suggestFileName('repare'), 'pdf', new Uint8Array(out));
		if (saved) setStatus(t('repairDone'));
		else setStatus('');
	} catch (error) {
		console.error(error);
		setStatus(error instanceof Error ? error.message : String(error), 'error');
	}
}

async function handleRemoveAnnotations() {
	if (!state.fileBytes) {
		setStatus(t('needPdfOpen'), 'error');
		return;
	}
	try {
		setStatus(t('processing'));
		const bytes = await currentDocumentBytes();
		const out = await invokeBytes('remove_annotations', { bytes });
		const saved = await saveNativeFile(suggestFileName('sans-annotations'), 'pdf', new Uint8Array(out));
		if (saved) setStatus(t('removeAnnotationsDone'));
		else setStatus('');
	} catch (error) {
		console.error(error);
		setStatus(error instanceof Error ? error.message : String(error), 'error');
	}
}

async function handleRemoveBlankPages() {
	if (!state.fileBytes) {
		setStatus(t('needPdfOpen'), 'error');
		return;
	}
	try {
		setStatus(t('blankProcessing'));
		const result = await invokeCommand('remove_blank_pages', {
			bytes: Array.from(state.fileBytes)
		});
		const removed = Array.isArray(result.removed) ? result.removed : [];
		if (removed.length === 0) {
			setStatus(t('blankNone'));
			return;
		}
		const saved = await saveNativeFile(
			suggestFileName('sans-pages-blanches'),
			'pdf',
			new Uint8Array(result.bytes)
		);
		if (saved) {
			const fmt = t('blankDone');
			setStatus(typeof fmt === 'function' ? fmt(removed.length) : fmt);
		} else {
			setStatus('');
		}
	} catch (error) {
		console.error(error);
		setStatus(error instanceof Error ? error.message : String(error), 'error');
	}
}

async function handleSignPdf() {
	if (!state.fileBytes) {
		setStatus(t('needPdfOpen'), 'error');
		return;
	}
	let p12Path;
	try {
		p12Path = await invokeCommand('pick_certificate_file');
	} catch (error) {
		console.error(error);
		setStatus(error instanceof Error ? error.message : String(error), 'error');
		return;
	}
	if (!p12Path) return;
	const opts = await openToolOptionsModal({
		title: t('signPdf'),
		help: t('signHelp'),
		confirm: t('signCta'),
		fields: [
			{ id: 'password', label: t('signPassword'), type: 'password', value: '' },
			{ id: 'reason', label: t('signReason'), type: 'text', value: '' },
			{ id: 'location', label: t('signLocation'), type: 'text', value: '' }
		]
	});
	if (!opts) return;
	try {
		setStatus(t('signProcessing'));
		const out = await invokeBytes('sign_pdf_pades', {
			bytes: Array.from(state.fileBytes),
			p12Path,
			password: opts.password || '',
			reason: opts.reason ? opts.reason : null,
			location: opts.location ? opts.location : null,
			contact: null
		});
		const saved = await saveNativeFile(suggestFileName('signe'), 'pdf', new Uint8Array(out));
		if (saved) setStatus(t('signDone'));
		else setStatus('');
	} catch (error) {
		console.error(error);
		setStatus(error instanceof Error ? error.message : String(error), 'error');
	}
}

async function handleOcrSearchable() {
	if (!state.fileBytes) {
		setStatus(t('needPdfOpen'), 'error');
		return;
	}
	try {
		setStatus(t('ocrLayerProcessing'));
		const out = await invokeBytes('ocr_searchable_pdf', {
			bytes: Array.from(state.fileBytes),
			language: 'eng+fra'
		});
		const saved = await saveNativeFile(
			suggestFileName('recherchable'),
			'pdf',
			new Uint8Array(out)
		);
		if (saved) setStatus(t('ocrLayerDone'));
		else setStatus('');
	} catch (error) {
		console.error(error);
		setStatus(error instanceof Error ? error.message : String(error), 'error');
	}
}

async function handleExtractImages() {
	if (!state.fileBytes) {
		setStatus(t('needPdfOpen'), 'error');
		return;
	}
	try {
		setStatus(t('processing'));
		const bytes = await currentDocumentBytes();
		const report = await invokeCommand('extract_images_to_folder', { bytes });
		if (!report) {
			setStatus('');
			return;
		}
		const fmt = t('extractImagesDone');
		setStatus(typeof fmt === 'function' ? fmt(report.count) : fmt);
	} catch (error) {
		console.error(error);
		setStatus(error instanceof Error ? error.message : String(error), 'error');
	}
}

async function handleUnlock() {
	if (!state.fileBytes) {
		setStatus(t('needPdfOpen'), 'error');
		return;
	}
	const opts = await openToolOptionsModal({
		title: t('unlockPdf'),
		help: t('unlockHelp'),
		confirm: t('unlockCta'),
		fields: [{ id: 'password', label: t('protectPassword'), type: 'password', value: '' }]
	});
	if (!opts) return;
	if (!opts.password) {
		setStatus(t('unlockEmpty'), 'error');
		return;
	}
	try {
		setStatus(t('processing'));
		const out = await invokeBytes('remove_password', {
			bytes: Array.from(state.fileBytes),
			password: opts.password
		});
		const saved = await saveNativeFile(suggestFileName('deverrouille'), 'pdf', new Uint8Array(out));
		if (saved) setStatus(t('unlockDone'));
		else setStatus('');
	} catch (error) {
		console.error(error);
		setStatus(error instanceof Error ? error.message : String(error), 'error');
	}
}

function renderBookmarkRow(item) {
	const row = document.createElement('div');
	row.className = 'bookmark-row';
	const title = document.createElement('input');
	title.type = 'text';
	title.className = 'bookmark-title';
	title.placeholder = t('bookmarkTitle');
	title.value = item?.title || '';
	const page = document.createElement('input');
	page.type = 'number';
	page.className = 'bookmark-page';
	page.min = 1;
	page.value = item?.page || 1;
	const remove = document.createElement('button');
	remove.type = 'button';
	remove.className = 'bookmark-remove';
	remove.textContent = '×';
	remove.addEventListener('click', () => row.remove());
	row.appendChild(title);
	row.appendChild(page);
	row.appendChild(remove);
	return row;
}

async function handleBookmarks() {
	if (!state.fileBytes) {
		setStatus(t('needPdfOpen'), 'error');
		return;
	}
	const modal = elements.bookmarksModal;
	if (!modal) return;
	let existing = [];
	try {
		existing = await invokeCommand('get_bookmarks', { bytes: Array.from(state.fileBytes) });
	} catch (error) {
		existing = [];
	}
	elements.bookmarksList.innerHTML = '';
	if (existing && existing.length) {
		for (const item of existing) elements.bookmarksList.appendChild(renderBookmarkRow(item));
	} else {
		elements.bookmarksList.appendChild(renderBookmarkRow({ title: '', page: 1 }));
	}
	elements.bookmarksError.textContent = '';
	modal.classList.remove('hidden');
	elements.bookmarksBackdrop.classList.remove('hidden');

	const cleanup = () => {
		modal.classList.add('hidden');
		elements.bookmarksBackdrop.classList.add('hidden');
		elements.bookmarksAdd.removeEventListener('click', onAdd);
		elements.bookmarksSave.removeEventListener('click', onSave);
		elements.bookmarksCancel.removeEventListener('click', onCancel);
		elements.bookmarksBackdrop.removeEventListener('click', onCancel);
	};
	const onCancel = () => cleanup();
	const onAdd = () => {
		elements.bookmarksList.appendChild(renderBookmarkRow({ title: '', page: 1 }));
	};
	const onSave = async () => {
		const items = [];
		for (const row of elements.bookmarksList.querySelectorAll('.bookmark-row')) {
			const title = row.querySelector('.bookmark-title').value.trim();
			const page = Math.max(1, Number(row.querySelector('.bookmark-page').value) || 1);
			if (title) items.push({ title, page });
		}
		cleanup();
		try {
			setStatus(t('processing'));
			const bytes = await currentDocumentBytes();
			const out = await invokeBytes('set_bookmarks', { bytes, items });
			const saved = await saveNativeFile(suggestFileName('marque-pages'), 'pdf', new Uint8Array(out));
			if (saved) setStatus(t('bookmarksDone'));
			else setStatus('');
		} catch (error) {
			console.error(error);
			setStatus(error instanceof Error ? error.message : String(error), 'error');
		}
	};
	elements.bookmarksAdd.addEventListener('click', onAdd);
	elements.bookmarksSave.addEventListener('click', onSave);
	elements.bookmarksCancel.addEventListener('click', onCancel);
	elements.bookmarksBackdrop.addEventListener('click', onCancel);
}

async function handleDeskewPdf() {
	if (!state.fileBytes) {
		setStatus(t('needPdfOpen'), 'error');
		return;
	}
	try {
		setStatus(t('deskewProcessing'));
		const result = await invokeCommand('deskew_pdf', {
			bytes: Array.from(state.fileBytes)
		});
		const corrected = Array.isArray(result?.corrected) ? result.corrected : [];
		if (!corrected.length) {
			setStatus(t('deskewNone'));
			return;
		}
		const bytes = new Uint8Array(result.bytes);
		await openPdfFromBytes(bytes, state.fileName || 'alto.pdf', { dedupe: false });
		const tab = currentTab();
		if (tab) {
			tab.dirty = true;
			persistCurrentTabState();
			renderTabs();
		}
		const summary = corrected
			.map((entry) => `p.${entry.page} (${entry.angle > 0 ? '+' : ''}${entry.angle.toFixed(1)}°)`)
			.join(', ');
		const fmt = t('deskewDone');
		setStatus(typeof fmt === 'function' ? fmt(summary) : fmt);
	} catch (error) {
		console.error(error);
		setStatus(error instanceof Error ? error.message : String(error), 'error');
	}
}

async function handlePrintPdf() {
	if (!state.fileBytes) {
		setStatus(t('needPdfOpen'), 'error');
		return;
	}
	try {
		setStatus('Préparation de l’impression…');
		let bytes;
		const tab = currentTab();
		if (tab && tab.dirty && state.pdf) {
			// Imprimer fidèlement ce qui est affiché (annotations + éditions).
			const pages = [];
			for (let pageNumber = 1; pageNumber <= state.pdf.numPages; pageNumber += 1) {
				pages.push(await renderFlattenedPage(pageNumber));
			}
			bytes = Array.from(await invokeBytes('export_edited_pdf', { pages }));
		} else {
			bytes = Array.from(state.fileBytes);
		}
		await invokeCommand('print_pdf', { bytes });
		setStatus('');
	} catch (error) {
		console.error(error);
		setStatus(error instanceof Error ? error.message : String(error), 'error');
	}
}

async function handleRotateCurrentPage(angle) {
	if (!state.fileBytes || !state.pdf) {
		setStatus(t('needPdfOpen'), 'error');
		return;
	}
	try {
		setStatus(t('rotateProcessing'));
		const rotated = await invokeBytes('rotate_pages', {
			bytes: Array.from(state.fileBytes),
			pageNumbers: [state.page],
			angle
		});
		const bytes = new Uint8Array(rotated);
		await openPdfFromBytes(bytes, state.fileName || 'alto.pdf', { dedupe: false });
		setStatus(t('rotateDone'));
		const tab = currentTab();
		if (tab) {
			tab.dirty = true;
			persistCurrentTabState();
			renderTabs();
		}
	} catch (error) {
		console.error(error);
		setStatus(error instanceof Error ? error.message : String(error), 'error');
	}
}

async function handleExportPageImage() {
	if (!state.pdf) {
		setStatus(t('needPdfOpen'), 'error');
		return;
	}
	const format = await openFormatChoice(['png', 'jpeg']);
	if (!format) return;
	try {
		const page = await state.pdf.getPage(state.page);
		const viewport = page.getViewport({ scale: 3 });
		const canvas = document.createElement('canvas');
		canvas.width = Math.floor(viewport.width);
		canvas.height = Math.floor(viewport.height);
		const ctx = canvas.getContext('2d', { alpha: false });
		if (!ctx) throw new Error('Canvas indisponible.');
		ctx.fillStyle = '#ffffff';
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		await page.render({ canvasContext: ctx, viewport }).promise;
		const mime = format === 'png' ? 'image/png' : 'image/jpeg';
		const quality = format === 'png' ? undefined : 0.95;
		const blob = await new Promise((resolve) => canvas.toBlob(resolve, mime, quality));
		if (!blob) throw new Error('Encodage image impossible.');
		const bytes = new Uint8Array(await blob.arrayBuffer());
		const filename = suggestFileName(`page-${state.page}`, `alto-page-${state.page}.${format}`)
			.replace(/\.pdf$/i, `.${format}`);
		await saveNativeFile(filename, format, bytes);
	} catch (error) {
		console.error(error);
		setStatus(error instanceof Error ? error.message : String(error), 'error');
	}
}

function openFormatChoice(formats) {
	return new Promise((resolve) => {
		const choice = window.prompt(
			currentLocale() === 'fr'
				? `Format d'export (${formats.join(' / ')}) :`
				: `Export format (${formats.join(' / ')}):`,
			formats[0]
		);
		if (!choice) {
			resolve(null);
			return;
		}
		const normalized = choice.trim().toLowerCase();
		resolve(formats.includes(normalized) ? normalized : formats[0]);
	});
}

async function handleShowProperties() {
	if (!state.fileBytes) {
		setStatus(t('needPdfOpen'), 'error');
		return;
	}
	try {
		const props = await invokeCommand('document_properties', {
			bytes: Array.from(state.fileBytes)
		});
		let pageFormat = null;
		try {
			const page = await state.pdf.getPage(1);
			const viewport = page.getViewport({ scale: 1 });
			pageFormat = formatPageSize(viewport.width, viewport.height);
		} catch {
			/* format indisponible */
		}
		showPropertiesModal(props, pageFormat);
	} catch (error) {
		console.error(error);
		setStatus(error instanceof Error ? error.message : String(error), 'error');
	}
}

function formatPageSize(widthPts, heightPts) {
	const toMm = (pts) => (pts * 25.4) / 72;
	const widthMm = toMm(widthPts);
	const heightMm = toMm(heightPts);
	const named = [
		['A3', 297, 420],
		['A4', 210, 297],
		['A5', 148, 210],
		['Letter', 215.9, 279.4],
		['Legal', 215.9, 355.6]
	];
	const tolerance = 1.5;
	let label = '';
	for (const [name, w, h] of named) {
		const portrait = Math.abs(widthMm - w) <= tolerance && Math.abs(heightMm - h) <= tolerance;
		const landscape = Math.abs(widthMm - h) <= tolerance && Math.abs(heightMm - w) <= tolerance;
		if (portrait || landscape) {
			label = ` (${name})`;
			break;
		}
	}
	const round = (value) => (Math.abs(value - Math.round(value)) < 0.05 ? String(Math.round(value)) : value.toFixed(1));
	return `${round(widthMm)} × ${round(heightMm)} mm${label}`;
}

function showPropertiesModal(props, pageFormat) {
	const list = elements.propertiesList;
	list.innerHTML = '';
	const isFr = currentLocale() === 'fr';
	const rows = [
		[isFr ? 'Nom' : 'Name', state.fileName || '—'],
		[isFr ? 'Titre' : 'Title', props.title || '—'],
		[isFr ? 'Auteur' : 'Author', props.author || '—'],
		[isFr ? 'Sujet' : 'Subject', props.subject || '—'],
		[isFr ? 'Mots-clés' : 'Keywords', props.keywords || '—'],
		[isFr ? 'Créateur' : 'Creator', props.creator || '—'],
		[isFr ? 'Producteur' : 'Producer', props.producer || '—'],
		[isFr ? 'Créé le' : 'Created', formatPdfDate(props.creationDate) || '—'],
		[isFr ? 'Modifié le' : 'Modified', formatPdfDate(props.modDate) || '—'],
		[isFr ? 'Version PDF' : 'PDF version', props.pdfVersion || '—'],
		[isFr ? 'Pages' : 'Pages', String(props.pageCount)],
		[isFr ? 'Format de page' : 'Page size', pageFormat || '—'],
		[isFr ? 'Taille' : 'Size', humanFileSize(Number(props.fileSize) || 0)],
		[isFr ? 'Chiffré' : 'Encrypted', props.encrypted ? (isFr ? 'Oui' : 'Yes') : (isFr ? 'Non' : 'No')]
	];
	for (const [label, value] of rows) {
		const dt = document.createElement('dt');
		dt.textContent = label;
		const dd = document.createElement('dd');
		dd.textContent = value;
		list.append(dt, dd);
	}
	elements.propertiesBackdrop.classList.remove('hidden');
	elements.propertiesModal.classList.remove('hidden');
}

function closePropertiesModal() {
	elements.propertiesBackdrop.classList.add('hidden');
	elements.propertiesModal.classList.add('hidden');
}

function formatPdfDate(raw) {
	if (!raw || typeof raw !== 'string') return null;
	const match = raw.match(/D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/);
	if (!match) return raw;
	const [, year, month = '01', day = '01', hour = '00', min = '00', sec = '00'] = match;
	const date = new Date(
		Date.UTC(
			Number(year),
			Math.max(0, Number(month) - 1),
			Number(day),
			Number(hour),
			Number(min),
			Number(sec)
		)
	);
	if (isNaN(date.getTime())) return raw;
	return date.toLocaleString(currentLocale() === 'fr' ? 'fr-FR' : 'en-US');
}

const RECENT_FILES_KEY = 'alto-recent-files';
const RECENT_FILES_MAX = 20;

function loadRecentFiles() {
	try {
		const raw = localStorage.getItem(RECENT_FILES_KEY);
		if (!raw) return [];
		const items = JSON.parse(raw);
		return Array.isArray(items) ? items : [];
	} catch (_err) {
		return [];
	}
}

function saveRecentFiles(items) {
	try {
		localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(items.slice(0, RECENT_FILES_MAX)));
	} catch (_err) {
		/* noop */
	}
}

// Vignette de la 1ʳᵉ page (data URL JPEG compacte) mise en cache dans les récents.
async function makeThumbnail(pdf) {
	try {
		if (!pdf) return '';
		const page = await pdf.getPage(1);
		const base = page.getViewport({ scale: 1 });
		const targetWidth = 240;
		const scale = targetWidth / base.width;
		const viewport = page.getViewport({ scale });
		const canvas = document.createElement('canvas');
		canvas.width = Math.round(viewport.width);
		canvas.height = Math.round(viewport.height);
		const context = canvas.getContext('2d');
		if (!context) return '';
		context.fillStyle = '#ffffff';
		context.fillRect(0, 0, canvas.width, canvas.height);
		await page.render({ canvasContext: context, viewport }).promise;
		return canvas.toDataURL('image/jpeg', 0.72);
	} catch (_err) {
		return '';
	}
}

// Génération paresseuse des vignettes manquantes (entrées d'avant la feature, ou
// ouvertes sans vignette). On lit le fichier sur le disque à son emplacement, on
// rend la 1ʳᵉ page, on met en cache, puis on remplace le placeholder.
//
// On utilise un JETON de rendu plutôt qu'une file d'attente globale : chaque appel
// à renderHome() incrémente le jeton, et la boucle de génération s'arrête dès
// qu'un rendu plus récent l'a remplacée. Cela évite la course qui interrompait la
// génération quand renderHome() était appelé plusieurs fois au démarrage.
let _homeRenderToken = 0;

async function generateMissingThumbs(pending, token) {
	for (const { item, thumbEl } of pending) {
		if (token !== _homeRenderToken) return;
		if (item.thumb || !item.path) continue;
		let pdf = null;
		try {
			const bytes = await invokeBytes('read_pdf_path', { path: item.path });
			if (token !== _homeRenderToken) return;
			if (!bytes || !bytes.length) {
				markRecentMissing(thumbEl);
				continue;
			}
			const data = new Uint8Array(bytes);
			pdf = await pdfjsLib.getDocument(pdfDocumentOptions({ data })).promise;
			const thumb = await makeThumbnail(pdf);
			if (!thumb) continue;

			// Cache persistant (relit la liste au moment d'écrire pour ne pas écraser
			// d'autres mises à jour concurrentes).
			const list = loadRecentFiles();
			const entry = list.find(
				(candidate) => candidate.path === item.path && candidate.name === item.name
			);
			if (entry) {
				entry.thumb = thumb;
				if (!entry.size) entry.size = data.length;
				saveRecentFiles(list);
			}
			item.thumb = thumb;

			if (token === _homeRenderToken && thumbEl.isConnected) {
				thumbEl.classList.remove('placeholder');
				thumbEl.textContent = '';
				const img = document.createElement('img');
				img.src = thumb;
				img.alt = '';
				img.loading = 'lazy';
				thumbEl.append(img);
			}
		} catch (err) {
			// Fichier introuvable / déplacé / illisible : on garde le placeholder mais
			// on le signale visuellement (le clic proposera de le retirer des récents).
			console.warn('Thumbnail generation failed for', item.path, err);
			markRecentMissing(thumbEl);
		} finally {
			if (pdf) {
				try {
					await pdf.destroy();
				} catch (_err) {
					/* noop */
				}
			}
		}
	}
}

function markRecentMissing(thumbEl) {
	if (thumbEl && thumbEl.isConnected) {
		thumbEl.closest('.recent-card')?.classList.add('is-missing');
	}
}

async function rememberRecentFile(path, name) {
	if (!path && !name) return;
	const list = loadRecentFiles().filter(
		(item) => item.path !== path || item.name !== name
	);
	const thumb = await makeThumbnail(state.pdf);
	const size = state.fileBytes ? state.fileBytes.length : 0;
	list.unshift({
		path: path || '',
		name: name || 'document.pdf',
		at: Date.now(),
		size,
		thumb
	});
	saveRecentFiles(list);
	renderHome();
}

// Après un enregistrement (« Enregistrer » → dialogue natif), on relie l'entrée
// « Récents » au chemin RÉELLEMENT choisi par l'utilisateur. On vide la vignette
// pour qu'elle se régénère depuis le fichier sur le disque, qui contient désormais
// les modifications sauvegardées. Rouvrir depuis « Récents » retrouve donc bien le
// fichier modifié.
function rememberSavedFile(savedPath, sizeBytes) {
	if (!savedPath) return;
	const name = savedPath.split('/').pop() || 'document.pdf';
	const list = loadRecentFiles().filter((item) => item.path !== savedPath);
	list.unshift({
		path: savedPath,
		name,
		at: Date.now(),
		size: sizeBytes || 0,
		thumb: ''
	});
	saveRecentFiles(list);
	renderHome();
}

// Ouverture via le dialogue NATIF (renvoie le chemin) → les récents restent
// réouvrables et reçoivent une vignette. Préféré au sélecteur navigateur.
async function openViaNativeDialog() {
	try {
		const result = await invokeCommand('open_file');
		if (!result) return;
		const fileName = result.file_name || result.fileName || 'document.pdf';
		const bytes = new Uint8Array(result.bytes);
		await openPdfFromBytes(bytes, fileName);
		await rememberRecentFile(result.path || '', fileName);
	} catch (error) {
		console.error(error);
		setStatus(error instanceof Error ? error.message : String(error), 'error');
	}
}

function handleShowRecent() {
	const list = loadRecentFiles();
	elements.recentList.innerHTML = '';
	if (!list.length) {
		const li = document.createElement('li');
		li.className = 'recent-empty';
		li.textContent = currentLocale() === 'fr' ? 'Aucun fichier récent.' : 'No recent files.';
		elements.recentList.append(li);
	} else {
		for (const item of list) {
			const li = document.createElement('li');
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'recent-item';
			btn.innerHTML = `<strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.path || '—')}</span>`;
			btn.addEventListener('click', () => {
				closeRecentModal();
				void openRecentFile(item);
			});
			li.append(btn);
			elements.recentList.append(li);
		}
	}
	elements.recentBackdrop.classList.remove('hidden');
	elements.recentModal.classList.remove('hidden');
}

function closeRecentModal() {
	elements.recentBackdrop.classList.add('hidden');
	elements.recentModal.classList.add('hidden');
}

async function openRecentFile(item) {
	if (!item.path) {
		setStatus(
			currentLocale() === 'fr'
				? 'Fichier non localisé — rouvrez-le via « Ouvrir ».'
				: 'File location unknown — reopen it via “Open”.',
			'error'
		);
		return;
	}
	try {
		const bytes = await invokeBytes('read_pdf_path', { path: item.path });
		if (!bytes || !bytes.length) {
			notifyRecentMissing();
			renderHome();
			return;
		}
		await openPdfFromBytes(new Uint8Array(bytes), item.name);
		await rememberRecentFile(item.path, item.name);
	} catch (error) {
		console.error(error);
		// Fichier déplacé ou supprimé : on GARDE l'entrée dans « Récents » (affichée
		// grisée) et on prévient l'utilisateur — on ne la retire pas automatiquement.
		notifyRecentMissing();
		renderHome();
	}
}

function notifyRecentMissing() {
	setStatus(
		currentLocale() === 'fr' ? 'Fichier manquant ou déplacé.' : 'File missing or moved.',
		'error'
	);
}

function homeGreetingText() {
	const hour = new Date().getHours();
	const fr = currentLocale() === 'fr';
	let salutation;
	if (hour < 6) salutation = fr ? 'Bonsoir' : 'Good evening';
	else if (hour < 18) salutation = fr ? 'Bonjour' : 'Hello';
	else salutation = fr ? 'Bonsoir' : 'Good evening';
	const name = (state.settings.identityName || '').trim();
	const first = name ? name.split(/\s+/)[0] : '';
	return first ? `${salutation}, ${first}` : salutation;
}

function profileInitials() {
	const name = (state.settings.identityName || '').trim();
	if (!name) return 'SL';
	const parts = name.split(/\s+/).filter(Boolean);
	const letters = parts.length >= 2 ? parts[0][0] + parts[1][0] : parts[0].slice(0, 2);
	return letters.toUpperCase();
}

function formatRecentDate(timestamp) {
	if (!timestamp) return '';
	const date = new Date(timestamp);
	const fr = currentLocale() === 'fr';
	const now = new Date();
	const sameDay = date.toDateString() === now.toDateString();
	if (sameDay) {
		return date.toLocaleTimeString(fr ? 'fr-FR' : 'en-US', { hour: '2-digit', minute: '2-digit' });
	}
	return date.toLocaleDateString(fr ? 'fr-FR' : 'en-US', { day: 'numeric', month: 'short' });
}

function refreshProfileAvatar() {
	if (elements.profileAvatar) elements.profileAvatar.textContent = profileInitials();
}

function updateHomeButtonState() {
	if (!elements.homeButton) return;
	const onHome = state.viewingHome || !state.tabs.length;
	elements.homeButton.classList.toggle('active', onHome);
}

// Affiche l'accueil PAR-DESSUS les documents ouverts (sans fermer les onglets),
// comme le bouton « Home » d'Acrobat. Cliquer un onglet revient au document.
function showHome() {
	state.viewingHome = true;
	elements.createView.classList.add('hidden');
	elements.pagesStack.classList.add('hidden');
	elements.emptyState.classList.remove('hidden');
	closeDrawer();
	renderHome();
	renderTabs();
	updateHomeButtonState();
}

function renderHome() {
	refreshProfileAvatar();
	if (elements.homeGreeting) elements.homeGreeting.textContent = homeGreetingText();
	for (const btn of elements.homeViewButtons) {
		btn.classList.toggle('active', btn.dataset.homeView === state.homeView);
	}

	const body = elements.homeRecentsBody;
	if (!body) return;
	const renderToken = ++_homeRenderToken;
	const pendingThumbs = [];
	const list = loadRecentFiles();
	body.innerHTML = '';
	body.classList.toggle('is-list', state.homeView === 'list');
	body.classList.toggle('is-grid', state.homeView !== 'list');

	if (elements.homeClearRecents) elements.homeClearRecents.style.display = list.length ? '' : 'none';

	if (!list.length) {
		const empty = document.createElement('p');
		empty.className = 'home-recents-empty';
		empty.textContent =
			currentLocale() === 'fr'
				? 'Aucun fichier récent. Ouvrez un PDF pour commencer.'
				: 'No recent files yet. Open a PDF to get started.';
		body.append(empty);
		return;
	}

	for (const item of list) {
		const card = document.createElement('button');
		card.type = 'button';
		card.className = 'recent-card';
		if (!item.path) card.classList.add('no-path');

		const thumb = document.createElement('div');
		thumb.className = 'recent-card-thumb';
		if (item.thumb) {
			const img = document.createElement('img');
			img.src = item.thumb;
			img.alt = '';
			img.loading = 'lazy';
			thumb.append(img);
		} else {
			thumb.classList.add('placeholder');
			// Placeholder discret (petite icône document) le temps de générer l'aperçu,
			// ou si le fichier n'a pas de chemin connu (impossible à relire).
			thumb.innerHTML =
				'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3h6l4 4v14H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M14 3v4h4"/><path d="M9 13h6M9 17h4"/></svg>';
			// Aperçu manquant : on le génère à la volée si on a le chemin du fichier.
			if (item.path) pendingThumbs.push({ item, thumbEl: thumb });
		}

		const info = document.createElement('div');
		info.className = 'recent-card-info';
		const name = document.createElement('span');
		name.className = 'recent-card-name';
		name.textContent = item.name || 'document.pdf';
		name.title = item.path || item.name || '';
		const meta = document.createElement('span');
		meta.className = 'recent-card-meta';
		const bits = [formatRecentDate(item.at)];
		if (item.size) bits.push(humanFileSize(item.size));
		meta.textContent = bits.filter(Boolean).join(' · ');
		info.append(name, meta);

		const remove = document.createElement('span');
		remove.className = 'recent-card-remove';
		remove.setAttribute('role', 'button');
		remove.tabIndex = 0;
		remove.title = currentLocale() === 'fr' ? 'Retirer des récents' : 'Remove from recents';
		remove.setAttribute('aria-label', remove.title);
		remove.innerHTML =
			'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6 18 18M18 6 6 18"/></svg>';
		const doRemove = (event) => {
			event.stopPropagation();
			event.preventDefault();
			const matches = (it) =>
				item.path ? it.path === item.path : it.name === item.name && it.at === item.at;
			saveRecentFiles(loadRecentFiles().filter((it) => !matches(it)));
			renderHome();
		};
		remove.addEventListener('click', doRemove);
		remove.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' || event.key === ' ') doRemove(event);
		});

		card.append(thumb, info, remove);
		card.addEventListener('click', () => void openRecentFile(item));
		body.append(card);
	}

	if (pendingThumbs.length) void generateMissingThumbs(pendingThumbs, renderToken);
}

let _compareState = {
	docA: null,
	docB: null,
	nameA: null,
	nameB: null,
	page: 1
};

function openCompareModal() {
	_compareState = { docA: null, docB: null, nameA: null, nameB: null, page: 1 };
	elements.compareNameA.textContent = '—';
	elements.compareNameB.textContent = '—';
	elements.comparePageLabel.textContent = '— / —';
	for (const c of [elements.compareCanvasA, elements.compareCanvasB, elements.compareCanvasDiff]) {
		const ctx = c.getContext('2d');
		ctx?.clearRect(0, 0, c.width, c.height);
	}
	elements.compareBackdrop.classList.remove('hidden');
	elements.compareModal.classList.remove('hidden');
}

function closeCompareModal() {
	elements.compareBackdrop.classList.add('hidden');
	elements.compareModal.classList.add('hidden');
	_compareState = { docA: null, docB: null, nameA: null, nameB: null, page: 1 };
}

async function comparePickFile(slot) {
	try {
		const result = await invokeCommand('open_file');
		if (!result) return;
		const bytes = new Uint8Array(result.bytes);
		const pdf = await pdfjsLib.getDocument(pdfDocumentOptions({ data: bytes })).promise;
		if (slot === 'A') {
			_compareState.docA = pdf;
			_compareState.nameA = result.fileName;
			elements.compareNameA.textContent = result.fileName;
		} else {
			_compareState.docB = pdf;
			_compareState.nameB = result.fileName;
			elements.compareNameB.textContent = result.fileName;
		}
		_compareState.page = 1;
		await renderComparePage();
	} catch (error) {
		console.error(error);
		setStatus(error instanceof Error ? error.message : String(error), 'error');
	}
}

async function renderComparePage() {
	const { docA, docB, page } = _compareState;
	if (!docA || !docB) return;
	const maxPages = Math.min(docA.numPages, docB.numPages);
	_compareState.page = Math.min(Math.max(page, 1), maxPages);
	elements.comparePageLabel.textContent = `${_compareState.page} / ${maxPages}`;
	const renderTo = async (pdf, canvas) => {
		const p = await pdf.getPage(_compareState.page);
		const viewport = p.getViewport({ scale: 1 });
		const targetWidth = 360;
		const scale = targetWidth / viewport.width;
		const vp = p.getViewport({ scale });
		canvas.width = Math.floor(vp.width);
		canvas.height = Math.floor(vp.height);
		const ctx = canvas.getContext('2d', { alpha: false });
		if (!ctx) return null;
		ctx.fillStyle = '#fff';
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		await p.render({ canvasContext: ctx, viewport: vp }).promise;
		return ctx;
	};
	const ctxA = await renderTo(docA, elements.compareCanvasA);
	const ctxB = await renderTo(docB, elements.compareCanvasB);
	if (!ctxA || !ctxB) return;
	const w = Math.min(elements.compareCanvasA.width, elements.compareCanvasB.width);
	const h = Math.min(elements.compareCanvasA.height, elements.compareCanvasB.height);
	elements.compareCanvasDiff.width = w;
	elements.compareCanvasDiff.height = h;
	const ctxD = elements.compareCanvasDiff.getContext('2d', { alpha: false });
	if (!ctxD) return;
	const aData = ctxA.getImageData(0, 0, w, h);
	const bData = ctxB.getImageData(0, 0, w, h);
	const diff = ctxD.createImageData(w, h);
	for (let i = 0; i < aData.data.length; i += 4) {
		const dr = Math.abs(aData.data[i] - bData.data[i]);
		const dg = Math.abs(aData.data[i + 1] - bData.data[i + 1]);
		const db = Math.abs(aData.data[i + 2] - bData.data[i + 2]);
		const delta = (dr + dg + db) / 3;
		if (delta > 12) {
			diff.data[i] = 229;
			diff.data[i + 1] = 72;
			diff.data[i + 2] = 63;
			diff.data[i + 3] = 220;
		} else {
			diff.data[i] = aData.data[i];
			diff.data[i + 1] = aData.data[i + 1];
			diff.data[i + 2] = aData.data[i + 2];
			diff.data[i + 3] = 80;
		}
	}
	ctxD.putImageData(diff, 0, 0);
}

async function handleReorderPages(newOrder) {
	if (!state.fileBytes || !state.pdf) {
		setStatus(t('needPdfOpen'), 'error');
		return;
	}
	try {
		const updated = await invokeBytes('reorder_pages', {
			bytes: Array.from(state.fileBytes),
			newOrder
		});
		const bytes = new Uint8Array(updated);
		await openPdfFromBytes(bytes, state.fileName || 'alto.pdf', { dedupe: false });
		const tab = currentTab();
		if (tab) {
			tab.dirty = true;
			persistCurrentTabState();
			renderTabs();
		}
	} catch (error) {
		console.error(error);
		setStatus(error instanceof Error ? error.message : String(error), 'error');
	}
}

async function handleExtractCurrentPage() {
	if (!state.fileBytes || !state.pdf) {
		setStatus(t('needPdfOpen'), 'error');
		return;
	}
	try {
		const targetPage = state.page;
		const extracted = await invokeBytes('extract_pages', {
			bytes: Array.from(state.fileBytes),
			pageNumbers: [targetPage]
		});
		const filename = suggestFileName(`page-${targetPage}`, `alto-page-${targetPage}.pdf`);
		await saveNativeFile(filename, 'pdf', new Uint8Array(extracted));
	} catch (error) {
		console.error(error);
		setStatus(error instanceof Error ? error.message : String(error), 'error');
	}
}

async function handleDeleteCurrentPage() {
	if (!state.fileBytes || !state.pdf) {
		setStatus(t('needPdfOpen'), 'error');
		return;
	}
	if (state.pdf.numPages <= 1) {
		setStatus(t('needPdfOpen'), 'error');
		return;
	}
	try {
		setStatus(t('deleteProcessing'));
		const targetPage = state.page;
		const updated = await invokeBytes('delete_pages', {
			bytes: Array.from(state.fileBytes),
			pageNumbers: [targetPage]
		});
		const bytes = new Uint8Array(updated);
		await openPdfFromBytes(bytes, state.fileName || 'alto.pdf', { dedupe: false });
		const newPage = Math.min(targetPage, state.pdf?.numPages || 1);
		goToPage(newPage);
		setStatus(t('deleteDone'));
		const tab = currentTab();
		if (tab) {
			tab.dirty = true;
			persistCurrentTabState();
			renderTabs();
		}
	} catch (error) {
		console.error(error);
		setStatus(error instanceof Error ? error.message : String(error), 'error');
	}
}

function openProtectModal() {
	return new Promise((resolve) => {
		const modal = elements.protectModal;
		if (!modal) {
			resolve(null);
			return;
		}
		elements.protectPasswordInput.value = '';
		elements.protectConfirmInput.value = '';
		elements.protectError.textContent = '';
		modal.classList.remove('hidden');
		setTimeout(() => elements.protectPasswordInput.focus(), 50);

		const cleanup = () => {
			modal.classList.add('hidden');
			elements.protectConfirmButton.removeEventListener('click', onConfirm);
			elements.protectCancelButton.removeEventListener('click', onCancel);
			elements.protectBackdrop.removeEventListener('click', onCancel);
			elements.protectPasswordInput.removeEventListener('keydown', onKeydown);
			elements.protectConfirmInput.removeEventListener('keydown', onKeydown);
		};

		const onCancel = () => {
			cleanup();
			resolve(null);
		};

		const onConfirm = () => {
			const password = elements.protectPasswordInput.value;
			const confirm = elements.protectConfirmInput.value;
			if (!password) {
				elements.protectError.textContent = t('protectEmpty');
				return;
			}
			if (password !== confirm) {
				elements.protectError.textContent = t('protectMismatch');
				return;
			}
			cleanup();
			resolve({ password });
		};

		const onKeydown = (event) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				onConfirm();
			} else if (event.key === 'Escape') {
				event.preventDefault();
				onCancel();
			}
		};

		elements.protectConfirmButton.addEventListener('click', onConfirm);
		elements.protectCancelButton.addEventListener('click', onCancel);
		elements.protectBackdrop.addEventListener('click', onCancel);
		elements.protectPasswordInput.addEventListener('keydown', onKeydown);
		elements.protectConfirmInput.addEventListener('keydown', onKeydown);
	});
}

// Décompose le HTML d'un bloc en segments stylés (texte + gras/italique/souligné),
// pour redessiner fidèlement le formatage partiel lors de l'export.
function extractRunsFromHtml(html, baseBold, baseItalic, baseUnderline, baseFamily) {
	const host = document.createElement('div');
	host.style.cssText = 'position:absolute;left:-99999px;top:0;white-space:pre;visibility:hidden;';
	host.style.fontWeight = baseBold ? '700' : '400';
	host.style.fontStyle = baseItalic ? 'italic' : 'normal';
	host.style.textDecoration = baseUnderline ? 'underline' : 'none';
	// On applique la police de base du bloc au host : ainsi le texte NON stylé hérite
	// de la bonne famille, et seules les portions avec un override (span/font) la
	// remplacent — getComputedStyle restitue la famille effective par run.
	if (baseFamily) host.style.fontFamily = baseFamily;
	host.innerHTML = html;
	document.body.appendChild(host);
	const runs = [];
	const walk = (node) => {
		node.childNodes.forEach((child) => {
			if (child.nodeType === Node.TEXT_NODE) {
				const text = child.textContent;
				if (!text) return;
				const cs = getComputedStyle(child.parentElement || host);
				const decoration = `${cs.textDecorationLine || ''} ${cs.textDecoration || ''}`;
				runs.push({
					text,
					bold: (parseInt(cs.fontWeight, 10) || 400) >= 600,
					italic: cs.fontStyle === 'italic' || cs.fontStyle === 'oblique',
					underline: decoration.includes('underline'),
					fontFamily: cs.fontFamily || ''
				});
			} else if (child.nodeType === Node.ELEMENT_NODE) {
				const tag = child.tagName;
				if (tag === 'BR') {
					runs.push({ text: '\n', bold: false, italic: false, underline: false, fontFamily: '' });
				} else {
					const isBlock = tag === 'DIV' || tag === 'P';
					if (isBlock && runs.length && runs[runs.length - 1].text !== '\n') {
						runs.push({ text: '\n', bold: false, italic: false, underline: false, fontFamily: '' });
					}
					walk(child);
				}
			}
		});
	};
	walk(host);
	document.body.removeChild(host);
	return runs.length ? runs : [{ text: host.innerText || '', bold: baseBold, italic: baseItalic, underline: baseUnderline, fontFamily: baseFamily || '' }];
}

async function renderFlattenedPage(pageNumber) {
	const page = await state.pdf.getPage(pageNumber);
	const viewport = page.getViewport({ scale: 2 });
	const canvas = document.createElement('canvas');
	const context = canvas.getContext('2d');
	if (!context) throw new Error('Unable to create export canvas.');

	canvas.width = Math.round(viewport.width);
	canvas.height = Math.round(viewport.height);
	await page.render({ canvasContext: context, viewport }).promise;

	const blocks = state.editBlocks.filter((block) => block.page === pageNumber);
	context.textBaseline = 'top';

	const needsOriginalCopy = blocks.some(
		(block) => !block.hidden && isBlockDirty(block) && !isBlockTextEdited(block)
	);
	let originalCopy = null;
	if (needsOriginalCopy) {
		originalCopy = document.createElement('canvas');
		originalCopy.width = canvas.width;
		originalCopy.height = canvas.height;
		originalCopy.getContext('2d').drawImage(canvas, 0, 0);
	}

	for (const block of blocks) {
		const dirty = isBlockDirty(block);
		const textEdited = isBlockTextEdited(block);
		if (!block.hidden && !dirty) continue;

		const blockScaleX = viewport.width / (block.pageWidth || viewport.width);
		const blockScaleY = viewport.height / (block.pageHeight || viewport.height);
		const originalX = block.originalX * blockScaleX;
		const originalY = block.originalY * blockScaleY;
		// Étendue D'ORIGINE (à effacer + à relire comme source) vs étendue ACTUELLE
		// (redimensionnée, où on redessine). Si non redimensionné, src == dst.
		const srcW = Math.max((block.originalWidth ?? block.width) * blockScaleX, 2);
		const srcH = Math.max((block.originalHeight ?? block.height) * blockScaleY, 2);
		const width = Math.max(block.width * blockScaleX, 2);
		const height = Math.max(block.height * blockScaleY, 2);
		context.fillStyle = '#ffffff';
		context.fillRect(originalX - 1, originalY - 1, srcW + 2, srcH + 2);

		if (block.hidden) continue;

		if (block.kind !== 'image' && textEdited) {
			context.fillStyle = block.color || '#111111';
			let family = block.serif ? 'Georgia, "Times New Roman", serif' : '-apple-system, BlinkMacSystemFont, sans-serif';
			if (block.fontMatch) family = `${block.fontMatch.family}, ${family}`;
			if (block.fontFamilyOverride) family = `${block.fontFamilyOverride}, ${family}`;
			const fontPx = block.fontSizeOverride
				? block.fontSizeOverride * blockScaleY
				: Math.max(10, height * 0.82);
			const align = block.align || 'left';
			const baseColor = block.color || '#111111';

			// Runs de formatage partiel si présents, sinon un seul run pour tout le bloc.
			// On passe la police du bloc comme base : chaque run porte alors sa famille
			// effective (héritée du bloc, ou override appliqué sur une sous-sélection).
			const runs = block.htmlEdited && block.html
				? extractRunsFromHtml(block.html, block.bold, block.italic, block.underline, family)
				: [{ text: block.text, bold: block.bold, italic: block.italic, underline: block.underline, fontFamily: family }];

			const fontFor = (run) => {
				const runFamily = run.fontFamily && run.fontFamily.trim() ? run.fontFamily : family;
				return `${run.italic ? 'italic' : 'normal'} ${run.bold ? '700' : '400'} ${fontPx}px ${runFamily}`;
			};

			// Largeur de colonne + interligne pour le retour à la ligne (paragraphes).
			const colWidth = block.multiline ? Math.max(20, width) : Infinity;
			// Interligne : pour du texte édité/collé, dérivé de la police (le bloc a pu
			// changer de nombre de lignes). Pour un paragraphe natif, hauteur/lignes.
			const lineHeightPx = block.multiline
				? (textEdited
					? fontPx * 1.32
					: Math.max(fontPx, (block.height * blockScaleY) / Math.max(1, (block.text || '').split('\n').length)))
				: fontPx;

			// Tokenisation en mots (avec espaces), \n = saut dur.
			const tokens = [];
			for (const run of runs) {
				const parts = (run.text || '').split('\n');
				parts.forEach((segment, i) => {
					if (i > 0) tokens.push({ br: true });
					for (const word of segment.split(/(\s+)/)) {
						if (word.length) tokens.push({ text: word, run });
					}
				});
			}

			// Construction des lignes (wrap à colWidth).
			const lines = [[]];
			let lineWidth = 0;
			for (const tok of tokens) {
				if (tok.br) {
					lines.push([]);
					lineWidth = 0;
					continue;
				}
				context.font = fontFor(tok.run);
				const w = context.measureText(tok.text).width;
				const isSpace = /^\s+$/.test(tok.text);
				if (!isSpace && lineWidth + w > colWidth && lines[lines.length - 1].length) {
					lines.push([]);
					lineWidth = 0;
				}
				lines[lines.length - 1].push({ text: tok.text, run: tok.run, w });
				lineWidth += w;
			}

			// Dessin ligne par ligne.
			let lineY = block.y * blockScaleY;
			for (const line of lines) {
				const totalWidth = line.reduce((acc, seg) => acc + seg.w, 0);
				let x = block.x * blockScaleX;
				if (align === 'center') x += (width - totalWidth) / 2;
				else if (align === 'right') x += width - totalWidth;
				for (const seg of line) {
					if (seg.text.trim()) {
						context.font = fontFor(seg.run);
						context.fillStyle = baseColor;
						context.fillText(seg.text, x, lineY);
						if (seg.run.underline) {
							const uy = lineY + fontPx * 1.02;
							context.strokeStyle = baseColor;
							context.lineWidth = Math.max(1, fontPx * 0.06);
							context.beginPath();
							context.moveTo(x, uy);
							context.lineTo(x + seg.w, uy);
							context.stroke();
						}
					}
					x += seg.w;
				}
				lineY += lineHeightPx;
			}
		} else if (originalCopy) {
			// Source = étendue d'origine du contenu ; destination = position + taille
			// actuelles (redimensionnées) → l'image/logo est mise à l'échelle proprement.
			context.drawImage(
				originalCopy,
				originalX,
				originalY,
				srcW,
				srcH,
				block.x * blockScaleX,
				block.y * blockScaleY,
				width,
				height
			);
		}
	}

	await drawSignaturePlacementsOnCanvas(context, canvas, pageNumber);

	const jpegBytes = await canvasToJpegBytes(canvas);
	return {
		jpegBytes: Array.from(jpegBytes),
		width: canvas.width,
		height: canvas.height
	};
}

async function drawSignaturePlacementsOnCanvas(context, canvas, pageNumber) {
	const placements = state.signaturePlacements.filter((p) => p.page === pageNumber);
	for (const placement of placements) {
		const img = await loadImageAsync(placement.dataUrl);
		if (!img) continue;
		const x = placement.xFrac * canvas.width;
		const y = placement.yFrac * canvas.height;
		const w = placement.wFrac * canvas.width;
		const h = placement.hFrac * canvas.height;
		context.save();
		context.translate(x + w / 2, y + h / 2);
		context.rotate((placement.rotation || 0) * (Math.PI / 180));
		context.drawImage(img, -w / 2, -h / 2, w, h);
		context.restore();
	}
}

function loadImageAsync(src) {
	return new Promise((resolve) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => resolve(null);
		img.src = src;
	});
}

async function canvasToPngBytes(canvas) {
	return blobToBytes(await new Promise((resolve) => canvas.toBlob(resolve, 'image/png')));
}

async function canvasToJpegBytes(canvas) {
	return blobToBytes(await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92)));
}

async function blobToBytes(blob) {
	if (!blob) throw new Error('Unable to encode page image.');
	return new Uint8Array(await blob.arrayBuffer());
}

async function saveNativeFile(filename, extension, bytes) {
	const normalizedBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	const savedPath = await invokeCommand('save_file_dialog', {
		filename,
		extension,
		data: Array.from(normalizedBytes)
	});
	if (savedPath) {
		setStatus(t('fileSaved'));
	}
	// Renvoie le chemin réel choisi par l'utilisateur (ou null), pour pouvoir
	// mettre à jour les récents et rouvrir le fichier MODIFIÉ depuis « Récents ».
	return savedPath || null;
}

function openDrawer(panel) {
	state.activeDrawer = panel;
	const titleByPanel = {
		search: ['search', 'findText'],
		notes: ['notes', 'annotations'],
		pages: ['pages', 'document'],
		edit: ['modify', 'modifyPdf'],
		outline: ['pages', 'outlineTitle'],
		forms: ['modify', 'formsTitle'],
		sign: ['sign', 'signTitle'],
		ai: ['aiKicker', 'aiTitle']
	};
	const [kicker, title] = titleByPanel[panel] || titleByPanel.search;
	elements.drawerKicker.textContent = t(kicker);
	elements.drawerTitle.textContent = t(title);
	for (const section of document.querySelectorAll('[data-drawer-section]')) {
		section.classList.toggle('hidden', section.dataset.drawerSection !== panel);
	}
	elements.drawer.classList.remove('hidden');
	if (panel === 'pages') {
		void renderThumbnailsPanel();
	} else if (panel === 'outline') {
		void renderOutlinePanel();
	} else if (panel === 'forms') {
		void renderFormsPanel();
	} else if (panel === 'sign') {
		renderSignaturesPanel();
	} else if (panel === 'ai') {
		focusAiInput();
	}
}

const _thumbnailCache = new Map();

async function renderThumbnailsPanel() {
	if (!elements.thumbsGrid) return;
	elements.thumbsGrid.innerHTML = '';
	if (!state.pdf) return;
	const fingerprint = state.fingerprint || 'unknown';
	let dragFrom = null;

	for (let pageNumber = 1; pageNumber <= state.pdf.numPages; pageNumber += 1) {
		const wrapper = document.createElement('button');
		wrapper.type = 'button';
		wrapper.className = 'thumb';
		wrapper.dataset.page = String(pageNumber);
		wrapper.draggable = true;
		if (pageNumber === state.page) wrapper.classList.add('active');
		wrapper.addEventListener('click', () => goToPage(pageNumber));

		wrapper.addEventListener('dragstart', (event) => {
			dragFrom = pageNumber;
			wrapper.classList.add('dragging');
			event.dataTransfer?.setData('text/plain', String(pageNumber));
			if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
		});
		wrapper.addEventListener('dragend', () => {
			wrapper.classList.remove('dragging');
			elements.thumbsGrid
				.querySelectorAll('.thumb.drop-target')
				.forEach((el) => el.classList.remove('drop-target'));
		});
		wrapper.addEventListener('dragover', (event) => {
			event.preventDefault();
			if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
			wrapper.classList.add('drop-target');
		});
		wrapper.addEventListener('dragleave', () => {
			wrapper.classList.remove('drop-target');
		});
		wrapper.addEventListener('drop', (event) => {
			event.preventDefault();
			wrapper.classList.remove('drop-target');
			const from = dragFrom || Number(event.dataTransfer?.getData('text/plain') || 0);
			const to = pageNumber;
			if (!from || from === to) return;
			const order = [];
			for (let n = 1; n <= state.pdf.numPages; n += 1) order.push(n);
			const moved = order.splice(from - 1, 1)[0];
			order.splice(to - 1, 0, moved);
			void handleReorderPages(order);
		});

		const canvas = document.createElement('canvas');
		const label = document.createElement('span');
		label.className = 'thumb-label';
		label.textContent = String(pageNumber);
		wrapper.append(canvas, label);
		elements.thumbsGrid.append(wrapper);

		const key = `${fingerprint}:${pageNumber}`;
		if (_thumbnailCache.has(key)) {
			const dataUrl = _thumbnailCache.get(key);
			const img = new Image();
			img.onload = () => {
				const ctx = canvas.getContext('2d');
				canvas.width = img.naturalWidth;
				canvas.height = img.naturalHeight;
				ctx?.drawImage(img, 0, 0);
			};
			img.src = dataUrl;
		} else {
			void renderThumbnailInto(pageNumber, canvas, key);
		}
	}
}

async function renderThumbnailInto(pageNumber, canvas, cacheKey) {
	try {
		const page = await state.pdf.getPage(pageNumber);
		const viewport = page.getViewport({ scale: 1 });
		const targetWidth = 160;
		const scale = targetWidth / viewport.width;
		const thumbViewport = page.getViewport({ scale });
		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		canvas.width = Math.floor(thumbViewport.width);
		canvas.height = Math.floor(thumbViewport.height);
		await page.render({ canvasContext: ctx, viewport: thumbViewport }).promise;
		_thumbnailCache.set(cacheKey, canvas.toDataURL('image/png'));
	} catch (error) {
		console.warn('Thumbnail render failed', error);
	}
}

async function renderOutlinePanel() {
	if (!elements.outlineTree || !elements.outlineEmpty) return;
	elements.outlineTree.innerHTML = '';
	elements.outlineEmpty.classList.add('hidden');
	if (!state.pdf) {
		elements.outlineEmpty.classList.remove('hidden');
		return;
	}
	try {
		const outline = await state.pdf.getOutline();
		if (!outline || outline.length === 0) {
			elements.outlineEmpty.classList.remove('hidden');
			return;
		}
		await renderOutlineItems(outline, elements.outlineTree);
	} catch (error) {
		console.warn('Outline load failed', error);
		elements.outlineEmpty.classList.remove('hidden');
	}
}

async function renderOutlineItems(items, parent) {
	for (const item of items) {
		const li = document.createElement('li');
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'outline-item';
		btn.textContent = item.title || '—';
		btn.addEventListener('click', () => goToOutlineDest(item));
		li.append(btn);
		if (item.items && item.items.length) {
			const sub = document.createElement('ol');
			sub.className = 'outline-tree';
			li.append(sub);
			await renderOutlineItems(item.items, sub);
		}
		parent.append(li);
	}
}

async function goToOutlineDest(item) {
	try {
		let dest = item.dest;
		if (typeof dest === 'string') {
			dest = await state.pdf.getDestination(dest);
		}
		if (!Array.isArray(dest) || !dest[0]) return;
		const pageIndex = await state.pdf.getPageIndex(dest[0]);
		goToPage(pageIndex + 1);
	} catch (error) {
		console.warn('Outline destination failed', error);
	}
}

async function renderFormsPanel() {
	if (!elements.formsFields || !elements.formsEmpty || !elements.formsApply) return;
	elements.formsFields.innerHTML = '';
	elements.formsEmpty.classList.add('hidden');
	elements.formsApply.disabled = true;
	if (!state.fileBytes) {
		elements.formsEmpty.textContent = t('formsEmpty');
		elements.formsEmpty.classList.remove('hidden');
		return;
	}
	let fields;
	try {
		fields = await invokeCommand('list_form_fields', { bytes: Array.from(state.fileBytes) });
	} catch (error) {
		elements.formsEmpty.textContent = String(error.message || error);
		elements.formsEmpty.classList.remove('hidden');
		return;
	}
	if (!fields || fields.length === 0) {
		elements.formsEmpty.textContent = t('formsEmpty');
		elements.formsEmpty.classList.remove('hidden');
		return;
	}

	for (const field of fields) {
		const row = document.createElement('label');
		row.className = 'forms-field';
		row.dataset.name = field.name;
		row.dataset.kind = field.kind;

		const labelSpan = document.createElement('span');
		labelSpan.className = 'forms-field-label';
		labelSpan.textContent = field.name;
		row.append(labelSpan);

		if (field.kind === 'text') {
			const input = document.createElement('input');
			input.type = 'text';
			input.className = 'forms-field-input';
			input.value = field.value || '';
			row.append(input);
		} else if (field.kind === 'checkbox') {
			const input = document.createElement('input');
			input.type = 'checkbox';
			input.className = 'forms-field-checkbox';
			input.checked = field.value === 'true';
			row.classList.add('forms-field--checkbox');
			row.append(input);
		} else if (field.kind === 'radio' && field.options && field.options.length) {
			const select = document.createElement('select');
			select.className = 'forms-field-input';
			const empty = document.createElement('option');
			empty.value = '';
			empty.textContent = '—';
			select.append(empty);
			for (const option of field.options) {
				const opt = document.createElement('option');
				opt.value = option;
				opt.textContent = option;
				if (option === field.value) opt.selected = true;
				select.append(opt);
			}
			row.append(select);
		} else {
			const ro = document.createElement('input');
			ro.type = 'text';
			ro.className = 'forms-field-input';
			ro.value = field.value || '';
			ro.disabled = true;
			row.classList.add('forms-field--readonly');
			row.append(ro);
		}

		elements.formsFields.append(row);
	}

	elements.formsApply.disabled = false;
}

async function handleFillForms() {
	if (!state.fileBytes || !elements.formsFields) return;
	const values = {};
	for (const row of elements.formsFields.querySelectorAll('.forms-field')) {
		if (row.classList.contains('forms-field--readonly')) continue;
		const name = row.dataset.name;
		if (!name) continue;
		const checkbox = row.querySelector('.forms-field-checkbox');
		if (checkbox) {
			values[name] = checkbox.checked ? 'true' : 'false';
			continue;
		}
		const control = row.querySelector('.forms-field-input');
		if (control) values[name] = control.value;
	}

	try {
		setStatus(t('formsProcessing'));
		const filled = await invokeBytes('fill_form_fields', {
			bytes: Array.from(state.fileBytes),
			values
		});
		const bytes = new Uint8Array(filled);
		const filename = suggestFileName('rempli', 'alto-rempli.pdf');
		const saved = await saveNativeFile(filename, 'pdf', bytes);
		if (saved) setStatus(t('formsDone'));
	} catch (error) {
		setStatus(String(error.message || error), 'error');
	}
}

function closeDrawer() {
	elements.drawer.classList.add('hidden');
}

function openSettings() {
	syncSettingsForm();
	elements.settingsBackdrop.classList.remove('hidden');
	elements.settingsModal.classList.remove('hidden');
}

function closeSettings() {
	elements.settingsBackdrop.classList.add('hidden');
	elements.settingsModal.classList.add('hidden');
}

function syncSettingsForm() {
	elements.settingLanguage.value = state.settings.language;
	elements.settingDefaultZoom.value = String(state.settings.defaultZoom);
	elements.settingPageLayout.value = state.settings.pageLayout === 'single' ? 'single' : 'continuous';
	elements.settingFitWidth.checked = state.settings.fitWidth;
	elements.settingShowTools.checked = state.settings.showTools;
	elements.settingShowRail.checked = state.settings.showRail;
	elements.settingShowNotes.checked = state.settings.showPageNotes;
	elements.settingShowGuides.checked = state.settings.showAlignmentGuides;
	elements.settingHighlightColor.value = state.settings.highlightColor;
	elements.settingIdentityName.value = state.settings.identityName || '';
	elements.settingIdentityEmail.value = state.settings.identityEmail || '';
	elements.settingAiProvider.value = aiState.config.provider || 'claude';
	elements.settingAiModel.value = aiState.config.model || '';
	elements.settingAiKey.value = aiState.config.apiKey || '';
	elements.settingAiBaseurl.value = aiState.config.baseUrl || '';
}

function applySettingsFromForm() {
	const previousLayout = state.settings.pageLayout;
	state.settings.language = elements.settingLanguage.value;
	state.settings.defaultZoom = Number(elements.settingDefaultZoom.value);
	state.settings.pageLayout = elements.settingPageLayout.value === 'single' ? 'single' : 'continuous';
	state.settings.fitWidth = elements.settingFitWidth.checked;
	state.settings.showTools = elements.settingShowTools.checked;
	state.settings.showRail = elements.settingShowRail.checked;
	state.settings.showPageNotes = elements.settingShowNotes.checked;
	state.settings.showAlignmentGuides = elements.settingShowGuides.checked;
	state.settings.highlightColor = elements.settingHighlightColor.value;
	state.settings.identityName = elements.settingIdentityName.value.trim();
	state.settings.identityEmail = elements.settingIdentityEmail.value.trim();
	saveSettings();
	localizeUi();
	updateUi();
	renderPageNotes();
	renderHome();
	if (state.pdf && state.settings.pageLayout !== previousLayout) {
		void transitionPageLayout();
	} else if (state.pdf && state.settings.fitWidth) {
		void fitPageWidth();
	}
}

async function saveAiConfigFromSettings() {
	const provider = elements.settingAiProvider.value;
	aiState.config = {
		provider,
		model: elements.settingAiModel.value.trim() || AI_DEFAULT_MODELS[provider] || '',
		apiKey: elements.settingAiKey.value.trim(),
		baseUrl: elements.settingAiBaseurl.value.trim()
	};
	if (aiElements.provider) {
		aiElements.provider.value = aiState.config.provider;
		aiElements.model.value = aiState.config.model;
		aiElements.key.value = aiState.config.apiKey;
		aiElements.baseUrl.value = aiState.config.baseUrl;
		updateAiProviderUi();
	}
	try {
		await invokeCommand('llm_set_config', {
			config: {
				provider: aiState.config.provider,
				api_key: aiState.config.apiKey,
				model: aiState.config.model,
				base_url: aiState.config.baseUrl
			}
		});
		setStatus(t('aiConfigSaved'));
	} catch (error) {
		console.error(error);
		setStatus(error instanceof Error ? error.message : String(error), 'error');
	}
}

function clearLocalNotes() {
	for (const key of Object.keys(localStorage)) {
		if (key.startsWith('alto-pdf-reader:')) {
			localStorage.removeItem(key);
		}
	}
	state.annotations = [];
	markDirty();
	renderPageNotes();
	renderNotes();
	updateUi();
	setStatus(t('localNotesCleared'));
}

function sanitizeFilename(name, fallback) {
	const raw = (name || '').trim();
	if (!raw) return fallback;
	const cleaned = raw
		.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	if (!cleaned) return fallback;
	return /\.pdf$/i.test(cleaned) ? cleaned : `${cleaned}.pdf`;
}

function escapeHtml(value) {
	const div = document.createElement('div');
	div.textContent = value;
	return div.innerHTML;
}

function multiplyPdfTransform(a, b) {
	return [
		a[0] * b[0] + a[2] * b[1],
		a[1] * b[0] + a[3] * b[1],
		a[0] * b[2] + a[2] * b[3],
		a[1] * b[2] + a[3] * b[3],
		a[0] * b[4] + a[2] * b[5] + a[4],
		a[1] * b[4] + a[3] * b[5] + a[5]
	];
}

function createId() {
	if (crypto.randomUUID) return crypto.randomUUID();
	return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function bindTauriMenuEvents() {
	const tauriListen = window.__TAURI__?.event?.listen;
	if (!tauriListen) return;
	tauriListen('alto-open-settings', openSettings);
	tauriListen('alto-open-pdf', () => void openViaNativeDialog());
	tauriListen('alto-export-notes', exportAnnotations);
	tauriListen('alto-export-edited-pdf', () => void exportEditedPdf());
	tauriListen('alto-save-copy', downloadOriginal);
	tauriListen('alto-save-as', downloadOriginal);
	tauriListen('alto-modify-pdf', () => toggleEditMode(true));
	tauriListen('alto-focus-search', () => {
		openDrawer('search');
		elements.searchInput.focus();
	});
	tauriListen('alto-ocr-page', () => runOcrForCurrentPage(true));
	tauriListen('alto-toggle-tools', showToolsPanel);
	tauriListen('alto-print', () => void handlePrintPdf());
	tauriListen('alto-prev-page', () => goToPage(state.page - 1));
	tauriListen('alto-next-page', () => goToPage(state.page + 1));
	tauriListen('alto-close-file', closeCurrentFile);
	tauriListen('alto-menu-unsupported', () =>
		setStatus(
			currentLocale() === 'fr'
				? 'Cette commande de menu sera ajoutée dans une prochaine version.'
				: 'This menu command will be added in a future version.',
			'error'
		)
	);
	tauriListen('alto-fit-width', () => void fitPageWidth());
	tauriListen('alto-zoom-in', () => zoomBy(0.1));
	tauriListen('alto-zoom-out', () => zoomBy(-0.1));
	tauriListen('alto-undo', () => undoEdit());
	tauriListen('alto-redo', () => redoEdit());
	tauriListen('alto-document-properties', () => void handleShowProperties());
	tauriListen('alto-recent-files', () => handleShowRecent());
	tauriListen('alto-combine-files', () => void handleCombineFiles());
	tauriListen('alto-compress-pdf', () => void handleCompressPdf());
	tauriListen('alto-protect-pdf', () => void handleProtectPdf());
	tauriListen('alto-delete-page', () => void handleDeleteCurrentPage());
	tauriListen('alto-rotate-page-cw', () => void handleRotateCurrentPage(90));
	tauriListen('alto-rotate-page-ccw', () => void handleRotateCurrentPage(-90));
	tauriListen('alto-organize-pages', () => openDrawer('pages'));
	tauriListen('alto-open-files-available', () => {
		void drainPendingOpenFiles();
	});

	void drainPendingOpenFiles();
}

async function drainPendingOpenFiles() {
	try {
		const pending = await invokeCommand('take_pending_open_files');
		if (!Array.isArray(pending) || !pending.length) return;
		for (const file of pending) {
			const fileName = file.fileName || file.file_name || 'document.pdf';
			const bytes = new Uint8Array(file.bytes);
			await openPdfFromBytes(bytes, fileName);
			await rememberRecentFile(file.path || '', fileName);
		}
	} catch (error) {
		console.warn('drainPendingOpenFiles failed', error);
	}
}

function showToolsPanel() {
	// « Tous les outils » doit toujours ramener à l'accueil des outils ET quitter
	// le mode Modifier s'il est actif (sinon l'onglet Modifier reste sélectionné).
	if (state.editMode) {
		exitEditMode();
	}
	state.settings.showTools = true;
	elements.settingShowTools.checked = true;
	saveSettings();
	closeDrawer();
	updateUi();
}

async function requestCloseTab(tabId) {
	const tab = state.tabs.find((candidate) => candidate.id === tabId);
	if (!tab) return;
	if (tab.id === state.activeTabId) {
		persistCurrentTabState();
	}
	if (tab.dirty) {
		state.pendingCloseTabId = tab.id;
		showSaveChangesModal(tab);
		return;
	}
	await closeTab(tab.id);
}

function showSaveChangesModal(tab) {
	const base = (tab.fileName || t('untitledPdf')).replace(/\.pdf$/i, '');
	elements.saveChangesFilename.value = base;
	elements.saveChangesMessage.textContent = t('saveChangesMessage');
	elements.saveChangesModal.querySelector('h2').textContent = t('saveChangesTitle');
	elements.saveConfirmClose.textContent = t('saveChangesConfirm');
	elements.saveDiscardClose.textContent = t('saveChangesDiscard');
	elements.saveCancelClose.textContent = t('saveChangesCancel');
	elements.saveChangesBackdrop.classList.remove('hidden');
	elements.saveChangesModal.classList.remove('hidden');
	requestAnimationFrame(() => {
		elements.saveChangesFilename.focus();
		elements.saveChangesFilename.select();
	});
}

function hideSaveChangesModal() {
	state.pendingCloseTabId = null;
	elements.saveChangesBackdrop.classList.add('hidden');
	elements.saveChangesModal.classList.add('hidden');
}

async function closeTab(tabId) {
	const closingIndex = state.tabs.findIndex((tab) => tab.id === tabId);
	if (closingIndex === -1) return;
	const wasActive = state.activeTabId === tabId;
	state.tabs.splice(closingIndex, 1);

	if (!state.tabs.length) {
		state.activeTabId = null;
		state.viewingHome = false;
		clearActiveDocumentState();
		elements.emptyState.classList.remove('hidden');
		renderHome();
		closeDrawer();
		renderTabs();
		updateUi();
		return;
	}

	if (wasActive) {
		const nextTab = state.tabs[Math.min(closingIndex, state.tabs.length - 1)];
		state.viewingHome = false;
		state.activeTabId = nextTab.id;
		loadTabIntoState(nextTab);
		elements.emptyState.classList.add('hidden');
		elements.pagesStack.classList.remove('hidden');
		closeDrawer();
		renderTabs();
		updateUi();
		await mountPagesStack();
		return;
	}

	renderTabs();
}

function closeCurrentFile() {
	if (!state.activeTabId) return;
	void requestCloseTab(state.activeTabId);
}

async function saveAndClosePendingTab() {
	const tabId = state.pendingCloseTabId;
	if (!tabId) return;
	const tab = state.tabs.find((candidate) => candidate.id === tabId);
	if (!tab) {
		hideSaveChangesModal();
		return;
	}
	const userName = elements.saveChangesFilename.value || '';
	const previousActiveTabId = state.activeTabId;
	if (tab.id !== state.activeTabId) {
		persistCurrentTabState();
		state.activeTabId = tab.id;
		loadTabIntoState(tab);
		await renderCurrentPage();
	}
	const suggested = userName.trim() ? `${userName.trim().replace(/\.pdf$/i, '')}.pdf` : undefined;
	const saved = await exportEditedPdf(suggested);
	if (!saved) {
		return;
	}
	hideSaveChangesModal();
	await closeTab(tab.id);
	if (previousActiveTabId && state.tabs.some((candidate) => candidate.id === previousActiveTabId)) {
		await activateTab(previousActiveTabId);
	}
}

async function discardAndClosePendingTab() {
	const tabId = state.pendingCloseTabId;
	hideSaveChangesModal();
	if (tabId) {
		await closeTab(tabId);
	}
}

function cancelPendingTabClose() {
	hideSaveChangesModal();
}

function resetToStartScreen() {
	state.viewingHome = false;
	clearActiveDocumentState();
	elements.emptyState.classList.remove('hidden');
	renderHome();
	closeDrawer();
	renderEditBlocks();
	updateUi();
}

function openCreateView() {
	state.createSource = state.createSource || 'file';
	elements.createView.classList.remove('hidden');
	elements.emptyState.classList.add('hidden');
	elements.pagesStack.classList.add('hidden');
	updateCreateSourceUi();
}

function closeCreateView() {
	elements.createView.classList.add('hidden');
	if (state.pdf) {
		elements.pagesStack.classList.remove('hidden');
	} else {
		elements.emptyState.classList.remove('hidden');
		renderHome();
	}
}

function selectCreateSource(source) {
	state.createSource = source;
	updateCreateSourceUi();
}

function updateCreateSourceUi() {
	elements.createSources.querySelectorAll('[data-create-source]').forEach((button) => {
		button.classList.toggle('active', button.dataset.createSource === state.createSource);
	});
	if (state.createSource === 'blank') {
		elements.createPick.style.display = 'none';
		elements.createHint.textContent = 'Une page A4 blanche sera créée.';
	} else {
		elements.createPick.style.display = '';
		elements.createHint.textContent = 'Choisir parmi .pdf pour le moment (autres formats à venir).';
	}
}

async function confirmCreate() {
	if (state.createSource === 'file') {
		elements.fileInput.click();
		return;
	}
	if (state.createSource === 'blank') {
		try {
			const bytes = await invokeBytes('create_blank_pdf');
			const blob = new Blob([new Uint8Array(bytes)], { type: 'application/pdf' });
			const file = new File([blob], 'Nouveau document.pdf', { type: 'application/pdf' });
			closeCreateView();
			await openFile(file);
		} catch (error) {
			console.error(error);
			setStatus(error instanceof Error ? error.message : 'Création impossible.', 'error');
		}
	}
}

function zoomBy(delta) {
	if (!state.pdf) return;
	// Zoom manuel → on quitte le mode « ajuster » : le bouton du rail se désélectionne.
	state.fitMode = null;
	state.settings.fitWidth = false;
	elements.settingFitWidth.checked = false;
	saveSettings();
	state.zoom = Math.max(0.65, Math.min(2.75, Number((state.zoom + delta).toFixed(2))));
	updateUi();
	void relayoutPagesStack();
}

elements.railLayoutSingle.addEventListener('click', () => {
	void toggleSinglePageLayout();
});

let _scrollRaf = 0;
elements.dropZone.addEventListener(
	'scroll',
	() => {
		if (_scrollRaf) return;
		_scrollRaf = requestAnimationFrame(() => {
			_scrollRaf = 0;
			detectActivePageFromScroll();
		});
	},
	{ passive: true }
);

let _wheelPageCooldown = 0;
elements.dropZone.addEventListener(
	'wheel',
	(event) => {
		if (!state.pdf) return;
		if (state.settings.pageLayout !== 'single') return;
		if (event.ctrlKey || event.metaKey) return;
		const now = Date.now();
		if (now < _wheelPageCooldown) return;
		if (Math.abs(event.deltaY) < 2) return;
		if (event.deltaY > 0 && state.page < state.pdf.numPages) {
			_wheelPageCooldown = now + 280;
			event.preventDefault();
			goToPage(state.page + 1);
		} else if (event.deltaY < 0 && state.page > 1) {
			_wheelPageCooldown = now + 280;
			event.preventDefault();
			goToPage(state.page - 1);
		}
	},
	{ passive: false }
);

elements.openButton.addEventListener('click', () => void openViaNativeDialog());
elements.chooseEmpty.addEventListener('click', () => void openViaNativeDialog());
elements.homeOpen?.addEventListener('click', () => void openViaNativeDialog());
elements.homeDropzone?.addEventListener('click', () => void openViaNativeDialog());
elements.homeCreate?.addEventListener('click', () => openCreateView());
elements.homeClearRecents?.addEventListener('click', () => {
	saveRecentFiles([]);
	renderHome();
});
elements.profileAvatar?.addEventListener('click', () => openSettings());
elements.homeButton?.addEventListener('click', () => showHome());
for (const btn of elements.homeViewButtons) {
	btn.addEventListener('click', () => {
		state.homeView = btn.dataset.homeView === 'list' ? 'list' : 'grid';
		try {
			localStorage.setItem('alto-home-view', state.homeView);
		} catch (_err) {
			/* noop */
		}
		renderHome();
	});
}
elements.createTabButton.addEventListener('click', () => openCreateView());
elements.createClose.addEventListener('click', () => closeCreateView());
elements.createSources.addEventListener('click', (event) => {
	const button = event.target.closest('[data-create-source]');
	if (!button || button.disabled) return;
	selectCreateSource(button.dataset.createSource);
});
elements.createPick.addEventListener('click', () => {
	if (state.createSource === 'file') elements.fileInput.click();
});
elements.createConfirm.addEventListener('click', () => confirmCreate());
elements.fileInput.addEventListener('change', (event) => {
	const file = event.target.files?.[0];
	if (file) void openFile(file);
	event.target.value = '';
});

elements.prevPage.addEventListener('click', () => goToPage(state.page - 1));
elements.nextPage.addEventListener('click', () => goToPage(state.page + 1));
elements.railZoomOut.addEventListener('click', () => zoomBy(-0.1));
elements.railZoomIn.addEventListener('click', () => zoomBy(0.1));
elements.railFitWidth.addEventListener('click', () => {
	// Bouton « ajuster » du rail : on montre la PAGE ENTIÈRE (largeur ET hauteur),
	// déterministe → cliquer plusieurs fois donne toujours le même zoom (stable).
	// Le bouton passe en état actif et le % se met à jour (via updateUi).
	state.fitMode = 'page';
	void fitSinglePageToViewport();
});

// Responsive : quand la fenêtre change de taille, on ré-ajuste la page au cadre.
// - mode « page unique » → on refait tenir la PAGE ENTIÈRE (largeur + hauteur) ;
// - mode « largeur de page » → on refait tenir la LARGEUR.
// Debounce léger pour ne pas re-rendre à chaque pixel pendant le drag de la fenêtre.
let _resizeFitToken = 0;
window.addEventListener('resize', () => {
	if (!state.pdf) return;
	if (_resizeFitToken) clearTimeout(_resizeFitToken);
	_resizeFitToken = window.setTimeout(() => {
		_resizeFitToken = 0;
		if (state.settings.pageLayout === 'single') {
			void fitSinglePageToViewport();
		} else if (state.settings.fitWidth) {
			void fitPageWidth();
		}
	}, 140);
});
elements.downloadOriginal.addEventListener('click', downloadOriginal);
elements.exportAnnotations.addEventListener('click', exportAnnotations);
elements.exportEditedPdf.addEventListener('click', () => void exportEditedPdf());
elements.saveButton?.addEventListener('click', () => void handleSaveDocument());
elements.highlightButton.addEventListener('click', () => createAnnotation('highlight'));
elements.commentButton.addEventListener('click', () => createAnnotation('comment'));
elements.modifyTab.addEventListener('click', () => toggleEditMode());
elements.modifyTool.addEventListener('click', () => toggleEditMode(true));
elements.exitEditMode.addEventListener('click', exitEditMode);
elements.scanEditBlocks.addEventListener('click', scanEditableBlocks);
elements.ocrCurrentPage.addEventListener('click', () => runOcrForCurrentPage(true));
// ── Sélection au rectangle (marquee) ────────────────────────────────────────
// En mode édition, un drag sur une zone vide d'une page dessine un rectangle bleu.
// Au relâcher, tous les blocs de cette page que le rectangle touche sont sélectionnés
// (puis Suppr les efface tous).
let suppressNextPageClick = false;

elements.pagesStack.addEventListener('pointerdown', (event) => {
	if (!state.editMode || event.button !== 0 || state.editingBlockId) return;
	// Le drag doit démarrer sur le FOND d'une page (edit-layer), pas sur un bloc.
	const editLayer = event.target.classList?.contains('edit-layer') ? event.target : null;
	if (!editLayer) return;

	const pageNumber = Number(editLayer.dataset.page);
	const data = getPageData(pageNumber);
	if (!data) return;

	const rect = editLayer.getBoundingClientRect();
	const sx = data.viewportWidth / Math.max(1, rect.width);
	const sy = data.viewportHeight / Math.max(1, rect.height);
	const toLocal = (e) => ({
		x: Math.max(0, Math.min(data.viewportWidth, (e.clientX - rect.left) * sx)),
		y: Math.max(0, Math.min(data.viewportHeight, (e.clientY - rect.top) * sy))
	});
	const start = toLocal(event);

	let marquee = null;
	let dragging = false;

	// Blocs (non masqués) de la page dont la boîte intersecte le rectangle courant.
	const blocksInRect = (left, top, right, bottom) =>
		state.editBlocks.filter((block) => {
			if (block.page !== pageNumber || block.hidden) return false;
			const bw = Math.max(block.width, 1);
			const bh = Math.max(block.height, 1);
			return block.x < right && block.x + bw > left && block.y < bottom && block.y + bh > top;
		});

	const onMove = (moveEvent) => {
		const cur = toLocal(moveEvent);
		const dx = cur.x - start.x;
		const dy = cur.y - start.y;
		if (!dragging) {
			if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
			dragging = true;
			marquee = document.createElement('div');
			marquee.className = 'selection-marquee';
			editLayer.append(marquee);
		}
		const selLeft = Math.min(start.x, cur.x);
		const selTop = Math.min(start.y, cur.y);
		marquee.style.left = `${selLeft}px`;
		marquee.style.top = `${selTop}px`;
		marquee.style.width = `${Math.abs(dx)}px`;
		marquee.style.height = `${Math.abs(dy)}px`;

		// Surbrillance PROGRESSIVE : on marque/démarque chaque bloc en direct selon
		// qu'il touche le rectangle (sans re-render, pour ne pas détruire le marquee).
		const hitIds = new Set(
			blocksInRect(selLeft, selTop, Math.max(start.x, cur.x), Math.max(start.y, cur.y)).map((b) =>
				String(b.id)
			)
		);
		editLayer.querySelectorAll('.edit-block').forEach((el) => {
			el.classList.toggle('selected', hitIds.has(el.dataset.blockId));
		});
	};

	const onUp = (upEvent) => {
		window.removeEventListener('pointermove', onMove);
		window.removeEventListener('pointerup', onUp);
		if (!dragging) return;
		const cur = toLocal(upEvent);
		const selLeft = Math.min(start.x, cur.x);
		const selTop = Math.min(start.y, cur.y);
		const selRight = Math.max(start.x, cur.x);
		const selBottom = Math.max(start.y, cur.y);
		if (marquee) marquee.remove();

		const hits = blocksInRect(selLeft, selTop, selRight, selBottom);

		// Empêche le clic de fin de drag de vider la sélection qu'on vient de faire.
		suppressNextPageClick = true;
		if (!hits.length) {
			clearBlockSelection();
		} else {
			state.selectedBlockIds = hits.map((block) => block.id);
			state.selectedBlockId = hits[0].id;
			refreshBlockFontInfo(hits[0]);
		}
		renderEditBlocks();
		updateSelectedEditField();
	};

	window.addEventListener('pointermove', onMove);
	window.addEventListener('pointerup', onUp);
});

elements.pagesStack.addEventListener('click', (event) => {
	// Un marquee vient d'aboutir : on ne traite pas le clic de fin de drag
	// (sinon il viderait la sélection qu'on vient de faire).
	if (suppressNextPageClick) {
		suppressNextPageClick = false;
		return;
	}
	if (event.target.closest('.edit-block') || event.target.closest('.sign-placement')) return;
	let changed = false;
	if (state.editingBlockId === null && clearBlockSelection()) {
		changed = true;
	}
	if (state.selectedSignatureId) {
		state.selectedSignatureId = null;
		renderAllSignaturePlacements();
	}
	if (changed) {
		renderEditBlocks();
		updateSelectedEditField();
	}
});
elements.undoButton?.addEventListener('click', undoEdit);
elements.redoButton?.addEventListener('click', redoEdit);
document.addEventListener(
	'keydown',
	(event) => {
		if ((event.key !== 'Backspace' && event.key !== 'Delete') || event.metaKey || event.ctrlKey || event.altKey) {
			return;
		}

		const target = event.target;
		const isFormField =
			target &&
			(target.tagName === 'INPUT' ||
				target.tagName === 'TEXTAREA' ||
				(target.isContentEditable && !target.classList?.contains('pdf-glyph-editing')));

		// Bloc(s) sélectionné(s) (hors édition) : Suppr/Retour supprime le(s) bloc(s).
		if (!state.editingBlockId) {
			const hasSelection =
				state.selectedBlockId || (state.selectedBlockIds && state.selectedBlockIds.length);
			if (state.editMode && hasSelection && !isFormField) {
				event.preventDefault();
				event.stopPropagation();
				hideSelectedBlock();
			}
			return;
		}

		// En édition « glyphe » (texte PDF non encore ré-écrit) : Backspace efface le
		// caractère avant le caret. (Delete/sélection sont gérés au niveau du bloc.)
		if (event.key !== 'Backspace') return;
		const block = state.editBlocks.find((candidate) => candidate.id === state.editingBlockId);
		if (!block || !Array.isArray(block.pdfChars) || !block.pdfChars.length) return;
		// Bloc déjà converti en édition texte : le caret natif gère Backspace.
		if (isBlockTextEdited(block)) return;
		if (isFormField) return;

		event.preventDefault();
		event.stopPropagation();
		deletePdfTextBeforeCaret(block);
	},
	true
);
document.addEventListener('keydown', (event) => {
	const key = event.key.toLowerCase();
	const meta = event.metaKey || event.ctrlKey;
	if (!meta) return;
	const target = event.target;
	const isField =
		target &&
		(target.tagName === 'INPUT' ||
			target.tagName === 'TEXTAREA' ||
			target.isContentEditable);
	if (isField) return;
	if (key === 'z' && !event.shiftKey) {
		event.preventDefault();
		undoEdit();
	} else if ((key === 'z' && event.shiftKey) || key === 'y') {
		event.preventDefault();
		redoEdit();
	} else if (key === 's' && state.pdf) {
		event.preventDefault();
		void handleSaveDocument();
	}
});
elements.applyEditText.addEventListener('click', applySelectedText);
elements.deleteEditBlock.addEventListener('click', hideSelectedBlock);
elements.applyEditTextPanel.addEventListener('click', applySelectedText);
elements.deleteEditBlockPanel.addEventListener('click', hideSelectedBlock);

setupFontCombo();
elements.formatSize?.addEventListener('change', () => {
	const size = parseFloat(elements.formatSize.value);
	if (!Number.isFinite(size) || size < 4) return;
	applyFormatChange((block) => {
		block.fontSizeOverride = size;
		block.baseFontSize = size;
	});
});
elements.formatColor?.addEventListener('input', () => {
	const color = elements.formatColor.value;
	applyFormatChange((block) => {
		block.color = color;
	});
});
// Empêche le panneau de format de voler le focus de la zone éditable :
// sans ça, le `blur` du contenteditable déclencherait finishInlineEdit (= sortie d'édition)
// dès qu'on clique sur B/I/U. Le clic du bouton continue de se déclencher normalement.
elements.formatPanel?.addEventListener('pointerdown', (event) => {
	if (state.editingBlockId && event.target instanceof Element && event.target.closest('button')) {
		event.preventDefault();
	}
});
elements.formatBold?.addEventListener('click', () => {
	if (applyInlineStyleToSelection('bold')) return;
	applyFormatChange((block) => {
		const current = block.boldOverride !== undefined ? block.boldOverride : Boolean(block.bold);
		block.boldOverride = !current;
		block.bold = !current;
	});
});
elements.formatItalic?.addEventListener('click', () => {
	if (applyInlineStyleToSelection('italic')) return;
	applyFormatChange((block) => {
		const current = block.italicOverride !== undefined ? block.italicOverride : Boolean(block.italic);
		block.italicOverride = !current;
		block.italic = !current;
	});
});
elements.formatUnderline?.addEventListener('click', () => {
	if (applyInlineStyleToSelection('underline')) return;
	applyFormatChange((block) => {
		block.underline = !block.underline;
	});
});
for (const button of elements.formatAlignButtons) {
	button.addEventListener('click', () => {
		applyFormatChange((block) => {
			block.align = button.dataset.align;
		});
	});
}
elements.editText.addEventListener('keydown', (event) => {
	if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
		applySelectedText();
	}
});
elements.editTextPanel.addEventListener('keydown', (event) => {
	if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
		applySelectedText();
	}
});
elements.toggleMoreTools.addEventListener('click', () => {
	const isHidden = elements.moreTools.classList.toggle('hidden');
	elements.toggleMoreTools.textContent = isHidden ? t('showMore') : t('showLess');
});

if (elements.formsApply) {
	elements.formsApply.addEventListener('click', () => void handleFillForms());
}

document.addEventListener(
	'pointerdown',
	(event) => {
		const targetEl = event.target instanceof Element ? event.target : null;
		const insideEditBlock = targetEl ? targetEl.closest('.edit-block') : null;
		const insideSign = targetEl ? targetEl.closest('.sign-placement') : null;
		// Clic sur le panneau de format (police, gras, etc.) : ne pas quitter l'édition
		// ni effacer la sélection. Le focus reste dans la zone éditable.
		if (targetEl && targetEl.closest('#format-panel')) {
			return;
		}

		if (state.editingBlockId) {
			const editing = elements.pagesStack.querySelector(
				`.edit-block.editing[data-block-id="${state.editingBlockId}"]`
			);
			const clickInsideSame =
				editing && event.target instanceof Node && editing.contains(event.target);
			if (!clickInsideSame) {
				finishInlineEdit(state.editingBlockId, editing ? editing.innerText : '');
			} else {
				return;
			}
		}

		// Clic dans le vide : on retire la sélection (cadre bleu) et la signature active.
		if (!insideEditBlock && !insideSign) {
			let changed = false;
			if (clearBlockSelection()) {
				changed = true;
			}
			if (state.selectedSignatureId) {
				state.selectedSignatureId = null;
				renderAllSignaturePlacements();
			}
			if (changed) {
				renderEditBlocks();
				updateSelectedEditField();
			}
		}
	},
	true
);

document.addEventListener('keydown', (event) => {
	if (event.key !== 'Escape') return;
	if (state.editingBlockId) return;
	const target = event.target;
	if (target && target instanceof HTMLElement) {
		const tag = target.tagName;
		if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
	}
	if (state.editMode) {
		event.preventDefault();
		exitEditMode();
	}
});
elements.drawerClose.addEventListener('click', closeDrawer);
elements.settingsButton.addEventListener('click', openSettings);
elements.settingsClose.addEventListener('click', closeSettings);
elements.settingsDone.addEventListener('click', closeSettings);
elements.settingsBackdrop.addEventListener('click', closeSettings);
elements.clearLocalData.addEventListener('click', clearLocalNotes);
elements.connectClaude?.addEventListener('click', async () => {
	try {
		await invokeCommand('connect_claude_desktop', {});
		setStatus(t('connectClaudeDone'));
	} catch (error) {
		console.error(error);
		setStatus(error instanceof Error ? error.message : String(error), 'error');
	}
});
elements.copyMcpPath?.addEventListener('click', async () => {
	try {
		const path = await invokeCommand('mcp_binary_path', {});
		await navigator.clipboard.writeText(path);
		setStatus(t('mcpPathCopied'));
	} catch (error) {
		console.error(error);
		setStatus(error instanceof Error ? error.message : String(error), 'error');
	}
});
document.querySelectorAll('[data-settings-tab]').forEach((tab) => {
	tab.addEventListener('click', () => {
		const target = tab.dataset.settingsTab;
		document.querySelectorAll('[data-settings-tab]').forEach((button) => {
			button.classList.toggle('active', button === tab);
		});
		document.querySelectorAll('[data-settings-pane]').forEach((pane) => {
			pane.classList.toggle('hidden', pane.dataset.settingsPane !== target);
		});
	});
});
elements.saveConfirmClose.addEventListener('click', () => {
	void saveAndClosePendingTab();
});
elements.saveDiscardClose.addEventListener('click', () => {
	void discardAndClosePendingTab();
});
elements.saveCancelClose.addEventListener('click', cancelPendingTabClose);
elements.saveChangesBackdrop.addEventListener('click', cancelPendingTabClose);
elements.saveChangesFilename.addEventListener('keydown', (event) => {
	if (event.key === 'Enter') {
		event.preventDefault();
		void saveAndClosePendingTab();
	}
});

elements.propertiesCloseButton?.addEventListener('click', closePropertiesModal);
elements.propertiesBackdrop?.addEventListener('click', closePropertiesModal);
elements.recentCloseButton?.addEventListener('click', closeRecentModal);
elements.recentBackdrop?.addEventListener('click', closeRecentModal);
elements.recentClearButton?.addEventListener('click', () => {
	saveRecentFiles([]);
	handleShowRecent();
});
elements.compareClose?.addEventListener('click', closeCompareModal);
elements.compareBackdrop?.addEventListener('click', closeCompareModal);
elements.comparePickA?.addEventListener('click', () => void comparePickFile('A'));
elements.comparePickB?.addEventListener('click', () => void comparePickFile('B'));
elements.comparePrev?.addEventListener('click', () => {
	_compareState.page = Math.max(1, _compareState.page - 1);
	void renderComparePage();
});
elements.compareNext?.addEventListener('click', () => {
	_compareState.page += 1;
	void renderComparePage();
});

for (const control of [
	elements.settingLanguage,
	elements.settingDefaultZoom,
	elements.settingPageLayout,
	elements.settingFitWidth,
	elements.settingShowTools,
	elements.settingShowRail,
	elements.settingShowNotes,
	elements.settingShowGuides,
	elements.settingHighlightColor,
	elements.settingIdentityName,
	elements.settingIdentityEmail
]) {
	control.addEventListener('change', applySettingsFromForm);
}

for (const control of [
	elements.settingAiProvider,
	elements.settingAiModel,
	elements.settingAiKey,
	elements.settingAiBaseurl
]) {
	control.addEventListener('change', () => void saveAiConfigFromSettings());
}

document.querySelectorAll('[data-open-panel]').forEach((button) => {
	button.addEventListener('click', () => {
		if (button.dataset.openPanel === 'tools') {
			showToolsPanel();
			return;
		}

		openDrawer(button.dataset.openPanel);
	});
});

document.querySelectorAll('[data-close-panel]').forEach((button) => {
	button.addEventListener('click', () => {
		state.settings.showTools = false;
		elements.settingShowTools.checked = false;
		saveSettings();
		updateUi();
	});
});

document.querySelectorAll('[data-open-settings]').forEach((button) => {
	button.addEventListener('click', openSettings);
});

document.querySelectorAll('[data-tool-action]').forEach((button) => {
	button.addEventListener('click', () => {
		switch (button.dataset.toolAction) {
			case 'export-edited-pdf':
				void exportEditedPdf();
				break;
			case 'ocr-page':
				void runOcrForCurrentPage(true);
				break;
			case 'combine':
				void handleCombineFiles();
				break;
			case 'protect':
				void handleProtectPdf();
				break;
			case 'compress':
				void handleCompressPdf();
				break;
			case 'deskew':
				void handleDeskewPdf();
				break;
			case 'print':
				handlePrintPdf();
				break;
			case 'rotate-cw':
				void handleRotateCurrentPage(90);
				break;
			case 'rotate-ccw':
				void handleRotateCurrentPage(-90);
				break;
			case 'delete-page':
				void handleDeleteCurrentPage();
				break;
			case 'extract-page':
				void handleExtractCurrentPage();
				break;
			case 'export-image':
				void handleExportPageImage();
				break;
			case 'properties':
				void handleShowProperties();
				break;
			case 'recent':
				handleShowRecent();
				break;
			case 'compare-files':
				openCompareModal();
				break;
			case 'watermark':
				void handleWatermark();
				break;
			case 'page-numbers':
				void handlePageNumbers();
				break;
			case 'images-to-pdf':
				void handleImagesToPdf();
				break;
			case 'crop':
				void handleCrop();
				break;
			case 'auto-redact':
				void handleAutoRedact();
				break;
			case 'flatten':
				void handleFlatten();
				break;
			case 'extract-images':
				void handleExtractImages();
				break;
			case 'unlock':
				void handleUnlock();
				break;
			case 'sanitize':
				void handleSanitize();
				break;
			case 'ocr-searchable':
				void handleOcrSearchable();
				break;
			case 'sign-certificate':
				void handleSignPdf();
				break;
			case 'repair':
				void handleRepairPdf();
				break;
			case 'remove-annotations':
				void handleRemoveAnnotations();
				break;
			case 'remove-blank-pages':
				void handleRemoveBlankPages();
				break;
			case 'bookmarks':
				void handleBookmarks();
				break;
			default:
				setStatus(
					currentLocale() === 'fr'
						? 'Cette action n’est pas encore disponible.'
						: 'This action is not available yet.',
					'error'
				);
		}
	});
});

document.querySelectorAll('[data-tool-disabled]').forEach((button) => {
	button.addEventListener('click', () =>
		setStatus(
			currentLocale() === 'fr'
				? 'Cette fonction n’est pas encore disponible.'
				: button.dataset.toolDisabled,
			'error'
		)
	);
});

elements.searchForm.addEventListener('submit', async (event) => {
	event.preventDefault();
	if (!state.pdf) return;
	const query = elements.searchInput.value.trim();
	if (!query) return;

	elements.searchButton.disabled = true;
	elements.searchButton.textContent = '...';
	openDrawer('search');

	try {
		const results = await searchDocument(query);
		state.search = {
			query,
			results,
			activeIndex: results.length ? 0 : -1
		};
		if (results[0]) {
			goToResult(results[0], 0);
		} else {
			renderResults();
		}
		setStatus(results.length ? t('resultsFound', results.length) : t('noResults'));
	} catch (error) {
		console.error(error);
		setStatus(error instanceof Error ? error.message : 'Search failed.', 'error');
	} finally {
		elements.searchButton.textContent = t('search');
		updateUi();
	}
});

for (const eventName of ['dragenter', 'dragover']) {
	document.addEventListener(eventName, (event) => {
		event.preventDefault();
		elements.dropZone.classList.add('dragging');
	});
}

for (const eventName of ['dragleave', 'drop']) {
	document.addEventListener(eventName, (event) => {
		event.preventDefault();
		elements.dropZone.classList.remove('dragging');
	});
}

document.addEventListener('drop', (event) => {
	const file = event.dataTransfer?.files?.[0];
	if (file) void openFile(file);
});

window.addEventListener('resize', () => {
	if (state.pdf && state.settings.fitWidth) {
		void fitPageWidth();
	}
});

// ── Mise à jour automatique ─────────────────────────────────────────────
let _updateInProgress = false;

async function checkForUpdates() {
	try {
		const info = await invokeCommand('check_for_update');
		if (info && info.version) showUpdateToast(info);
	} catch (_) {
		// Vérification silencieuse : aucune mise à jour ou réseau indisponible.
	}
}

function showUpdateToast(info) {
	if (document.getElementById('slate-update-toast')) return;
	const fr = currentLocale() === 'fr';
	const toast = document.createElement('div');
	toast.id = 'slate-update-toast';
	toast.className = 'slate-update-toast';
	toast.setAttribute('role', 'alert');
	toast.innerHTML = `
		<div class="slate-update-toast-body">
			<span class="slate-update-toast-icon" aria-hidden="true">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M5 21h14"/></svg>
			</span>
			<div class="slate-update-toast-text">
				<div class="slate-update-toast-title">${fr ? 'Mise à jour disponible' : 'Update available'}</div>
				<div class="slate-update-toast-sub">${fr ? `Slate ${info.version} est prêt à être installé.` : `Slate ${info.version} is ready to install.`}</div>
			</div>
		</div>
		<div class="slate-update-toast-actions">
			<button type="button" class="slate-update-later">${fr ? 'Plus tard' : 'Later'}</button>
			<button type="button" class="slate-update-now">${fr ? 'Mettre à jour' : 'Update'}</button>
		</div>
		<div class="slate-update-progress" hidden><div class="slate-update-progress-bar"></div></div>
	`;
	document.body.appendChild(toast);
	requestAnimationFrame(() => toast.classList.add('is-visible'));

	toast.querySelector('.slate-update-later').addEventListener('click', () => dismissUpdateToast(toast));
	toast.querySelector('.slate-update-now').addEventListener('click', () => void startUpdateInstall(toast));
}

function dismissUpdateToast(toast) {
	toast.classList.remove('is-visible');
	setTimeout(() => toast.remove(), 280);
}

async function startUpdateInstall(toast) {
	if (_updateInProgress) return;
	_updateInProgress = true;
	const fr = currentLocale() === 'fr';
	const actions = toast.querySelector('.slate-update-toast-actions');
	const sub = toast.querySelector('.slate-update-toast-sub');
	const progress = toast.querySelector('.slate-update-progress');
	const bar = toast.querySelector('.slate-update-progress-bar');
	if (actions) actions.remove();
	if (progress) progress.hidden = false;
	if (sub) sub.textContent = fr ? 'Téléchargement de la mise à jour…' : 'Downloading update…';

	const tauriListen = window.__TAURI__?.event?.listen;
	let unlisten = null;
	if (tauriListen) {
		unlisten = await tauriListen('slate-update-progress', (event) => {
			const payload = event?.payload || {};
			if (payload.total && bar) {
				const pct = Math.min(100, Math.round((payload.downloaded / payload.total) * 100));
				bar.style.width = `${pct}%`;
			}
		});
	}

	try {
		// install_update télécharge, installe, puis redémarre l'app : on ne revient
		// normalement jamais ici en cas de succès.
		await invokeCommand('install_update');
	} catch (err) {
		_updateInProgress = false;
		if (typeof unlisten === 'function') unlisten();
		if (sub) sub.textContent = fr ? 'Échec de la mise à jour. Réessayez plus tard.' : 'Update failed. Please try again later.';
		setStatus(fr ? 'La mise à jour a échoué.' : 'Update failed.', 'error');
	}
}

bindTauriMenuEvents();
setupTabsScrolling();
setupPreciseSelectionOverlay();
setupDefaultAppPrompt();
setupSignFeature();
setupAiAssistant();
setupToolsResize();
syncSettingsForm();
applyIcons();
localizeUi();
updateUi();
renderHome();
// Précharge le catalogue de polices au démarrage (liste prête dès la 1re ouverture
// du panneau de mise en forme, et le backend a le temps de répondre).
void ensureFontSelectPopulated();

// Vérifie les mises à jour en arrière-plan, sans bloquer le démarrage.
setTimeout(() => void checkForUpdates(), 3500);
