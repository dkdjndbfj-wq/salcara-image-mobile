import EventKit
import ExpoModulesCore

/**
 * iOS side of Salcara's confirmed phone actions.
 *
 * - insertEvent: the user already tapped “确认” on the card, so the event is
 *   written to the default calendar through EventKit (write-only access on
 *   iOS 17+, the classic calendar permission before that).
 * - setAlarm / setTimer: iOS has no public API for other apps to create Clock
 *   alarms or timers, so these reject with a message the card shows. The JS
 *   side does not offer them on iOS in the first place.
 */
public class SalcaraActionsModule: Module {
  private let store = EKEventStore()

  public func definition() -> ModuleDefinition {
    Name("SalcaraActions")

    AsyncFunction("setAlarm") { (hour: Int, minutes: Int, message: String, days: [Int], skipUi: Bool, promise: Promise) in
      promise.reject("ERR_UNSUPPORTED", "iPhone 不允许其他应用设置闹钟，请在“时钟”App 中手动设置")
    }

    AsyncFunction("setTimer") { (seconds: Int, message: String, skipUi: Bool, promise: Promise) in
      promise.reject("ERR_UNSUPPORTED", "iPhone 不允许其他应用设置倒计时，请在“时钟”App 中手动设置")
    }

    AsyncFunction("insertEvent") { (title: String, begin: Double, end: Double, allDay: Bool, location: String, description: String, promise: Promise) in
      let cleanTitle = String(title.trimmingCharacters(in: .whitespacesAndNewlines).prefix(200))
      if cleanTitle.isEmpty || !begin.isFinite || begin <= 0 {
        promise.reject("ERR_ARGUMENT", "日程信息不完整")
        return
      }
      self.requestWriteAccess { granted, error in
        if !granted {
          if let error = error {
            promise.reject("ERR_DENIED", "无法访问日历：\(error.localizedDescription)")
          } else {
            promise.reject("ERR_DENIED", "没有日历权限，请在“设置 → Salcara AI → 日历”中允许添加日程")
          }
          return
        }
        let store = self.store
        guard let calendar = store.defaultCalendarForNewEvents else {
          promise.reject("ERR_NO_CALENDAR", "没有找到可以写入的日历，请先在“日历”App 中设置默认日历")
          return
        }
        let start = Date(timeIntervalSince1970: begin / 1000)
        var finish = Date(timeIntervalSince1970: (end.isFinite && end > begin ? end : begin + (allDay ? 86_400_000 : 3_600_000)) / 1000)
        if allDay && finish.timeIntervalSince(start) >= 86_400 {
          // EventKit treats an all-day end date as inclusive (the last day), unlike Android's exclusive end.
          finish = finish.addingTimeInterval(-1)
        }
        let event = EKEvent(eventStore: store)
        event.calendar = calendar
        event.title = cleanTitle
        event.startDate = start
        event.endDate = finish
        event.isAllDay = allDay
        let place = location.trimmingCharacters(in: .whitespacesAndNewlines)
        if !place.isEmpty { event.location = String(place.prefix(300)) }
        let notes = description.trimmingCharacters(in: .whitespacesAndNewlines)
        if !notes.isEmpty { event.notes = String(notes.prefix(4000)) }
        do {
          try store.save(event, span: .thisEvent, commit: true)
          promise.resolve(true)
        } catch {
          promise.reject("ERR_SAVE", "添加日程失败：\(error.localizedDescription)")
        }
      }
    }
  }

  private func requestWriteAccess(_ completion: @escaping (Bool, Error?) -> Void) {
    if #available(iOS 17.0, *) {
      store.requestWriteOnlyAccessToEvents { granted, error in completion(granted, error) }
    } else {
      store.requestAccess(to: .event) { granted, error in completion(granted, error) }
    }
  }
}
