package expo.modules.salcaranotify

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * Low-priority foreground service shown as "Codex 正在运行…" while a remote task runs.
 *
 * While the app is in background (or after it was swiped away) the JS thread may
 * be paused or gone, so this service follows the running sessions itself: one
 * long-poll per session against the Hub's existing `/app/events` endpoint, using
 * the pair token handed over in memory (never written to disk). When a turn
 * completes / fails, or an approval or question arrives, it posts a normal
 * notification; when nothing is left running it stops. Hard limit: two hours.
 *
 * 后台待命 (standby): on phones that cannot receive push, the person may keep this
 * service running. It then follows the whole computer (Hub scope=device), keeps a
 * quiet "正在待命" notification, never stops on its own and has no time limit
 * (foreground type remoteMessaging on Android 14+).
 */
class SalcaraWatchService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  @Volatile private var worker: Thread? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    SalcaraNotifyModule.ensureChannels(this)
    if (intent?.getBooleanExtra("standby", false) == true) standby = true
    intent?.getStringExtra("title")?.let { lastTitle = it }
    intent?.getStringExtra("body")?.let { lastBody = it }
    val title = if (standby) STANDBY_TITLE else lastTitle
    val body = if (standby) STANDBY_BODY else lastBody
    val notification = SalcaraNotifyModule.build(this, SalcaraNotifyModule.WATCH_CHANNEL, title, body, null, true)
    try {
      val type = if (standby && Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING else ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
      if (Build.VERSION.SDK_INT >= 29) startForeground(WATCH_ID, notification, type)
      else startForeground(WATCH_ID, notification)
    } catch (error: Exception) {
      standby = false
      stopSelf()
      return START_NOT_STICKY
    }
    if (startedAt == 0L) startedAt = System.currentTimeMillis()
    handler.removeCallbacksAndMessages(null)
    if (!standby) handler.postDelayed({ stopSelf() }, MAX_WATCH_MS)
    if (intent?.action == ACTION_DECIDE) {
      val decideIntent = intent
      Thread({ decide(decideIntent) }, "salcara-decide").start()
    }
    if (worker?.isAlive != true) {
      worker = Thread({ follow() }, "salcara-watch").apply { isDaemon = true; start() }
    }
    return START_NOT_STICKY
  }

  override fun onTimeout(startId: Int) {
    stopSelf()
  }

  override fun onDestroy() {
    running = false
    standby = false
    startedAt = 0L
    handler.removeCallbacksAndMessages(null)
    worker?.interrupt()
    worker = null
    super.onDestroy()
  }

  // ——— native follow loop ———

  private class Target(val deviceId: String, val sessionKey: String, val title: String, val agent: String, var after: Long, var done: Boolean = false)

  private fun follow() {
    running = true
    val targets = LinkedHashMap<String, Target>()
    var configVersion = -1
    while (running && !Thread.currentThread().isInterrupted) {
      val current = config
      if (current == null || !current.optBoolean("follow", false)) {
        // The app is in the foreground and syncing itself.
        sleep(1500)
        continue
      }
      if (standby && current.optBoolean("standby", false)) {
        followDevices(current)
        continue
      }
      if (current.optInt("version", 0) != configVersion) {
        configVersion = current.optInt("version", 0)
        val sessions = current.optJSONArray("sessions") ?: JSONArray()
        for (index in 0 until sessions.length()) {
          val item = sessions.optJSONObject(index) ?: continue
          val key = "${item.optString("deviceId")}|${item.optString("sessionKey")}"
          if (!targets.containsKey(key)) targets[key] = Target(item.optString("deviceId"), item.optString("sessionKey"),
            item.optString("title", "远程任务"), item.optString("agent", "Agent"), item.optLong("after", 0))
        }
      }
      val pending = targets.values.filter { !it.done }
      if (pending.isEmpty()) { handler.post { stopSelf() }; return }
      updateOngoing(pending)
      val canWait = current.optBoolean("wait", false)
      for (target in pending) {
        if (!running) return
        try { poll(current, target, canWait && pending.size == 1) } catch (error: AuthError) { handler.post { stopSelf() }; return } catch (error: Exception) { sleep(5000) }
      }
      if (!canWait || pending.size > 1) sleep(6000)
    }
  }

  private class AuthError : Exception()

  // ——— 后台待命: the whole computer ———

  private val deviceCursors = HashMap<String, Long>()
  private val sessionTitles = LinkedHashMap<String, String>()

  /** One round over the configured computers; returns after a poll (long-poll when supported). */
  private fun followDevices(current: JSONObject) {
    val devices = current.optJSONArray("devices") ?: JSONArray()
    if (devices.length() == 0) { sleep(1500); return }
    val wait = current.optBoolean("wait", false) && devices.length() == 1
    for (index in 0 until devices.length()) {
      if (!running) return
      val deviceId = devices.optJSONObject(index)?.optString("deviceId").orEmpty()
      if (deviceId.isEmpty()) continue
      try { pollDevice(current, deviceId, wait) } catch (error: AuthError) { handler.post { stopSelf() }; return } catch (error: Exception) { sleep(10_000) }
    }
    if (!wait) sleep(15_000)
  }

  private fun pollDevice(current: JSONObject, deviceId: String, wait: Boolean) {
    val hubUrl = current.optString("hubUrl").trimEnd('/')
    if (!hubUrl.startsWith("https://") && !hubUrl.startsWith("http://")) throw AuthError()
    val after = deviceCursors[deviceId] ?: 0L
    val query = "deviceId=${enc(deviceId)}&scope=device&after=$after&limit=100" + if (wait) "&wait=25" else ""
    val connection = URL("$hubUrl/app/events?$query").openConnection() as HttpURLConnection
    connection.instanceFollowRedirects = false
    connection.connectTimeout = 15_000
    connection.readTimeout = if (wait) 45_000 else 20_000
    connection.setRequestProperty("Accept", "application/json")
    current.optString("pairToken").takeIf { it.isNotEmpty() }?.let { connection.setRequestProperty("X-Salcara-Pair-Token", it) }
    current.optString("key").takeIf { it.isNotEmpty() }?.let { connection.setRequestProperty("Authorization", "Bearer $it") }
    try {
      val status = connection.responseCode
      if (status == 401 || status == 403) throw AuthError()
      if (status !in 200..299) { sleep(10_000); return }
      val json = JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
      val events = json.optJSONArray("events") ?: JSONArray()
      var next = after
      for (index in 0 until events.length()) {
        val event = events.optJSONObject(index) ?: continue
        val seq = event.optLong("seq", 0)
        if (seq > 0 && seq <= after) continue
        if (seq > next) next = seq
        val sessionKey = event.optString("sessionKey")
        if (sessionKey.isEmpty()) continue
        event.optJSONObject("session")?.optString("title")?.takeIf { it.isNotBlank() }?.let {
          sessionTitles["$deviceId|$sessionKey"] = it
          if (sessionTitles.size > 200) sessionTitles.remove(sessionTitles.keys.first())
        }
        val agent = when (event.optString("tool")) { "codex" -> "Codex"; "claude" -> "Claude Code"; else -> "Agent" }
        handle(Target(deviceId, sessionKey, sessionTitles["$deviceId|$sessionKey"] ?: "电脑上的任务", agent, 0), event)
      }
      deviceCursors[deviceId] = maxOf(next, json.optLong("nextSeq", next))
    } finally {
      connection.disconnect()
    }
  }

  private fun poll(current: JSONObject, target: Target, wait: Boolean) {
    val hubUrl = current.optString("hubUrl").trimEnd('/')
    if (!hubUrl.startsWith("https://") && !hubUrl.startsWith("http://")) throw AuthError()
    val query = "deviceId=${enc(target.deviceId)}&sessionKey=${enc(target.sessionKey)}&after=${target.after}&limit=100" + if (wait) "&wait=20" else ""
    val connection = URL("$hubUrl/app/events?$query").openConnection() as HttpURLConnection
    connection.instanceFollowRedirects = false
    connection.connectTimeout = 15_000
    connection.readTimeout = if (wait) 40_000 else 20_000
    connection.setRequestProperty("Accept", "application/json")
    current.optString("pairToken").takeIf { it.isNotEmpty() }?.let { connection.setRequestProperty("X-Salcara-Pair-Token", it) }
    current.optString("key").takeIf { it.isNotEmpty() }?.let { connection.setRequestProperty("Authorization", "Bearer $it") }
    try {
      val status = connection.responseCode
      if (status == 401 || status == 403) throw AuthError()
      if (status !in 200..299) { sleep(5000); return }
      val json = JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
      val events = json.optJSONArray("events") ?: JSONArray()
      var next = target.after
      for (index in 0 until events.length()) {
        val event = events.optJSONObject(index) ?: continue
        val seq = event.optLong("seq", 0)
        if (seq > 0 && seq <= target.after) continue
        if (seq > next) next = seq
        handle(target, event)
      }
      val nextSeq = json.optLong("nextSeq", next)
      target.after = maxOf(target.after, nextSeq, next)
    } finally {
      connection.disconnect()
    }
  }

  private fun handle(target: Target, event: JSONObject) {
    // Only news since this watch began; older history is never re-announced.
    if (event.optLong("ts", 0) < startedAt - 60_000) return
    if (event.optString("deviceId", target.deviceId) != target.deviceId || event.optString("sessionKey", target.sessionKey) != target.sessionKey) return
    val payload = JSONObject().put("deviceId", target.deviceId).put("sessionKey", target.sessionKey).toString()
    val seq = event.optLong("seq", event.optLong("ts", 0))
    when (event.optString("type")) {
      "turn" -> { when (event.optString("status")) {
        "completed" -> { post("done:${target.deviceId}:${target.sessionKey}:$seq", "${target.agent} 完成了任务", target.title, payload); target.done = true }
        "failed" -> {
          val error = event.optString("error")
          post("failed:${target.deviceId}:${target.sessionKey}:$seq", "${target.agent} 的任务没有完成", if (error.isNotEmpty()) "${target.title} · $error" else target.title, payload)
          target.done = true
        }
        "interrupted" -> { target.done = true }
      } }
      "approval.request" -> {
        val question = event.optString("kind") == "question"
        val id = event.optString("approvalId", seq.toString())
        val notifyId = "ask:${target.deviceId}:${target.sessionKey}:$id"
        // Plain CLI approvals can be answered from the notification; questions and
        // desktop-native requests need the app.
        val quick = !question && event.optString("approvalTransport").isEmpty() && event.optString("approvalId").isNotEmpty()
        postApproval(notifyId, if (question) "${target.agent} 有问题想问你" else "${target.agent} 需要你批准",
          "${event.optString("title")} · ${target.title}", payload, if (quick) Triple(target.deviceId, target.sessionKey, id) else null)
      }
      "session.updated" -> {
        val status = event.optJSONObject("session")?.optString("status")
        if (status == "idle" || status == "failed") target.done = true
      }
    }
  }

  private fun post(id: String, title: String, body: String, payload: String) {
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    manager.notify(id.hashCode(), SalcaraNotifyModule.build(this, SalcaraNotifyModule.TASK_CHANNEL, title, body, payload, false))
  }

  private fun postApproval(id: String, title: String, body: String, payload: String, approval: Triple<String, String, String>?) {
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val actions = if (approval == null) emptyList() else listOf("allow" to "允许", "deny" to "拒绝").map { (decision, label) ->
      val intent = Intent(this, SalcaraWatchService::class.java).setAction(ACTION_DECIDE)
        .putExtra("deviceId", approval.first).putExtra("sessionKey", approval.second).putExtra("approvalId", approval.third)
        .putExtra("decision", decision).putExtra("notifyId", id).putExtra("label", body)
      val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      val pending = if (Build.VERSION.SDK_INT >= 26) PendingIntent.getForegroundService(this, "$id:$decision".hashCode(), intent, flags)
        else PendingIntent.getService(this, "$id:$decision".hashCode(), intent, flags)
      val builder = Notification.Action.Builder(null, label, pending)
      // Approving runs a command on the computer: require an unlocked phone.
      if (Build.VERSION.SDK_INT >= 31) builder.setAuthenticationRequired(true)
      builder.build()
    }
    manager.notify(id.hashCode(), SalcaraNotifyModule.build(this, SalcaraNotifyModule.TASK_CHANNEL, title, body, payload, false, actions))
  }

  /** Answers one approval from a notification button through the Hub's normal command endpoint. */
  private fun decide(intent: Intent) {
    val notifyId = intent.getStringExtra("notifyId") ?: return
    val decision = intent.getStringExtra("decision") ?: return
    val label = intent.getStringExtra("label") ?: ""
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val current = config
    val ok = try {
      if (current == null) false else {
        val hubUrl = current.optString("hubUrl").trimEnd('/')
        val body = JSONObject().put("deviceId", intent.getStringExtra("deviceId")).put("command", JSONObject()
          .put("type", "approval.respond").put("approvalId", intent.getStringExtra("approvalId")).put("decision", decision).put("controlSurface", "cli"))
        val connection = URL("$hubUrl/app/commands").openConnection() as HttpURLConnection
        try {
          connection.instanceFollowRedirects = false
          connection.requestMethod = "POST"
          connection.doOutput = true
          connection.connectTimeout = 15_000
          connection.readTimeout = 55_000
          connection.setRequestProperty("Content-Type", "application/json")
          connection.setRequestProperty("Accept", "application/json")
          current.optString("pairToken").takeIf { it.isNotEmpty() }?.let { connection.setRequestProperty("X-Salcara-Pair-Token", it) }
          current.optString("key").takeIf { it.isNotEmpty() }?.let { connection.setRequestProperty("Authorization", "Bearer $it") }
          connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
          connection.responseCode in 200..299 && JSONObject(connection.inputStream.bufferedReader().use { it.readText() }).optBoolean("ok", false)
        } finally { connection.disconnect() }
      }
    } catch (error: Exception) { false }
    val title = if (!ok) "没能发送，请在 App 中处理" else if (decision == "allow") "已允许" else "已拒绝"
    val payload = JSONObject().put("deviceId", intent.getStringExtra("deviceId")).put("sessionKey", intent.getStringExtra("sessionKey")).toString()
    manager.notify(notifyId.hashCode(), SalcaraNotifyModule.build(this, SalcaraNotifyModule.TASK_CHANNEL, title, label, payload, false))
  }

  private fun updateOngoing(pending: List<Target>) {
    val first = pending.first()
    val body = if (pending.size > 1) "${first.title} 等 ${pending.size} 个任务" else first.title
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    manager.notify(WATCH_ID, SalcaraNotifyModule.build(this, SalcaraNotifyModule.WATCH_CHANNEL, "${first.agent} 正在运行", body, null, true))
  }

  private fun enc(value: String) = URLEncoder.encode(value, "UTF-8")
  private fun sleep(ms: Long) { try { Thread.sleep(ms) } catch (interrupted: InterruptedException) { Thread.currentThread().interrupt() } }

  companion object {
    const val WATCH_ID = 4127
    const val MAX_WATCH_MS = 2L * 60 * 60 * 1000

    /** Shared in memory with the JS module (same process); holds the pair token, never persisted. */
    @Volatile var config: JSONObject? = null
    @Volatile var running = false
    @Volatile var startedAt = 0L
    @Volatile var lastTitle = "Salcara"
    @Volatile var lastBody = "正在关注电脑上的任务"
    @Volatile var standby = false
    const val STANDBY_TITLE = "Salcara 正在待命"
    const val STANDBY_BODY = "电脑上的任务完成或需要你批准时会提醒你"
    const val ACTION_DECIDE = "top.salcara.watch.DECIDE"
  }
}
