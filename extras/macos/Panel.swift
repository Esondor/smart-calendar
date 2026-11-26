// The panel under the menu bar item (left click): a month with a dot for each calendar that has something on a day,
// the chosen day below it (for today with a red line at the current time, inside the running entry as far as it has got),
// and the details of an entry, unfolded beside the list. It exists only while it is open; the red line moves once a minute.
import AppKit
import SwiftUI

/// One entry of a day: an appointment, a planned task or a break.
struct Row: Identifiable {
  enum Kind { case event, task, rest }
  let id: String, kind: Kind, title: String, start: Date, end: Date, allDay: Bool
  let color: Color, also: [Agenda.Also], event: Agenda.Event?, task: Agenda.Task?
}

extension App {
  /// The side an entry unfolds to: away from the screen edge the panel is nearer to (the menu bar items are mostly on the right).
  var detailSide: Edge {
    guard let w = panel.contentViewController?.view.window, let sc = w.screen?.visibleFrame else { return .leading }
    return w.frame.minX - sc.minX >= 300 ? .leading : .trailing
  }
  /// Entries of one day, from the panel's month (it has the past too) or the live agenda until that arrives.
  func rows(on day: Date) -> [Row] {
    let cal = Calendar.current, d0 = cal.startOfDay(for: day), d1 = cal.date(byAdding: .day, value: 1, to: d0)!
    guard let src = month ?? agenda else { return [] }
    let live = agenda.map { Dictionary($0.events.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a }) } ?? [:]
    var out: [Row] = []
    for e0 in src.events {
      let e = live[e0.id] ?? e0, s = Date(ms: e.start), en = Date(ms: e.end)   // the live agenda knows what you started
      guard s < d1, en > d0, visible(e) else { continue }
      out.append(Row(id: "e\(e.id)", kind: .event, title: e.title, start: s, end: en, allDay: e.allDay, color: Color(nsColor: NSColor(hex: e.color)), also: e.alsoIn ?? [], event: e, task: nil))
    }
    if UserDefaults.standard.bool(forKey: "panelTasks") {
      for t in src.tasks where Date(ms: t.start) < d1 && Date(ms: t.end) > d0 {
        out.append(Row(id: "t\(t.taskId):\(t.period):\(t.start)", kind: .task, title: t.title, start: Date(ms: t.start), end: Date(ms: t.end), allDay: false, color: Color(nsColor: NSColor(hex: t.color)), also: [], event: nil, task: t))
      }
    }
    for b in src.breaks ?? [] where Date(ms: b.start) < d1 && Date(ms: b.end) > d0 {
      out.append(Row(id: "b\(b.start)", kind: .rest, title: b.title, start: Date(ms: b.start), end: Date(ms: b.end), allDay: false, color: Color.secondary.opacity(0.5), also: [], event: nil, task: nil))
    }
    return out.sorted { ($0.allDay ? 0 : 1, $0.start, $0.end) < ($1.allDay ? 0 : 1, $1.start, $1.end) }
  }
  /// Up to three calendar colors for a day of the month grid.
  func dots(on day: Date) -> [Color] {
    guard let m = month else { return [] }
    let cal = Calendar.current, d0 = cal.startOfDay(for: day), d1 = cal.date(byAdding: .day, value: 1, to: d0)!
    var seen: [String] = []
    for e in m.events where visible(e) && Date(ms: e.start) < d1 && Date(ms: e.end) > d0 { let c = e.color ?? ""; if !seen.contains(c) { seen.append(c) } }
    return seen.prefix(3).map { Color(nsColor: NSColor(hex: $0)) }
  }
}

final class PanelState: ObservableObject {
  @Published var page = Calendar.current.date(from: Calendar.current.dateComponents([.year, .month], from: clockNow()))!
  @Published var day = Calendar.current.startOfDay(for: clockNow())
  @Published var open: Row?
  @Published var form: NewKind?
}
enum NewKind: String { case task, event, flex }

