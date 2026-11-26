// Settings window: what the menu bar shows, the panel, the account, Open at Login, Quit.
import AppKit
import ServiceManagement
import SwiftUI

struct SettingsView: View {
  @EnvironmentObject var app: App
  @AppStorage("dateIcon") var dateIcon = true
  @AppStorage("barColor") var barColor = true
  @AppStorage("barSize") var barSize = 13
  @AppStorage("showFree") var showFree = false
  @AppStorage("barTasks") var barTasks = true
  @AppStorage("barSoon") var barSoon = 60
  @AppStorage("barLength") var barLength = 24
  @AppStorage("weekNumbers") var weekNumbers = false
  @AppStorage("gaps") var gaps = true
  @AppStorage("panelTasks") var panelTasks = true
  @StateObject var url = Box("")
  @StateObject var token = Box("")
  @StateObject var problem = Box<String?>(nil)
  @StateObject var login = Box(SMAppService.mainApp.status == .enabled)

  /// A calendar on or off (off: left out of the menu bar, the menu and the panel).
  func shows(_ id: Int) -> Binding<Bool> {
    Binding(get: { !Pref.hiddenCals.contains(id) }, set: { on in
      UserDefaults.standard.set(Pref.hiddenCals.filter { $0 != id } + (on ? [] : [id]), forKey: "hiddenCals"); app.objectWillChange.send()
    })
  }

  var body: some View {
    Form {
      Section("Menu Bar") {
        Toggle("Date", isOn: $dateIcon)
        Picker("Text Size", selection: $barSize) { Text("Small").tag(11); Text("Medium").tag(12); Text("Standard").tag(13) }
        Toggle("Calendar Color", isOn: $barColor)
        Toggle("Tasks", isOn: $barTasks)
        Picker("Countdown", selection: $barSoon) { ForEach([15, 30, 60, 120], id: \.self) { Text("\($0) min before").tag($0) } }
        Picker("Title Length", selection: $barLength) { ForEach([16, 24, 32, 48], id: \.self) { Text("\($0) characters").tag($0) } }
      }
      Section("Calendar") {
        Toggle("Week Numbers", isOn: $weekNumbers)
        Toggle("Free Time", isOn: $gaps)
        Toggle("Tasks", isOn: $panelTasks)
      }
      Section("Shown") {
        ForEach(app.agenda?.calendars ?? app.month?.calendars ?? [], id: \.id) { c in
          Toggle(isOn: shows(c.id)) {
            HStack(spacing: 8) { RoundedRectangle(cornerRadius: 1.5).fill(Color(nsColor: NSColor(hex: c.color))).frame(width: 3, height: 14); Text(c.name) }
          }
        }
        Toggle("Appointments That Don't Block", isOn: $showFree)
      }
      Section("Account") {
        TextField("Address", text: $url.v, prompt: Text("https://plan.example.com"))
        SecureField("Token", text: $token.v, prompt: Text("sc_…"))
        HStack {
          if let p = problem.v { Text(p).foregroundStyle(.red).font(.callout) }
          else if app.rejected { Text("Token not accepted").foregroundStyle(.red).font(.callout) }
          else if app.agenda != nil { Label("Connected", systemImage: "checkmark.circle.fill").foregroundStyle(.green).font(.callout) }
          Spacer()
          Button("Save") { problem.v = app.saveAccount(url.v, token.v); if problem.v == nil { token.v = "" } }
            .disabled(url.v.isEmpty)
        }
      }
      Section {
        Toggle("Open at Login", isOn: $login.v).onChange(of: login.v) { _, on in
          do { if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() } } catch { login.v = !on }
        }
        HStack { Spacer(); Button("Quit Smart Calendar Bar") { NSApp.terminate(nil) } }
      }
    }
    .formStyle(.grouped)
    .frame(width: 400)
    .fixedSize(horizontal: false, vertical: true)
    .onAppear { url.v = app.base.isEmpty ? "https://" : app.base; login.v = SMAppService.mainApp.status == .enabled }
  }
}
