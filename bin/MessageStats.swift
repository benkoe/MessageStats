// MessageStats.app's main executable: a window, and a server to fill it.
//
// Deliberately dumb, for the same reason bootstrap.sh is. This binary is
// sealed inside the signed bundle, so it is the one part of MessageStats that
// `git pull` cannot update — changing it means re-signing, re-notarizing, and
// asking everyone to download the app again. So it knows nothing about
// messages, chats or statistics. It starts bootstrap.sh, waits for the server
// to answer, and points a WKWebView at it. Everything you can see in that
// window is served out of the repo clone and updates on its own.
//
// It replaces an earlier version that shelled out to `open http://…`, which
// handed the UI to Safari and left the server with no owner: no Dock icon, no
// menu bar, no way to quit short of Activity Monitor.

import AppKit
import Foundation
import WebKit

let port = ProcessInfo.processInfo.environment["MESSAGESTATS_PORT"] ?? "4173"
let rootURL = URL(string: "http://127.0.0.1:\(port)/")!
let statusURL = URL(string: "http://127.0.0.1:\(port)/api/status")!

// Shown while node boots. First launch also clones the repo, so this can be up
// a few seconds on a cold start.
let placeholderHTML = """
<!doctype html><meta charset="utf-8">
<style>
  :root { color-scheme: light dark }
  html,body { height:100%; margin:0 }
  body { display:grid; place-content:center; gap:.6rem; text-align:center;
         font:14px/1.5 system-ui,-apple-system,sans-serif;
         background:Canvas; color:CanvasText }
  .t { font-weight:600; font-size:15px }
  .s { opacity:.6 }
</style>
<div class="t">Starting MessageStats…</div>
<div class="s">First launch takes a moment while it downloads itself.</div>
"""

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var window: NSWindow!
  private var webView: WKWebView!
  private var server: Process?
  private var serverIsUp = false

  func applicationDidFinishLaunching(_: Notification) {
    buildMenu()
    buildWindow()
    startServer()
    waitForServer()
  }

  // Closing the window is how you quit this app — there is nothing else to it.
  func applicationShouldTerminateAfterLastWindowClosed(_: NSApplication) -> Bool { true }

  /// SIGTERM rather than SIGKILL: launch.sh traps it and kills node itself, so
  /// the server goes down with us instead of being orphaned on the port.
  func applicationWillTerminate(_: Notification) {
    guard let server, server.isRunning else { return }
    server.terminate()
    let deadline = Date().addingTimeInterval(3)
    while server.isRunning && Date() < deadline { usleep(50_000) }
    if server.isRunning { kill(server.processIdentifier, SIGKILL) }
  }

  // MARK: - window

  private func buildWindow() {
    webView = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
    webView.loadHTMLString(placeholderHTML, baseURL: nil)

    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1180, height: 820),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered, defer: false)
    window.title = "MessageStats"
    window.contentView = webView
    window.minSize = NSSize(width: 720, height: 480)
    if !window.setFrameUsingName("MessageStatsWindow") { window.center() }
    window.setFrameAutosaveName("MessageStatsWindow")
    window.makeKeyAndOrderFront(nil)
  }

  /// Built by hand because there is no nib. Without a main menu there is no
  /// ⌘Q, and without the Edit items copy and paste don't reach the web view.
  private func buildMenu() {
    let main = NSMenu()

    let appItem = NSMenuItem()
    let appMenu = NSMenu()
    appMenu.addItem(withTitle: "About MessageStats",
                    action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
                    keyEquivalent: "")
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: "Hide MessageStats",
                    action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: "Quit MessageStats",
                    action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = appMenu
    main.addItem(appItem)

    let editItem = NSMenuItem()
    let editMenu = NSMenu(title: "Edit")
    editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    editMenu.addItem(withTitle: "Select All",
                     action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editItem.submenu = editMenu
    main.addItem(editItem)

    let viewItem = NSMenuItem()
    let viewMenu = NSMenu(title: "View")
    let reload = NSMenuItem(title: "Reload", action: #selector(reloadPage), keyEquivalent: "r")
    reload.target = self
    viewMenu.addItem(reload)
    viewItem.submenu = viewMenu
    main.addItem(viewItem)

    NSApp.mainMenu = main
  }

  @objc private func reloadPage() {
    webView.load(URLRequest(url: rootURL))
  }

  // MARK: - server

  private func startServer() {
    guard let script = Bundle.main.url(forResource: "bootstrap", withExtension: "sh") else {
      fail("MessageStats is damaged — bootstrap.sh is missing from the app bundle.")
      return
    }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/bash")
    p.arguments = [script.path]
    var env = ProcessInfo.processInfo.environment
    env["MESSAGESTATS_PORT"] = port
    env["MESSAGESTATS_NO_OPEN"] = "1"   // we are the UI; don't also open a browser
    p.environment = env

    // A crash before the server answers means bootstrap hit something it could
    // not fix — missing Node, a failed clone. It shows its own dialog first;
    // this stops us sitting on "Starting…" forever afterwards.
    //
    // Except when it exited *because* a server was already up — launch.sh
    // stands down in that case rather than fighting for the port. So probe
    // before concluding anything is wrong. This runs off the main queue, so
    // blocking here is fine.
    p.terminationHandler = { [weak self] _ in
      guard let self, !self.serverIsUp else { return }
      if self.probe() { return }
      DispatchQueue.main.async {
        guard !self.serverIsUp else { return }
        NSApp.terminate(nil)
      }
    }

    do { try p.run() } catch {
      fail("MessageStats couldn't start its server.\n\n\(error.localizedDescription)")
      return
    }
    server = p
  }

  /// Poll rather than parse stdout: /api/status answering 200 is the only
  /// signal that actually means the page will load.
  private func waitForServer() {
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      for _ in 0..<240 {                       // 60s, then give up
        guard let self else { return }
        if self.probe() {
          DispatchQueue.main.async {
            self.serverIsUp = true
            self.webView.load(URLRequest(url: rootURL))
          }
          return
        }
        Thread.sleep(forTimeInterval: 0.25)
      }
      DispatchQueue.main.async {
        self?.fail("MessageStats' server didn't start in time.")
      }
    }
  }

  private func probe() -> Bool {
    var ok = false
    let done = DispatchSemaphore(value: 0)
    var req = URLRequest(url: statusURL)
    req.timeoutInterval = 1
    URLSession.shared.dataTask(with: req) { _, response, _ in
      ok = (response as? HTTPURLResponse)?.statusCode == 200
      done.signal()
    }.resume()
    _ = done.wait(timeout: .now() + 2)
    return ok
  }

  private func fail(_ message: String) {
    let alert = NSAlert()
    alert.messageText = "MessageStats"
    alert.informativeText = message
    alert.alertStyle = .warning
    alert.runModal()
    NSApp.terminate(nil)
  }
}

@main
enum MessageStats {
  static func main() {
    let app = NSApplication.shared
    app.setActivationPolicy(.regular)          // a real app: Dock icon, menu bar
    let delegate = AppDelegate()
    app.delegate = delegate
    app.activate(ignoringOtherApps: true)
    app.run()
    _ = delegate                               // keep the delegate alive
  }
}