struct PanelView: View {
  @EnvironmentObject var app: App
  @AppStorage("weekNumbers") var weekNumbers = false
  @ObservedObject var s: PanelState   // made by App, which can open it at a form; @State needs a compiler plugin the Command Line Tools don't have

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if let k = s.form { NewForm(kind: k) { withAnimation(.easeOut(duration: 0.15)) { s.form = nil } } }
      else {
        header.padding(.horizontal, 14).padding(.top, 12)
        MonthGrid(page: s.page, day: $s.day, weekNumbers: weekNumbers) { d in
          s.day = d
          if !Calendar.current.isDate(d, equalTo: s.page, toGranularity: .month) { s.page = Calendar.current.date(from: Calendar.current.dateComponents([.year, .month], from: d))! }
        }
        .padding(.horizontal, 10).padding(.top, 6)
        Divider().padding(.horizontal, 14).padding(.vertical, 8)
        DayList(day: s.day, open: $s.open)
        footer
      }
    }
    .frame(width: 292)
    .onAppear { app.loadMonth(gridStart(s.page)) }
    .onChange(of: s.page) { _, p in app.loadMonth(gridStart(p)) }
    .onChange(of: s.day) { _, _ in s.open = nil }
  }

  var header: some View {
    HStack(spacing: 14) {
      Text(s.page.formatted(.dateTime.month(.wide).year())).font(.system(size: 15, weight: .semibold)).foregroundStyle(.primary)
      Spacer()
      Button { s.page = Calendar.current.date(byAdding: .month, value: -1, to: s.page)! } label: { Image(systemName: "chevron.left") }
      Button {
        let now = clockNow(); s.day = Calendar.current.startOfDay(for: now)
        s.page = Calendar.current.date(from: Calendar.current.dateComponents([.year, .month], from: now))!
      } label: { Image(systemName: "circle") }.help("Today")
      Button { s.page = Calendar.current.date(byAdding: .month, value: 1, to: s.page)! } label: { Image(systemName: "chevron.right") }
    }
    .buttonStyle(.plain).foregroundStyle(.secondary).font(.system(size: 12, weight: .semibold))
  }

  var footer: some View {
    HStack(spacing: 16) {
      Menu {
        Button("Task") { s.form = .task }
        if app.agenda?.calendars?.contains(where: { $0.writable == true }) == true { Button("Appointment") { s.form = .event } }
        Button("Flexible Appointment") { s.form = .flex }
      } label: { Image(systemName: "plus") }.menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().help("New")
      Spacer()
      Button { app.open("/#/calendar") } label: { Image(systemName: "calendar") }.help("Open Smart Calendar")
      Button { app.openSettings() } label: { Image(systemName: "gearshape") }.help("Settings")
    }
    .buttonStyle(.plain).foregroundStyle(.secondary).font(.system(size: 13))
    .padding(.horizontal, 14).padding(.top, 6).padding(.bottom, 10)
  }
}

/// First day shown on a month page: the week start on or before the 1st.
func gridStart(_ page: Date) -> Date {
  let cal = Calendar.current, wd = cal.component(.weekday, from: page)
  return cal.date(byAdding: .day, value: -((wd - cal.firstWeekday + 7) % 7), to: page)!
}

struct MonthGrid: View {
  @EnvironmentObject var app: App
  let page: Date
  @Binding var day: Date
  let weekNumbers: Bool
  let pick: (Date) -> Void

  var body: some View {
    let cal = Calendar.current, start = gridStart(page), today = cal.startOfDay(for: clockNow())
    let syms = cal.veryShortStandaloneWeekdaySymbols, first = cal.firstWeekday - 1
    VStack(spacing: 2) {
      HStack(spacing: 0) {
        if weekNumbers { Text("").frame(width: 22) }
        ForEach(0..<7, id: \.self) { i in Text(syms[(first + i) % 7]).frame(maxWidth: .infinity) }
      }
      .font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary).padding(.bottom, 2)
      ForEach(0..<6, id: \.self) { w in
        HStack(spacing: 0) {
          if weekNumbers {
            Text("\(cal.component(.weekOfYear, from: cal.date(byAdding: .day, value: w * 7, to: start)!))")
              .font(.system(size: 10).monospacedDigit()).foregroundStyle(.tertiary).frame(width: 22)
          }
          ForEach(0..<7, id: \.self) { i in
            let d = cal.date(byAdding: .day, value: w * 7 + i, to: start)!
            DayCell(date: d, inMonth: cal.isDate(d, equalTo: page, toGranularity: .month), isToday: d == today, picked: d == day, dots: app.dots(on: d))
              .onTapGesture { pick(d) }
          }
        }
      }
    }
  }
}

