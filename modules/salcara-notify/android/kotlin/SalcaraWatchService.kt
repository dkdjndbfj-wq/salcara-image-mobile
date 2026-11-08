package expo.modules.salcaranotify

import android.app.Notification
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
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
 * the pair token handed over by the app. A bounded, Android Keystore encrypted
 * checkpoint allows a system-initiated service restart to resume safely. When a turn
 * completes / fails, or a final assistant reply arrives, it posts a normal
 * notification; when nothing is left running it stops. Hard limit: two hours.
 *
 * 后台待命 (standby): on phones that cannot receive push, the person may keep this
 * service running. It then follows the whole computer (Hub scope=device), keeps a
 * quiet "正在待命" notification (remoteMessaging on Android 14+). Its restart
 * lease lasts up to seven days; opening the app and returning to background renews
 * it. Force-stop, reboot and vendor background restrictions are not bypassed.
 */
class SalcaraWatchService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  @Volatile private var worker: Thread? = null
  @Volatile private var active = false
  @Volatile private var connectionInFlight: HttpURLConnection? = null
  private var lastCheckpointPayload: String? = null
  private var leaseIdentity: JSONObject? = null
  @Volatile private var leaseDeadlineElapsed = 0L

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    synchronized(configLock) {
      if (intent != null && intent.getLongExtra("watchGeneration", -1) != generation) {
        // A delayed retired start must not stop a newer, valid service instance.
        if (activeService === this && active && running) return START_STICKY
        stopSelf(startId); return START_NOT_STICKY
      }
      if (!SalcaraNotifyModule.notificationsAllowed(this)) {
        clearConfiguration(this, "permission"); stopSelf(); return START_NOT_STICKY
      }
      if (intent == null) {
        val restored = SalcaraWatchVault.load(this)
        if (restored == null) { clearConfiguration(this, "expired"); stopSelf(); return START_NOT_STICKY }
        snapshot = restored
        leaseIdentity = restored
        leaseDeadlineElapsed = SystemClock.elapsedRealtime() + (restored.getLong("expiresAt") - System.currentTimeMillis()).coerceAtLeast(0)
        config = restored.getJSONObject("config")
        startedAt = restored.getLong("startedAt")
        standby = restored.optBoolean("standby")
        recoveryReady = true
      } else {
        standby = intent.getBooleanExtra("standby", false)
        intent.getStringExtra("title")?.let { lastTitle = it }
        intent.getStringExtra("body")?.let { lastBody = it }
      }
      if (startedAt == 0L) startedAt = System.currentTimeMillis()
      activeService = this
      active = true
      running = true
      stopReason = ""
    }
    SalcaraNotifyModule.ensureChannels(this)
    val title = if (standby) STANDBY_TITLE else lastTitle
    val body = if (standby) STANDBY_BODY else lastBody
    val notification = SalcaraNotifyModule.build(this, SalcaraNotifyModule.WATCH_CHANNEL, title, body, null, true)
    try {
      val type = if (standby && Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING else ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
      if (Build.VERSION.SDK_INT >= 29) startForeground(WATCH_ID, notification, type)
      else startForeground(WATCH_ID, notification)
    } catch (error: Exception) {
      clearConfiguration(this, "restricted")
      stopSelf()
      return START_NOT_STICKY
    }
    handler.removeCallbacksAndMessages(null)
    if (!standby) handler.postDelayed({ clearConfiguration(this, "expired"); stopSelf() }, (startedAt + MAX_WATCH_MS - System.currentTimeMillis()).coerceAtLeast(1))
    synchronized(configLock) { if (snapshot == null) config?.takeIf { it.optBoolean("follow") }?.let { saveCheckpoint(it) } }
    if (worker?.isAlive != true) {
      worker = Thread({ follow() }, "salcara-watch").apply { isDaemon = true; start() }
    }
    return START_STICKY
  }

  override fun onTimeout(startId: Int) {
    clearConfiguration(this, "restricted")
    stopSelf()
  }

  override fun onTimeout(startId: Int, fgsType: Int) {
    clearConfiguration(this, "restricted")
    stopSelf()
  }

  override fun onDestroy() {
    active = false
    synchronized(configLock) {
      if (activeService === this) { activeService = null; running = false; standby = false; startedAt = 0L }
    }
    connectionInFlight?.disconnect()
    handler.removeCallbacksAndMessages(null)
    worker?.interrupt()
    worker = null
    super.onDestroy()
  }

  // ——— native follow loop ———

  private class Target(val deviceId: String, val sessionKey: String, val title: String, val agent: String, var after: Long, var done: Boolean = false)

  private fun follow() {
    val targets = LinkedHashMap<String, Target>()
    var previousConfig: JSONObject? = null
    while (active && running && !Thread.currentThread().isInterrupted) {
      val current = config
      if (!SalcaraNotifyModule.notificationsAllowed(this)) { requestStop(current, "permission"); return }
      if (current == null || !current.optBoolean("follow", false)) {
        // The app is in the foreground and syncing itself.
        sleep(1500)
        continue
      }
      // A new config is also the station/credential boundary. Never retain a
      // target or cursor from the previous Hub: otherwise a phone switching
      // from station A to B can keep polling A in the background, while a
      // device cursor from A can skip the first events from B.
      val configChanged = current !== previousConfig
      if (configChanged) {
        previousConfig = current
        targets.clear()
        deviceCursors.clear()
        deviceCursorOwner = current
        sessionTitles.clear()
        val devices = current.optJSONArray("devices") ?: JSONArray()
        for (index in 0 until devices.length()) devices.optJSONObject(index)?.let { deviceCursors[it.optString("deviceId")] = it.optLong("after", 0).coerceAtLeast(0) }
      }
      if (snapshot?.optLong("expiresAt", Long.MAX_VALUE)?.let { it <= System.currentTimeMillis() } == true
        || (leaseDeadlineElapsed > 0 && SystemClock.elapsedRealtime() >= leaseDeadlineElapsed)) { requestStop(current, "expired"); return }
      if (standby && current.optBoolean("standby", false)) {
        followDevices(current)
        continue
      }
      if (configChanged) {
        val sessions = current.optJSONArray("sessions") ?: JSONArray()
        for (index in 0 until sessions.length()) {
          val item = sessions.optJSONObject(index) ?: continue
          val key = "${item.optString("deviceId")}|${item.optString("sessionKey")}"
          if (!targets.containsKey(key)) targets[key] = Target(item.optString("deviceId"), item.optString("sessionKey"),
            item.optString("title", "远程任务"), item.optString("agent", "Agent"), item.optLong("after", 0))
        }
      }
      val pending = targets.values.filter { !it.done }
      if (pending.isEmpty()) { requestStop(current, "completed"); return }
      updateOngoing(pending)
      val canWait = current.optBoolean("wait", false)
      for (target in pending) {
        if (!active || !running) return
        if (config !== current) break
        try { poll(current, target, canWait && pending.size == 1) } catch (error: AuthError) {
          if (config === current) { requestStop(current, "authentication"); return }
        } catch (error: Exception) { if (config === current) sleep(5000) }
      }
      saveCheckpoint(current, targets.values.toList())
      if (!canWait || pending.size > 1) sleep(6000)
    }
  }

  private class AuthError : Exception()

  private fun requestStop(expected: JSONObject?, reason: String) {
    handler.post { synchronized(configLock) { if (activeService === this && config === expected) { clearConfiguration(this, reason); stopSelf() } } }
  }

  private fun saveCheckpoint(current: JSONObject, targets: List<Target>? = null, includeDeviceProgress: Boolean = false) = synchronized(configLock) {
    if (!active || !running || config !== current || !current.optBoolean("follow")) return@synchronized
    val stored = snapshot ?: SalcaraWatchRecovery.create(current, startedAt, standby, System.currentTimeMillis()) ?: return@synchronized
    if (leaseIdentity !== stored) {
      leaseIdentity = stored
      leaseDeadlineElapsed = SystemClock.elapsedRealtime() + (stored.optLong("expiresAt") - System.currentTimeMillis()).coerceAtLeast(0)
    }
    val nextConfig = SalcaraWatchRecovery.checkpointConfig(current,
      if (includeDeviceProgress) deviceCursorOwner else null, if (includeDeviceProgress) deviceCursors else emptyMap())
    // Only the worker may copy its device cursor map, after it has observed and
    // reset to this exact config. A JS handoff must persist the caller's cursors,
    // never an old pairing's progress that the worker has not retired yet.
    if (!standby && targets != null) {
      val sessions = JSONArray()
      targets.filter { !it.done }.forEach { sessions.put(JSONObject().put("deviceId", it.deviceId).put("sessionKey", it.sessionKey)
        .put("title", it.title).put("agent", it.agent).put("after", it.after)) }
      if (sessions.length() == 0) { requestStop(current, "completed"); return@synchronized }
      nextConfig.put("sessions", sessions)
    }
    stored.put("config", nextConfig)
    snapshot = stored
    val payload = stored.toString()
    if (recoveryReady && payload == lastCheckpointPayload) return@synchronized
    recoveryReady = SalcaraWatchVault.save(this, stored)
    stopReason = if (recoveryReady) "" else "storage"
    lastCheckpointPayload = if (recoveryReady) payload else null
  }

  // ——— 后台待命: the whole computer ———

  private val deviceCursors = HashMap<String, Long>()
  private var deviceCursorOwner: JSONObject? = null
  private val sessionTitles = LinkedHashMap<String, String>()
  private val ingress = SalcaraIngressRouter()

  private fun ingressUrl(current: JSONObject): String {
    val hubUrl = current.optString("hubUrl").trimEnd('/')
    if (!hubUrl.startsWith("https://") && !hubUrl.startsWith("http://")) throw AuthError()
    return ingress.resolve(hubUrl, current.optJSONObject("ingressManifest")) {
      active && running && !Thread.currentThread().isInterrupted && config === current && SalcaraNotifyModule.notificationsAllowed(this)
    }
  }

  /** One round over the configured computers; returns after a poll (long-poll when supported). */
  private fun followDevices(current: JSONObject) {
    val devices = current.optJSONArray("devices") ?: JSONArray()
    if (devices.length() == 0) { sleep(1500); return }
    val wait = current.optBoolean("wait", false) && devices.length() == 1
    for (index in 0 until devices.length()) {
      if (!active || !running) return
      if (config !== current) return
      val deviceId = devices.optJSONObject(index)?.optString("deviceId").orEmpty()
      if (deviceId.isEmpty()) continue
      try { pollDevice(current, deviceId, wait) } catch (error: AuthError) {
        if (config === current) requestStop(current, "authentication")
        return
      } catch (error: Exception) { if (config === current) sleep(10_000) }
    }
    saveCheckpoint(current, includeDeviceProgress = true)
    if (!wait) sleep(15_000)
  }

  private fun pollDevice(current: JSONObject, deviceId: String, wait: Boolean) {
    val hubUrl = ingressUrl(current)
    val after = deviceCursors[deviceId] ?: 0L
    val query = "deviceId=${enc(deviceId)}&scope=device&after=$after&limit=100" + if (wait) "&wait=25" else ""
    val connection = URL("$hubUrl/app/events?$query").openConnection() as HttpURLConnection
    connectionInFlight = connection
    connection.instanceFollowRedirects = false
    connection.connectTimeout = 15_000
    connection.readTimeout = if (wait) 45_000 else 20_000
    connection.setRequestProperty("Accept", "application/json")
    current.optString("pairToken").takeIf { it.isNotEmpty() }?.let { connection.setRequestProperty("X-Salcara-Pair-Token", it) }
    current.optString("key").takeIf { it.isNotEmpty() }?.let { connection.setRequestProperty("Authorization", "Bearer $it") }
    try {
      val status = connection.responseCode
      if (status == 401 || status == 403) throw AuthError()
      if (status !in 200..299) { if (status in 300..399 || status in listOf(502, 503, 504)) ingress.fail(hubUrl); sleep(10_000); return }
      val json = JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
      if (config !== current || !SalcaraNotifyModule.notificationsAllowed(this)) return
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
        handle(current, Target(deviceId, sessionKey, sessionTitles["$deviceId|$sessionKey"] ?: "电脑上的任务", agent, 0), event)
      }
      // `nextSeq` is allowed to describe the station tail, while this read is
      // filtered by device.  Advancing to that tail on an empty/foreign page
      // can skip a session event that arrives between polls; only trust it as
      // a page frontier when this response actually carried a device event.
      val advertised = json.optLong("nextSeq", next)
      deviceCursors[deviceId] = if (events.length() > 0) maxOf(next, advertised) else next
    } catch (error: AuthError) { throw error }
    catch (error: Exception) { ingress.fail(hubUrl); throw error }
    finally {
      connection.disconnect()
      if (connectionInFlight === connection) connectionInFlight = null
    }
  }

  private fun poll(current: JSONObject, target: Target, wait: Boolean) {
    val hubUrl = ingressUrl(current)
    val query = "deviceId=${enc(target.deviceId)}&sessionKey=${enc(target.sessionKey)}&after=${target.after}&limit=100" + if (wait) "&wait=20" else ""
    val connection = URL("$hubUrl/app/events?$query").openConnection() as HttpURLConnection
    connectionInFlight = connection
    connection.instanceFollowRedirects = false
    connection.connectTimeout = 15_000
    connection.readTimeout = if (wait) 40_000 else 20_000
    connection.setRequestProperty("Accept", "application/json")
    current.optString("pairToken").takeIf { it.isNotEmpty() }?.let { connection.setRequestProperty("X-Salcara-Pair-Token", it) }
    current.optString("key").takeIf { it.isNotEmpty() }?.let { connection.setRequestProperty("Authorization", "Bearer $it") }
    try {
      val status = connection.responseCode
      if (status == 401 || status == 403) throw AuthError()
      if (status !in 200..299) { if (status in 300..399 || status in listOf(502, 503, 504)) ingress.fail(hubUrl); sleep(5000); return }
      val json = JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
      if (config !== current || !SalcaraNotifyModule.notificationsAllowed(this)) return
      val events = json.optJSONArray("events") ?: JSONArray()
      var next = target.after
      for (index in 0 until events.length()) {
        val event = events.optJSONObject(index) ?: continue
        val seq = event.optLong("seq", 0)
        if (seq > 0 && seq <= target.after) continue
        if (seq > next) next = seq
        handle(current, target, event)
      }
      // Keep the same cursor rule as the JS client: a session-filtered empty
      // page must not jump to a station-wide tail and silently miss a later
      // event.  Non-empty pages may advance to the relay's advertised page
      // frontier, while the event maximum remains the hard lower bound.
      val advertised = json.optLong("nextSeq", next)
      target.after = if (events.length() > 0) maxOf(target.after, advertised, next) else maxOf(target.after, next)
    } catch (error: AuthError) { throw error }
    catch (error: Exception) { ingress.fail(hubUrl); throw error }
    finally {
      connection.disconnect()
      if (connectionInFlight === connection) connectionInFlight = null
    }
  }

  private fun handle(current: JSONObject, target: Target, event: JSONObject) {
    if (config !== current || !SalcaraNotifyModule.notificationsAllowed(this)) return
    // Only news since this watch began; older history is never re-announced.
    if (event.optLong("ts", 0) < startedAt - 60_000) return
    if (event.optString("deviceId", target.deviceId) != target.deviceId || event.optString("sessionKey", target.sessionKey) != target.sessionKey) return
    val navigationScope = current.optString("navigationScope").takeIf { it.matches(Regex("ns1_[a-f0-9]{64}")) }
    val payload = JSONObject().put("deviceId", target.deviceId).put("sessionKey", target.sessionKey)
      .apply { if (navigationScope != null) put("notificationScope", navigationScope) }.toString()
    val prefix = "${navigationScope ?: "legacy"}:"
    val seq = event.optLong("seq", event.optLong("ts", 0))
    val taskRef = event.optString("turnId").takeIf { it.isNotEmpty() } ?: seq.toString()
    val taskNotificationId = "${prefix}task:${target.deviceId}:${target.sessionKey}:$taskRef"
    when (event.optString("type")) {
      "turn" -> { when (event.optString("status")) {
        "completed" -> { post(taskNotificationId, "${target.agent} 完成了任务", target.title, payload); target.done = true }
        "failed" -> {
          post(taskNotificationId, "${target.agent} 的任务没有完成", target.title, payload)
          target.done = true
        }
        "interrupted" -> { target.done = true }
      } }
      "message" -> if (event.optString("role") == "assistant" && event.optBoolean("final", false)
        && event.optString("parentId").isEmpty() && event.optString("messagePhase") != "commentary") {
        post(taskNotificationId, "${target.agent} 有新回复", target.title, payload)
      }
      "session.updated" -> {
        val status = event.optJSONObject("session")?.optString("status")
        if (status == "idle" || status == "failed") target.done = true
      }
    }
  }

  private fun post(id: String, title: String, body: String, payload: String) {
    // A poll may finish just as the user returns to the app, before JS has
    // replaced this watch config. Keep that narrow handoff race from raising
    // a system banner over active work; foreground sync/toasts own the event.
    if (SalcaraPushService.inForeground(this)) return
    SalcaraNotifyModule.postTaskNotification(this, id.hashCode(), SalcaraNotifyModule.build(this, SalcaraNotifyModule.TASK_CHANNEL, title, body, payload, false))
  }

  private fun updateOngoing(pending: List<Target>) {
    if (!SalcaraNotifyModule.notificationsAllowed(this)) return
    val first = pending.first()
    val body = if (pending.size > 1) "${first.title} 等 ${pending.size} 个任务" else first.title
    SalcaraNotifyModule.postTaskNotification(this, WATCH_ID, SalcaraNotifyModule.build(this, SalcaraNotifyModule.WATCH_CHANNEL, "${first.agent} 正在运行", body, null, true))
  }

  private fun enc(value: String) = URLEncoder.encode(value, "UTF-8")
  private fun sleep(ms: Long) { try { Thread.sleep(ms) } catch (interrupted: InterruptedException) { Thread.currentThread().interrupt() } }

  companion object {
    const val WATCH_ID = 4127
    const val MAX_WATCH_MS = 2L * 60 * 60 * 1000

    private val configLock = Any()
    private var generation = 0L
    @Volatile private var activeService: SalcaraWatchService? = null
    @Volatile private var snapshot: JSONObject? = null
    @Volatile private var recoveryReady = false
    @Volatile private var stopReason = ""
    /** Live configuration; only an active background watch gets an encrypted restart checkpoint. */
    @Volatile var config: JSONObject? = null
    @Volatile var running = false
    @Volatile var startedAt = 0L
    @Volatile var lastTitle = "Salcara"
    @Volatile var lastBody = "正在关注电脑上的任务"
    @Volatile var standby = false

    fun prepareStart(intent: Intent) = synchronized(configLock) { intent.putExtra("watchGeneration", generation) }

    fun configure(context: Context, value: JSONObject?) = synchronized(configLock) {
      if (value == null) {
        clearConfiguration(context, "configuration")
        activeService?.stopSelf()
        return@synchronized
      }
      if (value.optBoolean("follow") && !SalcaraWatchRecovery.validConfig(value)) {
        clearConfiguration(context, "configuration")
        activeService?.stopSelf()
        return@synchronized
      }
      config = value
      snapshot = null
      recoveryReady = false
      SalcaraWatchVault.clear(context)
      activeService?.connectionInFlight?.disconnect()
      if (value?.optBoolean("follow") == true && SalcaraWatchRecovery.validConfig(value)) {
        // Renew a standby lease only on an explicit app handoff, never from polling.
        if (standby) startedAt = System.currentTimeMillis()
        activeService?.saveCheckpoint(value)
      }
    }

    fun clearConfiguration(context: Context, reason: String = "stopped") = synchronized(configLock) {
      generation++
      config = null
      snapshot = null
      recoveryReady = false
      running = false
      standby = false
      startedAt = 0L
      stopReason = reason
      SalcaraWatchVault.clear(context)
      activeService?.active = false
      activeService?.connectionInFlight?.disconnect()
    }

    fun status(): Map<String, Any> = synchronized(configLock) { mapOf("running" to running, "standby" to standby,
      "recoveryReady" to recoveryReady, "expiresAt" to (snapshot?.optLong("expiresAt") ?: 0L), "reason" to stopReason) }
    const val STANDBY_TITLE = "Salcara 正在待命"
    const val STANDBY_BODY = "电脑上的任务完成、失败或收到最终回复时会提醒你"
  }
}
