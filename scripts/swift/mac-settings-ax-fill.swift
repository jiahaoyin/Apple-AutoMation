#!/usr/bin/env swift
// mac-settings-ax-fill — 直接 AX API 填 System Settings 登录框
// 用法:
//   mac-settings-ax-fill --phase email
//   mac-settings-ax-fill --phase continue
//   mac-settings-ax-fill --phase password
//   mac-settings-ax-fill --phase dump
// JSON → stdout；[step N] → stderr

import ApplicationServices
import AppKit
import Foundation

struct Output: Codable {
    let ok: Bool
    let phase: String
    let message: String
    let textFieldCount: Int?
    let loginState: String?
    let inputRoute: String?

    init(
        ok: Bool,
        phase: String,
        message: String,
        textFieldCount: Int?,
        loginState: String? = nil,
        inputRoute: String? = nil
    ) {
        self.ok = ok
        self.phase = phase
        self.message = message
        self.textFieldCount = textFieldCount
        self.loginState = loginState
        self.inputRoute = inputRoute
    }
}

let settingsBundleIds = ["com.apple.systempreferences", "com.apple.SystemSettings"]

// These AX identifiers are stable across the English and Chinese System
// Settings login surfaces observed on macOS 15. Field position is not: the
// sidebar search field and retained username field pollute ordinal scans after
// the login UI rehydrates.
let usernameFieldIdentifier = "USERNAME_TEXT_FIELD"
let passwordFieldIdentifier = "PASSWORD_TEXT_FIELD"
let loginButtonIdentifier = "LOGIN_BUTTON"

let loginWindowMarkers = [
    "一个账户", "尽享 Apple", "电子邮件或电话号码",
    "Email or phone", "Email or Phone", "Sign in to your Apple",
    "登录", "登入", "Sign In", "Sign in",
]

func logStep(_ n: Int, _ msg: String) {
    FileHandle.standardError.write("[step \(n)] \(msg)\n".data(using: .utf8)!)
}

func axCopy<T>(_ element: AXUIElement, _ attr: String) -> T? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attr as CFString, &value) == .success else { return nil }
    return value as? T
}

func axString(_ element: AXUIElement, _ attr: String) -> String? {
    guard let v: CFTypeRef = axCopy(element, attr) else { return nil }
    if let s = v as? String { return s }
    if let n = v as? NSNumber { return n.stringValue }
    return nil
}

func axBool(_ element: AXUIElement, _ attr: String) -> Bool? {
    guard let v: CFTypeRef = axCopy(element, attr) else { return nil }
    if let b = v as? Bool { return b }
    if let n = v as? NSNumber { return n.boolValue }
    return nil
}

func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    axCopy(element, kAXChildrenAttribute as String) ?? []
}

func axRole(_ element: AXUIElement) -> String {
    axString(element, kAXRoleAttribute as String) ?? ""
}

