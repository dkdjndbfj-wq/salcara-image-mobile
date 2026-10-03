import ExpoModulesCore
import UserNotifications

/**
 * iOS local notifications for finished remote tasks / approvals.
 * iOS gives a background app only seconds, so there is no watch service here;
 * notifications appear for events the app sees while it is still running.
 */
public class SalcaraNotifyModule: Module {
  private let center = UNUserNotificationCenter.current()
  private let relay = NotificationRelay()

  public func definition() -> ModuleDefinition {
    Name("SalcaraNotify")
    Events("onOpen")

    OnCreate {
      self.relay.onOpen = { [weak self] payload in self?.sendEvent("onOpen", ["payload": payload]) }
      if self.center.delegate == nil { self.center.delegate = self.relay }
    }

    Function("canNotify") { () -> Bool in
      let semaphore = DispatchSemaphore(value: 0)
      var allowed = false
      self.center.getNotificationSettings { settings in
        allowed = settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
        semaphore.signal()
      }
      _ = semaphore.wait(timeout: .now() + 1)
      return allowed
    }

    AsyncFunction("requestPermission") { (promise: Promise) in
      self.center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in promise.resolve(granted) }
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
      let payload = self.relay.pending
      self.relay.pending = nil
      return payload
    }
  }
}

final class NotificationRelay: NSObject, UNUserNotificationCenterDelegate {
  var pending: String?
  var onOpen: ((String) -> Void)?

  func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
    if let payload = response.notification.request.content.userInfo["salcara_notification"] as? String {
      pending = payload
      onOpen?(payload)
    }
    completionHandler()
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
    completionHandler([.banner, .list])
  }
}
