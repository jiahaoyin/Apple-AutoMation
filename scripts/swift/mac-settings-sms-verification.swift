#!/usr/bin/env swift
// Supervised System Settings SMS verification helper.
// It uses Accessibility APIs only and emits redacted, fixed JSON tokens.

import ApplicationServices
import AppKit
import Foundation

private struct Output: Codable {
    let ok: Bool
    let stage: String
}

private func logStep(_ n: Int, _ msg: String) {
    FileHandle.standardError.write("[sms-step \(n)] \(msg)\n".data(using: .utf8)!)
}

private enum CodeEntry {
    case single(AXUIElement)
    case six([AXUIElement])
}

private struct PhoneSelection {
    let controls: [AXUIElement]
    let continueButton: AXUIElement
}

private struct SettingsSnapshot {
    let pid: pid_t
    let nodes: [AXUIElement]
}

private let settingsBundleIDs: Set<String> = [
    "com.apple.SystemSettings",
    "com.apple.systempreferences",
]

private let appleIDSettingsExecutablePaths: Set<String> = [
    "/System/Library/ExtensionKit/Extensions/AppleIDSettings.appex/Contents/MacOS/AppleIDSettings",
    "/System/Applications/System Settings.app/Contents/PlugIns/AppleIDSettings.appex/Contents/MacOS/AppleIDSettings",
    "/System/Applications/System Settings.app/Contents/PlugIns/AccountsSettingsExtension.appex/Contents/MacOS/AccountsSettingsExtension",
]
private let axSheetsAttribute = "AXSheets"

private let continueLabels: Set<String> = [
    "continue",
    "next",
    "\u{7EE7}\u{7EED}",
    "\u{7E7C}\u{7E8C}",
]

// macOS 15 System Settings uses SwiftUI which may render phone-selection
// controls as buttons, cells, or static-text rows rather than traditional
// radio buttons. Accept any interactive role that can receive a press.
private let phoneControlRoles: Set<String> = [
    kAXRadioButtonRole as String,
    kAXCheckBoxRole as String,
    kAXButtonRole as String,
    "AXCell",
    "AXStaticText",
    "AXGroup",
]

private let codeMarkers = [
    "verification",
    "one-time",
    "two-factor",
    "authentication",
    "\u{9A8C}\u{8BC1}\u{7801}",
    "\u{9A57}\u{8B49}\u{78BC}",
    "\u{53CC}\u{91CD}\u{8BA4}\u{8BC1}",
    "\u{96D9}\u{91CD}\u{8A8D}\u{8B49}",
]

private let phoneMarkers = [
    "send",
    "sent",
    "text",
    "message",
    "sms",
    "phone",
    "\u{53D1}\u{9001}",
    "\u{77ED}\u{4FE1}",
    "\u{7535}\u{8BDD}",
    "\u{624B}\u{673A}",
    "\u{50B3}\u{9001}",
    "\u{8A0A}\u{606F}",
    "\u{96FB}\u{8A71}",
    "\u{624B}\u{6A5F}",
]

private func emit(_ ok: Bool, _ stage: String) -> Never {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let output = Output(ok: ok, stage: stage)
    if let data = try? encoder.encode(output) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    }
    exit(ok ? 0 : 1)
}

private func axCopy<T>(_ element: AXUIElement, _ attribute: String) -> T? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
        return nil
    }
    return value as? T
}

private func axString(_ element: AXUIElement, _ attribute: String) -> String? {
    guard let value: CFTypeRef = axCopy(element, attribute) else { return nil }
    if let text = value as? String { return text }
    if let number = value as? NSNumber { return number.stringValue }
    return nil
}

private func axBool(_ element: AXUIElement, _ attribute: String) -> Bool? {
    guard let value: CFTypeRef = axCopy(element, attribute) else { return nil }
    if let boolean = value as? Bool { return boolean }
    if let number = value as? NSNumber { return number.boolValue }
    return nil
}

