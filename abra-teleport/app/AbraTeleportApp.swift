import SwiftUI
import Foundation
import AppKit

struct Endpoint: Decodable {
    let public_ip: String
    let ssh_user: String
    let ssh_key: String
    let abra_peer_id: String
    let local_peer_id: String

    static func load() throws -> Endpoint {
        let path = NSString(string: "~/.abra-teleport/cloud/endpoint.json").expandingTildeInPath
        return try JSONDecoder().decode(Endpoint.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
    }
}

struct BrowserProfile: Decodable, Identifiable, Hashable {
    let directory: String
    let name: String
    let account: String?
    let managed: Bool?
    var id: String { directory }
}

struct BrowserCookie: Decodable, Identifiable {
    let name: String
    let domain: String
    let path: String
    let httpOnly: Bool
    let secure: Bool
    let sameSite: String?
    let session: Bool
    let key: String
    var id: String { key }
}

struct ChromeTab: Decodable, Identifiable, Hashable {
    let id: String
    let windowId: String
    let windowIndex: Int
    let tabIndex: Int
    let title: String
    let url: String
    let active: Bool
    let host: String
}

struct CloudFrame: Decodable {
    let title: String
    let url: String
    let image: String
}

struct BrowserTab: Decodable, Identifiable {
    let title: String
    let url: String
    var id: String { url + "|" + title }
}

struct BrowserDomain: Decodable, Identifiable {
    let domain: String
    let cookies: [BrowserCookie]
    let tabs: [BrowserTab]
    let localStorage: [String]
    let sessionStorage: [String]
    let indexedDB: [String]
    let warnings: [String]
    var id: String { domain }
    var storageCount: Int { localStorage.count + sessionStorage.count + indexedDB.count }
}

struct BrowserInventory: Decodable {
    let profile: String
    let capturedAt: String
    let domains: [BrowserDomain]
}

struct CodexSession: Decodable, Identifiable, Hashable {
    let session_id: String
    let cwd: String
    let cli_version: String
    let updated_at: String
    let bytes: Int
    var id: String { session_id }
    var shortID: String { String(session_id.suffix(8)) }
    var folder: String { URL(fileURLWithPath: cwd).lastPathComponent }
}

struct CommandFailure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

final class LockedData: @unchecked Sendable {
    private let lock = NSLock()
    private var data = Data()

    func append(_ chunk: Data) {
        lock.lock()
        data.append(chunk)
        lock.unlock()
    }

    func value() -> Data {
        lock.lock()
        defer { lock.unlock() }
        return data
    }
}

enum Runner {
    static let runtime = Bundle.main.resourceURL!.appendingPathComponent("Runtime").path
    static let wrapper = runtime + "/wrapper/bin/abra-teleport.js"
    static let project = runtime + "/wrapper"
    static let adapter = runtime + "/browser-session"
    static let abra = runtime + "/abra"
    static let node = "/usr/local/bin/node"
    static let cloudBrowserAction = "/usr/lib/node_modules/abra-teleport/scripts/browser-cloud-action.js"
    static let cloudBrowserScreenshot = "/usr/lib/node_modules/abra-teleport/scripts/browser-cloud-screenshot.js"

    static func run(_ executable: String, _ arguments: [String], environment: [String: String] = [:], allowFailure: Bool = false) throws -> String {
        let process = Process()
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        let stdout = LockedData()
        let stderr = LockedData()

        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.currentDirectoryURL = URL(fileURLWithPath: project)
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe
        var merged = ProcessInfo.processInfo.environment
        environment.forEach { merged[$0.key] = $0.value }
        process.environment = merged

        stdoutPipe.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            if !chunk.isEmpty { stdout.append(chunk) }
        }
        stderrPipe.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            if !chunk.isEmpty { stderr.append(chunk) }
        }

        try process.run()
        process.waitUntilExit()
        stdoutPipe.fileHandleForReading.readabilityHandler = nil
        stderrPipe.fileHandleForReading.readabilityHandler = nil
        stdout.append(stdoutPipe.fileHandleForReading.readDataToEndOfFile())
        stderr.append(stderrPipe.fileHandleForReading.readDataToEndOfFile())