struct DayCell: View {
  let date: Date, inMonth: Bool, isToday: Bool, picked: Bool, dots: [Color]
  var body: some View {
    VStack(spacing: 2) {
      Text("\(Calendar.current.component(.day, from: date))")
        .font(.system(size: 12.5, weight: isToday ? .semibold : .regular).monospacedDigit())
        .foregroundStyle(isToday ? Color.accentColor : inMonth ? Color.primary : Color.secondary.opacity(0.6))
      HStack(spacing: 2) { ForEach(0..<dots.count, id: \.self) { Circle().fill(dots[$0]).frame(width: 4, height: 4) } }.frame(height: 4)
    }
    .frame(maxWidth: .infinity).frame(height: 32)
    .background(RoundedRectangle(cornerRadius: 7).fill(picked ? Color.primary.opacity(0.09) : .clear))
    .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(isToday ? Color.accentColor.opacity(0.9) : .clear, lineWidth: 1.2))
    .contentShape(Rectangle())
  }
}

/// A day's entries; for today with free time in between and the red line at the current time.
struct DayList: View {
  @EnvironmentObject var app: App
  @AppStorage("gaps") var gaps = true
  let day: Date
  @Binding var open: Row?   // the entry shown beside the list, in its own popover

  enum Item { case row(Row, line: CGFloat?, past: Bool), gap(TimeInterval, line: CGFloat?), line }

  var body: some View {
    TimelineView(.everyMinute) { ctx in
      let items = layout(now: ctx.date.addingTimeInterval(Clock.offset)), cal = Calendar.current
      VStack(alignment: .leading, spacing: 0) {
        Text(cal.isDateInToday(day) ? "Today" : cal.isDateInTomorrow(day) ? "Tomorrow" : day.formatted(.dateTime.weekday(.wide).day().month(.wide)))
          .font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary).frame(maxWidth: .infinity).padding(.bottom, 6)
        if items.isEmpty { Text(app.month == nil && app.agenda == nil ? "–" : "Nothing planned").font(.system(size: 12)).foregroundStyle(.secondary).frame(maxWidth: .infinity).padding(.vertical, 10) }
        else if items.count > 8 { ScrollView { list(items) }.scrollIndicators(.never).frame(height: 340) }
        else { list(items) }
      }
      .padding(.horizontal, 10)
    }
  }

  func list(_ items: [Item]) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      ForEach(Array(items.enumerated()), id: \.offset) { _, it in
        switch it {
        case let .row(r, line, past):
          let on = Binding(get: { open?.id == r.id }, set: { if !$0, open?.id == r.id { open = nil } })
          EntryRow(row: r, line: line, past: past)
            .background(RoundedRectangle(cornerRadius: 6).fill(Color.primary.opacity(on.wrappedValue ? 0.08 : 0)))
            .onTapGesture { if r.kind != .rest { open = open?.id == r.id ? nil : r } }
            .popover(isPresented: on, arrowEdge: app.detailSide) {
              DetailView(row: r) { open = nil }.environmentObject(app).frame(width: 280)
            }
        case let .gap(t, line): GapRow(seconds: t, line: line)
        case .line: NowLine().padding(.vertical, 2)
        }
      }
    }
  }

  func layout(now: Date) -> [Item] {
    let rows = app.rows(on: day), today = Calendar.current.isDate(day, inSameDayAs: now), over = !today && day < now
    var out: [Item] = rows.filter(\.allDay).map { .row($0, line: nil, past: over) }
    var placed = !today, last: Date?
    for r in rows where !r.allDay {
      // free time ends when you have to leave for it
      let s = r.event.flatMap { e in e.travel.map { $0.leave(e.start) } } ?? r.start
      if let l = last, gaps, s.timeIntervalSince(l) >= 300 {
        var f: CGFloat?
        if !placed, now >= l, now < s { f = CGFloat(now.timeIntervalSince(l) / s.timeIntervalSince(l)); placed = true }
        out.append(.gap(s.timeIntervalSince(l), line: f))
      }
      if !placed, now < r.start { out.append(.line); placed = true }
      var f: CGFloat?
      if !placed, now >= r.start, now < r.end { f = CGFloat(now.timeIntervalSince(r.start) / r.end.timeIntervalSince(r.start)); placed = true }
      out.append(.row(r, line: f, past: over || (today && r.end <= now)))
      let free = r.event.flatMap { e in e.travel?.home(e.end) } ?? r.end   // free once you are home
      last = max(last ?? free, free)
    }
    if !placed, out.contains(where: { if case .row(let r, _, _) = $0 { return !r.allDay }; return false }) { out.append(.line) }
    return out
  }
}

