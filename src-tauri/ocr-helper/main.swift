// Helper OCR Apple Vision embarqué dans Slate.app (sidecar `slate-ocr`).
//
// Compilé par scripts/ensure-ocr-helper.sh au build : aucune dépendance côté
// client (ni Xcode Command Line Tools, ni Tesseract). Vision fait partie de macOS.
//
// Usage : slate-ocr <image.png> <langue BCP-47>
// Sortie : JSON `[{text, x, y, width, height, confidence}]`, coordonnées en
// pixels image, origine en haut à gauche, confiance 0–100. Une ligne = un bloc.
//
// macOS 26+ : `RecognizeDocumentsRequest` (compréhension de la mise en page :
// paragraphes, tableaux, listes → lignes rendues dans l'ordre de lecture).
// Sinon : `VNRecognizeTextRequest` (.accurate), même format de sortie.

import AppKit
import Foundation
import Vision

struct OcrBlock: Codable {
	let text: String
	let x: Double
	let y: Double
	let width: Double
	let height: Double
	let confidence: Double
}

func fail(_ message: String, code: Int32) -> Never {
	FileHandle.standardError.write(Data((message + "\n").utf8))
	exit(code)
}

let arguments = CommandLine.arguments
guard arguments.count >= 3 else {
	fail("usage: slate-ocr <image> <language>", code: 2)
}

let imageUrl = URL(fileURLWithPath: arguments[1])
let languageTag = arguments[2]
guard let image = NSImage(contentsOf: imageUrl),
	let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
else {
	fail("unable to load image", code: 3)
}

let imageWidth = Double(cgImage.width)
let imageHeight = Double(cgImage.height)
// Langue demandée d'abord, puis les deux langues du produit en secours.
let languageTags = Array(NSOrderedSet(array: [languageTag, "en-US", "fr-FR"])) as! [String]

/// Rectangle Vision (normalisé, origine en bas à gauche) → pixels, origine en haut à gauche.
func pixelRect(_ normalized: CGRect) -> (Double, Double, Double, Double) {
	(
		normalized.minX * imageWidth,
		(1.0 - normalized.maxY) * imageHeight,
		normalized.width * imageWidth,
		normalized.height * imageHeight
	)
}

func recognizeLegacy() throws -> [OcrBlock] {
	let request = VNRecognizeTextRequest()
	request.recognitionLevel = .accurate
	request.usesLanguageCorrection = true
	request.recognitionLanguages = languageTags
	let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
	try handler.perform([request])
	return (request.results ?? []).compactMap { observation in
		guard let candidate = observation.topCandidates(1).first else { return nil }
		let (x, y, width, height) = pixelRect(observation.boundingBox)
		return OcrBlock(
			text: candidate.string, x: x, y: y, width: width, height: height,
			confidence: Double(candidate.confidence) * 100.0)
	}
}

@available(macOS 26.0, *)
func recognizeDocument() async throws -> [OcrBlock] {
	var request = RecognizeDocumentsRequest()
	request.textRecognitionOptions.recognitionLanguages = languageTags.map {
		Locale.Language(identifier: $0)
	}
	let observations = try await request.perform(on: cgImage)
	guard let document = observations.first?.document else { return [] }
	// `text.lines` : toutes les lignes du document (paragraphes, cellules de
	// tableaux, listes) dans l'ordre de lecture déterminé par Vision.
	return document.text.lines.compactMap { line in
		let transcript = line.transcript
		guard !transcript.isEmpty else { return nil }
		let (x, y, width, height) = pixelRect(line.boundingRegion.boundingBox.cgRect)
		return OcrBlock(
			text: transcript, x: x, y: y, width: width, height: height,
			confidence: Double(line.confidence) * 100.0)
	}
}

let blocks: [OcrBlock]
do {
	if #available(macOS 26.0, *) {
		blocks = try await recognizeDocument()
	} else {
		blocks = try recognizeLegacy()
	}
} catch {
	fail("vision: \(error.localizedDescription)", code: 4)
}

let payload = try JSONEncoder().encode(blocks)
FileHandle.standardOutput.write(payload)
