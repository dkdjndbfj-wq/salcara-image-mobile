import ExpoModulesCore
import FirebaseCore
import FirebaseMessaging
import UIKit
import UserNotifications

/**
 * iOS task notifications.
 *
 * Firebase Messaging delivers Hub alerts through APNs while the app is
 * backgrounded or closed. iOS suspends app code, so this deliberately has no
 * polling/watch service. Foreground task updates are shown by the app UI.
 */
public class SalcaraNotifyModule: Module {
  private let center = UNUserNotificationCenter.current()
  private let relay = NotificationRelay()
  private let permissionLock = NSLock()
  private var permissionGranted = false
  private var foregroundObserver: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("SalcaraNotify")
    Events("onOpen", "onPushToken", "onPermissionChange")

    OnCreate {
      self.configureFirebase()
      self.relay.onOpen = { [weak self] payload in self?.sendEvent("onOpen", ["payload": payload]) }
      self.relay.onToken = { [weak self] token in self?.sendEvent("onPushToken", ["token": token]) }
      if self.center.delegate == nil { self.center.delegate = self.relay }
      self.refreshPermissionState()
      self.foregroundObserver = NotificationCenter.default.addObserver(
        forName: UIApplication.willEnterForegroundNotification,
        object: nil,
        queue: .main
      ) { [weak self] _ in self?.refreshPermissionState() }

      if FirebaseApp.app() != nil {
        Messaging.messaging().delegate = self.relay
        self.center.getNotificationSettings { settings in
          if settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional || settings.authorizationStatus == .ephemeral {
            DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
          }
        }
      }
    }

    OnDestroy {
      if let observer = self.foregroundObserver {
        NotificationCenter.default.removeObserver(observer)
        self.foregroundObserver = nil
      }
    }

    Function("canNotify") { () -> Bool in self.hasNotificationPermission() }
    Function("setNotificationsEnabled") { (enabled: Bool) in self.relay.setEnabled(enabled) }
    Function("setNotificationTargets") { (json: String) in self.relay.setTargets(json) }
    Function("setVisibleNotificationTarget") { (scope: String?, session: String?) in self.relay.setVisible(scope, session) }
    Function("admitNotification") { (id: String, json: String) -> Bool in
      guard let data = json.data(using: .utf8), let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return false }
      return self.relay.admit(id: id, value: value)
    }

    AsyncFunction("requestPermission") { (promise: Promise) in
      self.center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
        self.setNotificationPermission(granted)
        self.sendEvent("onPermissionChange", ["allowed": granted])
        if granted { DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() } }
        promise.resolve(granted)
      }
    }

    AsyncFunction("pushToken") { (promise: Promise) in
      guard FirebaseApp.app() != nil else { promise.resolve(nil); return }
      Messaging.messaging().token { token, error in
        promise.resolve(error == nil ? token : nil)
      }
    }

    AsyncFunction("notify") { (id: String, title: String, body: String, payload: String) in
      let content = UNMutableNotificationContent()
      content.title = String(title.prefix(80))
      content.body = String(body.prefix(400))
      content.sound = .default
      content.userInfo = ["salcara_notification": payload]
      self.center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
    }

    AsyncFunction("startWatch") { (_: String, _: String) -> Bool in false }
    AsyncFunction("stopWatch") { () in }
    AsyncFunction("wait") { (ms: Int) async in
      try? await Task.sleep(nanoseconds: UInt64(max(0, min(ms, 30_000))) * 1_000_000)
    }

    Function("consumeLaunchPayload") { () -> String? in
      return self.relay.takePending()
    }
  }

  private func configureFirebase() {
    guard FirebaseApp.app() == nil,
      let path = Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist"),
      let options = FirebaseOptions(contentsOfFile: path) else { return }
    FirebaseApp.configure(options: options)
  }

  private func refreshPermissionState() {
    center.getNotificationSettings { [weak self] settings in
      guard let self else { return }
      let allowed = settings.authorizationStatus == .authorized
        || settings.authorizationStatus == .provisional
        || settings.authorizationStatus == .ephemeral
      self.setNotificationPermission(allowed)
      self.sendEvent("onPermissionChange", ["allowed": allowed])
    }
  }

  private func setNotificationPermission(_ value: Bool) {
    permissionLock.lock()
    permissionGranted = value
    permissionLock.unlock()
  }

  private func hasNotificationPermission() -> Bool {
    permissionLock.lock()
    defer { permissionLock.unlock() }
    return permissionGranted
  }
}