struct NowLine: View {
  var body: some View {
    HStack(spacing: 0) { Circle().fill(Color.red).frame(width: 6, height: 6); Rectangle().fill(Color.red).frame(height: 1.2) }.frame(height: 6)
  }
}

struct EntryRow: View {
  @EnvironmentObject var app: App
  let row: Row, line: CGFloat?, past: Bool
  var body: some View {
    let ev = row.event, running = ev?.since != nil || app.agenda?.active.map { $0.taskId == row.task?.taskId } == true
    HStack(alignment: .center, spacing: 8) {
      RoundedRectangle(cornerRadius: 1.5).fill(row.color).frame(width: 3)
      VStack(alignment: .leading, spacing: 1) {
        Text(row.title).font(.system(size: 13, weight: .medium)).lineLimit(1).strikethrough(ev?.done == true)
          .foregroundStyle(row.kind == .rest ? Color.secondary : Color.primary)
        HStack(spacing: 4) {
          Text(row.allDay ? "All day" : "\(time(row.start))–\(time(row.end))")
          if let t = ev?.travel, t.before > 0, !past, let e = ev { Image(systemName: t.symbol).font(.system(size: 9)); Text(time(t.leave(e.start))) }
        }.font(.system(size: 11).monospacedDigit()).foregroundStyle(.secondary)
      }
      Spacer(minLength: 4)
      if running { Image(systemName: "timer").font(.system(size: 11)).foregroundStyle(.secondary) }
      if let e = ev, !e.allDay, e.done != true, row.start <= clockNow() {
        Menu { DoneChoices(event: e, end: row.end) } label: { Image(systemName: "checkmark.circle") }
          .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().foregroundStyle(.secondary).help("Done")
      }
      ForEach(Array(row.also.enumerated()), id: \.offset) { _, a in Circle().fill(Color(nsColor: NSColor(hex: a.color))).frame(width: 6, height: 6).help(a.name) }
      if let j = ev?.join, !past, let u = URL(string: j) {
        Button { NSWorkspace.shared.open(u) } label: { Image(systemName: "video").font(.system(size: 12)) }.buttonStyle(.plain).foregroundStyle(.secondary).help("Join")
      }
    }
    .fixedSize(horizontal: false, vertical: true)
    .padding(.vertical, 5).padding(.horizontal, 6)
    .background(RoundedRectangle(cornerRadius: 6).fill(line != nil ? row.color.opacity(0.16) : .clear))
    .overlay(alignment: .topLeading) { if let f = line { GeometryReader { g in NowLine().offset(y: g.size.height * f - 3) } } }
    .opacity(past ? 0.5 : 1)
    .contentShape(Rectangle())
  }
}

