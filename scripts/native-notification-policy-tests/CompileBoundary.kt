package expo.modules.salcaranotify

import android.app.Notification
import android.content.Context

/** Compile-only Expo/Firebase boundary, never shipped or used to claim device runtime coverage. */
internal object SalcaraNotifyModule {
  const val WATCH_CHANNEL = "watch"
  const val TASK_CHANNEL = "task"
  const val QUIET_CHANNEL = "quiet"
  fun notificationsAllowed(context: Context): Boolean = error("compile-only")
  fun ensureChannels(context: Context): Unit = error("compile-only")
  fun postTaskNotification(context: Context, id: Int, notification: Notification): Unit = error("compile-only")
  fun postTaggedNotification(context: Context, tag: String, notification: Notification): Boolean = error("compile-only")
  fun build(context: Context, channel: String, title: String, body: String, payload: String?, ongoing: Boolean,
    actions: List<Notification.Action> = emptyList(), alertOnce: Boolean = true, expiresAt: Long? = null): Notification = error("compile-only")
}
internal object SalcaraPushService { fun inForeground(context: Context): Boolean = error("compile-only") }