private func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    axCopy(element, kAXChildrenAttribute as String) ?? []
}

private func axSheets(_ element: AXUIElement) -> [AXUIElement] {
    axCopy(element, axSheetsAttribute) ?? []
}

private func axRole(_ element: AXUIElement) -> String {
    axString(element, kAXRoleAttribute as String) ?? ""
}

private func axParent(_ element: AXUIElement) -> AXUIElement? {
    axCopy(element, kAXParentAttribute as String)
}

private func elementPID(_ element: AXUIElement) -> pid_t? {
    var pid: pid_t = 0
    return AXUIElementGetPid(element, &pid) == .success ? pid : nil
}

private func belongsTo(_ element: AXUIElement, pid: pid_t) -> Bool {
    elementPID(element) == pid
}

private func isVisible(_ element: AXUIElement) -> Bool {
    axBool(element, kAXHiddenAttribute as String) != true
}

private func isEnabled(_ element: AXUIElement) -> Bool {
    axBool(element, kAXEnabledAttribute as String) == true
}

private func supportsPress(_ element: AXUIElement) -> Bool {
    var actions: CFArray?
    guard AXUIElementCopyActionNames(element, &actions) == .success,
          let names = actions as? [String] else {
        return false
    }
    return names.contains(kAXPressAction as String)
}

private func normalized(_ text: String) -> String {
    text
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .lowercased()
}

private func directTexts(_ element: AXUIElement) -> [String] {
    [
        kAXTitleAttribute as String,
        kAXDescriptionAttribute as String,
        kAXValueAttribute as String,
        kAXPlaceholderValueAttribute as String,
        kAXHelpAttribute as String,
    ]
        .compactMap { axString(element, $0) }
        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
}

private func textInSubtree(_ root: AXUIElement, pid: pid_t, maxNodes: Int = 120) -> [String] {
    var queue: [AXUIElement] = [root]
    var seen: [AXUIElement] = []
    var texts: [String] = []
    var visited = 0

    while !queue.isEmpty && visited < maxNodes {
        let node = queue.removeFirst()
        if seen.contains(where: { $0 == node }) { continue }
        seen.append(node)
        visited += 1
        guard belongsTo(node, pid: pid), isVisible(node) else { continue }
        texts.append(contentsOf: directTexts(node))
        queue.append(contentsOf: axChildren(node))
    }
    return texts
}

private func visibleNodes(in roots: [AXUIElement], pid: pid_t, maxNodes: Int = 1_500) -> [AXUIElement] {
    var queue = roots
    var seen: [AXUIElement] = []
    var nodes: [AXUIElement] = []
    var visited = 0

    while !queue.isEmpty && visited < maxNodes {
        let node = queue.removeFirst()
        if seen.contains(where: { $0 == node }) { continue }
        seen.append(node)
        visited += 1
        guard belongsTo(node, pid: pid), isVisible(node) else { continue }
        nodes.append(node)
        queue.append(contentsOf: axChildren(node))
    }
    return nodes
}

private func isTrustedSystemSettingsHost(_ app: NSRunningApplication) -> Bool {
    guard let bundleID = app.bundleIdentifier,
          settingsBundleIDs.contains(bundleID),
          let executable = app.executableURL?.standardizedFileURL.path else {
        return false
    }
    return executable.hasPrefix("/System/")
}

private func isTrustedAppleIDSettingsExtension(_ app: NSRunningApplication) -> Bool {
    guard let path = app.executableURL?.standardizedFileURL.path else { return false }
    return appleIDSettingsExecutablePaths.contains(path)
}

private func isTrustedSystemSettings(_ app: NSRunningApplication) -> Bool {
    if isTrustedSystemSettingsHost(app) { return true }
    guard isTrustedAppleIDSettingsExtension(app) else { return false }
    return NSWorkspace.shared.runningApplications.filter(
        isTrustedAppleIDSettingsExtension
    ).count == 1
}