struct GapRow: View {
  let seconds: TimeInterval, line: CGFloat?
  var body: some View {
    HStack {
      Image(systemName: "ellipsis").rotationEffect(.degrees(90)).font(.system(size: 9))
      Spacer()
      Text(dur(Int(seconds / 60))).font(.system(size: 11).monospacedDigit())
    }
    .foregroundStyle(.tertiary).padding(.horizontal, 6).frame(height: 18)
    .overlay(alignment: .topLeading) { if let f = line { GeometryReader { g in NowLine().offset(y: g.size.height * f - 3) } } }
  }
}
func dur(_ m: Int) -> String { m < 60 ? "\(m)m" : m % 60 == 0 ? "\(m / 60)h" : "\(m / 60)h \(m % 60)m" }

/// One entry in full: when, which calendars, place, notes, and what you can do with it.
struct DetailView: View {
  @EnvironmentObject var app: App
  let row: Row
  let back: () -> Void
  @StateObject var pick = Box(false)   // the time picker for "Other Time…"
  @StateObject var end = Box(clockNow())

  var body: some View {
    let r = app.rows(on: row.start).first { $0.id == row.id } ?? row, now = clockNow()
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 10) {
        RoundedRectangle(cornerRadius: 2).fill(r.color).frame(width: 4)
        VStack(alignment: .leading, spacing: 3) {
          Text(r.title).font(.system(size: 16, weight: .semibold)).fixedSize(horizontal: false, vertical: true)
          Text(when(r)).font(.system(size: 12).monospacedDigit()).foregroundStyle(.secondary)
        }
      }
      .fixedSize(horizontal: false, vertical: true)
      VStack(alignment: .leading, spacing: 6) {
        if let c = r.event?.cal ?? r.task?.project { info("calendar", c, color: r.color) }
        ForEach(Array(r.also.enumerated()), id: \.offset) { _, a in info("square.on.square", a.name, color: Color(nsColor: NSColor(hex: a.color))) }
        if let p = r.event?.pin, let u = URL(string: p.url) {
          Button { NSWorkspace.shared.open(u) } label: { info("mappin.and.ellipse", r.event?.location.map { $0.isEmpty ? p.label : "\($0) · \(p.label)" } ?? p.label) }.buttonStyle(.plain).help("Google Maps")
        } else if let l = r.event?.location ?? r.task?.location, !l.isEmpty {
          Button { if let q = l.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed), let u = URL(string: "maps://?q=" + q) { NSWorkspace.shared.open(u) } } label: { info("mappin.and.ellipse", l) }.buttonStyle(.plain)
        }
        if let e = r.event, let t = e.travel, t.before > 0 { info(t.symbol, "Leave at \(time(t.leave(e.start))) · \(t.min) min by \(t.mode == "bike" ? "bike" : "car")") }
        if let e = r.event, let t = e.travel, let h = t.home(e.end) { info("house", "Home at \(time(h)) · \(t.min) min by \(t.mode == "bike" ? "bike" : "car")") }
        if let n = r.event?.notes { Text(n).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(8).textSelection(.enabled) }
      }
      actions(r, now)
      if pick.v, let e = r.event {
        HStack {
          DatePicker("Ended at", selection: $end.v, in: Date(ms: e.start).addingTimeInterval(60)...Date(), displayedComponents: .hourAndMinute).font(.system(size: 12))
          Button("Save") { app.eventDone(e.id, end: end.v); back() }.controlSize(.small)
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(14)
  }

  func when(_ r: Row) -> String {
    let d = r.start.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated))
    return r.allDay ? "\(d) · All day" : "\(d) · \(time(r.start))–\(time(r.end)) · \(dur(Int(r.end.timeIntervalSince(r.start) / 60)))"
  }
  func info(_ icon: String, _ text: String, color: Color? = nil) -> some View {
    HStack(spacing: 8) {
      Image(systemName: icon).font(.system(size: 11)).foregroundStyle(color ?? .secondary).frame(width: 14)
      Text(text).font(.system(size: 12)).lineLimit(2)
    }
  }

  /// What you can do: the main actions in the first row, the rest below, so nothing is cut off.
  @ViewBuilder func actions(_ r: Row, _ now: Date) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 6) {
        if let e = r.event {
          if let j = e.join, let u = URL(string: j) { Button { NSWorkspace.shared.open(u) } label: { Label("Join", systemImage: "video") }.buttonStyle(.borderedProminent) }
          if !e.allDay && e.done != true && r.start <= now.addingTimeInterval(3600) {
            if e.since != nil { Button { app.eventPause(e.id) } label: { Label("Pause", systemImage: "pause.fill") } }
            else { Button { app.eventStart(e.id) } label: { Label(e.spent > 0 ? "Resume" : "Start", systemImage: "play.fill") } }
          }
          if !e.allDay && e.done != true && r.start <= now {
            Menu { DoneChoices(event: e, end: r.end, after: back) { end.v = now; pick.v = true } } label: { Label("Done", systemImage: "checkmark") }
          }
        } else if let t = r.task {
          if app.agenda?.active?.taskId == t.taskId { Button { app.timerStop() } label: { Label("Pause", systemImage: "pause.fill") } }
          else { Button { app.taskStart(t.taskId, t.period) } label: { Label("Start", systemImage: "play.fill") } }
          Button { app.taskDone(t.taskId, t.period); back() } label: { Label("Done", systemImage: "checkmark") }
        }
      }
      HStack(spacing: 6) {
        if let e = r.event, !e.allDay, e.editable, r.start > now {
          Button { app.eventFlexible(e.id); back() } label: { Label("Make Flexible", systemImage: "arrow.left.and.right") }.help("Planned automatically from now on")
        } else if let t = r.task {
          Menu {
            ForEach(App.laterChoices(), id: \.0) { c in Button(c.0) { app.taskLater(t.taskId, t.period, c.1); back() } }
            if t.recur { Divider(); Button("Skip This Time") { app.taskSkip(t.taskId, t.period); back() } }
          } label: { Label("Postpone", systemImage: "clock.arrow.circlepath") }
          if t.pinned == true { Button { app.taskUnpin(t.taskId, t.period) } label: { Label("Unpin", systemImage: "pin.slash") }.help("Planned automatically again") }
          else { Button { app.taskPin(t.taskId, t.period, t.start, t.end) } label: { Label("Pin", systemImage: "pin") }.help("Stays at this time") }
        }
      }
    }
    .fixedSize().controlSize(.small).labelStyle(.titleAndIcon)
  }
}

