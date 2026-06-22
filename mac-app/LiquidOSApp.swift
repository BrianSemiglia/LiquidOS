import Cocoa
import WebKit
import UniformTypeIdentifiers
import Darwin
import UserNotifications

final class LiquidOSApp: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate, WKDownloadDelegate, WKScriptMessageHandler {
    private var window: NSWindow?
    private var webView: WKWebView?
    private var escapeKeyMonitor: Any?
    private var server: Process?
    private var port: Int = 0
    private var canvasesRootURL: URL?
    private var pendingWorkspaceURL: URL?
    private var workspaceChooserMessage: String?
    private var serverOutputBuffer = ""
    private var serverErrorBuffer = ""
    private var intentionallyStoppingServer = false
    // The app owns the server's lifecycle, so when the server dies on its own
    // the app brings it back. Recent crash times bound the restart rate so a
    // server that dies the instant it boots can't spin forever.
    private var serverCrashTimestamps: [Date] = []
    private static let crashWindowSeconds: TimeInterval = 60
    private static let maxCrashesInWindow = 3
    private static let restartDelaySeconds: TimeInterval = 1.0
    // True from when the server crashes until it reports the workspace is
    // bootable again ('ready'). While set, the app shows the recovery screen
    // (streaming the agent's repair) instead of the canvas.
    private var crashRecovering = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        requestNotificationPermission()
        Self.installMainMenu()
        port = Self.freePort()
        showWindow()
        installEscapeMonitor()

