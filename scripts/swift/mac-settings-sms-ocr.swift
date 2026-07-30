#!/usr/bin/env swift
// SMS verification OCR fallback — when AX cannot find the code entry fields,
// use ScreenCaptureKit + Vision to locate the input area and type via CGEvent.
// JSON → stdout；[sms-ocr N] → stderr

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ScreenCaptureKit
import Vision

struct Output: Codable {
    let ok: Bool
    let stage: String
    let suffix: String?
    let message: String
    let inputFieldCount: Int?

    init(ok: Bool, stage: String, suffix: String?, message: String, inputFieldCount: Int? = nil) {
        self.ok = ok
        self.stage = stage
        self.suffix = suffix
        self.message = message
        self.inputFieldCount = inputFieldCount
    }
}

func logStep(_ n: Int, _ msg: String) {
    FileHandle.standardError.write("[sms-ocr \(n)] \(msg)\n".data(using: .utf8)!)
}

func emit(_ output: Output) -> Never {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    if let data = try? encoder.encode(output) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    }
    exit(output.ok ? 0 : 1)
}

// ── screen capture via ScreenCaptureKit ────────────────────────────

func screenCaptureCapability() -> Bool {
    CGPreflightScreenCaptureAccess()
}

func captureMainDisplayImage() -> CGImage? {
    guard screenCaptureCapability() else {
        logStep(0, "screen recording permission missing")
        return nil
    }
    // Use ScreenCaptureKit's synchronous capture API via a semaphore.
    let semaphore = DispatchSemaphore(value: 0)
    var resultImage: CGImage?
    Task {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: false
            )
            guard let display = content.displays.first else {
                semaphore.signal()
                return
            }
            let filter = SCContentFilter(display: display, excludingWindows: [])
            let config = SCStreamConfiguration()
            let scale = CGFloat(display.width) / CGFloat(display.width)  // 1x
            config.width = display.width
            config.height = display.height
            config.showsCursor = false
            resultImage = try await SCScreenshotManager.captureImage(
                contentFilter: filter,
                configuration: config
            )
        } catch {
            logStep(0, "capture failed: \(error.localizedDescription)")
        }
        semaphore.signal()
    }
    semaphore.wait()
    return resultImage
}

// ── OCR ─────────────────────────────────────────────────────────────

struct OCRResult {
    let fullText: String
    let observations: [VNRecognizedTextObservation]
    let suffixCandidates: Set<String>
    let hasCodeMarker: Bool
    let hasPhoneMarker: Bool
}

func ocrImage(_ image: CGImage) -> OCRResult? {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["en-US", "zh-Hans", "zh-Hant"]
    request.usesLanguageCorrection = false

    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do {
        try handler.perform([request])
    } catch {
        logStep(0, "vision request failed: \(error.localizedDescription)")
        return nil
    }

    guard let observations = request.results, !observations.isEmpty else {
        return nil
    }

    let fullText = observations
        .compactMap { $0.topCandidates(1).first?.string }
        .joined(separator: " ")

    let normalized = fullText.lowercased()

    let codeMarkers = [
        "verification", "one-time", "security code",
        "验证码", "驗證碼", "双重认证", "雙重認證",
    ]
    let phoneMarkers = [
        "sent to", "send to", "text to",
        "发送至", "發送至", "发送短信至", "發送短訊至",
    ]

    let hasCodeMarker = codeMarkers.contains { normalized.contains($0) }
    let hasPhoneMarker = phoneMarkers.contains { normalized.contains($0) }

    // Extract 2-digit suffixes from masked phone number patterns
    var suffixCandidates = Set<String>()
    do {
        let pattern = try NSRegularExpression(
            pattern: #"\*\*\s*[•\-]*\s*(\d{2})"#,
            options: []
        )
        let range = NSRange(fullText.startIndex..., in: fullText)
        for match in pattern.matches(in: fullText, options: [], range: range) {
            if match.numberOfRanges >= 2,
               let suffixRange = Range(match.range(at: 1), in: fullText) {
                suffixCandidates.insert(String(fullText[suffixRange]))
            }
        }
    } catch { /* regex pattern is static */ }

    return OCRResult(
        fullText: fullText,
        observations: observations,
        suffixCandidates: suffixCandidates,
        hasCodeMarker: hasCodeMarker,
        hasPhoneMarker: hasPhoneMarker
    )
}

