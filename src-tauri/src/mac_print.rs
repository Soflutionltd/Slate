//! Impression depuis le Finder (macOS).
//!
//! Quand on sélectionne un PDF dans le Finder et qu'on l'imprime (Cmd+P du
//! Finder, menu « Imprimer », ou glisser sur l'icône de l'app), macOS envoie à
//! l'application l'Apple Event « print documents » (`kAEPrintDocuments`).
//!
//! Tauro/tao ne forwarde QUE l'event « open » (`RunEvent::Opened`), jamais
//! « print ». AppKit, lui, route automatiquement cet Apple Event vers la méthode
//! `application:printFiles:withSettings:showPrintPanels:` du delegate de
//! `NSApplication`… SI ce delegate l'implémente. tao ne l'implémente pas.
//!
//! On ajoute donc cette méthode à la VOLÉE sur la classe du delegate existant
//! (`class_addMethod`). Elle récupère la liste des chemins, les empile dans
//! `PendingPrints`, prévient le frontend (`alto-print-files-available`) puis
//! ramène la fenêtre au premier plan. Le frontend ouvre chaque PDF et lance
//! l'impression.

use std::ffi::CStr;
use std::io::Write;
use std::os::raw::c_char;
use std::path::PathBuf;
use std::sync::OnceLock;

use tauri::{AppHandle, Emitter, Manager};