func axDescription(_ element: AXUIElement) -> String {
    [kAXDescriptionAttribute, kAXTitleAttribute, kAXRoleDescriptionAttribute, kAXPlaceholderValueAttribute]
        .compactMap { axString(element, $0 as String)?.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
        .joined(separator: " | ")
}

func axIdentifier(_ element: AXUIElement) -> String {
    axString(element, kAXIdentifierAttribute as String)?
        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
}

func isTextInput(_ element: AXUIElement) -> Bool {
    let role = axRole(element)
    return role == kAXTextFieldRole as String || role == "AXSecureTextField"
}

func isVisible(_ element: AXUIElement) -> Bool {
    axBool(element, kAXHiddenAttribute as String) != true
}

func isSearchField(_ element: AXUIElement) -> Bool {
    let desc = axDescription(element)
    return desc.contains("搜索") || desc.contains("Search")
}

func isContainerRole(_ role: String) -> Bool {
    [kAXGroupRole, kAXScrollAreaRole, kAXSplitGroupRole, kAXTabGroupRole, kAXSplitterRole, kAXWindowRole, kAXSheetRole]
        .map { $0 as String }
        .contains(role)
}

struct FieldHit {
    let element: AXUIElement
}

enum LoginState: String {
    case email
    case password
}

struct LoginControlHit {
    let window: AXUIElement
    let element: AXUIElement
}

func axElementsEqual(_ lhs: AXUIElement, _ rhs: AXUIElement) -> Bool {
    CFEqual(lhs, rhs)
}

func bfsElements(root: AXUIElement, maxNodes: Int = 600) -> [AXUIElement] {
    var queue: [AXUIElement] = [root]
    var elements: [AXUIElement] = []
    var visited = 0

    while !queue.isEmpty && visited < maxNodes {
        let node = queue.removeFirst()
        visited += 1
        elements.append(node)
        queue.append(contentsOf: axChildren(node))
    }
    return elements
}

func matchingLoginControls(
    in window: AXUIElement,
    identifier: String,
    matches: (AXUIElement) -> Bool
) -> [AXUIElement] {
    bfsElements(root: window).filter {
        isVisible($0) && axIdentifier($0) == identifier && matches($0)
    }
}

func windowMatchesLoginState(_ window: AXUIElement, state: LoginState) -> Bool {
    guard isVisible(window), axBool(window, kAXMinimizedAttribute as String) != true else {
        return false
    }

    let username = matchingLoginControls(
        in: window,
        identifier: usernameFieldIdentifier,
        matches: isTextInput
    )
    let password = matchingLoginControls(
        in: window,
        identifier: passwordFieldIdentifier,
        matches: isTextInput
    )
    let loginButtons = matchingLoginControls(
        in: window,
        identifier: loginButtonIdentifier,
        matches: { axRole($0) == kAXButtonRole as String }
    )

    guard loginButtons.count == 1 else { return false }
    switch state {
    case .email:
        return username.count == 1 && password.isEmpty
    case .password:
        // macOS 15.6 can remove USERNAME_TEXT_FIELD after Continue. The
        // password field and submit button remain the unique state anchors.
        return username.count <= 1 && password.count == 1
    }
}

func loginWindows(appElement: AXUIElement, state: LoginState) -> [AXUIElement] {
    var windows: [AXUIElement] = axCopy(appElement, kAXWindowsAttribute as String) ?? []
    let focused: AXUIElement? = axCopy(appElement, kAXFocusedWindowAttribute as String)
    let main: AXUIElement? = axCopy(appElement, kAXMainWindowAttribute as String)
    for candidate in [focused, main].compactMap({ $0 }) where !windows.contains(where: { axElementsEqual($0, candidate) }) {
        windows.append(candidate)
    }
    return windows.filter { windowMatchesLoginState($0, state: state) }
}

func findLoginWindow(appElement: AXUIElement, state: LoginState) -> AXUIElement? {
    guard activeSettingsApp(for: appElement) != nil,
          let focusedWindow: AXUIElement = axCopy(appElement, kAXFocusedWindowAttribute as String) else {
        return nil
    }
    let candidates = loginWindows(appElement: appElement, state: state)
    guard candidates.count == 1, axElementsEqual(candidates[0], focusedWindow) else { return nil }
    return candidates[0]
}

func waitForLoginWindow(
    appElement: AXUIElement,
    state: LoginState,
    timeoutMs: UInt32 = 12_000
) -> AXUIElement? {
    let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1_000)
    while true {
        if let window = findLoginWindow(appElement: appElement, state: state) {
            return window
        }
        if Date() >= deadline { return nil }
        usleep(120_000)
    }
}

func currentLoginState(appElement: AXUIElement) -> LoginState? {
    let emailWindow = findLoginWindow(appElement: appElement, state: .email)
    let passwordWindow = findLoginWindow(appElement: appElement, state: .password)
    if emailWindow != nil && passwordWindow == nil { return .email }
    if passwordWindow != nil && emailWindow == nil { return .password }
    return nil
}

func waitForAnyLoginState(
    appElement: AXUIElement,
    timeoutMs: UInt32 = 12_000
) -> LoginState? {
    let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1_000)
    while true {
        if let state = currentLoginState(appElement: appElement) {
            return state
        }
        if Date() >= deadline { return nil }
        usleep(120_000)
    }
}

