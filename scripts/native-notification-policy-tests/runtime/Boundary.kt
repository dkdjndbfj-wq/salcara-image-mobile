package expo.modules.salcaranotify

import android.app.Notification
import android.content.Context

/** Executes the real notification center against a recording platform boundary. */
internal object SalcaraNotifyModule {
  const val WATCH_CHANNEL = "watch"
  const val TASK_CHANNEL = "task"
  const val QUIET_CHANNEL = "quiet"
  fun notificationsAllowed(context: Context) = context.allowed
  fun ensureChannels(context: Context) { }
  fun postTaskNotification(context: Context, id: Int, notification: Notification) { context.manager.notify(null, id, notification) }
  fun postTaggedNotification(context: Context, tag: String, notification: Notification): Boolean { if (!context.allowed) return false; context.manager.notify(tag, 0, notification); return true }
  fun build(context: Context, channel: String, title: String, body: String, payload: String?, ongoing: Boolean,
    alertOnce: Boolean = true, expiresAt: Long? = null) = Notification(channel, title, body, payload, alertOnce, expiresAt)
}
internal object SalcaraPushService { fun inForeground(context: Context) = context.foreground }