/// Trace de debug vers /tmp/slate-print.log (diagnostic impression Finder).
/// Silencieux par défaut : activé uniquement si la variable d'environnement
/// `SLATE_PRINT_DEBUG` est définie.
fn log(msg: &str) {
    if std::env::var_os("SLATE_PRINT_DEBUG").is_none() {
        return;
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("/tmp/slate-print.log")
    {
        let _ = writeln!(f, "[{:?}] {}", std::time::SystemTime::now(), msg);
    }
}

#[allow(non_camel_case_types)]
type id = *mut std::ffi::c_void;
#[allow(non_camel_case_types)]
type SEL = *const std::ffi::c_void;
#[allow(non_camel_case_types)]
type Class = *mut std::ffi::c_void;
type Imp = unsafe extern "C" fn();

#[link(name = "objc", kind = "dylib")]
extern "C" {
    fn objc_getClass(name: *const c_char) -> Class;
    fn sel_registerName(name: *const c_char) -> SEL;
    fn object_getClass(obj: id) -> Class;
    fn class_addMethod(cls: Class, name: SEL, imp: Imp, types: *const c_char) -> i8;
    fn objc_msgSend();
}

/// NSApplicationPrintReplySuccess.
const PRINT_REPLY_SUCCESS: usize = 1;

static APP: OnceLock<AppHandle> = OnceLock::new();

/// Installe le handler d'impression sur le delegate AppKit. À appeler une seule
/// fois, sur le thread principal (depuis `setup`).
pub fn install(app: AppHandle) {
    if APP.set(app).is_err() {
        log("install: APP déjà défini");
    }
    log("install: démarrage (setup)");
    attach_handlers("setup");
}

/// Ré-arme les handlers après `RunEvent::Ready` : à ce stade `NSApp` a fini son
/// `finishLaunching` (qui installe ses propres handlers Apple Event par défaut),
/// donc notre enregistrement AEM « tient » et le delegate existe à coup sûr.
pub fn rearm() {
    log("rearm: ré-armement (Ready)");
    attach_handlers("ready");
}

/// Attache la méthode `application:printFiles:...` sur le delegate ET enregistre
/// un handler Apple Event direct. Idempotent.
fn attach_handlers(phase: &str) {
    unsafe {
        let app_class = objc_getClass(c"NSApplication".as_ptr());
        if app_class.is_null() {
            log(&format!("{}: NSApplication class NULL", phase));
            return;
        }

        // [NSApplication sharedApplication]
        let shared_sel = sel_registerName(c"sharedApplication".as_ptr());
        let send_cls_id: unsafe extern "C" fn(Class, SEL) -> id =
            std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        let ns_app = send_cls_id(app_class, shared_sel);
        if ns_app.is_null() {
            log(&format!("{}: NSApp NULL", phase));
            return;
        }

        // [NSApp delegate]
        let delegate_sel = sel_registerName(c"delegate".as_ptr());
        let send_id_id: unsafe extern "C" fn(id, SEL) -> id =
            std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        let delegate = send_id_id(ns_app, delegate_sel);
        if delegate.is_null() {
            log(&format!(
                "{}: [NSApp delegate] NULL — méthode print non attachée pour l'instant",
                phase
            ));
        } else {
            log(&format!("{}: delegate={:p}", phase, delegate));
            let delegate_class = object_getClass(delegate);
            if !delegate_class.is_null() {
                let print_sel = sel_registerName(
                    c"application:printFiles:withSettings:showPrintPanels:".as_ptr(),
                );
                let imp: Imp = std::mem::transmute(print_files_imp as *const ());
                let added = class_addMethod(delegate_class, print_sel, imp, c"Q@:@@@B".as_ptr());
                log(&format!(
                    "{}: class_addMethod(printFiles) -> {} (1=ajouté, 0=existe déjà)",
                    phase, added
                ));
            }
        }

        // Handler Apple Event direct (robuste, indépendant du delegate).
        install_apple_event_handler(ns_app);
    }
}

/// Enregistre un handler Apple Event `aevt`/`pdoc` directement via
/// NSAppleEventManager, indépendamment du delegate de NSApp.
unsafe fn install_apple_event_handler(_ns_app: id) {
    // 'aevt' / 'pdoc'
    const K_CORE_EVENT_CLASS: u32 = 0x6165_7674; // aevt
    const K_AE_PRINT_DOCUMENTS: u32 = 0x7064_6f63; // pdoc

    let mgr_class = objc_getClass(c"NSAppleEventManager".as_ptr());
    if mgr_class.is_null() {
        log("AEM: NSAppleEventManager class NULL");
        return;
    }
    let shared_sel = sel_registerName(c"sharedAppleEventManager".as_ptr());
    let send_cls_id: unsafe extern "C" fn(Class, SEL) -> id =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    let mgr = send_cls_id(mgr_class, shared_sel);
    if mgr.is_null() {
        log("AEM: sharedAppleEventManager NULL");
        return;
    }

    // Crée une instance NSObject à laquelle on attache le handler, puis on
    // l'enregistre. On la « fuit » volontairement (durée de vie = app).
    let obj_class = objc_getClass(c"NSObject".as_ptr());
    let alloc_sel = sel_registerName(c"alloc".as_ptr());
    let init_sel = sel_registerName(c"init".as_ptr());
    let allocated = send_cls_id(obj_class, alloc_sel);
    let handler_obj = send_id_id_msg(allocated, init_sel);
    if handler_obj.is_null() {
        log("AEM: handler object NULL");
        return;
    }

    // Attache la méthode handleAppleEvent:withReplyEvent: à la classe de l'objet.
    let handler_class = object_getClass(handler_obj);
    let handle_sel = sel_registerName(c"handleAppleEvent:withReplyEvent:".as_ptr());
    let imp: Imp = std::mem::transmute(handle_apple_event_imp as *const ());
    let added = class_addMethod(handler_class, handle_sel, imp, c"v@:@@".as_ptr());
    log(&format!("AEM: class_addMethod(handleAppleEvent) -> {}", added));

    // [mgr setEventHandler:handler_obj andSelector:handle_sel forEventClass:'aevt' andEventID:'pdoc']
    let set_sel = sel_registerName(
        c"setEventHandler:andSelector:forEventClass:andEventID:".as_ptr(),
    );
    let set_handler: unsafe extern "C" fn(id, SEL, id, SEL, u32, u32) =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    set_handler(
        mgr,
        set_sel,
        handler_obj,
        handle_sel,
        K_CORE_EVENT_CLASS,
        K_AE_PRINT_DOCUMENTS,
    );
    log("AEM: setEventHandler enregistré pour aevt/pdoc");
    // handler_obj (alloc/init, retain=1) n'est jamais relâché : il vit toute la
    // durée de l'app, ce qui est nécessaire car NSAppleEventManager ne retient
    // pas le handler.
    let _ = handler_obj;
}

unsafe fn send_id_id_msg(obj: id, sel: SEL) -> id {
    let f: unsafe extern "C" fn(id, SEL) -> id =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    f(obj, sel)
}

/// IMP de `handleAppleEvent:withReplyEvent:` (handler `aevt`/`pdoc`).
unsafe extern "C" fn handle_apple_event_imp(
    _this: id,
    _cmd: SEL,
    event: id,
    _reply: id,
) {
    log("AEM: handleAppleEvent appelé (pdoc)");
    let paths = read_paths_from_event(event);
    log(&format!("AEM: {} chemin(s) extrait(s)", paths.len()));
    if !paths.is_empty() {
        enqueue(paths);
    }
}

/// Extrait les chemins de fichiers d'un Apple Event « print documents ».
/// keyDirectObject ('----') -> liste de descripteurs -> coercition typeFileURL ('furl').
unsafe fn read_paths_from_event(event: id) -> Vec<PathBuf> {
    const KEY_DIRECT_OBJECT: u32 = 0x2d2d_2d2d; // '----'
    const TYPE_FILE_URL: u32 = 0x6675_726c; // 'furl'

    if event.is_null() {
        return Vec::new();
    }

    // [event paramDescriptorForKeyword:'----']
    let param_sel = sel_registerName(c"paramDescriptorForKeyword:".as_ptr());
    let send_id_u32_id: unsafe extern "C" fn(id, SEL, u32) -> id =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    let direct = send_id_u32_id(event, param_sel, KEY_DIRECT_OBJECT);
    if direct.is_null() {
        log("AEM: keyDirectObject absent");
        return Vec::new();
    }

    // [direct numberOfItems]
    let count_sel = sel_registerName(c"numberOfItems".as_ptr());
    let send_id_isize: unsafe extern "C" fn(id, SEL) -> isize =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    let count = send_id_isize(direct, count_sel);
    log(&format!("AEM: numberOfItems={}", count));

    let at_sel = sel_registerName(c"descriptorAtIndex:".as_ptr());
    let send_id_isize_id: unsafe extern "C" fn(id, SEL, isize) -> id =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    let coerce_sel = sel_registerName(c"coerceToDescriptorType:".as_ptr());
    let send_id_u32_id2: unsafe extern "C" fn(id, SEL, u32) -> id =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    let data_sel = sel_registerName(c"data".as_ptr());
    let send_id_id_fn: unsafe extern "C" fn(id, SEL) -> id =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    let bytes_sel = sel_registerName(c"bytes".as_ptr());
    let send_id_ptr: unsafe extern "C" fn(id, SEL) -> *const u8 =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    let length_sel = sel_registerName(c"length".as_ptr());
    let send_id_len: unsafe extern "C" fn(id, SEL) -> usize =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());

    let mut out = Vec::new();
    if count <= 0 {
        // Pas une liste : tenter une coercition directe.
        if let Some(p) = coerce_desc_to_path(
            direct,
            TYPE_FILE_URL,
            coerce_sel,
            send_id_u32_id2,
            data_sel,
            send_id_id_fn,
            bytes_sel,
            send_id_ptr,
            length_sel,
            send_id_len,
        ) {
            out.push(p);
        }
        return out;
    }

    for i in 1..=count {
        let desc = send_id_isize_id(direct, at_sel, i);
        if desc.is_null() {
            continue;
        }
        if let Some(p) = coerce_desc_to_path(
            desc,
            TYPE_FILE_URL,
            coerce_sel,
            send_id_u32_id2,
            data_sel,
            send_id_id_fn,
            bytes_sel,
            send_id_ptr,
            length_sel,
            send_id_len,
        ) {
            out.push(p);
        }
    }
    out
}