        let out = String(data: stdout.value(), encoding: .utf8) ?? ""
        let err = String(data: stderr.value(), encoding: .utf8) ?? ""
        if process.terminationStatus != 0 && !allowFailure {
            let detail = [err, out].first { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
                ?? "process exited with status \(process.terminationStatus)"
            throw CommandFailure(message: detail.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        return out
    }

    static func local(_ arguments: [String], allowFailure: Bool = false) throws -> String {
        try run(node, [wrapper] + arguments, environment: [
            "ABRA_BIN": abra,
            "ABRA_BROWSER_ADAPTER": adapter,
            "PATH": "/Users/vividh/.local/bin:/usr/local/bin:/usr/bin:/bin"
        ], allowFailure: allowFailure)
    }

    static func quote(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    static func remote(_ endpoint: Endpoint, _ arguments: [String], allowFailure: Bool = false) throws -> String {
        let command = (["sudo", "env", "ABRA_BROWSER_ADAPTER=/var/lib/abra/adapters/browser-session", "abra-teleport"] + arguments)
            .map(quote)
            .joined(separator: " ")
        return try run("/usr/bin/ssh", [
            "-i", endpoint.ssh_key,
            "-o", "BatchMode=yes",
            "-o", "ConnectTimeout=10",
            "-o", "StrictHostKeyChecking=yes",
            "\(endpoint.ssh_user)@\(endpoint.public_ip)",
            command
        ], allowFailure: allowFailure)
    }

    static func value(_ key: String, in output: String) throws -> String {
        let escaped = NSRegularExpression.escapedPattern(for: key)
        let regex = try NSRegularExpression(pattern: "\"\(escaped)\"\\s*:\\s*\"([^\"]+)\"")
        let range = NSRange(output.startIndex..<output.endIndex, in: output)
        guard let match = regex.matches(in: output, range: range).last,
              let capture = Range(match.range(at: 1), in: output) else {
            throw CommandFailure(message: "The wrapper did not return \(key).")
        }
        return String(output[capture])
    }

    static func decode<T: Decodable>(_ type: T.Type, from output: String) throws -> T {
        guard let data = output.data(using: .utf8) else {
            throw CommandFailure(message: "The wrapper returned unreadable data.")
        }
        return try JSONDecoder().decode(type, from: data)
    }

    static func browserInventory(_ profile: String, attempts: Int = 12) throws -> BrowserInventory {
        var lastError: Error = CommandFailure(message: "The browser session was not ready.")
        for attempt in 0..<attempts {
            do {
                return try decode(BrowserInventory.self, from: local(["browser", "inventory", profile]))
            } catch {
                lastError = error
                if attempt + 1 < attempts { Thread.sleep(forTimeInterval: 0.5) }
            }
        }
        throw lastError
    }

    static func firstJSONLine<T: Decodable>(_ type: T.Type, from output: String) throws -> T {
        for line in output.split(separator: "\n") {
            guard let data = String(line).data(using: .utf8) else { continue }
            if let decoded = try? JSONDecoder().decode(type, from: data) { return decoded }
        }
        throw CommandFailure(message: "The cloud browser returned an unreadable preview.")
    }
}

final class AppModel: ObservableObject {
    @Published var connected = false
    @Published var busy = false
    @Published var scanning = false
    @Published var currentStep = "Checking the two endpoints…"
    @Published var browserResult = "Ready"
    @Published var codexResult = "Ready"
    @Published var activity = ""

    @Published var profiles: [BrowserProfile] = []
    @Published var selectedProfile = "Profile 1"
    @Published var browserDomains: [BrowserDomain] = []
    @Published var selectedDomains: Set<String> = []
    @Published var chromeTabs: [ChromeTab] = []
    @Published var selectedTabID = ""
    @Published var tabInventory: BrowserInventory?
    @Published var selectedCookieKeys: Set<String> = []
    @Published var includeStorage = true
    @Published var cloudBrowserActive = false
    @Published var cloudPreview: NSImage?
    @Published var cloudPreviewTitle = ""
    @Published var cloudPreviewURL = ""
    @Published var previewStatus = "Waiting for the first frame…"
    @Published var inspectingTab = false
    @Published var previewBusy = false

    private var previewTimer: Timer?

    @Published var codexSessions: [CodexSession] = []
    @Published var selectedSession = "01a06829-8e28-7532-ba53-f979355cee9f"
    @Published var workspace = "/Users/vividh/Desktop/abra-teleport-demo-workspace"
    @Published var task = "Add a line test-run=gui to handoff.txt, preserving the existing lines."

    let endpoint: Endpoint?

    init() {
        endpoint = try? Endpoint.load()
        DispatchQueue.main.async { self.refresh() }
    }

    var selectedProfileRecord: BrowserProfile? {
        profiles.first { $0.directory == selectedProfile }
    }

    var selectedTab: ChromeTab? { chromeTabs.first { $0.id == selectedTabID } }
    var tabCookies: [BrowserCookie] { tabInventory?.domains.flatMap(\.cookies) ?? [] }
    var tabStorageCount: Int { tabInventory?.domains.reduce(0) { $0 + $1.storageCount } ?? 0 }

    var selectedSessionRecord: CodexSession? {
        codexSessions.first { $0.session_id == selectedSession }
    }

    func log(_ message: String) {
        DispatchQueue.main.async {
            let stamp = Date().formatted(date: .omitted, time: .standard)
            self.activity += "[\(stamp)] \(message)\n"
        }
    }

    func step(_ message: String) {
        DispatchQueue.main.async { self.currentStep = message }
        log(message)
    }

    func finish(_ result: Result<String, Error>, target: String) {
        DispatchQueue.main.async {
            self.busy = false
            self.scanning = false
            switch result {
            case .success(let message):
                self.currentStep = message
                if target == "browser" { self.browserResult = "Passed" }
                if target == "codex" { self.codexResult = "Passed" }
                self.activity += "\(message)\n"
            case .failure(let error):
                self.currentStep = "Failed"
                if target == "browser" { self.browserResult = "Failed" }
                if target == "codex" { self.codexResult = "Failed" }
                self.activity += "ERROR: \(error.localizedDescription)\n"
            }
        }
    }

    func refresh() {
        guard let endpoint else {
            currentStep = "Cloud endpoint configuration is missing."
            return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                _ = try Runner.local(["doctor"])
                _ = try Runner.remote(endpoint, ["doctor"])
                let profiles = try Runner.decode([BrowserProfile].self, from: Runner.local(["browser", "profiles"]))
                let tabs = try Runner.decode([ChromeTab].self, from: Runner.local(["browser", "tabs"]))
                let sessions = try Runner.decode([CodexSession].self, from: Runner.local(["codex", "sessions"]))
                DispatchQueue.main.async {
                    self.connected = true
                    self.profiles = profiles
                    self.chromeTabs = tabs
                    self.codexSessions = sessions
                    if !profiles.contains(where: { $0.directory == self.selectedProfile && $0.directory != "active" }) {
                        self.selectedProfile = profiles.first(where: { $0.directory != "active" })?.directory ?? "Default"
                    }
                    if let demo = sessions.first(where: { $0.session_id == self.selectedSession }) {
                        self.workspace = demo.cwd
                    } else if let first = sessions.first {
                        self.selectedSession = first.session_id
                        self.workspace = first.cwd
                    }
                    if !self.busy { self.currentStep = "Connected. Select a browser or Codex session." }
                }
            } catch {
                DispatchQueue.main.async {
                    self.connected = false
                    if !self.busy { self.currentStep = error.localizedDescription }
                }
            }
        }
    }

    func chooseProfile(_ profile: String) {
        selectedProfile = profile
        browserDomains = []
        selectedDomains = []
        tabInventory = nil
        selectedCookieKeys = []
        browserResult = "Ready"
    }

    func reloadChromeTabs() {
        guard !busy else { return }
        busy = true
        currentStep = "Reading open Chrome tabs…"
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let tabs = try Runner.decode([ChromeTab].self, from: Runner.local(["browser", "tabs"]))
                DispatchQueue.main.async {
                    self.chromeTabs = tabs
                    self.busy = false
                    self.currentStep = tabs.isEmpty ? "Open a page in Chrome, then refresh." : "Choose a Chrome tab."
                }
            } catch { self.finish(.failure(error), target: "browser") }
        }
    }