// ── input field location ────────────────────────────────────────────

func findCodeInputs(
    in image: CGImage,
    observations: [VNRecognizedTextObservation]
) -> [CGRect] {
    // Look for single-digit or empty text observations that are
    // horizontally aligned (the six-cell verification code widget).
    let digitObservations = observations.filter { obs in
        guard let candidate = obs.topCandidates(1).first else { return false }
        let text = candidate.string.trimmingCharacters(in: .whitespaces)
        return text.isEmpty || (text.count == 1 && text.allSatisfy { $0.isNumber })
    }

    guard digitObservations.count >= 3 else { return [] }

    // Group by vertical position (within 12px tolerance)
    let sorted = digitObservations.sorted {
        $0.boundingBox.origin.x < $1.boundingBox.origin.x
    }

    var groups: [[VNRecognizedTextObservation]] = []
    for obs in sorted {
        if let lastGroup = groups.last,
           let lastObs = lastGroup.last,
           abs(lastObs.boundingBox.midY - obs.boundingBox.midY) < 0.012 {
            groups[groups.count - 1].append(obs)
        } else {
            groups.append([obs])
        }
    }

    // Pick the group closest to 6 observations
    guard let bestGroup = groups.max(by: {
        abs($0.count - 6) > abs($1.count - 6)
    }), bestGroup.count >= 3 else { return [] }

    return bestGroup.map { obs in
        let box = obs.boundingBox
        return CGRect(
            x: box.origin.x * CGFloat(image.width),
            y: (1.0 - box.origin.y - box.height) * CGFloat(image.height),
            width: box.width * CGFloat(image.width),
            height: box.height * CGFloat(image.height)
        )
    }
}

// ── CGEvent keyboard ────────────────────────────────────────────────

func postUnicodeText(_ text: String) -> Bool {
    guard !text.isEmpty,
          let source = CGEventSource(stateID: .hidSystemState) else {
        return false
    }
    for character in text {
        let codeUnits = Array(String(character).utf16)
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else {
            return false
        }
        codeUnits.withUnsafeBufferPointer { buffer in
            down.keyboardSetUnicodeString(stringLength: codeUnits.count, unicodeString: buffer.baseAddress)
            up.keyboardSetUnicodeString(stringLength: codeUnits.count, unicodeString: buffer.baseAddress)
        }
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
        usleep(12_000)
    }
    return true
}

func clickPoint(_ point: CGPoint) -> Bool {
    guard let source = CGEventSource(stateID: .hidSystemState) else { return false }
    guard let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown,
                              mouseCursorPosition: point, mouseButton: .left),
          let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp,
                            mouseCursorPosition: point, mouseButton: .left) else {
        return false
    }
    down.post(tap: .cghidEventTap)
    usleep(30_000)
    up.post(tap: .cghidEventTap)
    usleep(30_000)
    return true
}

// ── main ────────────────────────────────────────────────────────────

var phase = "ocr-state"
var inputCode: String?
var expectedSuffix: String?
var i = 1
let args = CommandLine.arguments
while i < args.count {
    if args[i] == "--phase", i + 1 < args.count { phase = args[i + 1]; i += 2; continue }
    if args[i] == "--suffix", i + 1 < args.count { expectedSuffix = args[i + 1]; i += 2; continue }
    if args[i] == "--code", i + 1 < args.count { inputCode = args[i + 1]; i += 2; continue }
    i += 1
}

guard screenCaptureCapability() else {
    emit(Output(ok: false, stage: "ocr_unavailable", suffix: nil, message: "screen recording permission missing"))
}