#[allow(clippy::too_many_arguments)]
unsafe fn coerce_desc_to_path(
    desc: id,
    type_file_url: u32,
    coerce_sel: SEL,
    coerce: unsafe extern "C" fn(id, SEL, u32) -> id,
    data_sel: SEL,
    data_fn: unsafe extern "C" fn(id, SEL) -> id,
    bytes_sel: SEL,
    bytes_fn: unsafe extern "C" fn(id, SEL) -> *const u8,
    length_sel: SEL,
    length_fn: unsafe extern "C" fn(id, SEL) -> usize,
) -> Option<PathBuf> {
    let url_desc = coerce(desc, coerce_sel, type_file_url);
    if url_desc.is_null() {
        return None;
    }
    let data = data_fn(url_desc, data_sel);
    if data.is_null() {
        return None;
    }
    let ptr = bytes_fn(data, bytes_sel);
    let len = length_fn(data, length_sel);
    if ptr.is_null() || len == 0 {
        return None;
    }
    let raw = std::slice::from_raw_parts(ptr, len);
    let url_str = String::from_utf8_lossy(raw);
    // url_str est de la forme "file:///chemin/encodé".
    let trimmed = url_str.trim_end_matches('\0');
    let path = url_to_path(trimmed)?;
    log(&format!("AEM: url={} -> path={}", trimmed, path.display()));
    Some(path)
}