final class NotificationRelay: NSObject, UNUserNotificationCenterDelegate, MessagingDelegate {
  private let pendingLock = NSLock()
  private var pendingPayload: String?
  var onOpen: ((String) -> Void)?
  var onToken: ((String) -> Void)?
  private let policyLock = NSLock()
  private var visibleScope: String?
  private var visibleSession: String?
  private let defaults = UserDefaults.standard

  func setEnabled(_ enabled: Bool) {
    policyLock.lock(); defer { policyLock.unlock() }
    defaults.set(enabled, forKey: "salcara.notifications.enabled")
    if !enabled {
      let center = UNUserNotificationCenter.current()
      center.getDeliveredNotifications { notifications in
        center.removeDeliveredNotifications(withIdentifiers: notifications.filter {
          $0.request.content.userInfo["notificationScope"] != nil || $0.request.content.userInfo["salcara_notification"] != nil
        }.map { $0.request.identifier })
      }
    }
  }

  func setTargets(_ json: String) {
    guard let data = json.data(using: .utf8), data.count <= 65536,
      let rows = (try? JSONSerialization.jsonObject(with: data)) as? [[String: String]], rows.count <= 64,
      rows.allSatisfy({ $0["notificationScope"]?.range(of: "^ns1_[a-f0-9]{64}$", options: .regularExpression) != nil && !($0["deviceId"] ?? "").isEmpty }) else {
      policyLock.lock(); defaults.set([String: String](), forKey: "salcara.notifications.targets"); policyLock.unlock(); return
    }
    var targets: [String: String] = [:]
    for row in rows { targets[row["notificationScope"]!] = row["deviceId"]! }
    let allowedTargets = targets
    policyLock.lock(); defaults.set(targets, forKey: "salcara.notifications.targets"); policyLock.unlock()
    // Only already-delivered banners can be cleaned locally. Offline APNs may
    // still display before the process gets a chance to apply this allowlist.
    let center = UNUserNotificationCenter.current()
    center.getDeliveredNotifications { notifications in
      let stale = notifications.filter { notification in
        let value = notification.request.content.userInfo
        guard let scope = value["notificationScope"] as? String else { return false }
        return allowedTargets[scope] != (value["deviceId"] as? String)
      }.map { $0.request.identifier }
      center.removeDeliveredNotifications(withIdentifiers: stale)
    }
  }

  func setVisible(_ scope: String?, _ session: String?) {
    policyLock.lock(); visibleScope = scope; visibleSession = session; policyLock.unlock()
  }