    func selectChromeTab(_ tab: ChromeTab) {
        guard !busy else { return }
        selectedTabID = tab.id
        tabInventory = nil
        selectedCookieKeys = []
        inspectingTab = true
        busy = true
        browserResult = "Reading cookies"
        activity = ""
        let profile = selectedProfile
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                self.step("Reading cookies and storage for \(tab.host)…")
                let inventory = try Runner.decode(BrowserInventory.self, from: Runner.local([
                    "browser", "tab-inventory",
                    "--profile", profile,
                    "--url", tab.url,
                    "--title", tab.title
                ]))
                let keys = Set(inventory.domains.flatMap(\.cookies).map(\.key))
                DispatchQueue.main.async {
                    self.tabInventory = inventory
                    self.selectedCookieKeys = keys
                    self.inspectingTab = false
                    self.busy = false
                    self.browserResult = "Ready to send"
                    self.currentStep = "Choose the cookies to send with this tab."
                    self.activity += "Found \(keys.count) matching cookies. Cookie values remain hidden.\n"
                }
            } catch { self.finish(.failure(error), target: "browser") }
        }
    }

    func toggleCookie(_ key: String, enabled: Bool) {
        if enabled { selectedCookieKeys.insert(key) }
        else { selectedCookieKeys.remove(key) }
    }

    func selectAllCookies(_ enabled: Bool) {
        selectedCookieKeys = enabled ? Set(tabCookies.map(\.key)) : []
    }

    func sendBrowserToCloud() {
        guard !busy, let endpoint, let tab = selectedTab, tabInventory != nil else { return }
        busy = true
        browserResult = "Sending"
        activity = ""
        let profile = selectedProfile
        let cookieData = try? JSONEncoder().encode(selectedCookieKeys.sorted())
        let encodedCookies = cookieData?.base64EncodedString() ?? "W10="
        let includeSiteStorage = includeStorage

        DispatchQueue.global(qos: .userInitiated).async {
            do {
                self.step("Preparing the selected tab and cookies…")
                _ = try? Runner.remote(endpoint, ["browser", "revoke"], allowFailure: true)
                _ = try? Runner.remote(endpoint, ["browser", "close", "--force"], allowFailure: true)
                _ = try? Runner.local(["browser", "revoke"], allowFailure: true)
                _ = try? Runner.local(["browser", "close", "--force"], allowFailure: true)
                var prepare = [
                    "browser", "prepare",
                    "--profile", profile,
                    "--url", tab.url,
                    "--title", tab.title,
                    "--cookies", encodedCookies
                ]
                if !includeSiteStorage { prepare.append("--no-storage") }
                _ = try Runner.local(prepare)

                self.step("Sending \(tab.host) to the cloud with Abra…")
                let sent = try Runner.local(["browser", "up", endpoint.abra_peer_id, "--all-domains"])
                let snapshotID = try Runner.value("snapshot_id", in: sent)
                _ = try Runner.local(["browser", "revoke"])
                _ = try? Runner.local(["browser", "close", "--force"], allowFailure: true)

                self.step("Opening the selected tab in the cloud browser…")
                _ = try Runner.remote(endpoint, ["browser", "receive", snapshotID, "--headless"])
                DispatchQueue.main.async {
                    self.busy = false
                    self.cloudBrowserActive = true
                    self.browserResult = "Live in cloud"
                    self.currentStep = "The selected tab is live in the cloud."
                    self.startCloudPreview()
                }
            } catch { self.finish(.failure(error), target: "browser") }
        }
    }

    func startCloudPreview() {
        previewTimer?.invalidate()
        refreshCloudPreview()
        previewTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in self?.refreshCloudPreview() }
    }

    func stopCloudPreview() {
        previewTimer?.invalidate()
        previewTimer = nil
        previewBusy = false
    }

    func refreshCloudPreview() {
        guard cloudBrowserActive, !previewBusy, let endpoint else { return }
        previewBusy = true
        DispatchQueue.global(qos: .utility).async {
            do {
                let output = try Runner.remote(endpoint, [
                    "browser", "exec", "--", "node", Runner.cloudBrowserScreenshot
                ])
                let frame = try Runner.firstJSONLine(CloudFrame.self, from: output)
                guard let data = Data(base64Encoded: frame.image), let image = NSImage(data: data) else {
                    throw CommandFailure(message: "The cloud browser returned a broken image.")
                }
                DispatchQueue.main.async {
                    self.cloudPreview = image
                    self.cloudPreviewTitle = frame.title
                    self.cloudPreviewURL = frame.url
                    self.previewStatus = "Live"
                    self.previewBusy = false
                }
            } catch {
                DispatchQueue.main.async {
                    self.previewStatus = error.localizedDescription
                    self.previewBusy = false
                }
            }
        }
    }

    func runCloudBrowserAction() {
        guard !busy, let endpoint, let tab = selectedTab else { return }
        busy = true
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                self.step("The cloud agent is changing the page…")
                _ = try Runner.remote(endpoint, ["browser", "exec", "--", "node", Runner.cloudBrowserAction, tab.host])
                DispatchQueue.main.async { self.busy = false; self.currentStep = "Cloud action finished." }
                self.refreshCloudPreview()
            } catch { self.finish(.failure(error), target: "browser") }
        }
    }

    func returnBrowserToMac() {
        guard !busy, let endpoint else { return }
        busy = true
        browserResult = "Returning"
        stopCloudPreview()
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                self.step("Sending the live cloud browser back to this Mac…")
                let returned = try Runner.remote(endpoint, ["browser", "down", endpoint.local_peer_id, "--all-domains"])
                let snapshotID = try Runner.value("snapshot_id", in: returned)
                _ = try Runner.remote(endpoint, ["browser", "revoke"])
                _ = try? Runner.local(["browser", "revoke"], allowFailure: true)
                _ = try? Runner.local(["browser", "close", "--force"], allowFailure: true)
                _ = try Runner.local(["browser", "receive", snapshotID])
                DispatchQueue.main.async {
                    self.busy = false
                    self.cloudBrowserActive = false
                    self.browserResult = "Returned"
                    self.currentStep = "The updated tab is open on this Mac."
                    self.activity += "Browser returned. The updated tab is open in an isolated Chrome window.\n"
                }
            } catch { self.finish(.failure(error), target: "browser") }
        }
    }

    func chooseSession(_ session: String) {
        selectedSession = session
        if let record = codexSessions.first(where: { $0.session_id == session }) {
            workspace = record.cwd
        }
    }

    func toggleDomain(_ domain: String, enabled: Bool) {
        if enabled { selectedDomains.insert(domain) }
        else { selectedDomains.remove(domain) }
    }

    func selectAllDomains() {
        selectedDomains = Set(browserDomains.map(\.domain))
    }

    func openCaptureBrowser() {
        guard !busy else { return }
        busy = true
        activity = ""
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                self.step("Opening a clean capture browser…")
                _ = try? Runner.local(["browser", "revoke"])
                _ = try? Runner.local(["browser", "close", "--force"])
                _ = try Runner.local(["browser", "open"])
                DispatchQueue.main.async {
                    self.selectedProfile = "active"
                    self.browserDomains = []
                    self.selectedDomains = []
                }
                self.finish(.success("Capture browser opened. Sign in or open tabs, then click Scan session."), target: "none")
            } catch {
                self.finish(.failure(error), target: "none")
            }
        }
    }

    func scanBrowser() {
        guard !busy else { return }
        busy = true
        scanning = true
        browserResult = "Scanning"
        activity = ""
        let profile = selectedProfile
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                self.step(profile == "active" ? "Reading the open capture browser…" : "Scanning a temporary copy of the selected Chrome profile…")
                let inventory = try Runner.browserInventory(profile)
                DispatchQueue.main.async {
                    self.browserDomains = inventory.domains
                    self.selectedDomains = []
                    self.browserResult = "Choose domains"
                }
                let cookies = inventory.domains.reduce(0) { $0 + $1.cookies.count }
                let tabs = inventory.domains.reduce(0) { $0 + $1.tabs.count }
                self.finish(.success("Found \(inventory.domains.count) domains, \(tabs) tabs, and \(cookies) cookies. Choose what to move."), target: "none")
            } catch {
                self.finish(.failure(error), target: "browser")
            }
        }
    }

    func runBrowserRoundTrip() {
        guard !busy, let endpoint, !selectedDomains.isEmpty else { return }
        let profile = selectedProfile
        let domains = selectedDomains.sorted()
        busy = true
        browserResult = "Running"
        activity = ""

        DispatchQueue.global(qos: .userInitiated).async {
            do {
                self.step("Preparing the selected browser state…")
                _ = try? Runner.remote(endpoint, ["browser", "revoke"], allowFailure: true)
                _ = try? Runner.remote(endpoint, ["browser", "close", "--force"], allowFailure: true)
                if profile != "active" {
                    _ = try? Runner.local(["browser", "revoke"])
                }

                self.step("Moving \(domains.count) selected domains to the cloud with Abra…")
                var send = ["browser", "up", endpoint.abra_peer_id]
                if profile != "active" { send += ["--profile", profile] }
                send += ["--domains", domains.joined(separator: ",")]
                let sent = try Runner.local(send)
                let upID = try Runner.value("snapshot_id", in: sent)

                self.step("Restoring tabs, cookies, and storage in the cloud agent…")
                _ = try Runner.remote(endpoint, [
                    "browser", "receive", upID,
                    "--allow", domains.joined(separator: ","),
                    "--headless"
                ])

                self.step("The cloud agent is adding a tab and storage marker…")
                _ = try Runner.remote(endpoint, [
                    "browser", "exec", "--", "node",
                    Runner.cloudBrowserAction, domains[0]
                ])

                self.step("Moving the updated browser state back to this Mac…")
                let returned = try Runner.remote(endpoint, [
                    "browser", "down", endpoint.local_peer_id,
                    "--domains", domains.joined(separator: ",")
                ])
                let downID = try Runner.value("snapshot_id", in: returned)
                _ = try Runner.remote(endpoint, ["browser", "revoke"])
                _ = try? Runner.local(["browser", "revoke"])
                _ = try? Runner.local(["browser", "close", "--force"])
                _ = try Runner.local([
                    "browser", "receive", downID,
                    "--allow", domains.joined(separator: ",")
                ])

                self.step("Reading the returned browser state…")
                let inventory = try Runner.browserInventory("active")
                guard inventory.domains.contains(where: { domain in
                    domain.tabs.contains(where: { $0.url.contains("abra-cloud=1") })
                }) else {
                    throw CommandFailure(message: "The state returned, but the cloud tab marker was missing.")
                }
                DispatchQueue.main.async {
                    self.selectedProfile = "active"
                    self.browserDomains = inventory.domains
                    self.selectedDomains = Set(domains)
                }
                self.finish(.success("Browser round trip passed. The returned isolated Chrome window is open."), target: "browser")
            } catch {
                self.finish(.failure(error), target: "browser")
            }
        }
    }

    func runCodexRoundTrip() {
        guard !busy, let endpoint else { return }
        let requestedTask = task.trimmingCharacters(in: .whitespacesAndNewlines)
        let requestedWorkspace = workspace.trimmingCharacters(in: .whitespacesAndNewlines)
        let requestedSession = selectedSession.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !requestedTask.isEmpty, !requestedWorkspace.isEmpty, !requestedSession.isEmpty else { return }

        busy = true
        codexResult = "Running"
        activity = ""

        DispatchQueue.global(qos: .userInitiated).async {
            do {
                self.step("Moving the selected Codex session and workspace to the cloud…")
                let sent = try Runner.local([
                    "codex", "up", endpoint.abra_peer_id,
                    "--session", requestedSession,
                    "--workspace", requestedWorkspace,
                    "--confirm-workspace"
                ])
                let upID = try Runner.value("session_snapshot_id", in: sent)

                self.step("Restoring the same Codex UUID in the cloud…")
                _ = try Runner.remote(endpoint, [
                    "codex", "receive", upID,
                    "--workspace", "/workspace/abra-teleport-demo"
                ])

                self.step("Codex is running the requested cloud turn…")
                let cloudRun = try Runner.remote(endpoint, [
                    "codex", "run", requestedTask,
                    "--confirm-workspace"
                ])
                let downID = try Runner.value("session_snapshot_id", in: cloudRun)

                self.step("Abra is returning the changed workspace and transcript…")
                _ = try Runner.local([
                    "codex", "receive", downID,
                    "--workspace", requestedWorkspace
                ])

                let status = try Runner.local(["codex", "status"])
                guard status.contains(requestedSession), status.contains("\"location\": \"local\"") else {
                    throw CommandFailure(message: "The Codex session returned, but continuity verification failed.")
                }
                self.finish(.success("Codex round trip passed. The selected session is back on this Mac."), target: "codex")
            } catch {
                self.finish(.failure(error), target: "codex")
            }
        }
    }
}