/// Convertit une URL `file://` en chemin filesystem (décodage % minimal).
fn url_to_path(url: &str) -> Option<PathBuf> {
    let rest = url.strip_prefix("file://")?;
    // Retire l'éventuel host (rare pour les fichiers locaux).
    let rest = rest.strip_prefix("localhost").unwrap_or(rest);
    let decoded = percent_decode(rest);
    if decoded.is_empty() {
        return None;
    }
    Some(PathBuf::from(decoded))
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// IMP de `application:printFiles:withSettings:showPrintPanels:`.
unsafe extern "C" fn print_files_imp(
    _this: id,
    _cmd: SEL,
    _application: id,
    filenames: id,
    _settings: id,
    _show_panels: i8,
) -> usize {
    log("delegate: application:printFiles: appelé");
    let paths = read_filenames(filenames);
    log(&format!("delegate: {} chemin(s)", paths.len()));
    if !paths.is_empty() {
        enqueue(paths);
    }
    PRINT_REPLY_SUCCESS
}

/// Lit un `NSArray<NSString*>` en `Vec<PathBuf>` via le runtime ObjC.
unsafe fn read_filenames(array: id) -> Vec<PathBuf> {
    if array.is_null() {
        return Vec::new();
    }

    let count_sel = sel_registerName(c"count".as_ptr());
    let send_count: unsafe extern "C" fn(id, SEL) -> usize =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    let count = send_count(array, count_sel);

    let at_index_sel = sel_registerName(c"objectAtIndex:".as_ptr());
    let send_at_index: unsafe extern "C" fn(id, SEL, usize) -> id =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());

    let utf8_sel = sel_registerName(c"UTF8String".as_ptr());
    let send_utf8: unsafe extern "C" fn(id, SEL) -> *const c_char =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());

    let mut out = Vec::with_capacity(count);
    for index in 0..count {
        let ns_string = send_at_index(array, at_index_sel, index);
        if ns_string.is_null() {
            continue;
        }
        let utf8 = send_utf8(ns_string, utf8_sel);
        if utf8.is_null() {
            continue;
        }
        let path = CStr::from_ptr(utf8).to_string_lossy().into_owned();
        if !path.is_empty() {
            out.push(PathBuf::from(path));
        }
    }
    out
}

/// Empile les PDF à imprimer et prévient le frontend.
fn enqueue(paths: Vec<PathBuf>) {
    let Some(app) = APP.get() else {
        log("enqueue: APP non initialisé");
        return;
    };

    let state = app.state::<crate::PendingPrints>();
    if let Ok(mut buf) = state.0.lock() {
        for path in &paths {
            match crate::read_pdf_as_file_result(path) {
                Some(result) => buf.push(result),
                None => log(&format!("enqueue: lecture échouée pour {}", path.display())),
            }
        }
        log(&format!("enqueue: file mise à jour, total={}", buf.len()));
    }

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("alto-print-files-available", ());
        crate::bring_window_to_front(&window);
        log("enqueue: event alto-print-files-available émis");
    } else {
        log("enqueue: fenêtre 'main' introuvable");
    }
}

// ── Impression native (panneau dans l'app, via PDFKit) ──────────────────────

/// Imprime un PDF via le panneau d'impression natif macOS (PDFKit /
/// `NSPrintOperation`), affiché DANS Slate (une seule app, comme Acrobat).
/// Émet `alto-print-finished` (payload `bool` = succès) à la fermeture du panneau.
pub fn print_pdf_native(app: &AppHandle, bytes: Vec<u8>) -> Result<(), String> {
    // Ré-applique la locale Slate juste avant le panneau (au cas où le JS a
    // changé la langue depuis le boot). Effet complet surtout au prochain
    // lancement ; on persiste + synchronise quand même les defaults.
    apply_persisted_apple_languages();
    log(&format!(
        "print_pdf_native: reçu {} octets, dispatch main thread",
        bytes.len()
    ));
    app.run_on_main_thread(move || {
        log("print_pdf_native: closure sur main thread");
        unsafe { run_print_panel(&bytes) };
    })
    .map_err(|e| format!("Dispatch impression impossible : {e}"))
}

