import AppIntents
import ExpoModulesCore
import Foundation

// Bridge between the App Intent and the JS side. The intent stashes its action in
// the app's UserDefaults; JS consumes it on mount and on foreground (see
// app/pocket.tsx), so the toggle fires exactly once whatever order the OS brings
// the app and the intent up in. The entry expires so a stale intent can never
// start a recording much later.
enum PocketIntentBridge {
  static let key = "pocket.pendingIntent"
  static let maxAge: TimeInterval = 20

  static func stash(_ action: String) {
    UserDefaults.standard.set(["action": action, "at": Date().timeIntervalSince1970], forKey: key)
  }

  static func consume() -> String? {
    guard let entry = UserDefaults.standard.dictionary(forKey: key),
          let action = entry["action"] as? String,
          let at = entry["at"] as? TimeInterval,
          Date().timeIntervalSince1970 - at < maxAge
    else { return nil }
    UserDefaults.standard.removeObject(forKey: key)
    return action
  }
}

public final class PocketModule: Module {
  public func definition() -> ModuleDefinition {
    Name("Pocket")

    Function("consumePendingIntentAction") {
      PocketIntentBridge.consume()
    }
  }
}

// The named action itself: appears under Shortcuts' "Run App Intent" and in the
// app's App Shortcuts, independent of any hand-made shortcut. iOS decides whether
// Back Tap lists it directly or bridges through a user-made Shortcut — the action
// is the same either way. openAppWhenRun brings the app up so the JS recorder
// logic (BLE lives there) can perform the toggle.
@available(iOS 16.0, *)
struct TogglePocketRecordingIntent: AppIntent {
  static var title: LocalizedStringResource = "Toggle Pocket Recording"
  static var description = IntentDescription("Starts a Pocket recording, or stops and ships the current one.")
  static var openAppWhenRun = true

  init() {}

  func perform() async throws -> some IntentResult {
    PocketIntentBridge.stash("record")
    return .result()
  }
}

@available(iOS 16.0, *)
struct PocketAppShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: TogglePocketRecordingIntent(),
      phrases: [
        "Toggle Pocket Recording in \(.applicationName)",
        "Record with \(.applicationName)",
      ],
      shortTitle: "Toggle Pocket Recording",
      systemImageName: "mic"
    )
  }
}