        if let workspaceURL = pendingWorkspaceURL ?? Self.startupWorkspaceURL() {
            pendingWorkspaceURL = nil
            openWorkspace(workspaceURL)
            return
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            if let workspaceURL = self.pendingWorkspaceURL {
                self.pendingWorkspaceURL = nil
                self.openWorkspace(workspaceURL)
            } else if self.server == nil {
                self.showWorkspaceChooser()
            }
        }
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        if let url = urls.first {
            receiveWorkspaceURL(url)
        }
    }

    func application(_ sender: NSApplication, openFile filename: String) -> Bool {
        receiveWorkspaceURL(URL(fileURLWithPath: filename, isDirectory: true))
        return true
    }
    
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        stopServer()
        return true
    }
    
    func applicationWillTerminate(_ notification: Notification) {
        stopServer()
    }
    
    deinit {
        stopServer()
    }
    
    // The harness "desk" background, matched natively so the unpainted web
    // backing reads as one surface with the harness desk (light = Mist #e9ebf0,
    // dark = Slate #1a1c1f).
    private static let deskColor = NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            ? NSColor(srgbRed: 0x1a / 255.0, green: 0x1c / 255.0, blue: 0x1f / 255.0, alpha: 1)
            : NSColor(srgbRed: 0xe9 / 255.0, green: 0xeb / 255.0, blue: 0xf0 / 255.0, alpha: 1)
    }

    // The title bar color — matched in BOTH modes to the escaped-mode canvas
    // sheet (--surface-1: dark #23262a, light #ffffff) so the bar reads as one
    // seamless surface with the canvas, not the greyer desk. Painted as a solid
    // opaque fill in the title bar (see paintTitleBar) rather than via
    // titlebarAppearsTransparent, which lets the system title-bar material bleed
    // through and never lands on a flat tone (worst in dark mode).
    private static let titleBarColor = NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            ? NSColor(srgbRed: 0x23 / 255.0, green: 0x26 / 255.0, blue: 0x2a / 255.0, alpha: 1)
            : NSColor(srgbRed: 1, green: 1, blue: 1, alpha: 1)
    }

    private func showWindow() {
        let configuration = WKWebViewConfiguration()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = true
        // HTML5 element fullscreen (Element.requestFullscreen()) is off by
        // default in WKWebView on macOS — without this, an iframe video
        // player's "fullscreen" button does nothing. macOS 12.3+.
        if #available(macOS 12.3, *) {
            configuration.preferences.isElementFullscreenEnabled = true
        }
        configuration.userContentController.add(self, name: "liquidosMac")

        webView = WKWebView(frame: .zero, configuration: configuration)
        webView?.uiDelegate = self
        webView?.navigationDelegate = self
        webView?.allowsBackForwardNavigationGestures = true
        // Until a page paints, WKWebView draws its own opaque (white) backing on
        // top of the window — a flash of white on launch (before the chooser
        // even loads) and between page swaps, worst in dark mode. Stop it from
        // drawing a background so the window's opaque desk-colored backing shows
        // through any unpainted area; underPageBackgroundColor tints overscroll
        // to match. Both follow the system light/dark via the dynamic deskColor.
        webView?.setValue(false, forKey: "drawsBackground")
        if #available(macOS 12.0, *) {
            webView?.underPageBackgroundColor = Self.deskColor
        }

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 840),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window?.title = ""
        // Shows the workspace name (set in openWorkspace) centered in the bar.
        window?.titleVisibility = .visible
        // A real title bar painted a solid title-bar tone (paintTitleBar) so the
        // bar reads as one uniform surface with the canvas below it: the web
        // content sits BELOW the bar (no overlap), and the bar stays draggable.
        // The window background stays the desk tone so the unpainted web backing
        // (drawsBackground=false) reads as the harness desk during load flashes.
        window?.isOpaque = true
        window?.backgroundColor = Self.deskColor
        window?.center()
        window?.contentView = webView
        webView?.autoresizingMask = [.width, .height]
        window?.makeKeyAndOrderFront(nil)
        paintTitleBar()
        NSApp.activate(ignoringOtherApps: true)
    }

    // Paints the title bar a solid, opaque title-bar tone instead of relying on
    // titlebarAppearsTransparent (which lets the system title-bar material show
    // through, so the bar never lands on a flat #23262a in dark mode). A
    // layer-backed fill is inserted BEHIND the traffic lights and title text,
    // spanning the whole title bar; its color follows the system appearance via
    // the dynamic titleBarColor.
    private var titleBarFill: TitleBarFillView?
    private func paintTitleBar() {
        guard let titlebarContainer = window?.standardWindowButton(.closeButton)?.superview else { return }
        let fill = TitleBarFillView()
        fill.translatesAutoresizingMaskIntoConstraints = false
        titlebarContainer.addSubview(fill, positioned: .below, relativeTo: nil)
        NSLayoutConstraint.activate([
            fill.leadingAnchor.constraint(equalTo: titlebarContainer.leadingAnchor),
            fill.trailingAnchor.constraint(equalTo: titlebarContainer.trailingAnchor),
            fill.topAnchor.constraint(equalTo: titlebarContainer.topAnchor),
            fill.bottomAnchor.constraint(equalTo: titlebarContainer.bottomAnchor),
        ])
        fill.fillColor = Self.titleBarColor
        titleBarFill = fill
    }

    // Escape is reserved for the harness: it toggles the prompt bar (and, when
    // an overlay is open, dismisses that first). We intercept it natively —
    // before WKWebView dispatches the key — so no canvas content, iframe, or
    // fullscreen keyboard-lock inside the web view can swallow it first. This
    // is the resilient path the browser build can't have; there a capture-phase
    // listener does the same job. Swallowing here (returning nil) means the web
    // listener never sees the key in the Mac app, so there's no double handling.
    private func installEscapeMonitor() {
        guard escapeKeyMonitor == nil else { return }
        escapeKeyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self = self, event.keyCode == 53 else { return event }   // 53 = Escape
            // Only claim Escape for the main canvas window. Sheets, save panels,
            // and WKWebView's own HTML-fullscreen window get their own window,
            // so Escape still cancels them / exits video fullscreen natively.
            guard event.window === self.window else { return event }
            // One action per physical press. Holding Escape makes macOS fire
            // repeat key-downs; acting on each would flip the prompt bar
            // rapidly. Still swallow the repeats so the canvas never sees a
            // stray Escape — just don't re-trigger the handler.
            if event.isARepeat { return nil }
            self.webView?.evaluateJavaScript("window.liquidos?.handleEscape?.()")
            return nil   // swallow: the web view (and the canvas) never see it
        }
    }

    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.begin { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    private var downloadDestinations: [ObjectIdentifier: URL] = [:]

    private func openExternally(_ url: URL) {
        NSWorkspace.shared.open(url)
    }

    // External = a real web URL that isn't our local app server.
    private func isExternalLink(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            return false
        }
        let host = url.host?.lowercased()
        return host != "127.0.0.1" && host != "localhost"
    }

    // target="_blank" / window.open: open in the default browser instead of silently dropping it.
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url {
            openExternally(url)
        }
        return nil
    }

    // Keep the app on its local server; send user-clicked external links to the
    // browser, and let download links (the `download` attribute) become real
    // downloads. Iframe loads and subresource navigations are NOT intercepted —
    // a component embedding e.g. a third-party player iframe needs that iframe
    // to actually load inline, not get hijacked to Safari.
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        let isMainFrame = navigationAction.targetFrame?.isMainFrame ?? false
        let isLinkClick = navigationAction.navigationType == .linkActivated
        if isMainFrame, isLinkClick, let url = navigationAction.request.url, isExternalLink(url) {
            openExternally(url)
            decisionHandler(.cancel)
            return
        }
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download)
            return
        }
        decisionHandler(.allow)
    }

    // Responses the web view can't render itself (e.g. a generated file) become downloads.
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(
        _ download: WKDownload,
        decideDestinationUsing response: URLResponse,
        suggestedFilename: String,
        completionHandler: @escaping (URL?) -> Void
    ) {
        let directory = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        let fileManager = FileManager.default
        let name = suggestedFilename.isEmpty ? "download" : suggestedFilename
        var destination = directory.appendingPathComponent(name)
        let base = destination.deletingPathExtension().lastPathComponent
        let ext = destination.pathExtension
        var index = 1
        while fileManager.fileExists(atPath: destination.path) {
            let candidate = ext.isEmpty ? "\(base) \(index)" : "\(base) \(index).\(ext)"
            destination = directory.appendingPathComponent(candidate)
            index += 1
        }
        downloadDestinations[ObjectIdentifier(download)] = destination
        completionHandler(destination)
    }

    func downloadDidFinish(_ download: WKDownload) {
        if let destination = downloadDestinations.removeValue(forKey: ObjectIdentifier(download)) {
            NSWorkspace.shared.open(destination)
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloadDestinations.removeValue(forKey: ObjectIdentifier(download))
    }

    private func startServer() {
        // Kill any lingering Hermes processes on the same port first
        if let existingPID = Self.getPIDForPort(port) {
            kill(existingPID, SIGKILL)
            sleep(1) // Allow OS to release the port
        }
        
        guard let canvasesRootURL else {
            showWorkspaceChooser()
            return
        }


        guard let appRoot = Bundle.main.resourceURL else {
            showError("Missing app resources.")
            return
        }
        
        guard FileManager.default.fileExists(atPath: appRoot.appendingPathComponent("server.js").path) else {
            showError("Missing server.js in app resources.")
            return
        }
        
        serverErrorBuffer = ""
        intentionallyStoppingServer = false
        server = Process()
        server?.executableURL = URL(fileURLWithPath: "/bin/zsh")
        server?.currentDirectoryURL = appRoot
        // Run the server on the Node runtime bundled in the app (Resources/
        // runtime/bin/node), by absolute path, so the app works with no
        // user-installed node. launchPath() also puts that bin first, so any
        // `node` the server itself spawns resolves to the bundled one too.
        let bundledNode = appRoot.appendingPathComponent("runtime/bin/node").path
        server?.arguments = [
            "-lc",
            Self.shellCommand(
                [bundledNode, "server.js", "--workspace", canvasesRootURL.path]
                    + Self.agentScriptArgs()
                    + ["--port", String(port)]
            )
        ]
        server?.environment = ProcessInfo.processInfo.environment.merging(Self.serverEnvironment()) { _, new in new }

        let outputPipe = Pipe()
        let errorPipe = Pipe()

        server?.standardOutput = outputPipe
        server?.standardError = errorPipe

        outputPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if !data.isEmpty, let text = String(data: data, encoding: .utf8) {
                DispatchQueue.main.async {
                    self?.handleServerOutput(text)
                }
            }
        }

        errorPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if !data.isEmpty, let text = String(data: data, encoding: .utf8) {
                FileHandle.standardError.write(Data(text.utf8))
                DispatchQueue.main.async {
                    self?.serverErrorBuffer += text
                }
            }
        }

        server?.terminationHandler = { [weak self] process in
            DispatchQueue.main.async {
                guard let self else { return }
                guard !self.intentionallyStoppingServer else { return }
                guard self.server?.processIdentifier == process.processIdentifier else { return }

                // The server died on its own — almost always one component the
                // agent wrote taking it down. The app's only job is to restart
                // it: the fresh boot is where the server hands the crash to the
                // agent (Phase 1, make it bootable) and then the permanent fix
                // (Phase 2) — see dispatchCrashRecovery in server.js. If it
                // crashes again we land right back here; that recursion is what
                // runs until the workspace boots clean. Give up only if it keeps
                // crashing faster than the repairs can help.
                let now = Date()
                self.serverCrashTimestamps = self.serverCrashTimestamps.filter {
                    now.timeIntervalSince($0) < Self.crashWindowSeconds
                }
                self.serverCrashTimestamps.append(now)

                guard self.serverCrashTimestamps.count <= Self.maxCrashesInWindow else {
                    self.showError([
                        "LiquidOS server keeps crashing and could not be recovered.",
                        "",
                        "Exit code: \(process.terminationStatus)",
                        "",
                        self.serverErrorBuffer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            ? "No server error output was captured."
                            : self.serverErrorBuffer.trimmingCharacters(in: .whitespacesAndNewlines)
                    ].joined(separator: "\n"))
                    return
                }

                NSLog("LiquidOS server exited (code \(process.terminationStatus)); recovering (\(self.serverCrashTimestamps.count)/\(Self.maxCrashesInWindow)).")
                self.server = nil
                // Show the recovery screen now (it streams the agent's repair as
                // soon as the server is back). Only on the first crash of a
                // sequence — keep it up across restarts so its activity log
                // accumulates rather than flickering.
                if !self.crashRecovering {
                    self.crashRecovering = true
                    self.showRecoveryScreen()
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + Self.restartDelaySeconds) {
                    guard !self.intentionallyStoppingServer else { return }
                    // Bring the server back, then swap the gap screen for the
                    // server's /recovery page (live agent activity). The canvas
                    // loads later, when the server reports 'ready' (Phase 1 done).
                    self.startServer()
                    self.loadRecoveryWhenReady(attempt: 0)
                }
            }
        }
        
        do {
            try server?.run()
        } catch {
            showError("Could not start Node. Install Node.js, then reopen LiquidOS.\n\n" + error.localizedDescription)
        }
    }

    private static func getPIDForPort(_ port: Int) -> pid_t? {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        task.arguments = ["-t", "-i", ":\(port)"]
        task.standardOutput = Pipe()
        task.standardError = Pipe()
        
        do {
            try task.run()
            task.waitUntilExit()
            
            guard task.terminationStatus == 0 else { return nil }
            
            let outputData = task.standardOutput as! Pipe
            let output = String(data: outputData.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
            
            return output.flatMap { Int32($0) }
        } catch {
            return nil
        }
    }
    
    private func loadWhenReady(attempt: Int) {
        guard attempt < 120 else {
            showError([
                "LiquidOS server did not answer on localhost port \(port).",
                "",
                serverErrorBuffer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    ? "No server error output was captured."
                    : serverErrorBuffer.trimmingCharacters(in: .whitespacesAndNewlines)
            ].joined(separator: "\n"))
            return
        }
        
        URLSession.shared.dataTask(with: URL(string: "http://127.0.0.1:\(port)/")!) { _, response, _ in
            DispatchQueue.main.async {
                if (response as? HTTPURLResponse)?.statusCode == 200 {
                    self.webView?.load(URLRequest(url: URL(string: "http://127.0.0.1:\(self.port)/")!))
                } else {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                        self.loadWhenReady(attempt: attempt + 1)
                    }
                }
            }
        }.resume()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        switch message.body as? String {
        case "open":
            showOpenWorkspacePanel()
        case "create":
            showCreateWorkspacePanel()
        default:
            break
        }
    }

    private func showOpenWorkspacePanel() {
        let panel = NSOpenPanel()
        panel.title = "Open Workspace"
        panel.prompt = "Open"
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [Self.workspaceContentType]
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            self.openWorkspace(url)
        }
    }

    private func showCreateWorkspacePanel() {
        let panel = NSSavePanel()
        panel.title = "Create Workspace"
        panel.prompt = "Create"
        panel.nameFieldStringValue = "Untitled.liquidos"
        panel.canCreateDirectories = true
        panel.allowedContentTypes = [Self.workspaceContentType]
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }

            do {
                let workspaceURL = Self.workspaceURL(url)
                try self.createWorkspace(at: workspaceURL)
                self.openWorkspace(workspaceURL)
            } catch {
                self.workspaceChooserMessage = "Could not create workspace.\n\n" + error.localizedDescription
                self.showWorkspaceChooser()
            }
        }
    }

    private func createWorkspace(at url: URL) throws {
        let fileManager = FileManager.default

        if fileManager.fileExists(atPath: url.path) {
            try fileManager.removeItem(at: url)
        }

        try fileManager.createDirectory(at: url, withIntermediateDirectories: true)
    }

    private func showWorkspaceChooser() {
        let messageHTML: String
        if let workspaceChooserMessage {
            messageHTML = """
            <p class="error">\(Self.escapeHTML(workspaceChooserMessage))</p>
            """
            self.workspaceChooserMessage = nil
        } else {
            messageHTML = ""
        }

        webView?.loadHTMLString("""
        <!doctype html>
        <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            /* Follows the system appearance and matches the harness
               "blueprint" look: dotted field, flat stroke-less card, soft
               primary. Default = dark (Slate); prefers-color-scheme:light
               flips to Mist. */
            :root {
              color-scheme: light dark;
              --bg: #1a1c1f;
              --fg: #edeff2;
              --card: #23262a;
              --accent: #d4d7dc;
              --accent-hover: #e6e8ec;
              --accent-fg: #1a1c1f;
              --control: #2a2d31;
              --control-hover: #31343a;
              --err: rgba(239, 68, 68, 0.22);
            }
            @media (prefers-color-scheme: light) {
              :root {
                --bg: #f4f5f7;
                --fg: #22262c;
                --card: #ffffff;
                --accent: #3b4047;
                --accent-hover: #2c3037;
                --accent-fg: #ffffff;
                --control: #eceef2;
                --control-hover: #e3e6ec;
                --err: rgba(220, 38, 38, 0.12);
              }
            }

            html, body {
              width: 100%;
              height: 100%;
              margin: 0;
              background-color: var(--bg);
            }

            body {
              display: grid;
              place-items: center;
              color: var(--fg);
              font: -apple-system-body;
              -webkit-font-smoothing: antialiased;
              text-rendering: optimizeLegibility;
            }

            main {
              width: min(320px, calc(100vw - 48px));
            }

            .error {
              margin: 0 0 16px;
              padding: 12px 14px;
              border-radius: 12px;
              background: var(--err);
              color: var(--fg);
              line-height: 1.4;
            }

            .actions {
              display: grid;
              gap: 10px;
            }

            button {
              width: 100%;
              padding: 12px 14px;
              border: 0;
              border-radius: 10px;
              background: var(--accent);
              color: var(--accent-fg);
              font: inherit;
              font-weight: 600;
              cursor: pointer;
            }

            button:hover { background: var(--accent-hover); }

            button.secondary {
              background: var(--control);
              color: var(--fg);
            }

            button.secondary:hover { background: var(--control-hover); }
          </style>
        </head>
        <body>
          <main>
            \(messageHTML)
            <div class="actions">
              <button onclick="window.webkit.messageHandlers.liquidosMac.postMessage('open')">Open</button>
              <button class="secondary" onclick="window.webkit.messageHandlers.liquidosMac.postMessage('create')">Create</button>
            </div>
          </main>
        </body>
        </html>
        """, baseURL: nil)
    }

    private func showStartingScreen() {
        webView?.loadHTMLString("""
        <!doctype html>
        <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            /* Follows the system appearance, matching the harness blueprint
               (dotted field). Default dark (Slate); light flips to Mist. */
            :root {
              color-scheme: light dark;
              --bg: #1a1c1f;
              --fg: rgba(237, 239, 242, 0.7);
            }
            @media (prefers-color-scheme: light) {
              :root {
                --bg: #f4f5f7;
                --fg: rgba(34, 38, 44, 0.6);
              }
            }

            html, body {
              width: 100%;
              height: 100%;
              margin: 0;
              background-color: var(--bg);
            }

            body {
              display: grid;
              place-items: center;
              color: var(--fg);
              font: -apple-system-body;
            }

            .loading {
              letter-spacing: 0.01em;
              font-weight: 500;
              -webkit-font-smoothing: antialiased;
              text-rendering: optimizeLegibility;
            }
          </style>
        </head>
        <body>
          <div class="loading" aria-label="Loading" role="status">Loading...</div>
        </body>
        </html>
        """, baseURL: nil)
    }
    
    private func requestNotificationPermission() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    private func handleServerOutput(_ text: String) {
        print(text, terminator: "")
        serverOutputBuffer += text

        while let newlineRange = serverOutputBuffer.range(of: "\n") {
            let line = String(serverOutputBuffer[..<newlineRange.lowerBound])
            serverOutputBuffer.removeSubrange(...newlineRange.lowerBound)
            handleServerOutputLine(line)
        }
    }

    private func handleServerOutputLine(_ line: String) {
        let recoveryPrefix = "LIQUIDOS_RECOVERY "
        if line.hasPrefix(recoveryPrefix) {
            let payload = String(line.dropFirst(recoveryPrefix.count))
            guard
                let data = payload.data(using: .utf8),
                let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { return }
            // The workspace is bootable again — leave the recovery screen for
            // the canvas. (Phase 2, the permanent fix, runs in the background.)
            if (object["state"] as? String) == "ready", crashRecovering {
                crashRecovering = false
                loadWhenReady(attempt: 0)
            }
            return
        }

        let prefix = "LIQUIDOS_NATIVE_NOTIFICATION "
        guard line.hasPrefix(prefix) else { return }

        let payload = String(line.dropFirst(prefix.count))
        guard
            let data = payload.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return
        }

        sendLocalNotification(
            title: object["title"] as? String ?? "LiquidOS",
            body: object["body"] as? String ?? ""
        )
    }

    // The gap screen: shown the instant the server crashes, while it restarts.
    // It's a static app-owned page (no network) — the server is down right now,
    // so it can't load anything. As soon as the server answers, loadRecoveryWhenReady
    // swaps to the server's /recovery page, which streams the live agent activity.
    private func showRecoveryScreen() {
        webView?.loadHTMLString("""
        <!doctype html>
        <html>
        <head><meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            :root { color-scheme: dark; }
            html, body { width: 100%; height: 100%; margin: 0; background: #121212; }
            body {
              display: flex; flex-direction: column; box-sizing: border-box;
              height: 100%; padding: 0 48px; gap: 14px;
              align-items: flex-start; justify-content: center;
              color: rgba(255,255,255,0.88); font: -apple-system-body;
              -webkit-font-smoothing: antialiased;
            }
            h1 { font-size: 17px; font-weight: 600; margin: 0; }
            .sub { color: rgba(255,255,255,0.55); font-size: 13px; margin: 0; max-width: 46ch; }
          </style>
        </head>
        <body>
          <h1>Recovering from a crash…</h1>
          <p class="sub">Something took the workspace down. The agent is repairing it — your workspace will return when it's safe to load.</p>
        </body>
        </html>
        """, baseURL: nil)
    }

    // Once the restarted server answers, load its /recovery page (served
    // same-origin so its EventSource('/agent/stream') connects cleanly and
    // streams the live agent activity). Connecting there is also what releases
    // Phase 1. Bails if recovery already finished (the canvas is loading).
    private func loadRecoveryWhenReady(attempt: Int) {
        guard crashRecovering, attempt < 120 else { return }
        URLSession.shared.dataTask(with: URL(string: "http://127.0.0.1:\(port)/")!) { _, response, _ in
            DispatchQueue.main.async {
                guard self.crashRecovering else { return }
                if (response as? HTTPURLResponse)?.statusCode == 200 {
                    self.webView?.load(URLRequest(url: URL(string: "http://127.0.0.1:\(self.port)/recovery")!))
                } else {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                        self.loadRecoveryWhenReady(attempt: attempt + 1)
                    }
                }
            }
        }.resume()
    }

    private func sendLocalNotification(title: String, body: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default

        let request = UNNotificationRequest(
            identifier: UUID().uuidString,
            content: content,
            trigger: nil
        )

        UNUserNotificationCenter.current().add(request)
    }

    private func showError(_ message: String) {
        webView?.loadHTMLString("""
        <!doctype html>
        <html>
        <body style="font: -apple-system-body; margin: 48px; color: #121212; background: #f9fafb;">
          <h1>LiquidOS</h1>
          <pre style="white-space: pre-wrap; line-height: 1.4;">\(Self.escapeHTML(message))</pre>
        </body>
        </html>
        """, baseURL: nil)
    }
    
    private func receiveWorkspaceURL(_ url: URL) {
        guard webView != nil else {
            pendingWorkspaceURL = url
            return
        }

        openWorkspace(url)
    }

    private func openWorkspace(_ url: URL) {
        guard Self.isWorkspaceURL(url) else {
            workspaceChooserMessage = "Workspaces must be .liquidos folders."
            showWorkspaceChooser()
            return
        }

        canvasesRootURL = url.standardizedFileURL
        window?.title = url.deletingPathExtension().lastPathComponent
        showStartingScreen()
        stopServer()
        startServer()
        loadWhenReady(attempt: 0)
    }

    private func stopServer() {
        guard let server else {
            return
        }

        intentionallyStoppingServer = true

        if server.isRunning {
            server.terminate()        // SIGTERM — node runs its shutdown handler
            server.waitUntilExit()    // block until node actually exits
        }

        self.server = nil
        intentionallyStoppingServer = false
    }

    private static let workspaceContentType = UTType("local.liquidos.workspace") ?? .package

    private static func startupWorkspaceURL() -> URL? {
        CommandLine.arguments.dropFirst().first.map {
            URL(fileURLWithPath: $0, isDirectory: true)
        }
    }

    private static func workspaceURL(_ url: URL) -> URL {
        url.pathExtension.lowercased() == "liquidos" ? url : url.appendingPathExtension("liquidos")
    }

    private static func isWorkspaceURL(_ url: URL) -> Bool {
        url.pathExtension.lowercased() == "liquidos"
    }


    // The PATH the server (and anything it spawns, e.g. `claude`) runs with.
    // The GUI app's inherited PATH is stripped and a login-but-non-interactive
    // `zsh -lc` sources ~/.zprofile but not ~/.zshrc — where user bin dirs like
    // ~/.local/bin usually live — so we set it explicitly here.
    // PATH for finding the external agent CLIs (hermes, claude, …). Node is not
    // resolved through here — the server runs on the bundled runtime and puts
    // its own execPath dir first for any node it spawns, so there is one node.
    private static func launchPath() -> String {
        [
            NSHomeDirectory() + "/.local/bin",
            NSHomeDirectory() + "/.cargo/bin",
            NSHomeDirectory() + "/.bun/bin",
            "/opt/homebrew/bin",
            "/opt/homebrew/sbin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin"
        ].joined(separator: ":")
    }

    private static func serverEnvironment() -> [String: String] {
        [
            "LIQUIDOS_RUNTIME_KIND": "mac-app",
            "PATH": launchPath()
        ]
    }

    // The agent roster is the array of --agent script paths the server loads;
    // the first is the default-active. Paths are resolved against the app root
    // (the server's cwd). A UI test can override the roster via LIQUIDOS_AGENT
    // (comma-separated script paths) to force the deterministic crash-repair
    // stub so the recovery loop is reproducible.
    private static func agentScriptArgs() -> [String] {
        let override = ProcessInfo.processInfo.environment["LIQUIDOS_AGENT"]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let scripts: [String]
        if let override, !override.isEmpty {
            scripts = override.split(separator: ",")
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
        } else {
            scripts = [
                "agent/(skillsPath+runtimePath)->hermes-runtime.js",
                "agent/(skillsPath+runtimePath)->pi-runtime.js",
                "agent/(skillsPath+runtimePath)->codex-runtime.js",
                "agent/(skillsPath+runtimePath)->claude-runtime.js",
            ]
        }
        return scripts.flatMap { ["--agent", $0] }
    }

    private static func shellQuote(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    private static func shellCommand(_ arguments: String...) -> String {
        shellCommand(arguments)
    }

    private static func shellCommand(_ arguments: [String]) -> String {
        arguments.map(shellQuote).joined(separator: " ")
    }

    private static func commandExists(_ command: String, environment: [String: String]) -> Bool {
        if command.hasPrefix("/") {
            return FileManager.default.isExecutableFile(atPath: command)
        }

        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        task.arguments = ["which", command]
        task.environment = [
            "PATH": launchPath(),
            "HOME": NSHomeDirectory(),
            "LIQUIDOS_NATIVE": "1"
        ].merging(environment) { _, new in new }
        task.standardOutput = Pipe()
        task.standardError = Pipe()

        do {
            try task.run()
            task.waitUntilExit()
            return task.terminationStatus == 0
        } catch {
            return false
        }
    }
    
    private static func freePort() -> Int {
        let descriptor = socket(AF_INET, SOCK_STREAM, 0)
        guard descriptor >= 0 else { return 3000 }
        defer { close(descriptor) }
        
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = 0
        address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
        
        return withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                guard Darwin.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0 else { return 3000 }
                var length = socklen_t(MemoryLayout<sockaddr_in>.size)
                var bound = sockaddr_in()
                let didReadPort = withUnsafeMutablePointer(to: &bound) {
                    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                        getsockname(descriptor, $0, &length) == 0
                    }
                }
                
                return didReadPort ? Int(UInt16(bigEndian: bound.sin_port)) : 3000
            }
        }
    }
    
    private static func installMainMenu() {
        let mainMenu = NSMenu()
        NSApp.mainMenu = mainMenu

        let appMenuItem = NSMenuItem()
        appMenuItem.submenu = NSMenu(title: "LiquidOS")
        appMenuItem.submenu?.addItem(withTitle: "About LiquidOS", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenuItem.submenu?.addItem(NSMenuItem.separator())
        appMenuItem.submenu?.addItem(withTitle: "Hide LiquidOS", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenuItem.submenu?.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h").keyEquivalentModifierMask = [.command, .option]
        appMenuItem.submenu?.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenuItem.submenu?.addItem(NSMenuItem.separator())
        appMenuItem.submenu?.addItem(withTitle: "Quit LiquidOS", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        mainMenu.addItem(appMenuItem)

        let fileMenuItem = NSMenuItem()
        fileMenuItem.submenu = NSMenu(title: "File")
        fileMenuItem.submenu?.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        fileMenuItem.submenu?.addItem(withTitle: "New Window", action: #selector(LiquidOSApp.newWindow(_:)), keyEquivalent: "n")
        mainMenu.addItem(fileMenuItem)

        let editMenuItem = NSMenuItem()
        editMenuItem.submenu = NSMenu(title: "Edit")
        editMenuItem.submenu?.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenuItem.submenu?.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenuItem.submenu?.addItem(NSMenuItem.separator())
        editMenuItem.submenu?.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenuItem.submenu?.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenuItem.submenu?.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenuItem.submenu?.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        mainMenu.addItem(editMenuItem)

        let viewMenuItem = NSMenuItem()
        viewMenuItem.submenu = NSMenu(title: "View")
        viewMenuItem.submenu?.addItem(withTitle: "Reload", action: #selector(WKWebView.reload(_:)), keyEquivalent: "r")
        viewMenuItem.submenu?.addItem(NSMenuItem.separator())
        let debugItem = viewMenuItem.submenu?.addItem(
            withTitle: "Show Debug Panel",
            action: #selector(toggleDebugPanel(_:)),
            keyEquivalent: "d")
        debugItem?.keyEquivalentModifierMask = [.command, .option]
        debugItem?.target = NSApp.delegate
        viewMenuItem.submenu?.addItem(NSMenuItem.separator())
        viewMenuItem.submenu?.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f").keyEquivalentModifierMask = [.command, .control]
        mainMenu.addItem(viewMenuItem)

        let windowMenuItem = NSMenuItem()
        windowMenuItem.submenu = NSMenu(title: "Window")
        windowMenuItem.submenu?.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenuItem.submenu?.addItem(withTitle: "Zoom", action: #selector(NSWindow.zoom(_:)), keyEquivalent: "")
        windowMenuItem.submenu?.addItem(NSMenuItem.separator())
        windowMenuItem.submenu?.addItem(withTitle: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        mainMenu.addItem(windowMenuItem)

        let helpMenuItem = NSMenuItem()
        helpMenuItem.submenu = NSMenu(title: "Help")
        helpMenuItem.submenu?.addItem(withTitle: "LiquidOS Help", action: nil, keyEquivalent: "")
        mainMenu.addItem(helpMenuItem)

        NSApp.windowsMenu = windowMenuItem.submenu
        NSApp.helpMenu = helpMenuItem.submenu
    }

    @objc private func newWindow(_ sender: Any?) {
        showWindow()
    }

    @objc private func toggleDebugPanel(_ sender: Any?) {
        // Web side owns the state (persists in localStorage); we just
        // ask it to flip and update the menu item's check mark from the
        // returned bool.
        let menuItem = sender as? NSMenuItem
        webView?.evaluateJavaScript("window.liquidos?.toggleDebug?.()") { (result, _) in
            let open = (result as? Bool) == true || (result as? NSNumber)?.boolValue == true
            menuItem?.state = open ? .on : .off
        }
    }
    
    private static func escapeHTML(_ value: String) -> String {
        value
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
    }
}


// A solid, opaque fill for the title bar. Layer-backed so it covers the system
// title-bar material with a flat color, and re-resolves the dynamic fillColor on
// every appearance change so it tracks system light/dark.
final class TitleBarFillView: NSView {
    var fillColor: NSColor? {
        didSet { needsLayout = true; applyColor() }
    }

    override var wantsUpdateLayer: Bool { true }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        applyColor()
    }

    private func applyColor() {
        wantsLayer = true
        guard let fillColor = fillColor else { return }
        // Resolve the dynamic color against THIS view's appearance so dark/light
        // pick the right tone (cgColor otherwise resolves against whatever
        // drawing appearance happens to be current).
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer?.backgroundColor = fillColor.cgColor
        }
    }
}

let liquidOSApp = LiquidOSApp()
NSApplication.shared.delegate = liquidOSApp
NSApplication.shared.setActivationPolicy(.regular)
NSApplication.shared.run()