  /** Shared admission for foreground JS and APNs; not an offline APNs filter. */
  func admit(id: String, value: [String: Any]) -> Bool {
    // Hub summaries keep the constituent identities so foreground replay cannot
    // produce another toast for each result in an already-shown summary.
    if id.contains(":summary:"), let encoded = value["taskIds"] as? String,
      let data = encoded.data(using: .utf8), data.count <= 4096,
      let rows = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]], !rows.isEmpty, rows.count <= 64 {
      var accepted = false
      for row in rows {
        guard let taskId = row["id"] as? String, !taskId.contains(":summary:") else { continue }
        var task = value
        task.removeValue(forKey: "taskIds")
        for (key, field) in row { task[key] = field }
        if admit(id: taskId, value: task) { accepted = true }
      }
      return accepted
    }
    policyLock.lock(); defer { policyLock.unlock() }
    guard defaults.bool(forKey: "salcara.notifications.enabled"),
      let scope = value["notificationScope"] as? String, let device = value["deviceId"] as? String,
      let targets = defaults.dictionary(forKey: "salcara.notifications.targets") as? [String: String], targets[scope] == device,
      id.hasPrefix(scope + ":"), id.count <= 2048 else { return false }
    let now = Date().timeIntervalSince1970 * 1000
    let rawKind = value["kind"] as? String ?? ""
    let kind = rawKind == "done" ? "completed" : rawKind
    guard ["reply", "completed", "failed", "approval", "question", "resolved"].contains(kind) else { return false }
    let expiry = (value["expiresAt"] as? NSNumber)?.doubleValue ?? Double(value["expiresAt"] as? String ?? "")
    var ledger = defaults.dictionary(forKey: "salcara.notifications.ledger") as? [String: [String: Any]] ?? [:]
    ledger = ledger.filter { now - (($0.value["at"] as? NSNumber)?.doubleValue ?? 0) < 86400000 }
    let previous = ledger[id]?["kind"] as? String
    if kind == "resolved" || ((kind == "approval" || kind == "question") && expiry.map { $0 <= now } == true) {
      ledger[id] = ["kind": "resolved", "at": now]
      defaults.set(ledger, forKey: "salcara.notifications.ledger")
      let center = UNUserNotificationCenter.current()
      center.getDeliveredNotifications { notifications in
        center.removeDeliveredNotifications(withIdentifiers: notifications.filter { $0.request.content.userInfo["id"] as? String == id }.map { $0.request.identifier })
      }
      return false
    }
    if previous != nil && !(kind == "failed" && (previous == "reply" || previous == "completed")) { return false }
    ledger[id] = ["kind": kind, "at": now]
    if ledger.count > 1000 {
      let oldest = ledger.sorted { (($0.value["at"] as? NSNumber)?.doubleValue ?? 0) < (($1.value["at"] as? NSNumber)?.doubleValue ?? 0) }
      for entry in oldest.prefix(ledger.count - 1000) { ledger.removeValue(forKey: entry.key) }
    }
    defaults.set(ledger, forKey: "salcara.notifications.ledger")
    return true
  }

  func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
    guard let fcmToken, !fcmToken.isEmpty else { return }
    onToken?(fcmToken)
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
    if let payload = payload(from: response.notification.request.content.userInfo) {
      pendingLock.lock()
      pendingPayload = payload
      pendingLock.unlock()
      onOpen?(payload)
    }
    completionHandler()
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
    let value = notification.request.content.userInfo
    let metadata = value.reduce(into: [String: Any]()) { result, pair in if let key = pair.key as? String { result[key] = pair.value } }
    guard let id = value["id"] as? String, admit(id: id, value: metadata) else { completionHandler([]); return }
    policyLock.lock()
    let visible = visibleScope != nil && visibleScope == (value["notificationScope"] as? String)
      && visibleSession == (value["sessionKey"] as? String) && (Int(value["notificationCount"] as? String ?? "1") ?? 1) <= 1
    policyLock.unlock()
    if visible { completionHandler([]) } else { completionHandler([.banner, .list, .sound]) }
  }

  func takePending() -> String? {
    pendingLock.lock()
    defer { pendingLock.unlock() }
    let payload = pendingPayload
    pendingPayload = nil
    return payload
  }

  private func payload(from userInfo: [AnyHashable: Any]) -> String? {
    if let local = userInfo["salcara_notification"] as? String { return local }
    guard let deviceId = userInfo["deviceId"] as? String,
      let sessionKey = userInfo["sessionKey"] as? String,
      !deviceId.isEmpty, !sessionKey.isEmpty else { return nil }
    var value: [String: String] = ["deviceId": deviceId, "sessionKey": sessionKey]
    if let scope = userInfo["notificationScope"] as? String { value["notificationScope"] = scope }
    if let count = userInfo["notificationCount"] as? String { value["notificationCount"] = count }
    else if let count = userInfo["notificationCount"] as? NSNumber { value["notificationCount"] = count.stringValue }
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return nil }
    return String(data: data, encoding: .utf8)
  }
}