/// Émet `alto-print-finished` vers le frontend (fin du panneau d'impression).
fn emit_print_finished(success: bool) {
    log(&format!("print: panneau fermé, succès={}", success));
    if let Some(app) = APP.get() {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.emit("alto-print-finished", success);
        }
    }
}

/// Présente le panneau d'impression natif (PDFKit) en SHEET asynchrone sur la
/// fenêtre principale. Non bloquant : la run loop applique l'activation et
/// affiche le panneau ; le callback `printOperationDidRun:success:contextInfo:`
/// émet ensuite `alto-print-finished`.
unsafe fn run_print_panel(bytes: &[u8]) {
    log("run_print_panel: début");
    let cls_to_id: unsafe extern "C" fn(Class, SEL) -> id =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    let id_bool: unsafe extern "C" fn(id, SEL, i8) =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    let id_id_ret: unsafe extern "C" fn(id, SEL, id) -> id =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    let id_sel_only: unsafe extern "C" fn(id, SEL) =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());

    // Fenêtre hôte du webview (NSWindow) : le panneau s'affiche en sheet dessus.
    let Some(app) = APP.get() else {
        emit_print_finished(false);
        return;
    };
    let Some(window) = app.get_webview_window("main") else {
        emit_print_finished(false);
        return;
    };
    let ns_window = match window.ns_window() {
        Ok(ptr) => ptr as id,
        Err(_) => {
            log("print: ns_window indisponible");
            emit_print_finished(false);
            return;
        }
    };

    // Ramène Slate + sa fenêtre au premier plan pour que la sheet soit visible.
    let app_class = objc_getClass(c"NSApplication".as_ptr());
    let ns_app = cls_to_id(app_class, sel_registerName(c"sharedApplication".as_ptr()));
    id_bool(
        ns_app,
        sel_registerName(c"activateIgnoringOtherApps:".as_ptr()),
        1,
    );
    id_id_ret(
        ns_window,
        sel_registerName(c"makeKeyAndOrderFront:".as_ptr()),
        std::ptr::null_mut(),
    );
    id_sel_only(ns_window, sel_registerName(c"orderFrontRegardless".as_ptr()));

    // [NSData dataWithBytes:length:]
    let nsdata_class = objc_getClass(c"NSData".as_ptr());
    let make_data: unsafe extern "C" fn(Class, SEL, *const u8, usize) -> id =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    let data = make_data(
        nsdata_class,
        sel_registerName(c"dataWithBytes:length:".as_ptr()),
        bytes.as_ptr(),
        bytes.len(),
    );
    if data.is_null() {
        log("print: NSData nil");
        emit_print_finished(false);
        return;
    }

    // [[PDFDocument alloc] initWithData:data]
    let pdf_class = objc_getClass(c"PDFDocument".as_ptr());
    if pdf_class.is_null() {
        log("print: PDFDocument introuvable (PDFKit non lié)");
        emit_print_finished(false);
        return;
    }
    let alloc = cls_to_id(pdf_class, sel_registerName(c"alloc".as_ptr()));
    let doc = id_id_ret(alloc, sel_registerName(c"initWithData:".as_ptr()), data);
    if doc.is_null() {
        log("print: initWithData a échoué (PDF illisible)");
        emit_print_finished(false);
        return;
    }

    // [NSPrintInfo sharedPrintInfo]
    let info_class = objc_getClass(c"NSPrintInfo".as_ptr());
    let info = cls_to_id(info_class, sel_registerName(c"sharedPrintInfo".as_ptr()));

    // [doc printOperationForPrintInfo:info scalingMode:kPDFPrintPageScaleNone autoRotate:YES]
    // Taille réelle (100 %) — pas ScaleDownToFit, qui décale les étiquettes 4×6.
    let make_op: unsafe extern "C" fn(id, SEL, id, isize, i8) -> id =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    let op = make_op(
        doc,
        sel_registerName(c"printOperationForPrintInfo:scalingMode:autoRotate:".as_ptr()),
        info,
        0, // kPDFPrintPageScaleNone
        1,
    );
    if op.is_null() {
        log("print: printOperation nil");
        emit_print_finished(false);
        return;
    }

    // op.showsPrintPanel = YES ; op.showsProgressPanel = YES
    id_bool(op, sel_registerName(c"setShowsPrintPanel:".as_ptr()), 1);
    id_bool(op, sel_registerName(c"setShowsProgressPanel:".as_ptr()), 1);

    // [op runOperationModalForWindow:ns_window delegate:handler
    //     didRunSelector:@selector(printOperationDidRun:success:contextInfo:) contextInfo:NULL]
    // Asynchrone : rend la main, la run loop affiche la sheet ; le callback émet.
    log("run_print_panel: présentation de la sheet d'impression");
    let handler = print_done_handler();
    let run_modal: unsafe extern "C" fn(id, SEL, id, id, SEL, *mut std::ffi::c_void) =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    run_modal(
        op,
        sel_registerName(c"runOperationModalForWindow:delegate:didRunSelector:contextInfo:".as_ptr()),
        ns_window,
        handler,
        sel_registerName(c"printOperationDidRun:success:contextInfo:".as_ptr()),
        std::ptr::null_mut(),
    );
}

