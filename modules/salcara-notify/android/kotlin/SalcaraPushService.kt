package expo.modules.salcaranotify

import android.app.ActivityManager
import android.app.NotificationManager
import android.content.Context
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONObject

/**
 * Task news pushed by the Hub (Firebase data messages) while the app is in the
 * background or closed. The message carries only the kind, the agent name and
 * the ids needed to open the thread, so the notification text is generic and
 * no task content passes through Google. Notification ids match the background
 * watch's, so a message that both deliver shows once.
 */
class SalcaraPushService : FirebaseMessagingService() {
  override fun onMessageReceived(message: RemoteMessage) {
    val data = message.data
    if (data["type"] != "salcara.task") return
    // In the foreground the app shows this itself.
    if (inForeground(this)) return
    val deviceId = data["deviceId"].orEmpty()
    val sessionKey = data["sessionKey"].orEmpty()
    val id = data["id"].orEmpty()
    if (deviceId.isEmpty() || sessionKey.isEmpty() || id.isEmpty() || id.length > 1200) return
    val agent = (data["agent"] ?: "Agent").take(40)
    val (title, body) = when (data["kind"]) {
      "done" -> "$agent 完成了任务" to "点开查看结果"
      "failed" -> "$agent 的任务没有完成" to "点开查看原因"
      "ask" -> "$agent 需要你批准" to "点开在手机上处理"
      "question" -> "$agent 有问题想问你" to "点开回答"
      else -> return
    }
    SalcaraNotifyModule.ensureChannels(this)
    val payload = JSONObject().put("deviceId", deviceId).put("sessionKey", sessionKey).toString()
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    manager.notify(id.hashCode(), SalcaraNotifyModule.build(this, SalcaraNotifyModule.TASK_CHANNEL, title, body, payload, false))
  }

  override fun onNewToken(token: String) {
    // The app re-registers with the Hub the next time it runs (or now, if it is running).
    SalcaraNotifyModule.tokenListener?.invoke(token)
  }

  companion object {
    fun inForeground(context: Context): Boolean {
      val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
      val mine = manager.runningAppProcesses?.firstOrNull { it.pid == android.os.Process.myPid() } ?: return false
      return mine.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
    }
  }
}