struct StatusPill: View {
    let label: String
    let good: Bool

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(good ? Color.green : Color.orange).frame(width: 8, height: 8)
            Text(label).font(.caption.weight(.semibold))
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(.thinMaterial, in: Capsule())
    }
}

struct FlowView: View {
    var body: some View {
        HStack(spacing: 10) {
            Label("This Mac", systemImage: "laptopcomputer")
            Image(systemName: "arrow.right")
            Text("Abra").fontWeight(.semibold)
            Image(systemName: "arrow.right")
            Label("Cloud agent", systemImage: "cloud")
            Image(systemName: "arrow.right")
            Text("Abra").fontWeight(.semibold)
            Image(systemName: "arrow.right")
            Label("This Mac", systemImage: "laptopcomputer")
        }
        .font(.callout)
        .foregroundStyle(.secondary)
        .padding(12)
        .frame(maxWidth: .infinity)
        .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 12))
    }
}

struct CookieRow: View {
    let cookie: BrowserCookie

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "key.horizontal").foregroundStyle(.secondary)
            Text(cookie.name).font(.system(.caption, design: .monospaced)).lineLimit(1)
            Spacer()
            if cookie.httpOnly { Text("HttpOnly").badgeStyle() }
            if cookie.secure { Text("Secure").badgeStyle() }
            if let sameSite = cookie.sameSite { Text(sameSite).badgeStyle() }
        }
    }
}

