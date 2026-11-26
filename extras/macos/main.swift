// Smart Calendar in the macOS menu bar: what Now shows: the running task or appointment, otherwise what comes next.
// Left click: month and day panel (Panel.swift). Right click: the Now buttons as a menu. Settings.swift: preferences. Talks to /api/ext/* with a personal access token;
// Settings → Devices & Access → Connect this Mac hands both over through smartcalendar://connect.
//
// Battery: no web engine and no polling loop. One idle connection tells the app when the plan changed (a keep-alive line
// every 50 s); the agenda is fetched only then. The label is redrawn only when its text changes (once a minute during a
// countdown, otherwise at the next start or end). Nothing runs while the display or the Mac sleeps; in Low Power Mode
// the connection is closed and the agenda is fetched every 15 minutes instead. Every timer carries tolerance so
// macOS can bundle the wakeups with others.
import AppKit
import Network
import Security
import ServiceManagement
import SwiftUI

struct Agenda: Decodable {
  struct Event: Decodable { let id: Int; let calendarId: Int; let editable: Bool; let since: Double?; let spent: Int; let title: String; let start: Double; let end: Double; let allDay: Bool; let blocks: Bool; let cal: String?; let color: String?; let location: String?; let join: String?
    let alsoIn: [Also]?; let notes: String?; let done: Bool?; let travel: Travel?; let pin: Pin? }
  /// The exact place from a place rule (a room code → a pin), opened in Google Maps.
  struct Pin: Decodable { let label: String; let url: String }
  /// The way there from home before an appointment: by bike or car, and when to leave.
  struct Travel: Decodable { let mode: String; let min: Int; let before: Int; let after: Int?
    var symbol: String { mode == "bike" ? "bicycle" : "car.fill" }
    func leave(_ start: Double) -> Date { Date(timeIntervalSince1970: (start - Double(before) * 60000) / 1000) }
    /// home again after the day's last place
    func home(_ end: Double) -> Date? { (after ?? 0) > 0 ? Date(timeIntervalSince1970: (end + Double(after!) * 60000) / 1000) : nil } }
  struct Also: Decodable { let name: String; let color: String? }
  struct Cal: Decodable { let id: Int; let name: String; let color: String?; let writable: Bool? }
  struct Project: Decodable { let id: Int; let name: String; let color: String? }
  struct Break: Decodable { let title: String; let start: Double; let end: Double }
  struct Task: Decodable { let taskId: Int; let period: Int; let title: String; let project: String?; let color: String?; let location: String?; let recur: Bool; let start: Double; let end: Double; let flexible: Bool?; let pinned: Bool? }
  struct Active: Decodable { let taskId: Int; let period: Int; let title: String; let recur: Bool; let since: Double; let until: Double? }
  let events: [Agenda.Event]; let tasks: [Agenda.Task]; let breaks: [Break]?; let calendars: [Cal]?; let projects: [Project]?; let active: Active?
}

/// The token lives in the login keychain and is read once per launch (SMART_CALENDAR_TOKEN and SMART_CALENDAR_URL override
/// token and address for test runs, without touching the saved ones).
/// The time the app goes by: the real one, or for screenshots of the demo a set clock time today that runs on from
/// there (SMART_CALENDAR_CLOCK=14:20)
enum Clock {
  static let offset: TimeInterval = {
    guard let v = ProcessInfo.processInfo.environment["SMART_CALENDAR_CLOCK"], v.count == 5, let h = Int(v.prefix(2)), let m = Int(v.suffix(2)),
          let t = Calendar.current.date(bySettingHour: h, minute: m, second: 0, of: Date()) else { return 0 }
    return t.timeIntervalSinceNow
  }()
}
func clockNow() -> Date { Date().addingTimeInterval(Clock.offset) }

enum Keychain {
  static let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "Smart Calendar", kSecAttrAccount as String: "token"]
  private static var cached: String?? = ProcessInfo.processInfo.environment["SMART_CALENDAR_TOKEN"].map { .some($0) }
  static func read() -> String? {
    if let c = cached { return c }
    cached = .some(load()); return cached!
  }
  private static func load() -> String? {
    var q = base; q[kSecReturnData as String] = true
    var out: AnyObject?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
    return String(data: d, encoding: .utf8)
  }
  static func write(_ v: String) {
    SecItemDelete(base as CFDictionary)
    var q = base; q[kSecValueData as String] = Data(v.utf8); q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
    SecItemAdd(q as CFDictionary, nil)
    cached = .some(v)
  }
}

/// Server-sent events: calls `changed` for every message, `ended` when the connection is gone.
final class Stream: NSObject, URLSessionDataDelegate {
  var changed: () -> Void = {}, ended: (Int) -> Void = { _ in }
  private var session: URLSession?
  func open(_ r: URLRequest) {
    close()
    let c = URLSessionConfiguration.ephemeral
    c.timeoutIntervalForRequest = 130; c.timeoutIntervalForResource = .infinity; c.waitsForConnectivity = false
    session = URLSession(configuration: c, delegate: self, delegateQueue: .main)
    session?.dataTask(with: r).resume()
  }
  func close() { session?.invalidateAndCancel(); session = nil }
  var isOpen: Bool { session != nil }
  func urlSession(_ s: URLSession, dataTask: URLSessionDataTask, didReceive r: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
    let code = (r as? HTTPURLResponse)?.statusCode ?? 0
    if code == 200 { completionHandler(.allow) } else { completionHandler(.cancel); end(s, code) }
  }
  func urlSession(_ s: URLSession, dataTask: URLSessionDataTask, didReceive d: Data) {
    if String(decoding: d, as: UTF8.self).contains("data:") { changed() }
  }
  func urlSession(_ s: URLSession, task: URLSessionTask, didCompleteWithError e: Error?) { end(s, 0) }
  private func end(_ s: URLSession, _ code: Int) { guard s === session else { return }; close(); ended(code) }
}