private func activeSystemSettings() -> NSRunningApplication? {
    let extensions = NSWorkspace.shared.runningApplications.filter(
        isTrustedAppleIDSettingsExtension
    )
    if extensions.count == 1 { return extensions[0] }
    if !extensions.isEmpty {
        // Multiple extension processes — fall back to the host app.
        logStep(10, "activeSettings: \(extensions.count) extension(s), falling back to host")
    }
    let hostMatches = NSWorkspace.shared.runningApplications.filter(isTrustedSystemSettingsHost)
    if hostMatches.count == 1 { return hostMatches[0] }
    if hostMatches.isEmpty {
        // Last resort: any running System Settings-like app.
        let anyMatch = NSWorkspace.shared.runningApplications.first { app in
            guard let bid = app.bundleIdentifier else { return false }
            return settingsBundleIDs.contains(bid)
        }
        if let app = anyMatch {
            logStep(11, "activeSettings: fallback to \(app.localizedName ?? "?") pid=\(app.processIdentifier)")
            return app
        }
    }
    logStep(12, "activeSettings: no match (hosts=\(hostMatches.count))")
    return nil
}

private func roots(for appElement: AXUIElement, pid: pid_t) -> [AXUIElement] {
    var roots: [AXUIElement] = []
    let focused: AXUIElement? = axCopy(appElement, kAXFocusedWindowAttribute as String)
    let main: AXUIElement? = axCopy(appElement, kAXMainWindowAttribute as String)
    let windows: [AXUIElement] = axCopy(appElement, kAXWindowsAttribute as String) ?? []

    for candidate in [focused, main].compactMap({ $0 }) + windows {
        guard let surface = activeSurfaceRoot(candidate, pid: pid) else { continue }
        if !roots.contains(where: { $0 == surface }) {
            roots.append(surface)
        }
    }
    if roots.isEmpty, let surface = activeSurfaceRoot(appElement, pid: pid) {
        roots.append(surface)
    }
    return roots
}

private func activeSurfaceRoot(_ root: AXUIElement, pid: pid_t) -> AXUIElement? {
    guard belongsTo(root, pid: pid), isVisible(root) else { return nil }
    let sheets = axSheets(root).filter {
        belongsTo($0, pid: pid) && isVisible($0)
    }
    if sheets.count > 1 { return nil }
    guard let sheet = sheets.first else { return root }
    return activeSurfaceRoot(sheet, pid: pid)
}

private func asciiDigits(in text: String) -> String {
    String(text.unicodeScalars.compactMap { scalar in
        guard scalar.value >= 48 && scalar.value <= 57 else { return nil }
        return Character(String(scalar))
    })
}

private func isSelectablePhoneControl(_ element: AXUIElement, pid: pid_t) -> Bool {
    let role = axRole(element)
    guard phoneControlRoles.contains(role) else {
        return false
    }
    // Static text rows and groups need explicit press support to confirm
    // they are interactive controls rather than passive labels.
    if role == "AXStaticText" || role == "AXGroup" {
        guard supportsPress(element) else { return false }
    }
    guard isEnabled(element) else { return false }
    let texts = textInSubtree(element, pid: pid)
    guard asciiDigits(in: texts.joined(separator: " ")).count >= 2 else { return false }
    return texts.contains { text in
        let value = normalized(text)
        return phoneMarkers.contains(where: value.contains)
    }
}

private func continueButton(in nodes: [AXUIElement]) -> AXUIElement? {
    let matches = nodes.filter { element in
        guard axRole(element) == kAXButtonRole as String,
              isEnabled(element),
              supportsPress(element) else {
            return false
        }
        return directTexts(element).contains { continueLabels.contains(normalized($0)) }
    }
    return matches.count == 1 ? matches[0] : nil
}

private func phoneSelection(in nodes: [AXUIElement], pid: pid_t) -> PhoneSelection? {
    let controls = nodes.filter { isSelectablePhoneControl($0, pid: pid) }
    guard !controls.isEmpty, let button = continueButton(in: nodes) else { return nil }
    return PhoneSelection(controls: controls, continueButton: button)
}