func findLoginControl(
    appElement: AXUIElement,
    state: LoginState,
    identifier: String,
    matches: (AXUIElement) -> Bool
) -> LoginControlHit? {
    guard let window = findLoginWindow(appElement: appElement, state: state) else { return nil }
    let controls = matchingLoginControls(in: window, identifier: identifier, matches: matches)
    guard controls.count == 1 else { return nil }
    return LoginControlHit(window: window, element: controls[0])
}

func waitForLoginControl(
    appElement: AXUIElement,
    state: LoginState,
    identifier: String,
    timeoutMs: UInt32 = 12_000,
    requireEnabled: Bool = false,
    matches: (AXUIElement) -> Bool
) -> LoginControlHit? {
    let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1_000)
    while true {
        if let hit = findLoginControl(
            appElement: appElement,
            state: state,
            identifier: identifier,
            matches: matches
        ) {
            if !requireEnabled || axBool(hit.element, kAXEnabledAttribute as String) == true {
                return hit
            }
        }
        if Date() >= deadline { return nil }
        usleep(120_000)
    }
}

func waitForLoginTextField(
    appElement: AXUIElement,
    state: LoginState,
    identifier: String
) -> LoginControlHit? {
    waitForLoginControl(
        appElement: appElement,
        state: state,
        identifier: identifier,
        requireEnabled: true,
        matches: isTextInput
    )
}

func pressLoginButton(appElement: AXUIElement, state: LoginState) -> Bool {
    guard waitForLoginControl(
        appElement: appElement,
        state: state,
        identifier: loginButtonIdentifier,
        requireEnabled: true,
        matches: { axRole($0) == kAXButtonRole as String }
    ) != nil else {
        return false
    }
    guard let liveHit = findLoginControl(
        appElement: appElement,
        state: state,
        identifier: loginButtonIdentifier,
        matches: { axRole($0) == kAXButtonRole as String }
    ), axBool(liveHit.element, kAXEnabledAttribute as String) == true else {
        return false
    }
    return AXUIElementPerformAction(liveHit.element, kAXPressAction as CFString) == .success
}

func bfsTextFields(root: AXUIElement, maxNodes: Int = 500) -> [FieldHit] {
    var queue: [AXUIElement] = [root]
    var hits: [FieldHit] = []
    var visited = 0
    while !queue.isEmpty && visited < maxNodes {
        let node = queue.removeFirst()
        visited += 1
        if isTextInput(node), !isSearchField(node) {
            hits.append(FieldHit(element: node))
        }
        if isContainerRole(axRole(node)) || visited == 1 {
            queue.append(contentsOf: axChildren(node))
        }
    }
    return hits
}

func findSettingsApp() -> NSRunningApplication? {
    for app in NSWorkspace.shared.runningApplications {
        if let bid = app.bundleIdentifier, settingsBundleIds.contains(bid) { return app }
    }
    return NSWorkspace.shared.runningApplications.first {
        let n = $0.localizedName ?? ""
        return n.contains("System Settings") || n.contains("系统设置")
    }
}

func isEnabledAndFocused(_ field: AXUIElement) -> Bool {
    axBool(field, kAXEnabledAttribute as String) == true &&
        axBool(field, kAXFocusedAttribute as String) == true
}

func activeSettingsApp(for appElement: AXUIElement) -> NSRunningApplication? {
    var pid: pid_t = 0
    guard AXUIElementGetPid(appElement, &pid) == .success,
          let app = NSRunningApplication(processIdentifier: pid),
          let bundleID = app.bundleIdentifier,
          settingsBundleIds.contains(bundleID),
          app.isActive else {
        return nil
    }
    return app
}