extension View {
    func badgeStyle() -> some View {
        self
            .font(.caption2.weight(.medium))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Color.secondary.opacity(0.12), in: Capsule())
    }
}

struct ChromeTabCard: View {
    let tab: ChromeTab
    let selected: Bool
    let action: () -> Void

    private var mark: String {
        let part = tab.host.split(separator: ".").first.map(String.init) ?? "web"
        return String(part.prefix(2)).uppercased()
    }

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top) {
                    Text(mark)
                        .font(.title3.bold())
                        .frame(width: 44, height: 44)
                        .background(Color.accentColor.opacity(0.16), in: RoundedRectangle(cornerRadius: 11))
                    Spacer()
                    if tab.active {
                        Text("OPEN").font(.caption2.bold()).foregroundStyle(.green)
                    }
                }
                Text(tab.title.isEmpty ? tab.host : tab.title)
                    .font(.callout.weight(.semibold))
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(tab.host).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                Text("Window \(tab.windowIndex) · Tab \(tab.tabIndex)")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            .padding(14)
            .frame(height: 142)
            .background(Color.primary.opacity(selected ? 0.085 : 0.035), in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(selected ? Color.accentColor : .clear, lineWidth: 2))
        }
        .buttonStyle(.plain)
    }
}

struct CookieChoiceRow: View {
    let cookie: BrowserCookie
    @Binding var selected: Bool

