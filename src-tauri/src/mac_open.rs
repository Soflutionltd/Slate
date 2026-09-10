//! Ouverture de PDF depuis le Finder / Mail pendant que Slate tourne déjà.
//!
//! Sur macOS récents (Tahoe+), Launch Services droppe parfois
//! `application:openURLs:` pour les fichiers **en quarantaine** (pièces jointes
//! Mail, téléchargements) quand l'app est déjà ouverte. `RunEvent::Opened` ne
//! part jamais → le 2ᵉ PDF ne s'ouvre pas en onglet.
//!
//! Contournement (même stratégie que `mac_print`) :
//! 1. Handler Apple Event direct `aevt`/`odoc` via `NSAppleEventManager`
//! 2. Fallback delegate `application:openFile:` / `application:openFiles:`

use std::ffi::CStr;
use std::io::Write;
use std::os::raw::c_char;
use std::path::PathBuf;
use std::sync::OnceLock;

use tauri::AppHandle;

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

static APP: OnceLock<AppHandle> = OnceLock::new();

fn log(msg: &str) {
	if std::env::var_os("SLATE_OPEN_DEBUG").is_none() {
		return;
	}
	if let Ok(mut f) = std::fs::OpenOptions::new()
		.create(true)
		.append(true)
		.open("/tmp/slate-open.log")
	{
		let _ = writeln!(f, "[{:?}] {}", std::time::SystemTime::now(), msg);
	}
}

pub fn install(app: AppHandle) {
	if APP.set(app).is_err() {
		log("install: APP déjà défini");
	}
	log("install: démarrage");
	attach_handlers("setup");
}

pub fn rearm() {
	log("rearm: Ready");
	attach_handlers("ready");
}

fn attach_handlers(phase: &str) {
	unsafe {
		let app_class = objc_getClass(c"NSApplication".as_ptr());
		if app_class.is_null() {
			log(&format!("{phase}: NSApplication class NULL"));
			return;
		}
		let shared_sel = sel_registerName(c"sharedApplication".as_ptr());
		let send_cls_id: unsafe extern "C" fn(Class, SEL) -> id =
			std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
		let ns_app = send_cls_id(app_class, shared_sel);
		if ns_app.is_null() {
			log(&format!("{phase}: NSApp NULL"));
			return;
		}

		let delegate_sel = sel_registerName(c"delegate".as_ptr());
		let send_id_id: unsafe extern "C" fn(id, SEL) -> id =
			std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
		let delegate = send_id_id(ns_app, delegate_sel);
		if !delegate.is_null() {
			let delegate_class = object_getClass(delegate);
			if !delegate_class.is_null() {
				// Fallback single-file (API plus ancienne, parfois hors chemin CSUI).
				let open_file_sel = sel_registerName(c"application:openFile:".as_ptr());
				let open_file_imp: Imp = std::mem::transmute(open_file_imp as *const ());
				let added_file =
					class_addMethod(delegate_class, open_file_sel, open_file_imp, c"c@:@@".as_ptr());
				log(&format!(
					"{phase}: class_addMethod(openFile) -> {added_file}"
				));

				let open_files_sel = sel_registerName(c"application:openFiles:".as_ptr());
				let open_files_imp: Imp = std::mem::transmute(open_files_imp as *const ());
				let added_files = class_addMethod(
					delegate_class,
					open_files_sel,
					open_files_imp,
					c"v@:@@".as_ptr(),
				);
				log(&format!(
					"{phase}: class_addMethod(openFiles) -> {added_files}"
				));
			}
		} else {
			log(&format!("{phase}: delegate NULL"));
		}

		install_apple_event_open_handler();
	}
}

/// Enregistre `aevt`/`odoc` (kAEOpenDocuments) via NSAppleEventManager.
unsafe fn install_apple_event_open_handler() {
	const K_CORE_EVENT_CLASS: u32 = 0x6165_7674; // aevt
	const K_AE_OPEN_DOCUMENTS: u32 = 0x6f64_6f63; // odoc

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

	let obj_class = objc_getClass(c"NSObject".as_ptr());
	let alloc_sel = sel_registerName(c"alloc".as_ptr());
	let init_sel = sel_registerName(c"init".as_ptr());
	let allocated = send_cls_id(obj_class, alloc_sel);
	let send_id_id: unsafe extern "C" fn(id, SEL) -> id =
		std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
	let handler_obj = send_id_id(allocated, init_sel);
	if handler_obj.is_null() {
		log("AEM: handler object NULL");
		return;
	}

	let handler_class = object_getClass(handler_obj);
	let handle_sel = sel_registerName(c"handleOpenAppleEvent:withReplyEvent:".as_ptr());
	let imp: Imp = std::mem::transmute(handle_open_apple_event_imp as *const ());
	let added = class_addMethod(handler_class, handle_sel, imp, c"v@:@@".as_ptr());
	log(&format!("AEM: class_addMethod(handleOpenAppleEvent) -> {added}"));

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
		K_AE_OPEN_DOCUMENTS,
	);
	log("AEM: setEventHandler enregistré pour aevt/odoc");
	let _ = handler_obj;
}

