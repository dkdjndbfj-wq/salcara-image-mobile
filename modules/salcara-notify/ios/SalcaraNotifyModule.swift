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
    // The app renders foreground task updates in context. Never stack an OS
    // banner over the user's current typing or navigation.
    completionHandler([])
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
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return nil }
    return String(data: data, encoding: .utf8)
  }
}