/// Local view state (stands in for @State, see PanelView).
final class Box<T>: ObservableObject { @Published var v: T; init(_ v: T) { self.v = v } }

/// Done: ended now, as planned (once that time has passed), or at another time.
struct DoneChoices: View {
  @EnvironmentObject var app: App
  let event: Agenda.Event, end: Date
  var after: () -> Void = {}
  var other: (() -> Void)? = nil
  var body: some View {
    let now = clockNow()
    Button("Ended Now · \(time(now))") { app.eventDone(event.id); after() }
    if end <= now { Button("Ended as Planned · \(time(end))") { app.eventDone(event.id, end: "planned"); after() } }
    if let other { Button("Other Time…", action: other) }
  }
}

/// Something new, as with + in the app: a task, a fixed appointment, a flexible appointment.
final class Draft: ObservableObject {
  @Published var title = ""
  @Published var minutes = 30
  @Published var project = 0
  @Published var calendar = 0
  @Published var place = ""
  @Published var start = Calendar.current.date(bySetting: .minute, value: 0, of: clockNow().addingTimeInterval(3600)) ?? clockNow()
  @Published var from = Calendar.current.date(bySettingHour: 8, minute: 0, second: 0, of: clockNow())!
  @Published var to = Calendar.current.date(bySettingHour: 11, minute: 0, second: 0, of: clockNow())!
  @Published var after = clockNow()
  @Published var days: Set<Int> = [1, 2, 3, 4, 5]
}

struct NewForm: View {
  @EnvironmentObject var app: App
  let kind: NewKind
  let close: () -> Void
  @StateObject var d = Draft()