final class App: NSObject, ObservableObject, NSApplicationDelegate, NSMenuDelegate, NSPopoverDelegate {
  let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  /// The date ("TUE" over "24"): a second item, moved on its own (⌘-drag), opens the same panel and menu.
  var dateItem: NSStatusItem?
  var shownDate = ""
  var prefSig = ""
  let menu = NSMenu()
  let http: URLSession = {
    let c = URLSessionConfiguration.ephemeral
    c.timeoutIntervalForRequest = 15; c.timeoutIntervalForResource = 30; c.waitsForConnectivity = false
    return URLSession(configuration: c)
  }()
  let stream = Stream(), net = NWPathMonitor()
  @Published var agenda: Agenda?
  @Published var month: Agenda?          // the visible month of the panel, fetched while it is open
  var monthFrom: Date?
  var outside: Any?
  lazy var panel: NSPopover = { let p = NSPopover(); p.behavior = .transient; p.animates = true; p.delegate = self; return p }()
  var settingsWindow: NSWindow?
  var fetched = Date.distantPast
  var failure: String?
  var rejected = false
  var loading = false, again = false, menuOpen = false, asleep = false, online = true
  var pollTimer: Timer?, drawTimer: Timer?, soonTimer: Timer?, retryTimer: Timer?
  var retry: TimeInterval = 5
  var shown = ""