guard let image = captureMainDisplayImage() else {
    emit(Output(ok: false, stage: "ocr_unavailable", suffix: nil, message: "display capture failed"))
}

guard let ocr = ocrImage(image) else {
    emit(Output(ok: false, stage: "ocr_unavailable", suffix: nil, message: "OCR produced no text"))
}

logStep(1, "ocr: \(ocr.fullText.prefix(200))")
logStep(2, "markers: code=\(ocr.hasCodeMarker) phone=\(ocr.hasPhoneMarker) suffixes=\(ocr.suffixCandidates)")

switch phase {
case "ocr-state":
    if ocr.hasCodeMarker && ocr.hasPhoneMarker {
        let detectedSuffix = ocr.suffixCandidates.first
        let suffixOk = expectedSuffix == nil || detectedSuffix == expectedSuffix
        logStep(3, "code-entry screen, suffix=\(detectedSuffix ?? "?") match=\(suffixOk)")
        if suffixOk {
            let inputs = findCodeInputs(in: image, observations: ocr.observations)
            emit(Output(ok: true, stage: "code_entry", suffix: detectedSuffix,
                        message: "code entry screen with matching suffix", inputFieldCount: inputs.count))
        }
        emit(Output(ok: true, stage: "code_entry_mismatch", suffix: detectedSuffix,
                    message: "code entry screen but suffix does not match"))
    }
    if ocr.hasPhoneMarker && !ocr.hasCodeMarker {
        emit(Output(ok: true, stage: "phone_selection", suffix: ocr.suffixCandidates.first,
                    message: "phone selection screen detected via OCR"))
    }
    emit(Output(ok: true, stage: "waiting", suffix: nil, message: "OCR did not match known patterns"))

case "ocr-code":
    guard let code = inputCode, code.count == 6, code.allSatisfy({ $0.isNumber }) else {
        emit(Output(ok: false, stage: "ocr-code", suffix: nil, message: "invalid code"))
    }

    let inputs = findCodeInputs(in: image, observations: ocr.observations)
    logStep(3, "found \(inputs.count) potential input(s)")

    if inputs.isEmpty {
        // Fallback: click near the "verification code" text
        var markerPos: CGPoint?
        for obs in ocr.observations {
            guard let candidate = obs.topCandidates(1).first else { continue }
            let text = candidate.string.lowercased()
            if text.contains("verification") || text.contains("验证码") ||
               text.contains("驗證碼") || text.contains("security code") {
                let box = obs.boundingBox
                markerPos = CGPoint(
                    x: box.midX * CGFloat(image.width),
                    y: (1.0 - box.midY) * CGFloat(image.height)
                )
                break
            }
        }
        guard let pos = markerPos else {
            emit(Output(ok: false, stage: "ocr-code", suffix: nil,
                        message: "no input fields or code marker found"))
        }
        let clickPos = CGPoint(x: pos.x + 120, y: pos.y + 40)
        logStep(4, "clicking estimated input at (\(clickPos.x), \(clickPos.y))")
        guard clickPoint(clickPos) else {
            emit(Output(ok: false, stage: "ocr-code", suffix: nil, message: "click failed"))
        }
    } else {
        let field = inputs[0]
        let clickPos = CGPoint(x: field.midX, y: field.midY)
        logStep(4, "clicking input at (\(clickPos.x), \(clickPos.y))")
        guard clickPoint(clickPos) else {
            emit(Output(ok: false, stage: "ocr-code", suffix: nil, message: "click failed"))
        }
    }
    usleep(200_000)

    logStep(5, "typing \(code.count) digit(s)")
    guard postUnicodeText(code) else {
        emit(Output(ok: false, stage: "ocr-code", suffix: nil, message: "type failed"))
    }
    usleep(300_000)

    emit(Output(ok: true, stage: "code_submitted", suffix: expectedSuffix,
                message: "code typed via OCR", inputFieldCount: inputs.count))

default:
    emit(Output(ok: false, stage: "unknown", suffix: nil, message: "unknown phase"))
}