    var body: some View {
        Toggle(isOn: $selected) {
            VStack(alignment: .leading, spacing: 5) {
                Text(cookie.name).font(.system(.callout, design: .monospaced)).lineLimit(1)
                HStack(spacing: 5) {
                    Text(cookie.domain).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                    if cookie.httpOnly { Text("HttpOnly").badgeStyle() }
                    if cookie.secure { Text("Secure").badgeStyle() }
                    if let sameSite = cookie.sameSite { Text(sameSite).badgeStyle() }
                }
            }
        }
        .toggleStyle(.checkbox)
        .padding(.vertical, 5)
    }
}

struct BrowserPickerView: View {
    @ObservedObject var model: AppModel
    private let columns = [GridItem(.adaptive(minimum: 180, maximum: 240), spacing: 12)]

    var body: some View {
        HStack(alignment: .top, spacing: 18) {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Choose a Chrome tab").font(.title2.bold())
                        Text("Pick one of the tabs already open in Chrome.").font(.callout).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button { model.reloadChromeTabs() } label: { Label("Refresh tabs", systemImage: "arrow.clockwise") }
                        .disabled(model.busy)
                }

                HStack {
                    Text("Use cookies from").font(.callout.weight(.medium))
                    Picker("Chrome profile", selection: Binding(
                        get: { model.selectedProfile },
                        set: { model.chooseProfile($0) }
                    )) {
                        ForEach(model.profiles.filter { $0.directory != "active" }) { profile in
                            Text(profile.account.map { "\(profile.name) · \($0)" } ?? profile.name).tag(profile.directory)
                        }
                    }
                    .labelsHidden()
                    .frame(maxWidth: 280)
                    Spacer()
                }

                if model.chromeTabs.isEmpty {
                    ContentUnavailableView("No Chrome tabs", systemImage: "rectangle.on.rectangle.slash", description: Text("Open a page in Chrome, then refresh this list."))
                } else {
                    ScrollView {
                        LazyVGrid(columns: columns, spacing: 12) {
                            ForEach(model.chromeTabs) { tab in
                                ChromeTabCard(tab: tab, selected: model.selectedTabID == tab.id) {
                                    model.selectChromeTab(tab)
                                }
                            }
                        }
                        .padding(2)
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            VStack(alignment: .leading, spacing: 14) {
                Text("Send with this tab").font(.title3.bold())

                if let tab = model.selectedTab {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(tab.title).font(.headline).lineLimit(2)
                        Text(tab.url).font(.caption).foregroundStyle(.secondary).lineLimit(2).truncationMode(.middle)
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 11))
                } else {
                    Text("Select a tab on the left.").foregroundStyle(.secondary)
                }

                if model.inspectingTab {
                    HStack { ProgressView(); Text("Reading site data…").foregroundStyle(.secondary) }
                    Spacer()
                } else if model.tabInventory != nil {
                    HStack {
                        Text("Cookies").font(.headline)
                        Spacer()
                        Button("All") { model.selectAllCookies(true) }.buttonStyle(.borderless)
                        Button("None") { model.selectAllCookies(false) }.buttonStyle(.borderless)
                    }
                    Text("\(model.selectedCookieKeys.count) of \(model.tabCookies.count) selected. Values stay hidden.")
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 2) {
                            ForEach(model.tabCookies) { cookie in
                                CookieChoiceRow(cookie: cookie, selected: Binding(
                                    get: { model.selectedCookieKeys.contains(cookie.key) },
                                    set: { model.toggleCookie(cookie.key, enabled: $0) }
                                ))
                                Divider()
                            }
                            if model.tabCookies.isEmpty {
                                Text("This profile has no cookies that apply to the selected page.")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .padding(.vertical, 10)
                            }
                        }
                    }

                    Toggle("Include site storage", isOn: $model.includeStorage)
                    Text("\(model.tabStorageCount) localStorage, sessionStorage, or IndexedDB items")
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    let warnings = model.tabInventory?.domains.flatMap(\.warnings) ?? []
                    if !warnings.isEmpty {
                        Label(warnings.joined(separator: ", "), systemImage: "exclamationmark.triangle.fill")
                            .font(.caption)
                            .foregroundStyle(.orange)
                    }

                    Button("Send tab to cloud") { model.sendBrowserToCloud() }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                        .disabled(model.busy || !model.connected)
                } else {
                    Spacer()
                }
            }
            .frame(width: 360)
            .padding(18)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
        }
    }
}