  var body: some View {
    let cals = (app.agenda?.calendars ?? []).filter { $0.writable == true }, projects = app.agenda?.projects ?? []
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        Button(action: close) { Image(systemName: "chevron.left") }.buttonStyle(.plain).foregroundStyle(.secondary)
        Text(kind == .task ? "Task" : kind == .event ? "Appointment" : "Flexible Appointment").font(.system(size: 13, weight: .semibold))
      }
      TextField("Title", text: $d.title).textFieldStyle(.roundedBorder)
      Picker("Takes", selection: $d.minutes) { ForEach(kind == .event ? [15, 30, 60, 90, 120] : [15, 30, 45, 60, 90], id: \.self) { Text(dur($0)).tag($0) } }.pickerStyle(.segmented)
      switch kind {
      case .task:
        Picker("Project", selection: $d.project) { ForEach(projects, id: \.id) { Text($0.name).tag($0.id) } }
      case .event:
        DatePicker("Starts", selection: $d.start, displayedComponents: [.date, .hourAndMinute])
        Picker("Calendar", selection: $d.calendar) { ForEach(cals, id: \.id) { Text($0.name).tag($0.id) } }
        TextField("Place", text: $d.place).textFieldStyle(.roundedBorder)
      case .flex:
        HStack(spacing: 4) {
          DatePicker("Between", selection: $d.from, displayedComponents: .hourAndMinute)
          Text("–"); DatePicker("", selection: $d.to, displayedComponents: .hourAndMinute).labelsHidden()
        }
        HStack(spacing: 3) {
          ForEach([1, 2, 3, 4, 5, 6, 0], id: \.self) { wd in
            let on = d.days.contains(wd)
            Text(Calendar.current.veryShortStandaloneWeekdaySymbols[wd]).font(.system(size: 11, weight: .medium)).frame(maxWidth: .infinity).frame(height: 22)
              .background(RoundedRectangle(cornerRadius: 5).fill(on ? Color.accentColor : Color.primary.opacity(0.07)))
              .foregroundStyle(on ? Color.white : Color.primary)
              .onTapGesture { if on { d.days.remove(wd) } else { d.days.insert(wd) } }
          }
        }
        DatePicker("From", selection: $d.after, displayedComponents: .date)
        Picker("Calendar", selection: $d.calendar) { Text("Plan calendar").tag(0); ForEach(cals, id: \.id) { Text($0.name).tag($0.id) } }
        TextField("Place", text: $d.place).textFieldStyle(.roundedBorder)
      }
      HStack {
        Spacer()
        Button(kind == .flex ? "Plan" : "Add") { submit(); close() }
          .keyboardShortcut(.defaultAction).disabled(!ready)
      }
    }
    .font(.system(size: 12)).controlSize(.small)
    .padding(14)
    .onAppear {
      if d.project == 0 { d.project = projects.first?.id ?? 0 }
      if kind == .event && d.calendar == 0 { d.calendar = cals.first?.id ?? 0 }
    }
  }

  var ready: Bool {
    let t = !d.title.trimmingCharacters(in: .whitespaces).isEmpty
    switch kind { case .task: return t; case .event: return t && d.calendar != 0; case .flex: return t && !d.days.isEmpty && d.to > d.from }
  }
  func submit() {
    let title = d.title.trimmingCharacters(in: .whitespaces), hm = DateFormatter(); hm.dateFormat = "HH:mm"
    let day = DateFormatter(); day.dateFormat = "yyyy-MM-dd"
    switch kind {
    case .task: app.addTask(title, minutes: d.minutes, project: d.project)
    case .event: app.addEvent(title, start: d.start, minutes: d.minutes, calendar: d.calendar, place: d.place)
    case .flex: app.addFlexible(title, minutes: d.minutes, days: d.days.sorted(), from: hm.string(from: d.from), to: hm.string(from: d.to), after: day.string(from: d.after), calendar: d.calendar, place: d.place)
    }
  }
}
