import * as pdfjsLib from './vendor/pdf.min.mjs';
import {
	BlockState,
	blockState,
	configureBlockState,
	isBlockDirty,
	isBlockTextEdited,
	hasLocalGlyphEdits,
	isLiveTextBlock,
	nativeTextEditEligible,
	hiddenCharSet,
	visiblePdfChars,
	visiblePdfText,
	pdfCharLines,
	pdfLinesText,
	pdfCaretTextOffset,
	pdfTextOffsetFromPoint,
	wordBoundsAtTextOffset,
	stripWhitespace,
	isHorizontalWhitespace
} from './block-state.js';
import {
	stripTransientBlockFields,
	nativeTouchedRecord,
	mergeNativeTouchedEntry
} from './native-history.js';

// isLogoBlock dépend du catalogue de polices : injecté dans la machine à états
// (déclaration hoistée, disponible dès l'évaluation du module).
configureBlockState({ isLogoBlock });

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).toString();

const STANDARD_FONT_DATA_URL = new URL('./vendor/standard_fonts/', import.meta.url).toString();
// pdf.js 5.x décode CCITT/JBIG2/JPX via WASM (jbig2.wasm, openjpeg.wasm).
// Sans wasmUrl, les ImageMask des scans MRC sont ignorés → texte « effacé »
// sous les surlignages (fond JPEG seul).
const PDFJS_WASM_URL = new URL('./vendor/wasm/', import.meta.url).toString();

function pdfDocumentOptions(extra) {
	const options = {
		standardFontDataUrl: STANDARD_FONT_DATA_URL,
		wasmUrl: PDFJS_WASM_URL,
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
const EDIT_BLOCK_PAD_Y = 3;

function pageViewport(page, zoom = state.zoom) {
	return page.getViewport({ scale: zoom * CSS_UNITS });
}

const defaultSettings = {
	settingsVersion: 5,
	language: 'auto',
	defaultZoom: 1,
	fitWidth: true,
	pageLayout: 'continuous',
	showTools: true,
	showRail: true,
	showPageNotes: true,
	showAlignmentGuides: true,
	autoSave: true,
	highlightColor: '#f5c542',
	identityName: '',
	identityEmail: ''
};

const state = {
	tabs: [],
	activeTabId: null,
	pendingCloseTabId: null,
	// Fermeture de la FENÊTRE demandée (croix rouge / Cmd+Q) : après résolution
	// des onglets non enregistrés, l'application quitte au lieu de rester ouverte.
	pendingQuit: false,
	// Croix de CETTE fenêtre : après les onglets dirty, on détruit la fenêtre
	// sans quitter l'app (d'autres fenêtres Slate peuvent rester ouvertes).
	pendingCloseWindow: false,
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
	editTool: 'select',
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
	documentName: document.getElementById('document-name'),
	documentMeta: document.getElementById('document-meta'),
	pageLabel: document.getElementById('page-label'),
	zoomLabel: document.getElementById('zoom-label'),
	prevPage: document.getElementById('prev-page'),
	nextPage: document.getElementById('next-page'),
	zoomOut: document.getElementById('zoom-out'),
	zoomIn: document.getElementById('zoom-in'),
	railZoomOut: document.getElementById('rail-zoom-out'),
	railZoomIn: document.getElementById('rail-zoom-in'),
	fitWidth: document.getElementById('fit-width'),
	railFitWidth: document.getElementById('rail-fit-width'),
	railLayoutSingle: document.getElementById('rail-layout-single'),
	undoButton: document.getElementById('undo-button'),
	redoButton: document.getElementById('redo-button'),
	downloadOriginal: document.getElementById('download-original'),
	exportAnnotations: document.getElementById('export-annotations'),
	exportEditedPdf: document.getElementById('export-edited-pdf'),
	saveButton: document.getElementById('save-button'),
	autosaveToggle: document.getElementById('autosave-toggle'),
	toolbarAutoSave: document.getElementById('toolbar-auto-save'),
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
	editSelectTool: document.getElementById('edit-select-tool'),
	addTextTool: document.getElementById('add-text-tool'),
	addImageTool: document.getElementById('add-image-tool'),
	addSignatureTool: document.getElementById('add-signature-tool'),
	addHeaderFooterTool: document.getElementById('add-header-footer-tool'),
	modifierMoreTools: document.getElementById('modifier-more-tools'),
	modifierMoreContent: document.getElementById('modifier-more-content'),
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
	formatListButtons: Array.from(document.querySelectorAll('.format-list [data-list]')),
	signatureTransformPanel: document.getElementById('signature-transform-panel'),
	signatureRotationRange: document.getElementById('signature-rotation-range'),
	signatureRotationInput: document.getElementById('signature-rotation-input'),
	settingsButton: document.getElementById('settings-button'),
	shareButton: document.getElementById('share-button'),
	sharePopover: document.getElementById('share-popover'),
	sharePopoverTitle: document.getElementById('share-popover-title'),
	shareInviteInput: document.getElementById('share-invite-input'),
	shareInfoBanner: document.getElementById('share-info-banner'),
	shareRevealButton: document.getElementById('share-reveal-button'),
	shareLinkSettingsHelp: document.getElementById('share-link-settings-help'),
	settingsBackdrop: document.getElementById('settings-backdrop'),
	settingsModal: document.getElementById('settings-modal'),
	settingsClose: document.getElementById('settings-close'),
	settingsDone: document.getElementById('settings-done'),
	settingLanguage: document.getElementById('setting-language'),
	settingDefaultZoom: document.getElementById('setting-default-zoom'),
	settingPageLayout: document.getElementById('setting-page-layout'),
	settingAutoSave: document.getElementById('setting-auto-save'),
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
	propertiesOkButton: document.getElementById('properties-ok-button'),
	propertiesCancelButton: document.getElementById('properties-cancel-button'),
	propertiesHelpButton: document.getElementById('properties-help-button'),
	prepressPanel: document.getElementById('prepress-panel'),
	prepressBack: document.getElementById('prepress-back'),
	toolsPanel: document.getElementById('tools-panel'),
	convertColorsModal: document.getElementById('convert-colors-modal'),
	convertColorsBackdrop: document.getElementById('convert-colors-backdrop'),
	convertColorsOk: document.getElementById('convert-colors-ok'),
	convertColorsCancel: document.getElementById('convert-colors-cancel'),
	convertColorsProfileStatus: document.getElementById('convert-colors-profile-status'),
	printModal: document.getElementById('print-modal'),
	printBackdrop: document.getElementById('print-backdrop'),
	printPrinter: document.getElementById('print-printer'),
	printPaper: document.getElementById('print-paper'),
	printInputSlot: document.getElementById('print-input-slot'),
	printInputSlotRow: document.getElementById('print-input-slot-row'),
	printCustomScale: document.getElementById('print-custom-scale'),
	printCopies: document.getElementById('print-copies'),
	printPageRange: document.getElementById('print-page-range'),
	printGrayscale: document.getElementById('print-grayscale'),
	printDuplex: document.getElementById('print-duplex'),
	printReverse: document.getElementById('print-reverse'),
	printAutoPaper: document.getElementById('print-auto-paper'),
	printFitLabel: document.getElementById('print-fit-label'),
	printFitCompact: document.getElementById('print-fit-compact'),
	printFitCompactRow: document.getElementById('print-fit-compact-row'),
	printFitSummary: document.getElementById('print-fit-summary'),
	printScaleLabel: document.getElementById('print-scale-label'),
	printDimsLabel: document.getElementById('print-dims-label'),
	printPreviewCanvas: document.getElementById('print-preview-canvas'),
	printPreviewPage: document.getElementById('print-preview-page'),
	printPreviewPrev: document.getElementById('print-preview-prev'),
	printPreviewNext: document.getElementById('print-preview-next'),
	printLayoutFocus: document.getElementById('print-layout-focus'),
	printTitlebar: document.getElementById('print-titlebar'),
	printAdvancedOpen: document.getElementById('print-advanced-open'),
	printAdvancedModal: document.getElementById('print-advanced-modal'),
	printAdvancedTitlebar: document.getElementById('print-advanced-titlebar'),
	printAdvancedPrinter: document.getElementById('print-advanced-printer'),
	printAdvancedBody: document.getElementById('print-advanced-body'),
	printAdvancedReset: document.getElementById('print-advanced-reset'),
	printAdvancedClose: document.getElementById('print-advanced-close'),
	printError: document.getElementById('print-error'),
	printCancel: document.getElementById('print-cancel'),
	printSubmit: document.getElementById('print-submit'),
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
		share: 'Share',
		shareTitle: (name) => `Share “${name}”`,
		shareInvitePlaceholder: 'Add a name or email address to invite',
		shareInfoLocal: 'The file stays on your computer — Slate does not upload anything to the cloud.',
		shareLinkHelp: 'Show in Finder to attach or send the PDF.',
		sharePathCopied: 'File path copied to clipboard.',
		shareOpenedWhatsApp: 'WhatsApp opened — file path copied.',
		shareOpenedGmail: 'Gmail compose opened.',
		shareOpenedOutlook: 'Outlook compose opened.',
		shareOpenedTeams: 'Message copied — paste it in Teams.',
		shareOpenedEmail: 'Email client opened.',
		shareRevealed: 'File revealed in Finder.',
		shareFailed: 'Unable to share this document.',
		shareNoDocument: 'Open a PDF before sharing.',
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
		usePrepress: 'Use print production',
		convertColors: 'Convert colors',
		convertColorsDone: 'Colors converted to Coated FOGRA39.',
		convertColorsNeedPdf: 'Open a PDF before converting colors.',
		convertColorsRunning: 'Converting colors to FOGRA39…',
		printTitle: 'Print',
		printPreparing: 'Preparing print…',
		printSending: 'Sending to printer…',
		printDone: 'Print job sent.',
		printNoPrinters: 'No printers found.',
		printNeedPdf: 'Open a PDF before printing.',
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
		docRepaired: 'Damaged document repaired on open.',
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
		autoSaveSetting: 'Default for new documents',
		autoSaveDesc: 'Used when a file has no saved preference yet.',
		autoSaveToolbar: 'Auto-save',
		autoSaved: 'Saved automatically.',
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
		rotatePageLeft: 'Rotate 90° left',
		rotatePageRight: 'Rotate 90° right',
		deleteThisPage: 'Delete this page',
		deleteLastPage: 'The last page cannot be deleted.',
		dragToReorder: 'Drag to reorder',
		deleteProcessing: 'Deleting page...',
		deleteDone: 'Page deleted.',
		cancel: 'Cancel',
		needPdfOpen: 'Open a PDF first.',
		outlineTitle: 'Bookmarks',
		sign: 'Sign',
		signTitle: 'Fill & Sign',
		aiKicker: 'AI',
		aiTitle: 'AI assistant',
		historyTitle: 'Modification history',
		historyKicker: 'History',
		historyTool: 'History',
		historyEmpty: 'No modifications yet.',
		historyCurrent: 'Current version',
		historyOriginal: 'Original state',
		historyUndone: 'Undone',
		histEdit: 'Modification',
		histTextEdit: 'Text edited',
		histBlockMove: 'Block moved',
		histBlockResize: 'Block resized',
		histBlockDelete: 'Block deleted',
		histBlockAdd: 'Text added',
		histImageAdd: 'Image added',
		histFormat: 'Formatting changed',
		histDuplicate: 'Block duplicated',
		histSignature: 'Signature',
		histPage: 'Page modified',
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
		headerFooter: 'Header and footer',
		headerFooterHelp: 'Adds editable text at the top and bottom of every page.',
		headerText: 'Header',
		footerText: 'Footer',
		headerFooterEmpty: 'Enter a header or footer.',
		headerFooterDone: 'Header and footer applied.',
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
		share: 'Partager',
		shareTitle: (name) => `Partager « ${name} »`,
		shareInvitePlaceholder: "Ajouter le nom ou l'adresse e-mail pour l'invitation",
		shareInfoLocal:
			'Le fichier reste sur votre ordinateur — Slate ne charge rien dans le cloud.',
		shareLinkHelp: 'Afficher dans le Finder pour joindre ou envoyer le PDF.',
		sharePathCopied: 'Chemin du fichier copié dans le presse-papiers.',
		shareOpenedWhatsApp: 'WhatsApp ouvert — chemin du fichier copié.',
		shareOpenedGmail: 'Composition Gmail ouverte.',
		shareOpenedOutlook: 'Composition Outlook ouverte.',
		shareOpenedTeams: 'Message copié — colle-le dans Teams.',
		shareOpenedEmail: 'Client mail ouvert.',
		shareRevealed: 'Fichier affiché dans le Finder.',
		shareFailed: 'Impossible de partager ce document.',
		shareNoDocument: 'Ouvre un PDF avant de partager.',
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
		convertColors: 'Convertir les couleurs',
		convertColorsDone: 'Couleurs converties en Coated FOGRA39.',
		convertColorsNeedPdf: 'Ouvre un PDF avant de convertir les couleurs.',
		convertColorsRunning: 'Conversion des couleurs vers FOGRA39…',
		printTitle: 'Imprimer',
		printPreparing: 'Préparation de l’impression…',
		printSending: 'Envoi à l’imprimante…',
		printDone: 'Travail d’impression envoyé.',
		printNoPrinters: 'Aucune imprimante trouvée.',
		printNeedPdf: 'Ouvre un PDF avant d’imprimer.',
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
		docRepaired: 'Document endommagé réparé à l\'ouverture.',
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
		autoSaveSetting: 'Par défaut pour les nouveaux documents',
		autoSaveDesc: 'Appliqué à l’ouverture d’un fichier qui n’a pas encore de préférence.',
		autoSaveToolbar: 'Enreg. auto',
		autoSaved: 'Enregistré automatiquement.',
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
		rotatePageLeft: 'Tourner à 90° vers la gauche',
		rotatePageRight: 'Tourner à 90° vers la droite',
		deleteThisPage: 'Supprimer cette page',
		deleteLastPage: 'Impossible de supprimer la dernière page.',
		dragToReorder: 'Glisser pour réordonner',
		deleteProcessing: 'Suppression de la page...',
		deleteDone: 'Page supprimée.',
		cancel: 'Annuler',
		needPdfOpen: 'Ouvre d’abord un PDF.',
		outlineTitle: 'Marque-pages',
		sign: 'Signer',
		signTitle: 'Remplir et signer',
		aiKicker: 'IA',
		aiTitle: 'Assistant IA',
		historyTitle: 'Historique des modifications',
		historyKicker: 'Historique',
		historyTool: 'Historique',
		historyEmpty: 'Aucune modification pour l’instant.',
		historyCurrent: 'Version actuelle',
		historyOriginal: 'État d’origine',
		historyUndone: 'Annulée',
		histEdit: 'Modification',
		histTextEdit: 'Texte modifié',
		histBlockMove: 'Bloc déplacé',
		histBlockResize: 'Bloc redimensionné',
		histBlockDelete: 'Bloc supprimé',
		histBlockAdd: 'Texte ajouté',
		histImageAdd: 'Image ajoutée',
		histFormat: 'Mise en forme modifiée',
		histDuplicate: 'Bloc dupliqué',
		histSignature: 'Signature',
		histPage: 'Page modifiée',
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
		headerFooter: 'En-tête et pied de page',
		headerFooterHelp: 'Ajoute un texte éditable en haut et en bas de chaque page.',
		headerText: 'En-tête',
		footerText: 'Pied de page',
		headerFooterEmpty: 'Saisis un en-tête ou un pied de page.',
		headerFooterDone: 'En-tête et pied de page appliqués.',
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
// (search, notes, pages, marque-pages, ajuster, zoom+, zoom-, page unique, historique, réglages)
const railIconNames = [
	'search',
	'comment',
	'pages',
	'bookmark',
	'fit',
	'plus',
	'minus',
	'singlePage',
	'clock',
	'settings'
];

const icons = {
	// Glyphes Lucide (ISC) — https://lucide.dev
	open: '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />',
	save: '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" /><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" /><path d="M7 3v4a1 1 0 0 0 1 1h7" />',
	search: '<path d="m21 21-4.34-4.34" /><circle cx="11" cy="11" r="8" />',
	comment: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />',
	edit: '<path d="m18 5-2.414-2.414A2 2 0 0 0 14.172 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2" /><path d="M21.378 12.626a1 1 0 0 0-3.004-3.004l-4.01 4.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z" /><path d="M8 18h1" />',
	export: '<path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="M4 7V4a2 2 0 0 1 2-2 2 2 0 0 0-2 2" /><path d="M4.063 20.999a2 2 0 0 0 2 1L18 22a2 2 0 0 0 2-2V7l-5-5H6" /><path d="m5 11-3 3" /><path d="m5 17-3-3h10" />',
	merge: '<path d="M10 18H5a3 3 0 0 1-3-3v-1" /><path d="M14 2a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2" /><path d="M20 2a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2" /><path d="m7 21 3-3-3-3" /><rect x="14" y="14" width="8" height="8" rx="2" /><rect x="2" y="2" width="8" height="8" rx="2" />',
	pages: '<rect width="7" height="7" x="3" y="3" rx="1" /><rect width="7" height="7" x="14" y="3" rx="1" /><rect width="7" height="7" x="14" y="14" rx="1" /><rect width="7" height="7" x="3" y="14" rx="1" />',
	sign: '<path d="M12 20h9" /><path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z" />',
	ocr: '<path d="M3 7V5a2 2 0 0 1 2-2h2" /><path d="M17 3h2a2 2 0 0 1 2 2v2" /><path d="M21 17v2a2 2 0 0 1-2 2h-2" /><path d="M7 21H5a2 2 0 0 1-2-2v-2" /><path d="M7 8h8" /><path d="M7 12h10" /><path d="M7 16h6" />',
	lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />',
	redact: '<path d="M21 21H8a2 2 0 0 1-1.42-.587l-3.994-3.999a2 2 0 0 1 0-2.828l10-10a2 2 0 0 1 2.829 0l5.999 6a2 2 0 0 1 0 2.828L12.834 21" /><path d="m5.082 11.09 8.828 8.828" />',
	compress: '<rect width="20" height="5" x="2" y="3" rx="1" /><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" /><path d="M10 12h4" />',
	form: '<rect width="8" height="4" x="8" y="2" rx="1" ry="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><path d="M12 11h4" /><path d="M12 16h4" /><path d="M8 11h.01" /><path d="M8 16h.01" />',
	convert: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="M9 15h6" /><path d="M12 18v-6" />',
	stamp: '<path d="M14 13V8.5C14 7 15 7 15 5a3 3 0 0 0-6 0c0 2 1 2 1 3.5V13" /><path d="M20 15.5a2.5 2.5 0 0 0-2.5-2.5h-11A2.5 2.5 0 0 0 4 15.5V17a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1z" /><path d="M5 22h14" />',
	certificate: '<path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z" /><path d="m9 12 2 2 4-4" />',
	prepress: '<path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6" /><rect x="6" y="14" width="12" height="8" rx="1" />',
	measure: '<path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z" /><path d="m14.5 12.5 2-2" /><path d="m11.5 9.5 2-2" /><path d="m8.5 6.5 2-2" /><path d="m17.5 15.5 2-2" />',
	compare: '<rect width="18" height="18" x="3" y="3" rx="2" /><path d="M12 3v18" />',
	media: '<rect width="18" height="18" x="3" y="3" rx="2" ry="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />',
	clock: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l4 2" />',
	crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14" /><path d="M18 22V8a2 2 0 0 0-2-2H2" />',
	flatten: '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z" /><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12" /><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17" />',
	shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /><path d="m9 12 2 2 4-4" />',
	bookmark: '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z" />',
	watermark: '<path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z" />',
	number: '<line x1="4" x2="20" y1="9" y2="9" /><line x1="4" x2="20" y1="15" y2="15" /><line x1="10" x2="8" y1="3" y2="21" /><line x1="16" x2="14" y1="3" y2="21" />',
	image: '<rect width="18" height="18" x="3" y="3" rx="2" ry="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />',
	style: '<path d="M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z" /><circle cx="13.5" cy="6.5" r=".5" fill="currentColor" /><circle cx="17.5" cy="10.5" r=".5" fill="currentColor" /><circle cx="6.5" cy="12.5" r=".5" fill="currentColor" /><circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />',
	custom: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" /><path d="M20 3v4" /><path d="M22 5h-4" /><path d="M4 17v2" /><path d="M5 18H3" />',
	translate: '<path d="m5 8 6 6" /><path d="m4 14 6-6 2-3" /><path d="M2 5h12" /><path d="M7 2h1" /><path d="m22 22-5-10-5 10" /><path d="M14 18h6" />',
	fit: '<path d="M15 3h6v6" /><path d="m21 3-7 7" /><path d="m3 21 7-7" /><path d="M9 21H3v-6" />',
	rotate: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" />',
	rotateCcw: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" />',
	trash: '<path d="M10 11v6" /><path d="M14 11v6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />',
	grip: '<circle cx="9" cy="5" r="1" /><circle cx="9" cy="12" r="1" /><circle cx="9" cy="19" r="1" /><circle cx="15" cy="5" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="15" cy="19" r="1" />',
	settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" />',
	textAdd: '<path d="M12 4v16" /><path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2" /><path d="M9 20h6" />',
	index: '<path d="M21 7h-3a2 2 0 0 1-2-2V2" /><path d="M21 6v6.5c0 .8-.7 1.5-1.5 1.5h-7c-.8 0-1.5-.7-1.5-1.5v-9c0-.8.7-1.5 1.5-1.5H17Z" /><path d="M7 8v8.8c0 .3.2.6.4.8.2.2.5.4.8.4H15" /><path d="M3 12v8.8c0 .3.2.6.4.8.2.2.5.4.8.4H11" />',
	standards: '<path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z" /><path d="m9 12 2 2 4-4" />',
	unlock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 9.9-1" />',
	review: '<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z" /><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1" />',
	actions: '<path d="m3 17 2 2 4-4" /><path d="m3 7 2 2 4-4" /><path d="M13 6h8" /><path d="M13 12h8" /><path d="M13 18h8" />',
	accessibility: '<circle cx="16" cy="4" r="1" /><path d="m18 19 1-7-6 1" /><path d="m5 8 3-3 5.5 3-2.36 3.5" /><path d="M4.24 14.5a5 5 0 0 0 6.88 6" /><path d="M13.76 17.5a5 5 0 0 0-6.88-6" />',
	code: '<path d="m18 16 4-4-4-4" /><path d="m6 8-4 4 4 4" /><path d="m14.5 4-5 16" />',
	singlePage: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" />',
	plus: '<path d="M5 12h14" /><path d="M12 5v14" />',
	minus: '<path d="M5 12h14" />',
};

/** Pastille iOS Settings par outil (panneau gauche uniquement). */
const iconTints = {
	open: 'blue',
	save: 'indigo',
	search: 'slate',
	comment: 'amber',
	textAdd: 'pink',
	edit: 'rose',
	export: 'teal',
	merge: 'violet',
	pages: 'green',
	sign: 'purple',
	ocr: 'mint',
	lock: 'blue',
	redact: 'red',
	compress: 'orange',
	form: 'indigo',
	convert: 'cyan',
	stamp: 'orange',
	certificate: 'violet',
	prepress: 'slate',
	measure: 'cyan',
	compare: 'blue',
	media: 'pink',
	review: 'amber',
	actions: 'green',
	accessibility: 'blue',
	standards: 'teal',
	index: 'slate',
	clock: 'indigo',
	code: 'slate',
	custom: 'violet',
	style: 'pink',
	translate: 'teal',
	fit: 'slate',
	plus: 'green',
	minus: 'slate',
	rotate: 'blue',
	settings: 'slate',
	singlePage: 'green',
	watermark: 'cyan',
	number: 'indigo',
	image: 'pink',
	crop: 'orange',
	flatten: 'slate',
	unlock: 'blue',
	shield: 'green',
	bookmark: 'amber',
};

function currentLocale() {
	if (state.settings.language && state.settings.language !== 'auto') return state.settings.language;
	return navigator.language?.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

// Aligne la langue des panneaux et menus NATIFS macOS (impression, enregistrer…)
// sur le réglage de Slate. Persiste côté Rust pour le prochain boot (AppKit lit
// AppleLanguages au démarrage). En mode "auto", on résout vers la locale détectée.
let _lastNativeLang = null;
function syncNativeLanguage() {
	const setting = state.settings.language || 'auto';
	const lang = setting === 'auto' ? currentLocale() : setting;
	if (lang === _lastNativeLang) return;
	_lastNativeLang = lang;
	void invokeCommand('set_native_language', { lang }).catch(() => {});
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
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${icons[name] || icons.custom}</svg>`;
}

function applyIcon(element, name) {
	if (!element) return;
	element.innerHTML = svgIcon(name);
	// Pastilles colorées seulement sur les lignes d’outils (pas le rail / modifiers).
	if (element.classList.contains('tool-icon') && element.closest('.tool-row')) {
		element.dataset.tint = iconTints[name] || 'slate';
	} else {
		delete element.dataset.tint;
	}
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
	setText('#autosave-toggle-label', 'autoSaveToolbar');
	setText(elements.shareButton, 'share');
	setText(elements.settingsButton, 'settings');
	if (elements.shareInviteInput) setPlaceholder(elements.shareInviteInput, 'shareInvitePlaceholder');
	if (elements.shareInfoBanner) setText(elements.shareInfoBanner, 'shareInfoLocal');
	if (elements.shareLinkSettingsHelp) setText(elements.shareLinkSettingsHelp, 'shareLinkHelp');
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
	setText(elements.prevPage, 'previous');
	setText(elements.nextPage, 'next');
	setText(elements.fitWidth, 'fitWidth');
	setText('.empty-card h1', 'emptyTitle');
	setText('.empty-card p', 'emptyDesc');
	setText(elements.drawerKicker, state.activeDrawer);
	const drawerTitleKeys = { search: 'findText', notes: 'annotations', pages: 'document', edit: 'modify', history: 'historyTitle' };
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
		['autoSaveSetting', 'autoSaveDesc'],
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
	if (invoke) {
		return invoke(command, args);
	}
	const bridge = window.slatePdfBridge;
	if (bridge?.invoke) {
		return bridge.invoke(command, args);
	}
	throw new Error('Native Tauri commands are unavailable in this window.');
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
		filePath: currentTab()?.filePath || null,
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

const AUTOSAVE_PATHS_KEY = 'slate-autosave-by-path';

function defaultAutoSavePreferred() {
	return state.settings.autoSave !== false;
}

function loadAutosavePrefs() {
	try {
		const parsed = JSON.parse(localStorage.getItem(AUTOSAVE_PATHS_KEY) || '{}');
		return parsed && typeof parsed === 'object' ? parsed : {};
	} catch {
		return {};
	}
}

function resolveDocumentAutoSave(filePath, explicit) {
	if (typeof explicit === 'boolean') return explicit;
	if (filePath) {
		const prefs = loadAutosavePrefs();
		if (Object.prototype.hasOwnProperty.call(prefs, filePath)) return Boolean(prefs[filePath]);
	}
	return defaultAutoSavePreferred();
}

function rememberTabAutoSave(tab) {
	if (!tab?.filePath) return;
	try {
		const prefs = loadAutosavePrefs();
		prefs[tab.filePath] = Boolean(tab.autoSave);
		localStorage.setItem(AUTOSAVE_PATHS_KEY, JSON.stringify(prefs));
	} catch {
		/* stockage indisponible */
	}
}

function tabAutosaveEnabled(tab) {
	return Boolean(tab && tab.autoSave);
}

function syncToolbarAutoSave() {
	const input = elements.toolbarAutoSave;
	const wrap = elements.autosaveToggle;
	if (!input || !wrap) return;
	const tab = currentTab();
	const hasDoc = Boolean(tab && state.pdf && !state.viewingHome);
	wrap.hidden = !hasDoc;
	input.disabled = !hasDoc;
	input.checked = hasDoc ? tab.autoSave !== false : defaultAutoSavePreferred();
}

function applyToolbarAutoSave() {
	const tab = currentTab();
	if (!tab || !elements.toolbarAutoSave) return;
	tab.autoSave = elements.toolbarAutoSave.checked;
	rememberTabAutoSave(tab);
	persistOpenSession();
	if (tab.autoSave && tab.dirty) scheduleAutosave();
}

function createDocumentTab({ fileName, fileBytes, pdf, fingerprint, annotations }) {
	return {
		id: createId(),
		fileName,
		filePath: null,
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
		dirty: false,
		recoveryPath: null,
		autoSave: defaultAutoSavePreferred(),
		formImages: {}
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
	state.editTool = 'select';
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
	setEditTool('select');
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
	state.editTool = 'select';
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
	scheduleAutosave();
}

const SESSION_KEY = 'slate-open-session';
const AUTOSAVE_DELAY_MS = 2000;
let _autosaveTimer = null;
let _autosaveInFlight = false;
let _restoringSession = false;
let _sessionRestoreReady = Promise.resolve();

function persistOpenSession() {
	try {
		const tabs = state.tabs
			.map((tab) => ({
				id: tab.id,
				fileName: tab.fileName,
				filePath: tab.filePath || null,
				recoveryPath: tab.recoveryPath || null,
				page: tab.page || 1,
				fingerprint: tab.fingerprint || null,
				autoSave: tab.autoSave !== false
			}))
			.filter((tab) => tab.filePath || tab.recoveryPath);
		localStorage.setItem(
			SESSION_KEY,
			JSON.stringify({
				tabs,
				activeTabId: state.activeTabId,
				at: Date.now()
			})
		);
	} catch (_err) {
		/* stockage indisponible */
	}
}

function loadOpenSession() {
	try {
		const parsed = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
		if (!parsed || !Array.isArray(parsed.tabs)) return null;
		return parsed;
	} catch {
		return null;
	}
}

function scheduleAutosave() {
	persistOpenSession();
	if (_restoringSession || !window.__TAURI__) return;
	if (!tabAutosaveEnabled(currentTab())) return;
	if (_autosaveTimer) clearTimeout(_autosaveTimer);
	_autosaveTimer = setTimeout(() => void flushAutosave({ reason: 'idle' }), AUTOSAVE_DELAY_MS);
}

async function writeTabBytes(tab, bytes, overwriteFile) {
	if (overwriteFile && tab.filePath) {
		await invokeCommand('save_file', {
			path: tab.filePath,
			data: Array.from(bytes)
		});
		tab.dirty = false;
		if (tab.id === state.activeTabId) {
			const live = currentTab();
			if (live) live.dirty = false;
		}
		return tab.filePath;
	}
	const recoveryPath = await invokeCommand('write_autosave', {
		id: tab.id,
		filename: tab.fileName || 'document.pdf',
		data: Array.from(bytes)
	});
	tab.recoveryPath = recoveryPath;
	return recoveryPath;
}

async function flushAutosave({ reason = 'idle', allTabs = false } = {}) {
	if (!window.__TAURI__ || _restoringSession) return;
	if (_autosaveInFlight) {
		if (reason === 'idle') scheduleAutosave();
		return;
	}
	const force = reason === 'exit' || reason === 'update';
	_autosaveInFlight = true;
	if (_autosaveTimer) {
		clearTimeout(_autosaveTimer);
		_autosaveTimer = null;
	}
	try {
		if (state.pdf) {
			if (state.nativeTextDirty) await syncNativeDocumentBytes({ render: false });
			const bytes = new Uint8Array(await currentDocumentBytes());
			state.fileBytes = bytes;
			const active = currentTab();
			if (active) active.fileBytes = bytes;
			persistCurrentTabState();
		}
		const tabs = (allTabs || force ? state.tabs : [currentTab()]).filter(Boolean);
		let wroteFile = false;
		for (const tab of tabs) {
			const bytes = tab.id === state.activeTabId ? state.fileBytes : tab.fileBytes;
			if (!bytes?.length) continue;
			if (reason === 'idle' && !tab.dirty) continue;
			const enabled = tabAutosaveEnabled(tab);
			if (reason === 'idle' && !enabled) continue;
			const overwriteFile = Boolean(enabled && tab.filePath);
			if (reason === 'idle') {
				await writeTabBytes(tab, bytes, overwriteFile);
				wroteFile = wroteFile || overwriteFile;
				continue;
			}
			if (overwriteFile) {
				await writeTabBytes(tab, bytes, true);
				wroteFile = true;
			} else if (tab.dirty || !tab.filePath) {
				await writeTabBytes(tab, bytes, false);
			}
		}
		persistOpenSession();
		if (wroteFile) renderTabs();
	} catch (error) {
		console.warn('Autosave failed', error);
	} finally {
		_autosaveInFlight = false;
	}
}

async function restoreOpenSession() {
	if (!window.__TAURI__ || state.tabs.length) return;
	const session = loadOpenSession();
	if (!session?.tabs?.length) return;
	_restoringSession = true;
	try {
		const preferred = session.tabs.find((item) => item.id === session.activeTabId) || session.tabs[session.tabs.length - 1];
		for (const item of session.tabs) {
			const path = item.filePath || item.recoveryPath;
			if (!path) continue;
			try {
				const bytes = await invokeBytes('read_pdf_path', { path });
				if (!bytes?.length) continue;
				await openPdfFromBytes(new Uint8Array(bytes), item.fileName || 'document.pdf', {
					filePath: item.filePath || null,
					autoSave: typeof item.autoSave === 'boolean' ? item.autoSave : undefined
				});
				const tab = currentTab();
				if (tab && item.recoveryPath && !item.filePath) {
					tab.recoveryPath = item.recoveryPath;
					tab.dirty = true;
					renderTabs();
				}
			} catch (error) {
				console.warn('Session restore skipped', path, error);
			}
		}
		if (preferred) {
			const match = state.tabs.find(
				(tab) =>
					(preferred.filePath && tab.filePath === preferred.filePath) ||
					(preferred.recoveryPath && tab.recoveryPath === preferred.recoveryPath)
			);
			if (match) await activateTab(match.id);
		}
	} finally {
		_restoringSession = false;
		persistOpenSession();
	}
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

// Réparation à l'ouverture (MuPDF côté Rust) : un PDF à structure cassée
// (xref corrompue, objets tronqués) s'affiche parfois dans PDF.js mais fait
// échouer toute l'édition native (lopdf/PDFium). Le moteur ne réécrit le
// document QUE s'il est réellement cassé — les octets d'origine restent la
// référence pour un document sain.
async function maybeRepairPdfBytes(bytes) {
	if (!window.__TAURI__) return bytes;
	try {
		const repaired = await invokeBytes('repair_pdf_bytes', { bytes: Array.from(bytes) });
		if (repaired && repaired.length) {
			setStatus(t('docRepaired'));
			return repaired;
		}
	} catch (_err) {
		// Document sain ou irrécupérable : on continue avec les octets d'origine
		// (PDF.js affichera sa propre erreur si le document est illisible).
	}
	return bytes;
}

async function openPdfFromBytes(bytes, fileName, options = {}) {
	try {
		const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
		const data = await maybeRepairPdfBytes(raw);
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
				// Rouvrir depuis le Finder / Récents : rattacher le chemin disque
				// (sinon ⌘S redemande Enregistrer sous).
				if (options.filePath) {
					const wasMissing = !existing.filePath;
					existing.filePath = options.filePath;
					if (wasMissing) existing.autoSave = resolveDocumentAutoSave(options.filePath, options.autoSave);
				}
				await activateTab(existing.id);
				setStatus(
					currentLocale() === 'fr' ? 'Ce document est déjà ouvert.' : 'This document is already open.'
				);
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
		if (options.filePath) {
			tab.filePath = options.filePath;
		}
		tab.autoSave = resolveDocumentAutoSave(tab.filePath, options.autoSave);
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
			state.fitMode = 'page';
			await fitSinglePageToViewport(false);
		} else if (state.settings.fitWidth) {
			state.fitMode = 'width';
			await fitPageWidth(false);
		}
		updateUi();
		await mountPagesStack();
		if (state.page > 1) {
			goToPage(state.page);
		}
		setTimeout(maybePromptDefaultApp, 600);
		persistOpenSession();
	} catch (error) {
		console.error(error);
		setStatus(error instanceof Error ? error.message : 'Failed to open PDF.', 'error');
	}
}

const TAB_SAVED_MARK = `<span class="document-tab-saved" aria-label="Saved"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.2 6.2 4.8 8.8 9.8 3.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
let _justSavedTabId = null;
let _justSavedTimer = null;

function flashSavedTab(tabId) {
	if (!tabId) return;
	_justSavedTabId = tabId;
	if (_justSavedTimer) clearTimeout(_justSavedTimer);
	_justSavedTimer = setTimeout(() => {
		if (_justSavedTabId === tabId) _justSavedTabId = null;
		const el = elements.tabList?.querySelector(`.document-tab[data-tab-id="${CSS.escape(String(tabId))}"]`);
		el?.classList.remove('just-saved');
		el?.querySelector('.document-tab-saved')?.remove();
		elements.saveButton?.classList.remove('just-saved');
	}, 1800);
	const el = elements.tabList?.querySelector(`.document-tab[data-tab-id="${CSS.escape(String(tabId))}"]`);
	if (el) {
		el.classList.remove('just-saved');
		void el.offsetWidth;
		el.classList.add('just-saved');
		const mark = el.querySelector('.document-tab-saved');
		if (mark) {
			mark.setAttribute('aria-label', currentLocale() === 'fr' ? 'Enregistré' : 'Saved');
		} else {
			el.querySelector('.document-tab-title')?.insertAdjacentHTML('afterend', TAB_SAVED_MARK);
			const added = el.querySelector('.document-tab-saved');
			added?.setAttribute('aria-label', currentLocale() === 'fr' ? 'Enregistré' : 'Saved');
		}
	}
	if (elements.saveButton) {
		elements.saveButton.classList.remove('just-saved');
		void elements.saveButton.offsetWidth;
		elements.saveButton.classList.add('just-saved');
	}
}

function renderTabs() {
	elements.tabList.innerHTML = '';
	for (const tab of state.tabs) {
		const tabButton = document.createElement('button');
		tabButton.type = 'button';
		const isActiveTab = tab.id === state.activeTabId && !state.viewingHome;
		const justSaved = _justSavedTabId === tab.id;
		tabButton.className = `document-tab ${isActiveTab ? 'active' : ''}${justSaved ? ' just-saved' : ''}`;
		tabButton.dataset.tabId = tab.id;
		tabButton.innerHTML = `
			<span class="document-tab-title">${escapeHtml(tab.fileName || t('untitledPdf'))}</span>
			${tab.dirty ? '<span class="document-tab-dirty" aria-label="Unsaved changes"></span>' : justSaved ? TAB_SAVED_MARK : ''}
			<span class="document-tab-close" aria-label="Close tab">×</span>
		`;
		tabButton.addEventListener('click', () => {
			void activateTab(tab.id);
		});
		tabButton.querySelector('.document-tab-close')?.addEventListener('click', (event) => {
			event.stopPropagation();
			void requestCloseTab(tab.id);
		});
		tabButton.addEventListener('pointerdown', (event) => onTabPointerDown(event, tab, tabButton));
		elements.tabList.append(tabButton);
	}
	updateTabsScrollButtons();
	scrollActiveTabIntoView();
	updateHomeButtonState();
}

// Onglets : réordonnancement à la souris dans la barre (pointer events, l'onglet
// suit le curseur comme dans Chrome). Dès que le curseur sort de la barre, on
// bascule sur un drag NATIF du fichier PDF (Rust/AppKit) : lâché sur une autre
// fenêtre Slate → fusion ; sur le Finder, Mail, un navigateur… → le PDF est
// déposé comme un vrai fichier ; annulé dans le vide → nouvelle fenêtre.
function tabInsertIndexFromClientX(clientX) {
	const tabs = [...elements.tabList.querySelectorAll('.document-tab:not(.dragging)')];
	const index = tabs.findIndex((tab) => {
		const rect = tab.getBoundingClientRect();
		return clientX < rect.left + rect.width / 2;
	});
	return index === -1 ? tabs.length : index;
}

// Un fichier déposé sur la fenêtre : soit c'est l'onglet glissé depuis une autre
// fenêtre Slate (on le récupère avec ses annotations), soit un vrai PDF à ouvrir.
async function handleDroppedFiles(event, insertIndex) {
	const file = event.dataTransfer?.files?.[0];
	let tabDragActive = false;
	try {
		tabDragActive = Boolean(await invokeCommand('is_tab_drag_active'));
	} catch (_err) {
		tabDragActive = false;
	}
	if (tabDragActive) {
		await acceptIncomingTab(insertIndex);
		return;
	}
	if (file) void openFile(file);
}

function initTabDragAndDrop() {
	const onStripDrop = (event) => {
		event.preventDefault();
		event.stopPropagation();
		elements.dropZone.classList.remove('dragging');
		void handleDroppedFiles(event, tabInsertIndexFromClientX(event.clientX));
	};
	const strip = elements.tabList.closest('.tab-strip');
	for (const node of [elements.tabList, elements.tabsViewport, strip]) {
		if (!node) continue;
		node.addEventListener('drop', onStripDrop);
	}
}

const TAB_DRAG_THRESHOLD_PX = 6;
let _tabPointerDrag = null;

function isOutsideTabBar(x, y) {
	const bar = (elements.tabsViewport || elements.tabList)?.getBoundingClientRect();
	if (!bar) return false;
	if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
	const pad = 12;
	return x < bar.left - pad || x > bar.right + pad || y < bar.top - pad || y > bar.bottom + pad;
}

function onTabPointerDown(event, tab, tabButton) {
	if (event.button !== 0 || _tabPointerDrag) return;
	if (event.target instanceof Element && event.target.closest('.document-tab-close')) return;
	_tabPointerDrag = {
		tabId: tab.id,
		button: tabButton,
		startX: event.clientX,
		startY: event.clientY,
		screenX: event.screenX,
		screenY: event.screenY,
		reordering: false,
		native: false,
		released: false,
		prep: null
	};
	window.addEventListener('pointermove', onTabPointerMove);
	window.addEventListener('pointerup', onTabPointerUp);
	window.addEventListener('pointercancel', onTabPointerUp);
}

function onTabPointerMove(event) {
	const drag = _tabPointerDrag;
	if (!drag || drag.native) return;
	drag.screenX = event.screenX;
	drag.screenY = event.screenY;
	if (!drag.reordering) {
		const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
		if (distance < TAB_DRAG_THRESHOLD_PX) return;
		drag.reordering = true;
		drag.button.classList.add('dragging');
		// On prépare le fichier tout de suite : s'il sort de la barre, le drag
		// natif doit démarrer pendant que le bouton de la souris est encore enfoncé.
		drag.prep = prepareTabDragPayload(drag.tabId);
	}
	if (isOutsideTabBar(event.clientX, event.clientY)) {
		drag.native = true;
		void startNativeTabDrag(drag);
		return;
	}
	reorderDraggingTab(event.clientX);
}

function reorderDraggingTab(clientX) {
	const dragging = _tabPointerDrag?.button;
	if (!dragging) return;
	const siblings = [...elements.tabList.querySelectorAll('.document-tab:not(.dragging)')];
	const next = siblings.find((sibling) => {
		const rect = sibling.getBoundingClientRect();
		return clientX < rect.left + rect.width / 2;
	});
	if (next) {
		if (next.previousElementSibling !== dragging) elements.tabList.insertBefore(dragging, next);
	} else if (elements.tabList.lastElementChild !== dragging) {
		elements.tabList.append(dragging);
	}
}

function onTabPointerUp() {
	const drag = _tabPointerDrag;
	if (!drag) return;
	drag.released = true;
	// Drag natif en cours : la fin nous revient par l'événement slate-tab-drag-ended.
	if (drag.native) return;
	teardownTabPointerDrag();
	if (drag.reordering) {
		commitTabOrderFromDom();
		void releasePreparedTabDrag(drag);
	}
}

// Le fichier avait été préparé côté Rust (begin_tab_drag) mais le drag natif n'a
// pas eu lieu : on libère le slot, sinon les vrais dépôts de PDF seraient ignorés.
async function releasePreparedTabDrag(drag) {
	try {
		await drag.prep;
	} catch (_err) {
		// Préparation échouée : rien à libérer.
	}
	try {
		await invokeCommand('cancel_tab_drag');
	} catch (_err) {
		// Fenêtre sans Tauri : rien à libérer.
	}
}

function teardownTabPointerDrag() {
	window.removeEventListener('pointermove', onTabPointerMove);
	window.removeEventListener('pointerup', onTabPointerUp);
	window.removeEventListener('pointercancel', onTabPointerUp);
	_tabPointerDrag?.button.classList.remove('dragging');
	_tabPointerDrag = null;
}

async function buildTabTransferPayload(tab) {
	if (tab.id === state.activeTabId) {
		await bakeFormValues();
		persistCurrentTabState();
	}
	let bytes = tab.fileBytes;
	if ((!bytes || !bytes.length) && tab.filePath) {
		try {
			bytes = await invokeBytes('read_pdf_path', { path: tab.filePath });
		} catch (_err) {
			bytes = null;
		}
	}
	if (!bytes || !bytes.length) return null;
	let editBlocks = [];
	try {
		editBlocks = JSON.parse(JSON.stringify(tab.editBlocks || []));
	} catch (_err) {
		editBlocks = [];
	}
	return {
		fileName: tab.fileName || 'document.pdf',
		filePath: tab.filePath || null,
		bytes: Array.from(bytes),
		annotations: tab.annotations || [],
		editBlocks,
		page: tab.page || 1,
		dirty: Boolean(tab.dirty)
	};
}

// Prépare ce que Rust doit connaître avant le drag natif : l'onglet complet
// (octets d'origine + annotations, pour fusion/tear-off) et, si le document a
// été modifié, l'export à plat qui sera le fichier réellement déposé ailleurs.
async function prepareTabDragPayload(tabId) {
	const tab = state.tabs.find((candidate) => candidate.id === tabId);
	if (!tab) return null;
	const payload = await buildTabTransferPayload(tab);
	if (!payload) return null;
	await invokeCommand('begin_tab_drag', payload);
	let exportBytes = null;
	if (tab.dirty && tab.id === state.activeTabId && state.pdf) {
		try {
			exportBytes = Array.from(await exportEditedPdfBytes({ audit: false }));
		} catch (error) {
			console.warn('Tab drag: export failed, dragging original bytes.', error);
		}
	}
	const icon = await renderTabDragIcon(tab);
	return { exportBytes, icon };
}

// Vignette glissée sous le curseur : la page courante si l'onglet est actif,
// sinon une « feuille » portant le nom du fichier.
async function renderTabDragIcon(tab) {
	const width = 96;
	const canvas = document.createElement('canvas');
	const ctx = canvas.getContext('2d');
	if (!ctx) return [];
	let painted = false;
	if (tab.id === state.activeTabId && state.pdf) {
		try {
			const page = await state.pdf.getPage(Math.min(Math.max(tab.page || 1, 1), state.pdf.numPages));
			const base = page.getViewport({ scale: 1 });
			const viewport = page.getViewport({ scale: width / base.width });
			canvas.width = Math.round(viewport.width);
			canvas.height = Math.round(viewport.height);
			ctx.fillStyle = '#ffffff';
			ctx.fillRect(0, 0, canvas.width, canvas.height);
			await page.render({ canvasContext: ctx, viewport, annotationStorage: state.pdf.annotationStorage })
				.promise;
			painted = true;
		} catch (_err) {
			painted = false;
		}
	}
	if (!painted) {
		canvas.width = width;
		canvas.height = Math.round(width * 1.3);
		ctx.fillStyle = '#ffffff';
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		ctx.fillStyle = 'rgba(23, 23, 23, 0.72)';
		ctx.font = '600 11px -apple-system, system-ui, sans-serif';
		ctx.textBaseline = 'top';
		const name = tab.fileName || 'document.pdf';
		ctx.fillText(name.length > 16 ? `${name.slice(0, 15)}…` : name, 8, 10, width - 16);
	}
	ctx.strokeStyle = 'rgba(23, 23, 23, 0.18)';
	ctx.lineWidth = 1;
	ctx.strokeRect(0.5, 0.5, canvas.width - 1, canvas.height - 1);
	const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
	if (!blob) return [];
	return Array.from(new Uint8Array(await blob.arrayBuffer()));
}

async function startNativeTabDrag(drag) {
	let prepared = null;
	try {
		prepared = await drag.prep;
	} catch (error) {
		console.warn('Tab drag: preparation failed', error);
	}
	if (_tabPointerDrag !== drag) return;
	const pointerEvent = { screenX: drag.screenX, screenY: drag.screenY };
	// Pas de drag natif possible (préparation ratée, bouton déjà relâché hors de
	// la barre avant que le fichier soit prêt, plateforme sans support) : on
	// garde le geste attendu, l'onglet part dans une nouvelle fenêtre.
	const fallbackDetach = async () => {
		teardownTabPointerDrag();
		await releasePreparedTabDrag(drag);
		await detachTabToNewWindow(drag.tabId, pointerEvent);
	};
	if (!prepared || !prepared.icon?.length || drag.released) {
		await fallbackDetach();
		return;
	}
	try {
		await invokeCommand('start_tab_native_drag', {
			icon: prepared.icon,
			exportBytes: prepared.exportBytes
		});
	} catch (error) {
		console.warn('Tab drag: native drag unavailable', error);
		await fallbackDetach();
	}
}

// Fin du drag natif, décidée côté Rust (voir finish_native_tab_drag).
async function onNativeTabDragEnded(action) {
	const drag = _tabPointerDrag;
	teardownTabPointerDrag();
	if (!drag) return;
	if (action === 'claimed' || action === 'merged' || action === 'detached') {
		await closeTab(drag.tabId);
		if (!state.tabs.length) destroyAppWindow();
		return;
	}
	if (action === 'copied') {
		setStatus(currentLocale() === 'fr' ? 'PDF déposé.' : 'PDF dropped.');
	}
	commitTabOrderFromDom();
}

async function acceptIncomingTab(insertIndex) {
	try {
		const payload = await invokeCommand('claim_tab_drag');
		if (!payload?.bytes) return;
		await applyDetachedPayload(payload, insertIndex);
	} catch (error) {
		console.warn('acceptIncomingTab failed', error);
	}
}

async function detachTabToNewWindow(tabId, event) {
	const tab = state.tabs.find((candidate) => candidate.id === tabId);
	if (!tab) return;
	const payload = await buildTabTransferPayload(tab);
	if (!payload) {
		setStatus(
			currentLocale() === 'fr'
				? 'Impossible d’ouvrir une nouvelle fenêtre : document introuvable.'
				: 'Cannot open a new window: document missing.',
			'error'
		);
		commitTabOrderFromDom();
		return;
	}
	try {
		await invokeCommand('spawn_document_window', {
			...payload,
			x: Number.isFinite(event.screenX) ? event.screenX : null,
			y: Number.isFinite(event.screenY) ? event.screenY : null
		});
	} catch (error) {
		setStatus(error instanceof Error ? error.message : String(error), 'error');
		commitTabOrderFromDom();
		return;
	}
	await closeTab(tabId);
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
	signElements.signListSignature = document.getElementById('sign-list-signature');
	signElements.signListInitials = document.getElementById('sign-list-initials');
	signElements.title = document.getElementById('signature-title');
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
	signElements.colorRow = document.getElementById('signature-color-row');
	signElements.color = document.getElementById('signature-color');
	signElements.clear = document.getElementById('signature-clear');
	signElements.typed = document.getElementById('signature-typed');
	signElements.fontRow = document.getElementById('signature-font-row');
	signElements.typedPreview = document.getElementById('signature-typed-preview');
	signElements.file = document.getElementById('signature-file');
	signElements.importPreview = document.getElementById('signature-import-preview');
}

let _signMode = 'draw';
let _signKind = 'signature';
let _signTypedFont = SIGNATURE_FONTS[0].css;
let _signImportDataUrl = null;
let _drawing = false;
let _drawHasInk = false;
let _drawLast = null;

function signatureKind(item) {
	return item?.kind === 'initials' ? 'initials' : 'signature';
}

function loadSavedSignatures() {
	try {
		const raw = localStorage.getItem(SIGNATURES_KEY);
		const items = raw ? JSON.parse(raw) : [];
		if (!Array.isArray(items)) return [];
		return items.map((item) => ({
			...item,
			kind: signatureKind(item)
		}));
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

function signCopy(kind) {
	const fr = currentLocale() === 'fr';
	const initials = kind === 'initials';
	return {
		add: initials
			? fr
				? '+ Ajouter un paraphe'
				: '+ Add initials'
			: fr
				? '+ Ajouter une signature'
				: '+ Add a signature',
		title: initials
			? fr
				? 'Créer un paraphe'
				: 'Create initials'
			: fr
				? 'Créer une signature'
				: 'Create a signature',
		save: initials
			? fr
				? 'Enregistrer le paraphe'
				: 'Save initials'
			: fr
				? 'Enregistrer la signature'
				: 'Save signature',
		placeholder: initials
			? fr
				? 'Tape tes initiales'
				: 'Type your initials'
			: fr
				? 'Tape ton nom'
				: 'Type your name',
		emptyDraw: initials
			? fr
				? 'Dessine ton paraphe.'
				: 'Draw your initials.'
			: fr
				? 'Dessine ta signature.'
				: 'Draw your signature.',
		empty: initials
			? fr
				? 'Paraphe vide.'
				: 'Empty initials.'
			: fr
				? 'Signature vide.'
				: 'Empty signature.',
		saved: initials
			? fr
				? 'Paraphe enregistré.'
				: 'Initials saved.'
			: fr
				? 'Signature enregistrée.'
				: 'Signature saved.',
		arm: initials
			? fr
				? 'Clique sur la page pour poser ton paraphe.'
				: 'Click on the page to place your initials.'
			: fr
				? 'Clique sur la page pour poser ta signature.'
				: 'Click on the page to place your signature.',
		alt: initials ? (fr ? 'paraphe' : 'initials') : 'signature'
	};
}

function applySignatureModalCopy() {
	const copy = signCopy(_signKind);
	if (signElements.title) signElements.title.textContent = copy.title;
	if (signElements.save) signElements.save.textContent = copy.save;
	if (signElements.typed) signElements.typed.placeholder = copy.placeholder;
}

function renderSignSlot(listEl, kind) {
	if (!listEl) return;
	const items = loadSavedSignatures().filter((item) => item.kind === kind);
	const copy = signCopy(kind);
	listEl.innerHTML = '';
	for (const sig of items) {
		const row = document.createElement('div');
		row.className = 'sign-item';
		if (state.pendingSignature?.id === sig.id) row.classList.add('armed');
		const img = document.createElement('img');
		img.src = sig.dataUrl;
		img.alt = copy.alt;
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
			const next = loadSavedSignatures().filter((item) => item.id !== sig.id);
			persistSavedSignatures(next);
			if (state.pendingSignature?.id === sig.id) disarmSignature();
			renderSignaturesPanel();
		});
		row.append(useBtn, del);
		listEl.append(row);
	}
	const add = document.createElement('button');
	add.type = 'button';
	add.className = 'sign-create-button';
	add.textContent = copy.add;
	add.addEventListener('click', () => openSignatureModal(kind));
	listEl.append(add);
}

function renderSignaturesPanel() {
	renderSignSlot(signElements.signListSignature, 'signature');
	renderSignSlot(signElements.signListInitials, 'initials');
}

function armSignature(sig) {
	if (_pendingFormSignatureField) {
		void applyFormSignature(sig);
		return;
	}
	state.pendingSignature = sig;
	document.body.classList.add('sign-arming');
	setStatus(signCopy(signatureKind(sig)).arm);
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
	const targetW =
		signatureKind(sig) === 'initials'
			? Math.min(rect.width * 0.12, 90)
			: Math.min(rect.width * 0.28, 220);
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
	const fromImage = String(sig.id || '').startsWith('img-');
	pushHistory(fromImage ? 'histImageAdd' : 'histSignature');
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

	const resizeHandle = document.createElement('div');
	resizeHandle.className = 'sign-handle sign-resize';
	const delHandle = document.createElement('div');
	delHandle.className = 'sign-handle sign-del';
	delHandle.textContent = '×';
	box.append(resizeHandle, delHandle);

	box.addEventListener('pointerdown', (event) => {
		if (event.target === resizeHandle || event.target === delHandle) {
			return;
		}
		event.preventDefault();
		selectSignature(placement.id);
		startSignatureDrag(event, placement, box);
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
		pushHistory('histSignature');
		state.signaturePlacements = state.signaturePlacements.filter((p) => p.id !== placement.id);
		if (state.selectedSignatureId === placement.id) state.selectedSignatureId = null;
		persistSignaturePlacements();
		renderSignaturePlacementsForPage(placement.page);
		updateSelectedEditField();
		markDirty();
	});

	return box;
}

function selectSignature(id) {
	state.selectedSignatureId = id;
	if (clearBlockSelection()) renderEditBlocks();
	for (const el of document.querySelectorAll('.sign-placement')) {
		el.classList.toggle('selected', el.dataset.id === id);
	}
	updateSelectedEditField();
}

function selectedSignaturePlacement() {
	return state.signaturePlacements.find((placement) => placement.id === state.selectedSignatureId) || null;
}

function normalizeSignatureRotation(value) {
	const angle = Number(value);
	if (!Number.isFinite(angle)) return 0;
	return Math.max(-180, Math.min(180, Math.round(angle)));
}

function updateSignatureControls() {
	const block = selectedEditBlock();
	const placement = selectedSignaturePlacement();
	const active = Boolean(placement || (block && block.kind !== 'image'));
	if (elements.signatureTransformPanel) elements.signatureTransformPanel.hidden = !active;
	const angle = normalizeSignatureRotation(placement?.rotation ?? block?.rotation ?? 0);
	for (const control of [elements.signatureRotationRange, elements.signatureRotationInput]) {
		if (!control) continue;
		control.disabled = !active;
		control.value = String(angle);
	}
}

let signatureRotationSnapshot = null;

function applySelectedSignatureRotation(value, commit = false) {
	const placement = selectedSignaturePlacement();
	const block = placement ? null : selectedEditBlock();
	if (!placement && (!block || block.kind === 'image')) return;
	const angle = normalizeSignatureRotation(value);
	const current = placement ? placement.rotation : (block.rotation || 0);
	if (current === angle && !commit) return;
	if (!signatureRotationSnapshot) signatureRotationSnapshot = captureEditableSnapshot();
	if (placement) {
		placement.rotation = angle;
		renderSignaturePlacementsForPage(placement.page);
		selectSignature(placement.id);
		persistSignaturePlacements();
	} else {
		block.rotation = angle === 0 ? 0 : angle;
		// Un bloc monté a été gelé (alto-frozen) avec transform réservé au
		// déplacement : la rotation emprunte le slow path (transform rotate) qui
		// reconstruit className SANS alto-frozen. Au retour à 0°, le fast path
		// réutiliserait ce node dé-gelé (couleur/white-space de base = texte
		// invisible ou déformé). On purge le montage pour forcer un remontage
		// propre dans les deux sens.
		delete block._mounted;
		delete block._mountX;
		delete block._mountY;
		delete block._mountLeft;
		delete block._mountTop;
		delete block._mountSig;
		renderEditBlocksForPage(block.page);
		updateSignatureControls();
	}
	markDirty();
	if (commit && signatureRotationSnapshot) {
		commitSnapshot(signatureRotationSnapshot, 'histSignature');
		signatureRotationSnapshot = null;
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
			commitSnapshot(snap, 'histSignature');
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
			commitSnapshot(snap, 'histSignature');
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
			commitSnapshot(snap, 'histSignature');
			persistSignaturePlacements();
			markDirty();
		}
	};
	window.addEventListener('pointermove', move);
	window.addEventListener('pointerup', up);
}

function openSignatureModal(kind = 'signature') {
	cacheSignElements();
	_signKind = kind === 'initials' ? 'initials' : 'signature';
	_signMode = 'draw';
	_signImportDataUrl = null;
	switchSignatureMode('draw');
	clearSignatureCanvas();
	if (signElements.typed) signElements.typed.value = '';
	if (signElements.typedPreview) signElements.typedPreview.innerHTML = '';
	if (signElements.importPreview) signElements.importPreview.innerHTML = '';
	if (signElements.file) signElements.file.value = '';
	applySignatureModalCopy();
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
	// Couleur partagée Dessiner / Taper — inutile à l’import (image inchangée).
	signElements.colorRow?.classList.toggle('hidden', mode === 'import');
	if (mode === 'type') renderTypedPreview();
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
	signElements.typedPreview.style.color = signElements.color?.value || '#0a3a8c';
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
	ctx.fillStyle = signElements.color?.value || '#0a3a8c';
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
	const copy = signCopy(_signKind);
	if (_signMode === 'draw') {
		if (!_drawHasInk) {
			setStatus(copy.emptyDraw, 'error');
			return;
		}
		result = trimCanvasToDataUrl(signElements.canvas);
	} else if (_signMode === 'type') {
		result = buildTypedSignature();
	} else {
		result = await buildImportSignature();
	}
	if (!result) {
		setStatus(copy.empty, 'error');
		return;
	}
	const items = loadSavedSignatures();
	items.unshift({
		id: `sg-${Date.now()}-${Math.random().toString(16).slice(2)}`,
		kind: _signKind,
		dataUrl: result.dataUrl,
		width: result.width,
		height: result.height
	});
	persistSavedSignatures(items);
	closeSignatureModal();
	renderSignaturesPanel();
	if (_pendingFormSignatureField) {
		void applyFormSignature(items[0]);
		return;
	}
	setStatus(copy.saved);
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
	signElements.close?.addEventListener('click', closeSignatureModal);
	signElements.cancel?.addEventListener('click', closeSignatureModal);
	signElements.backdrop?.addEventListener('click', closeSignatureModal);
	signElements.save?.addEventListener('click', () => void saveSignatureFromModal());
	signElements.clear?.addEventListener('click', clearSignatureCanvas);
	for (const tab of signElements.tabs) {
		tab.addEventListener('click', () => switchSignatureMode(tab.dataset.sigMode));
	}
	signElements.typed?.addEventListener('input', renderTypedPreview);
	signElements.color?.addEventListener('input', () => {
		if (_signMode === 'type') renderTypedPreview();
	});
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

	renderSignaturesPanel();

	document.addEventListener('keydown', (event) => {
		if (event.key === 'Escape' && state.pendingSignature) {
			disarmSignature();
		}
		if (event.key === 'Escape' && _pendingFormSignatureField) {
			_pendingFormSignatureField = null;
		}
		if (
			(event.key === 'Delete' || event.key === 'Backspace') &&
			state.selectedSignatureId &&
			document.activeElement === document.body
		) {
			const sel = state.signaturePlacements.find((p) => p.id === state.selectedSignatureId);
			if (sel) {
				pushHistory('histSignature');
				state.signaturePlacements = state.signaturePlacements.filter((p) => p.id !== sel.id);
				persistSignaturePlacements();
				renderSignaturePlacementsForPage(sel.page);
				state.selectedSignatureId = null;
				updateSelectedEditField();
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

// stripTransientBlockFields : voir ./native-history.js
// (préserve `_lineLocked` / `_splitFrom` pour le redo après éclatement).

function captureEditableSnapshot() {
	return {
		signaturePlacements: state.signaturePlacements.map((p) => ({ ...p })),
		editBlocks: state.editBlocks.map((b) => stripTransientBlockFields(b)),
		page: state.page
	};
}

// Historique « illimité » : plus de plafond fixe à 50 étapes. L'éviction est
// pilotée par un budget MÉMOIRE estimé (chaque snapshot copie tous les blocs)
// + un plafond de sécurité. Sur un document normal, des milliers de frappes
// tiennent dans le budget ; seuls les très gros documents évincent les états
// les plus anciens.
const HISTORY_MAX_ENTRIES = 2000;
const HISTORY_MAX_BYTES = 120 * 1024 * 1024;

function approxSnapshotBytes(snap) {
	let bytes = 2048;
	for (const b of snap.editBlocks || []) {
		bytes += 700;
		if (b.text) bytes += b.text.length * 2;
		if (b.originalText) bytes += b.originalText.length * 2;
		if (b.html) bytes += b.html.length * 2;
		if (Array.isArray(b.pdfChars)) bytes += b.pdfChars.length * 160;
	}
	bytes += (snap.signaturePlacements || []).length * 400;
	return bytes;
}

function commitSnapshot(snap, label) {
	const tab = currentTab();
	if (!tab || !snap) return;
	if (!Array.isArray(tab.undoStack)) tab.undoStack = [];
	tab.undoStack.push({
		snap,
		label: label || 'histEdit',
		time: Date.now(),
		bytes: approxSnapshotBytes(snap)
	});
	let total = 0;
	for (const entry of tab.undoStack) total += entry.bytes || 0;
	while (
		tab.undoStack.length > 1 &&
		(tab.undoStack.length > HISTORY_MAX_ENTRIES || total > HISTORY_MAX_BYTES)
	) {
		const evicted = tab.undoStack.shift();
		total -= evicted.bytes || 0;
		tab._historyEvicted = true;
	}
	tab.redoStack = [];
	updateUndoRedoButtons();
	refreshHistoryPanelIfVisible();
}

function pushHistory(label) {
	commitSnapshot(captureEditableSnapshot(), label);
}

function applyEditableSnapshot(snap) {
	if (!snap) return Promise.resolve();
	state.signaturePlacements = snap.signaturePlacements.map((p) => ({ ...p }));
	// Les files d'édition native en vol référencent les ANCIENS objets blocs :
	// on les détache pour qu'elles s'arrêtent (la réconciliation ci-dessous
	// reprend la main sur les nouveaux objets, sans entrelacement).
	for (const block of state.editBlocks) block._detached = true;
	// Strip défensif : un snapshot ne doit jamais réinjecter d'origines de
	// montage/drag périmées (cf. stripTransientBlockFields).
	state.editBlocks = snap.editBlocks.map((b) => stripTransientBlockFields(b));
	state.selectedBlockId = null;
	state.selectedBlockIds = [];
	state.selectedSignatureId = null;
	persistSignaturePlacements();
	persistCurrentTabState();
	renderEditBlocks();
	renderAllSignaturePlacements();
	updateSelectedEditField();
	markDirty();
	// Éditions natives : le document Rust peut porter un texte plus récent que
	// l'état restauré → on le ramène à ce que l'UI affiche (édition inverse).
	// nativeTouchedPages persiste après synchronisation : un undo POST-sync doit
	// encore réconcilier (sinon le canvas garde le texte édité à jamais).
	if (
		(state.nativeEditedPages instanceof Set && state.nativeEditedPages.size) ||
		nativeTouchedPagesSet().size
	) {
		return reconcileNativeEditsAfterHistory();
	}
	return Promise.resolve();
}

// Recule de `steps` étapes dans l'historique en n'appliquant l'état (rendu +
// réconciliation native) qu'UNE seule fois — le clic dans le panneau
// Historique peut sauter des dizaines d'étapes d'un coup.
async function historyJumpBack(steps) {
	const tab = currentTab();
	if (!tab || !Array.isArray(tab.undoStack) || !tab.undoStack.length) return;
	if (!Array.isArray(tab.redoStack)) tab.redoStack = [];
	let current = captureEditableSnapshot();
	for (let s = 0; s < steps; s += 1) {
		const entry = tab.undoStack.pop();
		if (!entry) break;
		tab.redoStack.push({
			snap: current,
			label: entry.label,
			time: entry.time,
			bytes: entry.bytes
		});
		current = entry.snap;
	}
	await applyEditableSnapshot(current);
	updateUndoRedoButtons();
	refreshHistoryPanelIfVisible();
}

async function historyJumpForward(steps) {
	const tab = currentTab();
	if (!tab || !Array.isArray(tab.redoStack) || !tab.redoStack.length) return;
	if (!Array.isArray(tab.undoStack)) tab.undoStack = [];
	let current = captureEditableSnapshot();
	for (let s = 0; s < steps; s += 1) {
		const entry = tab.redoStack.pop();
		if (!entry) break;
		tab.undoStack.push({
			snap: current,
			label: entry.label,
			time: entry.time,
			bytes: entry.bytes
		});
		current = entry.snap;
	}
	await applyEditableSnapshot(current);
	updateUndoRedoButtons();
	refreshHistoryPanelIfVisible();
}

function undoEdit() {
	void historyJumpBack(1);
}

function redoEdit() {
	void historyJumpForward(1);
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
	if (window.__slateDefaultAppPrompted) return;
	if (!elements.defaultAppModal || !elements.defaultAppBackdrop) return;

	let alreadyDefault = false;
	try {
		alreadyDefault = Boolean(await invokeCommand('is_default_pdf_handler'));
	} catch (_err) {
		alreadyDefault = false;
	}
	if (alreadyDefault) {
		setDefaultAppPref('done');
		window.__slateDefaultAppPrompted = true;
		return;
	}

	let pref = '';
	try {
		pref = localStorage.getItem(DEFAULT_APP_PREF_KEY) || '';
	} catch (_err) {
		pref = '';
	}
	if (pref === 'never' || pref === 'done') return;
	if (pref.startsWith('later:')) {
		const ts = Number(pref.slice(6));
		if (Number.isFinite(ts) && Date.now() - ts < 3 * 24 * 60 * 60 * 1000) return;
	}

	window.__slateDefaultAppPrompted = true;
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
			await runOcrForCurrentPage(false, { silent: true });
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
				pushHistory('histTextEdit');
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
				pushHistory('histBlockDelete');
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
		const fr = currentLocale() === 'fr';
		try {
			await invokeCommand('set_default_pdf_handler');
			let nowDefault = false;
			try {
				nowDefault = Boolean(await invokeCommand('is_default_pdf_handler'));
			} catch (_err) {
				nowDefault = false;
			}
			if (nowDefault) {
				setDefaultAppPref('done');
				setStatus(
					fr
						? 'Slate est maintenant ton lecteur PDF par défaut.'
						: 'Slate is now your default PDF reader.'
				);
			} else {
				setStatus(
					fr
						? 'Choisis Slate comme lecteur PDF dans les réglages qui viennent de s’ouvrir.'
						: 'Choose Slate as your default PDF reader in the settings that just opened.'
				);
			}
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
	document.body.classList.remove('has-precise-edit-selection');

	// Overlay SVG réservé à l'édition glyphe (boîtes PDF exactes). En lecture, la
	// sélection native du textLayer est la bonne géométrie — un SVG « resserré »
	// décalait le bleu au-dessus du texte.
	const preciseEdit = preciseEditSelection(selection);
	if (preciseEdit) {
		const fragments = nativeEditSelectionFragments(
			preciseEdit.element,
			preciseEdit.block,
			preciseEdit.start,
			preciseEdit.end
		);
		if (fragments.length) {
			renderPreciseSelectionFragments(fragments);
			document.body.classList.add('has-precise-edit-selection');
			return;
		}
	}

	_selectionOverlay.style.display = 'none';
}

function renderPreciseSelectionFragments(fragments) {
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

function preciseEditSelection(selection) {
	let element = null;
	let blockId = null;
	let start = 0;
	let end = 0;

	if (isFontComboOpen() && _fontComboSavedRange) {
		blockId = _fontComboSavedRange.blockId;
		start = _fontComboSavedRange.start;
		end = _fontComboSavedRange.end;
		element = elements.pagesStack.querySelector(
			`.edit-block.editing[data-block-id="${blockId}"]`
		);
	} else if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
		const range = selection.getRangeAt(0);
		let node = range.commonAncestorContainer;
		if (node.nodeType !== Node.ELEMENT_NODE) node = node.parentElement;
		element = node?.closest?.('.edit-block.editing') || null;
		if (!element) return null;
		const offsets = textOffsetsForDomRange(element, range);
		if (!offsets) return null;
		blockId = element.dataset.blockId;
		start = offsets.start;
		end = offsets.end;
	}

	if (!element || !blockId || end <= start) return null;
	const block = state.editBlocks.find((candidate) => candidate.id === blockId);
	if (!block) return null;
	return { element, block, start, end };
}

function nativeEditSelectionFragments(element, block, start, end) {
	// Après formatage HTML (ou sur un texte ajouté), le rendu visible et la
	// sélection utilisent la même police DOM : les anciennes boîtes PDF ne sont
	// plus la bonne géométrie.
	if (block.htmlEdited || block.added || (block.fontFamilyOverride && isBlockTextEdited(block))) {
		return [];
	}
	const lines = nativeCaretLines(block, element.textContent || '');
	const data = getPageData(block.page);
	if (!lines || !data?.editLayer) return [];
	const layerRect = data.editLayer.getBoundingClientRect();
	const scaleX = layerRect.width / Math.max(1, data.viewportWidth);
	const scaleY = layerRect.height / Math.max(1, data.viewportHeight);
	const { dx, dy } = blockMoveDelta(block);
	const fragments = [];
	let offset = 0;

	for (const line of lines) {
		for (const character of line.chars) {
			const length = (character.text || '').length;
			const characterStart = offset;
			const characterEnd = offset + length;
			if (length > 0 && characterEnd > start && characterStart < end) {
				const from = Math.max(0, start - characterStart) / length;
				const to = Math.min(length, end - characterStart) / length;
				const left = layerRect.left + (character.x + character.width * from + dx) * scaleX;
				const right = layerRect.left + (character.x + character.width * to + dx) * scaleX;
				const top = layerRect.top + (line.y + dy) * scaleY;
				const bottom = top + line.height * scaleY;
				fragments.push({ left, right, top, bottom });
			}
			offset = characterEnd;
		}
		offset += 1;
	}
	return fragments;
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

	if (state.activeTabId && state.activeTabId !== tabId) {
		try {
			if (state.nativeTextDirty) await syncNativeDocumentBytes({ render: false });
			await bakeFormValues();
		} catch (_err) {
			/* best effort avant de quitter l'onglet */
		}
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

function keepAppChromeVisible() {
	if (window.scrollX !== 0 || window.scrollY !== 0) {
		window.scrollTo({ left: 0, top: 0, behavior: 'auto' });
	}
}

function scrollPageInsideReader(data, behavior = 'auto') {
	if (!data?.wrapper || !elements.dropZone) return;
	keepAppChromeVisible();
	const stageRect = elements.dropZone.getBoundingClientRect();
	const pageRect = data.wrapper.getBoundingClientRect();
	const top = Math.max(0, elements.dropZone.scrollTop + pageRect.top - stageRect.top - 24);
	elements.dropZone.scrollTo({ top, behavior });
	requestAnimationFrame(keepAppChromeVisible);
}

async function mountPagesStack() {
	disposePagesStack();
	if (!state.pdf) return;

	elements.pagesStack.classList.remove('hidden');
	const ratio = pageRenderRatio();

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

		// Champs de formulaire interactifs (AnnotationLayer PDF.js) : on tape
		// directement dans les cases, comme dans Acrobat.
		const formLayer = document.createElement('div');
		formLayer.className = 'annotationLayer form-layer';
		formLayer.dataset.page = String(pageNumber);

		const mask = document.createElement('div');
		mask.className = 'render-mask';
		mask.textContent = '…';

		const badge = document.createElement('div');
		badge.className = 'page-badge';
		badge.textContent = String(pageNumber);

		wrapper.append(canvas, textLayer, formLayer, editLayer, overlay, signLayer, mask, badge);
		elements.pagesStack.append(wrapper);

		state.pageElements.set(pageNumber, {
			pageNumber,
			wrapper,
			canvas,
			textLayer,
			editLayer,
			overlay,
			signLayer,
			formLayer,
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
		scrollPageInsideReader(initial);
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
	if (state.settings.pageLayout === 'single') {
		state.settings.fitWidth = false;
		if (elements.settingFitWidth) elements.settingFitWidth.checked = false;
		await fitSinglePageToViewport(false);
		await relayoutPagesStack();
	} else {
		// Retour au continu : reprendre le fit largeur (comportement Acrobat).
		state.settings.fitWidth = true;
		if (elements.settingFitWidth) elements.settingFitWidth.checked = true;
		await fitPageWidth(false);
		await relayoutPagesStack();
	}
	saveSettings();
	applyPageLayout();
	// Le zoom a pu changer (ajustement page unique) sans passer par updateUi :
	// on rafraîchit l'indicateur de pourcentage pour qu'il reflète le zoom réel.
	updateUi();
	const data = getActivePageData();
	if (data) {
		scrollPageInsideReader(data);
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

// Résolution de rendu des pages : au minimum 2x, même sur écran non-Retina
// (devicePixelRatio = 1). Le canvas sur-échantillonné est réduit par le
// compositeur avec filtrage bilinéaire → texte et images nettement plus lisses,
// là où un rendu 1:1 donne un aspect pixelisé (crénelage des glyphes).
// Borné à 3 pour contenir la mémoire GPU (A4 zoomée ≈ 18 Mo par page à 2x).
function pageRenderRatio() {
	return Math.min(3, Math.max(2, window.devicePixelRatio || 1));
}

// Dimensions CSS d'une page : cadre + toutes les couches superposées au canvas.
function applyPageDimensions(data, cssWidth, cssHeight) {
	data.viewportWidth = cssWidth;
	data.viewportHeight = cssHeight;
	data.wrapper.style.width = `${cssWidth}px`;
	data.wrapper.style.height = `${cssHeight}px`;
	for (const layer of [data.textLayer, data.editLayer, data.overlay, data.signLayer]) {
		if (!layer) continue;
		layer.style.width = `${cssWidth}px`;
		layer.style.height = `${cssHeight}px`;
	}
}

// Peint une page PDF.js dans un canvas déjà dimensionné (en pixels physiques).
async function paintPageCanvas(page, viewport, canvas, ratio) {
	const context = canvas.getContext('2d', { alpha: false });
	if (!context) throw new Error('Canvas context is unavailable.');
	// Lissage ACTIVÉ : les images embarquées dans le PDF (logos, scans) sont
	// presque toujours ré-échantillonnées par le zoom ; sans lissage elles
	// sortent en « nearest neighbor » → aspect pixelisé sur toute la page.
	context.imageSmoothingEnabled = true;
	context.imageSmoothingQuality = 'high';
	context.fillStyle = '#ffffff';
	context.fillRect(0, 0, canvas.width, canvas.height);
	// ENABLE_FORMS : les champs de formulaire ne sont PAS peints sur le canvas,
	// c'est la couche HTML (renderFormLayer) qui les affiche et les rend
	// éditables. Les boutons image restent peints (ils ont leur propre rendu).
	await page.render({
		canvasContext: context,
		viewport,
		transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null,
		annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS,
		annotationStorage: state.pdf.annotationStorage
	}).promise;
}

function pageVisualLayers(data) {
	return [data.canvas, data.textLayer, data.formLayer, data.editLayer, data.overlay, data.signLayer].filter(
		Boolean
	);
}

// Aperçu instantané d'une rotation : la page telle qu'elle est déjà affichée
// (raster + couches) est tournée en CSS dans un cadre aux dimensions finales,
// le temps que le moteur écrive le PDF et que la page soit re-rendue nette.
// `_pendingTurn` cumule les quarts de tour cliqués mais pas encore rendus, si
// bien que des clics rapprochés s'additionnent sans jamais revenir en arrière.
function applyRotationPreview(data) {
	const turn = ((((data._pendingTurn || 0) % 360) + 360) % 360);
	const baseWidth = data.viewportWidth;
	const baseHeight = data.viewportHeight;
	const swapsAxes = turn === 90 || turn === 270;
	const frameWidth = swapsAxes ? baseHeight : baseWidth;
	const frameHeight = swapsAxes ? baseWidth : baseHeight;
	data.wrapper.style.width = `${frameWidth}px`;
	data.wrapper.style.height = `${frameHeight}px`;
	const shiftX = (frameWidth - baseWidth) / 2;
	const shiftY = (frameHeight - baseHeight) / 2;
	const transform = turn ? `translate(${shiftX}px, ${shiftY}px) rotate(${turn}deg)` : '';
	for (const layer of pageVisualLayers(data)) {
		layer.style.transform = transform;
		layer.style.transformOrigin = turn ? '50% 50%' : '';
	}
}

// Re-rend une page déjà affichée SANS masque ni canvas vidé : le nouveau rendu
// est peint hors écran puis substitué d'un coup à l'ancien. Après une rotation,
// la feuille passe ainsi directement de l'aperçu CSS au rendu net, sans page
// blanche intermédiaire.
async function rerenderPageQuietly(pageNumber) {
	if (!state.pdf) return;
	const data = getPageData(pageNumber);
	if (!data) return;
	const token = ++data.renderToken;
	const page = await state.pdf.getPage(pageNumber);
	if (token !== data.renderToken) return;
	const viewport = pageViewport(page);
	const cssWidth = Math.floor(viewport.width);
	const cssHeight = Math.floor(viewport.height);

	if (!data.rendered) {
		// Page hors champ : on ajuste seulement son cadre, le rendu paresseux
		// (IntersectionObserver) s'en chargera avec le nouveau document.
		applyPageDimensions(data, cssWidth, cssHeight);
		applyRotationPreview(data);
		return;
	}

	const ratio = pageRenderRatio();
	const canvas = document.createElement('canvas');
	canvas.setAttribute('aria-label', `PDF page ${pageNumber}`);
	canvas.width = Math.floor(cssWidth * ratio);
	canvas.height = Math.floor(cssHeight * ratio);
	canvas.style.width = `${cssWidth}px`;
	canvas.style.height = `${cssHeight}px`;
	await paintPageCanvas(page, viewport, canvas, ratio);
	if (token !== data.renderToken) return;

	data.canvas.replaceWith(canvas);
	data.canvas = canvas;
	data._nativeCanvasPrimed = null;
	applyPageDimensions(data, cssWidth, cssHeight);
	applyRotationPreview(data);
	renderEditBlocksForPage(pageNumber);
	renderPageNotesForPage(pageNumber);
	renderSignaturePlacementsForPage(pageNumber);
	try {
		await renderOfficialTextLayer(page, viewport, data);
	} catch (textLayerError) {
		console.warn('Text layer rendering skipped.', textLayerError);
	}
	try {
		await renderFormLayer(page, viewport, data);
	} catch (formLayerError) {
		console.warn('Form layer rendering skipped.', formLayerError);
	}
}

// Les couches de formulaire déjà rendues écrivent dans l'annotationStorage du
// document PDF.js qui les a créées : après un remplacement du document, on les
// rebranche sur le nouveau, sinon les saisies faites ensuite seraient perdues.
async function rebindRenderedFormLayers(exceptPage) {
	if (!state.pdf) return;
	for (const data of state.pageElements.values()) {
		if (data.pageNumber === exceptPage || !data.rendered) continue;
		if (!data.formLayer || data.formLayer.classList.contains('hidden')) continue;
		try {
			const page = await state.pdf.getPage(data.pageNumber);
			await renderFormLayer(page, pageViewport(page), data);
		} catch (formLayerError) {
			console.warn('Form layer rebinding skipped.', formLayerError);
		}
	}
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
		const ratio = pageRenderRatio();
		const cssWidth = Math.floor(viewport.width);
		const cssHeight = Math.floor(viewport.height);
		const pixelWidth = Math.floor(cssWidth * ratio);
		const pixelHeight = Math.floor(cssHeight * ratio);

		applyPageDimensions(data, cssWidth, cssHeight);
		if (data._pendingTurn) applyRotationPreview(data);
		data.canvas.width = pixelWidth;
		data.canvas.height = pixelHeight;
		data.canvas.style.width = `${cssWidth}px`;
		data.canvas.style.height = `${cssHeight}px`;

		await paintPageCanvas(page, viewport, data.canvas, ratio);
		if (token !== data.renderToken) return;
		// Le canvas vient d'être repeint par PDF.js : tout pré-rendu PDFium
		// antérieur est écrasé (primeNativePageCanvas devra re-basculer).
		data._nativeCanvasPrimed = null;

		try {
			await renderOfficialTextLayer(page, viewport, data);
		} catch (textLayerError) {
			console.warn('Text layer rendering skipped.', textLayerError);
		}
		try {
			await renderFormLayer(page, viewport, data);
		} catch (formLayerError) {
			console.warn('Form layer rendering skipped.', formLayerError);
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
function rescaleBlockToViewport(block, data) {
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
	// Espacement inter-lettres capturé en px à l'échelle précédente.
	if (Number.isFinite(block.editLetterSpacing)) block.editLetterSpacing *= rx;

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

function rescaleEditBlocksForZoom() {
	for (const block of state.editBlocks) {
		rescaleBlockToViewport(block, getPageData(block.page));
	}
	// Les snapshots undo/redo stockent des coordonnées ABSOLUES à l'échelle où
	// ils ont été capturés : sans rescale, un « Annuler » après un zoom
	// restaurerait des blocs désalignés du canvas. Chaque bloc snapshoté porte
	// son pageWidth/pageHeight de capture → même formule proportionnelle.
	const tab = currentTab();
	if (tab) {
		for (const entry of tab.undoStack || []) {
			for (const block of entry.snap?.editBlocks || []) {
				rescaleBlockToViewport(block, getPageData(block.page));
			}
		}
		for (const entry of tab.redoStack || []) {
			for (const block of entry.snap?.editBlocks || []) {
				rescaleBlockToViewport(block, getPageData(block.page));
			}
		}
	}
}

async function relayoutPagesStack() {
	if (!state.pdf || !state.pageElements.size) return;
	// Le caret est positionné en coordonnées d'overlay : il devient obsolète dès
	// que le zoom change. On le retire avant le redimensionnement, puis on le
	// recalcule uniquement sur le nouvel overlay.
	removeNativeCaretBar();
	// Éditions natives non synchronisées : PDF.js re-rendrait l'ANCIEN document
	// (les frappes disparaîtraient). On recharge d'abord le document édité.
	if (state.nativeTextDirty) await syncNativeDocumentBytes({ render: false });
	const ratio = pageRenderRatio();
	for (const data of state.pageElements.values()) {
		const page = await state.pdf.getPage(data.pageNumber);
		const viewport = pageViewport(page);
		// MÊME arrondi que renderPage (Math.floor) : sinon rescaleEditBlocksForZoom
		// calcule ses ratios sur un viewport ~1px plus grand que celui réellement
		// rendu ensuite → dérive progressive entre le canvas PDF et l'overlay.
		const cssWidth = Math.floor(viewport.width);
		const cssHeight = Math.floor(viewport.height);
		data.viewportWidth = cssWidth;
		data.viewportHeight = cssHeight;
		data.wrapper.style.width = `${cssWidth}px`;
		data.wrapper.style.height = `${cssHeight}px`;
		data.canvas.style.width = `${cssWidth}px`;
		data.canvas.style.height = `${cssHeight}px`;
		data.canvas.width = Math.floor(cssWidth * ratio);
		data.canvas.height = Math.floor(cssHeight * ratio);
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
		data.rendered = false;
	}
	// Aligner les blocs d'édition sur le nouveau zoom AVANT de re-rendre les pages.
	rescaleEditBlocksForZoom();
	await renderPagesAround(state.page, 1);
	scheduleNativeCaretUpdate();
}

// Largeur/hauteur RÉELLEMENT disponibles pour une page : clientWidth exclut déjà
// la scrollbar, mais inclut le padding de la zone. Soustraire une constante
// approximative laissait la page dépasser → barre de défilement horizontale.
function readerStageSize() {
	const zone = elements.dropZone;
	if (!zone) return { width: 120, height: 120 };
	const styles = getComputedStyle(zone);
	const padX = (parseFloat(styles.paddingLeft) || 0) + (parseFloat(styles.paddingRight) || 0);
	const padY = (parseFloat(styles.paddingTop) || 0) + (parseFloat(styles.paddingBottom) || 0);
	return {
		width: Math.max(120, zone.clientWidth - padX),
		height: Math.max(120, zone.clientHeight - padY)
	};
}

// Un relayout redimensionne les canvas alors qu'un `page.render` peut déjà être
// en vol : si le zoom change entre les deux, le rendu se pose en petit dans le
// coin d'un canvas agrandi. Tout changement de zoom < 0,5 % est donc ignoré, et
// les fits sont sérialisés (voir runViewportFit).
const FIT_ZOOM_EPSILON = 0.005;

async function applyFitZoom(nextZoom, shouldRender) {
	if (!shouldRender) {
		state.zoom = nextZoom;
		return;
	}
	if (Math.abs(nextZoom - state.zoom) < FIT_ZOOM_EPSILON) {
		updateUi();
		return;
	}
	state.zoom = nextZoom;
	updateUi();
	await relayoutPagesStack();
}

async function fitPageWidth(shouldRender = true) {
	if (!state.pdf) return;
	const page = await state.pdf.getPage(state.page);
	const viewport = page.getViewport({ scale: 1 });
	const { width: stageWidth } = readerStageSize();
	// Comme Acrobat : la page suit la largeur utile, y compris en fenêtre étroite.
	const nextZoom = Math.max(0.25, Math.min(2.5, stageWidth / (viewport.width * CSS_UNITS)));
	state.fitMode = 'width';
	await applyFitZoom(nextZoom, shouldRender);
}

async function fitSinglePageToViewport(shouldRender = true) {
	if (!state.pdf) return;
	const page = await state.pdf.getPage(state.page);
	const viewport = page.getViewport({ scale: 1 });
	const { width: stageWidth, height: stageHeight } = readerStageSize();
	const fitWidthZoom = stageWidth / (viewport.width * CSS_UNITS);
	const fitHeightZoom = stageHeight / (viewport.height * CSS_UNITS);
	const nextZoom = Math.max(0.25, Math.min(2.75, Math.min(fitWidthZoom, fitHeightZoom)));
	state.fitMode = 'page';
	await applyFitZoom(nextZoom, shouldRender);
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

// ── Formulaires AcroForm : remplissage direct sur la page ─────────────────
//
// Les widgets sont rendus en HTML par l'AnnotationLayer de PDF.js (inputs,
// cases, radios, listes) positionnés sur la page ; les valeurs vivent dans
// `pdf.annotationStorage`. Après chaque saisie, on « cuit » le document avec
// `pdf.saveDocument()` (PDF.js écrit /V ET une apparence propre) dans
// state.fileBytes : enregistrer, imprimer, partager ou glisser l'onglet
// emportent donc le formulaire rempli. Un miroir `tab.formValues` survit aux
// rechargements du document (éditions natives, bouton image).
const FORM_BAKE_DELAY_MS = 350;
let _formBakeTimer = null;
let _formBakePromise = null;
/** Champs affichés dans le panneau Formulaires (nom → champ). */
let _formsPanelFields = null;

// Service de liens minimal exigé par l'AnnotationLayer (on ne lui confie que
// des widgets : aucune navigation n'est réellement déclenchée).
const formLinkService = {
	externalLinkTarget: null,
	externalLinkRel: 'noopener noreferrer nofollow',
	externalLinkEnabled: false,
	isInPresentationMode: false,
	eventBus: null,
	getDestinationHash: () => '#',
	getAnchorUrl: () => '#',
	addLinkAttributes: (link) => {
		link.href = '#';
	},
	goToDestination: () => {},
	goToPage: () => {},
	executeNamedAction: () => {},
	executeSetOCGState: () => {}
};

function isFormWidget(annotation) {
	return annotation && annotation.subtype === 'Widget' && !annotation.hidden;
}

// Bouton poussoir « importer une image » : action JavaScript Acrobat
// `event.target.buttonImportIcon()` (aucun lecteur hors Acrobat ne l'exécute).
function isImageButtonWidget(annotation) {
	if (!annotation?.pushButton) return false;
	const actions = annotation.actions;
	if (!actions) return false;
	return Object.values(actions).some(
		(scripts) => Array.isArray(scripts) && scripts.some((js) => /buttonImportIcon/i.test(String(js)))
	);
}

function isSignatureWidget(annotation) {
	return annotation?.fieldType === 'Sig';
}

function dateActionScripts(widget) {
	const actions = widget?.actions;
	if (!actions) return [];
	return Object.values(actions)
		.flat()
		.filter((script) => typeof script === 'string');
}

function dateFormatOf(widget) {
	if (widget?.datetimeFormat) return String(widget.datetimeFormat);
	for (const script of dateActionScripts(widget)) {
		const match = script.match(/AFDate_(?:Keystroke|Format)(?:Ex)?\(['"]([^'"]+)['"]\)/i);
		if (match) return match[1];
	}
	const hint = `${widget?.alternativeText || ''} ${widget?.fieldName || ''}`;
	if (/jj\s*\/\s*mm\s*\/\s*aaaa/i.test(hint)) return 'dd/mm/yyyy';
	return 'dd/mm/yyyy';
}

function isDateWidget(widget) {
	if (!widget || widget.fieldType !== 'Tx' || widget.multiLine || widget.password) return false;
	if (widget.datetimeType === 'date' || widget.datetimeType === 'datetime-local') return true;
	if (dateActionScripts(widget).some((script) => /AFDate_/i.test(script))) return true;
	const hint = `${widget.alternativeText || ''} ${widget.fieldName || ''}`;
	if (/jj\s*\/\s*mm\s*\/\s*aaaa|dd\s*\/\s*mm\s*\/\s*yyyy/i.test(hint)) return true;
	return /^date([_-]|$)/i.test(widget.fieldName || '');
}

function dateToIso(value, format) {
	const raw = String(value || '').trim();
	if (!raw) return '';
	if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
	const nums = raw.match(/\d{1,4}/g);
	if (!nums || nums.length < 3) return '';
	const pattern = String(format || 'dd/mm/yyyy').toLowerCase();
	let day;
	let month;
	let year;
	if (pattern.startsWith('yyyy')) {
		[year, month, day] = nums;
	} else if (pattern.startsWith('mm')) {
		[month, day, year] = nums;
	} else {
		[day, month, year] = nums;
	}
	if (String(year).length === 2) year = Number(year) >= 50 ? `19${year}` : `20${year}`;
	const yyyy = String(year).padStart(4, '0');
	const mm = String(month).padStart(2, '0');
	const dd = String(day).padStart(2, '0');
	if (Number(mm) < 1 || Number(mm) > 12 || Number(dd) < 1 || Number(dd) > 31) return '';
	return `${yyyy}-${mm}-${dd}`;
}

function dateDigits(raw) {
	return String(raw || '').replace(/\D/g, '').slice(0, 8);
}

function maskDateInput(raw) {
	const digits = dateDigits(raw);
	if (!digits.length) return '';
	const day = digits.slice(0, 2);
	const month = digits.slice(2, 4);
	const year = digits.slice(4, 8);
	let out = day;
	if (digits.length >= 2) out += '/';
	if (digits.length > 2) out += month;
	if (digits.length >= 4) out += '/';
	if (digits.length > 4) out += year;
	return out;
}

function dateStorageValue(masked) {
	const trimmed = String(masked || '').replace(/\/+$/, '');
	return !trimmed || trimmed === '/' ? '' : trimmed;
}

function dateGuideOf(format) {
	return String(format || 'dd/mm/yyyy').toLowerCase() === 'dd/mm/yyyy' ? 'jj/mm/aaaa' : format;
}

function syncDateGuide(guide, value, format) {
	if (!guide) return;
	const template = dateGuideOf(format);
	const filled = String(value || '');
	guide.replaceChildren();
	if (filled) {
		const hide = document.createElement('span');
		hide.className = 'form-date-guide-filled';
		hide.textContent = filled;
		guide.append(hide);
	}
	const rest = document.createElement('span');
	rest.textContent = template.slice(filled.length);
	guide.append(rest);
}

function caretPosAfterDateDigits(formatted, count) {
	if (count <= 0) return 0;
	let seen = 0;
	for (let i = 0; i < formatted.length; i += 1) {
		if (formatted[i] < '0' || formatted[i] > '9') continue;
		seen += 1;
		if (seen < count) continue;
		let pos = i + 1;
		while (pos < formatted.length && formatted[pos] === '/') pos += 1;
		return pos;
	}
	return formatted.length;
}

function applyDateMask(input, raw) {
	const sel = input.selectionStart ?? String(raw || '').length;
	const digitsBefore = dateDigits(String(raw || '').slice(0, sel)).length;
	const next = maskDateInput(raw);
	input.value = next;
	const pos = caretPosAfterDateDigits(next, digitsBefore);
	try {
		input.setSelectionRange(pos, pos);
	} catch (_err) {
		/* WKWebView : selectionRange parfois refusé hors focus */
	}
	return next;
}

function isoToDate(iso, format) {
	if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
	const [yyyy, mm, dd] = iso.split('-');
	return String(format || 'dd/mm/yyyy')
		.replace(/yyyy/gi, yyyy)
		.replace(/yy/gi, yyyy.slice(2))
		.replace(/mm/gi, mm)
		.replace(/dd/gi, dd);
}

async function pageWidgetAnnotations(page) {
	const annotations = await page.getAnnotations({ intent: 'display' });
	return annotations.filter(isFormWidget);
}

function formStorage() {
	return state.pdf?.annotationStorage || null;
}

// Réinjecte le miroir de l'onglet dans le storage du document courant (après
// un rechargement, le storage repart vide alors que la saisie doit survivre).
function seedFormStorage() {
	const storage = formStorage();
	const tab = currentTab();
	if (!storage || !tab?.formValues) return;
	for (const [id, value] of Object.entries(tab.formValues)) {
		if (storage.getRawValue(id) === undefined) storage.setValue(id, { value });
	}
}

function syncFormMirrorFromStorage() {
	const storage = formStorage();
	const tab = currentTab();
	if (!storage || !tab) return;
	// `serializable.map` : seule vue itérable du storage (id → { value }).
	const entries = storage.size ? storage.serializable?.map : null;
	if (!entries) return;
	tab.formValues = tab.formValues || {};
	for (const [id, entry] of entries) {
		if (entry && typeof entry === 'object' && 'value' in entry) tab.formValues[id] = entry.value;
	}
}

async function renderFormLayer(page, viewport, data) {
	const container = data.formLayer;
	if (!container || !state.pdf) return;
	container.replaceChildren();
	container.style.setProperty('--scale-factor', String(viewport.scale));
	container.style.setProperty('--total-scale-factor', String(viewport.scale));
	container.style.width = `${Math.floor(viewport.width)}px`;
	container.style.height = `${Math.floor(viewport.height)}px`;
	const widgets = await pageWidgetAnnotations(page);
	if (!widgets.length) {
		container.classList.add('hidden');
		return;
	}
	container.classList.remove('hidden');
	seedFormStorage();
	const storage = state.pdf.annotationStorage;
	const layerViewport = viewport.clone({ dontFlip: true });
	const layer = new pdfjsLib.AnnotationLayer({
		div: container,
		page,
		viewport: layerViewport,
		annotationStorage: storage,
		linkService: formLinkService
	});
	await layer.render({
		annotations: widgets,
		renderForms: true,
		linkService: formLinkService,
		annotationStorage: storage,
		enableScripting: false
	});
	data.formLayerInstance = layer;
	bindFormLayer(container, widgets, layerViewport);
}

function bindFormLayer(container, widgets, viewport) {
	if (!container.dataset.formBound) {
		container.dataset.formBound = '1';
		const onEdit = () => {
			syncFormMirrorFromStorage();
			markDirty();
			scheduleFormBake();
			refreshFormsPanelValues();
		};
		container.addEventListener('input', onEdit);
		container.addEventListener('change', onEdit);
	}
	for (const widget of widgets) {
		if (isDateWidget(widget)) {
			bindDateWidget(container, widget);
			continue;
		}
		if (isImageButtonWidget(widget)) {
			const section = container.querySelector(`[data-annotation-id="${widget.id}"]`);
			if (!section) continue;
			section.classList.add('form-image-button');
			section.title =
				widget.alternativeText ||
				(currentLocale() === 'fr' ? 'Cliquer pour choisir une image' : 'Click to choose an image');
			section.addEventListener(
				'click',
				(event) => {
					event.preventDefault();
					event.stopPropagation();
					void handleFormImageButton(widget.fieldName);
				},
				true
			);
			continue;
		}
		if (!isSignatureWidget(widget) || !widget.fieldName) continue;
		const section = ensureSignatureHitTarget(container, widget, viewport);
		if (section.dataset.sigBound === '1') continue;
		section.dataset.sigBound = '1';
		const openSign = (event) => {
			event.preventDefault();
			event.stopPropagation();
			void handleFormSignatureField(widget.fieldName);
		};
		// pointerdown : WKWebView avale parfois le click sur une section sans input.
		section.addEventListener('pointerdown', openSign, true);
	}
}

// Même repère que PDF.js `_createContainer` : Y PDF inversé, pourcentages de
// la page. Un convertToViewportRectangle(dontFlip) plaquerait la cible en haut
// alors que la pastille /Sig est peinte en bas (noHTML : pas de section native).
function positionSignatureHitTarget(section, widget, viewport) {
	const rect = widget?.rect;
	const dims = viewport?.rawDims;
	if (!rect || rect.length < 4 || !dims) return;
	const { pageWidth, pageHeight, pageX, pageY } = dims;
	if (!pageWidth || !pageHeight) return;
	const viewBottom = pageY + pageHeight;
	const flipped0 = viewBottom - rect[1] + pageY;
	const flipped1 = viewBottom - rect[3] + pageY;
	let left = Math.min(rect[0], rect[2]);
	let right = Math.max(rect[0], rect[2]);
	let top = Math.min(flipped0, flipped1);
	let bottom = Math.max(flipped0, flipped1);
	// Pastille trop petite : on grandit vers le haut / les côtés, sans sortir
	// de la page (le champ nom est ~19 pt au-dessus sur l'attestation).
	const minH = 28;
	if (bottom - top < minH) top = Math.max(pageY, bottom - minH);
	const minW = 48;
	if (right - left < minW) {
		const extra = (minW - (right - left)) / 2;
		left = Math.max(pageX, left - extra);
		right = Math.min(pageX + pageWidth, right + extra);
	}
	section.style.left = `${(100 * (left - pageX)) / pageWidth}%`;
	section.style.top = `${(100 * (top - pageY)) / pageHeight}%`;
	section.style.width = `${(100 * (right - left)) / pageWidth}%`;
	section.style.height = `${(100 * (bottom - top)) / pageHeight}%`;
}

function ensureSignatureHitTarget(container, widget, viewport) {
	let section = container.querySelector(`[data-annotation-id="${widget.id}"]`);
	if (!section) {
		section = document.createElement('section');
		section.dataset.annotationId = widget.id;
		container.append(section);
	}
	section.classList.add('form-signature-field');
	section.title =
		widget.alternativeText ||
		(currentLocale() === 'fr' ? 'Cliquer pour signer' : 'Click to sign');
	positionSignatureHitTarget(section, widget, viewport);
	return section;
}

let _dateCal = {
	input: null,
	section: null,
	format: 'dd/mm/yyyy',
	commit: null,
	view: new Date()
};

function parseIsoDate(iso) {
	if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
	const [year, month, day] = iso.split('-').map(Number);
	const date = new Date(year, month - 1, day);
	if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
		return null;
	}
	return date;
}

function toIsoDate(date) {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

function dateCalendarRoot() {
	let el = document.getElementById('form-date-calendar');
	if (el) return el;
	el = document.createElement('div');
	el.id = 'form-date-calendar';
	el.className = 'form-date-calendar';
	el.hidden = true;
	el.setAttribute('role', 'dialog');
	el.addEventListener('mousedown', (event) => {
		event.preventDefault();
	});
	document.body.append(el);
	bindDateCalendarChrome();
	return el;
}

function dateCalendarIsOpen() {
	const el = document.getElementById('form-date-calendar');
	return Boolean(el && !el.hidden);
}

function bindDateCalendarChrome() {
	if (document.documentElement.dataset.dateCalBound) return;
	document.documentElement.dataset.dateCalBound = '1';
	document.addEventListener(
		'pointerdown',
		(event) => {
			if (!dateCalendarIsOpen()) return;
			const target = event.target;
			if (!(target instanceof Element)) {
				closeDateCalendar();
				return;
			}
			if (target.closest('#form-date-calendar, .form-date-field')) return;
			closeDateCalendar();
		},
		true
	);
	const reposition = () => {
		if (dateCalendarIsOpen()) positionDateCalendar(_dateCal.section);
	};
	window.addEventListener('resize', reposition);
	document.addEventListener('scroll', reposition, true);
	document.addEventListener('keydown', (event) => {
		if (event.key === 'Escape' && dateCalendarIsOpen()) closeDateCalendar();
	});
}

function closeDateCalendar() {
	const el = document.getElementById('form-date-calendar');
	if (el) el.hidden = true;
	_dateCal.input = null;
	_dateCal.section = null;
	_dateCal.commit = null;
}

function positionDateCalendar(anchor) {
	const el = dateCalendarRoot();
	if (!anchor?.isConnected) {
		closeDateCalendar();
		return;
	}
	const rect = anchor.getBoundingClientRect();
	const calW = el.offsetWidth || 268;
	const calH = el.offsetHeight || 292;
	let left = rect.right + 8;
	let top = rect.top;
	if (left + calW > window.innerWidth - 8) left = Math.max(8, rect.left - calW - 8);
	if (top + calH > window.innerHeight - 8) top = Math.max(8, window.innerHeight - calH - 8);
	if (top < 8) top = 8;
	el.style.left = `${Math.round(left)}px`;
	el.style.top = `${Math.round(top)}px`;
}

function dateWeekdayLabels(weekStartsOn) {
	const locale = currentLocale() === 'fr' ? 'fr-FR' : 'en-US';
	const labels = [];
	for (let i = 0; i < 7; i += 1) {
		const day = new Date(2024, 0, 1 + i);
		labels.push(new Intl.DateTimeFormat(locale, { weekday: 'narrow' }).format(day));
	}
	if (weekStartsOn === 0) return [labels[6], ...labels.slice(0, 6)];
	return labels;
}

function renderDateCalendar() {
	const el = dateCalendarRoot();
	const view = _dateCal.view instanceof Date ? _dateCal.view : new Date();
	const year = view.getFullYear();
	const month = view.getMonth();
	const locale = currentLocale() === 'fr' ? 'fr-FR' : 'en-US';
	const weekStartsOn = currentLocale() === 'fr' ? 1 : 0;
	const selectedIso = dateToIso(_dateCal.input?.value || '', _dateCal.format);
	const todayIso = toIsoDate(new Date());
	const title = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(
		new Date(year, month, 1)
	);

	const header = document.createElement('div');
	header.className = 'form-date-calendar-header';
	const prev = document.createElement('button');
	prev.type = 'button';
	prev.className = 'form-date-calendar-nav';
	prev.setAttribute('aria-label', currentLocale() === 'fr' ? 'Mois précédent' : 'Previous month');
	prev.textContent = '‹';
	prev.addEventListener('click', () => {
		_dateCal.view = new Date(year, month - 1, 1);
		renderDateCalendar();
		positionDateCalendar(_dateCal.section);
	});
	const label = document.createElement('p');
	label.className = 'form-date-calendar-title';
	label.textContent = title;
	const next = document.createElement('button');
	next.type = 'button';
	next.className = 'form-date-calendar-nav';
	next.setAttribute('aria-label', currentLocale() === 'fr' ? 'Mois suivant' : 'Next month');
	next.textContent = '›';
	next.addEventListener('click', () => {
		_dateCal.view = new Date(year, month + 1, 1);
		renderDateCalendar();
		positionDateCalendar(_dateCal.section);
	});
	header.append(prev, label, next);

	const week = document.createElement('div');
	week.className = 'form-date-calendar-week';
	for (const name of dateWeekdayLabels(weekStartsOn)) {
		const cell = document.createElement('span');
		cell.textContent = name;
		week.append(cell);
	}

	const grid = document.createElement('div');
	grid.className = 'form-date-calendar-grid';
	const first = new Date(year, month, 1);
	const startPad = (first.getDay() - weekStartsOn + 7) % 7;
	const daysInMonth = new Date(year, month + 1, 0).getDate();
	for (let i = 0; i < startPad; i += 1) {
		const empty = document.createElement('span');
		empty.className = 'form-date-calendar-day is-empty';
		grid.append(empty);
	}
	for (let day = 1; day <= daysInMonth; day += 1) {
		const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'form-date-calendar-day';
		button.textContent = String(day);
		if (iso === todayIso) button.classList.add('is-today');
		if (iso === selectedIso) button.classList.add('is-selected');
		button.addEventListener('click', () => {
			_dateCal.view = new Date(year, month, day);
			_dateCal.commit?.(iso);
			renderDateCalendar();
			positionDateCalendar(_dateCal.section);
		});
		grid.append(button);
	}

	el.replaceChildren(header, week, grid);
	el.hidden = false;
}

function openDateCalendar(input, section, { format, commit }) {
	const selected = parseIsoDate(dateToIso(input.value, format));
	_dateCal.input = input;
	_dateCal.section = section;
	_dateCal.format = format;
	_dateCal.commit = commit;
	_dateCal.view = selected || new Date();
	renderDateCalendar();
	positionDateCalendar(section);
}

function bindDateWidget(container, widget) {
	const section = container.querySelector(`[data-annotation-id="${widget.id}"]`);
	const input = section?.querySelector('input:not(.form-date-picker)');
	if (!input) return;
	const format = dateFormatOf(widget);
	const stored = formStorage()?.getRawValue(widget.id)?.value ?? widget.fieldValue ?? input.value;
	const formatted =
		isoToDate(dateToIso(String(stored ?? ''), format), format) || maskDateInput(stored) || '';
	section.classList.add('form-date-field');
	section.querySelector('input.form-date-picker')?.remove();
	let guide = section.querySelector('.form-date-guide');
	if (!guide) {
		guide = document.createElement('span');
		guide.className = 'form-date-guide';
		guide.setAttribute('aria-hidden', 'true');
		input.parentNode.insertBefore(guide, input);
	}
	input.type = 'text';
	input.classList.add('form-date-input');
	input.value = formatted;
	input.title = widget.alternativeText || dateGuideOf(format);
	input.autocomplete = 'off';
	input.inputMode = 'numeric';
	input.placeholder = '';
	syncDateGuide(guide, formatted, format);
	requestAnimationFrame(() => {
		const style = getComputedStyle(input);
		guide.style.font = style.font;
		guide.style.fontSize = style.fontSize;
		guide.style.fontFamily = style.fontFamily;
		guide.style.letterSpacing = style.letterSpacing;
		guide.style.padding = style.padding;
		guide.style.textAlign = style.textAlign;
	});
	if (input.disabled || widget.readOnly) return;

	const persist = (masked) => {
		const iso = dateToIso(masked, format);
		const storedValue = iso ? isoToDate(iso, format) : dateStorageValue(masked);
		formStorage()?.setValue(widget.id, { value: storedValue });
		syncDateGuide(guide, masked, format);
		if (_dateCal.input === input && iso) {
			const parsed = parseIsoDate(iso);
			if (parsed && dateCalendarIsOpen()) {
				_dateCal.view = parsed;
				renderDateCalendar();
				positionDateCalendar(section);
			}
		}
	};
	const commit = (iso) => {
		const next = isoToDate(iso, format);
		input.value = next;
		try {
			input.setSelectionRange(next.length, next.length);
		} catch (_err) {
			/* ignore */
		}
		formStorage()?.setValue(widget.id, { value: next });
		syncDateGuide(guide, next, format);
		input.dispatchEvent(new Event('input', { bubbles: true }));
	};
	const open = () => {
		openDateCalendar(input, section, { format, commit });
	};

	input.addEventListener('focus', open);
	input.addEventListener('click', open);
	input.addEventListener('input', () => {
		const next = applyDateMask(input, input.value);
		persist(next);
	});
	input.addEventListener('keydown', (event) => {
		if (event.key !== 'Backspace') return;
		const start = input.selectionStart ?? 0;
		const end = input.selectionEnd ?? 0;
		if (start !== end || start === 0 || input.value[start - 1] !== '/') return;
		event.preventDefault();
		const digits = dateDigits(input.value);
		const before = dateDigits(input.value.slice(0, start)).length;
		const nextDigits = digits.slice(0, Math.max(0, before - 1)) + digits.slice(before);
		const next = maskDateInput(nextDigits);
		input.value = next;
		const pos = caretPosAfterDateDigits(next, Math.max(0, before - 1));
		try {
			input.setSelectionRange(pos, pos);
		} catch (_err) {
			/* ignore */
		}
		persist(next);
		input.dispatchEvent(new Event('input', { bubbles: true }));
	});
	input.addEventListener('change', () => {
		const iso = dateToIso(input.value, format);
		if (iso) commit(iso);
		else persist(maskDateInput(input.value));
	});
}

function scheduleFormBake() {
	window.clearTimeout(_formBakeTimer);
	_formBakeTimer = window.setTimeout(() => {
		_formBakeTimer = null;
		void bakeFormValues();
	}, FORM_BAKE_DELAY_MS);
}

// Écrit la saisie du formulaire dans state.fileBytes (PDF.js génère /V et les
// apparences). Idempotent : peut être rappelé avant tout usage des octets.
async function bakeFormValues() {
	window.clearTimeout(_formBakeTimer);
	_formBakeTimer = null;
	if (_formBakePromise) return _formBakePromise;
	const pdf = state.pdf;
	const tab = currentTab();
	if (!pdf || !tab) return false;
	seedFormStorage();
	syncFormMirrorFromStorage();
	if (!pdf.annotationStorage.size) return false;
	_formBakePromise = (async () => {
		try {
			const saved = await pdf.saveDocument();
			let bytes = saved instanceof Uint8Array ? saved : new Uint8Array(saved);
			if (window.__TAURI__) {
				// PDF.js encadre les champs remplis : on restaure les bordures
				// « soulignées » du formulaire (sinon boîtes à l'impression).
				try {
					bytes = new Uint8Array(
						await invokeBytes('normalize_form_appearances', { bytes: Array.from(bytes) })
					);
				} catch (error) {
					console.warn('Form appearance normalisation skipped.', error);
				}
				try {
					bytes = await reapplyFormImages(tab, bytes);
				} catch (error) {
					console.warn('Form image reapply skipped.', error);
				}
			}
			if (state.pdf !== pdf || currentTab() !== tab) return false;
			state.fileBytes = bytes;
			tab.fileBytes = bytes;
			return true;
		} catch (error) {
			console.warn('Form values could not be written into the document.', error);
			return false;
		} finally {
			_formBakePromise = null;
		}
	})();
	return _formBakePromise;
}

// Remplace le document courant par de nouveaux octets (même onglet) et
// re-rend les pages. Les valeurs de formulaire sont ré-ensemencées depuis le
// miroir au prochain rendu de la couche.
async function replaceCurrentDocumentBytes(bytes) {
	const tab = currentTab();
	const normalized = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	const loadingTask = pdfjsLib.getDocument(pdfDocumentOptions({ data: normalized.slice() }));
	const pdf = await loadingTask.promise;
	state.fileBytes = normalized;
	state.pdf = pdf;
	if (tab) {
		tab.fileBytes = normalized;
		tab.pdf = pdf;
	}
	try {
		await invokeCommand('cache_document', { id: currentDocId(), bytes: Array.from(normalized) });
	} catch (_err) {
		// Cache natif indisponible : il se re-primera à la prochaine analyse.
	}
	invalidateAllPages();
	await renderCurrentPage();
	void renderPagesAround(state.page, 1);
}

// Octets de référence avant une opération de structure (rotation, ordre,
// suppression) : on y intègre d'abord les éditions natives en attente et les
// valeurs de formulaire, sinon elles seraient perdues par le remplacement.
async function structureOpSourceBytes() {
	if (state.nativeTextDirty) await syncNativeDocumentBytes({ render: false });
	await bakeFormValues();
	return Array.from(state.fileBytes);
}

// Fait suivre à une page qu'on vient de tourner le contenu posé dessus par
// l'utilisateur (zones de texte, masquages, signatures) : le centre de chaque
// élément tourne avec la page, sa taille est conservée, son angle propre cumule
// celui de la page. Les blocs simplement détectés (texte natif intact) sont
// abandonnés : ils seront re-détectés sur la page tournée, avec les bonnes
// coordonnées PDF. `aspect` = largeur/hauteur de la page AVANT rotation.
function rotatePageOverlays(pageNumber, angle, aspect) {
	const turn = ((angle % 360) + 360) % 360;
	if (!turn) return;
	const swapsAxes = turn === 90 || turn === 270;
	// Centre en fractions de la page d'origine → fractions de la page tournée.
	const rotateCenter = (cx, cy) => {
		if (turn === 90) return [1 - cy, cx];
		if (turn === 180) return [1 - cx, 1 - cy];
		return [cy, 1 - cx];
	};

	state.editBlocks = state.editBlocks.flatMap((block) => {
		if (block.page !== pageNumber) return [block];
		if (!isPersistedPageContent(block)) return [];
		const width = block.pageWidth;
		const height = block.pageHeight;
		if (!width || !height) return [block];
		const [cx, cy] = rotateCenter(
			(block.x + block.width / 2) / width,
			(block.y + block.height / 2) / height
		);
		const pageWidth = swapsAxes ? height : width;
		const pageHeight = swapsAxes ? width : height;
		return [
			{
				...block,
				pageWidth,
				pageHeight,
				x: cx * pageWidth - block.width / 2,
				y: cy * pageHeight - block.height / 2,
				rotation: ((block.rotation || 0) + turn) % 360
			}
		];
	});

	state.signaturePlacements = state.signaturePlacements.map((placement) => {
		if (placement.page !== pageNumber) return placement;
		const [cx, cy] = rotateCenter(
			placement.xFrac + placement.wFrac / 2,
			placement.yFrac + placement.hFrac / 2
		);
		// Les fractions se réfèrent aux dimensions de la page : si les axes
		// permutent, une largeur en fraction de W devient une fraction de H.
		const wFrac = swapsAxes ? placement.wFrac * aspect : placement.wFrac;
		const hFrac = swapsAxes ? placement.hFrac / aspect : placement.hFrac;
		return {
			...placement,
			wFrac,
			hFrac,
			xFrac: cx - wFrac / 2,
			yFrac: cy - hFrac / 2,
			rotation: ((placement.rotation || 0) + turn) % 360
		};
	});
}

// Remplace le document de l'onglet courant après une opération de structure.
// Contrairement à openPdfFromBytes, on reste dans le MÊME onglet : même nom,
// même chemin disque, marqué modifié → ⌘S écrase le fichier d'origine (Aperçu).
// `mapPage(ancienne) → nouvelle | null` fait suivre blocs, notes et signatures
// à leur page (null = page supprimée : l'élément disparaît avec elle).
// lopdf conserve le /ID du PDF, donc le fingerprint ne change pas : le cache
// PDFium natif et les miniatures répondraient avec l'ANCIEN document si on ne
// les re-primait pas explicitement ici.
async function replaceDocumentStructure(bytes, { focusPage, mapPage, rotated } = {}) {
	const tab = currentTab();
	if (!tab) return;
	const normalized = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	const loadingTask = pdfjsLib.getDocument(pdfDocumentOptions({ data: normalized }));
	const pdf = await loadingTask.promise;
	// Rotation : la pagination est inchangée, on re-rend la seule page tournée
	// à sa place (sans remonter la pile → ni défilement, ni pages blanches).
	const inPlacePage =
		rotated && state.pdf && pdf.numPages === state.pdf.numPages && getPageData(rotated.page)
			? rotated.page
			: null;
	const remap = typeof mapPage === 'function' ? mapPage : (page) => page;
	const followPages = (items) =>
		items.flatMap((item) => {
			const page = remap(item.page);
			return page ? [{ ...item, page }] : [];
		});

	if (rotated && state.pdf) {
		const before = (await state.pdf.getPage(rotated.page)).getViewport({ scale: 1 });
		rotatePageOverlays(rotated.page, rotated.angle, before.width / before.height);
	}
	state.fileBytes = normalized;
	state.pdf = pdf;
	state.editBlocks = followPages(state.editBlocks);
	state.annotations = followPages(state.annotations);
	state.signaturePlacements = followPages(state.signaturePlacements);
	state.selectedBlockId = null;
	state.selectedBlockIds = [];
	state.selectedSignatureId = null;
	state.nativeTextDirty = false;
	nativeEditedPagesSet().clear();
	tab.fileBytes = normalized;
	tab.pdf = pdf;
	// L'historique référence l'ancienne structure de pages : il n'est plus rejouable.
	tab.undoStack = [];
	tab.redoStack = [];
	updateUndoRedoButtons();

	try {
		await invokeCommand('cache_document', { id: currentDocId(), bytes: Array.from(normalized) });
	} catch (_err) {
		// Fenêtre sans natif : le cache se re-primera au prochain cache_miss.
	}

	if (inPlacePage) {
		_thumbnailCache.delete(`${state.fingerprint || 'unknown'}:${inPlacePage}`);
		await rerenderPageQuietly(inPlacePage);
		void rebindRenderedFormLayers(inPlacePage);
		markDirty();
		// La vignette est rafraîchie par l'appelant (handleRotatePage), qui seul
		// sait quel quart de tour elle doit cesser de simuler.
		return;
	}

	_thumbnailCache.clear();
	state.page = Math.min(Math.max(1, Number(focusPage) || state.page), pdf.numPages);
	await mountPagesStack();
	goToPage(state.page);
	markDirty();
	refreshPagesDrawerIfOpen();
}

async function reapplyFormImages(tab, bytes) {
	if (!window.__TAURI__ || !tab?.formImages) return bytes;
	let out = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	for (const [fieldName, image] of Object.entries(tab.formImages)) {
		if (!image?.length) continue;
		const raw = image instanceof Uint8Array ? image : new Uint8Array(image);
		out = new Uint8Array(
			await invokeBytes('set_form_button_image', {
				bytes: Array.from(out),
				fieldName,
				image: Array.from(raw)
			})
		);
	}
	return out;
}

async function handleFormImageButton(fieldName) {
	if (!state.pdf || !fieldName) return;
	try {
		const images = await invokeCommand('pick_images');
		if (!images || !images.length) return;
		setStatus(currentLocale() === 'fr' ? 'Insertion de l’image…' : 'Inserting image…');
		if (state.nativeTextDirty) await syncNativeDocumentBytes({ render: false });
		const tab = currentTab();
		if (tab) {
			tab.formImages = tab.formImages || {};
			tab.formImages[fieldName] = new Uint8Array(images[0]);
		}
		await bakeFormValues();
		const updated = await invokeBytes('set_form_button_image', {
			bytes: Array.from(state.fileBytes),
			fieldName,
			image: Array.from(new Uint8Array(images[0]))
		});
		await replaceCurrentDocumentBytes(updated);
		markDirty();
		refreshFormsPanelValues();
		setStatus(currentLocale() === 'fr' ? 'Image insérée.' : 'Image inserted.');
	} catch (error) {
		setStatus(error instanceof Error ? error.message : String(error), 'error');
	}
}

let _pendingFormSignatureField = null;

function dataUrlToBytes(dataUrl) {
	const comma = String(dataUrl || '').indexOf(',');
	if (comma < 0) return new Uint8Array();
	const binary = atob(dataUrl.slice(comma + 1));
	const out = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
	return out;
}

function handleFormSignatureField(fieldName) {
	if (!state.pdf || !fieldName) return;
	_pendingFormSignatureField = fieldName;
	openDrawer('sign');
	const hasSaved = loadSavedSignatures().some((item) => signatureKind(item) === 'signature');
	if (!hasSaved) openSignatureModal('signature');
	setStatus(
		currentLocale() === 'fr'
			? 'Choisis une signature ou crées-en une.'
			: 'Choose a signature or create one.'
	);
}

async function applyFormSignature(sig) {
	const fieldName = _pendingFormSignatureField;
	_pendingFormSignatureField = null;
	if (!state.pdf || !fieldName || !sig?.dataUrl) return;
	try {
		const image = dataUrlToBytes(sig.dataUrl);
		if (!image.length) return;
		setStatus(currentLocale() === 'fr' ? 'Signature en cours…' : 'Signing…');
		if (state.nativeTextDirty) await syncNativeDocumentBytes({ render: false });
		const tab = currentTab();
		if (tab) {
			tab.formImages = tab.formImages || {};
			tab.formImages[fieldName] = image;
		}
		await bakeFormValues();
		const updated = await invokeBytes('set_form_button_image', {
			bytes: Array.from(state.fileBytes),
			fieldName,
			image: Array.from(image)
		});
		await replaceCurrentDocumentBytes(updated);
		markDirty();
		refreshFormsPanelValues();
		setStatus(currentLocale() === 'fr' ? 'Signature apposée.' : 'Signature applied.');
	} catch (error) {
		setStatus(error instanceof Error ? error.message : String(error), 'error');
	}
}

// Champs du document regroupés par nom (un champ = un ou plusieurs widgets).
async function collectFormFields() {
	if (!state.pdf) return [];
	const byName = new Map();
	for (let pageNumber = 1; pageNumber <= state.pdf.numPages; pageNumber += 1) {
		const page = await state.pdf.getPage(pageNumber);
		for (const widget of await pageWidgetAnnotations(page)) {
			if (!widget.fieldName) continue;
			let kind = null;
			if (widget.fieldType === 'Tx') {
				if (isDateWidget(widget)) kind = 'date';
				else kind = widget.multiLine ? 'textarea' : 'text';
			}
			else if (widget.fieldType === 'Ch') kind = 'choice';
			else if (widget.fieldType === 'Sig') kind = 'signature';
			else if (widget.fieldType === 'Btn') {
				if (widget.checkBox) kind = 'checkbox';
				else if (widget.radioButton) kind = 'radio';
				else if (isImageButtonWidget(widget)) kind = 'image';
			}
			if (!kind) continue;
			let field = byName.get(widget.fieldName);
			if (!field) {
				field = {
					name: widget.fieldName,
					kind,
					page: pageNumber,
					readOnly: Boolean(widget.readOnly),
					widgets: [],
					options: Array.isArray(widget.options) ? widget.options : [],
					dateFormat: kind === 'date' ? dateFormatOf(widget) : null
				};
				byName.set(widget.fieldName, field);
			}
			field.widgets.push(widget);
		}
	}
	return [...byName.values()];
}

function formFieldValue(field) {
	const storage = formStorage();
	const first = field.widgets[0];
	if (field.kind === 'checkbox') {
		const stored = storage?.getRawValue(first.id);
		if (stored && typeof stored.value === 'boolean') return stored.value;
		return first.fieldValue === first.exportValue;
	}
	if (field.kind === 'radio') {
		for (const widget of field.widgets) {
			const stored = storage?.getRawValue(widget.id);
			if (stored?.value === true) return widget.buttonValue;
		}
		const checked = field.widgets.find((widget) => widget.fieldValue === widget.buttonValue);
		return checked ? checked.buttonValue : '';
	}
	const stored = storage?.getRawValue(first.id);
	if (stored && 'value' in stored && stored.value != null) return stored.value;
	return first.fieldValue ?? '';
}

// Saisie depuis le panneau : on écrit dans le storage ET dans les widgets HTML
// déjà rendus, puis on cuit comme pour une saisie sur la page.
function setFormFieldValue(field, value) {
	const storage = formStorage();
	if (!storage) return;
	for (const widget of field.widgets) {
		let widgetValue = value;
		if (field.kind === 'radio') widgetValue = widget.buttonValue === value;
		storage.setValue(widget.id, { value: widgetValue });
		for (const data of state.pageElements.values()) {
			const section = data.formLayer?.querySelector(`[data-annotation-id="${widget.id}"]`);
			const control = section?.querySelector('input, textarea, select');
			if (!control) continue;
			if (control.type === 'checkbox' || control.type === 'radio') control.checked = Boolean(widgetValue);
			else control.value = String(value ?? '');
		}
	}
	syncFormMirrorFromStorage();
	markDirty();
	scheduleFormBake();
}

function refreshFormsPanelValues() {
	const rows = elements.formsFields?.querySelectorAll('.forms-field');
	if (!rows?.length || !_formsPanelFields) return;
	for (const row of rows) {
		const field = _formsPanelFields.get(row.dataset.name);
		if (!field) continue;
		const control = row.querySelector('.forms-field-input, .forms-field-checkbox');
		if (!control || control === document.activeElement) continue;
		const value = formFieldValue(field);
		if (control.type === 'checkbox') control.checked = Boolean(value);
		else if (control.type === 'date') control.value = dateToIso(String(value ?? ''), field.dateFormat);
		else control.value = String(value ?? '');
	}
}

async function renderOfficialTextLayer(page, viewport, data) {
	const container = data.textLayer;
	if (!container) return;

	unbindTextLayerSelection(container);

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

	// setLayerDimensions pose width/height mais PAS le scale : sans ces variables,
	// font-size du textLayer reste à 1× et la sélection se décale du canvas.
	const scale = String(viewport.scale);
	container.style.setProperty('--scale-factor', scale);
	container.style.setProperty('--total-scale-factor', scale);
	data.wrapper?.style.setProperty('--scale-factor', scale);
	data.wrapper?.style.setProperty('--total-scale-factor', scale);
	if (typeof pdfjsLib.setLayerDimensions === 'function') {
		pdfjsLib.setLayerDimensions(container, viewport);
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

	let endOfContent = container.querySelector('.endOfContent');
	if (!endOfContent) {
		endOfContent = document.createElement('div');
		endOfContent.className = 'endOfContent';
		container.append(endOfContent);
	}
	// Obligatoire : sans les handlers du TextLayerBuilder pdf.js, Chrome
	// sélectionne en ordre DOM et ramasse toutes les lignes au-dessus.
	bindTextLayerSelection(container, endOfContent);

	if (state.search.query) {
		applySearchHighlightsToPage(data.pageNumber);
	}
}

// ── Sélection textLayer (port minimal de pdf.js TextLayerBuilder.#bindMouse) ──
const _textLayerSelectionMap = new Map();
let _textLayerSelectionAbort = null;
let _textLayerSelectionPrevRange = null;
let _textLayerPointerDown = false;
let _textLayerIsFirefox = null;

function resetTextLayerEndOfContent(end, textLayer) {
	if (!end || !textLayer) return;
	textLayer.append(end);
	end.style.width = '';
	end.style.height = '';
	end.style.userSelect = '';
	textLayer.classList.remove('selecting');
}

function enableTextLayerSelectionListener() {
	if (_textLayerSelectionAbort) return;
	_textLayerSelectionAbort = new AbortController();
	const { signal } = _textLayerSelectionAbort;

	document.addEventListener(
		'pointerdown',
		() => {
			_textLayerPointerDown = true;
		},
		{ signal }
	);
	document.addEventListener(
		'pointerup',
		() => {
			_textLayerPointerDown = false;
			_textLayerSelectionMap.forEach(resetTextLayerEndOfContent);
		},
		{ signal }
	);
	window.addEventListener(
		'blur',
		() => {
			_textLayerPointerDown = false;
			_textLayerSelectionMap.forEach(resetTextLayerEndOfContent);
		},
		{ signal }
	);
	document.addEventListener(
		'keyup',
		() => {
			if (!_textLayerPointerDown) {
				_textLayerSelectionMap.forEach(resetTextLayerEndOfContent);
			}
		},
		{ signal }
	);

	document.addEventListener(
		'selectionchange',
		() => {
			const selection = document.getSelection();
			if (!selection || selection.rangeCount === 0) {
				_textLayerSelectionMap.forEach(resetTextLayerEndOfContent);
				_textLayerSelectionPrevRange = null;
				return;
			}

			const activeLayers = new Set();
			for (let i = 0; i < selection.rangeCount; i += 1) {
				const range = selection.getRangeAt(i);
				for (const textLayerDiv of _textLayerSelectionMap.keys()) {
					if (!activeLayers.has(textLayerDiv) && range.intersectsNode(textLayerDiv)) {
						activeLayers.add(textLayerDiv);
					}
				}
			}

			for (const [textLayerDiv, endDiv] of _textLayerSelectionMap) {
				if (activeLayers.has(textLayerDiv)) {
					textLayerDiv.classList.add('selecting');
				} else {
					resetTextLayerEndOfContent(endDiv, textLayerDiv);
				}
			}

			if (_textLayerIsFirefox == null && _textLayerSelectionMap.size) {
				const sample = _textLayerSelectionMap.values().next().value;
				_textLayerIsFirefox =
					getComputedStyle(sample).getPropertyValue('-moz-user-select') === 'none';
			}
			if (_textLayerIsFirefox) return;

			const range = selection.getRangeAt(0);
			const prev = _textLayerSelectionPrevRange;
			const modifyStart =
				prev &&
				(range.compareBoundaryPoints(Range.END_TO_END, prev) === 0 ||
					range.compareBoundaryPoints(Range.START_TO_END, prev) === 0);

			let anchor = modifyStart ? range.startContainer : range.endContainer;
			if (anchor.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode;
			if (anchor?.classList?.contains('highlight')) anchor = anchor.parentNode;

			if (!modifyStart && range.endOffset === 0 && anchor) {
				do {
					while (anchor && !anchor.previousSibling) {
						anchor = anchor.parentNode;
					}
					if (!anchor) break;
					anchor = anchor.previousSibling;
				} while (anchor && !anchor.childNodes?.length);
			}

			const parentTextLayer = anchor?.parentElement?.closest?.('.textLayer');
			const endDiv = parentTextLayer ? _textLayerSelectionMap.get(parentTextLayer) : null;
			if (endDiv && parentTextLayer && anchor?.parentElement) {
				endDiv.style.width = parentTextLayer.style.width;
				endDiv.style.height = parentTextLayer.style.height;
				endDiv.style.userSelect = 'text';
				anchor.parentElement.insertBefore(
					endDiv,
					modifyStart ? anchor : anchor.nextSibling
				);
			}
			_textLayerSelectionPrevRange = range.cloneRange();
		},
		{ signal }
	);
}

const _textLayerLocalAborts = new WeakMap();

function bindTextLayerSelection(container, endOfContent) {
	if (!container || !endOfContent) return;
	unbindTextLayerSelection(container);
	const localAbort = new AbortController();
	_textLayerLocalAborts.set(container, localAbort);
	container.addEventListener(
		'mousedown',
		() => {
			container.classList.add('selecting');
		},
		{ signal: localAbort.signal }
	);
	_textLayerSelectionMap.set(container, endOfContent);
	enableTextLayerSelectionListener();
}

function unbindTextLayerSelection(container) {
	if (!container) return;
	const localAbort = _textLayerLocalAborts.get(container);
	if (localAbort) {
		localAbort.abort();
		_textLayerLocalAborts.delete(container);
	}
	_textLayerSelectionMap.delete(container);
	container.classList.remove('selecting');
	if (_textLayerSelectionMap.size === 0 && _textLayerSelectionAbort) {
		_textLayerSelectionAbort.abort();
		_textLayerSelectionAbort = null;
		_textLayerSelectionPrevRange = null;
		_textLayerPointerDown = false;
		_textLayerIsFirefox = null;
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
		scrollPageInsideReader(data);
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
				scrollPageInsideReader(active);
			}
			updateUi(false);
		})();
	} else {
		void renderPagesAround(next, 1);
		scrollPageInsideReader(data, 'smooth');
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
	// Seuil en points PDF (pas px zoomés) pour ne pas avaler un bandeau gris
	// sous du corps 14 pt à zoom ≥ 150 %.
	const inkData = getActivePageData() || getPageData(state.page);
	for (const block of blocks) {
		// Texte natif éditable : ne pas absorber l'encre voisine (icônes, bandeaux).
		// L'encre glyphes pilote déjà le cadre de sélection.
		if (
			block.kind !== 'image' &&
			pdfFontSizeInPoints(block) >= 22 &&
			!nativeTextEditEligible(block)
		) {
			expandBlockToInk(block, inkData);
		}
	}
	annotateBlockIntelligence(blocks);
	// Les textes ajoutés / déjà modifiés ne sont pas dans le PDF source : les
	// garder, sinon quitter Modifier puis relancer une détection les efface.
	const keepOnPage = state.editBlocks.filter(
		(block) => block.page === state.page && isPersistedPageContent(block)
	);
	const incoming = blocks.filter((scanned) => {
		return !keepOnPage.some((kept) => {
			if (isAddedTextBlock(kept)) return false;
			return (
				normalizeDocText(kept.originalText || kept.text) === normalizeDocText(scanned.text) &&
				blockOverlapRatio(kept, scanned) > 0.5
			);
		});
	});
	state.editBlocks = state.editBlocks
		.filter((block) => block.page !== state.page)
		.concat(keepOnPage, incoming);
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
						maskHeight: Math.max(0.5, (ch.maskHeight ?? ch.height ?? 0) * scaleY),
						// Index dans la page texte PDFium : clé de l'édition NATIVE.
						pageCharIndex: Number.isInteger(ch.pageCharIndex) ? ch.pageCharIndex : -1
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
					pdfPageWidth: pageWidth,
					pdfPageHeight: pageHeight,
					hidden: false,
					bold: Boolean(block.bold),
					italic: Boolean(block.italic),
					serif: Boolean(block.serif),
					justified: Boolean(block.justified),
					pdfChars,
					fontName: block.fontName || '',
					source: block.source || analysis?.engine || 'pdfium',
					confidence: typeof block.confidence === 'number' ? block.confidence : 96,
					fieldKind: block.fieldKind || null,
					critical: Boolean(block.critical),
					diagnostics: Array.isArray(block.diagnostics) ? [...block.diagnostics] : []
				};
			})
			.filter((block) => block.width > 2 && block.height > 2 && (block.text || block.kind !== 'text'))
			.filter((block, _index, all) => {
				if (block.kind !== 'image') return true;
				// Image qui recouvre du texte = fond / bandeau, pas un logo.
				// La garder pose un cadre rouge par-dessus les caractères.
				return !all.some((other) => {
					if (other.kind === 'image' || other === block) return false;
					const il = Math.max(block.x, other.x);
					const it = Math.max(block.y, other.y);
					const ir = Math.min(block.x + block.width, other.x + other.width);
					const ib = Math.min(block.y + block.height, other.y + other.height);
					if (ir <= il || ib <= it) return false;
					const inter = (ir - il) * (ib - it);
					const textArea = Math.max(1, other.width * other.height);
					return inter > textArea * 0.2;
				});
			});
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

async function runOcrForCurrentPage(openPanel = false, options = {}) {
	if (!state.pdf) return;
	const silent = Boolean(options.silent);

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

		const existing = state.editBlocks.filter((block) => !(block.page === state.page && block.source === 'ocr'));
		annotateBlockIntelligence([...existing.filter((block) => block.page === state.page), ...blocks]);
		state.editBlocks = mergeAnalysisSources(existing, blocks);
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
		if (!silent) {
			setStatus(error instanceof Error ? error.message : 'Local OCR failed.', 'error');
		}
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
			const pdfPageWidth = ocrResult?.pageWidth || data.pdfPageWidth || data.viewportWidth;
			const pdfPageHeight = ocrResult?.pageHeight || data.pdfPageHeight || data.viewportHeight;
			const ocrFontSize = Math.max(6, height * 0.78);
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
				pdfPageWidth,
				pdfPageHeight,
				baseFontSize: ocrFontSize,
				pdfFontSize: ocrFontSize,
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

// isBlockDirty, isBlockTextEdited, hasLocalGlyphEdits, isLiveTextBlock,
// hiddenCharSet, visiblePdfChars, visiblePdfText : voir ./block-state.js
// (machine à états des blocs — source de vérité unique).

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

// Capture bitmap SERRÉE sur l'encre des glyphes (coordonnées d'origine), à la
// résolution réelle du canvas, pour un rendu net en 1:1. Sert au texte natif
// DÉPLACÉ : identique au pixel près au rendu PDF natif (aucun reflow, aucun flou),
// cadre serré stable. Le cache (clé = dims + top d'origine) reste valable pendant
// les déplacements (l'encre est en coordonnées d'origine, donc invariante au move).
function getBlockInkSnapshot(block, data, inkBox) {
	const canvas = data && data.canvas;
	if (!canvas || !canvas.width || !data.viewportWidth || !inkBox) return null;
	const sx = canvas.width / data.viewportWidth;
	const sy = canvas.height / data.viewportHeight;
	const srcX = block.originalX ?? block.x;
	const srcY = inkBox.top;
	const srcW = Math.max(1, block.originalWidth || block.width);
	const srcH = Math.max(1, inkBox.height);
	// La clé inclut les glyphes masqués : trimmer un caractère change le bitmap
	// (glyphe effacé) → le cache doit être invalidé, sinon on renvoie l'image périmée.
	const hiddenKey = (block.hiddenCharIndexes || []).join(',');
	const key = `${Math.round(srcW)}x${Math.round(srcH)}@${Math.round(srcX)},${Math.round(srcY)}#${hiddenKey}`;
	if (block.inkSnapshotDataUrl && block.inkSnapshotKey === key) {
		return block.inkSnapshotDataUrl;
	}
	try {
		const off = document.createElement('canvas');
		off.width = Math.max(1, Math.round(srcW * sx));
		off.height = Math.max(1, Math.round(srcH * sy));
		const octx = off.getContext('2d', { willReadFrequently: true });
		octx.drawImage(canvas, srcX * sx, srcY * sy, srcW * sx, srcH * sy, 0, 0, off.width, off.height);
		// Glyphes SUPPRIMÉS (masqués) : on les efface chirurgicalement du bitmap (clearRect)
		// pour qu'ils n'apparaissent pas quand on déplace un texte tronqué en fin. On garde
		// ainsi les dimensions d'origine (pas de recalcul de largeur) : seuls les pixels des
		// lettres supprimées deviennent transparents.
		if (Array.isArray(block.hiddenCharIndexes) && block.hiddenCharIndexes.length && Array.isArray(block.pdfChars)) {
			const hidden = hiddenCharSet(block);
			for (const ch of block.pdfChars) {
				if (!hidden.has(ch.index)) continue;
				const mx = ch.maskX ?? ch.x;
				const my = ch.maskY ?? ch.y;
				const mw = ch.maskWidth ?? ch.width ?? 0;
				const mh = ch.maskHeight ?? ch.height ?? 0;
				// Petite marge pour effacer l'anti-aliasing résiduel du glyphe.
				octx.clearRect((mx - srcX) * sx - 1, (my - srcY) * sy - 1, mw * sx + 2, mh * sy + 2);
			}
		}
		// Fond blanc de la page → TRANSPARENT : on ne garde que l'encre. Sinon le bitmap
		// est un rectangle blanc opaque qui masque le contenu en dessous au déplacement et
		// passe devant le curseur. Clé alpha = 255 - min(r,g,b) (blanc→0, encre→opaque),
		// avec dé-prémultiplication sur fond blanc pour préserver la couleur réelle du texte.
		try {
			const imageData = octx.getImageData(0, 0, off.width, off.height);
			const d = imageData.data;
			for (let i = 0; i < d.length; i += 4) {
				// Pixel déjà effacé (clearRect d'un glyphe supprimé) → reste transparent.
				// Sans ce garde-fou, la clé alpha le transformerait en noir opaque.
				if (d[i + 3] === 0) continue;
				const r = d[i];
				const g = d[i + 1];
				const b = d[i + 2];
				const a = 255 - Math.min(r, g, b);
				if (a <= 0) {
					d[i + 3] = 0;
					continue;
				}
				const inv = 255 - a;
				d[i] = Math.max(0, Math.min(255, Math.round(((r - inv) * 255) / a)));
				d[i + 1] = Math.max(0, Math.min(255, Math.round(((g - inv) * 255) / a)));
				d[i + 2] = Math.max(0, Math.min(255, Math.round(((b - inv) * 255) / a)));
				d[i + 3] = a;
			}
			octx.putImageData(imageData, 0, 0);
		} catch (_keyError) {
			// Canvas potentiellement taint (improbable : données locales) → bitmap brut.
		}
		block.inkSnapshotDataUrl = off.toDataURL('image/png');
		block.inkSnapshotKey = key;
		return block.inkSnapshotDataUrl;
	} catch (error) {
		console.warn('Block ink snapshot failed', error);
		return null;
	}
}

let _lastBlockClick = { id: null, time: 0 };
const DOUBLE_CLICK_MS = 500;
// Un drag réel (ou une activation via pointerup) doit ignorer le `click`
// qui suit : sinon on re-sélectionne / on relance l'édition.
let _suppressIdleClick = false;

function suppressNextIdleClick() {
	_suppressIdleClick = true;
	setTimeout(() => {
		_suppressIdleClick = false;
	}, 0);
}

function renderEditBlocks() {
	for (const data of state.pageElements.values()) {
		renderEditBlocksForPage(data.pageNumber);
	}
}

// Rendu coalescé « au frame » pour les gestes continus (resize) : WebKit peut
// livrer plusieurs pointermove par frame d'affichage, et chaque
// renderEditBlocksForPage reconstruit les enfants non montés du layer. On ne
// rend donc qu'UNE fois par frame, avec le dernier état du modèle.
let _frameRenderPages = null;
function renderEditBlocksForPageOnFrame(pageNumber) {
	if (_frameRenderPages) {
		_frameRenderPages.add(pageNumber);
		return;
	}
	_frameRenderPages = new Set([pageNumber]);
	requestAnimationFrame(() => {
		const pages = _frameRenderPages;
		_frameRenderPages = null;
		for (const page of pages) renderEditBlocksForPage(page);
	});
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

// === Polices calées sur le rendu de page (embarquées, cf. styles.css) ========
// Helvetica/Arial : PDF.js dessine les base-14 sans-serif avec LiberationSans
// (vendor/standard_fonts/). L'overlay utilise LES MÊMES fichiers TTF → glyphes
// identiques au canvas, la bascule natif → édité ne change plus l'aspect du
// texte. Times/Courier : PDF.js utilise des Type1 Foxit inutilisables en CSS ;
// Tinos/Cousine (mêmes avances) restent la meilleure approximation.
function metricCompatibleFamily(fontName) {
	const n = String(fontName || '').toLowerCase();
	if (!n) return '';
	if (n.includes('courier') || n.includes('mono')) return 'Cousine';
	if (n.includes('times')) return 'Tinos';
	if (n.includes('helvetica') || n.includes('arial')) return 'Liberation Sans';
	return '';
}

// Charge les 4 variantes de LiberationSans dès le démarrage : sans ça,
// `font-display: swap` afficherait la première édition avec la police de repli
// puis échangerait les glyphes en cours de frappe (changement d'aspect visible).
function preloadStandardEditFonts() {
	if (!document.fonts || !document.fonts.load) return;
	for (const variant of ['400', '700', 'italic 400', 'italic 700']) {
		document.fonts.load(`${variant} 16px "Liberation Sans"`).catch(() => {});
	}
}
preloadStandardEditFonts();

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

// Précharge la police d'édition d'un bloc texte (police d'origine PDFium, repli
// Google Fonts) DÈS la sélection/entrée en édition. Sans ça, la police arrive en
// async pendant la frappe/suppression et le texte se recompose (« font-swap »),
// donnant l'impression que la taille change plusieurs fois. En la chargeant tôt,
// le premier rendu édité utilise déjà la bonne police → un seul état, stable.
function preloadBlockEditFont(block) {
	if (!block || block.kind === 'image') return;
	const pdfBase = baseFamilyName(cleanFontName(block.fontName));
	const fam = pdfBase || primaryFamilyName(block.fontFamilyOverride || '');
	if (!fam || fam.length < 3) return;
	ensureCloudFont(fam);
	const px = block.fontSizeOverride || (block.pdfFontSize > 0 ? block.pdfFontSize : block.baseFontSize) || 16;
	if (document.fonts && document.fonts.load && !document.fonts.check(`${px}px "${fam}"`)) {
		document.fonts
			.load(`${px}px "${fam}"`)
			.then(() => {
				// Re-render une seule fois quand la police est prête (corrige le repli initial).
				// Un bloc déjà MONTÉ a été rasterisé (et son cadre mesuré) avec la police de
				// repli : on invalide son montage pour qu'il soit remonté UNE fois avec la
				// police réelle et les bonnes métriques, plutôt que de laisser WebKit
				// échanger la police en place (texte qui change d'aspect en plein geste,
				// letter-spacing/cadre calculés sur les métriques du repli).
				if (block._mounted) {
					delete block._mounted;
					delete block._mountX;
					delete block._mountY;
					delete block._mountLeft;
					delete block._mountTop;
					delete block._mountSig;
				}
				if (state.editMode) renderEditBlocksForPage(block.page);
			})
			.catch(() => {});
	}
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
	_fontComboSavedRange = null;
	updatePreciseSelection();
}

// Capture la plage de texte sélectionnée DANS le bloc en cours d'édition inline.
// Les offsets restent valides même si execCommand reconstruit les nœuds HTML.
function captureInlineSelectionRange() {
	if (!state.editingBlockId) return null;
	const editing = elements.pagesStack.querySelector(
		`.edit-block.editing[data-block-id="${state.editingBlockId}"]`
	);
	if (!editing) return null;
	const selection = window.getSelection();
	if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
	if (!editing.contains(selection.anchorNode) || !editing.contains(selection.focusNode)) return null;
	const offsets = textOffsetsForDomRange(editing, selection.getRangeAt(0));
	if (!offsets || offsets.end <= offsets.start) return null;
	return { blockId: state.editingBlockId, ...offsets };
}

function textOffsetsForDomRange(element, range) {
	if (!element || !range) return null;
	if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return null;
	const beforeStart = range.cloneRange();
	beforeStart.selectNodeContents(element);
	beforeStart.setEnd(range.startContainer, range.startOffset);
	const beforeEnd = range.cloneRange();
	beforeEnd.selectNodeContents(element);
	beforeEnd.setEnd(range.endContainer, range.endOffset);
	return {
		start: beforeStart.toString().length,
		end: beforeEnd.toString().length
	};
}

function domRangeForTextOffsets(element, start, end) {
	const textLength = element.textContent?.length || 0;
	const from = Math.max(0, Math.min(start, textLength));
	const to = Math.max(from, Math.min(end, textLength));
	const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
	const range = document.createRange();
	let cursor = 0;
	let startPoint = null;
	let endPoint = null;
	let node = walker.nextNode();
	while (node) {
		const next = cursor + node.textContent.length;
		if (!startPoint && from <= next) startPoint = [node, from - cursor];
		if (!endPoint && to <= next) {
			endPoint = [node, to - cursor];
			break;
		}
		cursor = next;
		node = walker.nextNode();
	}
	if (!startPoint || !endPoint) return null;
	range.setStart(startPoint[0], startPoint[1]);
	range.setEnd(endPoint[0], endPoint[1]);
	return range;
}

function restoreInlineSelectionOffsets(element, saved) {
	const range = domRangeForTextOffsets(element, saved.start, saved.end);
	const selection = window.getSelection();
	if (!range || !selection) return false;
	element.focus({ preventScroll: true });
	selection.removeAllRanges();
	selection.addRange(range);
	return !selection.isCollapsed;
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

	const fullSelection =
		saved.start === 0 && saved.end === (editing.textContent?.length || 0);
	if (fullSelection) {
		pushHistory('histFormat');
		setFontComboValue(value);
		block.fontFamilyOverride = value || null;
		block.textEdited = true;
		block.inlineEditDirty = true;
		block.editLetterSpacing = 0;
		editing.classList.remove('editing-pristine');
		editing.style.letterSpacing = '0px';
		editing.style.fontFamily = value ? `"${value}", sans-serif` : '';
		ensureEditMask(editing, block);
		resizeEditingElementToContent(editing, block);
		block.snapshotDataUrl = null;
		block._mountSig = editedBlockSignature(block);
		markDirty();
		updateFormatPanel(block);
		restoreInlineSelectionOffsets(editing, saved);
		return true;
	}

	// Restaure la plage par offsets : contrairement à un Range cloné, elle survit
	// au focus du champ de recherche et à la reconstruction des spans de police.
	if (!restoreInlineSelectionOffsets(editing, saved)) return false;
	const selection = window.getSelection();

	pushHistory('histFormat');
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
	// Formatage explicitement modifié : l'espacement naturel devient la référence
	// (les rendus suivants ne doivent pas ré-appliquer l'étirement PDF).
	block.editLetterSpacing = 0;
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
	restoreInlineSelectionOffsets(editing, saved);
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
	// Taille : PDFium (scaled_font_size) — vérifié à l'écran : c'est la bonne
	// hauteur de glyphes (la taille du textLayer PDF.js sort TROP GRANDE).
	// L'impression de « texte plus petit » à la première frappe vient de
	// l'effondrement du letter-spacing, traité séparément (editLetterSpacing).
	if (!block.fontSizeOverride) {
		if (block.pdfFontSize > 0) {
			element.style.fontSize = `${block.pdfFontSize}px`;
		} else if (fontSize > 0) {
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
		// retombe sur l'estimation par hauteur que si PDFium ne l'a pas fournie.
		if (!block.fontSizeOverride) {
			block.baseFontSize = block.pdfFontSize > 0
				? block.pdfFontSize
				: Math.max(8, Math.min(48, Math.round(block.height * 0.78)));
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
// Encre serrée des glyphes visibles (mask*), sans clamp sur la géométrie du bloc.
function tightInkFromChars(chars) {
	if (!Array.isArray(chars) || !chars.length) return null;
	let left = Infinity;
	let top = Infinity;
	let right = -Infinity;
	let bottom = -Infinity;
	for (const ch of chars) {
		if (!ch.text || !ch.text.trim()) continue;
		const w = ch.maskWidth > 0 ? ch.maskWidth : ch.width;
		const h = ch.maskHeight > 0 ? ch.maskHeight : ch.height;
		const l = typeof ch.maskX === 'number' ? ch.maskX : ch.x;
		const t = typeof ch.maskY === 'number' ? ch.maskY : ch.y;
		if (!(w > 0) || !(h > 0)) continue;
		if (l < left) left = l;
		if (t < top) top = t;
		if (l + w > right) right = l + w;
		if (t + h > bottom) bottom = t + h;
	}
	if (!isFinite(left) || !isFinite(top) || right <= left || bottom <= top) return null;
	const height = bottom - top;
	if (!(height > 1)) return null;
	return { left, top, right, bottom, width: right - left, height };
}

function textInkBox(block) {
	const tight = tightInkFromChars(block?.pdfChars);
	if (!tight) return null;
	// Pas de clamp sur originalY : il abaissait le cadre sous les capitales quand
	// les bounds PDFium étaient plus bas que l'encre réelle. Les glyphes sont la
	// source de vérité ; le déplacement s'ajoute via dx/dy au rendu.
	if (!(tight.height > 1)) return null;
	return {
		left: tight.left,
		top: tight.top,
		right: tight.right,
		width: tight.width,
		height: tight.height
	};
}

// Après delete/insert natif : géométrie + hauteur de session calées sur l'encre
// (sinon le cadre garde le vide sous la ligne de la session d'avant).
function syncNativeEditBoxToInk(block) {
	const tight = tightInkFromChars(block?.pdfChars);
	if (!tight) return;
	const dx = block.x - (block.originalX ?? block.x);
	const dy = block.y - (block.originalY ?? block.y);
	block.originalX = tight.left;
	block.originalY = tight.top;
	block.originalWidth = tight.width;
	block.originalHeight = tight.height;
	block.x = tight.left + dx;
	block.y = tight.top + dy;
	block.width = tight.width;
	block.height = tight.height;
	if (block._nativePristine) {
		block._nativePristine.editBoxHeight =
			Math.round(Math.max(tight.height, 6)) + EDIT_BLOCK_PAD_Y * 2;
	}
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

function isAddedTextBlock(block) {
	return Boolean(block && (block.added || block.source === 'added'));
}

/** Contenu document (ajouté / édité / masqué) — pas un overlay de détection. */
function isPersistedPageContent(block) {
	return Boolean(
		block && (isAddedTextBlock(block) || block.hidden || isBlockDirty(block))
	);
}

function isEmptyAddedPlaceholder(block) {
	return isAddedTextBlock(block) && !(block.text || '').trim();
}

function ensureAddedPlaceholderGeometry(block) {
	if (!block) return;
	const fs = Number(block.fontSizeOverride || block.pdfFontSize || block.baseFontSize) || 16;
	const minW = Math.max(80, Math.ceil(fs * 4));
	const minH = Math.max(14, Math.ceil(fs));
	block.width = Math.max(Number(block.width) || 0, minW);
	block.height = Math.max(Number(block.height) || 0, minH);
	block.originalWidth = block.width;
	block.originalHeight = block.height;
}

// Hauteur contenu (hors padding) pour un texte « Ajouter un contenu ».
// Évite le scrollHeight contenteditable (souvent ~2× à cause d'un <br> / line-box).
function addedTextContentHeight(block, element, textOverride) {
	const raw =
		textOverride != null
			? String(textOverride)
			: String(element?.innerText ?? block?.text ?? '');
	const normalized = raw.replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '');
	const parts = normalized.length ? normalized.split('\n') : [''];
	const fs =
		Number(block?.fontSizeOverride || block?.pdfFontSize || block?.baseFontSize) || 16;
	const multi = parts.length > 1 || Boolean(block?.multiline);
	if (element && !block?.boxResized) {
		element.style.lineHeight = multi ? '1.15' : '1';
	}
	let fontStr = `400 ${fs}px Helvetica, Arial, sans-serif`;
	if (element) {
		const cs = window.getComputedStyle(element);
		const size = Number.parseFloat(cs.fontSize) || fs;
		fontStr = `${cs.fontStyle} ${cs.fontWeight} ${size}px ${cs.fontFamily}`;
	}
	let lineInk = 0;
	for (const line of parts) {
		const sample = (line && line.trim()) || 'Hg';
		const ink = measureTextInk(sample, fontStr);
		if (ink?.height) lineInk = Math.max(lineInk, ink.height);
	}
	const lineH = Math.max(lineInk, Math.ceil(fs * 0.92), 10);
	const gap = multi ? Math.ceil(lineH * 0.15) : 0;
	return Math.ceil(lineH * parts.length + gap * Math.max(0, parts.length - 1));
}

// Décalage vertical entre le HAUT D'ENCRE du texte HTML (1re ligne rendue par
// WebKit) et le HAUT DU CONTENU de l'élément (padding exclu). WebKit pose la
// ligne de base à demi-interligne + ascent de POLICE depuis le haut du line
// box ; l'encre réelle commence plus bas (ascent d'ENCRE < ascent de police).
// Résultat : le texte HTML s'affichait ~1-2px sous l'encre native → c'était le
// dernier « micro-saut » visible à la première frappe. En soustrayant ce
// décalage à l'ancrage (inkBox.top), l'encre HTML tombe PILE sur l'encre PDF.
// Mesuré sur le texte D'ORIGINE (l'ancre PDF ne bouge pas quand on tape) avec
// la police effective de l'élément (même moteur de rendu WebKit), mémoïsé par
// bloc et invalidé automatiquement si police/taille/interligne changent (zoom).
function htmlInkTopOffset(element, block) {
	const sample = String(block.originalText || block.text || '').split('\n')[0].trim();
	if (!sample) return 0;
	const cs = window.getComputedStyle(element);
	const fontSizePx = Number.parseFloat(cs.fontSize) || 0;
	if (!(fontSizePx > 0)) return 0;
	const lineHeightPx =
		cs.lineHeight === 'normal' ? fontSizePx : Number.parseFloat(cs.lineHeight) || fontSizePx;
	const key = `${cs.fontStyle}|${cs.fontWeight}|${cs.fontFamily}|${fontSizePx.toFixed(2)}|${lineHeightPx.toFixed(2)}|${sample}`;
	if (block._inkTopOffsetKey === key && Number.isFinite(block._inkTopOffset)) {
		return block._inkTopOffset;
	}
	const fontStr = `${cs.fontStyle} ${cs.fontWeight} ${fontSizePx}px ${cs.fontFamily}`;
	const ctx = inkMeasureCanvas().getContext('2d', { willReadFrequently: true });
	ctx.font = fontStr;
	const metrics = ctx.measureText(sample);
	const fontAscent = metrics.fontBoundingBoxAscent || 0;
	const fontDescent = metrics.fontBoundingBoxDescent || 0;
	const ink = measureTextInk(sample, fontStr);
	let offset = 0;
	if (fontAscent > 0 && ink && ink.ascent > 0) {
		offset = (lineHeightPx - (fontAscent + fontDescent)) / 2 + fontAscent - ink.ascent;
	}
	// Garde-fou : au-delà, la mesure est aberrante (police pas encore chargée…) ;
	// on garde alors l'ancrage historique plutôt que de décaler le bloc au hasard.
	if (!Number.isFinite(offset) || Math.abs(offset) > fontSizePx * 0.4) offset = 0;
	block._inkTopOffsetKey = key;
	block._inkTopOffset = offset;
	return offset;
}

// Demi-marge d'interligne RÉELLE d'une boîte de ligne CSS pour la police
// effective de l'élément : (lineHeight − (ascent + descent)) / 2, mesurée via
// les métriques réelles. L'approximation (lineHeight − fontSize)/2 surestime la
// remontée d'environ 0,1 × fontSize (ascent+descent ≈ 1,2 × fontSize) : c'est
// elle qui posait le caret 1-2px au-dessus des pixels natifs d'un paragraphe et
// produisait le micro-saut à la première frappe. Retourne null si les métriques
// ne sont pas disponibles (l'appelant garde alors l'approximation).
function measuredCssHalfLeading(element, lineHeightPx) {
	if (!(lineHeightPx > 0)) return null;
	try {
		const cs = window.getComputedStyle(element);
		const fontSizePx = Number.parseFloat(cs.fontSize) || 0;
		if (!(fontSizePx > 0)) return null;
		const ctx = inkMeasureCanvas().getContext('2d', { willReadFrequently: true });
		ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${fontSizePx}px ${cs.fontFamily}`;
		const metrics = ctx.measureText('Hg');
		const ascent = metrics.fontBoundingBoxAscent;
		const descent = metrics.fontBoundingBoxDescent;
		if (!Number.isFinite(ascent) || !Number.isFinite(descent) || ascent + descent <= 0) {
			return null;
		}
		return Math.max(0, (lineHeightPx - (ascent + descent)) / 2);
	} catch (_err) {
		return null;
	}
}

// ─── Préservation des glyphes (mode « Adobe ») ───────────────────────────────
// Quand on modifie un bloc texte, on ne ré-écrit PLUS tout le bloc en HTML avec
// une police de substitution (ce qui faisait « bouger » tout le texte à la
// première frappe). À la place, on décompose l'édition en diff préfixe/suffixe :
//   - les glyphes d'origine NON touchés restent le rendu natif du PDF (zéro
//     mouvement, par construction : on ne touche pas à leurs pixels) ;
//   - les glyphes remplacés/décalés sont masqués ;
//   - le texte INSÉRÉ est rendu en HTML dans la police de substitution ;
//   - la fin de ligne d'origine (suffixe) est décalée en BITMAP (copie exacte
//     des pixels natifs, translatée de la largeur insérée/supprimée).
// C'est le comportement d'Adobe Acrobat, badge « police non disponible » inclus.

// Pile de police de l'insertion : métrique-compatible d'abord (Liberation Sans
// pour Helvetica/Arial = fichier EXACT du rendu de page), puis le vrai nom du
// document (installé / Google Fonts), puis le match PDF.js, puis une générique.
function compositeInsertFontFamily(block) {
	const parts = [];
	const metric = metricCompatibleFamily(block.fontName);
	if (metric) parts.push(`"${metric}"`);
	const base = baseFamilyName(cleanFontName(block.fontName));
	if (base && base !== metric) {
		ensureCloudFont(base);
		parts.push(`"${base}"`);
	}
	if (block.fontMatch && block.fontMatch.family) parts.push(block.fontMatch.family);
	parts.push(block.serif ? 'Georgia, "Times New Roman", serif' : 'Helvetica, Arial, sans-serif');
	return parts.join(', ');
}

function compositeInsertFontString(block) {
	const fs = block.pdfFontSize > 0 ? block.pdfFontSize : block.baseFontSize > 0 ? block.baseFontSize : 14;
	const style = block.italic || block.italicOverride === true ? 'italic' : 'normal';
	const weight = block.bold || block.visualBold || block.boldOverride === true ? '700' : '400';
	const family = compositeInsertFontFamily(block);
	return { fs, style, weight, family, css: `${style} ${weight} ${fs}px ${family}` };
}

// Décomposition « glyphes préservés » d'un bloc texte modifié, ou null si le
// bloc n'y est pas éligible (multiligne, déplacé, redimensionné, formaté,
// HTML riche, pas de glyphes PDF…). Recalculée à chaque rendu à partir de
// originalText/text/pdfChars : dérivée pure, donc sûre pour undo/redo/zoom.
function glyphCompositeInfo(block) {
	// DÉSACTIVÉ : le mode composite (glyphes natifs + span HTML inséré + tranche
	// bitmap décalée) est remplacé par l'ÉDITION NATIVE PDFium (tryNativeTextEdit),
	// qui modifie le texte dans le document et laisse le moteur re-rendre la ligne
	// — alignement et caret exacts par construction. Les blocs inéligibles au
	// natif retombent directement sur l'édition HTML classique (applyGlyphEditHtml).
	return null;
	// eslint-disable-next-line no-unreachable
	if (!block || block.kind === 'image' || block.hidden) return null;
	if (!Array.isArray(block.pdfChars) || !block.pdfChars.length) return null;
	// Copie de bloc : aucun rendu natif sous sa position → pas de composite.
	if (block.added) return null;
	if (!isBlockTextEdited(block)) return null;
	if (block.htmlEdited || block.boxResized || block.rotation) return null;
	if (block.fontFamilyOverride || block.fontSizeOverride) return null;
	if (block.boldOverride !== undefined && block.boldOverride !== null) return null;
	if (block.italicOverride !== undefined && block.italicOverride !== null) return null;
	if (hasLocalGlyphEdits(block)) return null;
	const ot = String(block.originalText || '');
	const nt = String(block.text || '');
	if (!ot || ot.includes('\n') || nt.includes('\n') || block.multiline) return null;
	const moved =
		Math.abs(block.x - (block.originalX ?? block.x)) > 0.5 ||
		Math.abs(block.y - (block.originalY ?? block.y)) > 0.5;
	if (moved) return null;
	// Bloc en cours de drag : bascule HTML forcée (l'ancrage natif ne suit pas).
	if (block._dragForceHtml) return null;

	// Diff préfixe/suffixe : la zone touchée est [p, ot.length - s) côté origine,
	// remplacée par inserted côté nouveau texte.
	let p = 0;
	const maxP = Math.min(ot.length, nt.length);
	while (p < maxP && ot[p] === nt[p]) p += 1;
	let s = 0;
	const maxS = Math.min(ot.length, nt.length) - p;
	while (s < maxS && ot[ot.length - 1 - s] === nt[nt.length - 1 - s]) s += 1;
	const inserted = nt.slice(p, nt.length - s);
	const suffixStartIndex = ot.length - s;

	const chars = [...block.pdfChars].sort((a, b) => a.index - b.index);
	const prefixChars = chars.filter((ch) => ch.index < p);
	const replacedChars = chars.filter((ch) => ch.index >= p && ch.index < suffixStartIndex);
	const suffixChars = chars.filter((ch) => ch.index >= suffixStartIndex);

	// Point d'ancrage de l'insertion : là où commençait la zone remplacée
	// (remplacement/suppression), sinon fin du dernier glyphe du préfixe
	// (insertion pure entre deux caractères).
	const lastPrefix = prefixChars.length ? prefixChars[prefixChars.length - 1] : null;
	const firstChar = chars[0];
	const anchorX = lastPrefix ? lastPrefix.x + lastPrefix.width : firstChar ? firstChar.x : block.originalX;
	const firstReplaced = replacedChars.length ? replacedChars[0] : null;
	const insertX = firstReplaced ? firstReplaced.x : anchorX;

	// Largeur du texte inséré, mesurée avec la police de substitution réelle.
	const font = compositeInsertFontString(block);
	let insertedWidth = 0;
	if (inserted) {
		const ctx = inkMeasureCanvas().getContext('2d', { willReadFrequently: true });
		ctx.font = font.css;
		insertedWidth = ctx.measureText(inserted).width;
		if (!Number.isFinite(insertedWidth) || insertedWidth < 0) return null;
	}

	// Décalage du suffixe, en préservant les espacements naturels :
	//   remplacement : le suffixe suit la fin de l'insertion (posée au début de
	//     la zone remplacée) → dx = insertedWidth − avance retirée ;
	//   insertion pure : le suffixe est poussé d'exactement insertedWidth (le
	//     gap d'origine préfixe→suffixe est conservé après l'insertion) ;
	//   suppression pure : le suffixe vient prendre la place de la zone retirée.
	const firstSuffix = suffixChars.length ? suffixChars[0] : null;
	const removedAdvance = firstReplaced && firstSuffix ? firstSuffix.x - firstReplaced.x : 0;
	const dx = firstSuffix ? insertedWidth - removedAdvance : 0;
	if (!Number.isFinite(dx)) return null;

	// Bord droit VISUEL du composite (coordonnées page) : fin du texte inséré ou
	// fin du dernier glyphe du suffixe décalé. Sert à élargir le cadre du bloc
	// quand la saisie déborde de la boîte d'origine (comportement Adobe).
	const lastSuffix = suffixChars.length ? suffixChars[suffixChars.length - 1] : null;
	const extentRight = Math.max(
		insertX + insertedWidth,
		lastSuffix ? lastSuffix.x + lastSuffix.width + dx : 0
	);

	return { p, suffixStartIndex, inserted, prefixChars, replacedChars, suffixChars, insertX, insertedWidth, dx, extentRight, font };
}

function isGlyphCompositeBlock(block) {
	return Boolean(glyphCompositeInfo(block));
}

// Un bloc reste routé « glyphe » (chaque frappe passe par commitGlyphEdit, qui
// met à jour block.text et re-rend le composite) tant qu'il est vierge OU en
// mode composite. Il ne bascule en édition HTML classique que si le composite
// devient impossible (multiligne, formatage, déplacement…).
function isGlyphEditRouted(block) {
	return (
		Array.isArray(block.pdfChars) &&
		block.pdfChars.length > 0 &&
		(!isBlockTextEdited(block) || isGlyphCompositeBlock(block))
	);
}

// Passe blanc → alpha sur un canvas (garde l'encre seule, dé-prémultipliée).
// Extrait de getBlockInkSnapshot pour resservir aux tranches de suffixe.
function whiteToAlphaCanvas(octx, width, height) {
	try {
		const imageData = octx.getImageData(0, 0, width, height);
		const d = imageData.data;
		for (let i = 0; i < d.length; i += 4) {
			if (d[i + 3] === 0) continue;
			const r = d[i];
			const g = d[i + 1];
			const b = d[i + 2];
			const a = 255 - Math.min(r, g, b);
			if (a <= 0) {
				d[i + 3] = 0;
				continue;
			}
			const inv = 255 - a;
			d[i] = Math.max(0, Math.min(255, Math.round(((r - inv) * 255) / a)));
			d[i + 1] = Math.max(0, Math.min(255, Math.round(((g - inv) * 255) / a)));
			d[i + 2] = Math.max(0, Math.min(255, Math.round(((b - inv) * 255) / a)));
			d[i + 3] = a;
		}
		octx.putImageData(imageData, 0, 0);
	} catch (_err) {
		// Canvas taint improbable (données locales) → bitmap brut.
	}
}

// Boîte d'encre (coordonnées page) d'un sous-ensemble de glyphes.
function glyphRangeInkRect(chars) {
	let left = Infinity;
	let top = Infinity;
	let right = -Infinity;
	let bottom = -Infinity;
	for (const ch of chars) {
		const x = ch.maskX ?? ch.x;
		const y = ch.maskY ?? ch.y;
		const w = ch.maskWidth ?? ch.width ?? 0;
		const h = ch.maskHeight ?? ch.height ?? 0;
		if (!(w > 0) || !(h > 0)) continue;
		if (x < left) left = x;
		if (y < top) top = y;
		if (x + w > right) right = x + w;
		if (y + h > bottom) bottom = y + h;
	}
	if (!isFinite(left) || right <= left || bottom <= top) return null;
	// Marge : 1px autour pour l'anti-aliasing des glyphes.
	return { x: left - 1, y: top - 1, width: right - left + 2, height: bottom - top + 2 };
}

// Capture bitmap (encre seule, fond transparent) d'une PLAGE de glyphes du rendu
// natif, à la résolution réelle du canvas. Sert au suffixe décalé du composite.
function getGlyphRangeSnapshot(block, data, chars, cacheField) {
	const canvas = data && data.canvas;
	if (!canvas || !canvas.width || !data.viewportWidth) return null;
	const rect = glyphRangeInkRect(chars);
	if (!rect) return null;
	const sx = canvas.width / data.viewportWidth;
	const sy = canvas.height / data.viewportHeight;
	const key = `${chars.map((ch) => ch.index).join(',')}@${Math.round(rect.x * 10)},${Math.round(rect.y * 10)},${Math.round(rect.width * 10)}x${Math.round(rect.height * 10)}#${Math.round(sx * 100)}`;
	const cached = block[cacheField];
	if (cached && cached.key === key) return { url: cached.url, rect };
	try {
		const off = document.createElement('canvas');
		off.width = Math.max(1, Math.round(rect.width * sx));
		off.height = Math.max(1, Math.round(rect.height * sy));
		const octx = off.getContext('2d', { willReadFrequently: true });
		octx.drawImage(canvas, rect.x * sx, rect.y * sy, rect.width * sx, rect.height * sy, 0, 0, off.width, off.height);
		whiteToAlphaCanvas(octx, off.width, off.height);
		const url = off.toDataURL('image/png');
		block[cacheField] = { key, url };
		return { url, rect };
	} catch (error) {
		console.warn('Glyph range snapshot failed', error);
		return null;
	}
}

// Ligne de base NATIVE du bloc (coordonnées page), dérivée directement des
// boîtes SERRÉES des glyphes sans jambage : le bas d'encre d'un « x », « a »,
// chiffre… EST la ligne de base, au pixel près, quelle que soit la police du
// document. Beaucoup plus fiable que d'estimer un ascent avec la police de
// substitution (métriques différentes → insertion décalée verticalement).
// Médiane pour rester robuste aux exposants/indices éventuels.
const COMPOSITE_BASELINE_SAFE = /^[a-fh-ik-or-xzA-PR-Z0-9]$/;
function nativeGlyphBaseline(block) {
	if (!Array.isArray(block.pdfChars)) return null;
	const bottoms = [];
	for (const ch of block.pdfChars) {
		if (!ch.text || !COMPOSITE_BASELINE_SAFE.test(ch.text)) continue;
		const y = typeof ch.maskY === 'number' ? ch.maskY : ch.y;
		const h = ch.maskHeight > 0 ? ch.maskHeight : ch.height;
		if (!(h > 0)) continue;
		bottoms.push(y + h);
	}
	if (!bottoms.length) return null;
	bottoms.sort((a, b) => a - b);
	return bottoms[Math.floor(bottoms.length / 2)];
}

// Ligne de base pour poser l'INSERTION composite : glyphes natifs d'abord
// (exact), sinon repli sur l'estimation par encre de substitution.
function compositeBaseline(block, font) {
	const native = nativeGlyphBaseline(block);
	if (native != null) return native;
	const inkBox = textInkBox(block);
	const sample = String(block.originalText || '').trim();
	if (!inkBox || !sample) return null;
	const ink = measureTextInk(sample, font.css);
	if (!ink || !(ink.ascent > 0)) return null;
	return inkBox.top + ink.ascent;
}

// Position verticale (top CSS) d'un rendu HTML pour que sa LIGNE DE BASE tombe
// pile sur celle du texte natif : depuis la baseline native, on remonte de
// demi-interligne + ascent de police (formule WebKit, cf. htmlInkTopOffset).
function compositeInsertTop(block, font) {
	const baseline = compositeBaseline(block, font);
	if (baseline == null) return null;
	// Mémoïsé : ne dépend que de la police et de la baseline — pas du texte tapé.
	const key = `${font.css}|${Math.round(baseline * 10)}`;
	if (block._compInsertTop && block._compInsertTop.key === key) {
		return block._compInsertTop.value;
	}
	const ctx = inkMeasureCanvas().getContext('2d', { willReadFrequently: true });
	ctx.font = font.css;
	const metrics = ctx.measureText('Hxg');
	const fontAscent = metrics.fontBoundingBoxAscent || 0;
	const fontDescent = metrics.fontBoundingBoxDescent || 0;
	if (!(fontAscent > 0)) return null;
	const lineHeight = font.fs; // line-height: 1 sur l'insertion
	const top = baseline - ((lineHeight - (fontAscent + fontDescent)) / 2 + fontAscent);
	const value = Number.isFinite(top) ? top : null;
	block._compInsertTop = { key, value };
	return value;
}

// Rend les artefacts visuels du composite dans l'editLayer : masques des glyphes
// remplacés + suffixe, tranche bitmap du suffixe décalée, texte inséré en HTML.
// Appelé par le rendu classique ET par le fast path (les artefacts sont détruits
// à chaque clearEditLayerForPage, comme les masques).
function renderGlyphCompositeArtifacts(editLayer, block, data, composite) {
	for (const ch of composite.replacedChars) appendGlyphMask(editLayer, ch, block);

	// Suffixe : masqué + re-dessiné décalé UNIQUEMENT si le décalage est
	// perceptible (≥ 0.5px). Sinon (ex. « 5 » → « 6 », même largeur), on laisse
	// les glyphes natifs intacts : perturbation minimale, comme Adobe. Si la
	// capture échoue (canvas indisponible), on laisse aussi le natif en place
	// plutôt que de masquer sans redessiner (pas de trou dans le texte).
	if (composite.suffixChars.length && Math.abs(composite.dx) >= 0.5) {
		const snap = getGlyphRangeSnapshot(block, data, composite.suffixChars, '_compSuffixSnap');
		if (snap) {
			for (const ch of composite.suffixChars) appendGlyphMask(editLayer, ch, block);
			const img = document.createElement('img');
			img.src = snap.url;
			img.className = 'glyph-composite-artifact glyph-composite-suffix';
			img.dataset.compositeFor = block.id;
			img.draggable = false;
			img.alt = '';
			img.style.left = `${snap.rect.x + composite.dx}px`;
			img.style.top = `${snap.rect.y}px`;
			img.style.width = `${snap.rect.width}px`;
			img.style.height = `${snap.rect.height}px`;
			editLayer.append(img);
		}
	}

	if (composite.inserted) {
		const font = composite.font;
		const span = document.createElement('div');
		span.className = 'glyph-composite-artifact glyph-composite-insert';
		span.dataset.compositeFor = block.id;
		span.textContent = composite.inserted;
		span.style.fontFamily = font.family;
		span.style.fontWeight = font.weight;
		span.style.fontStyle = font.style;
		span.style.fontSize = `${font.fs}px`;
		span.style.color = block.color || '#161616';
		if (block.underline) span.style.textDecoration = 'underline';
		span.style.left = `${composite.insertX}px`;
		const top = compositeInsertTop(block, font);
		// Repli : aligné sur le haut d'encre si la mesure de baseline échoue.
		const inkBox = textInkBox(block);
		span.style.top = `${top != null ? top : inkBox ? inkBox.top : block.originalY}px`;
		editLayer.append(span);
	}
}

// Police du document indisponible localement (ni embarquée métrique-compatible,
// ni installée, ni chargée) : les caractères ajoutés utilisent une police
// approchante → badge d'avertissement jaune façon Adobe.
function blockFontUnavailable(block) {
	if (!block || block.kind === 'image') return false;
	// Édition NATIVE : le moteur a signalé que des caractères insérés n'ont pas
	// de glyphe dans la police embarquée (sous-ensemble) → badge d'avertissement.
	if (block.nativeGlyphWarning) return true;
	if (!block.fontName) return false;
	if (metricCompatibleFamily(block.fontName)) return false;
	const base = baseFamilyName(cleanFontName(block.fontName));
	if (!base) return true;
	if (_systemFontSet.has(base.toLowerCase())) return false;
	try {
		if (document.fonts && document.fonts.check(`12px "${base}"`)) return false;
	} catch (_err) {
		// check() peut jeter sur un nom exotique → considéré indisponible.
	}
	return true;
}

function appendFontWarningBadge(editLayer, block, visualBox) {
	const base = baseFamilyName(cleanFontName(block.fontName)) || 'inconnue';
	const badge = document.createElement('div');
	badge.className = 'font-warning-badge';
	badge.textContent = '!';
	badge.title = `Police « ${base} » non disponible sur cet ordinateur. Le texte d'origine est préservé tel quel ; les caractères ajoutés utilisent une police approchante. Installez la police pour une correspondance exacte.`;
	const x = (visualBox?.x ?? block.x) + (visualBox?.width ?? block.width);
	const y = visualBox?.y ?? block.y;
	badge.style.left = `${x + 8}px`;
	badge.style.top = `${y - 2}px`;
	editLayer.append(badge);
}

function normalizeDocText(value) {
	return String(value || '')
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase();
}

function classifyDocumentFromBlocks(blocks) {
	const text = normalizeDocText(blocks.map((block) => block.text || '').join('\n'));
	const score = (terms) => terms.reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0);
	const invoice = score(['facture', 'invoice', 'total ht', 'total ttc', 'tva', 'siret', 'siren']);
	const credit = score(['avoir', 'credit note', 'note de credit']);
	const receipt = score(['recu', 'ticket', 'receipt', 'paiement recu']);
	const quote = score(['devis', 'quote', 'bon pour accord']);
	const contract = score(['contrat', 'contract', 'conditions generales', 'signature']);
	const statement = score(['releve', 'statement', 'solde', 'iban', 'bic']);
	const candidates = [
		{ type: 'credit_note', score: credit + (invoice > 0 ? 1 : 0) },
		{ type: 'invoice', score: invoice },
		{ type: 'receipt', score: receipt },
		{ type: 'quote', score: quote },
		{ type: 'contract', score: contract },
		{ type: 'statement', score: statement }
	].sort((a, b) => b.score - a.score);
	const best = candidates[0];
	const confidence = Math.min(100, Math.max(0, best.score * 18));
	const diagnostic = blocks.some((b) => b.source === 'ocr')
		? (blocks.some((b) => b.source !== 'ocr') ? 'mixed' : 'probable_scan')
		: (blocks.length ? 'native_text' : 'image_only');
	return {
		type: best.score >= 2 ? best.type : 'other',
		confidence,
		diagnostic
	};
}

function detectFieldKind(text, documentType = 'other') {
	const value = normalizeDocText(text);
	const raw = String(text || '');
	if (/\bFR[0-9A-Z]{2}\s?[0-9]{9}\b/i.test(raw)) return 'vat_id';
	if (/\b(?:siret|siren)\b/.test(value) || /\b\d{3}\s?\d{3}\s?\d{3}(?:\s?\d{5})?\b/.test(raw)) return 'company_id';
	if (/\bFR\d{2}(?:\s?[0-9A-Z]{4}){5}\s?[0-9A-Z]{3}\b/i.test(raw) || /\biban\b/.test(value)) return 'iban';
	if (/\b(?:tva|vat)\b/.test(value)) return 'tax';
	if (/\b(?:total|ttc|net a payer|amount due)\b/.test(value)) return 'total';
	if (/\b(?:date|emission|echeance|due date)\b/.test(value) || /\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b/.test(raw)) return 'date';
	if (/\b(?:facture|invoice|avoir|devis|quote)\s*(?:n|no|numero|#)?/i.test(raw)) return 'document_number';
	if (['invoice', 'credit_note', 'receipt', 'quote'].includes(documentType) && /\b(?:client|customer|fournisseur|supplier)\b/.test(value)) return 'party';
	return null;
}

function fieldLabel(kind) {
	return ({
		document_number: 'Numéro',
		date: 'Date',
		total: 'Total',
		tax: 'TVA',
		company_id: 'SIRET/SIREN',
		vat_id: 'TVA intracom',
		iban: 'IBAN',
		party: 'Tiers'
	})[kind] || 'Champ';
}

function isCriticalField(kind) {
	return ['document_number', 'date', 'total', 'tax', 'company_id', 'vat_id', 'iban', 'party'].includes(kind);
}

function annotateBlockIntelligence(blocks) {
	const documentInfo = classifyDocumentFromBlocks(blocks);
	for (const block of blocks) {
		const source = block.source || 'pdf-text';
		const sourceConfidence = source === 'ocr'
			? Math.max(0, Math.min(100, Number(block.confidence ?? 70)))
			: source === 'pdf-text'
				? 78
				: 96;
		const fieldKind = detectFieldKind(block.text, documentInfo.type);
		block.source = source;
		block.confidence = sourceConfidence;
		block.documentType = documentInfo.type;
		block.documentConfidence = documentInfo.confidence;
		block.documentDiagnostic = documentInfo.diagnostic;
		block.fieldKind = fieldKind;
		block.critical = Boolean(fieldKind && isCriticalField(fieldKind));
		block.diagnostics = [
			source === 'ocr' && sourceConfidence < 70 ? 'low_confidence_ocr' : null,
			fieldKind ? `field:${fieldKind}` : null,
			block.critical ? 'critical_field' : null
		].filter(Boolean);
	}
	return documentInfo;
}

function blockOverlapRatio(a, b) {
	const left = Math.max(a.x, b.x);
	const top = Math.max(a.y, b.y);
	const right = Math.min(a.x + a.width, b.x + b.width);
	const bottom = Math.min(a.y + a.height, b.y + b.height);
	if (right <= left || bottom <= top) return 0;
	const area = (right - left) * (bottom - top);
	const minArea = Math.max(1, Math.min(a.width * a.height, b.width * b.height));
	return area / minArea;
}

function mergeAnalysisSources(existingBlocks, incomingBlocks) {
	const merged = [...existingBlocks];
	for (const block of incomingBlocks) {
		const duplicate = merged.find((candidate) =>
			candidate.page === block.page &&
			candidate.kind === block.kind &&
			normalizeDocText(candidate.text) === normalizeDocText(block.text) &&
			blockOverlapRatio(candidate, block) > 0.65
		);
		if (duplicate) {
			duplicate.confidence = Math.max(Number(duplicate.confidence || 0), Number(block.confidence || 0));
			duplicate.diagnostics = Array.from(new Set([...(duplicate.diagnostics || []), ...(block.diagnostics || []), 'source_merged']));
			continue;
		}
		merged.push(block);
	}
	return merged;
}

function glyphMaskRect(ch, block = null) {
	const mx = ch.maskX ?? ch.x;
	const my = ch.maskY ?? ch.y;
	const mw = Math.max(0.5, ch.maskWidth ?? ch.width ?? 0);
	const mh = Math.max(0.5, ch.maskHeight ?? ch.height ?? 0);
	const fontSize = Math.max(6, block?.pdfFontSize || block?.baseFontSize || mh);
	const boldBoost = block?.bold || block?.visualBold ? 0.35 : 0;
	const side = Math.min(1.2, Math.max(0.55, fontSize * 0.045 + boldBoost));
	// Marge haute ≥ 1.4px : l'anti-crénelage du glyphe déborde au-dessus de sa
	// boîte d'encre et l'arrondi DOM peut décaler le masque de 0.5px — trop
	// serré, le SOMMET des lettres restait visible après déplacement du bloc.
	const top = Math.min(2.5, Math.max(1.4, fontSize * 0.08 + boldBoost));
	const bottom = Math.min(2.2, Math.max(1.2, fontSize * 0.085 + boldBoost));
	return {
		x: Math.max(0, mx - side),
		y: Math.max(0, my - top),
		width: mw + side * 2,
		height: mh + top + bottom
	};
}

function appendGlyphMask(editLayer, ch, block) {
	// Un blanc (espace réel ou synthétique) n'a AUCUNE encre : le masquer
	// n'efface que ce qui passe dessous (trait de tableau entre deux colonnes).
	if (!stripWhitespace(ch?.text || '').length) return;
	const rect = glyphMaskRect(ch, block);
	const glyphMask = document.createElement('div');
	glyphMask.className = 'edit-block-mask glyph-mask';
	glyphMask.style.left = `${rect.x}px`;
	glyphMask.style.top = `${rect.y}px`;
	glyphMask.style.width = `${rect.width}px`;
	glyphMask.style.height = `${rect.height}px`;
	editLayer.append(glyphMask);
}

// Badge de fiabilité discret posé sur le bloc sélectionné : indique l'origine
// du texte (PDF natif vs OCR) et signale une confiance OCR faible. Purement
// informatif (pointer-events: none côté CSS) ; n'altère pas la géométrie.
function appendBlockQualityBadge(editLayer, block) {
	if (!block || block.kind === 'image') return;
	const isOcr = block.source === 'ocr';
	const confidence = typeof block.confidence === 'number' ? block.confidence : 100;
	let label;
	let cls;
	if (block.critical && block.fieldKind) {
		label = `Critique · ${fieldLabel(block.fieldKind)}`;
		cls = 'badge-low';
	} else if (block.fieldKind) {
		label = fieldLabel(block.fieldKind);
		cls = 'badge-native';
	} else if (isOcr && confidence < 70) {
		label = 'OCR · confiance faible';
		cls = 'badge-low';
	} else if (isOcr) {
		label = 'OCR';
		cls = 'badge-ocr';
	} else {
		label = 'PDF natif';
		cls = 'badge-native';
	}
	const badge = document.createElement('div');
	badge.className = `edit-block-badge ${cls}`;
	badge.textContent = label;
	badge.style.left = `${block.x}px`;
	badge.style.top = `${Math.max(0, block.y - 16)}px`;
	editLayer.append(badge);
}

function shouldPreserveTextElement(block) {
	return block && block.kind !== 'image' && !block.hidden && isLiveTextBlock(block);
}

function clearEditLayerForPage(editLayer, pageNumber) {
	const preserved = new Map();
	const preserveIds = new Set(
		state.editBlocks
			.filter((block) => block.page === pageNumber && shouldPreserveTextElement(block))
			.map((block) => block.id)
	);
	for (const child of Array.from(editLayer.children)) {
		if (child.classList?.contains('edit-block')) {
			const id = child.getAttribute('data-block-id');
			if (id && preserveIds.has(id)) {
				// POINT 3 : on NE secoue PAS le node préservé (pas de display:none, pas
				// de remove, pas de réordonnancement). Sous WebKit, masquer/ré-attacher
				// un node détruit sa backing layer => re-rasterisation du texte. On le
				// laisse exactement en place : seul `transform` le déplacera ensuite.
				preserved.set(id, child);
				continue;
			}
		}
		child.remove();
	}
	return preserved;
}

// ─── Couche composite persistante pour le texte MODIFIÉ ──────────────────────
// Un bloc modifié est rasterisé UNE seule fois (au montage), puis n'est plus
// jamais re-stylé / re-mesuré / ré-attaché : il est seulement déplacé par
// `transform: translate3d` entier (compositeur GPU) = zéro re-rasterisation,
// zéro flou, zéro snap. C'est le comportement déjà net des blocs natifs, étendu
// à tout le cycle de vie d'un bloc modifié.

// Signature de CONTENU/STYLE (PAS la position) : tant qu'elle ne change pas, le
// node monté est réutilisé tel quel. Toute vraie modif (texte, police, taille,
// couleur, gras…) la fait changer => re-montage unique. Le déplacement (x/y)
// n'y figure pas => bouger ne re-rasterise jamais.
function editedBlockSignature(block) {
	return [
		block.text || '',
		block.html || '',
		block.htmlEdited ? 1 : 0,
		block.fontFamilyOverride || '',
		block.fontSizeOverride || '',
		block.baseFontSize || '',
		block.color || '',
		block.boldOverride,
		block.italicOverride,
		block.underline ? 1 : 0,
		block.align || '',
		block.multiline ? 1 : 0,
		block.listType || '',
		block.bold ? 1 : 0,
		block.visualBold ? 1 : 0,
		block.fontName || '',
		// Géométrie de BOÎTE (pas la position) : un resize par poignées change
		// width/height sans toucher au contenu → sans ces champs, le fast path
		// réutilisait le node à l'ancienne taille et le resize ne suivait plus.
		// x/y restent exclus : déplacer ne re-rasterise jamais.
		block.boxResized ? 1 : 0,
		Math.round(block.width || 0),
		Math.round(block.height || 0)
	].join('\u0001');
}

// Transform unique : delta ENTIER depuis l'origine de montage. Même formule
// pendant le nudge, le drag et le commit => aucun désaccord, aucun snap.
function editedBlockTransform(block) {
	if (!block._mounted) return 'translateZ(0)';
	const tdx = Math.round(block.x - (block._mountX ?? block.x));
	const tdy = Math.round(block.y - (block._mountY ?? block.y));
	return tdx || tdy ? `translate3d(${tdx}px, ${tdy}px, 0)` : 'translateZ(0)';
}

// Masques blancs (texte PDF d'origine) pour un bloc modifié. Ils restent à la
// position d'ORIGINE (ils ne suivent pas le bloc) : ce sont de simples rectangles
// sans glyphes, donc les recréer à chaque rendu ne provoque aucun flou de texte.
function appendEditedBlockMasks(editLayer, block) {
	// Un bloc ajouté n'a aucun glyphe PDF sous-jacent à effacer.
	if (block.added) return;
	const originalChars = Array.isArray(block.pdfChars) ? block.pdfChars : [];
	if (originalChars.length) {
		for (const ch of originalChars) appendGlyphMask(editLayer, ch, block);
		return;
	}
	const mask = document.createElement('div');
	mask.className = 'edit-block-mask';
	mask.style.left = `${(block.originalX ?? block.x) - 1.5}px`;
	mask.style.top = `${(block.originalY ?? block.y) - 1.5}px`;
	mask.style.width = `${Math.max(block.width, block.originalWidth || block.width, 18) + 3}px`;
	mask.style.height = `${Math.max(block.height, block.originalHeight || block.height, 14) + 3}px`;
	editLayer.append(mask);
}

// Réutilise un bloc modifié déjà monté : on ne touche QUE le transform et les
// classes d'état chrome (selected/editing) + on (re)pose les écouteurs et les
// éléments séparés (masques, poignées). Le node texte lui-même n'est ni re-écrit,
// ni re-stylé, ni ré-attaché.
function syncMountedEditedBlock(editLayer, block, el) {
	// Composite (glyphes préservés) : masques partiels + artefacts (suffixe
	// bitmap, insertion HTML) au lieu du masquage complet. Les artefacts sont
	// détruits à chaque clearEditLayerForPage → recréés ici comme les masques.
	const composite = glyphCompositeInfo(block);
	if (composite) {
		const data = getPageData(block.page);
		if (data) renderGlyphCompositeArtifacts(editLayer, block, data, composite);
	} else {
		appendEditedBlockMasks(editLayer, block);
	}

	const isEditing = block.id === state.editingBlockId;
	const isSelected = isBlockSelected(block);
	const wasEditing = el.classList.contains('editing');

	el.style.display = '';
	el.classList.toggle('selected', isSelected);
	el.classList.toggle('editing', isEditing);
	el.style.transform = editedBlockTransform(block);
	// Couche compositor dédiée UNIQUEMENT quand le bloc peut bouger (sélectionné /
	// en édition). La garder sur tous les blocs montés accumulait une couche GPU
	// par bloc indéfiniment (mémoire) sur les gros documents.
	el.style.willChange = isSelected || isEditing ? 'transform' : '';

	resetEditBlockListeners(el);
	if (isEditing) {
		enterEditingMode(el, block);
	} else {
		if (wasEditing) exitEditingMode(el);
		bindIdleBlockListeners(el, block);
	}

	// POINT 3 : on n'ajoute au layer QUE si le node n'y est pas (jamais de
	// réordonnancement, qui détruirait la backing layer => re-rasterisation).
	if (el.parentElement !== editLayer) editLayer.append(el);

	if (isSelected && !isEditing && block.kind !== 'image') {
		const tdx = Math.round(block.x - (block._mountX ?? block.x));
		const tdy = Math.round(block.y - (block._mountY ?? block.y));
		const visualBox = {
			x: (block._mountLeft ?? block.x) + tdx,
			y: (block._mountTop ?? block.y) + tdy,
			width: Number.parseFloat(el.style.width) || Math.max(block.width, 18),
			height: Number.parseFloat(el.style.height) || Math.max(block.height, 14)
		};
		appendTextHandles(editLayer, block, visualBox);
		if (blockFontUnavailable(block)) {
			appendFontWarningBadge(editLayer, block, visualBox);
		}
	}
}

// Place le caret là où l'utilisateur a cliqué (double-clic). Plus intuitif et
// sans course rAF que de forcer la fin du texte. Retourne false si impossible.
function placeCaretAtPoint(element, x, y) {
	if (typeof document.caretRangeFromPoint !== 'function') return false;
	const range = document.caretRangeFromPoint(x, y);
	if (!range || !element.contains(range.startContainer)) return false;
	const selection = window.getSelection();
	if (!selection) return false;
	range.collapse(true);
	selection.removeAllRanges();
	selection.addRange(range);
	return true;
}

// Écouteurs d'un bloc EN ÉDITION (extraits du rendu pour pouvoir entrer en
// édition sans reconstruire le DOM — point 6). L'appelant a déjà fait
// resetEditBlockListeners(element).
function setEditableTextSelection(element, start, end) {
	const textLength = element.textContent?.length || 0;
	const from = Math.max(0, Math.min(Math.min(start, end), textLength));
	const to = Math.max(from, Math.min(Math.max(start, end), textLength));
	if (from === to) {
		placeCaretAtTextOffset(element, from);
		return true;
	}
	return restoreInlineSelectionOffsets(element, { start: from, end: to });
}

function clientPointToNativePagePoint(block, clientX, clientY) {
	const data = getPageData(block.page);
	const rect = data?.editLayer?.getBoundingClientRect();
	if (!rect) return null;
	const { dx, dy } = blockMoveDelta(block);
	return {
		x: clientX - rect.left - dx,
		y: clientY - rect.top - dy
	};
}

function enterEditingMode(element, block) {
	element.contentEditable = 'true';
	element.spellcheck = false;
	// Neutralise les substitutions macOS (autocorrection, double-espace →
	// point, guillemets typographiques) qui parasitent l'édition de texte PDF.
	element.setAttribute('autocorrect', 'off');
	element.setAttribute('autocapitalize', 'off');
	element.setAttribute('autocomplete', 'off');
	// Le glisser de sélection WebKit utilise les métriques de la police HTML
	// transparente. Sur les blocs natifs (glyphes PDF à l'écran), on pilote
	// caret + sélection exclusivement via les boîtes PDFium.
	let suppressNativeClickRecenter = false;
	bindEditBlockListener(element, 'pointerdown', (event) => {
		event.stopPropagation();
		if (event.button !== 0) return;
		const text = element.textContent || '';
		const lines = nativeCaretLines(block, text);
		if (!lines) return;
		// detail >= 2 : laisser le dblclick gérer la sélection de mot.
		if (event.detail >= 2) {
			event.preventDefault();
			return;
		}
		const startPoint = clientPointToNativePagePoint(block, event.clientX, event.clientY);
		if (!startPoint) return;
		const focusAtDown = pdfTextOffsetFromPoint(lines, startPoint.x, startPoint.y);
		if (focusAtDown == null) return;
		event.preventDefault();
		element.focus({ preventScroll: true });
		let anchor = focusAtDown;
		if (event.shiftKey) {
			const existing = selectionTextRange(element);
			const caret = caretTextOffset(element);
			if (existing) {
				const nearerStart =
					Math.abs(focusAtDown - existing.start) <= Math.abs(focusAtDown - existing.end);
				anchor = nearerStart ? existing.end : existing.start;
			} else if (caret != null) {
				anchor = caret;
			}
		}
		setEditableTextSelection(element, anchor, focusAtDown);
		scheduleNativeCaretUpdate();
		updatePreciseSelection();
		let dragged = false;
		const onMove = (moveEvent) => {
			if ((moveEvent.buttons & 1) === 0) return;
			const endPoint = clientPointToNativePagePoint(block, moveEvent.clientX, moveEvent.clientY);
			if (!endPoint) return;
			const focus = pdfTextOffsetFromPoint(lines, endPoint.x, endPoint.y);
			if (focus == null) return;
			setEditableTextSelection(element, anchor, focus);
			if (anchor !== focus) dragged = true;
			scheduleNativeCaretUpdate();
			updatePreciseSelection();
		};
		const onUp = () => {
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
			if (dragged) suppressNativeClickRecenter = true;
			updatePreciseSelection();
		};
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
	});
	bindEditBlockListener(element, 'dblclick', (event) => {
		event.stopPropagation();
		const text = element.textContent || '';
		const lines = nativeCaretLines(block, text);
		if (!lines) return;
		event.preventDefault();
		const point = clientPointToNativePagePoint(block, event.clientX, event.clientY);
		if (!point) return;
		const offset = pdfTextOffsetFromPoint(lines, point.x, point.y);
		if (offset == null) return;
		const bounds = wordBoundsAtTextOffset(text, offset);
		suppressNativeClickRecenter = true;
		setEditableTextSelection(element, bounds.start, bounds.end);
		scheduleNativeCaretUpdate();
		updatePreciseSelection();
	});
	bindEditBlockListener(element, 'click', (event) => {
		// On laisse le caret NATIF du contenteditable se placer là où
		// l'utilisateur clique : c'est lui qui pilote l'insertion. Aucun
		// re-render ici (sinon le caret natif retomberait au début du bloc).
		event.stopPropagation();
		if (suppressNativeClickRecenter) {
			suppressNativeClickRecenter = false;
			return;
		}
		// Bloc vierge : WebKit vient de placer le caret avec les métriques de la
		// police de substitution → il peut retomber du mauvais côté de la lettre
		// visée. On le recale sur la frontière de glyphe NATIVE la plus proche du
		// clic. Jamais quand une sélection est ouverte (on la détruirait).
		const sel = window.getSelection();
		if (sel && sel.isCollapsed && !isBlockTextEdited(block)) {
			const offset = nativeTextOffsetFromClientPoint(
				block,
				element.textContent || '',
				event.clientX,
				event.clientY
			);
			if (offset != null) placeCaretAtTextOffset(element, offset);
		}
	});
	bindEditBlockListener(element, 'keydown', (event) => {
		// Cmd/Ctrl+A dans un bloc PDF doit sélectionner explicitement TOUT le
		// contenu du bloc actif. WebKit arrêtait parfois la sélection avant les
		// derniers glyphes transparents du mode natif, notamment quand les zones
		// de redimensionnement recouvraient visuellement la fin du mot.
		if (
			(event.metaKey || event.ctrlKey) &&
			!event.altKey &&
			!event.shiftKey &&
			event.key.toLowerCase() === 'a'
		) {
			event.preventDefault();
			event.stopPropagation();
			selectAllEditableText(element);
			return;
		}
		// Mode glyphe : bloc vierge OU composite (glyphes préservés). Chaque frappe
		// passe par commitGlyphEdit → block.text à jour → composite re-rendu. On ne
		// bascule en édition HTML classique que si le composite devient impossible.
		const glyphMode = isGlyphEditRouted(block);
		if (
			!glyphMode &&
			event.key.length === 1 &&
			!event.metaKey &&
			!event.ctrlKey &&
			!event.altKey &&
			selectionTextRange(element)
		) {
			event.preventDefault();
			event.stopPropagation();
			replaceEditedTextRange(element, block, event.key);
			return;
		}
		// Espace en mode TEXTE (bloc déjà réécrit) : on insère l'espace nous-mêmes
		// pour neutraliser la substitution macOS « double-espace → point ». En
		// mode glyphe, l'espace est déjà géré plus bas (commitGlyphEdit).
		if (
			!glyphMode &&
			event.key === ' ' &&
			!event.metaKey &&
			!event.ctrlKey &&
			!event.altKey
		) {
			event.preventDefault();
			event.stopPropagation();
			insertPlainTextAtCaret(element, ' ');
			if (!block.inlineEditDirty) {
				ensureEditMask(element, block);
				element.classList.remove('editing-pristine');
			}
			block.inlineEditDirty = true;
			resizeEditingElementToContent(element, block);
			return;
		}
		// Entrée dans une liste (mode texte) : auto-continuation. On insère le
		// marqueur suivant (• ou « N. »), ou on sort de la liste si la ligne
		// courante est un marqueur vide. Shift+Entrée reste un saut natif.
		if (
			block.listType &&
			!glyphMode &&
			event.key === 'Enter' &&
			!event.shiftKey &&
			!event.metaKey &&
			!event.ctrlKey &&
			!event.altKey
		) {
			event.preventDefault();
			event.stopPropagation();
			const text = (element.textContent || '').replace(/\r\n?/g, '\n');
			const caret = caretTextOffset(element);
			const at = caret == null ? text.length : caret;
			const { newText, newCaret } = listEnter(text, at, block.listType);
			commitGlyphEdit(block, newText, newCaret);
			return;
		}
		// Entrée en mode TEXTE (hors liste) : on insère un vrai saut de ligne
		// nous-mêmes. Le comportement natif du contenteditable (insertion d'un
		// <div>/<br>) est incohérent ici (le caret bouge mais le \n n'est pas
		// fiable), donc on pilote l'insertion comme pour l'espace.
		if (
			!glyphMode &&
			event.key === 'Enter' &&
			!event.metaKey &&
			!event.ctrlKey &&
			!event.altKey
		) {
			event.preventDefault();
			event.stopPropagation();
			insertPlainTextAtCaret(element, '\n');
			block.multiline = true;
			element.classList.add('multiline');
			if (!block.inlineEditDirty) {
				ensureEditMask(element, block);
				element.classList.remove('editing-pristine');
			}
			block.inlineEditDirty = true;
			resizeEditingElementToContent(element, block);
			return;
		}
		// Suppr/Retour sont gérés par le handler document (phase capture)
		// pour qu'un seul chemin pilote la suppression. Les flèches restent
		// natives : le caret natif est la source de vérité de la position.
		// Entrée sur texte PDF natif : interdit (sinon repli HTML = lignes vides
		// sous les montants). L'atome d'édition reste une seule ligne.
		if (
			glyphMode &&
			event.key === 'Enter' &&
			!event.metaKey &&
			!event.ctrlKey &&
			!event.altKey &&
			nativeTextEditEligible(block)
		) {
			event.preventDefault();
			event.stopPropagation();
			setStatus(
				currentLocale() === 'fr'
					? 'Ajout de ligne non supporté sur ce texte PDF.'
					: 'Adding lines is not supported on this PDF text.',
				'info'
			);
			return;
		}
		// Frappe d'un caractère / Entrée en mode glyphe : on insère à l'offset
		// du caret NATIF dans block.text (ce que l'utilisateur voit), puis on
		// bascule le bloc en édition texte. Une sélection est remplacée.
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
			const range = selectionTextRange(element);
			if (range) {
				commitGlyphEdit(
					block,
					block.text.slice(0, range.start) + typed + block.text.slice(range.end),
					range.start + typed.length
				);
			} else {
				const off = caretTextOffset(element);
				const at = off == null ? block.text.length : off;
				commitGlyphEdit(
					block,
					block.text.slice(0, at) + typed + block.text.slice(at),
					at + typed.length
				);
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
	bindEditBlockListener(element, 'paste', (event) => {
		event.preventDefault();
		event.stopPropagation();
		const raw =
			(event.clipboardData && event.clipboardData.getData('text/plain')) || '';
		if (!raw) return;
		// Les copies de ligne unique embarquent souvent un \n final : il
		// créerait un <br> vide (= ligne en trop qui pousse le contenu hors
		// du cadre). On le retire quand on remplace une sélection sur place.
		const clean = raw.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
		const glyphMode = isGlyphEditRouted(block);
		if (glyphMode) {
			// Mode glyphe (texte PDF non ré-écrit) : on insère dans block.text à
			// l'offset du caret NATIF. Sélection présente => remplacement.
			const range = selectionTextRange(element);
			if (range) {
				commitGlyphEdit(
					block,
					block.text.slice(0, range.start) + clean + block.text.slice(range.end),
					range.start + clean.length
				);
			} else {
				const off = caretTextOffset(element);
				const at = off == null ? block.text.length : off;
				commitGlyphEdit(
					block,
					block.text.slice(0, at) + clean + block.text.slice(at),
					at + clean.length
				);
			}
			return;
		}
		replaceEditedTextRange(element, block, clean);
	});
	bindEditBlockListener(element, 'input', () => {
		// Bloc routé « glyphe » (vierge ou composite) : les frappes passent par
		// commitGlyphEdit (keydown preventDefault) et ne génèrent pas d'input.
		// Si un input natif arrive quand même (IME, dictée), on NE pose PAS le
		// masque complet : il peindrait un rectangle blanc sur les glyphes natifs
		// préservés du composite.
		if (isGlyphEditRouted(block)) return;
		const firstEdit = !block.inlineEditDirty;
		block.inlineEditDirty = true;
		if (isAddedTextBlock(block)) {
			block.text = (element.innerText || element.textContent || '').replace(/\r\n?/g, '\n');
			block.emptyPlaceholder = !(block.text || '').trim();
			element.classList.remove('added-empty');
			const inkColor = block.color || '#111111';
			element.style.color = inkColor;
			element.style.webkitTextFillColor = inkColor;
			element.style.caretColor = inkColor;
		}
		if (firstEdit) {
			// Première frappe : on masque le PDF et on rend notre texte opaque.
			// On garde le letter-spacing calé sur la largeur du PDF pour que
			// l'apparence reste identique (sinon le texte "bouge" en éditant).
			ensureEditMask(element, block);
			element.classList.remove('editing-pristine');
		}
		resizeEditingElementToContent(element, block);
	});
	bindEditBlockListener(element, 'blur', () => {
		// Juste après pose d'un champ ajouté, le panneau latéral peut voler le
		// focus : on le récupère au lieu de sortir d'édition (Aa gris au repos).
		if (
			isAddedTextBlock(block) &&
			Number.isFinite(block._addedEditFocusGuard) &&
			Date.now() < block._addedEditFocusGuard
		) {
			requestAnimationFrame(() => element.focus({ preventScroll: true }));
			return;
		}
		finishInlineEdit(block.id, block.htmlEdited ? element.innerText : element.textContent);
	});
}

function exitEditingMode(element) {
	element.contentEditable = 'false';
	element.removeAttribute('autocorrect');
	element.removeAttribute('autocapitalize');
	element.removeAttribute('autocomplete');
}

// Entre en édition texte. Images / logos : sélection seule.
// Ne pas dépendre de l'événement `click` : un micro-drag (3 px) re-rend le DOM
// et tue le click → cadre bleu, texte non modifiable.
function beginTextEdit(block, event) {
	if (!block || block.kind === 'image') {
		if (block) selectEditBlock(block.id);
		return false;
	}
	if (isLogoBlock(block)) {
		selectEditBlock(block.id);
		return false;
	}
	_lastBlockClick = { id: null, time: 0 };
	ensureEditModeForAddedText();
	startInlineEdit(block.id, {
		caretX: event?.clientX,
		caretY: event?.clientY
	});
	return true;
}

// 1 clic : sélection (flèches / drag). 2 clics rapides : édition du texte.
function activateIdleBlock(block, event) {
	if (!block) return;
	if (!state.editMode) ensureEditModeForAddedText();
	const now = performance.now();
	const isDouble = _lastBlockClick.id === block.id && now - _lastBlockClick.time < DOUBLE_CLICK_MS;
	if (isDouble) {
		_lastBlockClick = { id: null, time: 0 };
		beginTextEdit(block, event);
		return;
	}
	_lastBlockClick = { id: block.id, time: now };
	if (isBlockSelected(block) && (state.selectedBlockIds?.length || 0) > 1) return;
	selectEditBlock(block.id);
}

// Clic sur un bloc au repos : sélection, ou édition si double-clic.
// Partagé entre le clic sur l'élément, le fond de page à proximité, et le
// relais des zones de resize (qui avalent sinon le pointerdown).
function handleIdleBlockClick(block, event) {
	if (_suppressIdleClick) {
		_suppressIdleClick = false;
		return;
	}
	activateIdleBlock(block, event);
}

// Écouteurs d'un bloc AU REPOS (sélection + double-clic pour éditer + drag).
function bindIdleBlockListeners(element, block) {
	bindEditBlockListener(element, 'click', (event) => {
		event.stopPropagation();
		handleIdleBlockClick(block, event);
	});
	// Supprime la sélection de mot native du double-clic physique (qui plaçait le
	// caret au milieu du dernier mot). On pilote le caret nous-mêmes via le clic.
	bindEditBlockListener(element, 'dblclick', (event) => {
		event.preventDefault();
	});
	bindEditBlockListener(element, 'pointerdown', (event) => startBlockDrag(event, block.id));
}

function bindEditBlockListener(element, type, handler, options = {}) {
	if (!element._slateAbortController) {
		element._slateAbortController = new AbortController();
	}
	element.addEventListener(type, handler, { ...options, signal: element._slateAbortController.signal });
}

function resetEditBlockListeners(element) {
	if (element._slateAbortController) {
		element._slateAbortController.abort();
	}
	element._slateAbortController = new AbortController();
}

function setPlainEditTextContent(element, text) {
	const value = text || '';
	if (element.childNodes.length === 1 && element.firstChild.nodeType === Node.TEXT_NODE) {
		if (element.firstChild.nodeValue !== value) element.firstChild.nodeValue = value;
		return;
	}
	element.replaceChildren(document.createTextNode(value));
}

function ensureEditModeForAddedText() {
	if (state.editMode) return;
	// Réactive Modifier sans refermer le tiroir ni relancer l'auto-détection
	// (les blocs ajoutés sont déjà là — scanEditableBlocks les conserverait).
	state.editMode = true;
	elements.app.classList.add('editing');
	elements.modifyTab.classList.add('active');
	elements.allToolsTab?.classList.remove('active');
	elements.modifyTool.classList.add('active');
}

function renderEditBlocksForPage(pageNumber) {
	const data = getPageData(pageNumber);
	if (!data) return;
	const editLayer = data.editLayer;
	const persistContent = state.editBlocks.some(
		(block) => block.page === pageNumber && isPersistedPageContent(block)
	);
	const layerOn = state.editMode || persistContent;
	editLayer.classList.toggle('active', state.editMode);
	editLayer.classList.toggle('has-content', persistContent && !state.editMode);
	editLayer.style.width = `${data.viewportWidth}px`;
	editLayer.style.height = `${data.viewportHeight}px`;
	if (!layerOn) {
		editLayer.replaceChildren();
		return;
	}
	const preservedTextElements = clearEditLayerForPage(editLayer, pageNumber);

	// Blocs supprimés (hidden) : on peint un masque blanc sur leur emplacement
	// d'origine pour que le texte PDF disparaisse réellement à l'écran (sinon il
	// reste rasterisé sous l'overlay, donnant l'impression d'un bloc « figé »).
	// Identique au masquage fait à l'export dans renderFlattenedPage.
	state.editBlocks
		.filter(
			(block) =>
				block.page === pageNumber &&
				block.hidden &&
				(state.editMode || isPersistedPageContent(block))
		)
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
		.filter(
			(block) =>
				block.page === pageNumber &&
				!block.hidden &&
				(state.editMode || isPersistedPageContent(block))
		)
		.forEach((block) => {
			// FAST PATH (couche composite persistante) : un bloc modifié déjà monté,
			// dont le CONTENU/STYLE n'a pas changé (seule la position peut varier), est
			// réutilisé tel quel. On ne touche QUE son transform et ses classes d'état.
			// Aucune réécriture de texte/police/padding, aucun append => zéro
			// re-rasterisation, donc zéro flou et zéro snap. Les blocs en rotation
			// retombent sur le rendu classique (transform rotate géré plus bas).
			const mountedEl = preservedTextElements.get(block.id);
			if (
				mountedEl &&
				block._mounted &&
				!block.rotation &&
				block.kind !== 'image' &&
				isLiveTextBlock(block) &&
				block._mountSig === editedBlockSignature(block) &&
				// Le mode composite (glyphes préservés) dépend de la POSITION (un bloc
				// déplacé perd son ancrage natif) que la signature n'inclut pas : si le
				// statut composite a changé depuis le montage, on repasse par le rendu
				// complet pour rebasculer l'affichage (transparent ↔ opaque).
				mountedEl.classList.contains('glyph-composite') === isGlyphCompositeBlock(block)
			) {
				syncMountedEditedBlock(editLayer, block, mountedEl);
				return;
			}

			const dirty = isBlockDirty(block);
			const isEditing = block.id === state.editingBlockId;
			// Édition « vierge » : on vient d'entrer en saisie sans rien modifier.
			// On NE masque PAS le texte PDF et on n'affiche pas notre rendu opaque,
			// pour qu'il n'y ait AUCUN mouvement à l'entrée (juste cadre + curseur).
			const editTouched = block.inlineEditDirty || isBlockTextEdited(block);
			const localGlyphEdited = hasLocalGlyphEdits(block);
			// Déplacement réel (position) : un bloc « glyphe tronqué » reste NATIF au repos,
			// mais dès qu'il bouge, le natif ne suit pas → on passe en BITMAP (qui suit) et
			// on masque TOUT le texte d'origine. Le glyphe supprimé est effacé du bitmap.
			const moved =
				Math.abs(block.x - (block.originalX ?? block.x)) > 0.5 ||
				Math.abs(block.y - (block.originalY ?? block.y)) > 0.5;
			const lineCount = Math.max(1, (block.text || '').split('\n').length);
			const multiline = lineCount > 1 || block.multiline === true;
			block.multiline = multiline;
			const textEdited = isBlockTextEdited(block);
			// Glyphes préservés (mode Adobe) : décomposition préfixe natif / insertion
			// HTML / suffixe bitmap décalé. Non-null => le bloc N'EST PAS ré-écrit en
			// HTML opaque : seuls les glyphes touchés sont masqués et remplacés.
			const glyphComposite = glyphCompositeInfo(block);

			if (glyphComposite) {
				renderGlyphCompositeArtifacts(editLayer, block, data, glyphComposite);
			} else if ((dirty && (!localGlyphEdited || moved)) || (isEditing && block.kind !== 'image' && editTouched)) {
				const originalChars = Array.isArray(block.pdfChars) ? block.pdfChars : [];
				if (originalChars.length) {
					// Masque SERRÉ : un petit masque par glyphe d'origine plutôt qu'un
					// gros rectangle de la cellule. La marge est un peu plus généreuse en
					// bas pour couvrir l'anti-aliasing résiduel des glyphes PDF.
					for (const ch of originalChars) {
						appendGlyphMask(editLayer, ch, block);
					}
				} else {
					// Pas de données par-glyphe : on retombe sur le rectangle d'origine
					// (évite qu'un ancien texte PDF non masqué réapparaisse sous l'édition).
					const mask = document.createElement('div');
					mask.className = 'edit-block-mask';
					mask.style.left = `${block.originalX - 1.5}px`;
					mask.style.top = `${block.originalY - 1.5}px`;
					mask.style.width = `${Math.max(block.width, block.originalWidth || block.width, 18) + 3}px`;
					mask.style.height = `${Math.max(block.height, block.originalHeight || block.height, 14) + 3}px`;
					editLayer.append(mask);
				}
			}

			if (localGlyphEdited && !moved && Array.isArray(block.pdfChars)) {
				// AU REPOS : on masque seulement les glyphes supprimés (le reste reste natif).
				// DÉPLACÉ : inutile ici, le masque complet ci-dessus couvre déjà tout.
				const hidden = hiddenCharSet(block);
				for (const ch of block.pdfChars) {
					if (!hidden.has(ch.index)) continue;
					appendGlyphMask(editLayer, ch, block);
				}
			}

			const preservedElement = preservedTextElements.get(block.id) || null;
			const element = preservedElement || document.createElement('div');
			resetEditBlockListeners(element);
			element.style.display = '';
			element.style.transform = '';
			element.style.transformOrigin = '';
			element.contentEditable = 'false';
			element.removeAttribute('autocorrect');
			element.removeAttribute('autocapitalize');
			element.removeAttribute('autocomplete');
			const isSelected = isBlockSelected(block);
			// Bloc dont SEULS des glyphes ont été masqués (aucune frappe) : hors
			// édition il ne rend aucun contenu, donc le fond blanc de `.dirty`
			// peindrait un carré vide sur le PDF. On le laisse transparent.
			const glyphOnlyIdle = localGlyphEdited && !isEditing && !isBlockTextEdited(block) && !moved;
			element.className = `edit-block ${block.kind || 'text'}${isSelected ? ' selected' : ''}${dirty && !glyphOnlyIdle ? ' dirty' : ''}${isEditing ? ' editing' : ''}${glyphComposite ? ' glyph-composite' : ''}${isAddedTextBlock(block) ? ' added' : ''}`;
			if (isEditing && Array.isArray(block.pdfChars) && block.pdfChars.length && !isBlockTextEdited(block)) {
				element.classList.add('pdf-glyph-editing');
				// Caret natif dessiné actif : le re-render vient d'écraser className,
				// on re-masque le caret WebKit TOUT DE SUITE (sinon il apparaîtrait
				// une frame, en double du caret dessiné).
				if (_nativeCaretActive) element.classList.add('native-caret-active');
			}
			element.dataset.blockId = block.id;
			if (isAddedTextBlock(block)) element.dataset.added = 'true';
			else delete element.dataset.added;
			if (block.bold || block.visualBold || block.boldOverride === true) {
				element.dataset.bold = 'true';
			}
			// ARRONDIS ENTIER partout : les deltas de transform sont entiers, une
			// base left/top fractionnaire créait un désaccord de 1px entre les
			// chemins (repos/édition/déplacement) + du rendu sous-pixel flou.
			element.style.left = `${Math.round(block.x)}px`;
			element.style.top = `${Math.round(block.y)}px`;
			element.tabIndex = 0;
			element.setAttribute('role', 'button');
			element.setAttribute('aria-label', block.text || (block.kind === 'image' ? 'Image' : 'Bloc'));
			element.title = block.text;

			// Bloc-paragraphe : interligne = pas entre lignes d'origine.
			let multilineHalfLeading = 0;
			let multilineLineHeightPx = 0;
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
					multilineLineHeightPx = lh;
					// CSS centre chaque ligne dans sa boîte => une demi-marge (lh - police)/2
					// se glisse AU-DESSUS de la 1re ligne (trou en haut + curseur décalé).
					// On la mesure pour remonter le contenu et coller la 1re ligne au PDF.
					// (Approximation d'amorçage : corrigée plus bas avec les métriques
					// RÉELLES de la police une fois celle-ci appliquée à l'élément.)
					const fs = block.pdfFontSize > 0 ? block.pdfFontSize : lh * 0.82;
					multilineHalfLeading = Math.max(0, (lh - fs) / 2);
					// Hors édition aussi : on remonte la 1re ligne pour qu'elle colle au
					// PDF (sinon un "trou" réapparaît en haut une fois la saisie finie).
					// Arrondi entier comme les autres chemins (sinon _mountTop fractionnaire).
					if (!isEditing) element.style.top = `${Math.round(block.y - multilineHalfLeading)}px`;
				}
			}

			// Composite : la saisie peut déborder à droite de la boîte d'origine.
			// Le cadre s'élargit au fil de la frappe pour englober l'insertion et
			// le suffixe décalé (comportement Adobe : la boîte grandit, le texte
			// n'en sort jamais). +2px de marge d'anti-aliasing.
			const compositeWidth = glyphComposite
				? Math.max(0, glyphComposite.extentRight + 2 - block.x)
				: 0;
			const editingInkBox =
				!multiline && block.kind !== 'image' && !block.boxResized ? textInkBox(block) : null;
			const visualWidth =
				isEditing && editingInkBox
					? Math.max(
							editingInkBox.width,
							editingInkBox.right - (block.originalX ?? block.x)
						)
					: block.width;
			const minWidth = Math.max(visualWidth, compositeWidth, 18);
			// Hauteur : suit l'encre courante (plus de cadre figé trop haut après
			// une suppression — le vide sous la ligne faisait croire à un décalage).
			const minHeight = Math.max(
				editingInkBox ? editingInkBox.height : block.height,
				14
			);

			element.style.width = `${minWidth}px`;
			element.style.height = `${minHeight}px`;
			// État repos (ni en édition, ni déplacé) : resserrer le cadre sur l'encre
			// réelle pour supprimer le vide sous le texte (loose bounds). On ne touche
			// PAS à block.y/height (géométrie d'édition préservée → aucun mouvement au
			// double-clic), seulement à l'affichage de la boîte. Les blocs ré-écrits
			// (texte/police modifiés) sont recalés APRÈS rendu par recenterDirtyTextBox,
			// à partir des métriques RÉELLES de la police choisie (pas de l'ancienne).
			// Cadre serré sur l'encre (left/top/width/height), AU REPOS COMME DÉPLACÉ.
			// Avant : seule la hauteur était resserrée → largeur gonflée (icônes voisines)
			// et left restait sur les bounds lâches.
			if (block.kind !== 'image' && !isEditing && !textEdited && !multiline && !block.boxResized) {
				const inkBox = textInkBox(block);
				if (inkBox) {
					const dx = block.x - (block.originalX ?? block.x);
					const dy = block.y - (block.originalY ?? block.y);
					element.style.left = `${Math.round(inkBox.left + dx)}px`;
					element.style.top = `${Math.round(inkBox.top + dy)}px`;
					element.style.width = `${Math.round(Math.max(inkBox.width, 6))}px`;
					element.style.height = `${Math.round(Math.max(inkBox.height, 6))}px`;
				}
			}
			if (block.kind !== 'image' && (isEditing || textEdited)) {
				// Padding symétrique pour laisser de la place au curseur en début/fin de texte.
				// On décale la boîte d'autant pour que le texte reste aligné sur le PDF dessous.
				const padX = EDIT_BLOCK_PAD_X;
				const padY = EDIT_BLOCK_PAD_Y;
				// On resserre la hauteur sur l'encre réelle (comme au repos) pour que le
				// cadre ne grossisse pas vers le bas en entrant en édition.
				const inkBox = editingInkBox;
				// `inkBox.top` est en coordonnées d'ORIGINE : on ajoute le déplacement pour
				// que la boîte d'édition suive le bloc déplacé (sinon double-clic = saut).
				const editDy = block.y - (block.originalY ?? block.y);
				// ARRONDIS ENTIER (top + height) : le repos arrondit déjà inkBox.top+dy à
				// l'entier. Si l'édition reste fractionnaire, on a un décalage de 1px au
				// moment du blur (édition → repos). On arrondit donc l'édition pareil.
				const baseTop = inkBox ? Math.round(inkBox.top + editDy) : Math.round(block.y);
				const baseHeight = inkBox ? Math.round(Math.max(inkBox.height, 6)) : minHeight;
				const boxWidth = minWidth + padX * 2;
				const boxHeight = baseHeight + padY * 2;
				element.style.padding = `${padY}px ${padX}px`;
				element.style.left = `${Math.round(block.x - padX)}px`;
				// Pour un paragraphe, on remonte la boîte de la demi-marge d'interligne
				// pour que la 1re ligne soit pile sur le PDF (pas de "ligne vide" en haut).
				element.style.top = `${Math.round(baseTop - padY - multilineHalfLeading)}px`;
				element.style.width = `${boxWidth}px`;
				element.style.height = `${boxHeight}px`;
				element.style.minWidth = `${boxWidth}px`;
				element.style.minHeight = `${boxHeight}px`;
				const maxWidth = Math.max(boxWidth, (block.pageWidth || data.viewportWidth) - block.x - 4 + padX * 2);
				element.style.maxWidth = `${maxWidth}px`;
				// Boîte redimensionnée : même reflow en édition qu'au repos (pre-wrap à
				// largeur fixe, même interligne), sinon les lignes changeraient en
				// entrant en édition.
				if (block.boxResized) {
					element.style.whiteSpace = 'pre-wrap';
					element.style.maxWidth = `${boxWidth}px`;
					if (!multiline) element.style.lineHeight = '1.25';
				}
			}

			// Bloc redimensionné manuellement (poignées texte) : comportement Adobe.
			// La boîte épouse la géométrie pilotée par l'utilisateur, et le texte
			// REFLOWE dans cette largeur (retour à la ligne aux mots, \n respectés,
			// police inchangée). La boîte ne peut jamais être plus petite que son
			// contenu (clamp après rendu, plus bas) : le texte ne sort JAMAIS du cadre.
			if (block.boxResized && !isEditing && block.kind !== 'image') {
				element.style.left = `${Math.round(block.x)}px`;
				element.style.top = `${Math.round(block.y)}px`;
				element.style.width = `${Math.max(block.width, 8)}px`;
				element.style.height = `${Math.max(block.height, 8)}px`;
				element.style.whiteSpace = 'pre-wrap';
				element.style.overflow = 'visible';
				// Interligne lisible pour les lignes créées par le reflow (le défaut du
				// bloc est line-height: 1, qui collerait les lignes). Les paragraphes
				// multilignes gardent leur interligne calculé plus haut.
				if (!multiline) element.style.lineHeight = '1.25';
			}

			// Mode pristine : au double-clic, on ne peint pas de texte HTML opaque.
			const pristineInlineEdit = isEditing && block.kind !== 'image' && !editTouched;
			// Un bloc texte « vivant » (édité OU déplacé) est TOUJOURS rendu en HTML et
			// déplacé par translate3d : plus de chemin bitmap pour le texte.
			const showAsText =
				block.kind !== 'image' &&
				(isEditing || (dirty && textEdited) || isLiveTextBlock(block));
			// La capture bitmap ne sert PLUS qu'aux logos / images (non reproductibles
			// en HTML) : isLiveTextBlock écarte le texte, donc !showAsText suffit.
			const showAsSnapshot =
				dirty && !isEditing && !showAsText && (!localGlyphEdited || moved);

			// Encre d'origine pour la capture bitmap serrée et nette (texte natif uniquement).
			// Les logos / images (sans glyphes connus) retombent sur la capture lâche.
			const snapshotInkBox =
				!multiline && block.kind !== 'image' && Array.isArray(block.pdfChars) && block.pdfChars.length
					? textInkBox(block)
					: null;

			if (showAsText) {
				const emptyAdded = isEmptyAddedPlaceholder(block);
				if (emptyAdded && !isEditing) {
					// Fantôme « Aa » via CSS ::before — jamais dans textContent,
					// sinon la frappe prolonge/édite le gris au lieu de le remplacer.
					ensureAddedPlaceholderGeometry(block);
					element.classList.add('added-empty');
					setPlainEditTextContent(element, '');
				} else {
					element.classList.remove('added-empty');
					if (block.htmlEdited && block.html) {
						if (element.innerHTML !== block.html) element.innerHTML = block.html;
					} else {
						setPlainEditTextContent(element, block.text);
					}
				}
				if (!block.baseFontSize) {
					block.baseFontSize = block.pdfFontSize > 0
						? block.pdfFontSize
						: Math.max(8, Math.min(48, Math.round(block.height * 0.78)));
				}
				element.style.fontSize = `${block.baseFontSize}px`;
				applyBlockFontStyle(element, block);
				if (isEditing && isAddedTextBlock(block)) {
					const inkColor = block.color || '#111111';
					element.style.color = inkColor;
					element.style.webkitTextFillColor = inkColor;
					element.style.caretColor = inkColor;
				} else if (emptyAdded && !isEditing) {
					element.style.color = 'transparent';
					element.style.webkitTextFillColor = 'transparent';
				}
				// Bloc ré-écrit : on ré-applique l'espacement capturé à l'état vierge
				// (calé sur la largeur de la ligne PDF). Sans ça, la bascule vers le
				// rendu HTML à la première frappe compresse le texte (espacement 0)
				// → impression de « texte plus petit ».
				if (
					isBlockTextEdited(block) &&
					!block.multiline &&
					Number.isFinite(block.editLetterSpacing) &&
					block.editLetterSpacing !== 0
				) {
					element.style.letterSpacing = `${block.editLetterSpacing}px`;
				}
				if (pristineInlineEdit) {
					element.classList.add('editing-pristine');
					// Bloc DÉPLACÉ en édition vierge : aucun texte natif sous la nouvelle
					// position → on pose derrière le caret une COPIE bitmap exacte des
					// glyphes d'origine (glyphes supprimés effacés). Ni blanc, ni reflow.
					if (moved && snapshotInkBox) {
						const snap = getBlockInkSnapshot(block, data, snapshotInkBox);
						if (snap) {
							const bg = document.createElement('img');
							bg.src = snap;
							bg.className = 'edit-block-edit-backdrop';
							bg.draggable = false;
							bg.alt = '';
							bg.style.position = 'absolute';
							bg.style.left = `${EDIT_BLOCK_PAD_X}px`;
							bg.style.top = `${EDIT_BLOCK_PAD_Y}px`;
							bg.style.width = `${Math.max(1, block.originalWidth || block.width)}px`;
							bg.style.height = `${Math.max(1, snapshotInkBox.height)}px`;
							bg.style.pointerEvents = 'none';
							// Derrière le texte/caret de l'élément éditable (sinon il masque le curseur).
							bg.style.zIndex = '-1';
							element.append(bg);
						}
					}
				}
			} else if (showAsSnapshot) {
				// Bloc déplacé non ré-écrit (texte natif OU logo) : on rend le BITMAP
				// d'origine pour préserver EXACTEMENT l'aspect, au pixel près (zéro reflow).
				// Texte natif → capture de l'ENCRE (cadre serré) affichée en 1:1 (nette,
				// jamais ré-échantillonnée). Logos/images → capture lâche historique.
				const snap = snapshotInkBox
					? getBlockInkSnapshot(block, data, snapshotInkBox)
					: getBlockOriginalSnapshot(block, data);
				if (snap) {
					const img = document.createElement('img');
					img.src = snap;
					img.draggable = false;
					img.alt = '';
					if (snapshotInkBox) {
						img.style.width = `${Math.max(1, block.originalWidth || block.width)}px`;
						img.style.height = `${Math.max(1, snapshotInkBox.height)}px`;
					} else {
						img.style.width = `${Math.max(1, Math.round(block.width))}px`;
						img.style.height = `${Math.max(1, Math.round(block.height))}px`;
					}
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
				enterEditingMode(element, block);
			} else {
				bindIdleBlockListeners(element, block);
			}

			// POINT 3 : pour un bloc modifié réutilisé, on n'append QUE s'il n'est pas
			// déjà parenté (jamais de réordonnancement, qui re-rasterise). Les autres
			// blocs gardent le comportement historique (réordonnancement = z-order).
			const reorderOk = !(isLiveTextBlock(block) && element.parentElement === editLayer);
			if (element.parentElement !== editLayer || (reorderOk && editLayer.lastElementChild !== element)) {
				editLayer.append(element);
			}

			// Comportement Adobe pour une boîte redimensionnée : elle ne peut JAMAIS
			// être plus petite que son contenu. Mesuré après insertion (layout dispo) :
			// si le texte reflowé dépasse (mot le plus long > largeur, ou lignes
			// supplémentaires > hauteur), la boîte est agrandie et block.* resynchronisé
			// (poignées, export). Le texte ne sort donc jamais du cadre.
			if (block.boxResized && !isEditing && block.kind !== 'image') {
				const contentWidth = Math.ceil(element.scrollWidth);
				const contentHeight = Math.ceil(element.scrollHeight);
				if (contentWidth > block.width) {
					block.width = contentWidth;
					// Drag en cours depuis le bord GAUCHE : le ré-agrandissement au
					// contenu garde le bord DROIT fixe (sinon la boîte se translate
					// vers la droite quand on tire au-delà du minimum).
					if (Number.isFinite(block._resizeAnchorRight)) {
						block.x = Math.max(0, block._resizeAnchorRight - contentWidth);
						element.style.left = `${Math.round(block.x)}px`;
					}
					element.style.width = `${contentWidth}px`;
				}
				if (contentHeight > block.height) {
					block.height = contentHeight;
					// Idem depuis le bord HAUT : le bord BAS reste fixe (la boîte ne
					// « descend » plus quand on continue à tirer au minimum).
					if (Number.isFinite(block._resizeAnchorBottom)) {
						block.y = Math.max(0, block._resizeAnchorBottom - contentHeight);
						element.style.top = `${Math.round(block.y)}px`;
					}
					element.style.height = `${contentHeight}px`;
				}
			}

			// Police finale AVANT le calcul d'ancrage compensé et des poignées :
			// htmlInkTopOffset mesure avec la police effective de l'élément.
			if ((showAsText || (showAsSnapshot && element.textContent)) && block.kind !== 'image') {
				matchFontFromTextLayer(element, block, data);
				applyBlockFormatOverrides(element, block);
			}

			// Texte ajouté : cadre serré sur l'encre (après police effective).
			// Sans ça, scrollHeight / hauteur initiale ×1.35 laissent un vide sous la ligne.
			if (
				showAsText &&
				isAddedTextBlock(block) &&
				block.kind !== 'image' &&
				!block.boxResized &&
				!block.rotation
			) {
				const tight = addedTextContentHeight(block, element);
				if (tight > 0) {
					block.height = tight;
					block.originalHeight = tight;
					const boxH = tight + EDIT_BLOCK_PAD_Y * 2;
					element.style.height = `${boxH}px`;
					element.style.minHeight = `${boxH}px`;
				}
			}

			// Paragraphe : recale le top avec la demi-marge d'interligne RÉELLE
			// (métriques de la police effective, mesurables seulement maintenant
			// que la police est appliquée). L'approximation d'amorçage surestimait
			// la remontée de 1-2px → caret flottant au-dessus du texte natif au
			// double-clic, puis micro-saut du paragraphe à la première frappe.
			if (multiline && multilineLineHeightPx > 0 && block.kind !== 'image' && element.textContent) {
				const realHalfLeading = measuredCssHalfLeading(element, multilineLineHeightPx);
				if (realHalfLeading != null) {
					multilineHalfLeading = realHalfLeading;
					const nextTop =
						isEditing || textEdited
							? `${Math.round(Math.round(block.y) - EDIT_BLOCK_PAD_Y - realHalfLeading)}px`
							: `${Math.round(block.y - realHalfLeading)}px`;
					if (element.style.top !== nextTop) element.style.top = nextTop;
				}
			}

			// Composite (glyphes préservés) : le texte HTML du bloc reste INVISIBLE
			// (il ne sert qu'au caret natif et à la sélection). Le visuel est porté
			// par le rendu natif + les artefacts composite. Inline (pas seulement en
			// CSS) car applyBlockFormatOverrides pose block.color en style inline.
			if (glyphComposite) {
				element.style.color = 'transparent';
				element.style.webkitTextFillColor = 'transparent';
				element.style.caretColor = '#161616';
			} else if (isEditing && isAddedTextBlock(block)) {
				const inkColor = block.color || '#111111';
				element.style.color = inkColor;
				element.style.webkitTextFillColor = inkColor;
				element.style.caretColor = inkColor;
			} else if (block.kind !== 'image') {
				element.style.webkitTextFillColor = '';
				element.style.caretColor = '';
				if (!block.color) element.style.color = '';
			}

			// DERNIER MICRO-SAUT à la première frappe : l'encre du texte HTML tombe
			// ~1-2px sous l'encre native (ascent de police ≠ ascent d'encre, cf.
			// htmlInkTopOffset). On remonte la boîte d'exactement ce décalage pour
			// TOUT bloc rendu en HTML (édition vierge, ré-écrit, déplacé) : mêmes
			// coordonnées dans tous les états → aucun mouvement entre eux, et le
			// rendu HTML se cale pile sur l'encre native.
			if (
				showAsText &&
				block.kind !== 'image' &&
				!multiline &&
				!block.boxResized &&
				!block.rotation
			) {
				const anchorInk = textInkBox(block);
				if (anchorInk) {
					const inkOffset = htmlInkTopOffset(element, block);
					if (inkOffset) {
						const editDy = block.y - (block.originalY ?? block.y);
						const newTop =
							Math.round(anchorInk.top + editDy - inkOffset) - EDIT_BLOCK_PAD_Y;
						element.style.top = `${newTop}px`;
						// Remonter le top sans garder l'ancienne hauteur = vide en bas.
						// On ancre le bas du cadre sur le bas de l'encre + pad.
						const newBottom =
							Math.round(anchorInk.top + editDy + anchorInk.height) + EDIT_BLOCK_PAD_Y;
						element.style.height = `${Math.max(6 + EDIT_BLOCK_PAD_Y * 2, newBottom - newTop)}px`;
						// Le fond bitmap (bloc déplacé, édition vierge) doit rester calé
						// sur l'encre : il compense le décalage appliqué à l'élément.
						const backdrop = element.querySelector('.edit-block-edit-backdrop');
						if (backdrop) backdrop.style.top = `${EDIT_BLOCK_PAD_Y + inkOffset}px`;
					}
				}
			}

			// Images + logos non éditables : cadre CARRÉ dès le survol (classe posée
			// même hors sélection). Les poignées de redimensionnement (4 coins
			// proportionnels + 4 arêtes) n'apparaissent qu'une fois le bloc sélectionné.
			if (!isEditing && isResizableBlock(block)) {
				element.classList.add('resizable');
				if (isSelected) appendBlockResizeHandles(editLayer, block);
			}

			// Cadre de survol/sélection multiligne : le contenu est remonté de sa
			// demi-marge d'interligne pour aligner la première ligne. Compenser
			// exactement cette remontée dans la hauteur, puis ajouter 3 px sous la
			// dernière ligne. Survol, sélection et poignées partagent ainsi la même
			// géométrie sans mordre le texte.
			if (multiline && !isEditing && !block.boxResized) {
				const currentHeight = Number.parseFloat(element.style.height) || Math.max(block.height, 14);
				element.style.height = `${currentHeight + multilineHalfLeading + 3}px`;
			}

			const visualBox = {
				x: Number.parseFloat(element.style.left) || block.x,
				y: Number.parseFloat(element.style.top) || block.y,
				width: Number.parseFloat(element.style.width) || Math.max(block.width, 18),
				height: Number.parseFloat(element.style.height) || Math.max(block.height, 14)
			};

			// Poignées UNIQUEMENT en sélection, jamais pendant l'édition : elles
			// recouvrent le texte (z-index 9) et volent les clics / la sélection
			// de caractères.
			if (isSelected && !isEditing && block.kind !== 'image') {
				appendTextHandles(editLayer, block, visualBox);
				// Badge « police non disponible » (façon Adobe) : point d'exclamation
				// jaune à droite du cadre, tooltip au survol. Uniquement quand le bloc
				// est actif (sélection/édition) pour ne pas surcharger la page.
				if (blockFontUnavailable(block)) {
					appendFontWarningBadge(editLayer, block, visualBox);
				}
			}

			// Rotation du bloc (texte) : transform CSS centré. Les poignées sont
			// repositionnées en conséquence dans appendTextHandles.
			if (block.rotation) {
				element.style.transformOrigin = 'center center';
				element.style.transform = `rotate(${block.rotation}deg)`;
			}

			// Le caret est désormais le caret NATIF du contenteditable (visible en mode
			// glyphe via caret-color). Plus de caret custom à dessiner.

			// FINALISATION DU MONTAGE (point 2) : à ce stade, un bloc modifié vient
			// d'être rasterisé une fois avec son texte/police/taille/couleur/padding et
			// son left/top DÉFINITIFS. On fige l'origine pour que TOUT déplacement
			// ultérieur se fasse uniquement par transform translate3d (compositeur),
			// sans plus jamais re-styler/re-mesurer/ré-attacher le node. `alto-frozen`
			// gèle aussi les propriétés CSS qui re-rasterisaient (white-space,
			// text-rendering, color…). Les blocs en rotation sont exclus (transform
			// déjà utilisé pour la rotation).
			if (!block.rotation && block.kind !== 'image' && isLiveTextBlock(block)) {
				block._mounted = true;
				block._mountX = block.x;
				block._mountY = block.y;
				block._mountLeft = Number.parseFloat(element.style.left) || block.x;
				block._mountTop = Number.parseFloat(element.style.top) || block.y;
				block._mountSig = editedBlockSignature(block);
				element.classList.add('alto-frozen');
				// will-change seulement si le bloc est manipulable maintenant (même
				// logique que syncMountedEditedBlock) : pas de couche GPU permanente.
				element.style.willChange = isSelected || isEditing ? 'transform' : '';
				element.style.transform = 'translateZ(0)';
			}

		// Bloc texte ré-écrit (police/texte modifiés) : on NE recale PAS vivant ici.
		// recenterDirtyTextBox mesurait la position du DOM à chaque rendu (strut + ratio)
		// pendant le déplacement → flou sous-pixel et jitter au move, ET au blur il
		// appliquait une formule (baseline - ink.ascent) DIFFÉRENTE de l'édition
		// (inkBox.top + dy) → le texte "snappait" à une autre position, puis revenait
		// juste en re-éditant. En supprimant cette surcharge, un bloc modifié au repos
		// utilise EXACTEMENT le même ancrage que l'édition et que le natif
		// (inkBox.top + dy, voir plus haut) : plus de snap au blur, plus de re-mesure
		// au move → plus de flou ni jitter. Trade-off : la boîte reste ancrée sur
		// l'encre PDF d'origine (stable) plutôt que sur la métrique de la police de
		// substitution ; l'utilisateur ajuste avec les poignées si besoin.
		});

	// Le nettoyage du layer a détruit la barre du caret natif : re-dessin.
	if (state.editingBlockId) scheduleNativeCaretUpdate();
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
	// Police métriquement compatible en TÊTE de pile pour les base-14 (Arimo pour
	// Helvetica/Arial, Tinos pour Times, Cousine pour Courier). Même avance que la
	// police d'origine → l'overlay d'édition ne décale ni ne rétrécit le texte.
	// Ignorée si l'utilisateur a explicitement choisi une autre police.
	if (!block.fontFamilyOverride) {
		const metric = metricCompatibleFamily(block.fontName);
		if (metric && !(element.style.fontFamily || '').includes(metric)) {
			element.style.fontFamily = element.style.fontFamily
				? `"${metric}", ${element.style.fontFamily}`
				: `"${metric}"`;
		}
	}
}

function fitEditTextWidth(element, block) {
	// En mode glyphe/pristine (texte HTML TRANSPARENT posé sur le PDF natif
	// visible dessous), le caret natif se place en fin du texte HTML. Or le PDF
	// est souvent JUSTIFIÉ alors que l'HTML a l'espacement naturel : sans
	// étirement, l'HTML est plus court que le PDF → le caret se retrouve dans un
	// « vide » après le dernier glyphe visible. On étire donc l'HTML pour qu'il
	// colle à la largeur de la ligne PDF, UNIQUEMENT quand le texte est transparent
	// (jamais en opaque, sinon trous visibles entre les lettres).
	if (!element) return;
	if (isBlockTextEdited(block)) {
		// Bloc déjà ré-écrit : on conserve l'espacement capturé à l'état vierge
		// (calé sur la largeur du PDF). Le remettre à 0 compressait le texte à la
		// première frappe → impression de « texte plus petit ».
		element.style.letterSpacing = `${Number.isFinite(block.editLetterSpacing) ? block.editLetterSpacing : 0}px`;
		return;
	}
	const lines = pdfCharLines(block);
	const line = lines.length ? lines[lines.length - 1] : null;
	if (!line || line.chars.length < 2) {
		element.style.letterSpacing = '0px';
		block.editLetterSpacing = 0;
		return;
	}
	// Largeur de la ligne PDF (coords page = CSS px, comme l'editLayer).
	const first = line.chars[0];
	const last = line.chars[line.chars.length - 1];
	const pdfLineWidth = (last.x + last.width) - first.x;
	// Largeur naturelle du texte HTML (espacement 0, largeur auto).
	const prevSpacing = element.style.letterSpacing;
	const prevWidth = element.style.width;
	const prevWhiteSpace = element.style.whiteSpace;
	element.style.letterSpacing = '0px';
	element.style.whiteSpace = 'pre';
	element.style.width = 'auto';
	const naturalWidth = Math.ceil(element.getBoundingClientRect().width);
	element.style.letterSpacing = prevSpacing;
	element.style.whiteSpace = prevWhiteSpace;
	element.style.width = prevWidth;
	if (!(naturalWidth > 0) || !(pdfLineWidth > 0)) {
		element.style.letterSpacing = '0px';
		return;
	}
	// Étirement réparti entre les caractères. Clampé pour éviter l'absurde
	// (police de substitution très différente de l'originale).
	const gap = pdfLineWidth - naturalWidth;
	const ls = gap / Math.max(1, line.chars.length - 1);
	const fs = block.pdfFontSize > 0 ? block.pdfFontSize : 16;
	const clamped = Math.max(-fs * 0.1, Math.min(fs * 0.5, ls));
	element.style.letterSpacing = `${clamped}px`;
	// Mémorisé sur le bloc : à la première frappe (bascule vierge → ré-écrit) et
	// à tous les rendus suivants, le texte garde CET espacement au lieu de
	// retomber à 0 et de se compresser (le « texte plus petit » perçu).
	block.editLetterSpacing = clamped;
}

function resizeEditingElementToContent(element, block) {
	if (!element || !block) return;
	const padX = EDIT_BLOCK_PAD_X;
	const padY = EDIT_BLOCK_PAD_Y;
	// Boîte redimensionnée manuellement : largeur FIGÉE par l'utilisateur, le
	// texte reflowe dedans (pre-wrap) et seule la hauteur suit le contenu —
	// comportement Adobe, identique au repos.
	if (block.boxResized) {
		const fixedWidth = Math.max(block.width, 8) + padX * 2;
		element.style.whiteSpace = 'pre-wrap';
		if (!block.multiline) element.style.lineHeight = '1.25';
		element.style.width = `${fixedWidth}px`;
		element.style.height = 'auto';
		const contentHeight = Math.ceil(element.scrollHeight);
		element.style.height = `${Math.max(Math.max(block.height, 8) + padY * 2, contentHeight)}px`;
		return;
	}
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
	const inkExtentWidth = inkBox
		? Math.max(inkBox.width, inkBox.right - (block.originalX ?? block.x))
		: 0;
	const minBoxWidth = Math.max(inkExtentWidth, 8) + padX * 2;
	element.style.minWidth = `${minBoxWidth}px`;
	// Mesure la taille réelle du contenu en libérant la largeur, sinon scrollWidth
	// reste bridé par la largeur déjà fixée et la boîte ne grandit jamais.
	element.style.width = 'auto';
	element.style.height = 'auto';
	const contentWidth = Math.ceil(element.scrollWidth);
	const contentHeight = Math.ceil(element.scrollHeight);
	const maxWidth = Math.max(minBoxWidth, (block.pageWidth || block.width) - block.x - 4 + padX * 2);
	const nextWidth = Math.min(maxWidth, Math.max(minBoxWidth, contentWidth));
	// Texte PDF natif : le scrollHeight HTML (line-height / ascent) gonfle le
	// cadre sous l'encre. On reste calé sur l'encre glyphe.
	// Texte ajouté : idem via encre canvas (scrollHeight contenteditable trop haut).
	let nextHeight;
	if (nativeTextEditEligible(block)) {
		nextHeight = minBoxHeight;
	} else if (isAddedTextBlock(block) && !inkBox) {
		const tight = addedTextContentHeight(block, element);
		block.height = tight;
		nextHeight = tight + padY * 2;
	} else {
		nextHeight = Math.max(minBoxHeight, contentHeight);
	}
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

// Insère du texte brut à la position du caret natif (remplace la sélection si
// présente). Utilisé pour insérer un espace sans passer par la saisie native,
// ce qui contourne les substitutions macOS (double-espace → point).
function insertPlainTextAtCaret(element, text) {
	const selection = window.getSelection();
	if (!selection || !selection.rangeCount) {
		element.appendChild(document.createTextNode(text));
		placeCaretAtEnd(element);
		return;
	}
	const range = selection.getRangeAt(0);
	range.deleteContents();
	const node = document.createTextNode(text);
	range.insertNode(node);
	range.setStartAfter(node);
	range.collapse(true);
	selection.removeAllRanges();
	selection.addRange(range);
}

function shouldStartSnapshotTextEdit(event) {
	if (event.metaKey || event.ctrlKey || event.altKey) return false;
	return event.key.length === 1 || event.key === 'Backspace' || event.key === 'Enter';
}

function ensureEditMask(element, block) {
	// Texte nouvellement ajouté : aucun contenu d'origine ne doit être masqué.
	if (block.added) return;
	// Couvre le texte PDF d'origine dès qu'on bascule en saisie réelle.
	const editLayer = element.parentElement;
	if (!editLayer || editLayer.querySelector(`.edit-block-mask[data-mask-for="${block.id}"]`)) {
		return;
	}
	// Masques SERRÉS par glyphe quand la géométrie native est connue : un
	// rectangle blanc plein effacerait les traits de tableau qui passent sous
	// le bloc (bande blanche coupant les colonnes dès la première frappe).
	const chars = Array.isArray(block.pdfChars) ? block.pdfChars : [];
	if (chars.length) {
		for (const ch of chars) {
			// Blanc sans encre : rien à masquer (voir appendGlyphMask).
			if (!stripWhitespace(ch?.text || '').length) continue;
			const rect = glyphMaskRect(ch, block);
			const glyphMask = document.createElement('div');
			glyphMask.className = 'edit-block-mask glyph-mask';
			glyphMask.dataset.maskFor = block.id;
			glyphMask.style.left = `${rect.x}px`;
			glyphMask.style.top = `${rect.y}px`;
			glyphMask.style.width = `${rect.width}px`;
			glyphMask.style.height = `${rect.height}px`;
			editLayer.insertBefore(glyphMask, editLayer.firstChild);
		}
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

// Offset (collapsed) du caret natif DANS le texte de l'élément éditable. C'est
// la source de vérité pour l'édition en mode glyphe : le navigateur place le
// caret là où l'utilisateur clique, et l'offset indexe directement block.text
// (== textContent de l'élément). Plus fiable que le mapping index-glyphe.
function caretTextOffset(element) {
	const sel = window.getSelection();
	if (!sel || sel.rangeCount === 0) return null;
	const range = sel.getRangeAt(0);
	if (!element.contains(range.startContainer)) return null;
	const pre = range.cloneRange();
	pre.selectNodeContents(element);
	pre.setEnd(range.startContainer, range.startOffset);
	return pre.toString().length;
}

// ─── Caret dessiné aux frontières des glyphes NATIFS ─────────────────────────
// Sur un bloc vierge, le caret du contenteditable est positionné par WebKit avec
// les métriques de la police de SUBSTITUTION : les frontières de lettres HTML
// dérivent de quelques px par rapport aux glyphes PDF affichés dessous → caret
// « en plein milieu d'une lettre ». On masque le caret WebKit et on dessine le
// nôtre aux frontières EXACTES des boîtes de caractères PDFium.

// Lignes de glyphes du bloc si (et seulement si) leur texte reconstruit
// correspond exactement au texte affiché : c'est la condition pour mapper un
// offset texte sur une frontière de glyphe sans ambiguïté.
function nativeCaretLines(block, elementText) {
	if (!block || block.kind === 'image') return null;
	if (!Array.isArray(block.pdfChars) || !block.pdfChars.length) return null;
	const lines = pdfCharLines(block);
	if (!lines.length) return null;
	if (pdfLinesText(lines) !== (elementText || '').replace(/\r\n?/g, '\n')) return null;
	return lines;
}

// Translation du bloc depuis sa position d'origine : les boîtes de glyphes
// (pdfChars) sont FIGÉES en coordonnées d'origine, tout calcul caret ↔ glyphe
// sur un bloc déplacé doit ajouter ce delta (sinon caret dessiné dans le vide
// à l'ancienne position, hit-test de clic décalé d'autant).
function blockMoveDelta(block) {
	return {
		dx: block.x - (block.originalX ?? block.x),
		dy: block.y - (block.originalY ?? block.y)
	};
}

// Boîte (coordonnées page CSS) de la frontière de glyphe correspondant à un
// offset texte. Entre deux glyphes : coller à la DROITE du précédent (avance),
// pas au bord gauche du suivant — sinon le caret « accroche » la lettre
// suivante dans l'interlettre (ex. entre 1 et 0). Début de ligne = gauche du
// premier ; fin de ligne = droite du dernier.
function nativeCaretRectForOffset(block, elementText, offset) {
	const lines = nativeCaretLines(block, elementText);
	if (!lines) return null;
	const { dx, dy } = blockMoveDelta(block);
	let pos = 0;
	for (let li = 0; li < lines.length; li += 1) {
		const line = lines[li];
		const lineLength = line.chars.reduce((sum, ch) => sum + (ch.text || '').length, 0);
		if (offset <= pos + lineLength) {
			const within = offset - pos;
			let consumed = 0;
			let prev = null;
			for (const ch of line.chars) {
				const chLength = (ch.text || '').length;
				if (within <= consumed) {
					if (prev) {
						return { x: prev.x + prev.width + dx, top: line.y + dy, height: line.height };
					}
					return { x: ch.x + dx, top: line.y + dy, height: line.height };
				}
				if (within < consumed + chLength) {
					// Frontière à l'intérieur d'un caractère multi-unités (ligature) :
					// interpolation linéaire dans sa boîte.
					const fraction = (within - consumed) / chLength;
					return { x: ch.x + ch.width * fraction + dx, top: line.y + dy, height: line.height };
				}
				consumed += chLength;
				prev = ch;
			}
			if (prev) return { x: prev.x + prev.width + dx, top: line.y + dy, height: line.height };
			return null;
		}
		pos += lineLength + 1; // '\n' entre les lignes
	}
	return null;
}

// Offset texte correspondant à un point (coordonnées page CSS) : ligne la plus
// proche verticalement, puis frontière au plus près du x cliqué (moitié gauche
// d'un glyphe → avant lui, moitié droite → après). C'est le hit-test qui place
// le caret là où l'utilisateur VOIT les lettres, pas là où l'HTML les mesure.
function nativeTextOffsetFromPagePoint(block, elementText, pageX, pageY) {
	const lines = nativeCaretLines(block, elementText);
	if (!lines) return null;
	// Bloc déplacé : le clic est en coordonnées COURANTES, les glyphes en
	// coordonnées d'ORIGINE — on ramène le point dans le référentiel des glyphes.
	const { dx, dy } = blockMoveDelta(block);
	pageX -= dx;
	pageY -= dy;
	return pdfTextOffsetFromPoint(lines, pageX, pageY);
}

// Variante en coordonnées CLIENT (clic souris) : conversion via l'editLayer.
function nativeTextOffsetFromClientPoint(block, elementText, clientX, clientY) {
	const data = getPageData(block.page);
	const rect = data?.editLayer?.getBoundingClientRect();
	if (!rect) return null;
	return nativeTextOffsetFromPagePoint(block, elementText, clientX - rect.left, clientY - rect.top);
}

// Vrai tant que le caret dessiné est affiché : le re-render (qui écrase les
// classes de l'élément éditable) s'en sert pour re-masquer le caret WebKit
// sans attendre la mise à jour différée du caret.
let _nativeCaretActive = false;

function removeNativeCaretBar() {
	_nativeCaretActive = false;
	for (const bar of document.querySelectorAll('.alto-native-caret')) bar.remove();
}

// (Re)dessine le caret natif pour le bloc en cours d'édition, ou le retire et
// restaure le caret WebKit quand le mapping offset↔glyphe n'est pas possible
// (bloc passé en rendu HTML, sélection non réduite, texte désaligné…).
function updateNativeCaret() {
	const id = state.editingBlockId;
	const element = id
		? elements.pagesStack.querySelector(`.edit-block.editing[data-block-id="${id}"]`)
		: null;
	const block = id ? state.editBlocks.find((candidate) => candidate.id === id) : null;
	const deactivate = () => {
		removeNativeCaretBar();
		if (element) element.classList.remove('native-caret-active');
	};
	if (!block || !element || block.kind === 'image') return deactivate();
	// Uniquement pour un bloc VIERGE (glyphes natifs à l'écran). Dès que le bloc
	// bascule en rendu HTML, le caret WebKit mesure le texte réellement affiché
	// et redevient exact : on le restaure.
	if (isBlockTextEdited(block) || !Array.isArray(block.pdfChars) || !block.pdfChars.length) {
		return deactivate();
	}
	const sel = window.getSelection();
	if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return deactivate();
	const range = sel.getRangeAt(0);
	if (!element.contains(range.startContainer)) return deactivate();
	const data = getPageData(block.page);
	if (!data?.editLayer) return deactivate();
	const offset = caretTextOffset(element);
	if (offset == null) return deactivate();
	let rect = nativeCaretRectForOffset(block, element.textContent || '', offset);
	if (!rect && (block._nativeBusy || block._nativeQueued)) {
		// Frappes natives EN VOL : le texte est en avance sur les boîtes de
		// glyphes. Estimation transitoire par la géométrie HTML (le caret snappe
		// sur la frontière exacte dès la réponse moteur, quelques dizaines de ms).
		const caretRect = range.getBoundingClientRect();
		const layerRect = data.editLayer.getBoundingClientRect();
		if (caretRect && (caretRect.height > 0 || caretRect.width > 0)) {
			rect = {
				x: caretRect.left - layerRect.left,
				top: caretRect.top - layerRect.top,
				height: caretRect.height || 12
			};
		}
	}
	if (!rect) return deactivate();
	element.classList.add('native-caret-active');
	_nativeCaretActive = true;
	let bar = data.editLayer.querySelector('.alto-native-caret');
	if (!bar) {
		bar = document.createElement('div');
		bar.className = 'alto-native-caret';
		data.editLayer.append(bar);
	}
	// La boîte native contient déjà toute la ligne : le caret doit exactement
	// épouser sa hauteur, sans surplomb au-dessus ou sous le cadre d'édition.
	bar.style.left = `${rect.x - 0.75}px`;
	bar.style.top = `${rect.top}px`;
	bar.style.height = `${rect.height}px`;
	// Un caret qui vient de bouger est PLEIN : on redémarre le clignotement.
	bar.style.animation = 'none';
	void bar.offsetWidth;
	bar.style.animation = '';
}

let _nativeCaretRaf = 0;
function scheduleNativeCaretUpdate() {
	if (_nativeCaretRaf) return;
	_nativeCaretRaf = requestAnimationFrame(() => {
		_nativeCaretRaf = 0;
		updateNativeCaret();
	});
}

// Bascule un bloc « glyphe » (texte PDF non encore ré-écrit) en édition texte
// HTML, avec block.text remplacé par newText et le caret natif replacé à
// caretOffset. Utilisé par l'insertion / la suppression en mode glyphe : on
// part TOUJOURS de block.text (ce que l'utilisateur voit dans l'éditable) et
// d'offsets natifs, donc rien ne se décale ni ne se duplique.
// Suppression « EN FIN » SANS reflow : masque le dernier glyphe natif visible (via
// hiddenCharIndexes) et GARDE le bloc en rendu natif (glyphTrimOnly → isBlockTextEdited
// reste faux). Aucune bascule vers la police de substitution → zéro changement de
// taille. Retourne false (→ voie classique HTML) si le dernier caractère n'est pas un
// vrai glyphe en toute fin, ou si le bloc a été déplacé/redimensionné (le natif n'y
// serait plus aligné).
function trimLastVisibleGlyph(block) {
	if (!block || !Array.isArray(block.pdfChars) || !block.pdfChars.length) return false;
	const moved =
		Math.abs(block.x - (block.originalX ?? block.x)) > 0.5 ||
		Math.abs(block.y - (block.originalY ?? block.y)) > 0.5;
	if (moved || block.boxResized) return false;
	const lines = pdfCharLines(block);
	if (!lines.length) return false;
	const lastLine = lines[lines.length - 1];
	if (!lastLine.chars.length) return false;
	const lastCh = lastLine.chars[lastLine.chars.length - 1];
	if (!lastCh.text || !lastCh.text.trim()) return false;
	if (!(block.text || '').endsWith(lastCh.text)) return false;
	pushHistory('histTextEdit');
	const hidden = new Set(hiddenCharSet(block));
	hidden.add(lastCh.index);
	block.hiddenCharIndexes = Array.from(hidden);
	block.localGlyphEdited = true;
	block.glyphTrimOnly = true;
	block.text = (block.text || '').slice(0, block.text.length - lastCh.text.length);
	block.localCaretIndex = lastCh.index;
	block.localCaretAffinity = 'prev';
	block.snapshotDataUrl = null;
	block.inkSnapshotDataUrl = null;
	state.selectedBlockId = block.id;
	if (elements.editText) elements.editText.value = block.text;
	if (elements.editTextPanel) elements.editTextPanel.value = block.text;
	markDirty();
	renderEditBlocks();
	requestAnimationFrame(() => {
		const next = elements.pagesStack.querySelector(`.edit-block.editing[data-block-id="${block.id}"]`);
		if (!next) return;
		next.focus({ preventScroll: true });
		placeCaretAtTextOffset(next, block.text.length);
	});
	return true;
}

// ─── Édition de texte NATIVE (PDFium, façon Adobe) ──────────────────────────
// Chaque frappe modifie le texte DANS le document PDF (FPDFText_SetText côté
// Rust), qui re-rend la ligne avec la police embarquée d'origine. Ni overlay
// HTML opaque, ni police de substitution, ni composite : le pixel affiché est
// celui du moteur PDF → zéro micro-mouvement, alignement vertical exact.

function nativeCharsSorted(block) {
	return [...(Array.isArray(block?.pdfChars) ? block.pdfChars : [])].sort(
		(a, b) => (a.index ?? 0) - (b.index ?? 0)
	);
}

function nativeCharsText(chars) {
	return chars.map((ch) => ch.text || '').join('');
}

// nativeTextEditEligible : voir ./block-state.js (machine à états des blocs).

function nativeEditedPagesSet() {
	if (!(state.nativeEditedPages instanceof Set)) state.nativeEditedPages = new Set();
	return state.nativeEditedPages;
}

// Pages ayant reçu AU MOINS une édition native depuis l'ouverture du document
// (jamais vidé par la synchronisation, contrairement à nativeEditedPages) :
// un undo/redo APRÈS synchronisation doit encore pouvoir réconcilier le
// document avec l'état restauré, sinon le canvas garde le texte édité.
function nativeTouchedPagesSet() {
	const tab = currentTab();
	if (tab) {
		if (!(tab.nativeTouchedPages instanceof Set)) tab.nativeTouchedPages = new Set();
		return tab.nativeTouchedPages;
	}
	if (!(state.nativeTouchedPages instanceof Set)) state.nativeTouchedPages = new Set();
	return state.nativeTouchedPages;
}

// Blocs ayant reçu AU MOINS une édition native RÉUSSIE : id → DERNIER texte
// écrit dans le document. La réconciliation post-undo ne ré-émet d'édition
// inverse QUE pour eux (sans ce périmètre, un mauvais matching géométrique
// déclenchait de fausses éditions inverses sur des blocs jamais édités), et le
// texte mémorisé lui permet de retrouver les caractères du bloc même quand
// l'analyse a re-segmenté la page (texte élargi fusionné avec un voisin).
function nativeTouchedBlocksMap() {
	const tab = currentTab();
	if (tab) {
		if (!(tab.nativeTouchedBlocks instanceof Map)) tab.nativeTouchedBlocks = new Map();
		return tab.nativeTouchedBlocks;
	}
	if (!(state.nativeTouchedBlocks instanceof Map)) state.nativeTouchedBlocks = new Map();
	return state.nativeTouchedBlocks;
}

// Entrées de la map : string legacy (= lastWritten) ou
// { lastWritten, baseline } — baseline = texte document à la 1ʳᵉ édition
// (indispensable au redo après restore_native_page).
function rememberNativeTouchedBlock(blockId, lastWritten, baseline) {
	const map = nativeTouchedBlocksMap();
	map.set(blockId, mergeNativeTouchedEntry(map.get(blockId), lastWritten, baseline));
}

function nativeWhitespaceTouchedBlocksSet() {
	const tab = currentTab();
	if (tab) {
		if (!(tab.nativeWhitespaceTouchedBlocks instanceof Set)) {
			tab.nativeWhitespaceTouchedBlocks = new Set();
		}
		return tab.nativeWhitespaceTouchedBlocks;
	}
	if (!(state.nativeWhitespaceTouchedBlocks instanceof Set)) {
		state.nativeWhitespaceTouchedBlocks = new Set();
	}
	return state.nativeWhitespaceTouchedBlocks;
}

// Dessine la bande re-rendue par PDFium sur le canvas de la page (échelle
// device-pixels : la bande a été rendue à la résolution EXACTE du canvas).
async function drawNativeStrip(data, report) {
	if (!data?.canvas || !report?.stripPngBase64) return;
	const img = new Image();
	img.src = `data:image/png;base64,${report.stripPngBase64}`;
	try {
		await img.decode();
	} catch (_err) {
		return;
	}
	// Compteur de dessins natifs : un pré-rendu pleine page parti AVANT cette
	// bande ne doit pas l'écraser en arrivant après (voir primeNativePageCanvas).
	data._nativeDrawSeq = (data._nativeDrawSeq || 0) + 1;
	const context = data.canvas.getContext('2d', { alpha: false });
	if (!context) return;
	const ky = data.canvas.height / Math.max(1, report.imageHeightPx);
	context.drawImage(
		img,
		0,
		Math.round(report.stripTopPx * ky),
		data.canvas.width,
		Math.max(1, Math.round(report.stripHeightPx * ky))
	);
}

// Bascule le canvas de la page sur un rendu PDFium PLEINE PAGE, à l'entrée en
// édition d'un bloc éligible au natif — AVANT toute frappe. Sans ça, la bande
// re-rendue à la première frappe (rasteriseur PDFium) diffère subtilement du
// rendu PDF.js affiché autour (anti-aliasing, graisse) : le texte semblait
// « changer d'état » alors qu'aucun glyphe n'avait bougé. Même rasteriseur
// partout → les bandes suivantes sont pixel-identiques hors caractères édités.
async function primeNativePageCanvas(pageNumber) {
	const data = getPageData(pageNumber);
	if (!data?.canvas || !data.viewportWidth) return;
	if (data._nativePrimeInFlight) return;
	if (
		data._nativeCanvasPrimed &&
		data._nativeCanvasPrimed.token === data.renderToken &&
		data._nativeCanvasPrimed.width === data.canvas.width
	) {
		return;
	}
	const anchor = state.editBlocks.find(
		(candidate) => candidate.page === pageNumber && candidate.pdfPageWidth > 0
	);
	if (!anchor) return;
	const pdfPageWidth = anchor.pdfPageWidth;
	data._nativePrimeInFlight = true;
	try {
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const token = data.renderToken;
			const seq = data._nativeDrawSeq || 0;
			const scale = data.canvas.width / Math.max(1, pdfPageWidth);
			let report;
			try {
				report = await invokeCommand('render_pdf_page_cached', {
					id: currentDocId(),
					page: pageNumber,
					scale
				});
			} catch (error) {
				if (String(error).includes('cache_miss') && state.fileBytes && !state.nativeTextDirty) {
					await invokeCommand('cache_document', {
						id: currentDocId(),
						bytes: Array.from(state.fileBytes)
					});
					continue;
				}
				return;
			}
			const img = new Image();
			img.src = `data:image/png;base64,${report.pngBase64}`;
			try {
				await img.decode();
			} catch (_err) {
				return;
			}
			// Page re-rendue par PDF.js (zoom, sync) pendant le vol : caduc.
			if (data.renderToken !== token) return;
			// Une bande de frappe a été dessinée pendant le vol : notre image
			// pleine page est en retard d'une édition → on re-rend (le cache
			// Rust porte déjà les octets à jour).
			if ((data._nativeDrawSeq || 0) !== seq) continue;
			const context = data.canvas.getContext('2d', { alpha: false });
			if (!context) return;
			context.drawImage(img, 0, 0, data.canvas.width, data.canvas.height);
			data._nativeCanvasPrimed = { token, width: data.canvas.width };
			return;
		}
	} finally {
		data._nativePrimeInFlight = false;
	}
}

// Convertit les blocs d'une ré-analyse PDFium (points PDF) vers les coordonnées
// viewport de la page — même mapping que pdfiumEditBlocks.
function convertNativeAnalysisBlocks(analysis, data) {
	const pageWidth = analysis?.pageWidth || 1;
	const pageHeight = analysis?.pageHeight || 1;
	const scaleX = data.viewportWidth / pageWidth;
	const scaleY = data.viewportHeight / pageHeight;
	return (Array.isArray(analysis?.blocks) ? analysis.blocks : [])
		.filter((raw) => raw.kind !== 'image')
		.map((raw) => ({
			raw,
			x: raw.x * scaleX,
			y: raw.y * scaleY,
			width: raw.width * scaleX,
			height: raw.height * scaleY,
			fontSize: raw.fontSize > 0 ? raw.fontSize * scaleY : 0,
			chars: (Array.isArray(raw.chars) ? raw.chars : []).map((ch, charIndex) => ({
				index: charIndex,
				text: ch.text || '',
				x: (ch.x || 0) * scaleX,
				y: (ch.y || 0) * scaleY,
				width: Math.max(0.5, (ch.width || 0) * scaleX),
				height: Math.max(0.5, (ch.height || 0) * scaleY),
				maskX: (ch.maskX ?? ch.x ?? 0) * scaleX,
				maskY: (ch.maskY ?? ch.y ?? 0) * scaleY,
				maskWidth: Math.max(0.5, (ch.maskWidth ?? ch.width ?? 0) * scaleX),
				maskHeight: Math.max(0.5, (ch.maskHeight ?? ch.height ?? 0) * scaleY),
				pageCharIndex: Number.isInteger(ch.pageCharIndex) ? ch.pageCharIndex : -1
			}))
		}));
}

function nativeBlockOverlap(block, candidate) {
	const bx = block.originalX ?? block.x;
	const by = block.originalY ?? block.y;
	const bw = block.originalWidth ?? block.width;
	const bh = block.originalHeight ?? block.height;
	const left = Math.max(bx, candidate.x);
	const top = Math.max(by, candidate.y);
	const right = Math.min(bx + bw, candidate.x + candidate.width);
	const bottom = Math.min(by + bh, candidate.y + candidate.height);
	if (right <= left || bottom <= top) return 0;
	const inter = (right - left) * (bottom - top);
	const minArea = Math.max(1, Math.min(bw * bh, candidate.width * candidate.height));
	return inter / minArea;
}

function matchNativeAnalysisBlockByOverlap(block, converted, minScore = 0.5) {
	let best = null;
	let bestScore = 0;
	for (const candidate of converted) {
		const score = nativeBlockOverlap(block, candidate);
		if (score > bestScore) {
			bestScore = score;
			best = candidate;
		}
	}
	return bestScore >= minScore ? best : null;
}

function synthBlockFromClosestLine(block, lines) {
	if (!Array.isArray(lines) || !lines.length) return null;
	const cy = (block.y ?? 0) + (block.height ?? 0) / 2;
	let best = null;
	let bestDy = Infinity;
	for (const line of lines) {
		if (!line?.chars?.length) continue;
		const dy = Math.abs(line.y + line.height / 2 - cy);
		if (dy < bestDy) {
			bestDy = dy;
			best = line;
		}
	}
	if (!best) return null;
	const maxDy = Math.max(block.height || 0, best.height || 0, 8) * 1.75;
	if (bestDy > maxDy) return null;
	const chars = best.chars.map((ch, i) => ({ ...ch, index: i }));
	const left = Math.min(...chars.map((ch) => ch.x));
	const top = Math.min(...chars.map((ch) => ch.y));
	const right = Math.max(...chars.map((ch) => ch.x + ch.width));
	const bottom = Math.max(...chars.map((ch) => ch.y + ch.height));
	return {
		raw: {},
		x: left,
		y: top,
		width: Math.max(1, right - left),
		height: Math.max(1, bottom - top),
		fontSize: 0,
		chars
	};
}

function matchNativeAnalysisBlock(block, converted) {
	// Ligne issue d'un paragraphe éclaté : ne jamais réabsorber les lignes
	// voisines lors d'une ré-analyse (sinon les montants de facture refusionnent).
	if (block._lineLocked) {
		const record = nativeTouchedRecord(nativeTouchedBlocksMap().get(block.id));
		// Ordre : texte UI courant, baseline d'origine (post-restore), lastWritten.
		for (const target of [block.text || '', record?.baseline || '', record?.lastWritten || '']) {
			if (!stripWhitespace(target)) continue;
			const carved = carveNativeAnalysisBlock(block, converted, target);
			if (carved) return carved;
		}
	}
	return matchNativeAnalysisBlockByOverlap(block, converted, 0.5);
}

// Post-restore_native_page : le document est à l'ORIGINE. On doit retrouver les
// glyphes d'origine (baseline), pas lastWritten (absent du PDF restauré).
function resolveReplayAnalysisBlock(block, converted) {
	const record = nativeTouchedRecord(nativeTouchedBlocksMap().get(block.id));
	if (record?.baseline && stripWhitespace(record.baseline)) {
		const carved = carveNativeAnalysisBlock(block, converted, record.baseline);
		if (carved) return carved;
	}
	let best = matchNativeAnalysisBlockByOverlap(block, converted, 0.5);
	if (!best) best = matchNativeAnalysisBlockByOverlap(block, converted, 0.2);
	if (!best) return null;
	const lines = groupAnalysisCharsIntoLines(best.chars);
	if (lines.length > 1 && !(block.text || '').includes('\n')) {
		return synthBlockFromClosestLine(block, lines) || best;
	}
	return best;
}

// Groupe une liste de caractères d'analyse en lignes visuelles (même règle de
// proximité verticale que pdfCharLines, mais sur une liste brute).
function groupAnalysisCharsIntoLines(chars) {
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

// Cherche dans `lineChars` une sous-suite dont le texte sans blancs vaut
// exactement `squeezedTarget`. La recherche se fait dans l'ordre DOCUMENT
// (pageCharIndex) : quand deux blocs fusionnent, leurs caractères
// s'entrelacent par x mais restent CONTIGUS par index de page — c'est le seul
// ordre fiable. Les espaces internes (réels ou synthétiques) situés dans la
// plage retenue sont réinclus. Retourne la tranche triée par x, ou null.
function sliceLineForSqueezedText(lineChars, squeezedTarget) {
	if (!squeezedTarget) return null;
	const seenPci = new Set();
	const ordered = lineChars
		.filter(
			(ch) =>
				stripWhitespace(ch.text || '').length &&
				Number.isInteger(ch.pageCharIndex) &&
				ch.pageCharIndex >= 0
		)
		.sort((a, b) => a.pageCharIndex - b.pageCharIndex)
		.filter((ch) => {
			// Deux textes qui se CHEVAUCHENT physiquement : PDFium duplique les
			// caractères frontière dans deux segments (même index de page). Un
			// caractère du document n'existe qu'une fois — on garde le premier.
			if (seenPci.has(ch.pageCharIndex)) return false;
			seenPci.add(ch.pageCharIndex);
			return true;
		});
	for (let start = 0; start < ordered.length; start += 1) {
		let consumed = '';
		for (let i = start; i < ordered.length; i += 1) {
			const squeezedChar = stripWhitespace(ordered[i].text || '');
			if (!squeezedTarget.startsWith(consumed + squeezedChar)) break;
			consumed += squeezedChar;
			if (consumed === squeezedTarget) {
				const core = ordered.slice(start, i + 1);
				const pciLo = core[0].pageCharIndex;
				const pciHi = core[core.length - 1].pageCharIndex;
				const left = Math.min(...core.map((ch) => ch.x));
				const right = Math.max(...core.map((ch) => ch.x + ch.width));
				const spaces = lineChars.filter((ch) => {
					if (stripWhitespace(ch.text || '').length) return false;
					const pci = ch.pageCharIndex;
					if (Number.isInteger(pci) && pci >= 0) return pci > pciLo && pci < pciHi;
					// Espace synthétique (sans index) : rattaché par sa position.
					return ch.x > left && ch.x + ch.width < right;
				});
				return [...core, ...spaces].sort((a, b) => a.x - b.x);
			}
		}
	}
	return null;
}

// Quand le texte élargi d'un bloc touche un voisin, l'analyse peut FUSIONNER
// les deux (ou scinder un paragraphe) : plus aucun candidat ne porte le texte
// exact du bloc. Le document, lui, est correct — on DÉCOUPE alors, ligne par
// ligne, les caractères du bloc dans les candidats de la ré-analyse (ancrage
// sur le y de chaque ligne existante et le x du bloc). Retourne un candidat
// synthétique { x, y, width, height, fontSize, chars, raw } ou null.
function carveNativeAnalysisBlock(block, converted, expectedText) {
	const expectedLines = (expectedText || '')
		.split('\n')
		.map((line) => stripWhitespace(line))
		.filter((line) => line.length);
	if (!expectedLines.length) return null;
	const blockLines = pdfCharLines(block);
	const chars = [];
	let fontSize = 0;
	let fontName = '';
	for (let lineIndex = 0; lineIndex < expectedLines.length; lineIndex += 1) {
		const target = expectedLines[lineIndex];
		const refLine = blockLines[lineIndex];
		const refY = refLine
			? refLine.y + refLine.height / 2
			: block.y + (block.height * (lineIndex + 0.5)) / expectedLines.length;
		let bestSlice = null;
		let bestDy = Infinity;
		let bestDx = Infinity;
		let bestCandidate = null;
		for (const candidate of converted) {
			for (const line of groupAnalysisCharsIntoLines(candidate.chars)) {
				const dy = Math.abs(line.y + line.height / 2 - refY);
				if (dy > Math.max(line.height, refLine?.height || line.height)) continue;
				const slice = sliceLineForSqueezedText(line.chars, target);
				if (!slice) continue;
				const dx = Math.abs(slice[0].x - block.x);
				if (dy < bestDy - 0.5 || (Math.abs(dy - bestDy) <= 0.5 && dx < bestDx)) {
					bestDy = dy;
					bestDx = dx;
					bestSlice = slice;
					bestCandidate = candidate;
				}
			}
		}
		if (!bestSlice) return null;
		chars.push(...bestSlice);
		if (bestCandidate) {
			fontSize = fontSize || bestCandidate.fontSize;
			fontName = fontName || bestCandidate.raw?.fontName || '';
		}
	}
	const renumbered = chars.map((ch, i) => ({ ...ch, index: i }));
	const left = Math.min(...renumbered.map((ch) => ch.x));
	const top = Math.min(...renumbered.map((ch) => ch.y));
	const right = Math.max(...renumbered.map((ch) => ch.x + ch.width));
	const bottom = Math.max(...renumbered.map((ch) => ch.y + ch.height));
	return {
		raw: { fontName },
		x: left,
		y: top,
		width: right - left,
		height: bottom - top,
		fontSize,
		chars: renumbered
	};
}

function projectNativeWhitespace(chars, expectedText) {
	if (!Array.isArray(chars) || !(expectedText || '').length || expectedText.includes('\n')) return null;
	const actual = [...chars];
	if (stripWhitespace(nativeCharsText(actual)) !== stripWhitespace(expectedText)) return null;
	const expected = Array.from(expectedText);
	const projected = [];
	let actualIndex = 0;
	let expectedIndex = 0;
	while (expectedIndex < expected.length) {
		if (!/\s/u.test(expected[expectedIndex])) {
			while (actualIndex < actual.length && !stripWhitespace(actual[actualIndex].text || '').length) {
				actualIndex += 1;
			}
			const current = actual[actualIndex];
			if (!current || current.text !== expected[expectedIndex]) return null;
			projected.push({ ...current });
			actualIndex += 1;
			expectedIndex += 1;
			continue;
		}

		const runStart = expectedIndex;
		while (expectedIndex < expected.length && /\s/u.test(expected[expectedIndex])) {
			expectedIndex += 1;
		}
		const runLength = expectedIndex - runStart;
		const actualSpaces = [];
		while (actualIndex < actual.length && !stripWhitespace(actual[actualIndex].text || '').length) {
			actualSpaces.push(actual[actualIndex]);
			actualIndex += 1;
		}
		const previous = projected[projected.length - 1] || null;
		const next = actual[actualIndex] || null;
		const reference = actualSpaces.find((entry) => entry.pageCharIndex >= 0) || actualSpaces[0] || previous || next;
		if (!reference) return null;
		const fallbackWidth = Math.max(0.75, reference.height * 0.28);
		const left = previous
			? previous.x + previous.width
			: next
				? next.x - fallbackWidth * runLength
				: reference.x;
		const available = next ? next.x - left : fallbackWidth * runLength;
		const width = Math.max(0.5, available > 0 ? available / runLength : fallbackWidth);
		const hardSpace = actualSpaces.find((entry) => entry.pageCharIndex >= 0) || null;
		for (let offset = 0; offset < runLength; offset += 1) {
			projected.push({
				...reference,
				index: projected.length,
				text: expected[runStart + offset],
				x: left + width * offset,
				width,
				maskX: left + width * offset,
				maskWidth: width,
				pageCharIndex: offset === 0 && hardSpace ? hardSpace.pageCharIndex : -1
			});
		}
	}
	while (actualIndex < actual.length) {
		if (stripWhitespace(actual[actualIndex].text || '').length) return null;
		actualIndex += 1;
	}
	return projected.map((entry, index) => ({ ...entry, index }));
}

// Après une édition native : resynchronise les blocs de la page avec la
// ré-analyse. Le bloc édité reprend texte + géométrie + caractères du document ;
// les autres blocs vierges ne rafraîchissent que leurs index de page texte
// (ils GLISSENT quand le nombre de caractères de la page change).
function applyNativeAnalysisToPage(pageNumber, analysis, editedBlock, expectedText = null) {
	const data = getPageData(pageNumber);
	if (!data || !data.viewportWidth) return;
	const converted = convertNativeAnalysisBlocks(analysis, data);
	for (const block of state.editBlocks) {
		if (block.page !== pageNumber || block.kind === 'image' || block.hidden) continue;
		if (!Array.isArray(block.pdfChars) || !block.pdfChars.length) continue;
		const isEdited = editedBlock && block.id === editedBlock.id;
		if (!isEdited && (isBlockTextEdited(block) || hasLocalGlyphEdits(block))) continue;
		let best = matchNativeAnalysisBlock(block, converted);
		// Bloc édité : on CONNAÎT le texte attendu (celui qu'on vient d'écrire).
		// Si le meilleur candidat géométrique ne le porte pas (re-segmentation :
		// ligne fusionnée avec une voisine, colonne coupée…), on cherche un
		// candidat au texte EXACT — le matching géométrique seul liait le bloc
		// aux mauvais caractères et corrompait toutes les frappes suivantes.
		if (
			isEdited &&
			expectedText != null &&
			(!best || stripWhitespace(nativeCharsText(best.chars)) !== stripWhitespace(expectedText))
		) {
			let exact = null;
			let exactScore = 0;
			for (const candidate of converted) {
				if (stripWhitespace(nativeCharsText(candidate.chars)) !== stripWhitespace(expectedText)) {
					continue;
				}
				const score = nativeBlockOverlap(block, candidate);
				if (score > exactScore) {
					exactScore = score;
					exact = candidate;
				}
			}
			if (exact && exactScore >= 0.3) {
				best = exact;
			} else {
				// Aucun candidat ne porte le texte attendu : l'analyse a re-segmenté
				// (le texte élargi touche un voisin → blocs fusionnés/scindés). Le
				// DOCUMENT est correct : on découpe les caractères du bloc dans les
				// candidats, ligne par ligne (ancrage y/x).
				const carved = carveNativeAnalysisBlock(block, converted, expectedText);
				if (carved) {
					best = carved;
				} else {
					// Découpe impossible : adopter le meilleur candidat GÉOMÉTRIQUE
					// lierait le bloc aux mauvais caractères (corruption en cascade).
					// On gèle le natif : la vérification post-édition échouera et
					// déclenchera le repli HTML.
					block._nativeStale = true;
					continue;
				}
			}
		}
		if (!best) {
			block._nativeStale = true;
			continue;
		}
		if (
			isEdited &&
			expectedText != null &&
			nativeCharsText(best.chars) !== expectedText &&
			stripWhitespace(nativeCharsText(best.chars)) === stripWhitespace(expectedText)
		) {
			const projected = projectNativeWhitespace(best.chars, expectedText);
			if (!projected) {
				block._nativeStale = true;
				continue;
			}
			best = { ...best, chars: projected };
		}
		const docText = nativeCharsText(best.chars);
		if (isEdited) {
			block.x = best.x;
			block.y = best.y;
			block.width = best.width;
			block.height = best.height;
			block.originalX = best.x;
			block.originalY = best.y;
			block.originalWidth = best.width;
			block.originalHeight = best.height;
			block.pdfChars = best.chars;
			// Frappes encore en file : block.text porte un texte PLUS récent que le
			// document — on ne l'écrase pas (le prochain diff le rattrapera). Sans
			// file, le document est la vérité (glyphes manquants inclus). Pour un
			// paragraphe, on reconstruit ligne-par-ligne (docText n'a pas de \n).
			const wasMultiline = (expectedText || block.text || '').includes('\n');
			if (!block._nativeQueued) {
				const syncedText = wasMultiline ? pdfLinesText(pdfCharLines(block)) : docText;
				block.text = syncedText;
				block.originalText = syncedText;
			}
			block.multiline = wasMultiline;
			block.textEdited = false;
			block.inlineEditDirty = false;
			block.hiddenCharIndexes = [];
			block.localGlyphEdited = false;
			block.glyphTrimOnly = false;
			if (best.fontSize > 0) {
				block.pdfFontSize = best.fontSize;
				block.baseFontSize = best.fontSize;
			}
			block.fontName = best.raw.fontName || block.fontName;
			block.snapshotDataUrl = null;
			block.inkSnapshotDataUrl = null;
			delete block.editLetterSpacing;
			delete block._mounted;
			delete block._mountSig;
			block._nativeStale = false;
			// Cadre = encre serrée (évite le vide sous la ligne après une suppression).
			if (!wasMultiline && !block.boxResized) syncNativeEditBoxToInk(block);
		} else if (docText === nativeCharsText(nativeCharsSorted(block))) {
			const sorted = nativeCharsSorted(block);
			sorted.forEach((ch, i) => {
				ch.pageCharIndex = best.chars[i]?.pageCharIndex ?? -1;
			});
			block._nativeStale = false;
		} else {
			block._nativeStale = true;
		}
	}
}

// Reconstruit (texte, entrées) alignés 1:1 pour le diff natif. Monoligne :
// glyphes triés par index. Multiligne : reconstruction ligne-par-ligne, les
// '\n' étant des entrées VIRTUELLES (null, sans pageCharIndex) — le diff peut
// ainsi travailler sur le texte complet du bloc, sauts de ligne compris.
function nativeAlignedEntries(block) {
	if (!(block.text || '').includes('\n')) {
		const chars = nativeCharsSorted(block);
		return { baseText: nativeCharsText(chars), entries: chars };
	}
	const lines = pdfCharLines(block);
	const entries = [];
	let baseText = '';
	lines.forEach((line, lineIndex) => {
		if (lineIndex > 0) {
			entries.push(null);
			baseText += '\n';
		}
		for (const ch of line.chars) {
			entries.push(ch);
			baseText += ch.text || '';
		}
	});
	return { baseText, entries };
}

// Applique UNE édition native : diff préfixe/suffixe entre le texte porté par
// les glyphes du document et block.text, envoi au moteur, bande re-rendue,
// resynchronisation des blocs.
async function performNativeTextEdit(block) {
	const data = getPageData(block.page);
	if (!data || !data.canvas || !data.viewportWidth) throw new Error('page_not_ready');
	if (block._detached) throw new Error('block_detached');
	if (block._nativeStale) throw new Error('native_stale');
	const { baseText, entries } = nativeAlignedEntries(block);
	const newText = block.text || '';
	if (baseText === newText) return;
	// Multiligne : une édition native ne peut pas créer/supprimer une ligne.
	if (newText.split('\n').length !== baseText.split('\n').length) {
		throw new Error('multiline_structure');
	}
	const realChars = entries.filter(Boolean);
	if (!realChars.length) throw new Error('no_chars');
	// Espace « visuel » inter-segments : blanc entre deux objets texte du PDF,
	// présent dans block.text et les boîtes mais SANS caractère dans la page
	// texte (pageCharIndex = -1). Jamais d'ancre dessus, jamais supprimable
	// nativement (le document ne contient rien à supprimer).
	const isSoftEntry = (ch) =>
		ch && ch.pageCharIndex < 0 && !stripWhitespace(ch.text || '').length;
	// Indices page STRICTEMENT croissants exigés (espaces visuels exclus) : un
	// mapping incohérent (bloc re-mappé sur une mauvaise segmentation) produirait
	// un splice destructeur dans le document (caractères supprimés/insérés au
	// mauvais endroit).
	let lastHardPci = -1;
	for (const ch of realChars) {
		if (isSoftEntry(ch)) continue;
		const pci = ch.pageCharIndex;
		if (!Number.isInteger(pci) || pci < 0 || pci <= lastHardPci) {
			block._nativeStale = true;
			throw new Error('unmapped_chars');
		}
		lastHardPci = pci;
	}

	let prefix = 0;
	const maxPrefix = Math.min(baseText.length, newText.length);
	while (prefix < maxPrefix && baseText[prefix] === newText[prefix]) prefix += 1;
	let suffix = 0;
	const maxSuffix = Math.min(baseText.length, newText.length) - prefix;
	while (
		suffix < maxSuffix &&
		baseText[baseText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
	) {
		suffix += 1;
	}
	let removedEntries = entries.slice(prefix, baseText.length - suffix);
	let inserted = newText.slice(prefix, newText.length - suffix);
	const whitespaceOnlyEdit =
		baseText !== newText && stripWhitespace(baseText) === stripWhitespace(newText);
	let replaceWhitespaceRun = whitespaceOnlyEdit;
	if (whitespaceOnlyEdit) {
		let oldStart = prefix;
		let oldEnd = baseText.length - suffix;
		let newStart = prefix;
		let newEnd = newText.length - suffix;
		while (oldStart > 0 && isHorizontalWhitespace(baseText[oldStart - 1])) oldStart -= 1;
		while (oldEnd < baseText.length && isHorizontalWhitespace(baseText[oldEnd])) oldEnd += 1;
		while (newStart > 0 && isHorizontalWhitespace(newText[newStart - 1])) newStart -= 1;
		while (newEnd < newText.length && isHorizontalWhitespace(newText[newEnd])) newEnd += 1;
		if (oldStart !== newStart) throw new Error('whitespace_alignment');
		prefix = oldStart;
		removedEntries = entries.slice(oldStart, oldEnd);
		inserted = newText.slice(newStart, newEnd);
	}
	// PDFium omet souvent les espaces finaux de son analyse. Ils sont alors
	// projetés avec pageCharIndex=-1. Si le caractère suivant est tapé après ce
	// run, il faut réécrire « espaces + caractère » ensemble ; sinon le moteur
	// ancre le nouveau glyphe avant les espaces invisibles et le texte paraît
	// collé, tandis que les espaces restent après lui dans le flux PDF.
	// Important : ne PAS remonter au-delà d'un `\n` (isHorizontalWhitespace).
	if (!whitespaceOnlyEdit && inserted && removedEntries.length === 0) {
		let whitespaceStart = prefix;
		while (whitespaceStart > 0 && isHorizontalWhitespace(baseText[whitespaceStart - 1])) {
			whitespaceStart -= 1;
		}
		const precedingWhitespace = entries.slice(whitespaceStart, prefix);
		if (precedingWhitespace.some(isSoftEntry)) {
			prefix = whitespaceStart;
			removedEntries = precedingWhitespace;
			inserted = newText.slice(whitespaceStart, newText.length - suffix);
			replaceWhitespaceRun = true;
		}
	}
	if (replaceWhitespaceRun) {
		// Armer la restauration AVANT les validations propres aux espaces : une
		// espace synthétique refusée ne doit jamais provoquer un repli HTML avec
		// changement de police. Toute erreur pré-commit annule seulement la frappe.
		block._nativeAttemptBaseText = baseText;
		block._nativeAttemptCaret = prefix;
		block._nativeAttemptCommitted = false;
		block._nativeAttemptUndoLength = currentTab()?.undoStack?.length || 0;
	}
	// Un saut de ligne dans la zone modifiée = édition à cheval sur deux lignes
	// (sélection multiligne remplacée) : hors périmètre du natif.
	if (removedEntries.some((entry) => !entry)) throw new Error('multiline_structure');
	// Un espace VISUEL isolé n'existe pas dans le flux PDF. Seul le remplacement
	// explicite du run complet peut donc le manipuler sans ambiguïté.
	if (!replaceWhitespaceRun && removedEntries.some(isSoftEntry)) throw new Error('soft_space_edit');
	const removedChars = removedEntries.filter((entry) => !isSoftEntry(entry));
	// Ancres d'insertion : TOUJOURS un glyphe RÉEL de la ligne éditée. En début
	// de ligne N, l'entrée précédente est le '\n' virtuel (voire un glyphe de la
	// ligne N-1) : ancrer « après » lui enverrait l'insertion en FIN de ligne
	// précédente dans le flux → on ancre « avant » le premier glyphe qui suit.
	// Même logique pour un espace visuel (pas de caractère document) : on
	// remonte au dernier glyphe réel avant lui, sinon ancre « avant » le suivant.
	let insertAfter = -1;
	let insertBefore = -1;
	let prevEntry = null;
	for (let i = prefix - 1; i >= 0; i -= 1) {
		const entry = entries[i];
		if (!entry) break; // '\n' virtuel : frontière de ligne, on ancre « avant ».
		if (!isSoftEntry(entry)) {
			prevEntry = entry;
			break;
		}
	}
	if (prevEntry) {
		insertAfter = prevEntry.pageCharIndex;
	} else {
		let nextReal = null;
		for (let i = prefix; i < entries.length; i += 1) {
			if (entries[i] && !isSoftEntry(entries[i])) {
				nextReal = entries[i];
				break;
			}
		}
		insertBefore = (nextReal || realChars.find((ch) => !isSoftEntry(ch)) || realChars[0])
			.pageCharIndex;
	}

	// Bande à re-rendre : la LIGNE ÉDITÉE seulement (pas tout le bloc), pleine
	// largeur, marge généreuse (ascendantes/descendantes + anti-aliasing), en
	// POINTS PDF. Ligne éditée = celle des glyphes touchés par le diff.
	const pdfPageWidth = block.pdfPageWidth || data.viewportWidth;
	const pdfPageHeight = block.pdfPageHeight || data.viewportHeight;
	const cssToPtY = pdfPageHeight / data.viewportHeight;
	const anchorChars = removedChars.length
		? removedChars
		: [prevEntry || realChars.find(Boolean)].filter(Boolean);
	const anchorTop = Math.min(...anchorChars.map((ch) => ch.y));
	const anchorBottom = Math.max(...anchorChars.map((ch) => ch.y + ch.height));
	const anchorCenter = (anchorTop + anchorBottom) / 2;
	const lineChars = realChars.filter((ch) => {
		const center = ch.y + ch.height / 2;
		return Math.abs(center - anchorCenter) <= Math.max(ch.height, anchorBottom - anchorTop) * 0.6;
	});
	const bandChars = lineChars.length ? lineChars : realChars;
	const lineTopCss = Math.min(...bandChars.map((ch) => ch.y));
	const lineBottomCss = Math.max(...bandChars.map((ch) => ch.y + ch.height));
	const padCss = Math.max(4, (lineBottomCss - lineTopCss) * 0.9);
	// Bords calés ENTRE les lignes : une marge aveugle tranchait en plein milieu
	// de la ligne voisine (haut des lettres coupé, la bande PDFium ne raste pas
	// exactement comme PDF.js). On borne chaque côté au point médian entre la
	// ligne éditée et la ligne de texte la plus proche au-dessus / en dessous.
	let nearestAboveBottom = -Infinity;
	let nearestBelowTop = Infinity;
	for (const other of state.editBlocks) {
		if (other.page !== block.page || other.hidden || other.id === block.id) continue;
		if (!Array.isArray(other.pdfChars)) continue;
		for (const ch of other.pdfChars) {
			const chBottom = ch.y + ch.height;
			if (chBottom <= lineTopCss && chBottom > nearestAboveBottom) nearestAboveBottom = chBottom;
			if (ch.y >= lineBottomCss && ch.y < nearestBelowTop) nearestBelowTop = ch.y;
		}
	}
	// Bloc multiligne : ses PROPRES autres lignes sont les voisines les plus
	// proches — la bande doit s'arrêter à mi-chemin pour ne pas les trancher.
	for (const ch of realChars) {
		if (bandChars.includes(ch)) continue;
		const chBottom = ch.y + ch.height;
		if (chBottom <= lineTopCss && chBottom > nearestAboveBottom) nearestAboveBottom = chBottom;
		if (ch.y >= lineBottomCss && ch.y < nearestBelowTop) nearestBelowTop = ch.y;
	}
	let stripTopCss = lineTopCss - padCss;
	let stripBottomCss = lineBottomCss + padCss;
	if (Number.isFinite(nearestAboveBottom)) {
		stripTopCss = Math.max(stripTopCss, (nearestAboveBottom + lineTopCss) / 2);
	}
	if (Number.isFinite(nearestBelowTop)) {
		stripBottomCss = Math.min(stripBottomCss, (nearestBelowTop + lineBottomCss) / 2);
	}
	const stripTop = Math.max(0, stripTopCss * cssToPtY);
	const stripHeight = Math.min(
		pdfPageHeight - stripTop,
		Math.max(1, (stripBottomCss - stripTopCss)) * cssToPtY
	);
	const scale = data.canvas.width / Math.max(1, pdfPageWidth);

	// Garde PRÉ-COMMIT côté Rust : l'édition n'est commise que si la ré-analyse
	// porte toujours un bloc au texte attendu à cet emplacement (sinon l'UI ne
	// pourrait plus suivre le bloc et le document serait modifié « en aveugle »).
	const cssToPtX = pdfPageWidth / data.viewportWidth;
	const blockRect = [
		(block.originalX ?? block.x) * cssToPtX,
		(block.originalY ?? block.y) * cssToPtY,
		(block.originalWidth ?? block.width) * cssToPtX,
		(block.originalHeight ?? block.height) * cssToPtY
	];
	const args = {
		id: currentDocId(),
		page: block.page,
		removed: removedChars.map((ch) => ch.pageCharIndex),
		insertAfter,
		insertBefore,
		inserted,
		stripTop,
		stripHeight,
		scale,
		expectedBlockText: newText,
		blockRect,
		replaceWhitespaceRun
	};
	if (typeof block._nativeAttemptBaseText !== 'string') {
		block._nativeAttemptBaseText = baseText;
		block._nativeAttemptCaret = prefix;
		block._nativeAttemptCommitted = false;
		block._nativeAttemptUndoLength = currentTab()?.undoStack?.length || 0;
	}
	let report;
	try {
		report = await invokeCommand('edit_pdf_text_cached', args);
	} catch (error) {
		// Cache Rust purgé : on le re-prime avec les octets courants (qui incluent
		// les éditions déjà synchronisées) puis on rejoue UNE fois.
		if (String(error).includes('cache_miss') && state.fileBytes && !state.nativeTextDirty) {
			await invokeCommand('cache_document', {
				id: currentDocId(),
				bytes: Array.from(state.fileBytes)
			});
			report = await invokeCommand('edit_pdf_text_cached', args);
		} else {
			throw error;
		}
	}
	block._nativeAttemptCommitted = true;

	state.nativeTextDirty = true;
	nativeEditedPagesSet().add(block.page);
	nativeTouchedPagesSet().add(block.page);
	rememberNativeTouchedBlock(block.id, newText, baseText);
	if (replaceWhitespaceRun) nativeWhitespaceTouchedBlocksSet().add(block.id);
	await drawNativeStrip(data, report);
	applyNativeAnalysisToPage(block.page, report.analysis, block, newText);
	// Glyphe absent de la police embarquée : le moteur l'a JETÉ silencieusement.
	// On ne continue pas en natif (le texte UI divergerait du document à chaque
	// frappe) : bascule HTML avec police de substitution + badge d'avertissement.
	if (report.glyphsOk === false) {
		block.nativeGlyphWarning = true;
		block._nativeStale = true;
		throw new Error('missing_glyphs');
	}
	// VÉRIFICATION : utiliser EXACTEMENT le même ordre que le prochain diff.
	// Monoligne = index PDF ; multiligne = lignes visuelles haut→bas puis
	// caractères gauche→droite. Trier globalement les index PDF d'un paragraphe
	// multiligne plaçait parfois le glyphe fraîchement inséré en fin de bloc,
	// déclenchait un faux native_out_of_sync, puis un repli HTML avec changement
	// de police et caret expédié à la fin.
	const docTextNow = nativeAlignedEntries(block).baseText;
	if (stripWhitespace(docTextNow) !== stripWhitespace(newText)) {
		block._nativeStale = true;
		throw new Error('native_out_of_sync');
	}

	// Dernière édition de la file : re-rendu du bloc (géométrie/texte à jour)
	// avec conservation du caret natif, et recalibrage de l'espacement du
	// texte transparent sur la nouvelle largeur de ligne.
	if (!block._nativeQueued) {
		const editingElement = elements.pagesStack.querySelector(
			`.edit-block.editing[data-block-id="${block.id}"]`
		);
		const caret = editingElement ? caretTextOffset(editingElement) : null;
		renderEditBlocksForPage(block.page);
		if (state.editingBlockId === block.id) {
			requestAnimationFrame(() => {
				const next = elements.pagesStack.querySelector(
					`.edit-block.editing[data-block-id="${block.id}"]`
				);
				if (!next) return;
				if (!block.multiline) fitEditTextWidth(next, block);
				next.focus({ preventScroll: true });
				if (caret != null) {
					placeCaretAtTextOffset(next, Math.max(0, Math.min(caret, (block.text || '').length)));
				}
			});
		}
	}
	block._nativeUndoCommittedLength = block._nativeAttemptUndoLength;
	delete block._nativeAttemptBaseText;
	delete block._nativeAttemptCaret;
	delete block._nativeAttemptCommitted;
	delete block._nativeAttemptUndoLength;
}

// stripWhitespace : voir ./block-state.js.

// Ramène le document Rust à l'état d'AVANT la session de frappe native
// (state.fileBytes n'avance qu'à la synchronisation). Appelé quand une édition
// native échoue APRÈS avoir écrit dans le document : sans cette restauration,
// le repli HTML se superposerait à un document déjà modifié — texte en double
// à l'écran et Cmd+Z définitivement incapable de retrouver l'état d'origine.
async function restoreNativeDocumentBaseline(pageNumber) {
	// La restauration des octets n'a de sens que si la session n'a pas encore
	// été synchronisée dans state.fileBytes. Mais le RAFRAÎCHISSEMENT du canvas
	// et la ré-analyse doivent avoir lieu dans TOUS les cas : sinon les bandes
	// de la session avortée restent peintes sous le repli HTML (glyphes
	// décalés, accents parasites, lettres à moitié masquées).
	const mustRestore = Boolean(
		state.nativeTextDirty && state.fileBytes && state.fileBytes.length
	);
	try {
		if (mustRestore) {
			await invokeCommand('cache_document', {
				id: currentDocId(),
				bytes: Array.from(state.fileBytes)
			});
			state.nativeTextDirty = false;
			nativeEditedPagesSet().clear();
		}
		const data = getPageData(pageNumber);
		if (data) {
			data.rendered = false;
			data.renderToken += 1;
			data._nativeCanvasPrimed = null;
		}
		await renderPage(pageNumber);
		// Les index de page texte des blocs vierges ont GLISSÉ pendant la
		// session annulée : on les réaligne sur le document restauré.
		const analysis = await analyzePageCached(pageNumber);
		applyNativeAnalysisToPage(pageNumber, analysis, null);
	} catch (error) {
		console.warn('Restauration du document natif impossible.', error);
	}
	return mustRestore;
}

// File d'attente par bloc : une seule édition native en vol, les frappes
// intermédiaires sont fusionnées (le diff se recalcule sur le DERNIER texte).
// Les files en cours sont suivies globalement : la réconciliation post-undo
// attend leur drainage complet avant d'analyser le document (sinon elle
// calculerait des diffs sur un document en train de changer).
const _nativeQueueRuns = new Set();

function rejectUncommittedNativeEdit(block, error) {
	if (
		block._nativeAttemptCommitted !== false ||
		typeof block._nativeAttemptBaseText !== 'string'
	) {
		return false;
	}
	const stableText = block._nativeAttemptBaseText;
	const caret = Math.max(
		0,
		Math.min(block._nativeAttemptCaret ?? stableText.length, stableText.length)
	);
	const tab = currentTab();
	if (tab && Number.isInteger(block._nativeUndoCommittedLength)) {
		tab.undoStack = (tab.undoStack || []).slice(0, block._nativeUndoCommittedLength);
		tab.redoStack = [];
		if (!block._nativeSessionDirtyBefore && block._nativeUndoCommittedLength === block._nativeUndoStart) {
			tab.dirty = false;
		}
	}
	block.text = stableText;
	block.originalText = stableText;
	block.textEdited = false;
	block.inlineEditDirty = false;
	block._nativeStale = false;
	block._nativeQueued = false;
	block.snapshotDataUrl = null;
	block.inkSnapshotDataUrl = null;
	delete block._nativeAttemptBaseText;
	delete block._nativeAttemptCaret;
	delete block._nativeAttemptCommitted;
	delete block._nativeAttemptUndoLength;
	if (elements.editText) elements.editText.value = stableText;
	if (elements.editTextPanel) elements.editTextPanel.value = stableText;
	renderEditBlocksForPage(block.page);
	updateUndoRedoButtons();
	refreshHistoryPanelIfVisible();
	renderTabs();
	persistCurrentTabState();
	requestAnimationFrame(() => {
		const editing = elements.pagesStack.querySelector(
			`.edit-block.editing[data-block-id="${block.id}"]`
		);
		if (!editing) return;
		editing.focus({ preventScroll: true });
		placeCaretAtTextOffset(editing, caret);
		scheduleNativeCaretUpdate();
	});
	setStatus(
		currentLocale() === 'fr'
			? 'Cette frappe a été refusée pour préserver exactement le PDF.'
			: 'This keystroke was rejected to preserve the PDF exactly.',
		'info'
	);
	console.warn('Édition native refusée sans changement de rendu.', error);
	return true;
}

async function recoverCommittedNativeMismatch(block, error) {
	if (
		block._nativeAttemptCommitted !== true ||
		!String(error?.message || error).includes('native_out_of_sync')
	) {
		return false;
	}
	const tab = currentTab();
	await restoreNativeDocumentBaseline(block.page);
	const stableText = nativeAlignedEntries(block).baseText;
	if (tab && Number.isInteger(block._nativeUndoStart)) {
		tab.undoStack = (tab.undoStack || []).slice(0, block._nativeUndoStart);
		tab.redoStack = [];
		if (!block._nativeSessionDirtyBefore) tab.dirty = false;
	}
	block.text = stableText;
	block.originalText = stableText;
	block.textEdited = false;
	block.inlineEditDirty = false;
	block._nativeStale = false;
	block._nativeQueued = false;
	if (elements.editText) elements.editText.value = stableText;
	if (elements.editTextPanel) elements.editTextPanel.value = stableText;
	renderEditBlocksForPage(block.page);
	updateUndoRedoButtons();
	refreshHistoryPanelIfVisible();
	renderTabs();
	persistCurrentTabState();
	requestAnimationFrame(() => {
		const editing = elements.pagesStack.querySelector(
			`.edit-block.editing[data-block-id="${block.id}"]`
		);
		if (!editing) return;
		editing.focus({ preventScroll: true });
		placeCaretAtTextOffset(
			editing,
			Math.max(0, Math.min(block._nativeAttemptCaret ?? stableText.length, stableText.length))
		);
		scheduleNativeCaretUpdate();
	});
	setStatus(
		currentLocale() === 'fr'
			? 'La frappe a été annulée sans changer la police ni le rendu du PDF.'
			: 'The keystroke was cancelled without changing the PDF font or rendering.',
		'info'
	);
	console.warn('Incohérence native restaurée sans repli HTML.', error);
	return true;
}

function queueNativeTextEdit(block) {
	block._nativeQueued = true;
	if (block._nativeBusy) return;
	block._nativeBusy = true;
	const run = (async () => {
		try {
			while (block._nativeQueued) {
				block._nativeQueued = false;
				// Bloc DÉTACHÉ (un undo/redo a remplacé state.editBlocks pendant le
				// vol) : on abandonne, la réconciliation post-historique reprend la
				// main sur les NOUVEAUX objets blocs.
				if (block._detached) return;
				try {
					await performNativeTextEdit(block);
				} catch (error) {
					if (block._detached) return;
					if (rejectUncommittedNativeEdit(block, error)) {
						try {
							void invokeCommand('alto_debug', {
								line: `native_rejected page=${block.page} err=${String(error?.message || error)} text=${JSON.stringify((block.text || '').slice(0, 80))}`
							});
						} catch (_e) {
							/* diagnostic seulement */
						}
						return;
					}
					if (await recoverCommittedNativeMismatch(block, error)) return;
					const rejectMsg = String(error?.message || error);
					// Collision / glyphe manquant : jamais de fantôme HTML par-dessus
					// le PDF intact (sinon « u » collé sur « n » après un refus).
					if (
						rejectMsg.includes('insert_collision') ||
						rejectMsg.includes('missing_glyphs')
					) {
						block.nativeGlyphWarning = rejectMsg.includes('missing_glyphs');
						block._nativeStale = false;
						block._nativeQueued = false;
						try {
							void invokeCommand('alto_debug', {
								line: `native_rejected_hard page=${block.page} err=${rejectMsg} text=${JSON.stringify((block.text || '').slice(0, 80))}`
							});
						} catch (_e) {
							/* diagnostic seulement */
						}
						renderEditBlocksForPage(block.page);
						setStatus(
							currentLocale() === 'fr'
								? 'Cette frappe a été refusée pour préserver exactement le PDF.'
								: 'This keystroke was rejected to preserve the PDF exactly.',
							'info'
						);
						return;
					}
					// Repli : édition HTML classique (police métrique-compatible).
					console.warn('Édition native indisponible, repli HTML.', error);
					try {
						const indices = (Array.isArray(block.pdfChars) ? block.pdfChars : [])
							.map((ch) => ch.pageCharIndex)
							.join(',');
						void invokeCommand('alto_debug', {
							line: `native_fallback page=${block.page} err=${rejectMsg} editing=${state.editingBlockId === block.id} text=${JSON.stringify((block.text || '').slice(0, 80))} idx=[${indices.slice(0, 160)}]`
						});
					} catch (_e) {
						/* diagnostic seulement */
					}
					block._nativeStale = true;
					block._nativeQueued = false;
					const target = block.text || '';
					// Des frappes de CETTE session ont pu être écrites dans le
					// document avant l'échec : on le ramène à l'état d'avant-session
					// pour que le repli HTML se superpose au document INTACT.
					await restoreNativeDocumentBaseline(block.page);
					// L'invariant vierge (text === originalText) était maintenu de
					// façon optimiste : on ré-ancre originalText et les glyphes sur
					// l'état d'AVANT la session (le document vient d'y être ramené),
					// puis bascule HTML.
					if (block._nativePristine) {
						block.originalText = block._nativePristine.text;
						block.pdfChars = block._nativePristine.chars;
					} else {
						block.originalText = nativeCharsText(nativeCharsSorted(block));
					}
					const element = elements.pagesStack.querySelector(
						`.edit-block.editing[data-block-id="${block.id}"]`
					);
					const caret = element ? caretTextOffset(element) : null;
					applyGlyphEditHtml(block, target, caret == null ? target.length : caret);
					return;
				}
			}
		} finally {
			block._nativeBusy = false;
			delete block._nativeAttemptBaseText;
			delete block._nativeAttemptCaret;
			delete block._nativeAttemptCommitted;
			delete block._nativeAttemptUndoLength;
			delete block._nativeUndoStart;
			delete block._nativeUndoCommittedLength;
			delete block._nativeSessionDirtyBefore;
			// L'utilisateur a quitté l'édition pendant le vol : la synchronisation
			// déclenchée au blur est passée AVANT la dernière réponse moteur → on
			// resynchronise les octets maintenant que la file est vide.
			if (!block._detached && state.nativeTextDirty && state.editingBlockId !== block.id) {
				void syncNativeDocumentBytes({ render: false });
			}
		}
	})();
	_nativeQueueRuns.add(run);
	void run.finally(() => _nativeQueueRuns.delete(run));
}

// Tente le chemin natif pour une frappe en mode glyphe. Retourne true si pris
// en charge (mise à jour optimiste immédiate + édition moteur en arrière-plan).
function tryNativeTextEdit(block, newText, caretOffset) {
	if (!nativeTextEditEligible(block)) return false;
	// Multiligne : le natif édite UNE ligne à la fois. Ajouter/supprimer un
	// saut de ligne change la structure → HTML. Une frappe qui laisse le
	// nombre de lignes inchangé reste native (cas « q » en fin de ligne 2).
	if ((newText || '').includes('\n') || (block.text || '').includes('\n')) {
		const baseLineCount = (block.text || '').split('\n').length;
		if ((newText || '').split('\n').length !== baseLineCount) return false;
	}
	// Le diff par offsets exige un alignement 1:1 entre block.text et les
	// glyphes (pas d'espace « visuel » synthétisé par l'analyse). Pendant une
	// session native EN VOL, block.text est en avance sur les glyphes (mise à
	// jour optimiste) : l'alignement a déjà été validé au départ de la session.
	// Multiligne : la reconstruction ligne-par-ligne (avec \n) est la référence.
	const sessionActive = Boolean(block._nativeBusy || block._nativeQueued);
	if (!sessionActive) {
		const baselineText = (block.text || '').includes('\n')
			? pdfLinesText(pdfCharLines(block))
			: nativeCharsText(nativeCharsSorted(block));
		if (baselineText !== (block.text || '')) return false;
	}
	if (newText === block.text) return false;
	// Début de session : mémoriser l'état vierge (texte + glyphes) pour pouvoir
	// y revenir si une édition de la session échoue APRÈS écriture document.
	if (!sessionActive) {
		const tab = currentTab();
		block._nativeUndoStart = tab?.undoStack?.length || 0;
		block._nativeUndoCommittedLength = block._nativeUndoStart;
		block._nativeSessionDirtyBefore = Boolean(tab?.dirty);
		const editingElement = elements.pagesStack.querySelector(
			`.edit-block.editing[data-block-id="${block.id}"]`
		);
		const editBoxHeight = editingElement
			? Number.parseFloat(editingElement.style.height) || editingElement.getBoundingClientRect().height
			: Math.max(block.height, 14);
		block._nativePristine = {
			text: block.text || '',
			chars: Array.isArray(block.pdfChars) ? block.pdfChars.map((ch) => ({ ...ch })) : [],
			editBoxHeight
		};
	}
	pushHistory('histTextEdit');
	block.text = newText;
	// Invariant vierge maintenu pendant le vol : le bloc reste rendu en mode
	// pristine (HTML transparent posé sur le pixel natif), jamais en HTML opaque.
	block.originalText = newText;
	block.snapshotDataUrl = null;
	block.inkSnapshotDataUrl = null;
	block.localCaretIndex = null;
	state.selectedBlockId = block.id;
	if (elements.editText) elements.editText.value = newText;
	if (elements.editTextPanel) elements.editTextPanel.value = newText;
	markDirty();
	renderEditBlocksForPage(block.page);
	requestAnimationFrame(() => {
		const next = elements.pagesStack.querySelector(
			`.edit-block.editing[data-block-id="${block.id}"]`
		);
		if (!next) return;
		next.focus({ preventScroll: true });
		placeCaretAtTextOffset(next, Math.max(0, Math.min(caretOffset, newText.length)));
	});
	queueNativeTextEdit(block);
	return true;
}

// Synchronise les octets JS + PDF.js avec le document édité côté Rust. Appelé
// au blur (fin de session de frappe), avant un zoom et avant tout export.
async function syncNativeDocumentBytes(options = {}) {
	if (!state.nativeTextDirty) return false;
	if (state._nativeSyncPromise) return state._nativeSyncPromise;
	state._nativeSyncPromise = (async () => {
		try {
			const bytes = await invokeBytes('get_cached_document', { id: currentDocId() });
			if (!bytes || !bytes.length) return false;
			state.fileBytes = bytes;
			const tab = currentTab();
			if (tab) tab.fileBytes = bytes;
			const loadingTask = pdfjsLib.getDocument(pdfDocumentOptions({ data: bytes.slice() }));
			const pdf = await loadingTask.promise;
			state.pdf = pdf;
			if (tab) tab.pdf = pdf;
			state.nativeTextDirty = false;
			nativeEditedPagesSet().clear();
			if (options.render !== false) {
				invalidateAllPages();
				await renderCurrentPage();
			}
			return true;
		} catch (error) {
			console.warn('Synchronisation du document édité impossible.', error);
			return false;
		} finally {
			state._nativeSyncPromise = null;
		}
	})();
	return state._nativeSyncPromise;
}

// Après un undo/redo : le document Rust porte peut-être un texte plus récent
// que l'état restauré. On rafraîchit les index depuis le document puis on
// ré-émet une édition native pour ramener le document à ce que l'UI affiche.
// SÉRIALISÉ : des Cmd+Z en rafale lançaient des réconciliations concurrentes
// dont les éditions inverses s'entrelaçaient (lettres dupliquées). Une seule
// passe à la fois ; les demandes arrivées pendant une passe déclenchent UNE
// passe de rattrapage sur l'état final.
let _reconcileRunning = false;
let _reconcilePending = false;
async function reconcileNativeEditsAfterHistory() {
	if (_reconcileRunning) {
		_reconcilePending = true;
		return;
	}
	_reconcileRunning = true;
	try {
		do {
			_reconcilePending = false;
			await reconcileNativeEditsPass();
		} while (_reconcilePending);
	} finally {
		_reconcileRunning = false;
	}
}

async function reconcileNativeEditsPass() {
	// Drainer les files d'édition en vol : leurs réponses moteur modifieraient
	// le document APRÈS notre analyse (diffs calculés sur un état périmé).
	while (_nativeQueueRuns.size) {
		await Promise.allSettled([..._nativeQueueRuns]);
	}
	const pages = new Set([...nativeEditedPagesSet(), ...nativeTouchedPagesSet()]);
	for (const pageNumber of pages) {
		// UNDO PAR VERSIONNAGE : le moteur a mémorisé le flux de contenu
		// D'ORIGINE de la page à sa première édition. On le restaure (le
		// document redevient exactement l'original), puis on REJOUE le texte de
		// l'UI en une édition avant calculée depuis cet état propre — au lieu
		// de l'édition inverse par diff sur un document déjà modifié, fragile
		// quand l'analyse re-segmentait les blocs (fusion avec un voisin).
		let restored = false;
		try {
			restored = await invokeCommand('restore_native_page', {
				id: currentDocId(),
				page: pageNumber
			});
		} catch (_err) {
			restored = false;
		}
		if (restored) {
			await replayNativeEditsOnRestoredPage(pageNumber);
		} else {
			await legacyReconcilePage(pageNumber);
		}
	}
}

// Rejeu post-restauration : ré-analyse le document restauré (segmentation
// d'ORIGINE, matching géométrique fiable), réaligne les index de tous les
// blocs, puis ré-applique le texte de l'UI aux blocs touchés qui divergent.
async function replayNativeEditsOnRestoredPage(pageNumber) {
	// Le cache Rust diverge maintenant des octets JS : synchronisation requise
	// au prochain blur/zoom/export.
	state.nativeTextDirty = true;
	nativeEditedPagesSet().add(pageNumber);
	const data = getPageData(pageNumber);
	if (!data || !data.viewportWidth) return;
	let analysis;
	try {
		analysis = await analyzePageCached(pageNumber);
	} catch (_err) {
		return;
	}
	applyNativeAnalysisToPage(pageNumber, analysis, null);
	const converted = convertNativeAnalysisBlocks(analysis, data);
	const touchedBlocks = nativeTouchedBlocksMap();
	const whitespaceTouchedBlocks = nativeWhitespaceTouchedBlocksSet();
	const divergingIds = [];
	for (const block of state.editBlocks) {
		if (block.page !== pageNumber || block.kind === 'image' || block.hidden) continue;
		if (!touchedBlocks.has(block.id)) continue;
		if (block._nativeBusy || block._nativeQueued) continue;
		if (isBlockTextEdited(block) || hasLocalGlyphEdits(block)) continue;
		const best = resolveReplayAnalysisBlock(block, converted);
		if (!best) {
			block._nativeStale = true;
			continue;
		}
		block.pdfChars = best.chars;
		block._nativeStale = false;
		const docText = nativeCharsText(best.chars);
		const diverges = whitespaceTouchedBlocks.has(block.id)
			? (block.text || '') !== docText
			: stripWhitespace(block.text || '') !== stripWhitespace(docText);
		if (diverges) {
			divergingIds.push(block.id);
		}
	}
	// Rejeu SÉRIALISÉ, une analyse fraîche par bloc : chaque édition décale les
	// index de page des caractères suivants.
	for (let i = 0; i < divergingIds.length; i += 1) {
		const block = state.editBlocks.find((b) => b.id === divergingIds[i]);
		if (!block || block._detached) continue;
		if (i > 0) {
			let fresh;
			try {
				fresh = await analyzePageCached(pageNumber);
			} catch (_err) {
				break;
			}
			const freshConverted = convertNativeAnalysisBlocks(fresh, data);
			const best = resolveReplayAnalysisBlock(block, freshConverted);
			if (!best) {
				block._nativeStale = true;
				continue;
			}
			block.pdfChars = best.chars;
			block._nativeStale = false;
		}
		// Diff natif = glyphes document (pdfChars) → block.text (UI).
		// Ne pas écraser originalText ici : performNativeTextEdit lit pdfChars.
		queueNativeTextEdit(block);
		while (_nativeQueueRuns.size) {
			await Promise.allSettled([..._nativeQueueRuns]);
		}
	}
	// Canvas : rendu pleine page depuis le document restauré/rejoué (les bandes
	// affichées peuvent encore montrer le texte annulé).
	data._nativeCanvasPrimed = null;
	await primeNativePageCanvas(pageNumber);
}

// Ancien chemin (aucun point de restauration : cache re-primé, document jamais
// édité nativement dans cette génération…) : édition INVERSE par diff entre le
// document courant et l'état restauré.
async function legacyReconcilePage(pageNumber) {
	{
		let analysis;
		try {
			analysis = await analyzePageCached(pageNumber);
		} catch (_err) {
			return;
		}
		const data = getPageData(pageNumber);
		if (!data || !data.viewportWidth) return;
		const converted = convertNativeAnalysisBlocks(analysis, data);
		const touchedBlocks = nativeTouchedBlocksMap();
		const whitespaceTouchedBlocks = nativeWhitespaceTouchedBlocksSet();
		for (const block of state.editBlocks) {
			if (block.page !== pageNumber || block.kind === 'image' || block.hidden) continue;
			if (block._nativeBusy || block._nativeQueued) continue;
			if (isBlockTextEdited(block) || hasLocalGlyphEdits(block)) continue;
			if (!Array.isArray(block.pdfChars) || !block.pdfChars.length) continue;
			let best = matchNativeAnalysisBlock(block, converted);
			// Bloc édité nativement : on connaît le DERNIER texte écrit dans le
			// document. Si le candidat géométrique ne le porte pas (le texte
			// élargi a fusionné l'analyse avec un voisin), on découpe les
			// caractères du bloc dans les candidats — sans quoi le diff inverse
			// partirait des caractères du VOISIN et les supprimerait du document.
			if (touchedBlocks.has(block.id)) {
				const record = nativeTouchedRecord(touchedBlocks.get(block.id));
				const lastWritten = record?.lastWritten || '';
				const bestCarries =
					best && stripWhitespace(nativeCharsText(best.chars)) === stripWhitespace(lastWritten);
				if (!bestCarries) {
					// Document encore édité : carver lastWritten. Sinon baseline
					// (état d'origine) pour un undo partiel / sync bizarre.
					const carved =
						carveNativeAnalysisBlock(block, converted, lastWritten) ||
						(record?.baseline
							? carveNativeAnalysisBlock(block, converted, record.baseline)
							: null);
					if (carved) {
						best = carved;
					} else {
						// Ni candidat exact ni découpe : partir du candidat géométrique
						// (texte d'un VOISIN fusionné) rendrait le diff inverse
						// destructeur. On gèle le natif pour ce bloc.
						block._nativeStale = true;
						continue;
					}
				}
			}
			if (!best) {
				block._nativeStale = true;
				continue;
			}
			block.pdfChars = best.chars;
			block._nativeStale = false;
			const docText = nativeCharsText(best.chars);
			// PÉRIMÈTRE STRICT : seuls les blocs ayant reçu une édition native
			// peuvent nécessiter une édition inverse. Un bloc jamais édité dont
			// le texte diverge du document, c'est un désalignement d'ANALYSE
			// (segmentation, espaces visuels), pas une édition à annuler —
			// le ré-éditer le corrompait ou le basculait en HTML à chaque undo.
			if (!touchedBlocks.has(block.id)) continue;
			// Comparaison insensible aux blancs : le texte d'un bloc peut porter
			// des espaces « visuels » (écarts de crénage) absents des caractères
			// du document — ce n'est PAS une divergence de contenu. Sans cette
			// tolérance, chaque Cmd+Z émettait de fausses éditions inverses sur
			// les blocs crénés (insertion d'espaces réels dans le document !).
			// Les blocs MULTILIGNES sont réconciliés comme les autres depuis que
			// le natif les édite : les exclure laissait le document porter les
			// frappes annulées (caractères « fantômes » visibles mais
			// inatteignables au caret après Cmd+Z).
			const diverges = whitespaceTouchedBlocks.has(block.id)
				? (block.text || '') !== docText
				: stripWhitespace(block.text || '') !== stripWhitespace(docText);
			if (diverges) {
				// Le document diverge de l'état restauré → édition native inverse.
				block.originalText = block.text;
				queueNativeTextEdit(block);
			}
		}
	}
}

function commitGlyphEdit(block, newText, caretOffset) {
	if (tryNativeTextEdit(block, newText, caretOffset)) return;
	// Bloc natif : jamais de repli HTML qui ajoute/supprime des lignes
	// (Entrée → « espaces » vides sous les montants de facture).
	if (nativeTextEditEligible(block)) {
		const before = (block.text || '').split('\n').length;
		const after = (newText || '').split('\n').length;
		if (before !== after) {
			setStatus(
				currentLocale() === 'fr'
					? 'Ajout ou suppression de ligne non supporté sur ce texte PDF.'
					: 'Adding or removing lines is not supported on this PDF text.',
				'info'
			);
			return;
		}
	}
	pushHistory('histTextEdit');
	applyGlyphEditHtml(block, newText, caretOffset);
}

// Index de ligne visuelle sous un point client (pour éclater un paragraphe).
function lineIndexFromClientPoint(block, clientX, clientY) {
	const lines = pdfCharLines(block);
	if (lines.length <= 1) return 0;
	const data = getPageData(block.page);
	const rect = data?.editLayer?.getBoundingClientRect();
	if (!rect || !Number.isFinite(clientY)) return 0;
	let pageY = clientY - rect.top;
	const { dy } = blockMoveDelta(block);
	pageY -= dy;
	let best = 0;
	let bestDist = Infinity;
	for (let i = 0; i < lines.length; i += 1) {
		const center = lines[i].y + lines[i].height / 2;
		const dist = Math.abs(center - pageY);
		if (dist < bestDist) {
			bestDist = dist;
			best = i;
		}
	}
	return best;
}

// Atome d'édition = 1 ligne : un paragraphe fusionné (montants de facture,
// cellules empilées…) est découpé en blocs monolignes au moment d'éditer.
// `_lineLocked` empêche la ré-analyse de les refusionner.
function explodeMultilineBlockForEdit(block, lineIndex) {
	const lines = pdfCharLines(block);
	if (lines.length <= 1) return block;
	const at = state.editBlocks.indexOf(block);
	if (at < 0) return block;
	const pieces = lines.map((line, index) => {
		const chars = line.chars.map((ch, charIndex) => ({ ...ch, index: charIndex }));
		const text = chars.map((ch) => ch.text || '').join('');
		const left = Math.min(...chars.map((ch) => ch.x));
		const top = Math.min(...chars.map((ch) => ch.y));
		const right = Math.max(...chars.map((ch) => ch.x + ch.width));
		const bottom = Math.max(...chars.map((ch) => ch.y + ch.height));
		const width = Math.max(1, right - left);
		const height = Math.max(1, bottom - top);
		const piece = {
			...block,
			id: index === 0 ? block.id : `${block.id}__L${index}`,
			text,
			originalText: text,
			pdfChars: chars,
			x: left,
			y: top,
			width,
			height,
			originalX: left,
			originalY: top,
			originalWidth: width,
			originalHeight: height,
			multiline: false,
			_lineLocked: true,
			_splitFrom: block.id
		};
		// Session native / montage du paragraphe parent : ne pas hériter.
		delete piece._nativeBusy;
		delete piece._nativeQueued;
		delete piece._nativeStale;
		delete piece._nativePristine;
		delete piece._mounted;
		delete piece._mountSig;
		return piece;
	});
	state.editBlocks.splice(at, 1, ...pieces);
	const targetIndex = Math.max(0, Math.min(lineIndex, pieces.length - 1));
	return pieces[targetIndex];
}

// Chemin HISTORIQUE (bascule en édition HTML avec police métrique-compatible) :
// utilisé quand l'édition native est impossible (multiligne, bloc déplacé,
// glyphes non mappés, formatage partiel, échec moteur…).
function applyGlyphEditHtml(block, newText, caretOffset) {
	block.text = newText;
	block.textEdited = true;
	block.inlineEditDirty = true;
	block.hiddenCharIndexes = [];
	block.localGlyphEdited = false;
	block.glyphTrimOnly = false;
	block.localCaretIndex = null;
	block.snapshotDataUrl = null;
	if (newText.includes('\n')) block.multiline = true;
	state.selectedBlockId = block.id;
	elements.editText.value = block.text;
	elements.editTextPanel.value = block.text;
	markDirty();
	renderEditBlocks();
	requestAnimationFrame(() => {
		const next = elements.pagesStack.querySelector(`.edit-block.editing[data-block-id="${block.id}"]`);
		if (!next) return;
		next.focus({ preventScroll: true });
		placeCaretAtTextOffset(next, Math.max(0, Math.min(caretOffset, block.text.length)));
	});
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

function replaceEditedTextRange(element, block, insertText) {
	const range = selectionTextRange(element);
	const caret = range ? range.start : caretTextOffset(element);
	if (caret == null) return false;
	const current = (element.textContent || block.text || '').replace(/\r\n?/g, '\n');
	const from = range ? range.start : caret;
	const to = range ? range.end : caret;
	const inserted = insertText || '';
	commitGlyphEdit(block, current.slice(0, from) + inserted + current.slice(to), from + inserted.length);
	return true;
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
	pushHistory('histTextEdit');
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
	pushHistory('histTextEdit');
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
	pushHistory('histTextEdit');
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

// pdfCharLines, pdfLinesText, pdfCaretTextOffset : voir ./block-state.js.

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
	pushHistory('histTextEdit');
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

function selectAllEditableText(element) {
	const selection = window.getSelection();
	if (!selection) return;
	const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
	let first = null;
	let last = null;
	let node = walker.nextNode();
	while (node) {
		if (node.textContent.length) {
			if (!first) first = node;
			last = node;
		}
		node = walker.nextNode();
	}
	const range = document.createRange();
	if (first && last) {
		range.setStart(first, 0);
		range.setEnd(last, last.textContent.length);
	} else {
		range.selectNodeContents(element);
	}
	selection.removeAllRanges();
	selection.addRange(range);
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

// Taille de police en points PDF (indépendante du zoom). `pdfFontSize` est en
// px CSS (× zoom × CSS_UNITS) : un corps 14 pt passait le seuil logo dès ~150 %.
function pdfFontSizeInPoints(block) {
	const px = Number(block?.pdfFontSize) || 0;
	if (px <= 0) return 0;
	const scale = Math.max(0.01, state.zoom * CSS_UNITS);
	return px / scale;
}

// Un "logo" = gros bloc d'affichage dont la police décorative n'est NI installée
// NI chargeable (ex. "Scott"). L'éditer en HTML retomberait sur une police
// générique => le glyphe change d'aspect (carré blanc / texte différent). On le
// laisse donc déplaçable mais NON éditable.
// Exception : texte natif PDFium (glyphes mappés) → toujours éditable via la
// police embarquée, même si la WebView ne « voit » pas la famille système.
const TEXT_FONT_HINT =
	/helvetica|arial|times|courier|calibri|cambria|georgia|verdana|tahoma|trebuchet|garamond|palatino|avenir|futura|roboto|lato|montserrat|poppins|inter|nunito|ubuntu|noto|segoe|liberation|dejavu|tinos|cousine|open sans|opensans|source sans|sf pro|menlo|consolas|gill|myriad|minion|frutiger|univers|gotham|proxima|aktiv|circular|graphik|din\b/;

function isLikelyTextFont(fontName) {
	if (metricCompatibleFamily(fontName)) return true;
	return TEXT_FONT_HINT.test(String(fontName || '').toLowerCase());
}

function isLogoBlock(block) {
	if (!block || block.kind === 'image') return false;
	// Classification DÉFINITIVE par bloc : une webfont Google Fonts chargée en
	// différé (ensureCloudFont au moment de la sélection) rendait isFontInstalled
	// positif après coup → le logo déplacé basculait du bitmap exact vers du texte
	// HTML dans la police de substitution (changement d'aspect visible).
	if (block._isLogo !== undefined) return block._isLogo;
	// Édition native possible → ce n'est pas un logo (bandeau facture Lato, etc.).
	if (nativeTextEditEligible(block) || isAddedTextBlock(block) || isLikelyTextFont(block.fontName)) {
		block._isLogo = false;
		return false;
	}
	// Un logo = marque COURTE, gros corps, police décorative absente.
	// Un titre / paragraphe ≥ 22 pt n'en est pas un (sinon chaque heading
	// Calibri/Montserrat non installé devenait un bitmap inéditable).
	const text = String(block.text || '').trim();
	const words = text.split(/\s+/).filter(Boolean);
	const shortMark = text.length > 0 && text.length <= 18 && words.length <= 2;
	let result = false;
	if (shortMark && pdfFontSizeInPoints(block) >= 28) {
		const base = baseFamilyName(cleanFontName(block.fontName));
		if (base) result = !isFontInstalled(base);
	}
	block._isLogo = result;
	return result;
}

function startInlineEdit(id, opts = {}) {
	let block = state.editBlocks.find((candidate) => candidate.id === id);
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
	// Paragraphe fusionné → une ligne sous le clic (montants / tableaux).
	if (
		nativeTextEditEligible(block) &&
		!block._lineLocked &&
		((block.text || '').includes('\n') || block.multiline)
	) {
		const visualLines = pdfCharLines(block);
		if (visualLines.length > 1) {
			const lineIndex = Number.isFinite(opts.caretY)
				? lineIndexFromClientPoint(block, opts.caretX, opts.caretY)
				: 0;
			block = explodeMultilineBlockForEdit(block, lineIndex);
			id = block.id;
		}
	}
	block.inlineEditDirty = false;
	if (Array.isArray(block.pdfChars) && block.pdfChars.length && !Number.isFinite(block.localCaretIndex)) {
		block.localCaretIndex = block.pdfChars[block.pdfChars.length - 1].index + 1;
	}
	refreshBlockFontInfo(block);
	preloadBlockEditFont(block);
	// Bloc éligible au natif : bascule le canvas sur le rendu PDFium dès
	// MAINTENANT (avant la première frappe), pour que les bandes re-rendues à
	// chaque frappe soient issues du même rasteriseur que la page affichée.
	if (nativeTextEditEligible(block)) void primeNativePageCanvas(block.page);
	state.editingBlockId = id;
	state.selectedBlockId = id;
	renderEditBlocks();
	requestAnimationFrame(() => {
		const element = elements.pagesStack.querySelector(`.edit-block.editing[data-block-id="${id}"]`);
		if (!element) return;
		// Le letter-spacing ne sert QUE pour un bloc vierge (caler le texte invisible
		// sur le PDF dessous). Pour un bloc déjà édité, on ré-applique l'espacement
		// capturé à l'état vierge (0 si formatage modifié depuis) : le même que
		// celui du rendu au repos → aucune compression à l'entrée en édition.
		const pristine = !isBlockTextEdited(block);
		if (pristine && !block.multiline) {
			fitEditTextWidth(element, block);
		} else {
			element.style.letterSpacing = `${
				!block.multiline && Number.isFinite(block.editLetterSpacing) ? block.editLetterSpacing : 0
			}px`;
		}
		resizeEditingElementToContent(element, block);
		if (isAddedTextBlock(block)) {
			element.classList.remove('added-empty');
			const inkColor = block.color || '#111111';
			element.style.color = inkColor;
			element.style.webkitTextFillColor = inkColor;
			element.style.caretColor = inkColor;
			if (!Number.isFinite(block._addedEditFocusGuard) || block._addedEditFocusGuard < Date.now()) {
				block._addedEditFocusGuard = Date.now() + 400;
			}
		}
		element.focus({ preventScroll: true });
		// Caret SOUS le clic (double-clic) : plus intuitif et sans dépendance fragile
		// à block.text.length. Comme le node n'est plus reconstruit à l'entrée en
		// édition (fast path), il n'y a plus de course rAF avec la sélection native.
		// Bloc vierge : la frontière visée est calculée sur les boîtes de glyphes
		// NATIFS (là où l'utilisateur voit les lettres), pas sur la géométrie HTML.
		const nativeClickOffset = Number.isFinite(opts.caretX)
			? nativeTextOffsetFromClientPoint(block, element.textContent || '', opts.caretX, opts.caretY)
			: null;
		if (nativeClickOffset != null) {
			placeCaretAtTextOffset(element, nativeClickOffset);
		} else if (Number.isFinite(opts.caretX) && placeCaretAtPoint(element, opts.caretX, opts.caretY)) {
			// caret placé sous le curseur
		} else if (block.htmlEdited) {
			placeCaretAtEnd(element);
		} else {
			placeCaretAtTextOffset(element, block.text.length);
		}
		scheduleNativeCaretUpdate();
	});
}

function finishInlineEdit(id, newText) {
	if (state.editingBlockId !== id) return;
	const element = elements.pagesStack.querySelector(`.edit-block.editing[data-block-id="${id}"]`);
	state.editingBlockId = null;
	removeNativeCaretBar();
	element?.classList.remove('native-caret-active');
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
		if (block.added && !trimmed) {
			// Champ vide conservé : hitbox mini + fantôme « Aa » pour pouvoir
			// le resélectionner / déplacer (sinon zone cliquable nulle).
			block.text = '';
			block.originalText = '';
			block.emptyPlaceholder = true;
			block.textEdited = true;
			ensureAddedPlaceholderGeometry(block);
			if (block._addSnapshot) {
				commitSnapshot(block._addSnapshot, 'histBlockAdd');
				delete block._addSnapshot;
				markDirty();
			}
			renderEditBlocks();
			updateSelectedEditField();
			return;
		}
		if (block.added) block.emptyPlaceholder = false;
		const textChanged = typed && trimmed && trimmed !== block.text;
		// On ne touche JAMAIS la géométrie du bloc si le texte n'a pas changé,
		// sinon le padding d'édition ferait grossir le bloc à chaque entrée/sortie.
		if (textChanged) {
			block.text = block.listType ? renumberList(trimmed, block.listType) : trimmed;
			block.textEdited = true;
			block.snapshotDataUrl = null;
			elements.editText.value = block.text;
			elements.editTextPanel.value = block.text;
			if (element) {
				const nextHeight =
					isAddedTextBlock(block) && !block.boxResized
						? Math.max(14, addedTextContentHeight(block, element, trimmed))
						: Math.max(14, Math.ceil(element.scrollHeight) - EDIT_BLOCK_PAD_Y * 2);
				if (!block.multiline) {
					const nextWidth = Math.max(40, Math.ceil(element.scrollWidth) - EDIT_BLOCK_PAD_X * 2);
					block.width = Math.min(block.pageWidth - block.x, nextWidth);
				}
				block.height = Math.min(block.pageHeight - block.y, nextHeight);
				if (isAddedTextBlock(block)) block.originalHeight = block.height;
			}
			commitSnapshot(
				block.added && block._addSnapshot ? block._addSnapshot : editSnapshot,
				block.added ? 'histBlockAdd' : 'histTextEdit'
			);
			delete block._addSnapshot;
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
			const nextHeight =
				isAddedTextBlock(block) && !block.boxResized
					? Math.max(14, addedTextContentHeight(block, element, block.text))
					: Math.max(14, Math.ceil(element.scrollHeight) - EDIT_BLOCK_PAD_Y * 2);
			if (!block.multiline) {
				const nextWidth = Math.max(40, Math.ceil(element.scrollWidth) - EDIT_BLOCK_PAD_X * 2);
				block.width = Math.min(block.pageWidth - block.x, nextWidth);
			}
			block.height = Math.min(block.pageHeight - block.y, nextHeight);
			if (isAddedTextBlock(block)) block.originalHeight = block.height;
			markDirty();
		}
	}
	// Le node contentEditable affiche DÉJÀ le texte tapé. Reconstruire le bloc
	// (slow path) au commit re-rasterisait les glyphes (le flou « comme au début »)
	// et recalculait left/top (le snap de 1px). Comme seul le texte a changé et
	// que le node monté le porte déjà, on réaligne sa signature de montage : le
	// rendu suivant emprunte le FAST PATH et réutilise ce même node, sans le
	// réécrire, re-styler ni ré-attacher. (Premier passage en édition : _mounted
	// est encore false → slow path normal qui crée puis monte le node.)
	if (block && block._mounted) {
		block._mountSig = editedBlockSignature(block);
	}
	renderEditBlocks();
	updateSelectedEditField();
	// Fin de session de frappe : si des éditions NATIVES ont eu lieu, on
	// synchronise les octets JS + PDF.js avec le document édité côté Rust
	// (zoom, export et sauvegarde verront alors le texte à jour, vectoriel).
	if (state.nativeTextDirty) void syncNativeDocumentBytes({ render: false });
}

function selectEditBlock(id) {
	if (state.selectedSignatureId) {
		state.selectedSignatureId = null;
		renderAllSignaturePlacements();
		updateSelectedEditField();
	}
	// Rendu CIBLÉ : seules les pages dont le chrome de sélection change (ancienne
	// sélection + nouvelle) ont besoin d'un re-render. Re-rendre toutes les pages
	// à chaque clic rendait la sélection lente sur les gros documents.
	const affectedIds = new Set(state.selectedBlockIds || []);
	if (state.selectedBlockId) affectedIds.add(state.selectedBlockId);
	if (id) affectedIds.add(id);
	state.selectedBlockId = id;
	state.selectedBlockIds = id ? [id] : [];
	const block = state.editBlocks.find((candidate) => candidate.id === id);
	if (block) {
		refreshBlockFontInfo(block);
		preloadBlockEditFont(block);
	}
	const affectedPages = new Set(
		state.editBlocks.filter((b) => affectedIds.has(b.id)).map((b) => b.page)
	);
	for (const page of affectedPages) renderEditBlocksForPage(page);
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
	updateSignatureControls();
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
		...elements.formatAlignButtons,
		...elements.formatListButtons
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
	for (const button of elements.formatListButtons) {
		button.classList.toggle('active', button.dataset.list === block.listType);
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
	pushHistory('histFormat');
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

// ── Listes (puces / numérotées) ─────────────────────────────────────────
const LIST_MARKER_RE = /^(\u2022\s|\d+[.)]\s)/;

// Retire le marqueur de liste (• ou « N. ») en début de chaque ligne.
function stripListMarkers(text) {
	return (text || '')
		.split('\n')
		.map((line) => line.replace(LIST_MARKER_RE, ''))
		.join('\n');
}

// Renumérote UNIQUEMENT les lignes déjà numérotées (1., 2., …) pour rester
// correct même quand seules certaines lignes du bloc sont en liste. Les puces
// n'ont pas besoin de renumérotation.
function renumberList(text, type) {
	if (type !== 'number') return text;
	let n = 0;
	return (text || '')
		.split('\n')
		.map((line) => {
			if (!/^\d+[.)]\s/.test(line)) return line;
			n += 1;
			return line.replace(/^\d+[.)]\s/, `${n}. `);
		})
		.join('\n');
}

// Lit le texte LIVE de l'élément en cours d'édition et le recopie dans block.text
// (sinon une modif non encore "commitée" — ex. texte effacé — serait ignorée et
// ressusciterait au moment d'appliquer une liste). Renvoie l'élément éditable.
function syncEditingTextToBlock(block) {
	if (state.editingBlockId !== block.id) return null;
	const element = elements.pagesStack.querySelector(
		`.edit-block.editing[data-block-id="${block.id}"]`
	);
	if (element) {
		block.text = (element.innerText || '').replace(/\r\n?/g, '\n');
	}
	return element;
}

// Bascule un type de liste sur les LIGNES SÉLECTIONNÉES du bloc (ou tout le bloc
// si aucune sélection). Toggle : si toutes les lignes ciblées portent déjà ce
// type, on retire les marqueurs.
function applyListType(type) {
	const block = selectedEditBlock();
	if (!block || block.kind === 'image') return;

	// 1) Synchronise le texte live AVANT toute mutation (anti-résurrection).
	const element = syncEditingTextToBlock(block);
	// 2) Plage de lignes ciblée : sélection courante, sinon tout le bloc.
	const range = element ? selectionTextRange(element) : null;

	pushHistory('histFormat');
	const text = block.text || '';
	const lines = text.split('\n');
	let firstLine = 0;
	let lastLine = lines.length - 1;
	if (range) {
		firstLine = text.slice(0, range.start).split('\n').length - 1;
		lastLine = text.slice(0, range.end).split('\n').length - 1;
	}

	const markerRe = type === 'bullet' ? /^\u2022\s/ : /^\d+[.)]\s/;
	const targeted = [];
	for (let i = firstLine; i <= lastLine; i++) targeted.push(i);
	const nonEmpty = targeted.filter((i) => lines[i].trim() !== '');
	const allMarked = nonEmpty.length > 0 && nonEmpty.every((i) => markerRe.test(lines[i]));

	let counter = 0;
	for (const i of targeted) {
		const stripped = lines[i].replace(LIST_MARKER_RE, '');
		if (stripped.trim() === '') {
			lines[i] = stripped;
			continue;
		}
		if (allMarked) {
			lines[i] = stripped;
		} else if (type === 'bullet') {
			lines[i] = `\u2022 ${stripped}`;
		} else {
			counter += 1;
			lines[i] = `${counter}. ${stripped}`;
		}
	}

	block.text = lines.join('\n');
	block.listType = allMarked ? null : type;
	if (!allMarked) block.multiline = true;
	block.textEdited = true;
	block.html = null;
	block.htmlEdited = false;
	block.snapshotDataUrl = null;
	markDirty();
	renderEditBlocks();
	updateSelectedEditField();

	// Si on éditait, on rétablit le focus pour rester en saisie.
	if (state.editingBlockId === block.id) {
		requestAnimationFrame(() => {
			const next = elements.pagesStack.querySelector(
				`.edit-block.editing[data-block-id="${block.id}"]`
			);
			if (next) {
				next.focus();
				placeCaretAtEnd(next);
			}
		});
	}
}

// Calcule la transformation du texte quand on presse Entrée dans une liste :
// continuation (marqueur suivant) ou sortie de liste si la ligne courante est un
// marqueur vide. Renvoie { newText, newCaret }.
function listEnter(text, caret, type) {
	const before = text.slice(0, caret);
	const after = text.slice(caret);
	const lineStart = before.lastIndexOf('\n') + 1;
	const currentLine = before.slice(lineStart);
	const content = currentLine.replace(LIST_MARKER_RE, '');
	// Ligne « marqueur seul » → on sort de la liste : ligne vide, pas de nouveau marqueur.
	if (LIST_MARKER_RE.test(currentLine) && content.trim() === '') {
		const newText = before.slice(0, lineStart) + after;
		return { newText, newCaret: lineStart };
	}
	let marker;
	if (type === 'bullet') {
		marker = '\u2022 ';
	} else {
		// Numéro = nombre de lignes-liste avant (incluse la courante) + 1.
		const linesBefore = before.split('\n');
		const count = linesBefore.filter((l) => LIST_MARKER_RE.test(l)).length;
		marker = `${count + 1}. `;
	}
	const newText = `${before}\n${marker}${after}`;
	return { newText, newCaret: (before + '\n' + marker).length };
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

	pushHistory('histFormat');
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
	block.editLetterSpacing = 0;
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
	pushHistory('histTextEdit');
	block.text = block.listType ? renumberList(nextText, block.listType) : nextText;
	block.textEdited = true;
	block.snapshotDataUrl = null;
	elements.editText.value = block.text;
	elements.editTextPanel.value = block.text;
	markDirty();
	renderEditBlocks();
}

// ─── Modèle d'opérations d'édition ──────────────────────────────────────────
// Point d'entrée unique pour muter les blocs : centralise ce qui était dispersé
// dans le drag, le resize et le nudge. Les opérations « autonomes »
// (duplicate/hide) poussent UN snapshot d'annulation propre. Le déplacement
// (moveBlocks) ne commit pas : l'appelant gère l'historique (drag = 1 commit en
// fin de geste, nudge = commit débauncé).
// Convention de coordonnées : x/y/width/height des blocs sont en pixels de la
// viewport rendue (déjà au zoom courant) = mêmes pixels que l'écran. Aucun
// facteur d'échelle n'est appliqué aux deltas de pointeur.

function editBlocksByIds(ids) {
	const set = ids instanceof Set ? ids : new Set(ids || []);
	return state.editBlocks.filter((block) => set.has(block.id));
}

// Pendant un drag, on NE reconstruit PAS l'editLayer (innerHTML='') à chaque pixel :
// ça forçait WebKit à re-rasteriser le texte HTML à chaque frame → micro-flou sur
// les blocs modifiés. On translate directement les .edit-block existants via
// `transform` (entier) : le raster du texte est préservé, juste déplacé sur la
// couche GPU → net. Les poignées/badge (sans data-block-id fiable) sont masqués
// pendant le drag ; ils reviennent au render final au pointerup.
function translateDraggedBlocks(page, blocks) {
	const data = getPageData(page);
	if (!data) return;
	const layer = data.editLayer;
	if (!layer) return;
	// Bloc COMPOSITE déplacé : l'ancrage natif ne suit pas le déplacement. On
	// force la bascule en rendu HTML classique (texte opaque + masques complets)
	// AVANT de translater, sinon on traînerait un bloc invisible en laissant les
	// artefacts composite derrière. Le flag est transitoire (retiré des snapshots).
	let compositeSwitched = false;
	for (const b of blocks) {
		if (!b._dragForceHtml && isGlyphCompositeBlock(b)) {
			b._dragForceHtml = true;
			delete b._mounted;
			delete b._mountSig;
			compositeSwitched = true;
		}
	}
	// 1er déplacement d'un bloc texte « vivant » pas encore monté : on le rend en
	// HTML + on le monte AVANT de translater, pour que le texte suive le cadre dès
	// le 1er pixel (plus de cadre qui bouge seul, plus de capture bitmap).
	if (compositeSwitched || blocks.some((b) => isLiveTextBlock(b) && !b._mounted)) {
		renderEditBlocksForPage(page);
	}
	const byId = new Map(blocks.map((b) => [b.id, b]));
	for (const el of layer.children) {
		if (el.classList.contains('edit-block')) {
			const id = el.getAttribute('data-block-id');
			const b = id ? byId.get(id) : null;
			if (!b) continue;
			const tdx = Math.round(b.x - (b._dragOriginX ?? b.x));
			const tdy = Math.round(b.y - (b._dragOriginY ?? b.y));
			// POINT 1 : le texte modifié bouge EXCLUSIVEMENT par transform composité
			// (jamais left/top, qui déclenche layout + repaint = re-rasterisation des
			// glyphes). Pour un bloc monté, la formule est mount-relative (identique au
			// repos et au commit => aucun snap). Sinon, fallback drag-relative.
			if (isLiveTextBlock(b)) {
				el.style.transform = b._mounted
					? editedBlockTransform(b)
					: tdx || tdy
						? `translate3d(${tdx}px, ${tdy}px, 0)`
						: 'translateZ(0)';
				continue;
			}
			el.style.transform = tdx || tdy ? `translate3d(${tdx}px, ${tdy}px, 0)` : 'none';
			continue;
		}
		// Poignées + badges + artefacts composite : masqués pendant le drag/nudge
		// (recréés au render final, à la bonne position).
		if (
			el.classList.contains('block-resize-handle') ||
			el.classList.contains('text-resize-zone') ||
			el.classList.contains('edit-block-badge') ||
			el.classList.contains('edit-block-text-handle') ||
			el.classList.contains('glyph-composite-artifact') ||
			el.classList.contains('font-warning-badge')
		) {
			el.style.display = 'none';
		}
	}
}

// Déplace un ensemble de blocs d'un delta incrémental, clampé par bloc dans sa
// page. Retourne true si au moins un bloc a bougé. NE commit PAS.
// opts.visualOnly : translate DOM sans reconstruire le layer (flèches / drag).
function moveBlocks(ids, dx, dy, opts = {}) {
	const blocks = editBlocksByIds(ids).filter((block) => !block.hidden);
	if (!blocks.length) return false;
	let moved = false;
	const pages = new Set();
	for (const block of blocks) {
		const nextX = Math.max(0, Math.min(block.pageWidth - block.width, block.x + dx));
		const nextY = Math.max(0, Math.min(block.pageHeight - block.height, block.y + dy));
		if (nextX !== block.x || nextY !== block.y) moved = true;
		block.x = nextX;
		block.y = nextY;
		pages.add(block.page);
	}
	if (moved) {
		if (opts.visualOnly) {
			for (const page of pages) {
				const pageBlocks = blocks.filter((b) => b.page === page);
				if (pageBlocks.length) translateDraggedBlocks(page, pageBlocks);
			}
		} else {
			for (const page of pages) renderEditBlocksForPage(page);
		}
	}
	return moved;
}

// Duplique des blocs (nouvel id + léger décalage), sélectionne les copies et
// pousse un snapshot. Retourne les copies dans l'ordre des ids fournis.
function duplicateBlocks(ids) {
	const blocks = editBlocksByIds(ids);
	if (!blocks.length) return [];
	const snap = captureEditableSnapshot();
	const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
	const offset = 12;
	const copies = blocks.map((block, i) => {
		// Copie SANS l'état de montage/drag de l'original : sinon la copie hérite
		// de _mountX/_mountLeft d'un node qui n'est pas le sien et son transform
		// la place au mauvais endroit dès le premier rendu.
		const copy = stripTransientBlockFields(block);
		copy.id = `${block.id}-copy-${stamp}-${i}`;
		// Marque les copies comme contenu ajouté : l'export hybride doit toujours
		// aplatir une page qui en contient (sinon une copie non déplacée, donc non
		// « dirty », serait perdue en conservant la page native).
		copy.added = true;
		copy.x = Math.max(0, Math.min(block.pageWidth - block.width, block.x + offset));
		copy.y = Math.max(0, Math.min(block.pageHeight - block.height, block.y + offset));
		copy.originalX = copy.x;
		copy.originalY = copy.y;
		// Clone profond des glyphes pour ne pas partager le tableau avec l'original.
		if (Array.isArray(block.pdfChars)) copy.pdfChars = block.pdfChars.map((ch) => ({ ...ch }));
		return copy;
	});
	state.editBlocks.push(...copies);
	state.selectedBlockIds = copies.map((c) => c.id);
	state.selectedBlockId = copies[0].id;
	renderEditBlocks();
	updateSelectedEditField();
	commitSnapshot(snap, 'histDuplicate');
	markDirty();
	return copies;
}

// Masque (supprime visuellement) des blocs et pousse un snapshot.
function hideBlocks(ids) {
	const blocks = editBlocksByIds(ids);
	if (!blocks.length) return false;
	const snap = captureEditableSnapshot();
	for (const block of blocks) block.hidden = true;
	clearBlockSelection();
	renderEditBlocks();
	updateSelectedEditField();
	commitSnapshot(snap, 'histBlockDelete');
	markDirty();
	return true;
}

function hideSelectedBlock() {
	// Réunit le primaire + la sélection multiple (sans doublon).
	const ids = new Set(state.selectedBlockIds || []);
	if (state.selectedBlockId) ids.add(state.selectedBlockId);
	if (!ids.size) return;
	hideBlocks(ids);
}

function startBlockDrag(event, id) {
	if (state.editingBlockId === id) return;
	let block = state.editBlocks.find((candidate) => candidate.id === id);
	if (!block) return;
	// Hors Modifier : pas de déplacement, mais pointerup = sélection / édition
	// (le `click` peut ne jamais arriver si un re-render a lieu entre-temps).
	if (!state.editMode) {
		if (block.kind === 'image' || isLogoBlock(block)) return;
		const downX = event.clientX;
		const downY = event.clientY;
		const onIdleUp = (upEvent) => {
			window.removeEventListener('pointerup', onIdleUp);
			if (
				Math.abs(upEvent.clientX - downX) < 8 &&
				Math.abs(upEvent.clientY - downY) < 8
			) {
				suppressNextIdleClick();
				activateIdleBlock(block, upEvent);
			}
		};
		window.addEventListener('pointerup', onIdleUp);
		return;
	}

	// Alt+drag : on duplique d'abord (toute la sélection si le bloc en fait
	// partie, sinon ce seul bloc), puis on drague les copies fraîchement créées.
	if (event.altKey) {
		const baseIds =
			isBlockSelected(block) && (state.selectedBlockIds?.length || 0)
				? state.selectedBlockIds.slice()
				: [id];
		const copies = duplicateBlocks(baseIds);
		if (!copies.length) return;
		const idx = baseIds.indexOf(id);
		block = copies[idx >= 0 ? idx : 0];
		id = block.id;
	}

	// Déplacement de groupe : si le bloc saisi appartient à une sélection
	// multiple, on déplace TOUTE la sélection ensemble (et on ne la réduit pas).
	const inSelection = isBlockSelected(block) && (state.selectedBlockIds?.length || 0) > 1;
	const groupInit = inSelection
		? state.editBlocks
				.filter((b) => state.selectedBlockIds.includes(b.id) && b.id !== id && !b.hidden)
				.map((b) => ({ block: b, x: b.x, y: b.y }))
		: [];

	const startX = event.clientX;
	const startY = event.clientY;
	const initialX = block.x;
	const initialY = block.y;
	// Origine figée pour la translation visuelle (le delta de transform = position
	// courante − origine). On la pose sur le primaire ET sur chaque bloc du groupe.
	block._dragOriginX = initialX;
	block._dragOriginY = initialY;
	for (const g of groupInit) {
		g.block._dragOriginX = g.x;
		g.block._dragOriginY = g.y;
	}
	const dragSnapshot = captureEditableSnapshot();
	let dragging = false;
	let moved = false;

	const onMove = (moveEvent) => {
		let dx = moveEvent.clientX - startX;
		let dy = moveEvent.clientY - startY;
		if (!dragging) {
			// 8 px : un tremblement de trackpad (3 px) ne doit plus convertir
			// le clic en drag + re-render (qui tue l'événement click).
			if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
			dragging = true;
			// On ne (re)sélectionne en solo que si le bloc saisi est HORS sélection.
			if (!inSelection) selectEditBlock(id);
		}
		// Verrou d'axe : Shift maintenu pendant le drag fige l'axe dominant.
		if (moveEvent.shiftKey) {
			if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
			else dx = 0;
		}
		const nextX = Math.max(0, Math.min(block.pageWidth - block.width, initialX + dx));
		const nextY = Math.max(0, Math.min(block.pageHeight - block.height, initialY + dy));
		// Guides/snap uniquement en déplacement solo (en multi, le snap sur les
		// autres blocs sélectionnés — qui bougent aussi — provoquerait du jitter).
		const result =
			state.settings.showAlignmentGuides && !inSelection
				? computeAlignmentGuides(block, nextX, nextY)
				: { x: nextX, y: nextY, guides: [] };
		block.x = result.x;
		block.y = result.y;
		// Delta réellement appliqué au primaire (après clamp + snap), répliqué au
		// reste de la sélection avec clamp par bloc.
		const appliedDx = block.x - initialX;
		const appliedDy = block.y - initialY;
		const pages = new Set([block.page]);
		for (const g of groupInit) {
			const gb = g.block;
			gb.x = Math.max(0, Math.min(gb.pageWidth - gb.width, g.x + appliedDx));
			gb.y = Math.max(0, Math.min(gb.pageHeight - gb.height, g.y + appliedDy));
			pages.add(gb.page);
		}
		moved = true;
		// Pendant le drag : on NE reconstruit PAS le layer (sinon re-rasterisation
		// du texte HTML à chaque pixel = micro-flou). On translate les .edit-block
		// existants via transform (entier). Le render final propre se fait au onUp.
		for (const page of pages) {
			const pageBlocks = [block, ...groupInit.map((g) => g.block)].filter((b) => b.page === page);
			translateDraggedBlocks(page, pageBlocks);
		}
		renderAlignmentGuides(result.guides, block.page);
	};
	const onUp = (upEvent) => {
		window.removeEventListener('pointermove', onMove);
		window.removeEventListener('pointerup', onUp);
		clearAlignmentGuides();
		// Nettoyage des marqueurs d'origine + render final (poignées/badge reconstruits).
		delete block._dragOriginX;
		delete block._dragOriginY;
		delete block._dragVisualLeft;
		delete block._dragVisualTop;
		for (const g of groupInit) {
			delete g.block._dragOriginX;
			delete g.block._dragOriginY;
			delete g.block._dragVisualLeft;
			delete g.block._dragVisualTop;
		}
		const groupMoved = groupInit.some((g) => g.block.x !== g.x || g.block.y !== g.y);
		// IMPORTANT : on ne re-render QUE si le drag a réellement déplacé un bloc.
		// Sur un simple clic (pas de mouvement), on ne touche à rien : sinon la
		// reconstruction du DOM (innerHTML='') détruit l'élément avant que son
		// handler 'click' ne reçoive l'événement → l'édition n'est plus détectée.
		if (moved) {
			const pages = new Set([block.page, ...groupInit.map((g) => g.block.page)]);
			for (const page of pages) renderEditBlocksForPage(page);
		}
		if (dragging && moved && (block.x !== initialX || block.y !== initialY || groupMoved)) {
			commitSnapshot(dragSnapshot, 'histBlockMove');
			markDirty();
			suppressNextIdleClick();
			return;
		}
		// Clic sans déplacement : sélection (1 clic) ou édition (2 clics).
		// On n'attend pas `click` (souvent mort après un re-render, ou jamais
		// émis après preventDefault d'une zone de resize).
		suppressNextIdleClick();
		activateIdleBlock(block, upEvent);
	};

	window.addEventListener('pointermove', onMove);
	window.addEventListener('pointerup', onUp);
}

// Un bloc est redimensionnable s'il s'agit d'une image, ou d'un logo (texte dont la
// police n'est pas installée → non éditable, manipulé comme un visuel).
function isResizableBlock(block) {
	if (!block) return false;
	const stateName = blockState(block);
	return stateName === BlockState.IMAGE || stateName === BlockState.LOGO;
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
		renderEditBlocksForPageOnFrame(block.page);
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
			commitSnapshot(resizeSnapshot, 'histBlockResize');
			markDirty();
		}
	};

	window.addEventListener('pointermove', onMove);
	window.addEventListener('pointerup', onUp);
}

// Fait tourner un point (px,py) de `deg` degrés autour de (cx,cy).
function rotatePoint(px, py, cx, cy, deg) {
	if (!deg) return { x: px, y: py };
	const r = (deg * Math.PI) / 180;
	const dx = px - cx;
	const dy = py - cy;
	return {
		x: cx + dx * Math.cos(r) - dy * Math.sin(r),
		y: cy + dx * Math.sin(r) + dy * Math.cos(r)
	};
}

// Taille de police effective d'un bloc texte (override > base > police PDF > déduite).
function effectiveFontSize(block) {
	return (
		block.fontSizeOverride ||
		block.baseFontSize ||
		(block.pdfFontSize > 0
			? block.pdfFontSize
			: Math.max(8, Math.min(48, Math.round((block.originalHeight || block.height || 14) * 0.78))))
	);
}

// Poignées d'un bloc TEXTE sélectionné : redimensionnement uniquement.
// La rotation se pilote depuis le panneau gauche pour ne pas polluer la page.
// Zones de redimensionnement INVISIBLES pour les blocs texte : pas de carrés
// blancs qui masquent le texte (illisible sur les petits blocs type « 1,000 »).
// On survole un bord ou un angle → le curseur change (↕ / ↔ / diagonales) et on
// tire directement. Bandes fines centrées sur chaque arête (moitié dedans,
// moitié dehors) + carrés d'angle un peu plus grands, prioritaires (z-index).
function appendTextHandles(editLayer, block, visualBox = null) {
	const left = visualBox?.x ?? block.x;
	const top = visualBox?.y ?? block.y;
	const w = Math.max(visualBox?.width ?? block.width, 8);
	const h = Math.max(visualBox?.height ?? block.height, 8);
	const cx = left + w / 2;
	const cy = top + h / 2;
	const rot = block.rotation || 0;
	const EDGE_THICKNESS = 8;
	const CORNER_SIZE = 13;

	for (const dir of RESIZE_HANDLE_DIRS) {
		let hx = left + w / 2;
		if (dir.includes('e')) hx = left + w;
		else if (dir.includes('w')) hx = left;
		let hy = top + h / 2;
		if (dir.includes('s')) hy = top + h;
		else if (dir.includes('n')) hy = top;
		const corner = dir.length === 2;
		// Hitbox HORS du cadre (évite ↕ sur les lettres). Carrés d'angle :
		// entièrement à l'extérieur, collés au coin (CSS ::after).
		const hitboxOffset = corner ? CORNER_SIZE / 2 : EDGE_THICKNESS / 2;
		if (dir.includes('e')) hx += hitboxOffset;
		else if (dir.includes('w')) hx -= hitboxOffset;
		if (dir.includes('s')) hy += hitboxOffset;
		else if (dir.includes('n')) hy -= hitboxOffset;
		const p = rotatePoint(hx, hy, cx, cy, rot);
		const zone = document.createElement('div');
		zone.className = `text-resize-zone zone-${dir}`;
		// Arêtes horizontales/verticales : la bande couvre TOUT le côté (moins les
		// angles) pour pouvoir attraper le bord n'importe où, pas juste au milieu.
		const zoneWidth = corner
			? CORNER_SIZE
			: dir === 'n' || dir === 's'
				? Math.max(w - CORNER_SIZE, 8)
				: EDGE_THICKNESS;
		const zoneHeight = corner
			? CORNER_SIZE
			: dir === 'e' || dir === 'w'
				? Math.max(h - CORNER_SIZE, 8)
				: EDGE_THICKNESS;
		zone.style.left = `${p.x}px`;
		zone.style.top = `${p.y}px`;
		zone.style.width = `${zoneWidth}px`;
		zone.style.height = `${zoneHeight}px`;
		zone.style.transform = `translate(-50%, -50%)${rot ? ` rotate(${rot}deg)` : ''}`;
		zone.dataset.dir = dir;
		zone.addEventListener('pointerdown', (event) => startTextBoxResize(event, block.id, dir, { x: left, y: top, width: w, height: h }));
		editLayer.append(zone);
	}

}

// Redimensionne la BOÎTE d'un bloc texte (box_only : la taille de police ne change
// pas). Rotation-aware : le côté opposé reste fixe dans le repère monde. Le bloc
// passe en « texte vivant » (reflow) au premier déplacement réel.
function startTextBoxResize(event, id, dir, visualBox = null) {
	if (!state.editMode) return;
	event.preventDefault();
	event.stopPropagation();
	const block = state.editBlocks.find((candidate) => candidate.id === id);
	if (!block) return;
	selectEditBlock(id);

	const snap = captureEditableSnapshot();
	const startX = event.clientX;
	const startY = event.clientY;
	const ix = visualBox?.x ?? block.x;
	const iy = visualBox?.y ?? block.y;
	const iw = Math.max(8, visualBox?.width ?? block.width);
	const ih = Math.max(8, visualBox?.height ?? block.height);
	const rot = block.rotation || 0;
	const minSize = 8;
	const signX = dir.includes('e') ? 1 : dir.includes('w') ? -1 : 0;
	const signY = dir.includes('s') ? 1 : dir.includes('n') ? -1 : 0;
	const cx0 = ix + iw / 2;
	const cy0 = iy + ih / 2;
	const anchorWorld = rotatePoint(cx0 - signX * (iw / 2), cy0 - signY * (ih / 2), cx0, cy0, rot);
	let converted = false;

	// Drag depuis le bord GAUCHE/HAUT : si le clamp « contenu minimum » (au rendu)
	// ré-agrandit la boîte, il doit le faire en gardant le côté OPPOSÉ fixe —
	// sinon la boîte se translate quand on continue à tirer au-delà du minimum.
	if (!rot) {
		block._resizeAnchorRight = signX < 0 ? ix + iw : null;
		block._resizeAnchorBottom = signY < 0 ? iy + ih : null;
	}

	const onMove = (moveEvent) => {
		// ZONE MORTE : un simple clic (ou double-clic) avec 1-2 px de tremblement
		// ne doit PAS convertir le bloc en « texte vivant » (textEdited +
		// fontSizeOverride) — cette conversion irréversible désactivait
		// l'édition native (police de substitution) sur un simple clic raté.
		if (
			!converted &&
			Math.abs(moveEvent.clientX - startX) < 3 &&
			Math.abs(moveEvent.clientY - startY) < 3
		) {
			return;
		}
		if (!converted) {
			converted = true;
			// box_only : police figée → on n'altère jamais la taille de police.
			if (!block.fontSizeOverride) block.fontSizeOverride = effectiveFontSize(block);
			// Bloc PDF d'origine → texte vivant pour autoriser le reflow.
			if (Array.isArray(block.pdfChars) && block.pdfChars.length && !isBlockTextEdited(block)) {
				block.textEdited = true;
				block.snapshotDataUrl = null;
				block.hiddenCharIndexes = [];
			}
			block.x = ix;
			block.y = iy;
			block.width = iw;
			block.height = ih;
			block.boxResized = true;
		}
		const rad = (-rot * Math.PI) / 180;
		const rawdx = moveEvent.clientX - startX;
		const rawdy = moveEvent.clientY - startY;
		const ldx = rawdx * Math.cos(rad) - rawdy * Math.sin(rad);
		const ldy = rawdx * Math.sin(rad) + rawdy * Math.cos(rad);
		const w = Math.max(minSize, iw + signX * ldx);
		const h = Math.max(minSize, ih + signY * ldy);
		// L'ancre (côté opposé) reste fixe dans le monde → recalcule le centre.
		const r = (rot * Math.PI) / 180;
		const alX = -signX * (w / 2);
		const alY = -signY * (h / 2);
		const cx1 = anchorWorld.x - (alX * Math.cos(r) - alY * Math.sin(r));
		const cy1 = anchorWorld.y - (alX * Math.sin(r) + alY * Math.cos(r));
		block.width = w;
		block.height = h;
		block.x = Math.max(0, cx1 - w / 2);
		block.y = Math.max(0, cy1 - h / 2);
		renderEditBlocksForPageOnFrame(block.page);
	};
	const onUp = (upEvent) => {
		window.removeEventListener('pointermove', onMove);
		window.removeEventListener('pointerup', onUp);
		delete block._resizeAnchorRight;
		delete block._resizeAnchorBottom;
		if (converted && (Math.abs(block.width - iw) > 0.5 || Math.abs(block.height - ih) > 0.5)) {
			commitSnapshot(snap, 'histBlockResize');
			markDirty();
		}
		// Simple clic sans tirage : les zones de resize avalent le pointerdown.
		// 1 clic = sélection, 2 clics = édition.
		if (!converted && upEvent) {
			suppressNextIdleClick();
			activateIdleBlock(block, upEvent);
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

function setEditTool(tool) {
	const next = tool === 'add-text' ? 'add-text' : 'select';
	state.editTool = next;
	elements.editSelectTool?.classList.toggle('active', next === 'select');
	elements.addTextTool?.classList.toggle('active', next === 'add-text');
	elements.addTextTool?.setAttribute('aria-pressed', String(next === 'add-text'));
	elements.pagesStack.classList.toggle('add-text-mode', next === 'add-text');
}

function activateAddTextTool() {
	if (!state.pdf) {
		setStatus(t('needPdfOpen'), 'error');
		return;
	}
	if (state.editMode && state.editTool === 'add-text') {
		setEditTool('select');
		return;
	}
	if (!state.editMode) toggleEditMode(true);
	setEditTool('add-text');
	setStatus(currentLocale() === 'fr' ? 'Cliquez dans la page pour ajouter du texte.' : 'Click the page to add text.');
}

function bytesToImageDataUrl(bytes) {
	const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let mime = 'image/png';
	if (u8.length >= 3 && u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) mime = 'image/jpeg';
	else if (u8.length >= 4 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) {
		mime = 'image/png';
	}
	let binary = '';
	const chunk = 0x8000;
	for (let i = 0; i < u8.length; i += chunk) {
		binary += String.fromCharCode(...u8.subarray(i, i + chunk));
	}
	return `data:${mime};base64,${btoa(binary)}`;
}

function loadImageDims(dataUrl) {
	return new Promise((resolve) => {
		const img = new Image();
		img.onload = () =>
			resolve({
				width: img.naturalWidth || 200,
				height: img.naturalHeight || 80
			});
		img.onerror = () => resolve({ width: 200, height: 80 });
		img.src = dataUrl;
	});
}

async function activateAddImageTool() {
	if (!state.pdf) {
		setStatus(t('needPdfOpen'), 'error');
		return;
	}
	try {
		const images = await invokeCommand('pick_images');
		if (!images || !images.length) return;
		if (!state.editMode) toggleEditMode(true);
		setEditTool('select');
		const dataUrl = bytesToImageDataUrl(images[0]);
		const dims = await loadImageDims(dataUrl);
		armSignature({
			id: `img-${Date.now()}`,
			dataUrl,
			width: dims.width,
			height: dims.height
		});
		setStatus(
			currentLocale() === 'fr'
				? 'Clique sur la page pour placer l’image.'
				: 'Click the page to place the image.'
		);
	} catch (error) {
		console.error(error);
		setStatus(error instanceof Error ? error.message : String(error), 'error');
	}
}

function activateAddSignatureTool() {
	if (!state.pdf) {
		setStatus(t('needPdfOpen'), 'error');
		return;
	}
	if (!state.editMode) toggleEditMode(true);
	setEditTool('select');
	openDrawer('sign');
	setStatus(
		currentLocale() === 'fr'
			? 'Choisis une signature ou un paraphe, puis clique sur la page pour le poser.'
			: 'Pick a saved signature or initials, then click the page to place it.'
	);
}

function measureAddedTextWidth(text, fontSize) {
	const fs = Math.max(8, Number(fontSize) || 16);
	const sample = text && String(text).length ? String(text) : 'Aa';
	try {
		const canvas = inkMeasureCanvas();
		const ctx = canvas.getContext('2d');
		ctx.font = `400 ${fs}px Helvetica, Arial, sans-serif`;
		return Math.ceil(ctx.measureText(sample).width);
	} catch (_err) {
		return Math.ceil(fs * Math.max(1, sample.length) * 0.55);
	}
}

function buildAddedTextBlock(pageNumber, pageX, pageY, options = {}) {
	const data = getPageData(pageNumber);
	if (!data) return null;
	const fontSize = Math.max(12, Number(options.fontSize) || 16 * state.zoom);
	// Hotspot I-beam OS = centre du curseur → cadre centré verticalement sur le clic.
	const height = Math.max(14, Math.ceil(fontSize));
	const text = typeof options.text === 'string' ? options.text : '';
	const caretWidth = Math.max(2, Math.ceil(fontSize * 0.12));
	const contentWidth = text
		? Math.max(caretWidth, measureAddedTextWidth(text, fontSize) + 4)
		: Math.max(caretWidth, Math.ceil(fontSize * 1.25));
	const width = Math.min(
		Math.max(8, data.viewportWidth - 8),
		Math.max(contentWidth, options.minWidth || 0)
	);
	let x = Math.max(4, Math.min(data.viewportWidth - width - 4, pageX));
	let y = Math.max(4, Math.min(data.viewportHeight - height - 4, pageY - height / 2));
	if (Number.isFinite(options.top)) {
		y = Math.max(4, Math.min(data.viewportHeight - height - 4, options.top));
	}
	if (options.align === 'center') {
		x = Math.max(4, Math.min(data.viewportWidth - width - 4, (data.viewportWidth - width) / 2));
	} else if (options.align === 'right') {
		x = Math.max(4, data.viewportWidth - width - 4);
	}
	const pdfPageWidth = data.viewportWidth / Math.max(0.01, state.zoom * CSS_UNITS);
	const pdfPageHeight = data.viewportHeight / Math.max(0.01, state.zoom * CSS_UNITS);
	return {
		id: options.id || `added-text-${pageNumber}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
		kind: 'text',
		page: pageNumber,
		text,
		originalText: '',
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
		pdfPageWidth,
		pdfPageHeight,
		baseFontSize: fontSize,
		pdfFontSize: fontSize,
		fontName: 'Helvetica',
		fontFamilyOverride: 'Helvetica',
		color: '#111111',
		align: options.align || 'left',
		bold: false,
		italic: false,
		underline: false,
		hidden: false,
		added: true,
		source: options.source || 'added',
		textEdited: true,
		inlineEditDirty: false,
		pdfChars: []
	};
}

function createAddedTextBlock(pageNumber, pageX, pageY) {
	const block = buildAddedTextBlock(pageNumber, pageX, pageY);
	if (!block) return;
	block._addSnapshot = captureEditableSnapshot();
	// Empêche un blur immédiat (panneau latéral) de sortir d'édition → Aa gris.
	block._addedEditFocusGuard = Date.now() + 500;
	state.editBlocks.push(block);
	state.page = pageNumber;
	state.selectedBlockId = block.id;
	state.selectedBlockIds = [block.id];
	setEditTool('select');
	renderEditBlocksForPage(pageNumber);
	// Édition d'abord (focus page), sync panneau ensuite — sinon le textarea vole le focus.
	startInlineEdit(block.id);
	requestAnimationFrame(() => {
		updateSelectedEditField();
		const el = elements.pagesStack.querySelector(`.edit-block.editing[data-block-id="${block.id}"]`);
		el?.focus({ preventScroll: true });
	});
}

async function activateHeaderFooterTool() {
	if (!state.pdf) {
		setStatus(t('needPdfOpen'), 'error');
		return;
	}
	if (!state.editMode) toggleEditMode(true);
	const opts = await openToolOptionsModal({
		title: t('headerFooter'),
		help: t('headerFooterHelp'),
		confirm: t('apply'),
		fields: [
			{ id: 'header', label: t('headerText'), type: 'text', value: '', placeholder: t('headerText') },
			{ id: 'footer', label: t('footerText'), type: 'text', value: '', placeholder: t('footerText') },
			{ id: 'fontSize', label: t('fontSize'), type: 'number', value: 11, min: 6, max: 48, step: 1 },
			{ id: 'margin', label: t('margin'), type: 'number', value: 28, min: 4, max: 120, step: 1 }
		]
	});
	if (!opts) return;
	const header = String(opts.header || '').trim();
	const footer = String(opts.footer || '').trim();
	if (!header && !footer) {
		setStatus(t('headerFooterEmpty'), 'error');
		return;
	}
	const snapshot = captureEditableSnapshot();
	const fontSizeCss = Math.max(10, (Number(opts.fontSize) || 11) * state.zoom * CSS_UNITS);
	const marginCss = Math.max(4, (Number(opts.margin) || 28) * state.zoom * CSS_UNITS);
	const touchedPages = new Set();
	const createdIds = [];
	for (let pageNumber = 1; pageNumber <= state.pdf.numPages; pageNumber += 1) {
		const data = getPageData(pageNumber);
		if (!data) continue;
		if (header) {
			const block = buildAddedTextBlock(pageNumber, 0, 0, {
				text: header,
				fontSize: fontSizeCss,
				align: 'center',
				top: marginCss,
				source: 'header'
			});
			if (block) {
				state.editBlocks.push(block);
				createdIds.push(block.id);
				touchedPages.add(pageNumber);
			}
		}
		if (footer) {
			const height = Math.max(14, Math.ceil(fontSizeCss));
			const block = buildAddedTextBlock(pageNumber, 0, 0, {
				text: footer,
				fontSize: fontSizeCss,
				align: 'center',
				top: data.viewportHeight - marginCss - height,
				source: 'footer'
			});
			if (block) {
				state.editBlocks.push(block);
				createdIds.push(block.id);
				touchedPages.add(pageNumber);
			}
		}
	}
	if (!createdIds.length) {
		setStatus(t('headerFooterEmpty'), 'error');
		return;
	}
	commitSnapshot(snapshot, 'histBlockAdd');
	for (const pageNumber of touchedPages) renderEditBlocksForPage(pageNumber);
	const lastId = createdIds[createdIds.length - 1];
	state.selectedBlockId = lastId;
	state.selectedBlockIds = [lastId];
	setEditTool('select');
	updateSelectedEditField();
	setStatus(t('headerFooterDone'));
}

function toggleEditMode(force) {
	state.editMode = typeof force === 'boolean' ? force : !state.editMode;
	if (!state.editMode) setEditTool('select');
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
	setEditTool('select');
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
		await runOcrForCurrentPage(false, { silent: true });
	}
}

function updateUi(renderPanels = true) {
	const hasPdf = Boolean(state.pdf);
	elements.app.classList.toggle('has-pdf', hasPdf);
	elements.app.classList.toggle('tools-hidden', !state.settings.showTools);
	elements.app.classList.toggle('rail-hidden', !state.settings.showRail);
	elements.documentName.textContent = state.fileName || t('noPdfOpen');
	elements.documentMeta.textContent = hasPdf
		? `${state.pdf.numPages} pages · ${bytesToMb(state.fileBytes.byteLength)}`
		: t('dropPdf');
	elements.openButton.textContent = hasPdf ? t('openAnother') : t('open');
	elements.openButton.setAttribute('aria-label', hasPdf ? 'Open another PDF' : 'Open PDF');
	elements.chooseEmpty.querySelector('span:last-child').textContent = hasPdf ? t('openAnother') : t('openPdf');
	elements.pageLabel.textContent = hasPdf ? `${state.page} / ${state.pdf.numPages}` : '0 / 0';
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
		elements.zoomOut,
		elements.zoomIn,
		elements.railZoomOut,
		elements.railZoomIn,
		elements.fitWidth,
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
	if (elements.shareButton) elements.shareButton.disabled = !hasPdf;
	syncToolbarAutoSave();
	const layout = state.settings.pageLayout === 'single' ? 'single' : 'continuous';
	elements.railLayoutSingle.classList.toggle('active', layout === 'single');
	elements.railFitWidth.classList.toggle('active', state.fitMode === 'page');
	elements.fitWidth?.classList.toggle('active', state.fitMode === 'width');
	if (renderPanels) {
		renderResults();
		renderNotes();
	}
}

function downloadOriginal() {
	if (!state.fileBytes || !state.fileName) return;
	void (async () => {
		if (state.nativeTextDirty) await syncNativeDocumentBytes({ render: false });
		await saveNativeFile(state.fileName, 'pdf', state.fileBytes);
	})();
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

// Exporter = Enregistrer sous (Word) : dialogue avec le MÊME nom (pas de
// « -modifie »). L'ancien fichier sur disque n'est pas touché (sauf si l'utilisateur
// choisit explicitement le même chemin). Le fichier écrit devient la nouvelle base.
async function exportEditedPdf(suggestedName) {
	if (!state.pdf) return false;
	const previousName = state.fileName;
	if (suggestedName) {
		state.fileName = sanitizeFilename(suggestedName, previousName || 'document.pdf');
	}
	const ok = await handleSaveAsDocument();
	if (!ok && suggestedName) state.fileName = previousName;
	return ok;
}

// Nom de fichier depuis un chemin disque ou une URL file://.
function fileNameFromPath(savedPath) {
	if (!savedPath || typeof savedPath !== 'string') return '';
	let path = savedPath.trim();
	if (path.startsWith('file:')) {
		try {
			path = decodeURIComponent(new URL(path).pathname);
		} catch {
			path = decodeURIComponent(path.replace(/^file:\/\//, ''));
		}
	}
	const parts = path.split(/[/\\]/).filter(Boolean);
	return parts.length ? parts[parts.length - 1] : '';
}

// Après un « Enregistrer » / « Enregistrer sous » / Export : l'onglet et le
// chrome héritent immédiatement du nom réellement choisi.
function applySavedDocumentName(savedPath) {
	const name = fileNameFromPath(savedPath);
	if (!name) return;
	state.fileName = name;
	const tab = currentTab();
	if (tab) {
		tab.fileName = name;
		tab.filePath = savedPath;
		rememberTabAutoSave(tab);
	}
}

function markDocumentSaved(bytes, savedPath) {
	const normalized = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	state.fileBytes = normalized;
	const tab = currentTab();
	if (tab) {
		tab.fileBytes = normalized;
		tab.dirty = false;
	}
	if (savedPath) applySavedDocumentName(savedPath);
	// updateUi persiste + re-render les onglets (titre à jour sans relancer).
	updateUi(false);
	if (tab) tab.dirty = false;
	renderTabs();
	if (tab) flashSavedTab(tab.id);
	rememberSavedFile(savedPath, normalized.length);
	persistOpenSession();
}

// Enregistrer (⌘S) : écrase le fichier ouvert s'il a un chemin ; sinon dialogue
// une fois, puis ce chemin devient le document de base (comportement Word).
async function handleSaveDocument() {
	if (!state.pdf) return false;
	try {
		const tab = currentTab();
		if (tab && tab.dirty) {
			setStatus(currentLocale() === 'fr' ? 'Enregistrement…' : 'Saving…');
		}
		if (state.nativeTextDirty) await syncNativeDocumentBytes({ render: false });
		const bytes = new Uint8Array(await currentDocumentBytes());
		let savedPath = null;
		if (tab?.filePath) {
			await invokeCommand('save_file', {
				path: tab.filePath,
				data: Array.from(bytes)
			});
			savedPath = tab.filePath;
			setStatus(t('fileSaved'));
		} else {
			const filename = sanitizeFilename(state.fileName, 'document.pdf');
			savedPath = await saveNativeFile(filename, 'pdf', bytes);
		}
		if (savedPath) markDocumentSaved(bytes, savedPath);
		return Boolean(savedPath);
	} catch (error) {
		console.error(error);
		setStatus(error instanceof Error ? error.message : 'Enregistrement impossible.', 'error');
		return false;
	}
}

// Enregistrer sous… : toujours un dialogue ; le chemin choisi devient le base.
async function handleSaveAsDocument() {
	if (!state.pdf) return false;
	try {
		if (state.nativeTextDirty) await syncNativeDocumentBytes({ render: false });
		const bytes = new Uint8Array(await currentDocumentBytes());
		const filename = sanitizeFilename(state.fileName, 'document.pdf');
		const savedPath = await saveNativeFile(filename, 'pdf', bytes);
		if (savedPath) markDocumentSaved(bytes, savedPath);
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
	await bakeFormValues();
	const tab = currentTab();
	if (tab && tab.dirty && state.pdf) {
		return Array.from(await exportEditedPdfBytes());
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
			bytes: await structureOpSourceBytes()
		});
		const corrected = Array.isArray(result?.corrected) ? result.corrected : [];
		if (!corrected.length) {
			setStatus(t('deskewNone'));
			return;
		}
		await replaceDocumentStructure(new Uint8Array(result.bytes), { focusPage: state.page });
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

/** État local du panneau d’impression (aperçu + formats papier). */
let _printPaperList = [];
let _printPreviewPage = 1;
let _printPreviewRenderToken = 0;
/** Réglages PPD de l’imprimante courante et choix de l’utilisateur. */
let _printAdvancedOptions = [];
let _printAdvancedValues = {};

/**
 * Rend un dialogue déplaçable par une poignée, comme une fenêtre système.
 *
 * Les dialogues sont centrés par `transform: translate(-50%, -50%)` ; au premier
 * déplacement on bascule sur des coordonnées absolues pour éviter de cumuler
 * centrage et décalage. La position est bornée à la fenêtre : impossible de
 * perdre un dialogue hors écran, barre de titre comprise.
 */
function makeDialogDraggable(dialog, handle) {
	if (!dialog || !handle) return;
	let pointerId = null;
	let originX = 0;
	let originY = 0;
	let startLeft = 0;
	let startTop = 0;

	const onPointerMove = (event) => {
		if (event.pointerId !== pointerId) return;
		const margin = 8;
		const maxLeft = Math.max(margin, window.innerWidth - dialog.offsetWidth - margin);
		const maxTop = Math.max(margin, window.innerHeight - dialog.offsetHeight - margin);
		const left = Math.min(maxLeft, Math.max(margin, startLeft + event.clientX - originX));
		const top = Math.min(maxTop, Math.max(margin, startTop + event.clientY - originY));
		dialog.style.left = `${left}px`;
		dialog.style.top = `${top}px`;
	};

	const onPointerUp = (event) => {
		if (event.pointerId !== pointerId) return;
		pointerId = null;
		handle.classList.remove('is-dragging');
		window.removeEventListener('pointermove', onPointerMove);
		window.removeEventListener('pointerup', onPointerUp);
		window.removeEventListener('pointercancel', onPointerUp);
	};

	handle.addEventListener('pointerdown', (event) => {
		if (event.button !== 0 || pointerId !== null) return;
		const rect = dialog.getBoundingClientRect();
		startLeft = rect.left;
		startTop = rect.top;
		originX = event.clientX;
		originY = event.clientY;
		pointerId = event.pointerId;
		dialog.style.transform = 'none';
		dialog.style.left = `${startLeft}px`;
		dialog.style.top = `${startTop}px`;
		handle.classList.add('is-dragging');
		window.addEventListener('pointermove', onPointerMove);
		window.addEventListener('pointerup', onPointerUp);
		window.addEventListener('pointercancel', onPointerUp);
		event.preventDefault();
	});
}

/** Remet un dialogue déplaçable au centre (à la réouverture). */
function resetDialogPosition(dialog) {
	if (!dialog) return;
	dialog.style.left = '';
	dialog.style.top = '';
	dialog.style.transform = '';
}

function printSettingsKey(printerName) {
	return `slate:print-settings:${printerName || 'default'}`;
}

/** Dernière imprimante réellement choisie pour imprimer — pas le défaut système. */
const PRINT_LAST_PRINTER_KEY = 'slate:print-last-printer';

function loadLastPrinterName() {
	try {
		return localStorage.getItem(PRINT_LAST_PRINTER_KEY) || '';
	} catch {
		return '';
	}
}

function saveLastPrinterName(printerName) {
	if (!printerName) return;
	try {
		localStorage.setItem(PRINT_LAST_PRINTER_KEY, printerName);
	} catch {
		/* quota / private mode */
	}
}

function loadPrintSettings(printerName) {
	try {
		const raw = localStorage.getItem(printSettingsKey(printerName));
		if (!raw) return null;
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

function savePrintSettings(printerName, settings) {
	try {
		localStorage.setItem(printSettingsKey(printerName), JSON.stringify(settings));
	} catch {
		/* quota / private mode */
	}
}

function collectPrintFormSettings() {
	const scaling =
		document.querySelector('input[name="print-scaling"]:checked')?.value || 'actual';
	const pagesMode = document.querySelector('input[name="print-pages"]:checked')?.value || 'all';
	const orientation =
		document.querySelector('input[name="print-orientation"]:checked')?.value || 'auto';
	return {
		paperSize: elements.printPaper?.value || '',
		scaling,
		customScale: Number(elements.printCustomScale?.value) || 100,
		orientation,
		copies: Math.max(1, Number(elements.printCopies?.value) || 1),
		pagesMode,
		pageRange: elements.printPageRange?.value?.trim() || '',
		grayscale: Boolean(elements.printGrayscale?.checked),
		duplex: Boolean(elements.printDuplex?.checked),
		reverse: Boolean(elements.printReverse?.checked),
		autoPaper: Boolean(elements.printAutoPaper?.checked),
		fitLabel: Boolean(elements.printFitLabel?.checked),
		fitCompact: elements.printFitCompact ? Boolean(elements.printFitCompact.checked) : true,
		inputSlot: elements.printInputSlot?.value || '',
		advanced: { ..._printAdvancedValues }
	};
}

function applyPrintFormSettings(settings) {
	if (!settings) return;
	if (elements.printPaper && settings.paperSize) {
		const opt = [...elements.printPaper.options].find((o) => o.value === settings.paperSize);
		if (opt) elements.printPaper.value = settings.paperSize;
	}
	const scaling = settings.scaling || 'actual';
	const scaleRadio = document.querySelector(`input[name="print-scaling"][value="${scaling}"]`);
	if (scaleRadio) scaleRadio.checked = true;
	if (elements.printCustomScale) {
		elements.printCustomScale.value = String(settings.customScale || 100);
		elements.printCustomScale.disabled = scaling !== 'custom';
	}
	const orientation = settings.orientation || 'auto';
	const orientRadio = document.querySelector(
		`input[name="print-orientation"][value="${orientation}"]`
	);
	if (orientRadio) orientRadio.checked = true;
	if (elements.printCopies) {
		elements.printCopies.value = String(Math.max(1, settings.copies || 1));
	}
	const pagesMode = settings.pagesMode || 'all';
	const pagesRadio = document.querySelector(`input[name="print-pages"][value="${pagesMode}"]`);
	if (pagesRadio) pagesRadio.checked = true;
	if (elements.printPageRange) {
		elements.printPageRange.value = settings.pageRange || '';
		elements.printPageRange.disabled = pagesMode !== 'range';
	}
	if (elements.printGrayscale) elements.printGrayscale.checked = Boolean(settings.grayscale);
	if (elements.printDuplex) elements.printDuplex.checked = Boolean(settings.duplex);
	if (elements.printReverse) elements.printReverse.checked = Boolean(settings.reverse);
	if (elements.printAutoPaper) elements.printAutoPaper.checked = Boolean(settings.autoPaper);
	// `fitLabel` absent = réglages d’avant cette option : on laisse l’auto-détection
	// décider plutôt que d’imposer « décoché ».
	if (elements.printFitLabel && typeof settings.fitLabel === 'boolean') {
		elements.printFitLabel.checked = settings.fitLabel;
		_printFitLabelTouched = true;
	}
	if (elements.printFitCompact) {
		elements.printFitCompact.checked = settings.fitCompact !== false;
	}
	if (elements.printInputSlot && settings.inputSlot) {
		const opt = [...elements.printInputSlot.options].find((o) => o.value === settings.inputSlot);
		if (opt) elements.printInputSlot.value = settings.inputSlot;
	}
	syncPrintFitLabelInputs();
	_printAdvancedValues =
		settings.advanced && typeof settings.advanced === 'object' ? { ...settings.advanced } : {};
}

/**
 * Hauteur à laquelle les bandes vides internes sont ramenées, en points (≈ 2 mm).
 * Doit rester sous `MIN_GUTTER_PT` du backend, sinon le resserrage ne gagne rien.
 */
const LABEL_GUTTER_PT = 6;
/** Au-delà de cette largeur, on est sur une imprimante bureautique, pas d’étiquettes. */
const LABEL_MEDIA_MAX_WIDTH_MM = 130;
/** Écart de format à partir duquel le recadrage vaut la peine. */
const LABEL_SIZE_MISMATCH = 0.05;

/** L’utilisateur a-t-il touché la case ? Si oui, on ne la re-décide plus pour lui. */
let _printFitLabelTouched = false;
/** Dernier recadrage calculé par le backend, pour ne pas le refaire à chaque redraw. */
let _printFitPreview = null;

/**
 * Grise les modes d’échelle quand le recadrage est actif.
 *
 * Les deux se cumuleraient sinon : le backend produit déjà une page à la taille
 * exacte du media, contenu ajusté au plus grand. Y appliquer « Ajuster » par
 * dessus ne pourrait que rétrécir le résultat.
 */
function syncPrintFitLabelInputs() {
	const active = Boolean(elements.printFitLabel?.checked);
	for (const radio of document.querySelectorAll('input[name="print-scaling"]')) {
		radio.disabled = active;
		radio.closest('.print-radio')?.classList.toggle('is-disabled', active);
	}
	if (elements.printCustomScale && active) elements.printCustomScale.disabled = true;
	if (elements.printFitCompactRow) {
		elements.printFitCompactRow.classList.toggle('hidden', !active);
	}
}

/**
 * Coche la case d’office sur une étiquette manifestement au mauvais format.
 *
 * Deux conditions, et seulement celles-là : un media étroit (imprimante
 * d’étiquettes) et un document qui ne colle pas à ce media. Le choix explicite
 * de l’utilisateur, lui, n’est jamais écrasé.
 */
async function applyFitLabelAutoDefault() {
	if (_printFitLabelTouched || !elements.printFitLabel) return;
	const paper = selectedPrintPaper();
	const widthMm = ((paper?.widthPts || 0) * 25.4) / 72;
	if (!widthMm || widthMm >= LABEL_MEDIA_MAX_WIDTH_MM) {
		elements.printFitLabel.checked = false;
		syncPrintFitLabelInputs();
		return;
	}
	const pageSize = await getPrintPageSizePts(_printPreviewPage || state.page || 1);
	if (!pageSize?.width || !pageSize?.height) return;
	const widthGap = Math.abs(pageSize.width - paper.widthPts) / paper.widthPts;
	const heightGap = Math.abs(pageSize.height - paper.heightPts) / paper.heightPts;
	elements.printFitLabel.checked =
		widthGap > LABEL_SIZE_MISMATCH || heightGap > LABEL_SIZE_MISMATCH;
	syncPrintFitLabelInputs();
}

/**
 * Demande au backend l’étiquette recadrée, et la garde en cache.
 *
 * L’aperçu affiche ce PDF-là, pas une simulation : c’est exactement ce qui
 * partira à l’imprimante, donc aucun écart possible entre les deux.
 */
async function getLabelFitPreview() {
	const paper = selectedPrintPaper();
	const widthPt = paper?.widthPts || 0;
	const heightPt = paper?.heightPts || 0;
	if (!state.fileBytes || widthPt <= 1 || heightPt <= 1) return null;
	const gutterPt = elements.printFitCompact?.checked === false ? 0 : LABEL_GUTTER_PT;
	const key = `${widthPt}x${heightPt}|${gutterPt}|${state.fileBytes.length}`;
	if (_printFitPreview?.key === key) return _printFitPreview;

	const result = await invokeCommand('fit_label_to_media', {
		bytes: Array.from(state.fileBytes),
		target: { widthPt, heightPt, marginPt: 0, gutterPt }
	});
	const data = Uint8Array.from(result.bytes || []);
	const doc = await pdfjsLib.getDocument(pdfDocumentOptions({ data: data.slice() })).promise;
	_printFitPreview = {
		key,
		doc,
		scale: result.scale || 1,
		sourceWidthPt: result.sourceWidthPt || 0,
		sourceHeightPt: result.sourceHeightPt || 0,
		compactedGutters: result.compactedGutters || 0,
		paperWidthPt: widthPt,
		paperHeightPt: heightPt
	};
	return _printFitPreview;
}

/** Invalide le cache : le document, le media ou le mode ont changé. */
function invalidateLabelFitPreview() {
	_printFitPreview?.doc?.destroy?.();
	_printFitPreview = null;
}

/** « Document 110 × 210 mm, réduit à 94 % pour tenir sur 102 × 152 mm ». */
function renderFitLabelSummary(fit) {
	const summary = elements.printFitSummary;
	if (!summary) return;
	if (!fit) {
		summary.classList.add('hidden');
		summary.textContent = '';
		return;
	}
	const percent = Math.round(fit.scale * 100);
	const parts = [
		`Document ${formatPrintMm(fit.sourceWidthPt)} × ${formatPrintMm(fit.sourceHeightPt)} mm,`,
		percent >= 100 ? 'imprimé à 100 %' : `réduit à ${percent} %`,
		`pour tenir sur ${formatPrintMm(fit.paperWidthPt)} × ${formatPrintMm(fit.paperHeightPt)} mm`
	];
	if (fit.compactedGutters > 0) {
		parts.push(
			`· ${fit.compactedGutters} espace${fit.compactedGutters > 1 ? 's' : ''} vide${fit.compactedGutters > 1 ? 's' : ''} resserré${fit.compactedGutters > 1 ? 's' : ''}`
		);
	}
	summary.textContent = parts.join(' ');
	summary.classList.remove('hidden');
}

function isPaperSourceKeyword(keyword) {
	const key = String(keyword || '').toLowerCase();
	return key === 'inputslot' || key === 'brinputslot' || key === 'mediasource';
}

function findPaperSourceOption() {
	return _printAdvancedOptions.find((option) => isPaperSourceKeyword(option.keyword)) || null;
}

function paperSourceLabel(choice) {
	const id = String(choice?.id || '');
	const lower = id.toLowerCase();
	if (lower === 'auto') return 'Auto';
	if (lower.includes('by-pass') || lower.includes('bypass') || lower.includes('manual')) {
		return 'Bac manuel';
	}
	const tray = lower.match(/(?:tray|cassette|bac)[_-]?(\d+)/);
	if (tray) return `BAC ${tray[1]}`;
	if (choice?.label && choice.label !== choice.id) return choice.label;
	return id;
}

/** BAC 1 plutôt que le défaut CUPS (souvent le bac certificats). */
function preferredPaperSourceId(choices) {
	if (!choices?.length) return '';
	const tray1 = choices.find((choice) => /(?:tray|cassette|bac)[_-]?1$/i.test(choice.id));
	if (tray1) return tray1.id;
	return choices.find((choice) => choice.isDefault)?.id || choices[0].id;
}

function populatePrintInputSlot(preferred) {
	const row = elements.printInputSlotRow;
	const select = elements.printInputSlot;
	if (!select) return;
	const option = findPaperSourceOption();
	select.innerHTML = '';
	if (!option) {
		if (row) row.hidden = true;
		select.disabled = true;
		return;
	}
	if (row) row.hidden = false;
	select.disabled = false;
	for (const choice of option.choices) {
		const item = document.createElement('option');
		item.value = choice.id;
		item.textContent = paperSourceLabel(choice);
		select.appendChild(item);
	}
	const saved = preferred || _printAdvancedValues[option.keyword] || '';
	const valid = option.choices.some((choice) => choice.id === saved);
	select.value = valid ? saved : preferredPaperSourceId(option.choices);
	delete _printAdvancedValues[option.keyword];
	updatePrintAdvancedButton();
}

function collectPrintExtraOptions() {
	const extra = Object.entries(_printAdvancedValues).filter(
		([keyword]) => !isPaperSourceKeyword(keyword)
	);
	const source = findPaperSourceOption();
	const slot = elements.printInputSlot?.value;
	if (source && slot) extra.push([source.keyword, slot]);
	return extra;
}

/**
 * Charge les réglages PPD de l’imprimante et remplit la pop-up avancée.
 *
 * Ces réglages viennent de `lpoptions -l` : chaque choix part tel quel dans
 * `lp -o <keyword>=<choix>`, donc tout ce qui s’affiche ici agit réellement.
 */
async function loadPrintAdvancedOptions(printerName) {
	_printAdvancedOptions = [];
	if (!printerName) return;
	try {
		const options = await invokeCommand('list_printer_options', { printer: printerName });
		_printAdvancedOptions = Array.isArray(options) ? options : [];
	} catch (error) {
		console.warn('print advanced options', error);
		_printAdvancedOptions = [];
	}
	// On oublie les choix mémorisés qui ne correspondent plus à cette imprimante.
	const known = new Map(_printAdvancedOptions.map((option) => [option.keyword, option]));
	for (const keyword of Object.keys(_printAdvancedValues)) {
		const option = known.get(keyword);
		if (!option || !option.choices.some((choice) => choice.id === _printAdvancedValues[keyword])) {
			delete _printAdvancedValues[keyword];
		}
	}
	updatePrintAdvancedButton();
}

function updatePrintAdvancedButton() {
	const count = Object.entries(_printAdvancedValues).filter(
		([keyword]) => !isPaperSourceKeyword(keyword)
	).length;
	const available = _printAdvancedOptions.filter(
		(option) => !isPaperSourceKeyword(option.keyword)
	).length;
	if (elements.printAdvancedOpen) {
		elements.printAdvancedOpen.disabled = available === 0;
		elements.printAdvancedOpen.textContent =
			count > 0 ? `Options avancées (${count})` : 'Options avancées';
	}
	if (elements.printLayoutFocus) {
		elements.printLayoutFocus.disabled = available === 0;
	}
}

function renderPrintAdvanced() {
	const body = elements.printAdvancedBody;
	if (!body) return;
	body.innerHTML = '';
	const visible = _printAdvancedOptions.filter((option) => !isPaperSourceKeyword(option.keyword));
	if (!visible.length) {
		const empty = document.createElement('p');
		empty.className = 'print-advanced-empty';
		empty.textContent =
			'Cette imprimante n’expose aucun réglage supplémentaire via CUPS.';
		body.appendChild(empty);
		return;
	}
	for (const option of visible) {
		const field = document.createElement('label');
		field.className = 'print-advanced-field';
		const name = document.createElement('span');
		name.textContent = option.label || option.keyword;
		const select = document.createElement('select');
		for (const choice of option.choices) {
			const item = document.createElement('option');
			item.value = choice.id;
			item.textContent = choice.isDefault
				? `${choice.label} (défaut)`
				: choice.label;
			select.appendChild(item);
		}
		const fallback =
			option.choices.find((choice) => choice.isDefault)?.id || option.choices[0].id;
		select.value = _printAdvancedValues[option.keyword] || fallback;
		select.addEventListener('change', () => {
			// Un choix identique au défaut n’a pas à être transmis à `lp`.
			if (select.value === fallback) {
				delete _printAdvancedValues[option.keyword];
			} else {
				_printAdvancedValues[option.keyword] = select.value;
			}
			updatePrintAdvancedButton();
		});
		field.append(name, select);
		body.appendChild(field);
	}
}

function openPrintAdvanced() {
	if (!elements.printAdvancedModal) return;
	if (elements.printAdvancedPrinter) {
		const selected = elements.printPrinter?.selectedOptions?.[0];
		elements.printAdvancedPrinter.textContent = selected?.textContent || '';
	}
	renderPrintAdvanced();
	resetDialogPosition(elements.printAdvancedModal);
	elements.printAdvancedModal.classList.remove('hidden');
	elements.printAdvancedClose?.focus();
}

function closePrintAdvanced() {
	elements.printAdvancedModal?.classList.add('hidden');
	void renderPrintPreview();
}

function setPrintError(message) {
	if (!elements.printError) return;
	if (message) {
		elements.printError.textContent = message;
		elements.printError.classList.remove('hidden');
	} else {
		elements.printError.textContent = '';
		elements.printError.classList.add('hidden');
	}
}

function syncPrintScaleInputs() {
	const scaling =
		document.querySelector('input[name="print-scaling"]:checked')?.value || 'actual';
	if (elements.printCustomScale) {
		elements.printCustomScale.disabled = scaling !== 'custom';
	}
	void renderPrintPreview();
}

function syncPrintPageInputs() {
	const mode = document.querySelector('input[name="print-pages"]:checked')?.value || 'all';
	if (elements.printPageRange) {
		elements.printPageRange.disabled = mode !== 'range';
	}
	if (mode === 'active' && state.page) {
		_printPreviewPage = state.page;
		void renderPrintPreview();
	}
}

function selectedPrintPaper() {
	const id = elements.printPaper?.value;
	return _printPaperList.find((p) => p.id === id) || null;
}

async function getPrintPageSizePts(pageNumber) {
	if (!state.pdf) return null;
	const page = await state.pdf.getPage(pageNumber);
	const viewport = page.getViewport({ scale: 1 });
	return { width: viewport.width, height: viewport.height };
}

function formatPrintMm(pts) {
	const mm = (pts * 25.4) / 72;
	return mm.toLocaleString('fr-FR', { maximumFractionDigits: 2 });
}

/**
 * Où et à quelle échelle la page atterrit sur la feuille.
 *
 * Miroir exact de `place_page` (src-tauri/src/print_layout.rs), qui produit le
 * PDF réellement envoyé à l’imprimante. Les deux doivent rester alignés :
 * l’aperçu ne vaut que s’il montre ce qui sortira du bac.
 *
 * `pageWidth` / `pageHeight` sont les dimensions VISIBLES (le `/Rotate` de la
 * page est déjà appliqué par le viewport pdf.js), en points.
 */
function computePrintPlacement(pageWidth, pageHeight, paper, scaling, customScale, orientation) {
	const sheetWidth = paper?.widthPts || 0;
	const sheetHeight = paper?.heightPts || 0;
	// Sans dimensions de papier (PPD illisible), le backend n’impose rien :
	// l’aperçu montre alors la page telle quelle, sans feuille autour.
	if (!pageWidth || !pageHeight || sheetWidth <= 1 || sheetHeight <= 1) {
		return {
			imposed: false,
			sheetWidth: pageWidth || 1,
			sheetHeight: pageHeight || 1,
			scale: 1,
			quarterTurn: false,
			offsetX: 0,
			offsetY: 0
		};
	}

	const pageIsLandscape = pageWidth > pageHeight;
	const sheetIsLandscape = sheetWidth > sheetHeight;
	let quarterTurn = false;
	if (orientation === 'landscape') {
		quarterTurn = !sheetIsLandscape;
	} else if (orientation !== 'portrait') {
		quarterTurn = pageIsLandscape !== sheetIsLandscape;
	}

	const finalWidth = quarterTurn ? pageHeight : pageWidth;
	const finalHeight = quarterTurn ? pageWidth : pageHeight;
	const fit = Math.min(sheetWidth / finalWidth, sheetHeight / finalHeight);
	const fill = Math.max(sheetWidth / finalWidth, sheetHeight / finalHeight);
	let scale;
	switch (scaling) {
		case 'fit':
			scale = fit;
			break;
		case 'fill':
			scale = fill;
			break;
		case 'shrink':
			scale = Math.min(fit, 1);
			break;
		case 'custom':
			scale = (customScale || 100) / 100;
			break;
		default:
			scale = 1;
	}
	scale = Math.min(100, Math.max(0.01, scale));

	return {
		imposed: true,
		sheetWidth,
		sheetHeight,
		scale,
		quarterTurn,
		offsetX: (sheetWidth - finalWidth * scale) / 2,
		offsetY: (sheetHeight - finalHeight * scale) / 2
	};
}

function pickClosestPaperId(pageSize, papers) {
	if (!pageSize || !papers?.length) return null;
	let bestId = null;
	let bestScore = Infinity;
	for (const paper of papers) {
		if (!paper.widthPts || !paper.heightPts) continue;
		const d1 =
			Math.abs(paper.widthPts - pageSize.width) + Math.abs(paper.heightPts - pageSize.height);
		const d2 =
			Math.abs(paper.widthPts - pageSize.height) + Math.abs(paper.heightPts - pageSize.width);
		const score = Math.min(d1, d2);
		if (score < bestScore) {
			bestScore = score;
			bestId = paper.id;
		}
	}
	return bestId;
}

async function applyAutoPaperIfNeeded() {
	if (!elements.printAutoPaper?.checked || !elements.printPaper) return;
	const pageSize = await getPrintPageSizePts(_printPreviewPage || state.page || 1);
	const closest = pickClosestPaperId(pageSize, _printPaperList);
	if (closest && elements.printPaper.value !== closest) {
		elements.printPaper.value = closest;
	}
}

/**
 * Dessine l’aperçu : la FEUILLE d’abord, puis la page placée dessus.
 *
 * C’est la feuille qui remplit le cadre, jamais la page. Sans ça, « Ajuster »
 * n’a aucun effet visible : la page occupait toujours tout l’espace, quel que
 * soit le mode d’échelle. Le clip sur la feuille reproduit aussi le rognage
 * réel quand le contenu déborde.
 */
async function renderPrintPreview() {
	const canvas = elements.printPreviewCanvas;
	if (!canvas || !state.pdf) return;
	const token = ++_printPreviewRenderToken;
	const total = state.pdf.numPages || 1;
	_printPreviewPage = Math.max(1, Math.min(total, _printPreviewPage || 1));
	if (elements.printPreviewPage) {
		elements.printPreviewPage.textContent = `Page ${_printPreviewPage} sur ${total}`;
	}
	if (elements.printPreviewPrev) elements.printPreviewPrev.disabled = _printPreviewPage <= 1;
	if (elements.printPreviewNext) elements.printPreviewNext.disabled = _printPreviewPage >= total;

	// Recadrage actif : on affiche le PDF réellement produit par le backend,
	// donc l’aperçu ne peut pas diverger de la sortie imprimante.
	if (elements.printFitLabel?.checked) {
		try {
			const fit = await getLabelFitPreview();
			if (token !== _printPreviewRenderToken) return;
			if (fit) {
				await drawFittedLabelPreview(canvas, fit, token);
				return;
			}
		} catch (error) {
			console.warn('print fit preview', error);
			setPrintError(error instanceof Error ? error.message : String(error));
		}
	}
	renderFitLabelSummary(null);

	try {
		const page = await state.pdf.getPage(_printPreviewPage);
		if (token !== _printPreviewRenderToken) return;
		const base = page.getViewport({ scale: 1 });
		const form = collectPrintFormSettings();
		const placement = computePrintPlacement(
			base.width,
			base.height,
			selectedPrintPaper(),
			form.scaling,
			form.customScale,
			form.orientation
		);

		if (elements.printDimsLabel) {
			elements.printDimsLabel.textContent = `${formatPrintMm(base.width)} × ${formatPrintMm(base.height)} mm`;
		}
		if (elements.printScaleLabel) {
			elements.printScaleLabel.textContent = `Échelle : ${Math.round(placement.scale * 100)} %`;
		}

		const maxWidth = 360;
		const maxHeight = 420;
		const zoom = Math.min(
			maxWidth / placement.sheetWidth,
			maxHeight / placement.sheetHeight
		);
		const ratio = pageRenderRatio();
		canvas.width = Math.max(1, Math.round(placement.sheetWidth * zoom * ratio));
		canvas.height = Math.max(1, Math.round(placement.sheetHeight * zoom * ratio));
		canvas.style.width = `${Math.round(placement.sheetWidth * zoom)}px`;
		canvas.style.height = `${Math.round(placement.sheetHeight * zoom)}px`;

		const ctx = canvas.getContext('2d');
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.fillStyle = '#ffffff';
		ctx.fillRect(0, 0, canvas.width, canvas.height);

		// Rendu de la page à part, puis composition : c’est le seul moyen de la
		// positionner librement sur la feuille et de la laisser déborder.
		const viewport = page.getViewport({
			scale: placement.scale * zoom * ratio,
			rotation: (page.rotate || 0) + (placement.quarterTurn ? 90 : 0)
		});
		const offscreen = document.createElement('canvas');
		offscreen.width = Math.max(1, Math.round(viewport.width));
		offscreen.height = Math.max(1, Math.round(viewport.height));
		await page.render({
			canvasContext: offscreen.getContext('2d'),
			viewport,
			annotationStorage: state.pdf.annotationStorage
		}).promise;
		if (token !== _printPreviewRenderToken) return;

		ctx.save();
		ctx.beginPath();
		ctx.rect(0, 0, canvas.width, canvas.height);
		ctx.clip();
		ctx.drawImage(
			offscreen,
			placement.offsetX * zoom * ratio,
			placement.offsetY * zoom * ratio
		);
		ctx.restore();
	} catch (error) {
		console.warn('print preview', error);
	}
}

/**
 * Dessine l’étiquette recadrée telle qu’elle sortira : la page produite fait
 * déjà la taille exacte du media, il n’y a donc plus rien à placer.
 */
async function drawFittedLabelPreview(canvas, fit, token) {
	const total = fit.doc.numPages || 1;
	const pageNumber = Math.max(1, Math.min(total, _printPreviewPage || 1));
	const page = await fit.doc.getPage(pageNumber);
	if (token !== _printPreviewRenderToken) return;

	const base = page.getViewport({ scale: 1 });
	const maxWidth = 360;
	const maxHeight = 420;
	const zoom = Math.min(maxWidth / base.width, maxHeight / base.height);
	const ratio = pageRenderRatio();
	const viewport = page.getViewport({ scale: zoom * ratio });

	canvas.width = Math.max(1, Math.round(viewport.width));
	canvas.height = Math.max(1, Math.round(viewport.height));
	canvas.style.width = `${Math.round(base.width * zoom)}px`;
	canvas.style.height = `${Math.round(base.height * zoom)}px`;

	const ctx = canvas.getContext('2d');
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.fillStyle = '#ffffff';
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	await page.render({ canvasContext: ctx, viewport }).promise;
	if (token !== _printPreviewRenderToken) return;

	if (elements.printDimsLabel) {
		elements.printDimsLabel.textContent = `${formatPrintMm(base.width)} × ${formatPrintMm(base.height)} mm`;
	}
	if (elements.printScaleLabel) {
		elements.printScaleLabel.textContent = `Échelle : ${Math.round(fit.scale * 100)} %`;
	}
	renderFitLabelSummary(fit);
}

async function populatePrintPapers(printerName, preferredPaper) {
	if (!elements.printPaper) return;
	elements.printPaper.innerHTML = '';
	_printPaperList = [];
	if (!printerName) return;
	try {
		const papers = await invokeCommand('list_paper_sizes', { printer: printerName });
		const list = Array.isArray(papers) ? papers : [];
		_printPaperList = list;
		if (!list.length) {
			const opt = document.createElement('option');
			opt.value = '';
			opt.textContent = '—';
			elements.printPaper.appendChild(opt);
			return;
		}
		for (const paper of list) {
			const opt = document.createElement('option');
			opt.value = paper.id;
			opt.textContent = paper.label || paper.id;
			elements.printPaper.appendChild(opt);
		}
		if (elements.printAutoPaper?.checked) {
			await applyAutoPaperIfNeeded();
		} else {
			const preferred =
				preferredPaper || list.find((p) => p.isDefault)?.id || list[0]?.id;
			if (preferred) elements.printPaper.value = preferred;
		}
		await renderPrintPreview();
	} catch (error) {
		const opt = document.createElement('option');
		opt.value = '';
		opt.textContent = '—';
		elements.printPaper.appendChild(opt);
		setPrintError(error instanceof Error ? error.message : String(error));
	}
}

async function openPrintModal() {
	if (!state.fileBytes) {
		setStatus(t('printNeedPdf'), 'error');
		return;
	}
	if (!window.__TAURI__) {
		setStatus('Impression disponible dans l’app desktop.', 'error');
		return;
	}
	setPrintError('');
	if (elements.printSubmit) elements.printSubmit.disabled = false;
	_printPreviewPage = state.page || 1;
	_printFitLabelTouched = false;
	invalidateLabelFitPreview();
	resetDialogPosition(elements.printModal);
	elements.printBackdrop?.classList.remove('hidden');
	elements.printModal?.classList.remove('hidden');
	const title = elements.printModal?.querySelector('#print-title');
	if (title) title.textContent = t('printTitle');

	try {
		setStatus(t('printPreparing'));
		const printers = await invokeCommand('list_printers');
		const list = Array.isArray(printers) ? printers : [];
		if (!elements.printPrinter) return;
		elements.printPrinter.innerHTML = '';
		if (!list.length) {
			setPrintError(t('printNoPrinters'));
			if (elements.printSubmit) elements.printSubmit.disabled = true;
			setStatus('');
			return;
		}
		for (const printer of list) {
			const opt = document.createElement('option');
			opt.value = printer.name;
			const ready = printer.isReady === false ? ' · hors ligne' : '';
			opt.textContent = `${printer.displayName || printer.name}${printer.isDefault ? ' (défaut)' : ''}${ready}`;
			elements.printPrinter.appendChild(opt);
		}
		// Dernière imprimante utilisée d’abord ; défaut système seulement si
		// aucune n’est mémorisée ou si elle a disparu de la liste CUPS.
		const lastName = loadLastPrinterName();
		const selectedPrinter =
			(lastName && list.find((p) => p.name === lastName)) ||
			list.find((p) => p.isDefault) ||
			list[0];
		elements.printPrinter.value = selectedPrinter.name;
		const saved = loadPrintSettings(selectedPrinter.name);
		applyPrintFormSettings(
			saved || {
				scaling: 'actual',
				orientation: 'auto',
				copies: 1,
				pagesMode: 'all'
			}
		);
		await loadPrintAdvancedOptions(selectedPrinter.name);
		populatePrintInputSlot(saved?.inputSlot);
		await populatePrintPapers(selectedPrinter.name, saved?.paperSize);
		await applyFitLabelAutoDefault();
		syncPrintScaleInputs();
		syncPrintPageInputs();
		await renderPrintPreview();
		setStatus('');
	} catch (error) {
		console.error(error);
		// Fallback Windows / CUPS indisponible : sheet PDFKit / start.
		closePrintModal();
		try {
			setStatus(t('printPreparing'));
			let bytes;
			const tab = currentTab();
			if (tab && tab.dirty && state.pdf) {
				bytes = Array.from(await exportEditedPdfBytes());
			} else {
				bytes = Array.from(state.fileBytes);
			}
			await invokeCommand('print_pdf', { bytes });
			setStatus('');
		} catch (fallbackError) {
			setStatus(
				fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
				'error'
			);
		}
	}
}

function closePrintModal() {
	elements.printBackdrop?.classList.add('hidden');
	elements.printModal?.classList.add('hidden');
	elements.printAdvancedModal?.classList.add('hidden');
	setPrintError('');
	if (elements.printSubmit) elements.printSubmit.disabled = false;
	_printPreviewRenderToken += 1;
	invalidateLabelFitPreview();
	renderFitLabelSummary(null);
}

async function handlePrintPdf() {
	await openPrintModal();
}

async function submitPrintJob() {
	if (!state.fileBytes) {
		setPrintError(t('printNeedPdf'));
		return;
	}
	const printer = elements.printPrinter?.value;
	if (!printer) {
		setPrintError(t('printNoPrinters'));
		return;
	}
	const form = collectPrintFormSettings();
	savePrintSettings(printer, form);
	saveLastPrinterName(printer);
	setPrintError('');
	if (elements.printSubmit) elements.printSubmit.disabled = true;
	try {
		setStatus(t('printSending'));
		// Formulaire saisi sur la page : cuit dans les octets avant impression.
		const bytes = await currentDocumentBytes();
		let pageRange = null;
		if (form.pagesMode === 'active') {
			pageRange = String(state.page || 1);
		} else if (form.pagesMode === 'range') {
			pageRange = form.pageRange || null;
		}
		// Les dimensions du media conditionnent l’imposition côté Rust : sans
		// elles, le backend retombe sur les options CUPS, que macOS ignore.
		const paper = selectedPrintPaper();
		await invokeCommand('print_pdf_with_options', {
			bytes,
			options: {
				printer,
				paperSize: form.paperSize || null,
				paperWidthPts: paper?.widthPts ?? null,
				paperHeightPts: paper?.heightPts ?? null,
				scaling: form.scaling,
				customScale: form.scaling === 'custom' ? form.customScale : null,
				orientation: form.orientation || 'auto',
				copies: form.copies || 1,
				pageRange,
				grayscale: form.grayscale,
				duplex: form.duplex,
				reverse: form.reverse,
				fitToLabel: form.fitLabel,
				labelGutterPt: form.fitCompact ? LABEL_GUTTER_PT : 0,
				labelMarginPt: 0,
				extraOptions: collectPrintExtraOptions()
			}
		});
		closePrintModal();
		setStatus(t('printDone'), 'info');
	} catch (error) {
		console.error(error);
		setPrintError(error instanceof Error ? error.message : String(error));
		setStatus('');
		if (elements.printSubmit) elements.printSubmit.disabled = false;
	}
}

async function handleRotateCurrentPage(angle) {
	return handleRotatePage(state.page, angle);
}

// Les rotations s'enchaînent sur une file : chaque clic tourne l'aperçu
// immédiatement, puis les écritures PDF se font une par une, dans l'ordre,
// chacune à partir des octets produits par la précédente.
let _rotateQueue = Promise.resolve();

async function handleRotatePage(pageNumber, angle) {
	if (!state.fileBytes || !state.pdf) {
		setStatus(t('needPdfOpen'), 'error');
		return;
	}
	const target = Number(pageNumber) || state.page;
	const data = getPageData(target);
	if (data) {
		data._pendingTurn = (data._pendingTurn || 0) + angle;
		applyRotationPreview(data);
		// La vignette a son propre compteur : elle ne cesse de simuler ce quart de
		// tour qu'une fois SON nouveau contenu peint (après la page principale).
		data._thumbPendingTurn = (data._thumbPendingTurn || 0) + angle;
		applyThumbnailRotationPreview(target, data._thumbPendingTurn);
	}
	let settled = false;
	let thumbSettled = false;
	// Le quart de tour n'est plus « en attente » dès que le rendu net l'intègre.
	const settle = () => {
		if (settled || !data) return;
		settled = true;
		data._pendingTurn -= angle;
	};
	_rotateQueue = _rotateQueue.then(async () => {
		if (!state.fileBytes || !state.pdf || getPageData(target) !== data) return;
		try {
			const rotated = await invokeBytes('rotate_pages', {
				bytes: await structureOpSourceBytes(),
				pageNumbers: [target],
				angle
			});
			settle();
			await replaceDocumentStructure(rotated, { focusPage: target, rotated: { page: target, angle } });
			thumbSettled = true;
			await refreshThumbnail(target, angle);
			setStatus(t('rotateDone'));
		} catch (error) {
			console.error(error);
			// Échec : aperçus (page et vignette) reviennent à l'état réellement rendu.
			settle();
			if (data) {
				applyRotationPreview(data);
				if (!thumbSettled) {
					data._thumbPendingTurn -= angle;
					applyThumbnailRotationPreview(target, data._thumbPendingTurn);
				}
			}
			setStatus(error instanceof Error ? error.message : String(error), 'error');
		}
	});
	await _rotateQueue;
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
		await page.render({ canvasContext: ctx, viewport, annotationStorage: state.pdf.annotationStorage })
			.promise;
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

let _propertiesSnapshot = null;

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
		const widthPts = Number(props.pageWidthPts);
		const heightPts = Number(props.pageHeightPts);
		if (Number.isFinite(widthPts) && Number.isFinite(heightPts) && widthPts > 0 && heightPts > 0) {
			pageFormat = formatPageSize(widthPts, heightPts);
		} else {
			try {
				const page = await state.pdf.getPage(1);
				const viewport = page.getViewport({ scale: 1 });
				pageFormat = formatPageSize(viewport.width, viewport.height);
			} catch {
				/* format indisponible */
			}
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

function formatPdfVersionLabel(version) {
	const raw = String(version || '').replace(/^PDF-?/i, '');
	const map = {
		'1.0': '1.0',
		'1.1': '1.1 (Acrobat 2.x)',
		'1.2': '1.2 (Acrobat 3.x)',
		'1.3': '1.3 (Acrobat 4.x)',
		'1.4': '1.4 (Acrobat 5.x)',
		'1.5': '1.5 (Acrobat 6.x)',
		'1.6': '1.6 (Acrobat 7.x)',
		'1.7': '1.7 (Acrobat 8.x / ISO 32000-1)',
		'2.0': '2.0 (ISO 32000-2)'
	};
	return map[raw] || raw || '—';
}

function formatFileSizeAcrobat(bytes) {
	const size = Number(bytes) || 0;
	const mo = size / (1024 * 1024);
	const moLabel = mo.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
	const octets = Math.round(size).toLocaleString('de-DE');
	return `${moLabel} Mo (${octets} octets)`;
}

function yesNo(value) {
	return value ? 'Oui' : 'Non';
}

function allowedLabel(allowed) {
	return allowed ? 'Autorisée' : 'Non autorisée';
}

function setPropsTab(tabId) {
	const tabs = elements.propertiesModal?.querySelectorAll('[data-props-tab]') || [];
	const panels = elements.propertiesModal?.querySelectorAll('[data-props-panel]') || [];
	for (const tab of tabs) {
		const active = tab.dataset.propsTab === tabId;
		tab.classList.toggle('active', active);
		tab.setAttribute('aria-selected', active ? 'true' : 'false');
	}
	for (const panel of panels) {
		const active = panel.dataset.propsPanel === tabId;
		panel.classList.toggle('active', active);
		panel.hidden = !active;
	}
}

function showPropertiesModal(props, pageFormat) {
	_propertiesSnapshot = props;
	const setText = (id, value) => {
		const node = document.getElementById(id);
		if (node) node.textContent = value || '—';
	};
	const setInput = (id, value) => {
		const node = document.getElementById(id);
		if (node) node.value = value || '';
	};

	setText('props-file-name', state.fileName || '—');
	setInput('props-title', props.title);
	setInput('props-author', props.author);
	setInput('props-subject', props.subject);
	setInput('props-keywords', props.keywords);
	setText('props-created', formatPdfDate(props.creationDate) || '—');
	setText('props-modified', formatPdfDate(props.modDate) || '—');
	setText('props-creator', props.creator || '—');
	setText('props-producer', props.producer || '—');
	setText('props-pdf-version', formatPdfVersionLabel(props.pdfVersion));
	setText('props-location', currentTab()?.filePath || '—');
	setText('props-file-size', formatFileSizeAcrobat(props.fileSize));
	setText('props-page-format', pageFormat || '—');
	setText('props-page-count', String(props.pageCount ?? '—'));
	setText('props-tagged', yesNo(Boolean(props.tagged)));
	setText('props-linearized', yesNo(Boolean(props.linearized)));

	setText('props-security-method', props.securityMethod || (props.encrypted ? 'Mot de passe' : 'Aucune'));
	setText('props-perm-print', allowedLabel(Boolean(props.canPrint)));
	setText('props-perm-modify', allowedLabel(Boolean(props.canModify)));
	setText('props-perm-assemble', allowedLabel(Boolean(props.canModify)));
	setText('props-perm-copy', allowedLabel(Boolean(props.canCopy)));
	setText('props-perm-annotate', allowedLabel(Boolean(props.canAnnotate)));
	setText('props-perm-forms', allowedLabel(Boolean(props.canAnnotate)));

	const layoutMap = {
		SinglePage: 'Une seule page',
		OneColumn: 'Une colonne',
		TwoColumnLeft: 'Deux colonnes (gauche)',
		TwoColumnRight: 'Deux colonnes (droite)',
		TwoPageLeft: 'Deux pages (gauche)',
		TwoPageRight: 'Deux pages (droite)'
	};
	const modeMap = {
		UseNone: 'Page seule',
		UseOutlines: 'Signets et page',
		UseThumbs: 'Vignettes et page',
		FullScreen: 'Plein écran',
		UseOC: 'Calques et page',
		UseAttachments: 'Pièces jointes et page'
	};
	setText('props-page-layout', layoutMap[props.pageLayout] || props.pageLayout || 'Par défaut');
	setText('props-page-mode', modeMap[props.pageMode] || props.pageMode || 'Par défaut');
	setText('props-trapped', props.trapped || 'Non spécifié');

	const fontsList = document.getElementById('props-fonts-list');
	if (fontsList) {
		fontsList.innerHTML = '';
		const fonts = Array.isArray(props.fonts) ? props.fonts : [];
		if (!fonts.length) {
			const empty = document.createElement('li');
			empty.textContent = 'Aucune police détectée dans ce document.';
			fontsList.append(empty);
		} else {
			for (const font of fonts) {
				const li = document.createElement('li');
				const name = document.createElement('span');
				name.className = 'font-name';
				name.textContent = font.name || 'Sans nom';
				const meta = document.createElement('span');
				meta.className = 'font-meta';
				const bits = [font.subtype || null, font.encoding || null, font.embedded ? 'Incorporée' : 'Non incorporée'].filter(Boolean);
				meta.textContent = bits.join(' · ');
				li.append(name, meta);
				fontsList.append(li);
			}
		}
	}

	const customBody = document.getElementById('props-custom-body');
	const customEmpty = document.getElementById('props-custom-empty');
	const customWrap = customBody?.closest('.properties-custom-table-wrap');
	const customs = Array.isArray(props.customProperties) ? props.customProperties : [];
	if (customBody) {
		customBody.innerHTML = '';
		for (const item of customs) {
			const tr = document.createElement('tr');
			const tdName = document.createElement('td');
			tdName.textContent = item.name || '';
			const tdValue = document.createElement('td');
			tdValue.textContent = item.value || '';
			tr.append(tdName, tdValue);
			customBody.append(tr);
		}
	}
	if (customEmpty) customEmpty.hidden = customs.length > 0;
	if (customWrap) customWrap.hidden = customs.length === 0;

	setPropsTab('description');
	elements.propertiesBackdrop.classList.remove('hidden');
	elements.propertiesModal.classList.remove('hidden');
	document.getElementById('props-title')?.focus();
}

function closePropertiesModal() {
	elements.propertiesBackdrop.classList.add('hidden');
	elements.propertiesModal.classList.add('hidden');
	_propertiesSnapshot = null;
}

async function applyPropertiesModal() {
	if (!state.fileBytes) {
		closePropertiesModal();
		return;
	}
	const title = document.getElementById('props-title')?.value ?? '';
	const author = document.getElementById('props-author')?.value ?? '';
	const subject = document.getElementById('props-subject')?.value ?? '';
	const keywords = document.getElementById('props-keywords')?.value ?? '';
	const prev = _propertiesSnapshot || {};
	const unchanged =
		(prev.title || '') === title &&
		(prev.author || '') === author &&
		(prev.subject || '') === subject &&
		(prev.keywords || '') === keywords;
	if (unchanged) {
		closePropertiesModal();
		return;
	}
	try {
		const bytes = await invokeBytes('set_pdf_metadata', {
			bytes: Array.from(state.fileBytes),
			title,
			author,
			subject,
			keywords
		});
		if (!bytes?.length) throw new Error('Métadonnées non enregistrées.');
		state.fileBytes = bytes;
		const tab = currentTab();
		if (tab) tab.fileBytes = bytes;
		const loadingTask = pdfjsLib.getDocument(pdfDocumentOptions({ data: bytes.slice() }));
		const pdf = await loadingTask.promise;
		state.pdf = pdf;
		if (tab) tab.pdf = pdf;
		markDirty();
		invalidateAllPages();
		await renderCurrentPage();
		closePropertiesModal();
		setStatus('Métadonnées mises à jour.', 'info');
	} catch (error) {
		console.error(error);
		setStatus(error instanceof Error ? error.message : String(error), 'error');
	}
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
	const name = fileNameFromPath(savedPath) || 'document.pdf';
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
		const filePath = result.path || '';
		await openPdfFromBytes(bytes, fileName, { filePath });
		await rememberRecentFile(filePath, fileName);
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
		await openPdfFromBytes(new Uint8Array(bytes), item.name, { filePath: item.path });
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
	syncToolbarAutoSave();
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

async function handleReorderPages(newOrder, focusPage) {
	if (!state.fileBytes || !state.pdf) {
		setStatus(t('needPdfOpen'), 'error');
		return;
	}
	try {
		const updated = await invokeBytes('reorder_pages', {
			bytes: await structureOpSourceBytes(),
			newOrder
		});
		// newOrder[i] = ancienne page qui occupe désormais la position i + 1.
		await replaceDocumentStructure(updated, {
			focusPage,
			mapPage: (page) => {
				const index = newOrder.indexOf(page);
				return index < 0 ? null : index + 1;
			}
		});
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
	return handleDeletePage(state.page);
}

async function handleDeletePage(pageNumber) {
	if (!state.fileBytes || !state.pdf) {
		setStatus(t('needPdfOpen'), 'error');
		return;
	}
	if (state.pdf.numPages <= 1) {
		setStatus(t('deleteLastPage'), 'error');
		return;
	}
	const targetPage = Number(pageNumber) || state.page;
	try {
		setStatus(t('deleteProcessing'));
		const updated = await invokeBytes('delete_pages', {
			bytes: await structureOpSourceBytes(),
			pageNumbers: [targetPage]
		});
		await replaceDocumentStructure(updated, {
			focusPage: Math.min(targetPage, state.pdf.numPages - 1),
			mapPage: (page) => {
				if (page === targetPage) return null;
				return page > targetPage ? page - 1 : page;
			}
		});
		setStatus(t('deleteDone'));
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

// Une page nécessite l'aplatissement si elle porte une édition visible : bloc
// masqué, ajouté (copie) ou modifié (déplacé/redimensionné/texte), ou une
// signature. Sinon elle est conservée telle quelle (texte natif) à l'export.
function pageHasEdits(pageNumber) {
	const blockEdited = state.editBlocks.some(
		(block) =>
			block.page === pageNumber &&
			!isEmptyAddedPlaceholder(block) &&
			(block.hidden || block.added || isBlockDirty(block))
	);
	if (blockEdited) return true;
	return (state.signaturePlacements || []).some((placement) => placement.page === pageNumber);
}

function exportStrategyForPage(pageNumber) {
	const blocks = state.editBlocks.filter(
		(block) => block.page === pageNumber && !isEmptyAddedPlaceholder(block)
	);
	const signatures = (state.signaturePlacements || []).filter((placement) => placement.page === pageNumber);
	if (!blocks.some((block) => block.hidden || block.added || isBlockDirty(block)) && signatures.length === 0) {
		return { pageNumber, mode: 'native_preserved', reason: 'no_edits' };
	}
	const complex = signatures.length > 0 || blocks.some((block) =>
		block.kind === 'image' ||
		(block.added && !canVectorEditBlock(block)) ||
		block.rotation ||
		block.boxResized ||
		block.htmlEdited ||
		// Composite (glyphes préservés) : la voie vectorielle ré-écrirait tout le
		// bloc dans une police standard (perte des glyphes natifs). L'aplatissement
		// reproduit exactement l'écran → fidélité prioritaire.
		isGlyphCompositeBlock(block) ||
		(block.source === 'ocr' && isBlockDirty(block) && !canVectorEditBlock(block))
	);
	const simpleTextOnly = !complex && blocks.some((block) =>
		block.kind !== 'image' &&
		(block.added || isBlockDirty(block)) &&
		(block.source === 'added' || block.source === 'ocr' || isBlockTextEdited(block) || block.hidden || hasLocalGlyphEdits(block))
	);
	return simpleTextOnly
		? { pageNumber, mode: 'vector_candidate', reason: 'simple_text' }
		: { pageNumber, mode: 'flatten_page', reason: complex ? 'complex_edit' : 'safe_fallback' };
}

function buildExportAuditReport() {
	const warnings = [];
	const strategies = [];
	if (!state.pdf) return { warnings, strategies };
	for (let pageNumber = 1; pageNumber <= state.pdf.numPages; pageNumber += 1) {
		const strategy = exportStrategyForPage(pageNumber);
		strategies.push(strategy);
		if (strategy.mode === 'flatten_page') {
			warnings.push(`Page ${pageNumber} aplatie (${strategy.reason}) : texte non sélectionnable sur cette page.`);
		}
	}
	for (const block of state.editBlocks) {
		const dirty = block.hidden || block.added || isBlockDirty(block);
		if (!dirty) continue;
		if (block.critical) {
			const action = block.hidden ? 'masqué/supprimé' : 'modifié';
			warnings.push(`Champ critique ${fieldLabel(block.fieldKind)} ${action} page ${block.page}.`);
		}
		if (block.source === 'ocr' && Number(block.confidence ?? 100) < 70) {
			warnings.push(`Bloc OCR faible confiance exporté page ${block.page}.`);
		} else if (block.source === 'ocr' && canVectorEditBlock(block)) {
			warnings.push(`Bloc OCR page ${block.page} exporté en couche texte PDF native.`);
		}
	}
	const totalsChanged = state.editBlocks.some((block) => block.fieldKind === 'total' && isBlockDirty(block));
	const taxChanged = state.editBlocks.some((block) => block.fieldKind === 'tax' && isBlockDirty(block));
	if (totalsChanged && !taxChanged) {
		warnings.push('Total modifié sans TVA associée modifiée.');
	}
	return {
		warnings: Array.from(new Set(warnings)).slice(0, 8),
		strategies
	};
}

function confirmExportAudit(report) {
	if (!report?.warnings?.length) return true;
	const message = [
		'Audit avant export :',
		'',
		...report.warnings.map((warning) => `- ${warning}`),
		'',
		'Continuer quand même ?'
	].join('\n');
	return window.confirm(message);
}

function normalizePdfFontForVector(block) {
	const name = normalizeDocText(block.fontName || block.fontFamilyOverride || '');
	if (name.includes('times')) return block.bold ? 'times-bold' : block.italic ? 'times-italic' : 'times';
	if (name.includes('courier') || name.includes('mono')) return block.bold ? 'courier-bold' : 'courier';
	if (block.bold) return 'helvetica-bold';
	if (block.italic) return 'helvetica-oblique';
	return 'helvetica';
}

function blockRectToPdfPoints(block, current = false) {
	const pageWidth = block.pageWidth || 0;
	const pageHeight = block.pageHeight || 0;
	const pdfWidth = block.pdfPageWidth || 0;
	const pdfHeight = block.pdfPageHeight || 0;
	if (!(pageWidth > 0 && pageHeight > 0 && pdfWidth > 0 && pdfHeight > 0)) return null;
	const x = current ? block.x : (block.originalX ?? block.x);
	const y = current ? block.y : (block.originalY ?? block.y);
	const width = current ? block.width : (block.originalWidth ?? block.width);
	const height = current ? block.height : (block.originalHeight ?? block.height);
	const sx = pdfWidth / pageWidth;
	const sy = pdfHeight / pageHeight;
	return [x * sx, y * sy, (x + width) * sx, (y + height) * sy];
}

function blockFontSizeToPdfPoints(block) {
	const pageHeight = block.pageHeight || 0;
	const pdfHeight = block.pdfPageHeight || 0;
	const size = block.fontSizeOverride || block.pdfFontSize || block.baseFontSize || Math.max(8, block.height * 0.78);
	if (!(pageHeight > 0 && pdfHeight > 0)) return size;
	return size * (pdfHeight / pageHeight);
}

function canVectorEditBlock(block) {
	if (!block || block.kind === 'image') return false;
	// Restent non vectorisables : rotation (insert_textbox ne pose pas de matrice),
	// htmlEdited (formatage
	// par-caractère = plusieurs runs, alors qu'on écrit un seul run homogène).
	// En revanche déplacé/redimensionné ET changement de police sont désormais
	// gérés (effacement à l'origine + réécriture à la cible, police embarquée).
	if (block.rotation || block.htmlEdited) return false;
	if (!block.pdfPageWidth || !block.pdfPageHeight) return false;
	if (block.added) {
		if (block.source !== 'added' || !(block.text || '').trim()) return false;
		if (needsCloudFont(primaryFamilyName(block.fontFamilyOverride || ''))) return false;
		const target = blockRectToPdfPoints(block, true);
		return Boolean(target && target[2] - target[0] >= 4 && target[3] - target[1] >= 4);
	}
	if (block.source === 'ocr') {
		if (!block.hidden && !isBlockDirty(block)) return false;
		const confidence = Number(block.confidence ?? 100);
		if (confidence < 70) return false;
		const target = blockRectToPdfPoints(block, true);
		const source = blockRectToPdfPoints(block, false);
		if (!target || !source) return false;
		const targetWidth = target[2] - target[0];
		const targetHeight = target[3] - target[1];
		return targetWidth >= 4 && targetHeight >= 4;
	}
	if (block.source !== 'pdfium') return false;
	// Garde anti-Helvetica-silencieux : une web-font NON installée localement ne
	// peut pas être résolue en octets par font_kit côté natif, donc l'embedding
	// retomberait en base-14 sans le dire. On force alors le rendu raster de la
	// page (la WebView y dessine la vraie web-font, déjà chargée) → police
	// correcte à l'écran plutôt que mauvaise police vectorielle. Les polices
	// système (résolvables par font_kit) restent vectorielles et embarquées.
	if (needsCloudFont(primaryFamilyName(block.fontFamilyOverride || ''))) return false;
	return block.hidden || isBlockTextEdited(block) || hasLocalGlyphEdits(block);
}

// Plan vectoriel à granularité PAGE : seules les pages dont TOUS les blocs
// modifiés sont vectorisables (et sans signature) restent vectorielles. Les
// autres pages éditées sont rasterisées individuellement par l'appelant. Fini
// le tout-ou-rien où un seul bloc difficile faisait basculer tout le document
// en image. Retourne { operations, vectorPages:Set } ou null.
function buildVectorEditPlan() {
	const dirtyBlocks = state.editBlocks.filter(
		(block) =>
			!isEmptyAddedPlaceholder(block) && (block.hidden || block.added || isBlockDirty(block))
	);
	if (!dirtyBlocks.length) return null;
	const placements = state.signaturePlacements || [];
	const candidatePages = new Set(dirtyBlocks.map((block) => block.page));
	const vectorPages = new Set();
	const operations = [];
	for (const page of candidatePages) {
		if (placements.some((placement) => placement.page === page)) continue;
		const pageBlocks = dirtyBlocks.filter((block) => block.page === page);
		if (!pageBlocks.every(canVectorEditBlock)) continue;
		const pageOps = [];
		let ok = true;
		for (const block of pageBlocks) {
			const bbox = blockRectToPdfPoints(block, false);
			const targetBbox = blockRectToPdfPoints(block, true);
			if (!bbox || !targetBbox) {
				ok = false;
				break;
			}
			pageOps.push({
				pageNumber: block.page,
				bbox,
				targetBbox,
				text: block.hidden ? '' : hasLocalGlyphEdits(block) ? visiblePdfText(block) : block.text || '',
				font: normalizePdfFontForVector(block),
				fontFamily: block.fontFamilyOverride || block.fontName || null,
				bold: !!block.bold,
				italic: !!block.italic,
				size: blockFontSizeToPdfPoints(block),
				color: hexToRgb(block.color || '#111111'),
				align: block.align || 'left',
				source: block.source || null,
				insertOnly: Boolean(block.added && block.source === 'added'),
				reason: block.added
					? 'add_text'
					: block.hidden
						? 'hide_text'
						: isBlockTextEdited(block)
							? 'replace_text'
							: 'glyph_edit'
			});
		}
		if (!ok) continue;
		vectorPages.add(page);
		operations.push(...pageOps);
	}
	return operations.length ? { operations, vectorPages } : null;
}

// Précharge les polices cloud utilisées par les blocs édités avant tout rendu
// canvas (sinon le JPEG exporté utiliserait une police de repli).
async function ensureEditorFontsReady() {
	for (const block of state.editBlocks) {
		if (needsCloudFont(block.fontFamilyOverride)) {
			ensureCloudFont(block.fontFamilyOverride);
		}
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
}

// Export de l'éditeur. Chemin HYBRIDE : seules les pages éditées sont aplaties
// en image, les pages intactes gardent leur texte/vecteurs natifs (nets,
// sélectionnables, fichier léger). Repli automatique sur l'aplatissement
// complet (ancien chemin éprouvé) si le moteur natif échoue. Retourne le même
// type que invokeBytes.
async function exportEditedPdfBytes(options = {}) {
	// Éditions natives : les octets de base doivent inclure le texte édité
	// côté moteur (sinon l'export repartirait du document d'origine).
	if (state.nativeTextDirty) await syncNativeDocumentBytes({ render: false });
	if (options.audit) {
		const report = buildExportAuditReport();
		if (!confirmExportAudit(report)) {
			throw new Error('Export annulé après audit.');
		}
	}
	await ensureEditorFontsReady();
	const total = state.pdf.numPages;
	const strategies = buildExportAuditReport().strategies;
	const vectorPlan = buildVectorEditPlan();
	// Passe 1 — vectorielle : applique les pages vectorisables. Le résultat sert
	// de base à la passe raster (chaînage), pour que les deux coexistent dans le
	// même document final (pages nettes vectorielles + pages éditées complexes
	// rasterisées). vectorPages = pages réellement traitées en vectoriel.
	let workingBytes = null;
	let vectorPages = new Set();
	if (vectorPlan && vectorPlan.operations.length) {
		try {
			const result = await invokeCommand('export_edited_pdf_vector', {
				original: Array.from(state.fileBytes),
				operations: vectorPlan.operations
			});
			if (result?.bytes?.length > 64) {
				if (Array.isArray(result.warnings) && result.warnings.length) {
					console.warn('Vector PDF export warnings:', result.warnings);
				}
				workingBytes = new Uint8Array(result.bytes);
				vectorPages = vectorPlan.vectorPages;
			}
		} catch (error) {
			console.warn('Vector PDF export failed; falling back to hybrid flatten.', error);
		}
	}
	// Passe 2 — raster : seules les pages éditées NON couvertes par le vectoriel
	// sont aplaties. Les pages vectorielles (vectorPages) sont laissées telles
	// quelles dans le document issu de la passe 1.
	try {
		const pages = [];
		let needsRaster = false;
		for (let pageNumber = 1; pageNumber <= total; pageNumber += 1) {
			if (pageHasEdits(pageNumber) && !vectorPages.has(pageNumber)) {
				const flat = await renderFlattenedPage(pageNumber);
				const strategy = strategies.find((item) => item.pageNumber === pageNumber);
				pages.push({ pageNumber, jpegBytes: flat.jpegBytes, width: flat.width, height: flat.height, strategy });
				needsRaster = true;
			} else {
				pages.push({ pageNumber, jpegBytes: [], width: 0, height: 0 });
			}
		}
		if (!needsRaster && workingBytes) {
			return workingBytes;
		}
		const original = workingBytes ? Array.from(workingBytes) : Array.from(state.fileBytes);
		const out = await invokeBytes('export_edited_pdf_native', { original, pages });
		const len = out?.byteLength ?? out?.length ?? 0;
		if (len > 64) return out;
		console.warn('Native export returned an unexpectedly small result; falling back to flatten.');
	} catch (error) {
		console.warn('Native hybrid export failed; falling back to full flatten.', error);
	}
	const pages = [];
	for (let pageNumber = 1; pageNumber <= total; pageNumber += 1) {
		pages.push(await renderFlattenedPage(pageNumber));
	}
	return await invokeBytes('export_edited_pdf', { pages });
}

async function renderFlattenedPage(pageNumber) {
	const page = await state.pdf.getPage(pageNumber);
	// scale 3 = ~216 DPI (vs 2 = ~144 DPI auparavant) : la page éditée aplatie
	// est nettement plus nette, sans flou perceptible aux niveaux de zoom usuels.
	const viewport = page.getViewport({ scale: 3 });
	const canvas = document.createElement('canvas');
	const context = canvas.getContext('2d');
	if (!context) throw new Error('Unable to create export canvas.');

	canvas.width = Math.round(viewport.width);
	canvas.height = Math.round(viewport.height);
	await page.render({ canvasContext: context, viewport, annotationStorage: state.pdf.annotationStorage })
		.promise;

	const blocks = state.editBlocks.filter((block) => block.page === pageNumber);
	context.textBaseline = 'top';

	const needsOriginalCopy = blocks.some(
		(block) =>
			!block.hidden &&
			isBlockDirty(block) &&
			(!isBlockTextEdited(block) || isGlyphCompositeBlock(block))
	);
	let originalCopy = null;
	if (needsOriginalCopy) {
		originalCopy = document.createElement('canvas');
		originalCopy.width = canvas.width;
		originalCopy.height = canvas.height;
		originalCopy.getContext('2d').drawImage(canvas, 0, 0);
	}

	for (const block of blocks) {
		if (isEmptyAddedPlaceholder(block)) continue;
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
		// Glyphes préservés (composite) : l'export reproduit EXACTEMENT l'écran.
		// Masques uniquement sur les glyphes remplacés/décalés, suffixe re-dessiné
		// depuis la copie d'origine (pixels natifs, translatés de dx), insertion
		// dessinée dans la police de substitution sur la même ligne de base.
		const exportComposite =
			block.kind !== 'image' && !block.hidden ? glyphCompositeInfo(block) : null;
		if (exportComposite) {
			// Décalage imperceptible (< 0.5px) : le suffixe reste natif, comme à
			// l'écran — on ne masque et re-dessine que les glyphes remplacés.
			const shiftSuffix = exportComposite.suffixChars.length && Math.abs(exportComposite.dx) >= 0.5;
			const maskChars = shiftSuffix
				? [...exportComposite.replacedChars, ...exportComposite.suffixChars]
				: exportComposite.replacedChars;
			context.fillStyle = '#ffffff';
			for (const ch of maskChars) {
				const rect = glyphMaskRect(ch, block);
				context.fillRect(
					rect.x * blockScaleX - 0.5,
					rect.y * blockScaleY - 0.5,
					rect.width * blockScaleX + 1,
					rect.height * blockScaleY + 1
				);
			}
			if (shiftSuffix && originalCopy) {
				const rangeRect = glyphRangeInkRect(exportComposite.suffixChars);
				if (rangeRect) {
					const sliceW = Math.max(1, Math.round(rangeRect.width * blockScaleX));
					const sliceH = Math.max(1, Math.round(rangeRect.height * blockScaleY));
					const slice = document.createElement('canvas');
					slice.width = sliceW;
					slice.height = sliceH;
					const sliceCtx = slice.getContext('2d', { willReadFrequently: true });
					sliceCtx.drawImage(
						originalCopy,
						rangeRect.x * blockScaleX,
						rangeRect.y * blockScaleY,
						rangeRect.width * blockScaleX,
						rangeRect.height * blockScaleY,
						0,
						0,
						sliceW,
						sliceH
					);
					whiteToAlphaCanvas(sliceCtx, sliceW, sliceH);
					context.drawImage(
						slice,
						(rangeRect.x + exportComposite.dx) * blockScaleX,
						rangeRect.y * blockScaleY,
						rangeRect.width * blockScaleX,
						rangeRect.height * blockScaleY
					);
				}
			}
			if (exportComposite.inserted) {
				const font = exportComposite.font;
				// Ligne de base NATIVE (bas d'encre des glyphes sans jambage), même
				// source que le rendu écran. Repli sur une estimation par bloc.
				const nativeBaseline = compositeBaseline(block, font);
				const baselineCss =
					nativeBaseline != null ? nativeBaseline : block.originalY + block.height * 0.8;
				context.save();
				context.font = `${font.style} ${font.weight} ${font.fs * blockScaleY}px ${font.family}`;
				context.fillStyle = block.color || '#111111';
				context.textBaseline = 'alphabetic';
				context.fillText(
					exportComposite.inserted,
					exportComposite.insertX * blockScaleX,
					baselineCss * blockScaleY
				);
				context.restore();
				context.textBaseline = 'top';
			}
			continue;
		}

		const originalChars = Array.isArray(block.pdfChars) ? block.pdfChars : [];
		if (!block.added) {
			context.fillStyle = '#ffffff';
			if (!block.hidden && textEdited && block.kind !== 'image' && originalChars.length) {
				// Masque SERRÉ par glyphe (comme à l'écran) : on cache pile l'ancien
				// texte sans recouvrir les traits du tableau. Le nouveau texte est
				// redessiné juste après (textEdited), donc rien ne disparaît.
				for (const ch of originalChars) {
					const mx = (ch.maskX ?? ch.x) * blockScaleX;
					const my = (ch.maskY ?? ch.y) * blockScaleY;
					const mw = (ch.maskWidth ?? ch.width) * blockScaleX;
					const mh = (ch.maskHeight ?? ch.height) * blockScaleY;
					context.fillRect(mx - 0.5, my - 0.5, mw + 1, mh + 1);
				}
			} else {
				context.fillRect(originalX - 1, originalY - 1, srcW + 2, srcH + 2);
			}
		}

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

			// Largeur de colonne pour le retour à la ligne. Pour un bloc ÉDITÉ on
			// n'enroule QUE sur les \n explicites (colWidth infini) afin que le PDF
			// exporté corresponde exactement à l'écran (white-space: pre). Un paragraphe
			// natif non touché garde le wrap à sa largeur (sécurité ligne trop longue).
			const colWidth = block.multiline && !textEdited ? Math.max(20, width) : Infinity;
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

			// Rotation éventuelle du bloc texte : on tourne le repère autour du centre
			// de la boîte (mêmes centre/angle que le rendu écran).
			const rot = block.rotation || 0;
			if (rot) {
				const cx = block.x * blockScaleX + width / 2;
				const cy = block.y * blockScaleY + height / 2;
				context.save();
				context.translate(cx, cy);
				context.rotate((rot * Math.PI) / 180);
				context.translate(-cx, -cy);
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
			if (rot) context.restore();
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

	// PNG sans perte au lieu de JPEG 0.92 : zéro artefact de compression sur le
	// texte/les traits. Le moteur natif re-décode via image::load_from_memory
	// (format auto-détecté), donc le champ reste `jpegBytes` sans casse Rust.
	const pageImageBytes = await canvasToPngBytes(canvas);
	return {
		jpegBytes: Array.from(pageImageBytes),
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
		history: ['historyKicker', 'historyTitle'],
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
	} else if (panel === 'history') {
		renderHistoryPanel();
	} else if (panel === 'ai') {
		focusAiInput();
	}
}

// ── Panneau Historique (façon Google Docs / Photoshop) ─────────────────────
// Liste chronologique de toutes les modifications : les plus récentes en haut,
// les actions annulées (rétablissables) grisées au-dessus de la position
// courante. Cliquer une entrée ramène le document à l'état JUSTE APRÈS cette
// action ; « État d'origine » ramène au document initial.
function formatHistoryTime(ts) {
	const date = new Date(ts);
	const now = new Date();
	const sameDay =
		date.getFullYear() === now.getFullYear() &&
		date.getMonth() === now.getMonth() &&
		date.getDate() === now.getDate();
	const locale = currentLocale() === 'fr' ? 'fr-FR' : 'en-US';
	const time = date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
	if (sameDay) return time;
	return `${date.toLocaleDateString(locale, { day: 'numeric', month: 'short' })} ${time}`;
}

function renderHistoryPanel() {
	const list = document.getElementById('history-list');
	const empty = document.getElementById('history-empty');
	if (!list || !empty) return;
	list.innerHTML = '';
	const tab = currentTab();
	const undoStack = (tab && tab.undoStack) || [];
	const redoStack = (tab && tab.redoStack) || [];
	empty.textContent = t('historyEmpty');
	const hasHistory = undoStack.length || redoStack.length;
	empty.classList.toggle('hidden', Boolean(hasHistory));
	if (!hasHistory) return;

	const makeRow = ({ label, time, current, undone, onClick }) => {
		const item = document.createElement('li');
		const button = document.createElement('button');
		button.type = 'button';
		button.className = `history-row${current ? ' current' : ''}${undone ? ' undone' : ''}`;
		const text = document.createElement('span');
		text.className = 'history-row-label';
		text.textContent = label;
		const when = document.createElement('span');
		when.className = 'history-row-time';
		when.textContent = time;
		button.append(text, when);
		if (onClick) button.addEventListener('click', onClick);
		else button.disabled = true;
		item.append(button);
		list.append(item);
	};

	// Actions annulées (futur rétablissable), la plus lointaine en haut.
	// redoStack[len-1] = prochaine action à rétablir → affichée juste au-dessus
	// de la position courante.
	for (let j = 0; j < redoStack.length; j += 1) {
		const entry = redoStack[j];
		const steps = redoStack.length - j;
		makeRow({
			label: `${t(entry.label)} — ${t('historyUndone').toLowerCase()}`,
			time: formatHistoryTime(entry.time),
			undone: true,
			onClick: () => historyJumpForward(steps)
		});
	}
	// Actions effectuées, la plus récente en haut. L'entrée du haut correspond
	// à l'état ACTUEL du document (surlignée). Cliquer une entrée plus basse
	// annule tout ce qui la suit.
	for (let i = undoStack.length - 1; i >= 0; i -= 1) {
		const entry = undoStack[i];
		const steps = undoStack.length - 1 - i;
		makeRow({
			label: t(entry.label),
			time: formatHistoryTime(entry.time),
			current: steps === 0,
			onClick: steps > 0 ? () => historyJumpBack(steps) : null
		});
	}
	// État d'origine : uniquement si aucune éviction n'a tronqué l'historique
	// (sinon l'entrée la plus ancienne n'est plus le document initial).
	if (!tab._historyEvicted) {
		makeRow({
			label: t('historyOriginal'),
			time: '',
			current: !undoStack.length,
			onClick: undoStack.length ? () => historyJumpBack(undoStack.length) : null
		});
	}
}

function refreshHistoryPanelIfVisible() {
	if (state.activeDrawer !== 'history') return;
	if (!elements.drawer || elements.drawer.classList.contains('hidden')) return;
	renderHistoryPanel();
}

const _thumbnailCache = new Map();

function refreshPagesDrawerIfOpen() {
	if (state.activeDrawer !== 'pages') return;
	if (!elements.drawer || elements.drawer.classList.contains('hidden')) return;
	void renderThumbnailsPanel();
}

// Réordonnancement des vignettes : même mécanique que la barre d'onglets
// (onTabPointerDown), éprouvée dans WKWebView. La ligne saisie est déplacée
// DANS le DOM au fil du pointeur — pas de position fixe (le tiroir a un
// backdrop-filter, donc un `fixed` serait recalé sur lui), pas de
// setPointerCapture (WebKit cesse de livrer les événements à un élément passé
// en pointer-events: none). L'ordre final se lit simplement dans le DOM.
const THUMB_DRAG_THRESHOLD_PX = 5;

function thumbOrderFromDom(grid) {
	return [...grid.querySelectorAll('.thumb')].map((el) => Number(el.dataset.page));
}

function placeDraggedThumb(grid, row, clientY) {
	const siblings = [...grid.querySelectorAll('.thumb:not(.is-dragging)')];
	const next = siblings.find((sibling) => {
		const rect = sibling.getBoundingClientRect();
		return clientY < rect.top + rect.height / 2;
	});
	if (next) {
		if (next.previousElementSibling !== row) grid.insertBefore(row, next);
	} else if (grid.lastElementChild !== row) {
		grid.append(row);
	}
}

function beginThumbPointerDrag(event, row, pageNumber, hooks) {
	const grid = elements.thumbsGrid;
	if (!grid) return;
	const startX = event.clientX;
	const startY = event.clientY;
	const initialOrder = thumbOrderFromDom(grid);
	let dragging = false;

	const stop = () => {
		window.removeEventListener('pointermove', onMove);
		window.removeEventListener('pointerup', onUp);
		window.removeEventListener('pointercancel', onUp);
	};

	const onMove = (moveEvent) => {
		if (!dragging) {
			const distance = Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY);
			if (distance < THUMB_DRAG_THRESHOLD_PX) return;
			dragging = true;
			hooks?.start?.();
			row.classList.add('is-dragging');
			document.body.classList.add('is-thumb-dragging');
		}
		moveEvent.preventDefault();
		placeDraggedThumb(grid, row, moveEvent.clientY);
	};

	const onUp = () => {
		stop();
		if (!dragging) return;
		row.classList.remove('is-dragging');
		document.body.classList.remove('is-thumb-dragging');
		hooks?.end?.();
		const order = thumbOrderFromDom(grid);
		const total = state.pdf?.numPages || 0;
		if (order.length !== total || new Set(order).size !== total) return;
		if (order.every((page, index) => page === initialOrder[index])) return;
		void handleReorderPages(order, order.indexOf(pageNumber) + 1);
	};

	window.addEventListener('pointermove', onMove);
	window.addEventListener('pointerup', onUp);
	window.addEventListener('pointercancel', onUp);
}

function createThumbAction(className, label, content, onClick) {
	const button = document.createElement('button');
	button.type = 'button';
	button.className = className;
	button.title = label;
	button.setAttribute('aria-label', label);
	button.draggable = false;
	if (typeof content === 'string' && content.startsWith('<svg')) button.innerHTML = content;
	else button.textContent = content;
	button.addEventListener('pointerdown', (event) => event.stopPropagation());
	button.addEventListener('click', (event) => {
		event.preventDefault();
		event.stopPropagation();
		onClick();
	});
	return button;
}

async function renderThumbnailsPanel() {
	if (!elements.thumbsGrid) return;
	elements.thumbsGrid.innerHTML = '';
	if (!state.pdf) return;
	const fingerprint = state.fingerprint || 'unknown';
	const canDelete = state.pdf.numPages > 1;
	let didDrag = false;

	for (let pageNumber = 1; pageNumber <= state.pdf.numPages; pageNumber += 1) {
		const row = document.createElement('article');
		row.className = 'thumb';
		row.dataset.page = String(pageNumber);
		if (pageNumber === state.page) row.classList.add('active');

		const grip = document.createElement('span');
		grip.className = 'thumb-grip';
		grip.innerHTML = svgIcon('grip');
		grip.title = t('dragToReorder');

		const preview = document.createElement('div');
		preview.className = 'thumb-preview';
		const canvas = document.createElement('canvas');
		preview.append(canvas);

		const label = document.createElement('span');
		label.className = 'thumb-label';
		label.textContent = String(pageNumber);

		const actions = document.createElement('div');
		actions.className = 'thumb-actions';
		actions.append(
			createThumbAction('thumb-action', t('rotatePageLeft'), svgIcon('rotateCcw'), () => {
				void handleRotatePage(pageNumber, -90);
			}),
			createThumbAction('thumb-action', t('rotatePageRight'), svgIcon('rotate'), () => {
				void handleRotatePage(pageNumber, 90);
			})
		);
		const trash = createThumbAction(
			'thumb-action thumb-action-danger',
			t('deleteThisPage'),
			svgIcon('trash'),
			() => {
				void handleDeletePage(pageNumber);
			}
		);
		trash.disabled = !canDelete;
		actions.append(trash);

		const selectPage = () => {
			if (didDrag) return;
			goToPage(pageNumber);
			elements.thumbsGrid.querySelectorAll('.thumb.active').forEach((el) => el.classList.remove('active'));
			row.classList.add('active');
		};
		preview.addEventListener('click', selectPage);
		row.addEventListener('click', (event) => {
			if (event.target.closest('.thumb-action')) return;
			selectPage();
		});
		row.addEventListener('pointerdown', (event) => {
			if (event.button !== 0) return;
			if (event.target.closest('.thumb-action')) return;
			beginThumbPointerDrag(event, row, pageNumber, {
				start: () => {
					didDrag = true;
				},
				end: () => {
					window.setTimeout(() => {
						didDrag = false;
					}, 0);
				}
			});
		});

		row.append(grip, preview, label, actions);
		elements.thumbsGrid.append(row);

		const key = `${fingerprint}:${pageNumber}`;
		// Rotation encore en cours d'écriture : la vignette neuve reprend l'aperçu CSS.
		const restorePreview = () =>
			applyThumbnailRotationPreview(pageNumber, getPageData(pageNumber)?._thumbPendingTurn || 0);
		if (_thumbnailCache.has(key)) {
			const dataUrl = _thumbnailCache.get(key);
			const img = new Image();
			img.onload = () => {
				const ctx = canvas.getContext('2d');
				canvas.width = img.naturalWidth;
				canvas.height = img.naturalHeight;
				ctx?.drawImage(img, 0, 0);
				restorePreview();
			};
			img.src = dataUrl;
		} else {
			void renderThumbnailInto(pageNumber, canvas, key).then(restorePreview);
		}
	}
}

function thumbnailCanvasFor(pageNumber) {
	return elements.thumbsGrid?.querySelector(`.thumb[data-page="${pageNumber}"] canvas`) || null;
}

// Pendant de applyRotationPreview côté tiroir : la vignette tourne en CSS dans
// son emprise (mise à l'échelle pour qu'un quart de tour reste dans la colonne).
function applyThumbnailRotationPreview(pageNumber, pendingTurn) {
	const canvas = thumbnailCanvasFor(pageNumber);
	if (!canvas) return;
	const turn = (((pendingTurn || 0) % 360) + 360) % 360;
	if (!turn) {
		canvas.style.transform = '';
		return;
	}
	// Dimensions de mise en page (offset*), insensibles à la transformation déjà
	// appliquée. La case est un carré : un quart de tour A4 a scale ≈ 1
	// (même taille portrait / paysage). On ne plafonne pas à 1 pour les
	// pages hors A4 qui doivent encore tenir dans la case.
	const swapsAxes = turn === 90 || turn === 270;
	const width = canvas.offsetWidth;
	const height = canvas.offsetHeight;
	const box = canvas.parentElement;
	const fit =
		swapsAxes && box
			? Math.min(box.clientWidth / Math.max(1, height), box.clientHeight / Math.max(1, width))
			: 1;
	canvas.style.transform = `rotate(${turn}deg) scale(${fit})`;
}

// Re-rend UNE vignette dans son canvas existant (pas de reconstruction de la
// grille, donc pas de clignotement des autres lignes). `settledTurn` est le
// quart de tour que la vignette simulait en CSS et que son nouveau contenu
// intègre désormais : on le retire au moment exact où l'on peint, jamais avant.
async function refreshThumbnail(pageNumber, settledTurn = 0) {
	const data = getPageData(pageNumber);
	const canvas = thumbnailCanvasFor(pageNumber);
	const key = `${state.fingerprint || 'unknown'}:${pageNumber}`;
	_thumbnailCache.delete(key);
	let staging = null;
	if (canvas && state.pdf) {
		try {
			// Rendu hors écran puis copie d'un bloc : la vignette ne passe jamais
			// par un canvas vide entre l'ancien et le nouveau contenu.
			staging = document.createElement('canvas');
			await renderThumbnailInto(pageNumber, staging, key);
		} catch (error) {
			console.warn('Thumbnail refresh failed', error);
			staging = null;
		}
	}
	if (staging && thumbnailCanvasFor(pageNumber) === canvas) {
		canvas.width = staging.width;
		canvas.height = staging.height;
		canvas.getContext('2d')?.drawImage(staging, 0, 0);
	}
	if (data) {
		data._thumbPendingTurn = (data._thumbPendingTurn || 0) - settledTurn;
		applyThumbnailRotationPreview(pageNumber, data._thumbPendingTurn);
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
		await page.render({
			canvasContext: ctx,
			viewport: thumbViewport,
			annotationStorage: state.pdf.annotationStorage
		}).promise;
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
		fields = await collectFormFields();
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
	_formsPanelFields = new Map(fields.map((field) => [field.name, field]));
	const isFr = currentLocale() === 'fr';

	for (const field of fields) {
		const row = document.createElement(
			field.kind === 'image' || field.kind === 'signature' ? 'div' : 'label'
		);
		row.className = 'forms-field';
		row.dataset.name = field.name;
		row.dataset.kind = field.kind;

		const labelSpan = document.createElement('span');
		labelSpan.className = 'forms-field-label';
		labelSpan.textContent = field.name;
		labelSpan.title = field.name;
		row.append(labelSpan);

		const value = formFieldValue(field);
		if (field.kind === 'text' || field.kind === 'textarea') {
			const input = document.createElement(field.kind === 'textarea' ? 'textarea' : 'input');
			if (field.kind === 'text') input.type = 'text';
			else input.rows = 3;
			input.className = 'forms-field-input';
			input.value = String(value ?? '');
			input.disabled = field.readOnly;
			input.addEventListener('input', () => setFormFieldValue(field, input.value));
			row.append(input);
		} else if (field.kind === 'date') {
			const input = document.createElement('input');
			input.type = 'date';
			input.className = 'forms-field-input';
			input.value = dateToIso(String(value ?? ''), field.dateFormat);
			input.disabled = field.readOnly;
			input.addEventListener('change', () =>
				setFormFieldValue(field, isoToDate(input.value, field.dateFormat))
			);
			row.append(input);
		} else if (field.kind === 'checkbox') {
			const input = document.createElement('input');
			input.type = 'checkbox';
			input.className = 'forms-field-checkbox';
			input.checked = Boolean(value);
			input.disabled = field.readOnly;
			input.addEventListener('change', () => setFormFieldValue(field, input.checked));
			row.classList.add('forms-field--checkbox');
			row.append(input);
		} else if (field.kind === 'radio') {
			const select = document.createElement('select');
			select.className = 'forms-field-input';
			select.disabled = field.readOnly;
			const empty = document.createElement('option');
			empty.value = '';
			empty.textContent = '—';
			select.append(empty);
			const seen = new Set();
			for (const widget of field.widgets) {
				const exportValue = widget.buttonValue;
				if (!exportValue || seen.has(exportValue)) continue;
				seen.add(exportValue);
				const opt = document.createElement('option');
				opt.value = exportValue;
				opt.textContent = exportValue;
				if (exportValue === value) opt.selected = true;
				select.append(opt);
			}
			select.addEventListener('change', () => setFormFieldValue(field, select.value));
			row.append(select);
		} else if (field.kind === 'choice') {
			const select = document.createElement('select');
			select.className = 'forms-field-input';
			select.disabled = field.readOnly;
			const empty = document.createElement('option');
			empty.value = '';
			empty.textContent = '—';
			select.append(empty);
			for (const option of field.options) {
				const opt = document.createElement('option');
				opt.value = option.exportValue;
				opt.textContent = option.displayValue || option.exportValue;
				select.append(opt);
			}
			select.value = Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
			select.addEventListener('change', () => setFormFieldValue(field, select.value));
			row.append(select);
		} else if (field.kind === 'image') {
			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'forms-field-image';
			button.textContent = isFr ? 'Choisir une image…' : 'Choose an image…';
			button.addEventListener('click', () => void handleFormImageButton(field.name));
			row.append(button);
		} else if (field.kind === 'signature') {
			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'forms-field-image';
			button.textContent = isFr ? 'Signer…' : 'Sign…';
			button.addEventListener('click', () => void handleFormSignatureField(field.name));
			row.append(button);
		}

		elements.formsFields.append(row);
	}

	elements.formsApply.disabled = false;
}

// Bouton « Remplir et enregistrer » : la saisie est déjà dans le document
// (bake), il ne reste qu'à l'enregistrer.
async function handleFillForms() {
	if (!state.pdf) return;
	try {
		setStatus(t('formsProcessing'));
		await bakeFormValues();
		const saved = await handleSaveDocument();
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
	if (elements.settingAutoSave) elements.settingAutoSave.checked = state.settings.autoSave !== false;
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
	state.settings.autoSave = elements.settingAutoSave ? elements.settingAutoSave.checked : true;
	state.settings.fitWidth = elements.settingFitWidth.checked;
	state.settings.showTools = elements.settingShowTools.checked;
	state.settings.showRail = elements.settingShowRail.checked;
	state.settings.showPageNotes = elements.settingShowNotes.checked;
	state.settings.showAlignmentGuides = elements.settingShowGuides.checked;
	state.settings.highlightColor = elements.settingHighlightColor.value;
	state.settings.identityName = elements.settingIdentityName.value.trim();
	state.settings.identityEmail = elements.settingIdentityEmail.value.trim();
	saveSettings();
	syncNativeLanguage();
	localizeUi();
	updateUi();
	renderPageNotes();
	renderHome();
	if (state.pdf && state.settings.pageLayout !== previousLayout) {
		void transitionPageLayout();
	} else if (state.pdf && state.settings.fitWidth) {
		state.fitMode = 'width';
		void fitPageWidth();
	} else if (state.pdf && !state.settings.fitWidth && state.fitMode === 'width') {
		state.fitMode = null;
		updateUi();
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
	_sessionRestoreReady = restoreOpenSession();
	tauriListen('alto-open-settings', openSettings);
	tauriListen('alto-open-pdf', () => void openViaNativeDialog());
	tauriListen('alto-export-notes', exportAnnotations);
	tauriListen('alto-export-edited-pdf', () => void exportEditedPdf());
	tauriListen('alto-save-copy', () => void handleSaveDocument());
	tauriListen('alto-save-as', () => void handleSaveAsDocument());
	tauriListen('alto-modify-pdf', () => toggleEditMode(true));
	tauriListen('alto-add-text', () => activateAddTextTool());
	tauriListen('alto-add-image', () => void activateAddImageTool());
	tauriListen('alto-add-signature', () => activateAddSignatureTool());
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
	tauriListen('alto-share-pdf', () => openSharePopover());
	tauriListen('alto-request-quit', () => void requestQuitApp());
	tauriListen('slate-update-available', (event) => {
		const info = event?.payload;
		if (info?.version) showUpdateToast(info);
	});
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
	tauriListen('alto-prepress', () => openPrepressPanel());
	tauriListen('alto-convert-colors', () => void openConvertColorsModal());
	tauriListen('alto-recent-files', () => handleShowRecent());
	tauriListen('alto-combine-files', () => void handleCombineFiles());
	tauriListen('alto-compress-pdf', () => void handleCompressPdf());
	tauriListen('alto-protect-pdf', () => void handleProtectPdf());
	tauriListen('alto-delete-page', () => void handleDeleteCurrentPage());
	tauriListen('alto-rotate-page-cw', () => void handleRotateCurrentPage(90));
	tauriListen('alto-rotate-page-ccw', () => void handleRotateCurrentPage(-90));
	tauriListen('alto-organize-pages', () => openDrawer('pages'));
	tauriListen('alto-open-files-available', () => {
		void _sessionRestoreReady.then(() => drainPendingOpenFiles());
	});
	tauriListen('alto-print-files-available', () => {
		void drainPendingPrintFiles();
	});
	// Fin du panneau d'impression (façon Acrobat) : on restaure la session.
	tauriListen('alto-print-finished', () => {
		const restore = state.printRestore;
		state.printRestore = null;
		if (!restore) return; // impression in-app : rien à restaurer
		if (restore.hadDocs) {
			// Des docs étaient ouverts → on réduit Slate (icône Dock), session intacte.
			void invokeCommand('hide_app');
		}
		// Aucun doc → on reste sur la home (aucun onglet n'a été ouvert).
	});

	void _sessionRestoreReady.then(() => drainPendingOpenFiles());
	void drainPendingPrintFiles();
	tauriListen('slate-merge-tab', (event) => {
		const payload = event?.payload;
		if (!payload?.bytes) return;
		const index = Number.isFinite(payload.relativeX)
			? tabInsertIndexFromClientX(payload.relativeX)
			: state.tabs.length;
		void applyDetachedPayload(payload, index);
	});
	tauriListen('slate-tab-drag-ended', (event) => {
		void onNativeTabDragEnded(event?.payload?.action || 'local');
	});

	void drainDetachedTab();
}

// Impression depuis le Finder : on ouvre chaque PDF empilé côté Rust, puis on
// lance directement la fenêtre d'impression (sans manipulation de l'app).
async function drainPendingPrintFiles() {
	try {
		const pending = await invokeCommand('take_pending_print_files');
		if (!Array.isArray(pending) || !pending.length) return;
		// Façon Acrobat : on n'ouvre PAS le PDF comme onglet (pas de pollution de
		// session). On mémorise l'état pour le restaurer après le panneau.
		state.printRestore = { hadDocs: state.tabs.length > 0 };
		for (const file of pending) {
			const fileName = file.fileName || file.file_name || 'document.pdf';
			const bytes = Array.from(new Uint8Array(file.bytes));
			await rememberRecentFile(file.path || '', fileName);
			// Panneau d'impression natif (dans Slate) directement sur les octets.
			await invokeCommand('print_pdf', { bytes });
		}
	} catch (error) {
		console.warn('drainPendingPrintFiles failed', error);
		state.printRestore = null;
	}
}

async function applyDetachedPayload(payload, insertIndex = null) {
	const fileName = payload.fileName || payload.file_name || 'document.pdf';
	const filePath = payload.filePath || payload.file_path || '';
	const bytes = new Uint8Array(payload.bytes);
	await openPdfFromBytes(bytes, fileName, { filePath, dedupe: false });
	const tab = currentTab();
	if (!tab) return;
	const annotations = Array.isArray(payload.annotations) ? payload.annotations : [];
	const editBlocks = Array.isArray(payload.editBlocks)
		? payload.editBlocks
		: Array.isArray(payload.edit_blocks)
			? payload.edit_blocks
			: [];
	tab.annotations = annotations;
	state.annotations = annotations.map((annotation) => ({ ...annotation }));
	tab.editBlocks = editBlocks;
	state.editBlocks = editBlocks.map((block) => ({ ...block }));
	tab.dirty = Boolean(payload.dirty);
	const page = Number(payload.page) || 1;
	if (state.pdf) {
		state.page = Math.min(Math.max(page, 1), state.pdf.numPages);
		tab.page = state.page;
	}
	if (Number.isFinite(insertIndex) && state.tabs.length > 1) {
		const from = state.tabs.findIndex((candidate) => candidate.id === tab.id);
		if (from >= 0) {
			const [moved] = state.tabs.splice(from, 1);
			const index = Math.max(0, Math.min(insertIndex, state.tabs.length));
			state.tabs.splice(index, 0, moved);
		}
	}
	renderTabs();
	updateUi();
	if (state.editBlocks.length) renderEditBlocks();
	await mountPagesStack();
}

async function drainDetachedTab() {
	try {
		const payload = await invokeCommand('take_detached_tab');
		if (!payload?.bytes) return;
		await applyDetachedPayload(payload);
	} catch (error) {
		console.warn('drainDetachedTab failed', error);
	}
}

async function drainPendingOpenFiles() {
	try {
		const pending = await invokeCommand('take_pending_open_files');
		if (!Array.isArray(pending) || !pending.length) return;
		for (const file of pending) {
			try {
				const fileName = file.fileName || file.file_name || 'document.pdf';
				const bytes = new Uint8Array(file.bytes);
				await openPdfFromBytes(bytes, fileName, { filePath: file.path || '' });
				await rememberRecentFile(file.path || '', fileName);
			} catch (fileError) {
				console.warn('drainPendingOpenFiles: fichier ignoré', fileError);
			}
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
	closePrepressPanel();
	state.settings.showTools = true;
	elements.settingShowTools.checked = true;
	saveSettings();
	closeDrawer();
	updateUi();
}

function openPrepressPanel() {
	showToolsPanel();
	elements.toolsPanel?.classList.add('prepress-open');
	elements.prepressPanel?.classList.remove('hidden');
	if (elements.moreTools && elements.moreTools.classList.contains('hidden')) {
		elements.moreTools.classList.remove('hidden');
		if (elements.toggleMoreTools) {
			elements.toggleMoreTools.textContent = t('showLess');
		}
	}
}

function closePrepressPanel() {
	elements.toolsPanel?.classList.remove('prepress-open');
	elements.prepressPanel?.classList.add('hidden');
}

async function openConvertColorsModal() {
	if (!state.fileBytes) {
		setStatus(t('convertColorsNeedPdf'), 'error');
		return;
	}
	openPrepressPanel();
	const statusEl = elements.convertColorsProfileStatus;
	if (statusEl) {
		statusEl.textContent = 'Recherche du profil ICC…';
		statusEl.dataset.tone = '';
	}
	elements.convertColorsBackdrop?.classList.remove('hidden');
	elements.convertColorsModal?.classList.remove('hidden');
	try {
		const info = await invokeCommand('fogra39_profile_status');
		if (statusEl) {
			if (info) {
				statusEl.textContent = `Profil trouvé : ${info}`;
				statusEl.dataset.tone = 'ok';
				elements.convertColorsOk.disabled = false;
			} else {
				statusEl.textContent =
					'Profil Coated FOGRA39 introuvable. Installe Acrobat (profil Adobe) ou place ISOcoated_v2_eci.icc dans ~/Library/ColorSync/Profiles/.';
				statusEl.dataset.tone = 'error';
				elements.convertColorsOk.disabled = true;
			}
		}
	} catch (error) {
		if (statusEl) {
			statusEl.textContent = error instanceof Error ? error.message : String(error);
			statusEl.dataset.tone = 'error';
		}
		if (elements.convertColorsOk) elements.convertColorsOk.disabled = true;
	}
}

function closeConvertColorsModal() {
	elements.convertColorsBackdrop?.classList.add('hidden');
	elements.convertColorsModal?.classList.add('hidden');
	if (elements.convertColorsOk) elements.convertColorsOk.disabled = false;
}

async function applyConvertColorsFogra39() {
	if (!state.fileBytes) {
		setStatus(t('convertColorsNeedPdf'), 'error');
		return;
	}
	try {
		setStatus(t('convertColorsRunning'));
		if (elements.convertColorsOk) elements.convertColorsOk.disabled = true;
		const bytes = await invokeBytes('convert_pdf_colors_fogra39', {
			bytes: Array.from(state.fileBytes),
			iccPath: null
		});
		if (!bytes?.length) throw new Error('Conversion sans résultat.');
		state.fileBytes = bytes;
		const tab = currentTab();
		if (tab) tab.fileBytes = bytes;
		const loadingTask = pdfjsLib.getDocument(pdfDocumentOptions({ data: bytes.slice() }));
		const pdf = await loadingTask.promise;
		state.pdf = pdf;
		if (tab) tab.pdf = pdf;
		markDirty();
		invalidateAllPages();
		await renderCurrentPage();
		closeConvertColorsModal();
		setStatus(t('convertColorsDone'), 'info');
	} catch (error) {
		console.error(error);
		setStatus(error instanceof Error ? error.message : String(error), 'error');
		if (elements.convertColorsOk) elements.convertColorsOk.disabled = false;
	}
}

// ── Partage ───────────────────────────────────────────────────────────────

let _sharePathCache = null;

function isSharePopoverOpen() {
	return Boolean(elements.sharePopover && !elements.sharePopover.hidden);
}

function positionSharePopover() {
	const trigger = elements.shareButton;
	const pop = elements.sharePopover;
	if (!trigger || !pop) return;
	const rect = trigger.getBoundingClientRect();
	const width = Math.min(360, window.innerWidth - 24);
	pop.style.width = `${width}px`;
	let left = rect.right - width;
	left = Math.max(12, Math.min(left, window.innerWidth - width - 12));
	pop.style.left = `${Math.round(left)}px`;
	pop.style.top = `${Math.round(rect.bottom + 8)}px`;
}

function updateSharePopoverTitle() {
	if (!elements.sharePopoverTitle) return;
	const name = state.fileName || t('untitledPdf');
	elements.sharePopoverTitle.textContent = t('shareTitle', name);
}

function openSharePopover() {
	if (!state.pdf || !elements.sharePopover || !elements.shareButton) {
		setStatus(t('shareNoDocument'), 'error');
		return;
	}
	closeFontCombo();
	updateSharePopoverTitle();
	positionSharePopover();
	elements.sharePopover.hidden = false;
	elements.shareButton.setAttribute('aria-expanded', 'true');
	if (elements.shareInviteInput) {
		elements.shareInviteInput.value = '';
		requestAnimationFrame(() => elements.shareInviteInput.focus());
	}
}

function closeSharePopover() {
	if (!elements.sharePopover || elements.sharePopover.hidden) return;
	elements.sharePopover.hidden = true;
	elements.shareButton?.setAttribute('aria-expanded', 'false');
	_sharePathCache = null;
}

function toggleSharePopover() {
	if (isSharePopoverOpen()) {
		closeSharePopover();
	} else {
		openSharePopover();
	}
}

function parseShareInvitees(raw) {
	return (raw || '')
		.split(/[,;]+/)
		.map((part) => part.trim())
		.filter((part) => part.includes('@'));
}

function buildShareMessage(path) {
	const name = state.fileName || 'document.pdf';
	return currentLocale() === 'fr'
		? `Document PDF : ${name}\n\nFichier : ${path}\n\n(Ouvrez le Finder via Slate pour joindre le fichier.)`
		: `PDF document: ${name}\n\nFile: ${path}\n\n(Use Slate’s Finder reveal to attach the file.)`;
}

async function ensureShareablePath() {
	if (_sharePathCache) return _sharePathCache;
	if (!state.pdf || !state.fileBytes) return null;
	if (state.nativeTextDirty) await syncNativeDocumentBytes({ render: false });
	await bakeFormValues();
	const tab = currentTab();
	const tabDirty = Boolean(tab?.dirty);
	if (tab?.filePath && !tabDirty) {
		_sharePathCache = tab.filePath;
		return tab.filePath;
	}
	if (!tabDirty) {
		const recent = loadRecentFiles().find((item) => item.path && item.name === state.fileName);
		if (recent?.path) {
			_sharePathCache = recent.path;
			return recent.path;
		}
	}
	let bytes;
	if (tabDirty) {
		bytes = await exportEditedPdfBytes({ audit: false });
	} else {
		bytes =
			state.fileBytes instanceof Uint8Array
				? Array.from(state.fileBytes)
				: Array.from(new Uint8Array(state.fileBytes));
	}
	const path = await invokeCommand('prepare_share_pdf', {
		data: bytes,
		filename: state.fileName || 'document.pdf'
	});
	_sharePathCache = path;
	return path;
}

async function shareViaChannel(channel) {
	try {
		const path = await ensureShareablePath();
		if (!path) {
			setStatus(t('shareNoDocument'), 'error');
			return;
		}
		const name = state.fileName || 'document.pdf';
		const invitees = parseShareInvitees(elements.shareInviteInput?.value);
		const subject = encodeURIComponent(`PDF : ${name}`);
		const bodyText = buildShareMessage(path);
		const body = encodeURIComponent(bodyText);
		const to = encodeURIComponent(invitees.join(','));
		switch (channel) {
			case 'whatsapp': {
				await navigator.clipboard.writeText(path);
				await invokeCommand('open_external', {
					url: `https://wa.me/?text=${encodeURIComponent(`${name}\n${path}`)}`
				});
				setStatus(t('shareOpenedWhatsApp'));
				break;
			}
			case 'gmail': {
				let url = `https://mail.google.com/mail/?view=cm&fs=1&su=${subject}&body=${body}`;
				if (invitees.length) url += `&to=${to}`;
				await invokeCommand('open_external', { url });
				setStatus(t('shareOpenedGmail'));
				break;
			}
			case 'outlook': {
				const url = invitees.length
					? `https://outlook.office.com/mail/deeplink/compose?to=${to}&subject=${subject}&body=${body}`
					: `ms-outlook://compose?subject=${subject}&body=${body}`;
				await invokeCommand('open_external', { url });
				setStatus(t('shareOpenedOutlook'));
				break;
			}
			case 'teams': {
				await navigator.clipboard.writeText(bodyText);
				await invokeCommand('open_external', { url: 'https://teams.microsoft.com/v2/' });
				setStatus(t('shareOpenedTeams'));
				break;
			}
			case 'link': {
				await navigator.clipboard.writeText(path);
				setStatus(t('sharePathCopied'));
				break;
			}
			case 'email': {
				const mailto = invitees.length
					? `mailto:${invitees.join(',')}?subject=${subject}&body=${body}`
					: `mailto:?subject=${subject}&body=${body}`;
				await invokeCommand('open_external', { url: mailto });
				setStatus(t('shareOpenedEmail'));
				break;
			}
			default:
				return;
		}
		closeSharePopover();
	} catch (error) {
		console.warn('shareViaChannel failed', error);
		setStatus(t('shareFailed'), 'error');
	}
}

async function revealShareableFile() {
	try {
		const path = await ensureShareablePath();
		if (!path) {
			setStatus(t('shareNoDocument'), 'error');
			return;
		}
		await invokeCommand('reveal_file_in_folder', { path });
		setStatus(t('shareRevealed'));
		closeSharePopover();
	} catch (error) {
		console.warn('revealShareableFile failed', error);
		setStatus(t('shareFailed'), 'error');
	}
}

function bindShareUi() {
	elements.shareButton?.addEventListener('click', (event) => {
		event.stopPropagation();
		toggleSharePopover();
	});
	elements.shareRevealButton?.addEventListener('click', () => void revealShareableFile());
	document.querySelectorAll('[data-share-channel]').forEach((button) => {
		button.addEventListener('click', () => {
			void shareViaChannel(button.dataset.shareChannel);
		});
	});
	document.addEventListener('click', (event) => {
		if (!isSharePopoverOpen()) return;
		const target = event.target;
		if (elements.sharePopover?.contains(target) || elements.shareButton?.contains(target)) return;
		closeSharePopover();
	});
	window.addEventListener('resize', () => {
		if (isSharePopoverOpen()) positionSharePopover();
	});
	document.addEventListener('keydown', (event) => {
		if (event.key === 'Escape' && isSharePopoverOpen()) closeSharePopover();
	});
}

// ── Garde-fou fermeture de l'application ─────────────────────────────────
// La croix rouge (et Cmd+Q) ne doit JAMAIS fermer l'application avec des
// modifications non enregistrées : on réutilise la modale « Enregistrer les
// modifications ? » onglet par onglet, puis on détruit la fenêtre.

function destroyAppWindow() {
	const win = window.__TAURI__?.window?.getCurrentWindow?.();
	if (win?.destroy) {
		void win.destroy();
	} else if (win?.close) {
		void win.close();
	}
}

async function requestCloseWindow() {
	persistCurrentTabState();
	await flushAutosave({ reason: 'exit', allTabs: true });
	const dirty = state.tabs.find((tab) => tab.dirty && !(tab.autoSave && tab.filePath));
	if (!dirty) {
		destroyAppWindow();
		return;
	}
	state.pendingCloseWindow = true;
	state.pendingQuit = false;
	await requestCloseTab(dirty.id);
}

async function requestQuitApp() {
	persistCurrentTabState();
	await flushAutosave({ reason: 'exit', allTabs: true });
	const dirty = state.tabs.find((tab) => tab.dirty && !(tab.autoSave && tab.filePath));
	if (!dirty) {
		try {
			await invokeCommand('quit_application');
		} catch (_err) {
			destroyAppWindow();
		}
		return;
	}
	state.pendingQuit = true;
	state.pendingCloseWindow = false;
	await requestCloseTab(dirty.id);
}

// Après chaque onglet dirty résolu : continuer à fermer la fenêtre, ou quitter.
async function continuePendingQuitIfNeeded() {
	if (!state.pendingQuit && !state.pendingCloseWindow) return;
	const dirty = state.tabs.find((tab) => tab.dirty);
	if (dirty) {
		await requestCloseTab(dirty.id);
		return;
	}
	if (state.pendingQuit) {
		try {
			await invokeCommand('quit_application');
		} catch (_err) {
			destroyAppWindow();
		}
		return;
	}
	destroyAppWindow();
}

function bindWindowCloseGuard() {
	const getCurrentWindow = window.__TAURI__?.window?.getCurrentWindow;
	if (!getCurrentWindow) return;
	const win = getCurrentWindow();
	if (!win?.onCloseRequested) return;
	void win.onCloseRequested((event) => {
		persistCurrentTabState();
		if (!state.tabs.some((tab) => tab.dirty)) return;
		event.preventDefault();
		void requestCloseWindow();
	});
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
		persistOpenSession();
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
		persistOpenSession();
		return;
	}

	renderTabs();
	persistOpenSession();
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
	// Fermeture avec enregistrement : même logique que ⌘S (écrase le base
	// s'il existe ; sinon dialogue une fois).
	if (userName.trim() && !tab.filePath) {
		state.fileName = `${userName.trim().replace(/\.pdf$/i, '')}.pdf`;
	}
	const saved = await handleSaveDocument();
	if (!saved) {
		return;
	}
	hideSaveChangesModal();
	await closeTab(tab.id);
	if (previousActiveTabId && state.tabs.some((candidate) => candidate.id === previousActiveTabId)) {
		await activateTab(previousActiveTabId);
	}
	await continuePendingQuitIfNeeded();
}

async function discardAndClosePendingTab() {
	const tabId = state.pendingCloseTabId;
	hideSaveChangesModal();
	if (tabId) {
		await closeTab(tabId);
	}
	await continuePendingQuitIfNeeded();
}

function cancelPendingTabClose() {
	state.pendingQuit = false;
	state.pendingCloseWindow = false;
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
	// Zoom manuel → on quitte le fit courant (plus de reflow au resize),
	// sans écraser le réglage « ouvrir en largeur page ».
	state.fitMode = null;
	state.zoom = Math.max(0.15, Math.min(2.75, Number((state.zoom + delta).toFixed(2))));
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
elements.zoomOut.addEventListener('click', () => zoomBy(-0.1));
elements.zoomIn.addEventListener('click', () => zoomBy(0.1));
elements.railZoomOut.addEventListener('click', () => zoomBy(-0.1));
elements.railZoomIn.addEventListener('click', () => zoomBy(0.1));
elements.fitWidth.addEventListener('click', () => {
	state.fitMode = 'width';
	state.settings.fitWidth = true;
	saveSettings();
	void fitPageWidth();
});
elements.railFitWidth.addEventListener('click', () => {
	// Bouton « ajuster » du rail : on montre la PAGE ENTIÈRE (largeur ET hauteur),
	// déterministe → cliquer plusieurs fois donne toujours le même zoom (stable).
	// Le bouton passe en état actif et le % se met à jour (via updateUi).
	state.fitMode = 'page';
	void fitSinglePageToViewport();
});

// Responsive (style Acrobat) : la page suit la fenêtre tant qu'un mode fit est
// actif. Debounce pour éviter un re-render à chaque pixel du drag.
//
// On n'observe PAS la zone de lecture : son `clientWidth` dépend de la scrollbar,
// qui apparaît/disparaît selon le zoom → un ResizeObserver s'auto-déclenche en
// boucle et fait se chevaucher deux relayouts.
let _resizeFitToken = 0;
let _fitInFlight = false;
let _fitRequestedAgain = false;

async function runViewportFit() {
	if (_fitInFlight) {
		_fitRequestedAgain = true;
		return;
	}
	_fitInFlight = true;
	try {
		do {
			_fitRequestedAgain = false;
			if (state.settings.pageLayout === 'single' || state.fitMode === 'page') {
				await fitSinglePageToViewport();
			} else if (state.fitMode === 'width') {
				await fitPageWidth();
			}
		} while (_fitRequestedAgain);
	} finally {
		_fitInFlight = false;
	}
}

function scheduleViewportFit() {
	if (!state.pdf) return;
	if (_resizeFitToken) clearTimeout(_resizeFitToken);
	_resizeFitToken = window.setTimeout(() => {
		_resizeFitToken = 0;
		void runViewportFit();
	}, 140);
}
window.addEventListener('resize', scheduleViewportFit, { passive: true });
elements.downloadOriginal.addEventListener('click', downloadOriginal);
elements.exportAnnotations.addEventListener('click', exportAnnotations);
elements.exportEditedPdf.addEventListener('click', () => void exportEditedPdf());
elements.saveButton?.addEventListener('click', () => void handleSaveDocument());
elements.toolbarAutoSave?.addEventListener('change', applyToolbarAutoSave);
elements.highlightButton.addEventListener('click', () => createAnnotation('highlight'));
elements.commentButton.addEventListener('click', () => createAnnotation('comment'));
elements.modifyTab.addEventListener('click', () => toggleEditMode());
elements.modifyTool.addEventListener('click', () => toggleEditMode(true));
elements.exitEditMode.addEventListener('click', exitEditMode);
elements.editSelectTool?.addEventListener('click', () => setEditTool('select'));
elements.addTextTool?.addEventListener('click', activateAddTextTool);
elements.addImageTool?.addEventListener('click', () => void activateAddImageTool());
elements.addSignatureTool?.addEventListener('click', activateAddSignatureTool);
elements.addHeaderFooterTool?.addEventListener('click', () => void activateHeaderFooterTool());
elements.modifierMoreTools?.addEventListener('click', () => {
	const panel = elements.modifierMoreContent;
	const trigger = elements.modifierMoreTools;
	if (!panel || !trigger) return;
	const open = panel.classList.toggle('hidden') === false;
	trigger.setAttribute('aria-expanded', String(open));
	trigger.textContent = open
		? currentLocale() === 'fr'
			? 'Moins'
			: 'Less'
		: currentLocale() === 'fr'
			? 'Plus'
			: 'More';
});
elements.scanEditBlocks.addEventListener('click', scanEditableBlocks);
elements.ocrCurrentPage.addEventListener('click', () => runOcrForCurrentPage(true));
// ── Sélection au rectangle (marquee) ────────────────────────────────────────
// En mode édition, un drag sur une zone vide d'une page dessine un rectangle bleu.
// Au relâcher, tous les blocs de cette page que le rectangle touche sont sélectionnés
// (puis Suppr les efface tous).
let suppressNextPageClick = false;

elements.pagesStack.addEventListener('pointerdown', (event) => {
	if (!state.editMode || state.editTool === 'add-text' || event.button !== 0 || state.editingBlockId) return;
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
	if (state.editMode && state.editTool === 'add-text') {
		const layer = event.target.closest?.('.edit-layer');
		if (layer) {
			event.preventDefault();
			event.stopPropagation();
			const pageNumber = Number(layer.dataset.page);
			const data = getPageData(pageNumber);
			if (!data) return;
			const rect = layer.getBoundingClientRect();
			const x = (event.clientX - rect.left) * (data.viewportWidth / Math.max(1, rect.width));
			const y = (event.clientY - rect.top) * (data.viewportHeight / Math.max(1, rect.height));
			createAddedTextBlock(pageNumber, x, y);
		}
		return;
	}
	// Un marquee vient d'aboutir : on ne traite pas le clic de fin de drag
	// (sinon il viderait la sélection qu'on vient de faire).
	if (suppressNextPageClick) {
		suppressNextPageClick = false;
		return;
	}
	if (event.target.closest('.edit-block') || event.target.closest('.sign-placement')) return;
	// Clic sur une poignée/zone de redimensionnement : géré par le pointerdown
	// de la zone (resize ou relais sélection/édition) — ne pas vider la sélection.
	if (event.target.closest('.text-resize-zone, .block-resize-handle, .edit-block-text-handle')) return;
	// Clic TOLÉRANT : au repos la boîte d'un bloc texte est resserrée sur l'encre
	// (quelques px de haut). Un clic sur le fond de page à ±8px de la GÉOMÉTRIE
	// LOGIQUE d'un bloc est routé vers ce bloc (sélection / double-clic édition),
	// au lieu d'exiger de viser l'encre au pixel près.
	if (state.editMode && !state.editingBlockId && event.target.classList?.contains('edit-layer')) {
		const layer = event.target;
		const pageNumber = Number(layer.dataset.page);
		const rect = layer.getBoundingClientRect();
		const px = event.clientX - rect.left;
		const py = event.clientY - rect.top;
		const CLICK_TOLERANCE = 8;
		let nearest = null;
		let nearestDist = Infinity;
		for (const block of state.editBlocks) {
			if (block.page !== pageNumber || block.hidden) continue;
			const bw = Math.max(block.width, 1);
			const bh = Math.max(block.height, 1);
			const dx = Math.max(block.x - px, px - (block.x + bw), 0);
			const dy = Math.max(block.y - py, py - (block.y + bh), 0);
			if (dx > CLICK_TOLERANCE || dy > CLICK_TOLERANCE) continue;
			const dist = dx * dx + dy * dy;
			if (dist < nearestDist) {
				nearestDist = dist;
				nearest = block;
			}
		}
		if (nearest) {
			handleIdleBlockClick(nearest, event);
			return;
		}
	}
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
document.addEventListener('keydown', (event) => {
	if (event.key !== 'Escape' || state.editTool !== 'add-text') return;
	event.preventDefault();
	setEditTool('select');
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

		// En édition « glyphe » (texte PDF non encore ré-écrit) : Backspace/Delete
		// suppriment dans block.text à l'offset du caret NATIF (ou la sélection),
		// puis le bloc bascule en édition texte. Tout part de ce que l'utilisateur
		// voit dans l'éditable → aucun décalage.
		const block = state.editBlocks.find((candidate) => candidate.id === state.editingBlockId);
		if (!block || !Array.isArray(block.pdfChars) || !block.pdfChars.length) return;
		// Bloc converti en édition texte HTML classique : le caret natif gère
		// Backspace/Delete. Un bloc COMPOSITE (glyphes préservés) reste piloté ici :
		// chaque suppression passe par commitGlyphEdit → composite re-rendu.
		if (isBlockTextEdited(block) && !isGlyphCompositeBlock(block)) return;
		if (isFormField) return;
		const element = elements.pagesStack.querySelector(
			`.edit-block.editing[data-block-id="${block.id}"]`
		);
		if (!element) return;

		event.preventDefault();
		event.stopPropagation();

		const sel = selectionTextRange(element);
		if (sel) {
			commitGlyphEdit(block, block.text.slice(0, sel.start) + block.text.slice(sel.end), sel.start);
			return;
		}
		const off = caretTextOffset(element);
		if (off == null) return;
		if (event.key === 'Backspace') {
			if (off <= 0) return;
			// Suppression EN FIN : on masque le dernier glyphe natif (zéro reflow) au
			// lieu de réécrire en HTML avec une police de substitution. Réservé aux
			// blocs VIERGES *sans* édition native possible : quand le moteur peut
			// éditer le document directement, on supprime POUR DE VRAI (pas de
			// masquage local, qui rendrait le bloc inéligible au natif ensuite).
			if (
				!isBlockTextEdited(block) &&
				!nativeTextEditEligible(block) &&
				off === (block.text || '').length &&
				trimLastVisibleGlyph(block)
			) {
				return;
			}
			commitGlyphEdit(block, block.text.slice(0, off - 1) + block.text.slice(off), off - 1);
		} else {
			if (off >= block.text.length) return;
			commitGlyphEdit(block, block.text.slice(0, off) + block.text.slice(off + 1), off);
		}
	},
	true
);
// Flèches du clavier : décalent le(s) bloc(s) ou la signature sélectionné(s) quand on
// n'est PAS en édition de texte (sinon les flèches doivent piloter le caret natif).
// 1px par appui, 10px avec Shift. L'historique est groupé par rafale (débounce) pour
// qu'une série de petits décalages ne sature pas la pile undo.
let _nudgeSnapshot = null;
let _nudgeCommitTimer = null;
function scheduleNudgeCommit() {
	if (_nudgeCommitTimer) clearTimeout(_nudgeCommitTimer);
	_nudgeCommitTimer = setTimeout(() => {
		const movedPages = new Set();
		for (const block of state.editBlocks) {
			if (block._dragOriginX !== undefined || block._dragOriginY !== undefined) {
				movedPages.add(block.page);
			}
			delete block._dragOriginX;
			delete block._dragOriginY;
			delete block._dragVisualLeft;
			delete block._dragVisualTop;
		}
		// Rendu final ciblé, comme au pointerup d'un drag : les blocs montés
		// passent par le fast path (transform + classes uniquement, zéro
		// re-rasterisation), et les poignées/badges sont RECRÉÉS À LA BONNE
		// POSITION — le simple `display:''` d'avant les réaffichait à l'ancienne
		// place après un déplacement clavier.
		for (const page of movedPages) renderEditBlocksForPage(page);
		for (const el of document.querySelectorAll(
			'.block-resize-handle, .text-resize-zone, .edit-block-badge, .edit-block-text-handle, .glyph-composite-artifact, .font-warning-badge'
		)) {
			el.style.display = '';
		}
		if (_nudgeSnapshot) {
			commitSnapshot(_nudgeSnapshot, 'histBlockMove');
			_nudgeSnapshot = null;
		}
		_nudgeCommitTimer = null;
	}, 400);
}
function nudgeSelection(dx, dy) {
	// Bloc(s) sélectionné(s).
	const ids = new Set(state.selectedBlockIds || []);
	if (state.selectedBlockId) ids.add(state.selectedBlockId);
	const hasBlocks = state.editBlocks.some((block) => ids.has(block.id) && !block.hidden);
	if (hasBlocks) {
		if (!_nudgeSnapshot) {
			_nudgeSnapshot = captureEditableSnapshot();
			for (const id of ids) {
				const b = state.editBlocks.find((x) => x.id === id);
				if (b && !b.hidden) {
					b._dragOriginX = b.x;
					b._dragOriginY = b.y;
				}
			}
		}
		if (moveBlocks(ids, dx, dy, { visualOnly: true })) {
			updateSelectedEditField();
			markDirty();
			scheduleNudgeCommit();
		}
		return true;
	}

	// Signature sélectionnée (modèle fractionnaire).
	if (state.selectedSignatureId) {
		const placement = state.signaturePlacements.find((p) => p.id === state.selectedSignatureId);
		if (!placement) return false;
		const box = document.querySelector(`.sign-placement[data-id="${placement.id}"]`);
		const rect = box?.parentElement?.getBoundingClientRect();
		if (!rect || !rect.width || !rect.height) return false;
		if (!_nudgeSnapshot) _nudgeSnapshot = captureEditableSnapshot();
		const nextXFrac = Math.max(0, Math.min(1 - placement.wFrac, placement.xFrac + dx / rect.width));
		const nextYFrac = Math.max(0, Math.min(1 - placement.hFrac, placement.yFrac + dy / rect.height));
		if (nextXFrac !== placement.xFrac || nextYFrac !== placement.yFrac) {
			placement.xFrac = nextXFrac;
			placement.yFrac = nextYFrac;
			renderSignaturePlacementsForPage(placement.page);
			selectSignature(placement.id);
			persistSignaturePlacements();
			markDirty();
			scheduleNudgeCommit();
		}
		return true;
	}

	return false;
}
document.addEventListener('keydown', (event) => {
	if (event.metaKey || event.ctrlKey || event.altKey) return;
	let dx = 0;
	let dy = 0;
	if (event.key === 'ArrowLeft') dx = -1;
	else if (event.key === 'ArrowRight') dx = 1;
	else if (event.key === 'ArrowUp') dy = -1;
	else if (event.key === 'ArrowDown') dy = 1;
	else return;

	if (!state.editMode) return;
	// En édition de texte inline : les flèches déplacent le caret, on ne touche pas.
	if (state.editingBlockId) return;

	const target = event.target;
	const isFormField =
		target &&
		(target.tagName === 'INPUT' ||
			target.tagName === 'TEXTAREA' ||
			target.isContentEditable);
	if (isFormField) return;

	const step = event.shiftKey ? 10 : 1;
	if (nudgeSelection(dx * step, dy * step)) {
		event.preventDefault();
		event.stopPropagation();
	}
});
document.addEventListener('keydown', (event) => {
	const key = event.key.toLowerCase();
	const meta = event.metaKey || event.ctrlKey;
	if (!meta) return;
	// ⌘P / Ctrl+P : on imprime TOUJOURS le PDF (jamais l'impression native du
	// WebView, qui imprimerait l'UI de l'app). Prioritaire, quel que soit le focus.
	if (key === 'p' && !event.shiftKey && !event.altKey) {
		event.preventDefault();
		if (state.pdf) void handlePrintPdf();
		else setStatus(t('needPdfOpen'), 'error');
		return;
	}
	const target = event.target;
	const isField =
		target &&
		(target.tagName === 'INPUT' ||
			target.tagName === 'TEXTAREA' ||
			target.isContentEditable);
	// Dans nos blocs d'édition PDF (contenteditable), ⌘Z / ⌘⇧Z / ⌘Y doivent piloter
	// l'historique de l'app — l'undo natif du contenteditable ne revient pas sur les
	// modifications du PDF. Les vrais champs (recherche, réglages) gardent leur undo natif.
	const inEditBlock =
		target &&
		target.isContentEditable &&
		typeof target.closest === 'function' &&
		target.closest('.edit-block');
	if (isField && !inEditBlock) return;
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

// Curseur de texte (caret) : comme sur macOS/Windows/Linux, il ne doit PAS clignoter
// tant qu'un morceau de texte est sélectionné (surlignage bleu). On masque alors le
// caret custom du mode glyphe via une classe globale.
document.addEventListener('selectionchange', () => {
	const sel = window.getSelection();
	const hasSelection = !!sel && sel.rangeCount > 0 && !sel.isCollapsed && String(sel).length > 0;
	document.body.classList.toggle('has-text-selection', hasSelection);
	// Caret dessiné aux frontières de glyphes natifs : suit chaque déplacement
	// du caret logique (clic, flèches, frappe).
	if (state.editingBlockId) scheduleNativeCaretUpdate();
	else removeNativeCaretBar();
});
elements.applyEditText.addEventListener('click', applySelectedText);
elements.deleteEditBlock.addEventListener('click', hideSelectedBlock);
elements.applyEditTextPanel.addEventListener('click', applySelectedText);
elements.deleteEditBlockPanel.addEventListener('click', hideSelectedBlock);
for (const control of [elements.signatureRotationRange, elements.signatureRotationInput]) {
	control?.addEventListener('input', () => applySelectedSignatureRotation(control.value));
	control?.addEventListener('change', () => applySelectedSignatureRotation(control.value, true));
	control?.addEventListener('blur', () => applySelectedSignatureRotation(control.value, true));
}

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
for (const button of elements.formatListButtons) {
	button.addEventListener('mousedown', (event) => event.preventDefault());
	button.addEventListener('click', () => {
		applyListType(button.dataset.list);
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
		if (targetEl && targetEl.closest('#format-panel, #signature-transform-panel')) {
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
				updateSelectedEditField();
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

elements.propertiesOkButton?.addEventListener('click', () => void applyPropertiesModal());
elements.propertiesCancelButton?.addEventListener('click', closePropertiesModal);
elements.propertiesHelpButton?.addEventListener('click', () => {
	setStatus('Aide : métadonnées du PDF (titre, auteur, sécurité, polices…).', 'info');
});
elements.propertiesBackdrop?.addEventListener('click', closePropertiesModal);
elements.prepressBack?.addEventListener('click', closePrepressPanel);
elements.convertColorsOk?.addEventListener('click', () => void applyConvertColorsFogra39());
elements.convertColorsCancel?.addEventListener('click', closeConvertColorsModal);
elements.convertColorsBackdrop?.addEventListener('click', closeConvertColorsModal);
elements.convertColorsModal?.addEventListener('keydown', (event) => {
	if (event.key === 'Escape') {
		event.preventDefault();
		closeConvertColorsModal();
	}
});
elements.printCancel?.addEventListener('click', closePrintModal);
elements.printBackdrop?.addEventListener('click', closePrintModal);
elements.printSubmit?.addEventListener('click', () => void submitPrintJob());
elements.printLayoutFocus?.addEventListener('click', openPrintAdvanced);
elements.printAdvancedOpen?.addEventListener('click', openPrintAdvanced);
elements.printAdvancedClose?.addEventListener('click', closePrintAdvanced);
elements.printAdvancedReset?.addEventListener('click', () => {
	_printAdvancedValues = {};
	renderPrintAdvanced();
	updatePrintAdvancedButton();
});
elements.printAdvancedModal?.addEventListener('keydown', (event) => {
	if (event.key === 'Escape') {
		event.stopPropagation();
		closePrintAdvanced();
	}
});
makeDialogDraggable(elements.printModal, elements.printTitlebar);
makeDialogDraggable(elements.printAdvancedModal, elements.printAdvancedTitlebar);
elements.printPrinter?.addEventListener('change', () => {
	const name = elements.printPrinter.value;
	const saved = loadPrintSettings(name);
	applyPrintFormSettings(
		saved || { scaling: 'actual', orientation: 'auto', copies: 1, pagesMode: 'all' }
	);
	// Changer d’imprimante change le media : le recadrage mémorisé pour l’une ne
	// vaut rien pour l’autre.
	_printFitLabelTouched = typeof saved?.fitLabel === 'boolean';
	invalidateLabelFitPreview();
	void loadPrintAdvancedOptions(name)
		.then(() => {
			populatePrintInputSlot(saved?.inputSlot);
			return populatePrintPapers(name, saved?.paperSize);
		})
		.then(() => applyFitLabelAutoDefault())
		.then(() => renderPrintPreview());
	syncPrintScaleInputs();
	syncPrintPageInputs();
});
elements.printPaper?.addEventListener('change', () => {
	invalidateLabelFitPreview();
	void applyFitLabelAutoDefault().then(() => renderPrintPreview());
});
elements.printAutoPaper?.addEventListener('change', () => {
	invalidateLabelFitPreview();
	void applyAutoPaperIfNeeded()
		.then(() => applyFitLabelAutoDefault())
		.then(() => renderPrintPreview());
});
elements.printFitLabel?.addEventListener('change', () => {
	_printFitLabelTouched = true;
	syncPrintFitLabelInputs();
	void renderPrintPreview();
});
elements.printFitCompact?.addEventListener('change', () => {
	invalidateLabelFitPreview();
	void renderPrintPreview();
});
elements.printCustomScale?.addEventListener('input', () => {
	void renderPrintPreview();
});
elements.printPreviewPrev?.addEventListener('click', () => {
	_printPreviewPage -= 1;
	void renderPrintPreview();
});
elements.printPreviewNext?.addEventListener('click', () => {
	_printPreviewPage += 1;
	void renderPrintPreview();
});
document.querySelectorAll('input[name="print-scaling"]').forEach((input) => {
	input.addEventListener('change', syncPrintScaleInputs);
});
document.querySelectorAll('input[name="print-pages"]').forEach((input) => {
	input.addEventListener('change', syncPrintPageInputs);
});
document.querySelectorAll('input[name="print-orientation"]').forEach((input) => {
	input.addEventListener('change', () => void renderPrintPreview());
});
elements.printModal?.addEventListener('keydown', (event) => {
	if (event.key === 'Escape') {
		event.preventDefault();
		closePrintModal();
	}
});
elements.propertiesModal?.querySelectorAll('[data-props-tab]').forEach((tab) => {
	tab.addEventListener('click', () => setPropsTab(tab.dataset.propsTab));
});
elements.propertiesModal?.addEventListener('keydown', (event) => {
	if (event.key === 'Escape') {
		event.preventDefault();
		closePropertiesModal();
	}
});
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
	elements.settingAutoSave,
	elements.settingFitWidth,
	elements.settingShowTools,
	elements.settingShowRail,
	elements.settingShowNotes,
	elements.settingShowGuides,
	elements.settingHighlightColor,
	elements.settingIdentityName,
	elements.settingIdentityEmail
]) {
	control?.addEventListener('change', applySettingsFromForm);
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
			case 'prepress':
				openPrepressPanel();
				break;
			case 'convert-colors':
				void openConvertColorsModal();
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
		if (_tabPointerDrag?.native) return;
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
	void handleDroppedFiles(event, state.tabs.length);
});

// ── Mise à jour automatique ─────────────────────────────────────────────
let _updateInProgress = false;
let _lastUpdateCheck = 0;
// Version rejetée par l'utilisateur DANS CETTE SESSION (clic sur la croix / « Plus
// tard ») : on ne la re-propose plus jusqu'au prochain lancement de l'app.
let _updateDismissedVersion = null;
// Tentatives automatiques après un échec d'installation (réseau/CDN pas encore
// propagé, etc.) : on réessaie tout seul, puis on laisse le bouton « Réessayer ».
let _updateRetryCount = 0;
const UPDATE_AUTO_RETRIES = 2;
const UPDATE_RETRY_DELAY_MS = 15 * 1000;

async function checkForUpdates() {
	try {
		_lastUpdateCheck = Date.now();
		const info = await invokeCommand('check_for_update');
		if (info && info.version) showUpdateToast(info);
	} catch (_) {
		// Vérification silencieuse : aucune mise à jour ou réseau indisponible.
	}
}

// Vérification « opportuniste » : déclenchée quand l'utilisateur revient sur l'app
// (focus / onglet visible), au plus une fois par minute, pour que le pop-up monte
// tout seul sans attendre l'intervalle ni redémarrer.
function maybeCheckForUpdates() {
	// On revérifie même si le pop-up est déjà affiché : showUpdateToast rafraîchit la
	// version en place si une release plus récente est sortie entre-temps.
	if (_updateInProgress) return;
	if (Date.now() - _lastUpdateCheck < 15 * 1000) return;
	void checkForUpdates();
}

function showUpdateToast(info) {
	// Rejetée pour cette session : on attend le prochain lancement pour la reproposer.
	if (info && info.version && _updateDismissedVersion === info.version) return;
	const fr = currentLocale() === 'fr';
	const existing = document.getElementById('slate-update-toast');
	if (existing) {
		// Pop-up déjà affiché : si une version plus récente vient de sortir, on met à
		// jour le texte en place au lieu de laisser l'utilisateur installer l'ancienne.
		if (info.version && existing.dataset.version !== info.version) {
			existing.dataset.version = info.version;
			const sub = existing.querySelector('.slate-update-toast-sub');
			if (sub) sub.textContent = fr ? `Slate ${info.version} est prêt à être installé.` : `Slate ${info.version} is ready to install.`;
		}
		return;
	}
	_updateRetryCount = 0;
	const toast = document.createElement('div');
	toast.id = 'slate-update-toast';
	toast.className = 'slate-update-toast';
	toast.setAttribute('role', 'alert');
	toast.dataset.version = info.version || '';
	toast.innerHTML = `
		<button type="button" class="slate-update-toast-close" aria-label="${fr ? 'Ignorer' : 'Dismiss'}" title="${fr ? 'Ignorer jusqu’au prochain lancement' : 'Dismiss until next launch'}">
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
		</button>
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

	toast.querySelector('.slate-update-toast-close').addEventListener('click', () => dismissUpdateToast(toast));
	toast.querySelector('.slate-update-later').addEventListener('click', () => dismissUpdateToast(toast));
	toast.querySelector('.slate-update-now').addEventListener('click', () => void startUpdateInstall(toast));
}

function dismissUpdateToast(toast) {
	// On mémorise la version rejetée : elle ne réapparaîtra pas tant que l'app
	// tourne, mais reviendra au prochain lancement (la variable est réinitialisée).
	if (toast && toast.dataset && toast.dataset.version) {
		_updateDismissedVersion = toast.dataset.version;
	}
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
		if (sub) sub.textContent = fr ? 'Enregistrement du travail…' : 'Saving your work…';
		await flushAutosave({ reason: 'update', allTabs: true });
		persistOpenSession();
		if (sub) sub.textContent = fr ? 'Téléchargement de la mise à jour…' : 'Downloading update…';
		await invokeCommand('install_update');
	} catch (err) {
		_updateInProgress = false;
		if (typeof unlisten === 'function') unlisten();
		if (progress) progress.hidden = true;
		if (bar) bar.style.width = '0%';
		// Échec (souvent transitoire : release en cours de propagation sur le CDN).
		// On réessaie automatiquement, puis on rend la main avec un bouton « Réessayer ».
		if (_updateRetryCount < UPDATE_AUTO_RETRIES) {
			_updateRetryCount += 1;
			const secs = Math.round(UPDATE_RETRY_DELAY_MS / 1000);
			if (sub) {
				sub.textContent = fr
					? `Échec du téléchargement. Nouvelle tentative dans ${secs} s…`
					: `Download failed. Retrying in ${secs} s…`;
			}
			setTimeout(() => {
				if (document.body.contains(toast)) void startUpdateInstall(toast);
			}, UPDATE_RETRY_DELAY_MS);
			return;
		}
		if (sub) sub.textContent = fr ? 'Échec de la mise à jour.' : 'Update failed.';
		showUpdateRetryButton(toast);
		setStatus(fr ? 'La mise à jour a échoué.' : 'Update failed.', 'error');
	}
}

// Après épuisement des tentatives automatiques : bouton « Réessayer » manuel
// (le pop-up n'était plus actionnable, l'utilisateur restait bloqué).
function showUpdateRetryButton(toast) {
	if (!toast || toast.querySelector('.slate-update-toast-actions')) return;
	const fr = currentLocale() === 'fr';
	const actions = document.createElement('div');
	actions.className = 'slate-update-toast-actions';
	const retry = document.createElement('button');
	retry.type = 'button';
	retry.className = 'slate-update-now';
	retry.textContent = fr ? 'Réessayer' : 'Retry';
	retry.addEventListener('click', () => {
		_updateRetryCount = 0;
		void startUpdateInstall(toast);
	});
	actions.append(retry);
	const progress = toast.querySelector('.slate-update-progress');
	if (progress) toast.insertBefore(actions, progress);
	else toast.append(actions);
}

bindTauriMenuEvents();
bindShareUi();
bindWindowCloseGuard();
setupTabsScrolling();
setupPreciseSelectionOverlay();
setupDefaultAppPrompt();
setupSignFeature();
setupAiAssistant();
setupToolsResize();
syncSettingsForm();
syncNativeLanguage();
applyIcons();
localizeUi();
updateUi();
renderHome();
// Précharge le catalogue de polices au démarrage (liste prête dès la 1re ouverture
// du panneau de mise en forme, et le backend a le temps de répondre).
void ensureFontSelectPopulated();

// Vérifie les mises à jour en arrière-plan, sans bloquer le démarrage, PUIS
// régulièrement pendant l'utilisation : le pop-up apparaît dès qu'une nouvelle
// version est publiée, sans avoir à redémarrer l'application.
setTimeout(() => void checkForUpdates(), 3500);
setInterval(() => {
	// Pas de re-vérification pendant un téléchargement. Le pop-up déjà affiché est
	// rafraîchi en place si une version plus récente vient d'être publiée.
	if (_updateInProgress) return;
	void checkForUpdates();
}, 15 * 1000);

// WebView : focus / visibilité. WKWebView n'émet souvent rien si on reste
// dans la fenêtre — d'où le poll 15 s ci-dessus.
window.addEventListener('focus', maybeCheckForUpdates);
document.addEventListener('visibilitychange', () => {
	if (!document.hidden) maybeCheckForUpdates();
});
// Fenêtre native Tauri : le focus OS (clic Dock, ⌘Tab) n'atteint pas toujours
// le listener `window` du WebView.
{
	const getCurrentWindow = window.__TAURI__?.window?.getCurrentWindow;
	const win = getCurrentWindow?.();
	if (win?.onFocusChanged) {
		void win.onFocusChanged(({ payload: focused }) => {
			if (focused) maybeCheckForUpdates();
		});
	}
}
