package android.app

class Notification(val channel: String, val title: String, val body: String, val payload: String?, val alertOnce: Boolean, val expiresAt: Long?)
class StatusBarNotification(val tag: String?, val id: Int, val notification: Notification)
class NotificationManager {
  val records = LinkedHashMap<Pair<String?, Int>, Notification>()
  val posts = mutableListOf<StatusBarNotification>()
  val activeNotifications: Array<StatusBarNotification> get() = records.map { (key, value) -> StatusBarNotification(key.first, key.second, value) }.toTypedArray()
  fun notify(tag: String?, id: Int, value: Notification) { records[tag to id] = value; posts.add(StatusBarNotification(tag, id, value)) }
  fun cancel(tag: String?, id: Int) { records.remove(tag to id) }
  fun cancel(id: Int) { records.remove(null to id) }
}
