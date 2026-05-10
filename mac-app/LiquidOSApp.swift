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
        true
    }

    func applicationWillTerminate(_ notification: Notification) {
        server?.terminate()
    }

    private func showWindow() {
        let configuration = WKWebViewConfiguration()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false

        webView = WKWebView(frame: .zero, configuration: configuration)
        webView?.allowsBackForwardNavigationGestures = true

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 840),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window?.title = ""
        window?.titleVisibility = .hidden
        window?.titlebarAppearsTransparent = true
        window?.styleMask.insert(.fullSizeContentView)
        window?.center()
        window?.contentView = webView
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func startServer() {
        guard let webRoot = Bundle.main.resourceURL?.appendingPathComponent("Web") else {
            showError("Missing app resources.")
            return
        }

        guard FileManager.default.fileExists(atPath: webRoot.appendingPathComponent("server.js").path) else {
            showError("Missing server.js in app resources.")
            return
        }

        server = Process()
        server?.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        server?.currentDirectoryURL = webRoot
        server?.arguments = ["node", "server.js", "--port", String(port)]
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
