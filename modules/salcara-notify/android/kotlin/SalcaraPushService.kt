package expo.modules.salcaranotify

import android.app.ActivityManager
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
    if (!SalcaraNotifyModule.notificationsAllowed(this)) return
    val deviceId = data["deviceId"].orEmpty()
    val sessionKey = data["sessionKey"].orEmpty()
    val id = data["id"].orEmpty()
    if (deviceId.isEmpty() || sessionKey.isEmpty() || id.isEmpty() || id.length > 1200) return
    val agent = (data["agent"] ?: "Agent").take(40)
    val (title, body) = when (data["kind"]) {
      "done" -> "$agent 完成了任务" to "点开查看结果"
      "failed" -> "$agent 的任务没有完成" to "点开查看原因"
      "reply" -> "$agent 有新回复" to "点开查看回复"
      "approval" -> "$agent 需要批准" to "点开处理请求"
      "question" -> "$agent 需要你回答" to "点开查看问题"
      "resolved" -> "请求已处理" to ""
      else -> return
    }
    SalcaraNotifyModule.ensureChannels(this)
    val scope = data["notificationScope"].orEmpty().takeIf { it.matches(Regex("ns1_[a-f0-9]{64}")) } ?: return
    if (!SalcaraNotificationCenter.permits(this, scope, deviceId)) return
    val payload = JSONObject().put("deviceId", deviceId).put("sessionKey", sessionKey)
      .put("notificationScope", scope).put("kind", data["kind"])
    for (field in listOf("eventTs", "ts", "expiresAt")) data[field]?.toLongOrNull()?.let { payload.put(field, it) }
    data["approvalId"]?.let { payload.put("approvalId", it) }
    data["turnRef"]?.let { payload.put("turnRef", it) }
    // Metadata from newer Hubs lets all three channels share the legacy-turn adapter.
    data["event"]?.let { try { payload.put("event", JSONObject(it)) } catch (_: Exception) { } }
    data["eventType"]?.let { type ->
      val event = JSONObject().put("type", type)
      for (field in listOf("status", "role", "messagePhase", "parentId", "turnId", "approvalId")) data[field]?.let { event.put(field, it) }
      data["eventId"]?.let { event.put("id", it) }
      data["final"]?.let { event.put("final", it == "true" || it == "1") }
      for (field in listOf("seq", "ts", "expiresAt")) data[field]?.toLongOrNull()?.let { event.put(field, it) }
      if (!event.has("ts")) data["eventTs"]?.toLongOrNull()?.let { event.put("ts", it) }
      if (type == "approval.request") event.put("kind", if (data["kind"] == "question") "question" else "approval")
      payload.put("event", event)
    }
    SalcaraNotificationCenter.submit(this, id, title, body, payload)
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