unsafe extern "C" fn handle_open_apple_event_imp(
	_this: id,
	_cmd: SEL,
	event: id,
	_reply: id,
) {
	log("AEM: handleOpenAppleEvent appelé (odoc)");
	let paths = read_paths_from_event(event);
	log(&format!("AEM odoc: {} chemin(s)", paths.len()));
	enqueue_open(paths);
}

/// `- (BOOL)application:(NSApplication *)sender openFile:(NSString *)filename`
unsafe extern "C" fn open_file_imp(
	_this: id,
	_cmd: SEL,
	_application: id,
	filename: id,
) -> i8 {
	log("delegate: application:openFile: appelé");
	if let Some(path) = nsstring_to_path(filename) {
		enqueue_open(vec![path]);
		return 1; // YES
	}
	0
}

/// `- (void)application:(NSApplication *)sender openFiles:(NSArray *)filenames`
unsafe extern "C" fn open_files_imp(
	_this: id,
	_cmd: SEL,
	_application: id,
	filenames: id,
) {
	log("delegate: application:openFiles: appelé");
	let paths = read_nsstring_array(filenames);
	log(&format!("delegate openFiles: {} chemin(s)", paths.len()));
	if !paths.is_empty() {
		enqueue_open(paths);
	}
}

fn enqueue_open(paths: Vec<PathBuf>) {
	let Some(app) = APP.get() else {
		log("enqueue_open: APP non initialisé");
		return;
	};
	for path in paths {
		crate::dispatch_open_path(app, &path);
	}
}

unsafe fn read_paths_from_event(event: id) -> Vec<PathBuf> {
	const KEY_DIRECT_OBJECT: u32 = 0x2d2d_2d2d; // '----'
	const TYPE_FILE_URL: u32 = 0x6675_726c; // 'furl'

	if event.is_null() {
		return Vec::new();
	}

	let param_sel = sel_registerName(c"paramDescriptorForKeyword:".as_ptr());
	let send_id_u32_id: unsafe extern "C" fn(id, SEL, u32) -> id =
		std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
	let direct = send_id_u32_id(event, param_sel, KEY_DIRECT_OBJECT);
	if direct.is_null() {
		log("AEM: keyDirectObject absent");
		return Vec::new();
	}

	let count_sel = sel_registerName(c"numberOfItems".as_ptr());
	let send_id_isize: unsafe extern "C" fn(id, SEL) -> isize =
		std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
	let count = send_id_isize(direct, count_sel);

	let at_sel = sel_registerName(c"descriptorAtIndex:".as_ptr());
	let send_id_isize_id: unsafe extern "C" fn(id, SEL, isize) -> id =
		std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
	let coerce_sel = sel_registerName(c"coerceToDescriptorType:".as_ptr());
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
		if let Some(p) = coerce_desc_to_path(
			direct,
			TYPE_FILE_URL,
			coerce_sel,
			send_id_u32_id,
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
			send_id_u32_id,
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
	let trimmed = url_str.trim_end_matches('\0');
	url_to_path(trimmed)
}

fn url_to_path(url: &str) -> Option<PathBuf> {
	let rest = url.strip_prefix("file://")?;
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

unsafe fn nsstring_to_path(s: id) -> Option<PathBuf> {
	if s.is_null() {
		return None;
	}
	let utf8_sel = sel_registerName(c"UTF8String".as_ptr());
	let send_ptr: unsafe extern "C" fn(id, SEL) -> *const c_char =
		std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
	let ptr = send_ptr(s, utf8_sel);
	if ptr.is_null() {
		return None;
	}
	let text = CStr::from_ptr(ptr).to_string_lossy();
	if text.is_empty() {
		return None;
	}
	Some(PathBuf::from(text.as_ref()))
}

unsafe fn read_nsstring_array(array: id) -> Vec<PathBuf> {
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
	let mut out = Vec::with_capacity(count);
	for i in 0..count {
		let item = send_at_index(array, at_index_sel, i);
		if let Some(path) = nsstring_to_path(item) {
			out.push(path);
		}
	}
	out
}