struct CloudBrowserView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        HStack(alignment: .top, spacing: 18) {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(model.cloudPreviewTitle.isEmpty ? "Cloud browser" : model.cloudPreviewTitle).font(.title2.bold()).lineLimit(1)
                        Text(model.cloudPreviewURL).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                    }
                    Spacer()
                    HStack(spacing: 6) {
                        Circle().fill(Color.green).frame(width: 8, height: 8)
                        Text(model.previewStatus == "Live" ? "LIVE" : model.previewStatus).font(.caption.weight(.semibold)).lineLimit(1)
                    }
                }

                ZStack {
                    Color.black.opacity(0.88)
                    if let preview = model.cloudPreview {
                        Image(nsImage: preview).resizable().scaledToFit()
                    } else {
                        VStack(spacing: 10) {
                            ProgressView().controlSize(.large)
                            Text("Opening the page in the cloud…").foregroundStyle(.secondary)
                        }
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 14))
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.white.opacity(0.08)))
                .frame(maxWidth: .infinity, maxHeight: .infinity)

                Text("This is a live view of the page rendered by the cloud browser. It refreshes every 1.5 seconds.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            VStack(alignment: .leading, spacing: 16) {
                Label("Running in cloud", systemImage: "cloud.fill").font(.title3.bold())
                if let tab = model.selectedTab {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(tab.host).font(.headline)
                        Text("\(model.selectedCookieKeys.count) cookies sent")
                        Text(model.includeStorage ? "Site storage included" : "Site storage not included")
                    }
                    .font(.callout)
                    .foregroundStyle(.secondary)
                }
                Divider()
                Text("Test the agent").font(.headline)
                Text("The demo action changes localStorage and opens a second tab. You will see the result in the live view.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button("Run cloud action") { model.runCloudBrowserAction() }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.busy)
                Spacer()
                Button("Bring back to this Mac") { model.returnBrowserToMac() }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(model.busy)
            }
            .frame(width: 260)
            .padding(18)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
        }
    }
}