func activeFocusedLoginControl(
    appElement: AXUIElement,
    state: LoginState,
    identifier: String,
    matches: (AXUIElement) -> Bool
) -> LoginControlHit? {
    guard activeSettingsApp(for: appElement) != nil,
          let hit = findLoginControl(
              appElement: appElement,
              state: state,
              identifier: identifier,
              matches: matches
          ),
          let focusedWindow: AXUIElement = axCopy(appElement, kAXFocusedWindowAttribute as String),
          axElementsEqual(focusedWindow, hit.window) else {
        return nil
    }
    return hit
}

func resolveFocusedLoginTextField(
    appElement: AXUIElement,
    state: LoginState,
    identifier: String
) -> LoginControlHit? {
    guard waitForLoginTextField(
        appElement: appElement,
        state: state,
        identifier: identifier
    ) != nil else {
        return nil
    }
    guard let liveHit = activeFocusedLoginControl(
        appElement: appElement,
        state: state,
        identifier: identifier,
        matches: isTextInput
    ), axBool(liveHit.element, kAXEnabledAttribute as String) == true else {
        return nil
    }
    _ = AXUIElementPerformAction(liveHit.element, kAXRaiseAction as CFString)
    usleep(120_000)

    guard let readyHit = activeFocusedLoginControl(
        appElement: appElement,
        state: state,
        identifier: identifier,
        matches: isTextInput
    ), axBool(readyHit.element, kAXEnabledAttribute as String) == true else {
        return nil
    }
    guard AXUIElementSetAttributeValue(
        readyHit.element,
        kAXFocusedAttribute as CFString,
        kCFBooleanTrue
    ) == .success else {
        return nil
    }
    usleep(80_000)

    guard let focusedHit = activeFocusedLoginControl(
        appElement: appElement,
        state: state,
        identifier: identifier,
        matches: isTextInput
    ), isEnabledAndFocused(focusedHit.element) else {
        return nil
    }
    return focusedHit
}

func valueMatchesRequest(_ field: AXUIElement, _ text: String, isEmail: Bool) -> Bool {
    guard let value = axString(field, kAXValueAttribute as String) else { return false }
    if isEmail {
        return value.trimmingCharacters(in: .whitespacesAndNewlines) == text
    }
    return value.count >= min(4, text.count)
}

func postUnicodeText(_ text: String) -> Bool {
    guard !text.isEmpty,
          let source = CGEventSource(stateID: .hidSystemState) else {
        return false
    }

    for character in text {
        let codeUnits = Array(String(character).utf16)
        guard let down = CGEvent(
                  keyboardEventSource: source,
                  virtualKey: 0,
                  keyDown: true
              ),
              let up = CGEvent(
                  keyboardEventSource: source,
                  virtualKey: 0,
                  keyDown: false
              ) else {
            return false
        }
        codeUnits.withUnsafeBufferPointer { buffer in
            down.keyboardSetUnicodeString(
                stringLength: codeUnits.count,
                unicodeString: buffer.baseAddress
            )
            up.keyboardSetUnicodeString(
                stringLength: codeUnits.count,
                unicodeString: buffer.baseAddress
            )
        }
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
        usleep(8_000)
    }
    return true
}

struct LoginValueInputResult {
    let ok: Bool
    let route: String?
    let reason: String
}

func waitForLoginValueMatch(
    appElement: AXUIElement,
    state: LoginState,
    identifier: String,
    text: String,
    isEmail: Bool,
    previousValue: String? = nil,
    requireValueChange: Bool = false,
    timeoutMs: UInt32 = 1_500
) -> Bool {
    let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1_000)
    while true {
        if let hit = activeFocusedLoginControl(
            appElement: appElement,
            state: state,
            identifier: identifier,
            matches: isTextInput
        ), valueMatchesRequest(hit.element, text, isEmail: isEmail) {
            if !requireValueChange ||
               axString(hit.element, kAXValueAttribute as String) != previousValue {
                return true
            }
        }
        if Date() >= deadline { return false }
        usleep(120_000)
    }
}