  var base: String { (ProcessInfo.processInfo.environment["SMART_CALENDAR_URL"] ?? UserDefaults.standard.string(forKey: "url") ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "/")) }
  var ready: Bool { !base.isEmpty && !rejected && Keychain.read() != nil }
  var lowPower: Bool { ProcessInfo.processInfo.isLowPowerModeEnabled }

  func applicationDidFinishLaunching(_ n: Notification) {
    UserDefaults.standard.register(defaults: Pref.defaults)
    // screenshots: open the panel by itself (SMART_CALENDAR_OPEN=1) and print the windows' numbers for screencapture -l
    if ProcessInfo.processInfo.environment["SMART_CALENDAR_OPEN"] != nil {
      DispatchQueue.main.asyncAfter(deadline: .now() + 4) { self.showPanel()
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { for w in NSApp.windows where w.isVisible { print("window", w.windowNumber, Int(w.frame.minX), Int(w.frame.minY), Int(w.frame.width), Int(w.frame.height)) }; fflush(stdout) } }
    }
    menu.delegate = self; menu.autoenablesItems = false
    item.autosaveName = "appointment"   // macOS keeps each item's place in the menu bar
    if let b = item.button {
      b.imagePosition = .imageLeading; b.imageHugsTitle = true
      b.target = self; b.action = #selector(click(_:)); b.sendAction(on: [.leftMouseUp, .rightMouseUp])
    }
    // redraw when one of our settings changes (not for what macOS itself stores, like the items' places and visibility)
    prefSig = Pref.signature
    NotificationCenter.default.addObserver(forName: UserDefaults.didChangeNotification, object: nil, queue: .main) { [weak self] _ in
      guard let self, Pref.signature != self.prefSig else { return }
      self.prefSig = Pref.signature; self.shown = ""; self.draw()
    }
    let ws = NSWorkspace.shared.notificationCenter
    for n in [NSWorkspace.screensDidSleepNotification, NSWorkspace.willSleepNotification] { ws.addObserver(forName: n, object: nil, queue: .main) { [weak self] _ in self?.sleep() } }
    for n in [NSWorkspace.screensDidWakeNotification, NSWorkspace.didWakeNotification] { ws.addObserver(forName: n, object: nil, queue: .main) { [weak self] _ in self?.wake() } }
    for n in [Notification.Name.NSSystemClockDidChange, .NSCalendarDayChanged, .NSSystemTimeZoneDidChange] { NotificationCenter.default.addObserver(forName: n, object: nil, queue: .main) { [weak self] _ in self?.draw() } }
    NotificationCenter.default.addObserver(forName: Notification.Name.NSProcessInfoPowerStateDidChange, object: nil, queue: .main) { [weak self] _ in self?.connect() }
    stream.changed = { [weak self] in self?.soon() }
    stream.ended = { [weak self] code in self?.streamEnded(code) }
    net.pathUpdateHandler = { [weak self] p in DispatchQueue.main.async { self?.network(p.status == .satisfied) } }
    net.start(queue: .global(qos: .utility))
    draw()
    if ready { connect() } else { DispatchQueue.main.asyncAfter(deadline: .now() + 1) { if !self.ready { self.openSettings() } } }   // a connect link may be on its way
  }

  // MARK: Staying current

  /// Live connection when possible; otherwise the agenda is fetched on a slow timer.
  func connect() {
    retryTimer?.invalidate(); retryTimer = nil
    guard ready, !asleep, online else { stream.close(); pollTimer?.invalidate(); pollTimer = nil; return }
    if lowPower { stream.close() } else if !stream.isOpen, let r = request("/api/ext/stream") { stream.open(r) }   // its hello fetches the agenda
    if lowPower || !stream.isOpen { fetch() }
    poll(lowPower ? 900 : stream.isOpen ? 1800 : 600)
  }
  func poll(_ every: TimeInterval) {
    if let t = pollTimer, t.timeInterval == every { return }
    pollTimer?.invalidate()
    pollTimer = after(every, tolerance: every / 6, repeats: true) { [weak self] in self?.fetch() }
  }
  func streamEnded(_ code: Int) {
    if code == 401 { rejected = true; failure = "Token not accepted"; draw(); return connect() }
    guard !asleep, online, !lowPower else { return }
    poll(600)
    retryTimer?.invalidate()
    retryTimer = after(retry, tolerance: retry / 4) { [weak self] in self?.connect() }
    retry = min(retry * 2, 600)
  }
  func network(_ up: Bool) {
    let was = online; online = up
    if up && !was { retry = 5; connect() } else if !up { stream.close() }
  }
  func sleep() {
    asleep = true; stream.close()
    for t in [pollTimer, drawTimer, soonTimer, retryTimer] { t?.invalidate() }
    pollTimer = nil; drawTimer = nil; soonTimer = nil; retryTimer = nil
  }
  func wake() { guard asleep else { return }; asleep = false; retry = 5; draw(); connect() }
  /// Several changes in a row (a sync, a re-plan) become one fetch.
  func soon() {
    soonTimer?.invalidate()
    soonTimer = after(1.5, tolerance: 1) { [weak self] in self?.fetch() }
  }
  @discardableResult
  func after(_ s: TimeInterval, tolerance: TimeInterval, repeats: Bool = false, _ f: @escaping () -> Void) -> Timer {
    let t = Timer(timeInterval: s, repeats: repeats) { _ in f() }
    t.tolerance = tolerance; RunLoop.main.add(t, forMode: .common); return t
  }

  // MARK: Network

  func request(_ path: String, _ body: [String: Any]? = nil) -> URLRequest? {
    guard let tok = Keychain.read(), let url = URL(string: base + path) else { return nil }
    var r = URLRequest(url: url)
    r.setValue("Bearer " + tok, forHTTPHeaderField: "Authorization")
    if let body { r.httpMethod = "POST"; r.setValue("application/json", forHTTPHeaderField: "Content-Type"); r.httpBody = try? JSONSerialization.data(withJSONObject: body) }
    return r
  }

  func fetch() {
    guard ready, let r = request("/api/ext/agenda?days=2") else { return }
    if loading { again = true; return }
    loading = true
    http.dataTask(with: r) { data, resp, err in
      let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
      let a = code == 200 ? data.flatMap { try? JSONDecoder().decode(Agenda.self, from: $0) } : nil
      DispatchQueue.main.async {
        self.loading = false
        if let a { self.agenda = a; self.fetched = clockNow(); self.failure = nil; self.retry = 5 }
        else if code == 401 { self.rejected = true; self.failure = "Token not accepted"; self.connect() }
        else { self.failure = err != nil ? "Offline" : "Server error \(code)" }
        self.draw(); if self.menuOpen { self.build() }
        if a != nil, self.panel.isShown, let f = self.monthFrom { self.loadMonth(f, force: true) }
        if self.again { self.again = false; self.fetch() }
      }
    }.resume()
  }

  func act(_ path: String, _ body: [String: Any] = [:]) {
    guard let r = request(path, body) else { return }
    http.dataTask(with: r) { _, resp, _ in
      DispatchQueue.main.async {
        if (resp as? HTTPURLResponse)?.statusCode != 200 { NSSound.beep() }
        self.fetch()
      }
    }.resume()
  }

  // MARK: What is now, what is next

  struct Entry { let title: String; let start: Date; let end: Date; let color: NSColor; let task: Agenda.Task?; let event: Agenda.Event?
    var allDay: Bool { event?.allDay ?? false } }

  func entries(_ now: Date, tasks: Bool = true) -> [Entry] {
    guard let a = agenda else { return [] }
    let ev = a.events.filter(visible).map { Entry(title: $0.title, start: Date(ms: $0.start), end: Date(ms: $0.end), color: NSColor(hex: $0.color), task: nil, event: $0) }
    let ts = a.tasks.filter { tasks && $0.taskId != a.active?.taskId }.map { Entry(title: $0.title, start: Date(ms: $0.start), end: Date(ms: $0.end), color: NSColor(hex: $0.color), task: $0, event: nil) }
    return (ev + ts).filter { $0.end > now }.sorted { $0.start < $1.start }
  }
  /// As in the app's Now: appointments that block time; Settings can show the rest and leave calendars out.
  func visible(_ e: Agenda.Event) -> Bool { !Pref.hiddenCals.contains(e.calendarId) && (e.blocks || Pref.showFree) }

  /// The appointment you started and haven't paused (it may run past its end).
  var tracked: Agenda.Event? { agenda?.events.first { $0.since != nil } }

  struct BarLabel {
    var text = ""
    var color: NSColor? = nil
    var also: [NSColor] = []
    var change: Date
  }
  /// What the menu bar says, the calendar colors next to it, and when it would read differently.
  func label(_ now: Date) -> BarLabel {
    let minute = Date(timeIntervalSinceReferenceDate: (now.timeIntervalSinceReferenceDate / 60).rounded(.down) * 60 + 60)
    let left: (Date) -> String = { span(Int(($0.timeIntervalSince(now) / 60).rounded(.up))) }
    let also: (Agenda.Event?) -> [NSColor] = { ($0?.alsoIn ?? []).map { NSColor(hex: $0.color) } }
    if let a = agenda?.active {
      let c = agenda?.tasks.first { $0.taskId == a.taskId }.map { NSColor(hex: $0.color) } ?? .controlAccentColor
      if let u = a.until.map(Date.init(ms:)), u > now { return BarLabel(text: "\(short(a.title)) · \(left(u)) left", color: c, change: minute) }
      return BarLabel(text: "\(short(a.title)) · \(span(Int(now.timeIntervalSince(Date(ms: a.since)) / 60)))", color: c, change: minute)
    }
    if let e = tracked {
      let end = Date(ms: e.end)
      return BarLabel(text: end > now ? "\(short(e.title)) · \(left(end)) left" : "\(short(e.title)) · +\(span(Int(now.timeIntervalSince(end) / 60)))", color: NSColor(hex: e.color), also: also(e), change: minute)
    }
    let timed = entries(now, tasks: Pref.barTasks).filter { !$0.allDay }
    let running = timed.first { $0.start <= now }, next = timed.first { $0.start > now && Calendar.current.isDate($0.start, inSameDayAs: now) }
    if let n = next, running == nil || n.start.timeIntervalSince(now) <= 600 {
      let soon = TimeInterval(Pref.barSoon * 60)
      if n.start.timeIntervalSince(now) <= soon { return BarLabel(text: "\(short(n.title)) in \(left(n.start))", color: n.color, also: also(n.event), change: minute) }
      return BarLabel(text: "\(time(n.start)) \(short(n.title))", color: n.color, also: also(n.event), change: n.start.addingTimeInterval(-soon))
    }
    if let r = running { return BarLabel(text: "\(short(r.title)) · \(left(r.end)) left", color: r.color, also: also(r.event), change: minute) }
    return BarLabel(change: Calendar.current.startOfDay(for: now.addingTimeInterval(86400)))
  }

  /// The date item: drawn once a day (and when it is switched on or off), nothing in between.
  func drawDate(_ now: Date) {
    guard Pref.dateIcon else { if let d = dateItem { NSStatusBar.system.removeStatusItem(d); dateItem = nil; shownDate = "" }; return }
    if dateItem == nil {
      let d = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength); d.autosaveName = "date"
      d.button?.target = self; d.button?.action = #selector(click(_:)); d.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
      dateItem = d
    }
    let f = DateFormatter(); f.dateFormat = "EEE"
    let wd = f.string(from: now).replacingOccurrences(of: ".", with: "").uppercased(), day = String(Calendar.current.component(.day, from: now))
    guard wd + day != shownDate, let b = dateItem?.button else { return }
    shownDate = wd + day
    let top = NSAttributedString(string: wd, attributes: [.font: NSFont.systemFont(ofSize: 7, weight: .bold), .kern: 0.3, .foregroundColor: NSColor.black])
    let bottom = NSAttributedString(string: day, attributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: 9.5, weight: .bold), .foregroundColor: NSColor.black])
    let w = ceil(max(top.size().width, bottom.size().width)) + 2, h: CGFloat = 18   // about the height of the system's icons
    let img = NSImage(size: NSSize(width: max(w, 16), height: h), flipped: false) { r in
      top.draw(at: NSPoint(x: (r.width - top.size().width) / 2, y: 9.5))
      bottom.draw(at: NSPoint(x: (r.width - bottom.size().width) / 2, y: -0.5))
      return true
    }
    img.isTemplate = true   // follows the menu bar's color, light or dark
    b.image = img; b.imagePosition = .imageOnly
    let full = DateFormatter(); full.dateStyle = .full; b.setAccessibilityLabel(full.string(from: now)); b.toolTip = full.string(from: now)
  }

  func draw() {
    let now = clockNow(), l = label(now), size = CGFloat(Pref.barSize), color = Pref.barColor
    drawDate(now)
    // with the date item there, the appointment item steps aside when there is nothing to show
    let visible = !(Pref.dateIcon && l.text.isEmpty && !rejected)
    if item.isVisible != visible { item.isVisible = visible }
    let key = "\(l.text)|\(l.color?.description ?? "")|\(l.also.count)|\(size)|\(color)|\(rejected)"
    if key != shown, let b = item.button {
      shown = key
      if l.text.isEmpty || rejected {
        // nothing to say: a small symbol keeps the item there to click
        let img = NSImage(systemSymbolName: rejected ? "calendar.badge.exclamationmark" : "calendar", accessibilityDescription: "Smart Calendar")?.withSymbolConfiguration(.init(pointSize: size, weight: .regular))
        img?.isTemplate = true; b.image = img
      } else if color, let c = l.color {
        // the calendar's color as a band, like in the panel
        b.image = NSImage(size: NSSize(width: 3, height: size + 1), flipped: false) { r in c.setFill(); NSBezierPath(roundedRect: r, xRadius: 1.5, yRadius: 1.5).fill(); return true }
      } else { b.image = nil }
      let t = NSMutableAttributedString(string: l.text.isEmpty ? "" : (b.image == nil ? "" : " ") + l.text, attributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: size, weight: .regular), .baselineOffset: 0.5])
      if color { for c in l.also { t.append(NSAttributedString(string: " ●", attributes: [.font: NSFont.systemFont(ofSize: size * 0.55), .foregroundColor: c, .baselineOffset: size * 0.2])) } }
      b.attributedTitle = t
      b.setAccessibilityLabel(l.text.isEmpty ? "Smart Calendar" : l.text)
    }
    drawTimer?.invalidate(); drawTimer = nil
    guard !asleep else { return }
    let edges = entries(now, tasks: Pref.barTasks).flatMap { [$0.start, $0.end] }.filter { $0 > now }
    let at = max((edges + [l.change]).min()!, now.addingTimeInterval(1))
    drawTimer = after(at.timeIntervalSince(now), tolerance: 2) { [weak self] in self?.draw() }
  }

  // MARK: Menu: the Now tab

  func menuWillOpen(_ m: NSMenu) { menuOpen = true; build(); if clockNow().timeIntervalSince(fetched) > 120 && !stream.isOpen { fetch() } }
  func menuDidClose(_ m: NSMenu) { menuOpen = false; m.removeAllItems() }

  func build() {
    menu.removeAllItems()
    let now = clockNow(), cal = Calendar.current, list = entries(now)
    if !ready { add("Set Up…", "gearshape", #selector(openSettings)); menu.addItem(.separator()) }
    else if let f = failure { header(f) }

    header("Now")
    if let a = agenda?.active {
      menu.addItem(row(a.title, a.until.map { "until " + time(Date(ms: $0)) } ?? span(Int(now.timeIntervalSince(Date(ms: a.since)) / 60)), .controlAccentColor))
      add("Pause", "pause.fill", #selector(stop))
      add("Done", "checkmark", #selector(done(_:)), [a.taskId, a.period])
      add("30 More Minutes", "plus", #selector(more(_:)), [a.taskId, a.period])
      postpone(a.taskId, a.period, a.recur, into: menu)
    } else if let e = tracked {
      let end = Date(ms: e.end)
      menu.addItem(row(e.title, end > now ? "until " + time(end) : "+" + span(Int(now.timeIntervalSince(end) / 60)), NSColor(hex: e.color)))
      add("Pause", "pause.fill", #selector(evPause(_:)), e.id)
      menu.addItem(doneItem(e, now))
      if let j = e.join { add("Join", "video", #selector(join(_:)), j) }
    } else if let r = list.first(where: { !$0.allDay && $0.start <= now }) {
      menu.addItem(entry(r, now))
      if let t = r.task {
        add("Start", "play.fill", #selector(start(_:)), [t.taskId, t.period])
        add("Done", "checkmark", #selector(done(_:)), [t.taskId, t.period])
        postpone(t.taskId, t.period, t.recur, into: menu)
      } else if let e = r.event {
        if let j = e.join { add("Join", "video", #selector(join(_:)), j) }
        add(e.spent > 0 ? "Resume" : "Start", "play.fill", #selector(evStart(_:)), e.id)
        menu.addItem(doneItem(e, now))
      }
    } else {
      let next = list.first { !$0.allDay && $0.start > now }
      let free = NSMenuItem(title: next.map { cal.isDate($0.start, inSameDayAs: now) ? "Free until " + time($0.start) : "Free for today" } ?? (agenda == nil ? "–" : "Free"), action: nil, keyEquivalent: "")
      free.isEnabled = false; menu.addItem(free)
      if agenda != nil {
        add("Break", "cup.and.saucer", #selector(pause(_:)), 15)
        add("Lunch", "fork.knife", #selector(pause(_:)), 45)
      }
    }

    // appointments that ended today and aren't done yet: a meeting that ran longer gets its real end here
    let earlier = (agenda?.events ?? []).filter { visible($0) && !$0.allDay && $0.since == nil && Date(ms: $0.end) <= now }.suffix(4)
    if !earlier.isEmpty {
      menu.addItem(.separator()); header("Earlier")
      for e in earlier {
        let i = row(e.title, time(Date(ms: e.start)), NSColor(hex: e.color)), sub = NSMenu()
        sub.autoenablesItems = false; sub.addItem(doneItem(e, now))
        sub.addItem(make(e.spent > 0 ? "Resume" : "Start", "play.fill", #selector(evStart(_:)), e.id))
        i.submenu = sub; menu.addItem(i)
      }
    }

    for day in 0..<2 {
      let d0 = cal.date(byAdding: .day, value: day, to: cal.startOfDay(for: now))!, d1 = cal.date(byAdding: .day, value: 1, to: d0)!
      let items = list.filter { $0.allDay ? $0.start < d1 && $0.end > d0 : $0.start >= max(d0, now) && $0.start < d1 }
      if items.isEmpty { continue }
      menu.addItem(.separator()); header(day == 0 ? "Next" : "Tomorrow")
      for e in items.prefix(12) {
        let i = entry(e, now), sub = NSMenu(); sub.autoenablesItems = false
        if let t = e.task {
          sub.addItem(make("Start Now", "play.fill", #selector(start(_:)), [t.taskId, t.period]))
          sub.addItem(make("Done", "checkmark", #selector(done(_:)), [t.taskId, t.period]))
          postpone(t.taskId, t.period, t.recur, into: sub)
          sub.addItem(t.pinned == true ? make("Unpin", "pin.slash", #selector(unpin(_:)), [t.taskId, t.period])
                                       : make("Pin Here", "pin", #selector(pin(_:)), [t.taskId, t.period, Int(t.start), Int(t.end)]))
        } else if let ev = e.event {
          if let j = ev.join { sub.addItem(make("Join", "video", #selector(join(_:)), j)) }
          if !ev.allDay { sub.addItem(make("Start Now", "play.fill", #selector(evStart(_:)), ev.id)) }
          if !ev.allDay && ev.editable { sub.addItem(make("Make Flexible", "arrow.left.and.right", #selector(flexible(_:)), ev.id)) }
          sub.addItem(make("Show in Calendar", "calendar", #selector(openCalendar), nil))
        }
        i.submenu = sub; menu.addItem(i)
      }
    }

    menu.addItem(.separator())
    let new = make("New", "plus", nil, nil), ns = NSMenu(); ns.autoenablesItems = false
    ns.addItem(make("Task", "checklist", #selector(newItem(_:)), NewKind.task.rawValue))
    if agenda?.calendars?.contains(where: { $0.writable == true }) == true { ns.addItem(make("Appointment", "calendar", #selector(newItem(_:)), NewKind.event.rawValue)) }
    ns.addItem(make("Flexible Appointment", "clock", #selector(newItem(_:)), NewKind.flex.rawValue))
    new.submenu = ns; menu.addItem(new)
    add("Open Smart Calendar", "arrow.up.forward.app", #selector(openApp), key: "o")
    let l = add("Open at Login", nil, #selector(toggleLogin)); l.state = SMAppService.mainApp.status == .enabled ? .on : .off
    add("Settings…", "gearshape", #selector(openSettings), key: ",")
    add("Quit", nil, #selector(NSApplication.terminate(_:)), key: "q", target: NSApp)
  }

  /// Done for an appointment that has started: it ended now, as planned, or at a time you pick. The calendar gets the real end
  /// (earlier or later than planned) and what is flexible after it is planned again.
  func doneItem(_ e: Agenda.Event, _ now: Date) -> NSMenuItem {
    let end = Date(ms: e.end)
    let i = make("Done", "checkmark", nil, nil), sub = NSMenu(); sub.autoenablesItems = false
    sub.addItem(make("Ended Now · " + time(now), nil, #selector(evDone(_:)), Ending(id: e.id, end: nil)))
    if end <= now { sub.addItem(make("Ended as Planned · " + time(end), nil, #selector(evDone(_:)), Ending(id: e.id, end: "planned"))) }
    sub.addItem(make("Other Time…", nil, #selector(evOther(_:)), e))
    i.submenu = sub; return i
  }
  final class Ending: NSObject { let id: Int; let end: Any?; init(id: Int, end: Any?) { self.id = id; self.end = end } }

  func postpone(_ id: Int, _ period: Int, _ recur: Bool, into m: NSMenu) {
    let sub = NSMenu(); sub.autoenablesItems = false
    for (t, d) in App.laterChoices() {
      sub.addItem(make(t, nil, #selector(later(_:)), [id, period, Int(d.timeIntervalSince1970 * 1000)]))
    }
    if recur { sub.addItem(.separator()); sub.addItem(make("Skip This Time", nil, #selector(skip(_:)), [id, period])) }
    let i = make("Postpone", "clock.arrow.circlepath", nil, nil); i.submenu = sub; m.addItem(i)
  }

  func header(_ s: String) { menu.addItem(.sectionHeader(title: s)) }
  @discardableResult
  func add(_ title: String, _ symbol: String?, _ sel: Selector, _ obj: Any? = nil, key: String = "", target: AnyObject? = nil) -> NSMenuItem {
    let i = make(title, symbol, sel, obj, key: key, target: target); menu.addItem(i); return i
  }
  func make(_ title: String, _ symbol: String?, _ sel: Selector?, _ obj: Any?, key: String = "", target: AnyObject? = nil) -> NSMenuItem {
    let i = NSMenuItem(title: title, action: sel, keyEquivalent: key)
    i.target = target ?? self; i.representedObject = obj
    if let symbol { i.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil) }
    return i
  }
  func entry(_ e: Entry, _ now: Date) -> NSMenuItem {
    let when = e.allDay ? "All day" : e.start <= now ? "until " + time(e.end) : time(e.start)
    let i = row(e.title, when, e.color, dim: !(e.event?.blocks ?? true), also: (e.event?.alsoIn ?? []).map { NSColor(hex: $0.color) })
    i.toolTip = [e.event?.cal ?? e.task?.project, e.event?.location ?? e.task?.location].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    return i
  }
  /// The calendar's color as a band, the time in a fixed column, the title, then a dot for each calendar it is copied into.
  func row(_ title: String, _ when: String, _ color: NSColor, dim: Bool = false, also: [NSColor] = []) -> NSMenuItem {
    let i = NSMenuItem(title: title, action: nil, keyEquivalent: "")
    let f = NSFont.menuFont(ofSize: 0), p = NSMutableParagraphStyle(); p.tabStops = [NSTextTab(textAlignment: .left, location: 72)]
    let s = NSMutableAttributedString(string: when + "\t", attributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: f.pointSize, weight: .regular), .foregroundColor: NSColor.secondaryLabelColor, .paragraphStyle: p])
    s.append(NSAttributedString(string: title.count > 44 ? String(title.prefix(43)) + "…" : title, attributes: [.font: f, .foregroundColor: dim ? NSColor.secondaryLabelColor : NSColor.labelColor, .paragraphStyle: p]))
    for c in also { s.append(NSAttributedString(string: "  ●", attributes: [.font: NSFont.systemFont(ofSize: 7), .foregroundColor: c, .baselineOffset: 2])) }
    i.attributedTitle = s
    i.image = NSImage(size: NSSize(width: 4, height: 15), flipped: false) { r in color.setFill(); NSBezierPath(roundedRect: r, xRadius: 1.5, yRadius: 1.5).fill(); return true }
    return i
  }

  // MARK: Actions

  // shared by menu and panel
  func taskStart(_ id: Int, _ p: Int) { act("/api/ext/tasks/\(id)/start", ["period": p]) }
  func taskDone(_ id: Int, _ p: Int) { act("/api/ext/tasks/\(id)/done", ["period": p]) }
  func taskMore(_ id: Int) { act("/api/ext/tasks/\(id)/more", ["minutes": 30]) }
  func taskLater(_ id: Int, _ p: Int, _ until: Date) { act("/api/ext/tasks/\(id)/postpone", ["period": p, "until": Int(until.timeIntervalSince1970 * 1000)]) }
  func taskSkip(_ id: Int, _ p: Int) { act("/api/ext/tasks/\(id)/skip", ["period": p]) }
  func timerStop() { act("/api/ext/timer/stop") }
  func takeBreak(_ m: Int) { act("/api/ext/break", ["minutes": m, "title": m == 45 ? "Lunch" : "Break"]) }
  func eventStart(_ id: Int) { act("/api/ext/events/\(id)/start") }
  func eventPause(_ id: Int) { act("/api/ext/events/\(id)/pause") }
  /// end: nil = now, "planned", or a time
  func eventDone(_ id: Int, end: Any? = nil) { act("/api/ext/events/\(id)/done", end.map { ["end": $0 is Date ? Int(($0 as! Date).timeIntervalSince1970 * 1000) : $0] } ?? [:]) }
  func taskPin(_ id: Int, _ p: Int, _ s: Double, _ e: Double) { act("/api/ext/tasks/\(id)/pin", ["period": p, "start": Int(s), "end": Int(e)]) }
  func taskUnpin(_ id: Int, _ p: Int) { act("/api/ext/tasks/\(id)/unpin", ["period": p]) }
  func eventFlexible(_ id: Int) { act("/api/ext/events/\(id)/flexible") }
  func addTask(_ title: String, minutes: Int, project: Int) { act("/api/ext/tasks", ["title": title, "minutes": minutes, "project_id": project]) }
  func addEvent(_ title: String, start: Date, minutes: Int, calendar: Int, place: String) {
    let s = Int(start.timeIntervalSince1970 * 1000)
    act("/api/ext/events", ["title": title, "start": s, "end": s + minutes * 60000, "calendar_id": calendar, "location": place])
  }
  func addFlexible(_ title: String, minutes: Int, days: [Int], from: String, to: String, after: String, calendar: Int, place: String) {
    act("/api/ext/flexible", ["title": title, "minutes": minutes, "win": ["days": days, "s": from, "e": to], "start_after": after, "calendar_id": calendar, "location": place])
  }
  /// Postpone choices, shared by menu and panel.
  static func laterChoices() -> [(String, Date)] {
    let cal = Calendar.current, today = cal.startOfDay(for: clockNow())
    return [("In 1 Hour", clockNow().addingTimeInterval(3600)), ("Tomorrow", cal.date(byAdding: .day, value: 1, to: today)!),
            ("Next Week", cal.nextDate(after: today, matching: DateComponents(weekday: 2), matchingPolicy: .nextTime)!)]
  }

  func ids(_ s: NSMenuItem) -> [Int] { s.representedObject as? [Int] ?? [0, 0] }
  @objc func start(_ s: NSMenuItem) { taskStart(ids(s)[0], ids(s)[1]) }
  @objc func done(_ s: NSMenuItem) { taskDone(ids(s)[0], ids(s)[1]) }
  @objc func more(_ s: NSMenuItem) { taskMore(ids(s)[0]) }
  @objc func later(_ s: NSMenuItem) { taskLater(ids(s)[0], ids(s)[1], Date(timeIntervalSince1970: Double(ids(s)[2]) / 1000)) }
  @objc func skip(_ s: NSMenuItem) { taskSkip(ids(s)[0], ids(s)[1]) }
  @objc func pin(_ s: NSMenuItem) { let v = ids(s); taskPin(v[0], v[1], Double(v[2]), Double(v[3])) }
  @objc func unpin(_ s: NSMenuItem) { taskUnpin(ids(s)[0], ids(s)[1]) }
  @objc func flexible(_ s: NSMenuItem) { if let id = s.representedObject as? Int { eventFlexible(id) } }
  @objc func newItem(_ s: NSMenuItem) { if let k = (s.representedObject as? String).flatMap(NewKind.init) { showPanel(form: k) } }
  @objc func stop() { timerStop() }
  @objc func pause(_ s: NSMenuItem) { takeBreak(s.representedObject as? Int ?? 15) }
  @objc func evStart(_ s: NSMenuItem) { if let id = s.representedObject as? Int { eventStart(id) } }
  @objc func evPause(_ s: NSMenuItem) { if let id = s.representedObject as? Int { eventPause(id) } }
  @objc func evDone(_ s: NSMenuItem) { if let x = s.representedObject as? Ending { eventDone(x.id, end: x.end) } }
  @objc func evOther(_ s: NSMenuItem) {
    guard let e = s.representedObject as? Agenda.Event else { return }
    let a = NSAlert(); a.messageText = e.title; a.informativeText = "Ended at"; a.addButton(withTitle: "Done"); a.addButton(withTitle: "Cancel")
    let p = NSDatePicker(); p.datePickerStyle = .textFieldAndStepper; p.datePickerElements = .hourMinute
    p.minDate = Date(ms: e.start).addingTimeInterval(60); p.maxDate = clockNow(); p.dateValue = clockNow(); p.sizeToFit(); a.accessoryView = p
    NSApp.activate()
    if a.runModal() == .alertFirstButtonReturn { eventDone(e.id, end: p.dateValue) }
  }
  @objc func join(_ s: NSMenuItem) { if let j = s.representedObject as? String, let u = URL(string: j), u.scheme == "https" { NSWorkspace.shared.open(u) } }
  @objc func openApp() { open("/#/now") }
  @objc func openCalendar() { open("/#/calendar") }
  func open(_ path: String) { if let u = URL(string: base + path) { NSWorkspace.shared.open(u) } }
  @objc func toggleLogin() {
    do { if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() } else { try SMAppService.mainApp.register() } }
    catch { alert("Open at Login", error.localizedDescription) }
  }

  @objc func openSettings() {
    if panel.isShown { panel.performClose(nil) }
    if settingsWindow == nil {
      let w = NSWindow(contentViewController: NSHostingController(rootView: SettingsView().environmentObject(self)))
      w.title = "Smart Calendar Bar"; w.styleMask = [.titled, .closable]; w.isReleasedWhenClosed = false
      settingsWindow = w
    }
    settingsWindow?.center(); NSApp.activate(); settingsWindow?.makeKeyAndOrderFront(nil)
  }
  /// From Settings: nil when saved, otherwise what is wrong.
  func saveAccount(_ url: String, _ token: String) -> String? {
    let u = url.trimmingCharacters(in: .whitespaces), t = token.trimmingCharacters(in: .whitespaces)
    guard let p = URL(string: u), p.host != nil, p.scheme == "https" || p.host == "localhost" || p.host == "127.0.0.1" else { return "Use the https address" }
    if !t.isEmpty && !t.hasPrefix("sc_") { return "Not an access token" }
    UserDefaults.standard.set(u, forKey: "url"); if !t.isEmpty { Keychain.write(t) }
    reconnect(); return nil
  }
  func reconnect() { agenda = nil; month = nil; failure = nil; rejected = false; retry = 5; stream.close(); draw(); connect() }

  // MARK: Panel (left click) and menu (right click)

  @objc func click(_ b: NSStatusBarButton) {
    let e = NSApp.currentEvent, it = dateItem?.button === b ? dateItem! : item
    if e?.type == .rightMouseUp || e?.modifierFlags.contains(.control) == true {
      if panel.isShown { panel.performClose(nil) }
      it.menu = menu; b.performClick(nil); it.menu = nil   // the menu opens and closes inside performClick
    } else if panel.isShown { panel.performClose(nil) }
    else { showPanel(from: b) }
  }
  /// The panel under the item clicked (or the appointment item, else the date), optionally straight at a form for something new.
  func showPanel(form: NewKind? = nil, from: NSStatusBarButton? = nil) {
    guard let b = from ?? (item.isVisible ? item.button : nil) ?? dateItem?.button ?? item.button else { return }
    let st = PanelState(); st.form = form
    let host = NSHostingController(rootView: PanelView(s: st).environmentObject(self))
    host.sizingOptions = .preferredContentSize
    panel.contentViewController = host
    // active and key before the first click lands, so that click already hits a date or an entry (macOS 14's polite
    // activate() often leaves a menu bar app in the background, and the first click only woke the panel)
    NSApp.activate(ignoringOtherApps: true)
    panel.show(relativeTo: b.bounds, of: b, preferredEdge: .minY)
    panel.contentViewController?.view.window?.makeKey()
    // a menu bar app is often not the active one, so the popover would miss clicks elsewhere: watch them only while it is open
    if outside == nil { outside = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]) { [weak self] _ in self?.panel.performClose(nil) } }
    if clockNow().timeIntervalSince(fetched) > 120 && !stream.isOpen { fetch() }
  }
  func popoverDidClose(_ n: Notification) {
    if let o = outside { NSEvent.removeMonitor(o); outside = nil }
    panel.contentViewController = nil; month = nil; monthFrom = nil }   // nothing kept around while closed

  /// The agenda of a calendar page (6 weeks from `from`), fetched when the panel shows it.
  func loadMonth(_ from: Date, force: Bool = false) {
    if !force, monthFrom == from, month != nil { return }
    if monthFrom != from { month = nil }
    monthFrom = from
    let to = Calendar.current.date(byAdding: .day, value: 42, to: from)!
    guard ready, let r = request("/api/ext/agenda?from=\(Int(from.timeIntervalSince1970 * 1000))&to=\(Int(to.timeIntervalSince1970 * 1000))") else { return }
    http.dataTask(with: r) { data, resp, _ in
      let a = (resp as? HTTPURLResponse)?.statusCode == 200 ? data.flatMap { try? JSONDecoder().decode(Agenda.self, from: $0) } : nil
      DispatchQueue.main.async { if let a, self.monthFrom == from { self.month = a } }
    }.resume()
  }

  /// smartcalendar://connect?url=…&token=… from Settings → Connect this Mac; asks first, so no web page can redirect the app quietly.
  func application(_ app: NSApplication, open urls: [URL]) {
    guard let u = urls.first, u.scheme == "smartcalendar", u.host == "connect", let q = URLComponents(url: u, resolvingAgainstBaseURL: false)?.queryItems,
          let addr = q.first(where: { $0.name == "url" })?.value, let tok = q.first(where: { $0.name == "token" })?.value,
          let host = URL(string: addr)?.host, addr.hasPrefix("https://"), tok.hasPrefix("sc_") else { return }
    let a = NSAlert(); a.messageText = "Connect to \(host)?"; a.icon = NSApp.applicationIconImage
    a.addButton(withTitle: "Connect"); a.addButton(withTitle: "Cancel")
    NSApp.activate()
    guard a.runModal() == .alertFirstButtonReturn else { return }
    let first = base.isEmpty
    UserDefaults.standard.set(addr, forKey: "url"); Keychain.write(tok)
    if first { try? SMAppService.mainApp.register() }
    settingsWindow?.close(); reconnect()
  }
  func alert(_ title: String, _ text: String) { let a = NSAlert(); a.messageText = title; a.informativeText = text; NSApp.activate(); a.runModal() }
}

let fmt: DateFormatter = { let f = DateFormatter(); f.timeStyle = .short; f.dateStyle = .none; return f }()
func time(_ d: Date) -> String { fmt.string(from: d) }
func short(_ s: String) -> String { let n = Pref.barLength; return s.count > n ? String(s.prefix(n - 1)).trimmingCharacters(in: .whitespaces) + "…" : s }

/// Preferences (Settings window), read where they are used.
enum Pref {
  static let defaults: [String: Any] = ["dateIcon": true, "barColor": true, "barSize": 13, "barTasks": true, "barSoon": 60, "barLength": 24, "weekNumbers": false, "gaps": true, "panelTasks": true, "showFree": false, "hiddenCals": [Int]()]
  static var barColor: Bool { UserDefaults.standard.bool(forKey: "barColor") }
  static var dateIcon: Bool { UserDefaults.standard.bool(forKey: "dateIcon") }
  /// all of our settings in one string, to tell our changes from the ones macOS makes
  static var signature: String { defaults.keys.sorted().map { "\($0)=\(UserDefaults.standard.object(forKey: $0) ?? "")" }.joined(separator: ";") + "|\(UserDefaults.standard.string(forKey: "url") ?? "")" }
  static var barSize: Int { min(14, max(10, UserDefaults.standard.integer(forKey: "barSize"))) }
  static var showFree: Bool { UserDefaults.standard.bool(forKey: "showFree") }
  static var hiddenCals: [Int] { UserDefaults.standard.array(forKey: "hiddenCals") as? [Int] ?? [] }
  static var barTasks: Bool { UserDefaults.standard.bool(forKey: "barTasks") }
  static var barSoon: Int { UserDefaults.standard.integer(forKey: "barSoon") }
  static var barLength: Int { max(8, UserDefaults.standard.integer(forKey: "barLength")) }
}
func span(_ m: Int) -> String { let m = max(m, 0); return m < 60 ? "\(m) min" : m % 60 == 0 ? "\(m / 60) h" : "\(m / 60) h \(m % 60) min" }
extension Date { init(ms: Double) { self.init(timeIntervalSince1970: ms / 1000) } }
extension NSColor {
  convenience init(hex: String?) {
    var v: UInt64 = 0
    guard let h = hex?.trimmingCharacters(in: CharacterSet(charactersIn: "#")), h.count == 6, Scanner(string: h).scanHexInt64(&v) else { self.init(white: 0.6, alpha: 1); return }
    self.init(srgbRed: CGFloat(v >> 16 & 255) / 255, green: CGFloat(v >> 8 & 255) / 255, blue: CGFloat(v & 255) / 255, alpha: 1)
  }
}

let app = NSApplication.shared, delegate = App()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