private func isTextInput(_ element: AXUIElement) -> Bool {
    let role = axRole(element)
    return role == kAXTextFieldRole as String || role == "AXSecureTextField"
}

private func isSearchField(_ element: AXUIElement) -> Bool {
    directTexts(element).contains { text in
        let value = normalized(text)
        return value.contains("search") || value.contains("\u{641C}\u{7D22}") || value.contains("\u{641C}\u{5C0B}")
    }
}

private func isSemanticCodeField(_ field: AXUIElement) -> Bool {
    var candidate: AXUIElement? = field
    for _ in 0..<5 {
        guard let current = candidate else { break }
        if directTexts(current).contains(where: { text in
            let value = normalized(text)
            return codeMarkers.contains(where: { value.contains($0) })
        }) {
            return true
        }
        candidate = axParent(current)
    }
    return false
}

private func axFrame(_ element: AXUIElement) -> CGRect? {
    var positionValue: CFTypeRef?
    var sizeValue: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionValue) == .success,
          AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeValue) == .success,
          let positionValue,
          let sizeValue,
          CFGetTypeID(positionValue) == AXValueGetTypeID(),
          CFGetTypeID(sizeValue) == AXValueGetTypeID() else {
        return nil
    }
    let position = positionValue as! AXValue
    let size = sizeValue as! AXValue
    var point = CGPoint.zero
    var dimensions = CGSize.zero
    guard AXValueGetValue(position, .cgPoint, &point),
          AXValueGetValue(size, .cgSize, &dimensions),
          point.x.isFinite,
          point.y.isFinite,
          dimensions.width > 0,
          dimensions.height > 0 else {
        return nil
    }
    return CGRect(origin: point, size: dimensions)
}

private func codeEntry(in nodes: [AXUIElement]) -> CodeEntry? {
    let fields = nodes.filter {
        isTextInput($0) &&
            isEnabled($0) &&
            !isSearchField($0) &&
            axChildren($0).isEmpty
    }
    guard !fields.isEmpty else { return nil }

    if fields.count == 1, isSemanticCodeField(fields[0]) {
        return .single(fields[0])
    }

    let semanticCodeFields = fields.filter(isSemanticCodeField)
    let codeFields = semanticCodeFields.count == 6
        ? semanticCodeFields
        : (fields.count == 6 ? fields : [])
    guard codeFields.count == 6 else { return nil }
    let framed = codeFields.compactMap { field -> (AXUIElement, CGRect)? in
        guard let frame = axFrame(field) else { return nil }
        return (field, frame)
    }
    guard framed.count == 6 else { return nil }

    let verticalSpread = framed.map { $0.1.midY }.max()! - framed.map { $0.1.midY }.min()!
    let height = framed.map { $0.1.height }.max()!
    guard verticalSpread <= max(12, height) else { return nil }
    return .six(framed.sorted { $0.1.minX < $1.1.minX }.map { $0.0 })
}

private func hasCodeDeliverySuffix(in nodes: [AXUIElement], pid: pid_t, suffix: String) -> Bool {
    let texts = nodes
        .filter { belongsTo($0, pid: pid) && isVisible($0) }
        .flatMap(directTexts)
    guard texts.contains(where: { text in
        let value = normalized(text)
        return codeMarkers.contains(where: value.contains)
    }) else {
        return false
    }
    let deliverySuffixes = Set(texts.compactMap { text -> String? in
        let value = normalized(text)
        guard phoneMarkers.contains(where: value.contains) else {
            return nil
        }
        let digits = asciiDigits(in: text)
        guard digits.count >= 2 else { return nil }
        return String(digits.suffix(2))
    })
    return deliverySuffixes.count == 1 && deliverySuffixes.contains(suffix)
}