struct BrowserView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        if model.cloudBrowserActive { CloudBrowserView(model: model) }
        else { BrowserPickerView(model: model) }
    }
}

struct CodexView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        HStack(alignment: .top, spacing: 18) {
            VStack(alignment: .leading, spacing: 14) {
                Label("Codex session", systemImage: "chevron.left.forwardslash.chevron.right")
                    .font(.title2.bold())
                Text("Choose a completed session. Abra moves its rollout and workspace together.")
                    .font(.callout)
                    .foregroundStyle(.secondary)

                Picker("Session", selection: Binding(
                    get: { model.selectedSession },
                    set: { model.chooseSession($0) }
                )) {
                    ForEach(model.codexSessions) { session in
                        Text("\(session.folder) · …\(session.shortID)").tag(session.session_id)
                    }
                }

                if let session = model.selectedSessionRecord {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(session.session_id).font(.system(.caption, design: .monospaced))
                        Text(session.cwd).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        Text(ByteCountFormatter.string(fromByteCount: Int64(session.bytes), countStyle: .file))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 10))
                }

                TextField("Workspace", text: $model.workspace).textFieldStyle(.roundedBorder)
                Spacer()
            }
            .frame(width: 330)
            .padding(18)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))

            VStack(alignment: .leading, spacing: 12) {
                Text("Cloud task").font(.headline)
                TextEditor(text: $model.task)
                    .font(.system(.body, design: .monospaced))
                    .padding(8)
                    .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 10))
                Text("Codex runs this task in the cloud using the selected session UUID. Abra then returns the changed workspace and continued transcript.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                HStack {
                    Spacer()
                    Button("Run Codex round trip") { model.runCodexRoundTrip() }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .disabled(model.busy || !model.connected || model.task.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .padding(18)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
        }
    }
}

struct ContentView: View {
    @StateObject private var model = AppModel()
    @State private var section = "Browser"

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Abra Teleport").font(.largeTitle.bold())
                    Text("Pick state, move it to the cloud, and bring back the result.").foregroundStyle(.secondary)
                }
                Spacer()
                StatusPill(label: model.connected ? "Cloud connected" : "Cloud unavailable", good: model.connected)
                Button { model.refresh() } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.borderless)
                    .help("Refresh connection and sessions")
            }

            FlowView()

            Picker("", selection: $section) {
                Label("Browser", systemImage: "safari").tag("Browser")
                Label("Codex", systemImage: "chevron.left.forwardslash.chevron.right").tag("Codex")
            }
            .pickerStyle(.segmented)
            .frame(width: 360)

            Group {
                if section == "Browser" { BrowserView(model: model) }
                else { CodexView(model: model) }
            }
            .frame(maxHeight: .infinity)

            VStack(alignment: .leading, spacing: 7) {
                HStack {
                    Text("Activity").font(.headline)
                    Spacer()
                    if model.busy { ProgressView().controlSize(.small) }
                    Text(model.currentStep).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                ScrollView {
                    Text(model.activity.isEmpty ? "The app will show each Abra handoff here." : model.activity)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(model.activity.isEmpty ? .secondary : .primary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                        .padding(10)
                }
                .frame(height: 90)
                .background(Color.black.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
            }
        }
        .padding(24)
        .frame(minWidth: 1040, minHeight: 760)
    }
}

@main
struct AbraTeleportApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1120, height: 820)
    }
}
