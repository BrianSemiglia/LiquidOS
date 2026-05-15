import Cocoa
import WebKit
import Darwin

final class LiquidOSApp: NSObject, NSApplicationDelegate {
    private var window: NSWindow?
    private var webView: WKWebView?
    private var server: Process?
    private var port: Int = 0
    
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        Self.installMainMenu()
        port = Self.freePort()
        showWindow()
        showStartingScreen()
        startServer()
        loadWhenReady(attempt: 0)
    }
    
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        // Clean up server before terminating
        server?.terminate()
        // Give the process 2 seconds to terminate gracefully
        Thread.sleep(forTimeInterval: 2)
        if server?.isRunning == true {
            kill(server?.processIdentifier ?? 0, SIGKILL)
        }
        return true
    }
    
    func applicationWillTerminate(_ notification: Notification) {
        // Double-check: ensure the server is dead
        if server?.isRunning == true {
            server?.terminate()
            sleep(2) // Wait for cleanup
            if server?.isRunning == true {
                kill(server?.processIdentifier ?? 0, SIGKILL)
            }
        }
    }
    
    deinit {
        // Catch-all: kill the server if the app is deallocated
        if server?.isRunning == true {
            kill(server?.processIdentifier ?? 0, SIGKILL)
        }
    }
    
    private func showWindow() {
        let configuration = WKWebViewConfiguration()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView?.allowsBackForwardNavigationGestures = true
        
        // Create a visual effect view for vibrancy
        let visualEffectView = NSVisualEffectView()
        visualEffectView.blendingMode = .behindWindow
        visualEffectView.material = .sidebar
        visualEffectView.state = .active
        visualEffectView.frame = NSRect(x: 0, y: 0, width: 1280, height: 840)
        visualEffectView.autoresizingMask = [.width, .height]
        
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 840),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window?.title = ""
        window?.titleVisibility = .hidden
        window?.titlebarAppearsTransparent = true
        window?.isOpaque = false
        window?.backgroundColor = .clear
        window?.center()
        window?.contentView = visualEffectView
        visualEffectView.addSubview(webView!)
        webView?.frame = visualEffectView.bounds
        webView?.autoresizingMask = [.width, .height]
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
    
    private func startServer() {
        // Kill any lingering Hermes processes on the same port first
        if let existingPID = Self.getPIDForPort(port) {
            kill(existingPID, SIGKILL)
            sleep(1) // Allow OS to release the port
        }
        
        guard let appRoot = Bundle.main.resourceURL else {
            showError("Missing app resources.")
            return
        }
        
        guard FileManager.default.fileExists(atPath: appRoot.appendingPathComponent("server.js").path) else {
            showError("Missing server.js in app resources.")
            return
        }
        
        server = Process()
        server?.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        server?.currentDirectoryURL = appRoot
        let environment = Self.serverEnvironment()
        let hermesCommand = Self.resolvedHermesCommand(environment: environment)
        server?.arguments = [
            "node",
            "server.js",
            "--port",
            String(port),
            "--canvases",
            Self.canvasesRoot().path,
            "--agent",
            hermesCommand
        ]
        server?.environment = [
            "PATH": [
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
            ].joined(separator: ":"),
            "HOME": NSHomeDirectory(),
            "LIQUIDOS_NATIVE": "1",
            "LIQUIDOS_RUNTIME_KIND": "mac-app",
            "LIQUIDOS_LIVE_CANVAS_ROOT": Self.canvasesRoot().path
        ].merging(environment) { _, new in new }

        let outputPipe = Pipe()
        let errorPipe = Pipe()

        server?.standardOutput = outputPipe
        server?.standardError = errorPipe

        outputPipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if !data.isEmpty, let text = String(data: data, encoding: .utf8) {
                print(text, terminator: "")
            }
        }

        errorPipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if !data.isEmpty, let text = String(data: data, encoding: .utf8) {
                FileHandle.standardError.write(Data(text.utf8))
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
        guard attempt < 400 else {
            showError("LiquidOS server did not start on localhost port \(port).")
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

    private func showStartingScreen() {
        webView?.loadHTMLString("""
        <!doctype html>
        <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            :root {
              color-scheme: dark;
            }

            html, body {
              width: 100%;
              height: 100%;
              margin: 0;
              background: #111827;
            }

            body {
              display: grid;
              place-items: center;
              color: rgba(255, 255, 255, 0.88);
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
    
    private func showError(_ message: String) {
        webView?.loadHTMLString("""
        <!doctype html>
        <html>
        <body style="font: -apple-system-body; margin: 48px; color: #111827; background: #f9fafb;">
          <h1>LiquidOS</h1>
          <pre style="white-space: pre-wrap; line-height: 1.4;">\(Self.escapeHTML(message))</pre>
        </body>
        </html>
        """, baseURL: nil)
    }
    
    private static func canvasesRoot() -> URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Documents", isDirectory: true)
            .appendingPathComponent("LiquidOS", isDirectory: true)
    }

    private static func serverEnvironment() -> [String: String] {
        var environment: [String: String] = [:]
        if let bundledHermes = bundledHermesExecutablePath() {
            environment["LIQUIDOS_BUNDLED_HERMES"] = bundledHermes
        }
        environment["LIQUIDOS_RUNTIME_KIND"] = "mac-app"
        environment["LIQUIDOS_LIVE_CANVAS_ROOT"] = canvasesRoot().path
        return environment
    }

    private static func bundledHermesExecutablePath() -> String? {
        guard let resourceURL = Bundle.main.resourceURL else {
            return nil
        }

        let candidate = resourceURL.appendingPathComponent("Hermes/hermes")
        return FileManager.default.isExecutableFile(atPath: candidate.path) ? candidate.path : nil
    }

    private static func resolvedHermesCommand(environment: [String: String]) -> String {
        if Self.commandExists("hermes", environment: environment) {
            return "hermes"
        }

        if let bundledHermes = environment["LIQUIDOS_BUNDLED_HERMES"], Self.commandExists(bundledHermes, environment: environment) {
            return bundledHermes
        }

        return "hermes"
    }

    private static func commandExists(_ command: String, environment: [String: String]) -> Bool {
        if command.hasPrefix("/") {
            return FileManager.default.isExecutableFile(atPath: command)
        }

        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        task.arguments = ["which", command]
        task.environment = [
            "PATH": [
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
            ].joined(separator: ":"),
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
    
    private static func escapeHTML(_ value: String) -> String {
        value
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
    }
}


let liquidOSApp = LiquidOSApp()
NSApplication.shared.delegate = liquidOSApp
NSApplication.shared.setActivationPolicy(.regular)
NSApplication.shared.run()