private func setFocusedValue(
    _ element: AXUIElement,
    value: String,
    transitionSuffix: String? = nil
) -> Bool {
    _ = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    guard AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFString) == .success else {
        return false
    }
    usleep(transitionSuffix == nil ? 80_000 : 180_000)
    if axString(element, kAXValueAttribute as String) == value {
        return true
    }
    guard let suffix = transitionSuffix else { return false }
    return matchingCodeEntries(suffix: suffix).isEmpty
}

private func selected(_ element: AXUIElement) -> Bool {
    axBool(element, kAXValueAttribute as String) == true
}

private func selectPhone(_ control: AXUIElement) -> Bool {
    if selected(control) { return true }
    guard AXUIElementPerformAction(control, kAXPressAction as CFString) == .success else {
        return false
    }
    usleep(100_000)
    return selected(control)
}

private func readManualCodeFromStandardInput() -> String? {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard data.count <= 64,
          let input = String(data: data, encoding: .utf8) else {
        return nil
    }
    let code = input.trimmingCharacters(in: .whitespacesAndNewlines)
    return code.range(of: #"^[0-9]{6}$"#, options: .regularExpression) != nil ? code : nil
}

private func matchingCodeEntries(suffix: String) -> [(SettingsSnapshot, CodeEntry)] {
    currentSnapshots().compactMap { snapshot -> (SettingsSnapshot, CodeEntry)? in
        guard let entry = codeEntry(in: snapshot.nodes),
              hasCodeDeliverySuffix(in: snapshot.nodes, pid: snapshot.pid, suffix: suffix) else {
            return nil
        }
        return (snapshot, entry)
    }
}

private func parseArguments() -> (phase: String?, suffix: String?) {
    var phase: String?
    var suffix: String?
    var index = 1
    let arguments = CommandLine.arguments

    while index < arguments.count {
        if arguments[index] == "--phase", index + 1 < arguments.count {
            phase = arguments[index + 1]
            index += 2
            continue
        }
        if arguments[index] == "--suffix", index + 1 < arguments.count {
            suffix = arguments[index + 1]
            index += 2
            continue
        }
        index += 1
    }
    return (phase, suffix)
}

private func currentSnapshots() -> [SettingsSnapshot] {
    guard let app = activeSystemSettings() else { return [] }
    let pid = app.processIdentifier
    let appElement = AXUIElementCreateApplication(pid)
    let roots = roots(for: appElement, pid: pid)
    return roots.map { root in
        SettingsSnapshot(pid: pid, nodes: visibleNodes(in: [root], pid: pid))
    }.filter { !$0.nodes.isEmpty }
}

let arguments = parseArguments()
guard let phase = arguments.phase else {
    emit(false, "unknown_phase")
}
guard AXIsProcessTrusted() else {
    emit(false, "accessibility_unavailable")
}

switch phase {
case "sms-state":
    guard let suffix = arguments.suffix,
          suffix.range(of: #"^[0-9]{2}$"#, options: .regularExpression) != nil else {
        emit(false, "suffix_invalid")
    }
    let snapshots = currentSnapshots()
    logStep(1, "sms-state: \(snapshots.count) surface(s), \(snapshots.map { $0.nodes.count }.reduce(0, +)) node(s)")
    guard !snapshots.isEmpty else {
        emit(true, "waiting")
    }
    let codeSnapshots = snapshots.filter {
        codeEntry(in: $0.nodes) != nil &&
            hasCodeDeliverySuffix(in: $0.nodes, pid: $0.pid, suffix: suffix)
    }
    let phoneSnapshots = snapshots.filter {
        phoneSelection(in: $0.nodes, pid: $0.pid) != nil
    }
    logStep(2, "sms-state: code=\(codeSnapshots.count) phone=\(phoneSnapshots.count)")
    if codeSnapshots.count == 1, phoneSnapshots.isEmpty {
        emit(true, "code_entry")
    }
    if phoneSnapshots.count == 1, codeSnapshots.isEmpty {
        emit(true, "phone_selection")
    }
    emit(true, "waiting")

case "sms-select":
    guard let suffix = arguments.suffix,
          suffix.range(of: #"^[0-9]{2}$"#, options: .regularExpression) != nil else {
        emit(false, "suffix_invalid")
    }
    let selections = currentSnapshots().compactMap { snapshot -> (SettingsSnapshot, PhoneSelection)? in
        guard let selection = phoneSelection(in: snapshot.nodes, pid: snapshot.pid) else {
            return nil
        }
        return (snapshot, selection)
    }
    logStep(3, "sms-select: \(selections.count) selection surface(s)")
    guard selections.count == 1 else {
        emit(false, "phone_selection_unavailable")
    }
    let selectionSnapshot = selections[0].0
    let selection = selections[0].1
    logStep(4, "sms-select: \(selection.controls.count) phone control(s), suffix=\(suffix)")
    let matches = selection.controls.filter { control in
        textInSubtree(control, pid: selectionSnapshot.pid).contains { text in
            asciiDigits(in: text).hasSuffix(suffix)
        }
    }
    guard matches.count == 1 else {
        emit(false, matches.isEmpty ? "phone_not_matched" : "phone_not_unique")
    }
    guard selectPhone(matches[0]) else {
        emit(false, "selection_not_confirmed")
    }
    logStep(5, "sms-select: phone selected")
    emit(true, "selected")

case "sms-continue":
    guard let suffix = arguments.suffix,
          suffix.range(of: #"^[0-9]{2}$"#, options: .regularExpression) != nil else {
        emit(false, "phone_selection_unavailable")
    }
    let selections = currentSnapshots().compactMap { snapshot -> (SettingsSnapshot, PhoneSelection)? in
        guard let selection = phoneSelection(in: snapshot.nodes, pid: snapshot.pid) else {
            return nil
        }
        return (snapshot, selection)
    }
    guard selections.count == 1 else {
        emit(false, "selection_not_confirmed")
    }
    let selectionSnapshot = selections[0].0
    let selection = selections[0].1
    let selectedMatches = selection.controls.filter { control in
        selected(control) && textInSubtree(control, pid: selectionSnapshot.pid).contains { text in
            asciiDigits(in: text).hasSuffix(suffix)
        }
    }
    guard selectedMatches.count == 1,
          selection.controls.filter(selected).count == 1 else {
        emit(false, "selection_not_confirmed")
    }
    guard AXUIElementPerformAction(selection.continueButton, kAXPressAction as CFString) == .success else {
        emit(false, "continue_failed")
    }
    logStep(6, "sms-continue: button pressed")
    emit(true, "continued")

case "sms-code":
    guard let suffix = arguments.suffix,
          suffix.range(of: #"^[0-9]{2}$"#, options: .regularExpression) != nil else {
        emit(false, "suffix_invalid")
    }
    guard let code = readManualCodeFromStandardInput() else {
      emit(false, "manual_code_invalid")
    }
    let entries = matchingCodeEntries(suffix: suffix)
    logStep(7, "sms-code: \(entries.count) code entry match(es)")
    guard entries.count == 1 else {
        emit(false, "code_entry_unavailable")
    }
    let filled: Bool
    switch entries[0].1 {
    case .single(let field):
        filled = setFocusedValue(field, value: code, transitionSuffix: suffix)
    case .six(let fields):
        var wroteAllDigits = true
        for (index, field) in fields.enumerated() {
            let digitIndex = code.index(code.startIndex, offsetBy: index)
            let transitionSuffix = index == fields.count - 1 ? suffix : nil
            if !setFocusedValue(
                field,
                value: String(code[digitIndex]),
                transitionSuffix: transitionSuffix
            ) {
                wroteAllDigits = false
                break
            }
        }
        filled = wroteAllDigits
    }
    guard filled else {
        emit(false, "code_write_failed")
    }
    emit(true, "code_submitted")

default:
    emit(false, "unknown_phase")
}
