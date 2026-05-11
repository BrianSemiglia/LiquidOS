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
        
        guard let webRoot = Bundle.main.resourceURL?.appendingPathComponent("Web") else {
            showError("Missing app resources.")
            return
        }
        
        guard FileManager.default.fileExists(atPath: webRoot.appendingPathComponent("server.js").path) else {
            showError("Missing server.js in app resources.")
            return
        }
        
        do {
            try Self.ensureHomeCanvas(at: Self.canvasesRoot())
        } catch {
            showError("Could not prepare LiquidOS canvases.\n\n" + error.localizedDescription)
            return
        }
        
        server = Process()
        server?.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        server?.currentDirectoryURL = webRoot
        server?.arguments = ["node", "server.js", "--port", String(port), "--canvases", Self.canvasesRoot().path]
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
            "LIQUIDOS_NATIVE": "1"
        ]
        
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
        guard attempt < 80 else {
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
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("LiquidOS", isDirectory: true)
            .appendingPathComponent("canvases", isDirectory: true)
    }
    
    private static func ensureHomeCanvas(at canvasesRoot: URL) throws {
        try FileManager.default.createDirectory(
            at: canvasesRoot.appendingPathComponent("home", isDirectory: true),
            withIntermediateDirectories: true
        )
        
        try writeDefaultFile(
            at: canvasesRoot.appendingPathComponent("home/input.json"),
            contents: "{\"components\":[],\"css\":\"body{background:#0b1120}\"}\n"
        )
        try writeDefaultFile(
            at: canvasesRoot.appendingPathComponent("home/output.json"),
            contents: "[]\n"
        )
        try writeDefaultFile(
            at: canvasesRoot.appendingPathComponent("home/deltas.json"),
            contents: "[]\n"
        )
    }
    
    private static func writeDefaultFile(at url: URL, contents: String) throws {
        guard !FileManager.default.fileExists(atPath: url.path) else { return }
        try contents.write(to: url, atomically: true, encoding: .utf8)
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
        NSApp.mainMenu = NSMenu()
        NSApp.mainMenu?.addItem(NSMenuItem())
        NSApp.mainMenu?.item(at: 0)?.submenu = NSMenu()
        NSApp.mainMenu?.item(at: 0)?.submenu?.addItem(
            withTitle: "Quit LiquidOS",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )
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