func waitForExactLoginValue(
    appElement: AXUIElement,
    state: LoginState,
    identifier: String,
    expectedValue: String,
    timeoutMs: UInt32 = 1_000
) -> Bool {
    let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1_000)
    while true {
        if let hit = activeFocusedLoginControl(
            appElement: appElement,
            state: state,
            identifier: identifier,
            matches: isTextInput
        ), axString(hit.element, kAXValueAttribute as String) == expectedValue {
            return true
        }
        if Date() >= deadline { return false }
        usleep(120_000)
    }
}

func focusAndSetLoginValue(
    appElement: AXUIElement,
    state: LoginState,
    identifier: String,
    text: String,
    isEmail: Bool
) -> LoginValueInputResult {
    guard waitForLoginTextField(
        appElement: appElement,
        state: state,
        identifier: identifier
    ) != nil,
          let liveHit = activeFocusedLoginControl(
              appElement: appElement,
              state: state,
              identifier: identifier,
              matches: isTextInput
          ),
          axBool(liveHit.element, kAXEnabledAttribute as String) == true else {
        return LoginValueInputResult(
            ok: false,
            route: nil,
            reason: "target_unavailable_before_write"
        )
    }

    // An exact email value can be reused. A secure field only exposes a masked
    // length, so an existing password value can never prove it is this run's
    // credential and must not be submitted as-is.
    if isEmail && valueMatchesRequest(liveHit.element, text, isEmail: true) {
        return LoginValueInputResult(
            ok: true,
            route: "existing_value",
            reason: "verified"
        )
    }

    // Email fields must use real keyboard events. Setting AXValue alone does
    // not trigger the System Settings form validation that enables the Continue
    // button. Keyboard input produces the keystrokes that the form listens for.
    //
    // IMPORTANT: Do not use postCmdA() (Command+A) to select existing text in
    // System Settings. The global Cmd+A shortcut can be intercepted by the app
    // and cause the login pane to render blank. Instead, clear the field via AX
    // before typing the new value.
    if isEmail {
        let originalEmailValue = axString(liveHit.element, kAXValueAttribute as String)

        // Focus the text field, clear any existing content via AX, then type
        // the email through the HID event tap.
        if let keyboardHit = resolveFocusedLoginTextField(
            appElement: appElement,
            state: state,
            identifier: identifier
        ), isEnabledAndFocused(keyboardHit.element) {
            // Clear existing content so typing replaces it cleanly.
            // Uses the official AX API: setting kAXValueAttribute to ""
            // on a focused NSAccessibilityTextField is the standard way to
            // clear it before keyboard input.
            let beforeClear = axString(keyboardHit.element, kAXValueAttribute as String)
            if let beforeClear, !beforeClear.isEmpty {
                let cleared = AXUIElementSetAttributeValue(
                    keyboardHit.element,
                    kAXValueAttribute as CFString,
                    "" as CFString
                ) == .success
                if cleared {
                    _ = waitForExactLoginValue(
                        appElement: appElement,
                        state: state,
                        identifier: identifier,
                        expectedValue: ""
                    )
                }
                // If clear fails, continue with typing anyway — partial
                // overlap is better than failing the entire email phase.
                usleep(60_000)
            }

            if let beforeTypeHit = activeFocusedLoginControl(
                appElement: appElement,
                state: state,
                identifier: identifier,
                matches: isTextInput
            ), isEnabledAndFocused(beforeTypeHit.element),
               postUnicodeText(text),
               waitForLoginValueMatch(
                   appElement: appElement,
                   state: state,
                   identifier: identifier,
                   text: text,
                   isEmail: true,
                   previousValue: originalEmailValue,
                   requireValueChange: false
               ) {
                return LoginValueInputResult(
                    ok: true,
                    route: "keyboard",
                    reason: "verified"
                )
            }
        }
        // Keyboard path did not confirm the value. Try AXValue as a fallback
        // so the credential is at least visible for manual inspection.
        let beforeAxFallback = originalEmailValue ?? ""
        let axResult = AXUIElementSetAttributeValue(
            liveHit.element,
            kAXValueAttribute as CFString,
            text as CFString
        )
        if axResult == .success,
           waitForLoginValueMatch(
               appElement: appElement,
               state: state,
               identifier: identifier,
               text: text,
               isEmail: true,
               previousValue: beforeAxFallback,
               requireValueChange: false
           ) {
            return LoginValueInputResult(
                ok: true,
                route: "ax_value",
                reason: "verified"
            )
        }
        return LoginValueInputResult(
            ok: false,
            route: axResult == .success ? "ax_value" : nil,
            reason: axResult == .success
                ? "ax_value_unconfirmed"
                : "keyboard_unconfirmed"
        )
    }

    // --- Password path (AXValue-first, keyboard fallback) ---

    let originalValue = axString(liveHit.element, kAXValueAttribute as String)
    var valueBeforeWrite = originalValue
    if let originalValue, !originalValue.isEmpty {
        let clearResult = AXUIElementSetAttributeValue(
            liveHit.element,
            kAXValueAttribute as CFString,
            "" as CFString
        )
        guard clearResult == .success,
              waitForExactLoginValue(
                  appElement: appElement,
                  state: state,
                  identifier: identifier,
                  expectedValue: ""
              ) else {
            return LoginValueInputResult(
                ok: false,
                route: clearResult == .success ? "ax_value" : nil,
                reason: clearResult == .success
                    ? "ax_value_unconfirmed"
                    : "keyboard_fallback_unsafe"
            )
        }
        valueBeforeWrite = ""
    }

    let axWriteResult = AXUIElementSetAttributeValue(
        liveHit.element,
        kAXValueAttribute as CFString,
        text as CFString
    )
    if axWriteResult == .success,
       waitForLoginValueMatch(
           appElement: appElement,
           state: state,
           identifier: identifier,
           text: text,
           isEmail: false,
           previousValue: valueBeforeWrite,
           requireValueChange: true
       ) {
        return LoginValueInputResult(
            ok: true,
            route: "ax_value",
            reason: "verified"
        )
    }

    guard let currentHit = activeFocusedLoginControl(
        appElement: appElement,
        state: state,
        identifier: identifier,
        matches: isTextInput
    ), let valueBeforeWrite,
       let currentValue = axString(
           currentHit.element,
           kAXValueAttribute as String
       ), currentValue == valueBeforeWrite,
       let keyboardHit = resolveFocusedLoginTextField(
           appElement: appElement,
           state: state,
           identifier: identifier
       ),
       axString(keyboardHit.element, kAXValueAttribute as String) == valueBeforeWrite else {
        return LoginValueInputResult(
            ok: false,
            route: axWriteResult == .success ? "ax_value" : nil,
            reason: axWriteResult == .success
                ? "ax_value_unconfirmed"
                : "keyboard_fallback_unsafe"
        )
    }

    // Field is already empty from the clear above; no need for postCmdA().
    usleep(100_000)
    guard let beforeTypeHit = activeFocusedLoginControl(
        appElement: appElement,
        state: state,
        identifier: identifier,
        matches: isTextInput
    ), isEnabledAndFocused(beforeTypeHit.element),
       axString(beforeTypeHit.element, kAXValueAttribute as String) == valueBeforeWrite,
       postUnicodeText(text) else {
        return LoginValueInputResult(
            ok: false,
            route: "keyboard",
            reason: "keyboard_target_changed"
        )
    }

    if waitForLoginValueMatch(
        appElement: appElement,
        state: state,
        identifier: identifier,
        text: text,
        isEmail: false,
        previousValue: valueBeforeWrite,
        requireValueChange: true
    ) {
        return LoginValueInputResult(
            ok: true,
            route: "keyboard",
            reason: "verified"
        )
    }
    return LoginValueInputResult(
        ok: false,
        route: "keyboard",
        reason: "keyboard_unconfirmed"
    )
}