static PRINT_DONE_HANDLER: OnceLock<usize> = OnceLock::new();

/// Objet (créé une fois) portant le callback de fin d'impression.
unsafe fn print_done_handler() -> id {
    let ptr = PRINT_DONE_HANDLER.get_or_init(|| {
        let cls_to_id: unsafe extern "C" fn(Class, SEL) -> id =
            std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        let id_to_id: unsafe extern "C" fn(id, SEL) -> id =
            std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        let obj_class = objc_getClass(c"NSObject".as_ptr());
        let allocated = cls_to_id(obj_class, sel_registerName(c"alloc".as_ptr()));
        let obj = id_to_id(allocated, sel_registerName(c"init".as_ptr()));
        let cls = object_getClass(obj);
        let sel = sel_registerName(c"printOperationDidRun:success:contextInfo:".as_ptr());
        let imp: Imp = std::mem::transmute(print_did_run_imp as *const ());
        // v (void) @ self : _cmd @ op B success ^v contextInfo
        class_addMethod(cls, sel, imp, c"v@:@B^v".as_ptr());
        obj as usize
    });
    *ptr as id
}

/// IMP de `printOperationDidRun:success:contextInfo:`.
unsafe extern "C" fn print_did_run_imp(
    _this: id,
    _cmd: SEL,
    _op: id,
    success: i8,
    _ctx: *mut std::ffi::c_void,
) {
    emit_print_finished(success != 0);
}

/// Crée une `NSString` à partir d'un &str.
unsafe fn make_nsstring(s: &str) -> id {
    let cstr = std::ffi::CString::new(s).unwrap_or_default();
    let cls = objc_getClass(c"NSString".as_ptr());
    let make: unsafe extern "C" fn(Class, SEL, *const c_char) -> id =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    make(
        cls,
        sel_registerName(c"stringWithUTF8String:".as_ptr()),
        cstr.as_ptr(),
    )
}

/// Fichier persisté pour que `setup()` applique la langue AVANT AppKit
/// (le panneau d'impression lit `AppleLanguages` au boot, pas depuis le WebView).
fn native_language_path() -> Option<PathBuf> {
    let mut dir = dirs::home_dir()?;
    dir.push("Library");
    dir.push("Application Support");
    dir.push("com.soflution.slate");
    Some(dir.join("native-language"))
}

fn persist_native_language(lang: &str) {
    let Some(path) = native_language_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let value = if lang.is_empty() || lang == "auto" {
        "auto"
    } else {
        lang
    };
    let _ = std::fs::write(&path, value);
}

fn read_persisted_native_language() -> Option<String> {
    let path = native_language_path()?;
    let raw = std::fs::read_to_string(path).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Tags BCP-47 pour `AppleLanguages` (FR → fr-FR puis fr).
fn apple_language_tags(lang: &str) -> Vec<&'static str> {
    match lang {
        "fr" | "fr-FR" | "fr_FR" => vec!["fr-FR", "fr"],
        "en" | "en-US" | "en_US" | "en-GB" => vec!["en"],
        _ => vec![],
    }
}

/// Relit le fichier persisté et applique `AppleLanguages`. À appeler le plus
/// tôt possible (`main` avant le Builder) et avant impression / dialogues.
pub fn apply_persisted_apple_languages() {
    match read_persisted_native_language().as_deref() {
        None | Some("auto") | Some("") => set_apple_languages("auto"),
        Some(lang) => set_apple_languages(lang),
    }
}