func emit(_ output: Output) -> Never {
    let enc = JSONEncoder()
    enc.outputFormatting = [.sortedKeys]
    if let data = try? enc.encode(output) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    }
    exit(output.ok ? 0 : 1)
}

var phase = "all"
var i = 1
let args = CommandLine.arguments
while i < args.count {
    if args[i] == "--phase", i + 1 < args.count { phase = args[i + 1]; i += 2; continue }
    i += 1
}

logStep(1, "activating System Settings")
_ = NSWorkspace.shared.launchApplication(
    withBundleIdentifier: "com.apple.systempreferences",
    options: [],
    additionalEventParamDescriptor: nil,
    launchIdentifier: nil
)
usleep(900_000)

guard let app = findSettingsApp() else {
    emit(Output(ok: false, phase: phase, message: "System Settings process not found", textFieldCount: nil))
}

app.activate(options: [.activateIgnoringOtherApps])
usleep(700_000)

let appElement = AXUIElementCreateApplication(app.processIdentifier)
logStep(2, "found System Settings pid=\(app.processIdentifier)")

if phase == "state" || phase == "dump" {
    guard let state = waitForAnyLoginState(appElement: appElement) else {
        emit(
            Output(
                ok: false,
                phase: phase,
                message: "login_state_unknown",
                textFieldCount: nil,
                loginState: "unknown"
            )
        )
    }
    guard let stateWindow = findLoginWindow(appElement: appElement, state: state) else {
        emit(
            Output(
                ok: false,
                phase: phase,
                message: "login_state_unknown",
                textFieldCount: nil,
                loginState: "unknown"
            )
        )
    }
    emit(
        Output(
            ok: true,
            phase: phase,
            message: "ok",
            textFieldCount: bfsTextFields(root: stateWindow).count,
            loginState: state.rawValue
        )
    )
}