/// Langue UI effective pour libellés natifs (filtres de dialogue…).
/// `auto` / absent → suit la locale processus (souvent le système).
pub fn effective_ui_language() -> String {
    match read_persisted_native_language().as_deref() {
        Some("fr") | Some("fr-FR") | Some("fr_FR") => "fr".into(),
        Some("en") | Some("en-US") | Some("en_US") | Some("en-GB") => "en".into(),
        Some(other) if other != "auto" && !other.is_empty() => other.to_string(),
        _ => {
            let locale = std::env::var("LANG")
                .or_else(|_| std::env::var("LC_ALL"))
                .unwrap_or_default()
                .to_lowercase();
            if locale.starts_with("fr") {
                "fr".into()
            } else {
                "en".into()
            }
        }
    }
}

/// Force la langue des panneaux natifs AppKit (impression, enregistrer…) et des
/// menus en écrivant `AppleLanguages` dans les NSUserDefaults de l'app.
/// Persiste aussi sur disque pour le prochain lancement. `lang` vide ou "auto"
/// retire l'override (l'app suit alors les préférences système).
pub fn set_apple_languages(lang: &str) {
    persist_native_language(lang);
    unsafe {
        let defaults_class = objc_getClass(c"NSUserDefaults".as_ptr());
        if defaults_class.is_null() {
            return;
        }
        let cls_to_id: unsafe extern "C" fn(Class, SEL) -> id =
            std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        let defaults = cls_to_id(
            defaults_class,
            sel_registerName(c"standardUserDefaults".as_ptr()),
        );
        if defaults.is_null() {
            return;
        }
        let key = make_nsstring("AppleLanguages");
        if key.is_null() {
            return;
        }

        if lang.is_empty() || lang == "auto" {
            let remove: unsafe extern "C" fn(id, SEL, id) =
                std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            remove(
                defaults,
                sel_registerName(c"removeObjectForKey:".as_ptr()),
                key,
            );
        } else {
            let tags = apple_language_tags(lang);
            if tags.is_empty() {
                let lang_str = make_nsstring(lang);
                let arr_class = objc_getClass(c"NSArray".as_ptr());
                let make_arr: unsafe extern "C" fn(Class, SEL, id) -> id =
                    std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
                let arr = make_arr(
                    arr_class,
                    sel_registerName(c"arrayWithObject:".as_ptr()),
                    lang_str,
                );
                let set_obj: unsafe extern "C" fn(id, SEL, id, id) =
                    std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
                set_obj(
                    defaults,
                    sel_registerName(c"setObject:forKey:".as_ptr()),
                    arr,
                    key,
                );
            } else {
                // NSMutableArray + addObject pour fr-FR, fr
                let mut_arr_class = objc_getClass(c"NSMutableArray".as_ptr());
                let arr = cls_to_id(mut_arr_class, sel_registerName(c"array".as_ptr()));
                let add: unsafe extern "C" fn(id, SEL, id) =
                    std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
                for tag in tags {
                    let tag_str = make_nsstring(tag);
                    add(arr, sel_registerName(c"addObject:".as_ptr()), tag_str);
                }
                let set_obj: unsafe extern "C" fn(id, SEL, id, id) =
                    std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
                set_obj(
                    defaults,
                    sel_registerName(c"setObject:forKey:".as_ptr()),
                    arr,
                    key,
                );
            }
        }

        let sync: unsafe extern "C" fn(id, SEL) -> i8 =
            std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        sync(defaults, sel_registerName(c"synchronize".as_ptr()));
        log(&format!("set_apple_languages: '{}'", lang));
    }
}

/// Masque Slate (→ icône dans le Dock), façon Acrobat après impression quand
/// des documents étaient déjà ouverts. La session reste intacte.
pub fn hide_app_native(app: &AppHandle) -> Result<(), String> {
    app.run_on_main_thread(|| unsafe {
        let app_class = objc_getClass(c"NSApplication".as_ptr());
        if app_class.is_null() {
            return;
        }
        let cls_to_id: unsafe extern "C" fn(Class, SEL) -> id =
            std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        let ns_app = cls_to_id(app_class, sel_registerName(c"sharedApplication".as_ptr()));
        let id_id: unsafe extern "C" fn(id, SEL, id) =
            std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        id_id(
            ns_app,
            sel_registerName(c"hide:".as_ptr()),
            std::ptr::null_mut(),
        );
    })
    .map_err(|e| format!("Masquage de l'app impossible : {e}"))
}