let initialState: LoginState = phase == "password" ? .password : .email
guard let window = waitForLoginWindow(appElement: appElement, state: initialState) else {
    emit(Output(ok: false, phase: phase, message: "login window not found", textFieldCount: nil))
}

logStep(3, "found login window")

let fields = bfsTextFields(root: window)
logStep(4, "BFS found \(fields.count) non-search text fields")

switch phase {
case "email":
    let email = ProcessInfo.processInfo.environment["APPLE_SCRIPT_APPLE_ID"] ?? ""
    guard !email.isEmpty else {
        emit(Output(ok: false, phase: phase, message: "missing email value", textFieldCount: fields.count))
    }
    guard waitForLoginTextField(
        appElement: appElement,
        state: .email,
        identifier: usernameFieldIdentifier
    ) != nil else {
        emit(Output(ok: false, phase: phase, message: "exact username field not found", textFieldCount: fields.count))
    }
    logStep(5, "filling email")
    let emailResult = focusAndSetLoginValue(
        appElement: appElement,
        state: .email,
        identifier: usernameFieldIdentifier,
        text: email,
        isEmail: true
    )
    guard emailResult.ok else {
        emit(
            Output(
                ok: false,
                phase: phase,
                message: emailResult.reason,
                textFieldCount: fields.count,
                loginState: LoginState.email.rawValue,
                inputRoute: emailResult.route
            )
        )
    }
    logStep(6, "email ok")
    emit(
        Output(
            ok: true,
            phase: phase,
            message: "ok",
            textFieldCount: fields.count,
            loginState: LoginState.email.rawValue,
            inputRoute: emailResult.route
        )
    )

case "continue":
    logStep(7, "clicking continue")
    guard pressLoginButton(appElement: appElement, state: .email) else {
        emit(Output(ok: false, phase: phase, message: "enabled login button not found", textFieldCount: fields.count))
    }
    logStep(8, "continue ok")
    emit(Output(ok: true, phase: phase, message: "ok", textFieldCount: fields.count))

case "password":
    let password = ProcessInfo.processInfo.environment["APPLE_SCRIPT_PASSWORD"] ?? ""
    guard !password.isEmpty else {
        emit(Output(ok: false, phase: phase, message: "missing password value", textFieldCount: fields.count))
    }
    guard waitForLoginTextField(
        appElement: appElement,
        state: .password,
        identifier: passwordFieldIdentifier
    ) != nil else {
        emit(Output(ok: false, phase: phase, message: "exact password field not found", textFieldCount: fields.count))
    }
    logStep(9, "filling password")
    let passwordResult = focusAndSetLoginValue(
        appElement: appElement,
        state: .password,
        identifier: passwordFieldIdentifier,
        text: password,
        isEmail: false
    )
    guard passwordResult.ok else {
        emit(
            Output(
                ok: false,
                phase: phase,
                message: passwordResult.reason,
                textFieldCount: fields.count,
                loginState: LoginState.password.rawValue,
                inputRoute: passwordResult.route
            )
        )
    }
    logStep(10, "password ok")
    guard pressLoginButton(appElement: appElement, state: .password) else {
        emit(
            Output(
                ok: false,
                phase: phase,
                message: "enabled login button not found after password",
                textFieldCount: fields.count,
                loginState: LoginState.password.rawValue,
                inputRoute: passwordResult.route
            )
        )
    }
    logStep(11, "submit clicked")
    emit(
        Output(
            ok: true,
            phase: phase,
            message: "ok",
            textFieldCount: fields.count,
            loginState: LoginState.password.rawValue,
            inputRoute: passwordResult.route
        )
    )

case "all":
    let appleId = ProcessInfo.processInfo.environment["APPLE_SCRIPT_APPLE_ID"] ?? ""
    let password = ProcessInfo.processInfo.environment["APPLE_SCRIPT_PASSWORD"] ?? ""
    guard !appleId.isEmpty else {
        emit(Output(ok: false, phase: phase, message: "missing apple id", textFieldCount: fields.count))
    }
    guard !password.isEmpty else {
        emit(Output(ok: false, phase: phase, message: "missing password value", textFieldCount: fields.count))
    }
    guard waitForLoginTextField(
        appElement: appElement,
        state: .email,
        identifier: usernameFieldIdentifier
    ) != nil else {
        emit(Output(ok: false, phase: phase, message: "exact username field not found", textFieldCount: fields.count))
    }
    logStep(5, "filling email (all phase)")
    let emailResult = focusAndSetLoginValue(
        appElement: appElement,
        state: .email,
        identifier: usernameFieldIdentifier,
        text: appleId,
        isEmail: true
    )
    guard emailResult.ok else {
        emit(
            Output(
                ok: false,
                phase: phase,
                message: emailResult.reason,
                textFieldCount: fields.count,
                loginState: LoginState.email.rawValue,
                inputRoute: emailResult.route
            )
        )
    }
    logStep(6, "email ok — clicking continue")
    guard pressLoginButton(appElement: appElement, state: .email) else {
        emit(Output(ok: false, phase: phase, message: "enabled login button not found", textFieldCount: fields.count))
    }
    guard waitForLoginTextField(
        appElement: appElement,
        state: .password,
        identifier: passwordFieldIdentifier
    ) != nil else {
        emit(Output(ok: false, phase: phase, message: "exact password field not found", textFieldCount: fields.count))
    }
    logStep(9, "filling password (all phase)")
    let passwordResult = focusAndSetLoginValue(
        appElement: appElement,
        state: .password,
        identifier: passwordFieldIdentifier,
        text: password,
        isEmail: false
    )
    guard passwordResult.ok else {
        emit(
            Output(
                ok: false,
                phase: phase,
                message: passwordResult.reason,
                textFieldCount: fields.count,
                loginState: LoginState.password.rawValue,
                inputRoute: passwordResult.route
            )
        )
    }
    logStep(10, "password ok")
    guard pressLoginButton(appElement: appElement, state: .password) else {
        emit(
            Output(
                ok: false,
                phase: phase,
                message: "enabled login button not found after password",
                textFieldCount: fields.count,
                loginState: LoginState.password.rawValue,
                inputRoute: passwordResult.route
            )
        )
    }
    emit(
        Output(
            ok: true,
            phase: phase,
            message: "ok",
            textFieldCount: fields.count,
            loginState: LoginState.password.rawValue,
            inputRoute: passwordResult.route
        )
    )

default:
    emit(Output(ok: false, phase: phase, message: "unknown phase: \(phase)", textFieldCount: nil))
}
