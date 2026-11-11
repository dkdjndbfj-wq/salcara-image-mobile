package expo.modules.salcaranotify

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
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit

/** Independent pairing watches with a fair bounded worker pool and one encrypted restart lease. */
class SalcaraWatchService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private val executor = ScheduledThreadPoolExecutor(4).apply { removeOnCancelPolicy = true }
  @Volatile private var active = false
  @Volatile private var states = emptyList<ConnectionState>()
  private var lastCheckpointPayload: String? = null
  private var leaseIdentity: JSONObject? = null
  @Volatile private var leaseDeadlineElapsed = 0L
  private var latestStartId = 0

  private class Target(val device: String, val session: String, val title: String, val agent: String, var after: Long,
    val drain: SalcaraWatchDrain = SalcaraWatchDrain()) { val done get() = drain.done }
  private class ConnectionState(val owner: JSONObject, val value: JSONObject) {
    val scope = value.getString("navigationScope")
    val ingress = SalcaraIngressRouter()
    val targets = LinkedHashMap<String, Target>()
    val devices = LinkedHashMap<String, Long>()
    @Volatile var retired = value.optString("retiredReason").isNotEmpty()
    @Volatile var reason = value.optString("retiredReason")
    @Volatile var connection: HttpURLConnection? = null
    var deviceIndex = 0
    var targetIndex = 0
    init {
      value.optJSONArray("sessions")?.let { rows -> for (index in 0 until rows.length()) rows.optJSONObject(index)?.let { row ->
        val session = row.optString("sessionKey"); val device = row.optString("deviceId")
        targets["$device|$session"] = Target(device, session, row.optString("title", "远程任务"), row.optString("agent", "Agent"), row.optLong("after"),
          SalcaraWatchDrain(row.optBoolean("done"), row.optLong("completedAt"), row.optBoolean("emptyTail")))
      } }
      value.optJSONArray("devices")?.let { rows -> for (index in 0 until rows.length()) rows.optJSONObject(index)?.let { row -> devices[row.optString("deviceId")] = row.optLong("after") } }
    }
    fun deviceIds() = if (SalcaraWatchRecovery.deviceMode(value)) devices.keys.toList() else targets.values.map { it.device }.distinct()
  }
  private class AuthError : Exception()
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    synchronized(configLock) {
      if (intent != null && intent.getLongExtra("watchGeneration", -1) != generation) {
        if (activeService === this && active && running) return START_STICKY
        stopSelf(startId); return START_NOT_STICKY
      }
      if (!SalcaraNotifyModule.notificationsAllowed(this)) { clearConfiguration(this, "permission"); stopSelf(); return START_NOT_STICKY }
      if (intent == null) {
        val restored = SalcaraWatchVault.load(this)
        if (restored == null) { clearConfiguration(this, "expired"); stopSelf(); return START_NOT_STICKY }
        snapshot = restored; config = restored.getJSONObject("config"); startedAt = restored.getLong("startedAt")
        standby = restored.optBoolean("standby"); recoveryReady = true; bindLease(restored)
      } else {
        standby = config?.takeIf { it.optBoolean("follow") }?.optBoolean("standby") ?: intent.getBooleanExtra("standby", false)
        intent.getStringExtra("title")?.let { lastTitle = it }; intent.getStringExtra("body")?.let { lastBody = it }
      }
      val current = config
      if (current?.optBoolean("follow") == true && !SalcaraWatchRecovery.validConfig(current)) {
        clearConfiguration(this, "configuration"); stopSelf(); return START_NOT_STICKY
      }
      if (startedAt == 0L) startedAt = System.currentTimeMillis()
      latestStartId = startId
      activeService = this; active = true; running = true; stopReason = ""
    }
    SalcaraNotifyModule.ensureChannels(this)
    val notification = SalcaraNotifyModule.build(this, SalcaraNotifyModule.WATCH_CHANNEL,
      if (standby) STANDBY_TITLE else lastTitle, if (standby) STANDBY_BODY else lastBody, null, true)
    try {
      // Temporary device-level observation remains dataSync and retains the two-hour lease.
      val type = if (standby && Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING else ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
      if (Build.VERSION.SDK_INT >= 29) startForeground(WATCH_ID, notification, type) else startForeground(WATCH_ID, notification)
    } catch (_: Exception) { finish("restricted", true); return START_NOT_STICKY }
    restartWorkers()
    armLeaseTimeout()
    return START_STICKY
  }
  override fun onTimeout(startId: Int) { if (startId == latestStartId) finish("restricted", true) }
  override fun onTimeout(startId: Int, fgsType: Int) { if (startId == latestStartId) finish("restricted", true) }
  override fun onDestroy() {
    active = false; retireWorkers(); executor.shutdownNow(); handler.removeCallbacksAndMessages(null)
    synchronized(configLock) { if (activeService === this) { activeService = null; running = false; standby = false; startedAt = 0L } }
    super.onDestroy()
  }
  private fun bindLease(stored: JSONObject) {
    if (leaseIdentity !== stored) {
      leaseIdentity = stored
      leaseDeadlineElapsed = SystemClock.elapsedRealtime() + (stored.optLong("expiresAt") - System.currentTimeMillis()).coerceAtLeast(0)
    }
  }
  private var expiry: Runnable? = null
  private fun armLeaseTimeout() {
    expiry?.let { handler.removeCallbacks(it) }
    if (!active || !running) return
    val owner = config; val ownerGeneration = generation
    val duration = (snapshot?.optLong("expiresAt") ?: (startedAt + if (standby) SalcaraWatchRecovery.STANDBY_TTL else MAX_WATCH_MS)) - System.currentTimeMillis()
    val callback = Runnable { synchronized(configLock) { if (generation == ownerGeneration && config === owner) finish("expired", true) } }
    expiry = callback
    handler.postDelayed(callback, duration.coerceAtLeast(1))
  }
  private fun retireWorkers() { states.forEach { it.retired = true; it.connection?.disconnect() }; states = emptyList(); executor.queue.clear() }
  private fun restartWorkers() = synchronized(configLock) {
    retireWorkers()
    val current = config ?: return@synchronized
    if (!active || !running || !current.optBoolean("follow")) return@synchronized
    states = SalcaraWatchRecovery.connections(current).map { ConnectionState(current, it) }
    states.forEach { state -> if (!authorized(state)) { state.retired = true; state.reason = "authorization" } else schedule(state, 0) }
    saveCheckpoint(current); updateOngoing()
    if (states.none { !it.retired }) finish("authorization", false)
  }
  private fun current(state: ConnectionState) = active && running && !state.retired && config === state.owner && !Thread.currentThread().isInterrupted
  private fun authorized(state: ConnectionState) = state.deviceIds().isNotEmpty() && state.deviceIds().all { SalcaraNotificationCenter.permits(this, state.scope, it) }
  private fun schedule(state: ConnectionState, delay: Long) {
    if (!current(state) || executor.isShutdown) return
    try { executor.schedule({ step(state) }, delay, TimeUnit.MILLISECONDS) } catch (_: java.util.concurrent.RejectedExecutionException) { }
  }
  /** One request per slice; offline computers release the worker to other queued targets. */
  private fun step(state: ConnectionState) {
    if (!current(state)) return
    if (!SalcaraNotifyModule.notificationsAllowed(this)) { requestFinish(state, "permission", false); return }
    if (!authorized(state)) { retire(state, "authorization", false); return }
    if (leaseDeadlineElapsed > 0 && SystemClock.elapsedRealtime() >= leaseDeadlineElapsed) { requestFinish(state, "expired", true); return }
    var delay = if (standby) 15_000L else 6000L
    try {
      val pending = synchronized(state) { state.targets.values.filter { !it.drain.finished(System.currentTimeMillis()) } }
      if (!standby && pending.isEmpty()) { retire(state, "completed", false); return }
      if (SalcaraWatchRecovery.deviceMode(state.value)) {
        val devices = state.devices.keys.toList()
        if (devices.isEmpty()) { retire(state, "configuration", true); return }
        val device = devices[state.deviceIndex % devices.size]; state.deviceIndex = (state.deviceIndex + 1) % devices.size
        val wait = states.count { !it.retired } == 1 && devices.size == 1 && state.value.optBoolean("wait")
        poll(state, device, null, wait)
        if (wait || devices.size > 1 && state.deviceIndex != 0) delay = 100
      } else {
        val target = pending[state.targetIndex % pending.size]; state.targetIndex = (state.targetIndex + 1) % pending.size
        val wait = states.count { !it.retired } == 1 && pending.size == 1 && state.value.optBoolean("wait")
        poll(state, target.device, target, wait)
        if (wait || pending.size > 1 && state.targetIndex != 0) delay = 100
      }
      state.reason = ""; saveCheckpoint(state.owner); updateOngoing()
    } catch (_: AuthError) { retire(state, "authentication", true); return }
    catch (_: Exception) { if (current(state)) { state.reason = "connection"; delay = 10_000 } }
    schedule(state, delay)
  }
  private fun requestFinish(state: ConnectionState, reason: String, notify: Boolean) {
    val ownerGeneration = generation
    handler.post { synchronized(configLock) { if (current(state) && generation == ownerGeneration) finish(reason, notify) } }
  }
  private fun retire(state: ConnectionState, reason: String, notify: Boolean) {
    if (!current(state)) return
    state.reason = reason; state.retired = true; state.connection?.disconnect()
    if (notify) state.deviceIds().forEach { SalcaraNotificationCenter.observationStopped(this, state.scope, it, reason) }
    saveCheckpoint(state.owner)
    handler.post { if (active && config === state.owner && states.none { !it.retired }) finish(if (states.all { it.reason == "completed" }) "completed" else reason, false) else updateOngoing() }
  }
  private fun finish(reason: String, notify: Boolean) = synchronized(configLock) {
    if (activeService !== this || !active) return@synchronized
    if (notify) {
      val values = states.ifEmpty { config?.let { owner -> SalcaraWatchRecovery.connections(owner).map { ConnectionState(owner, it) } } ?: emptyList() }
      values.filter { !it.retired }.forEach { state -> state.deviceIds().forEach { SalcaraNotificationCenter.observationStopped(this, state.scope, it, reason) } }
    }
    clearConfiguration(this, reason); stopSelf()
  }
  private fun ingressUrl(state: ConnectionState): String {
    val value = state.value; val hub = value.getString("hubUrl").trimEnd('/')
    val ownerGeneration = generation
    try {
      return state.ingress.resolve(hub, value.optJSONObject("ingressManifest"), state.scope) {
        current(state) && generation == ownerGeneration && authorized(state) && SalcaraNotifyModule.notificationsAllowed(this)
      }
    } finally { persistIngress(state, ownerGeneration) }
  }
  private fun persistIngress(state: ConnectionState, ownerGeneration: Long) = synchronized(configLock) {
    if (!current(state) || generation != ownerGeneration) return@synchronized
    val envelope = state.ingress.recoverySnapshot(state.value.optString("hubUrl").trimEnd('/'), state.scope, state.value.optJSONObject("ingressManifest")) ?: return@synchronized
    val stored = snapshot ?: SalcaraWatchRecovery.create(state.owner, startedAt, standby, System.currentTimeMillis()) ?: return@synchronized
    val merged = SalcaraWatchRecovery.withConnectionIngressManifest(stored, state.owner, state.value, envelope, System.currentTimeMillis()) ?: return@synchronized
    // Only update the already-verified public locator; retain progressed cursors and original deadline.
    stored.put("config", merged.getJSONObject("config")); state.value.put("ingressManifest", JSONObject(envelope.toString()))
    snapshot = stored; bindLease(stored); persistSnapshot(stored)
  }
  private fun saveCheckpoint(owner: JSONObject) = synchronized(configLock) {
    if (!active || !running || config !== owner || !owner.optBoolean("follow")) return@synchronized
    val stored = snapshot ?: SalcaraWatchRecovery.create(owner, startedAt, standby, System.currentTimeMillis()) ?: return@synchronized
    val next = JSONObject(owner.toString()); val nextConnections = SalcaraWatchRecovery.connections(next)
    for (state in states) {
      if (state.owner !== owner) continue
      val target = nextConnections.firstOrNull { SalcaraWatchRecovery.sameAuthority(it, state.value) } ?: continue
      synchronized(state) {
        if (SalcaraWatchRecovery.deviceMode(state.value)) target.put("devices", JSONArray().also { rows -> state.devices.forEach { (device, after) -> rows.put(JSONObject().put("deviceId", device).put("after", after)) } })
        // Keep completed session rows and their cursor; restarting must not rewatch already-finished work forever.
        target.put("sessions", JSONArray().also { rows -> state.targets.values.forEach { item -> rows.put(JSONObject().put("deviceId", item.device).put("sessionKey", item.session).put("title", item.title).put("agent", item.agent).put("after", item.after).put("done", item.done).put("completedAt", item.drain.completedAt).put("emptyTail", item.drain.emptyTail)) } })
        if (state.retired) target.put("retiredReason", state.reason)
      }
    }
    stored.put("config", next); snapshot = stored; bindLease(stored); persistSnapshot(stored)
  }
  private fun persistSnapshot(stored: JSONObject) {
    val payload = stored.toString()
    if (recoveryReady && payload == lastCheckpointPayload) return
    recoveryReady = SalcaraWatchVault.save(this, stored); stopReason = if (recoveryReady) "" else "storage"
    lastCheckpointPayload = if (recoveryReady) payload else null
    if (!recoveryReady) states.filter { !it.retired }.forEach { state -> state.deviceIds().forEach { SalcaraNotificationCenter.observationStopped(this, state.scope, it, "storage") } }
  }
  private fun poll(state: ConnectionState, device: String, target: Target?, wait: Boolean) {
    val hub = ingressUrl(state)
    val after = synchronized(state) { target?.after ?: state.devices[device] ?: 0 }
    val query = "deviceId=${enc(device)}&" + (target?.let { "sessionKey=${enc(it.session)}" } ?: "scope=device") + "&after=$after&limit=100" + if (wait) "&wait=25" else ""
    val connection = URL("$hub/app/events?$query").openConnection() as HttpURLConnection
    state.connection = connection
    connection.instanceFollowRedirects = false; connection.connectTimeout = 15_000; connection.readTimeout = if (wait) 45_000 else 20_000
    connection.setRequestProperty("Accept", "application/json")
    SalcaraWatchRecovery.requestHeaders(state.value).forEach { (name, value) -> connection.setRequestProperty(name, value) }
    try {
      if (!current(state) || !authorized(state)) return
      val status = connection.responseCode
      if (pairingRejected(connection, status)) throw AuthError()
      if (status !in 200..299) { if (status in 300..399 || status in listOf(502, 503, 504)) state.ingress.fail(hub); throw IllegalStateException("Events temporarily unavailable") }
      val json = JSONObject(connection.inputStream.use { readBounded(it, 2 * 1024 * 1024) })
      if (!current(state) || !authorized(state) || !SalcaraNotifyModule.notificationsAllowed(this)) return
      val events = json.optJSONArray("events") ?: JSONArray()
      var next = after; var received = 0
      for (index in 0 until events.length()) {
        val event = events.optJSONObject(index) ?: continue; val session = event.optString("sessionKey")
        if (event.optString("deviceId", device) != device || session.isEmpty() || target != null && session != target.session) continue
        received++; val seq = event.optLong("seq")
        if (seq > 0 && seq <= after) continue
        next = maxOf(next, seq)
        val watched = synchronized(state) { state.targets["$device|$session"] }
        handle(state, watched ?: Target(device, session, event.optJSONObject("session")?.optString("title").orEmpty().ifBlank { "电脑上的任务" }, SalcaraWatchRecovery.agentDisplayName(event.optString("tool")), 0), event)
      }
      val advertised = json.optLong("nextSeq", next)
      synchronized(state) {
        val cursor = if (received > 0) maxOf(after, next, advertised) else maxOf(after, next)
        if (target == null) state.devices[device] = cursor else target.after = cursor
        val pageTargets = if (target != null) listOf(target) else state.targets.values.filter { it.device == device }
        pageTargets.forEach { it.drain.page(received == 0, System.currentTimeMillis()) }
      }
    } catch (error: AuthError) { throw error }
    catch (error: Exception) { state.ingress.fail(hub); throw error }
    finally { connection.disconnect(); if (state.connection === connection) state.connection = null }
  }
  private fun handle(state: ConnectionState, target: Target, event: JSONObject) {
    if (!current(state) || !authorized(state)) return
    val type = event.optString("type")
    synchronized(state) {
      if (SalcaraWatchRecovery.isTerminalEvent(event)) target.drain.terminal(System.currentTimeMillis())
      else if (type == "turn" && event.optString("status") == "started" && event.optString("parentId").isEmpty()) target.drain.started()
    }
    // session.updated idle/failed can precede a terminal page. Never use it to retire the target.
    // No age-based discard: old pending approvals and recovered results still matter.
    val kind = when {
      type == "approval.request" -> if (event.optString("kind") == "question") "question" else "approval"
      type == "approval.resolved" -> "resolved"
      type == "message" -> "reply"
      else -> event.optString("status")
    }
    val title = when (kind) {
      "completed" -> "${target.agent} 完成了任务"
      "failed" -> "${target.agent} 的任务没有完成"
      "approval" -> "${target.agent} 需要批准"
      "question" -> "${target.agent} 需要你回答"
      else -> "${target.agent} 有新回复"
    }
    val payload = JSONObject().put("notificationScope", state.scope).put("deviceId", target.device).put("sessionKey", target.session)
      .put("kind", kind).put("event", event).apply { if (event.has("approvalId")) put("approvalId", event.getString("approvalId")) }
    SalcaraNotificationCenter.submit(this, "", title, target.title, payload)
  }
  private fun updateOngoing() {
    if (!active || !SalcaraNotifyModule.notificationsAllowed(this)) return
    val watched = states.filter { !it.retired }; if (watched.isEmpty()) return
    val count = watched.sumOf { it.deviceIds().size }
    val tasks = watched.sumOf { state -> synchronized(state) { state.targets.values.count { !it.done } } }
    val body = if (standby) "关注 $count 台电脑的任务结果和待处理请求" else "正在关注 $count 台电脑、$tasks 个任务；本次最多持续 2 小时"
    SalcaraNotifyModule.postTaskNotification(this, WATCH_ID, SalcaraNotifyModule.build(this, SalcaraNotifyModule.WATCH_CHANNEL, if (standby) STANDBY_TITLE else "Salcara 正在关注任务", body, null, true))
  }
  private fun pairingRejected(connection: HttpURLConnection, status: Int): Boolean {
    if (status != 401 && status != 403) return false
    val code = try { connection.errorStream?.use { JSONObject(readBounded(it, 4096)).let { body -> if (!body.has("code")) null else body.opt("code") as? String ?: "unknown_remote_error" } } } catch (_: Exception) { "unknown_remote_error" }
    return phonePairingRejected(status, code)
  }
  private fun readBounded(input: java.io.InputStream, max: Int): String {
    val output = java.io.ByteArrayOutputStream(); val buffer = ByteArray(4096)
    while (true) { val count = input.read(buffer); if (count < 0) break; require(output.size() + count <= max); output.write(buffer, 0, count) }
    return String(output.toByteArray(), Charsets.UTF_8)
  }
  private fun enc(value: String) = URLEncoder.encode(value, "UTF-8")

  companion object {
    const val WATCH_ID = 4127
    const val MAX_WATCH_MS = SalcaraWatchRecovery.TASK_TTL
    private val configLock = Any()
    @Volatile private var generation = 0L
    @Volatile private var activeService: SalcaraWatchService? = null
    @Volatile private var snapshot: JSONObject? = null
    @Volatile private var recoveryReady = false
    @Volatile private var stopReason = ""
    @Volatile var config: JSONObject? = null
    @Volatile var running = false
    @Volatile var startedAt = 0L
    @Volatile var lastTitle = "Salcara"
    @Volatile var lastBody = "正在关注电脑上的任务"
    @Volatile var standby = false
    fun prepareStart(intent: Intent) = synchronized(configLock) { intent.putExtra("watchGeneration", generation) }
    fun configure(context: Context, value: JSONObject?) = synchronized(configLock) {
      if (value == null) { clearConfiguration(context, "configuration"); activeService?.stopSelf(); return@synchronized }
      if (!value.optBoolean("follow")) {
        // Foreground JS owns sync, but the user-started quiet service must stay
        // ready for the later background handoff. No credential survives this pause.
        config = JSONObject().put("version", value.optLong("version")).put("follow", false)
        snapshot = null; recoveryReady = false; stopReason = ""
        SalcaraWatchVault.clear(context)
        activeService?.let { it.retireWorkers(); it.leaseIdentity = null; it.leaseDeadlineElapsed = 0; it.armLeaseTimeout() }
        return@synchronized
      }
      val normalized = SalcaraWatchRecovery.normalized(value)
      if (normalized == null) { activeService?.finish("configuration", true); clearConfiguration(context, "configuration"); return@synchronized }
      val persisted = (snapshot?.takeIf { SalcaraWatchRecovery.validate(it, System.currentTimeMillis()) != null } ?: SalcaraWatchVault.peek(context))?.optJSONObject("config")
      for (item in SalcaraWatchRecovery.connections(normalized)) {
        val old = persisted?.let { SalcaraWatchRecovery.connections(it).firstOrNull { candidate -> SalcaraWatchRecovery.sameAuthority(candidate, item) } }
        val router = activeService?.states?.firstOrNull { SalcaraWatchRecovery.sameAuthority(it.value, item) }?.ingress ?: SalcaraIngressRouter()
        router.recoverySnapshot(item.optString("hubUrl").trimEnd('/'), item.optString("navigationScope"), item.optJSONObject("ingressManifest"), old)?.let { item.put("ingressManifest", it) }
      }
      val wasStandby = standby
      standby = normalized.optBoolean("standby")
      config = normalized; snapshot = null; recoveryReady = false; SalcaraWatchVault.clear(context)
      if (standby || wasStandby != standby || startedAt == 0L) startedAt = System.currentTimeMillis()
      activeService?.let { it.restartWorkers(); it.armLeaseTimeout() }
    }
    fun targetsChanged(context: Context) = synchronized(configLock) {
      val service = activeService
      // Take the latest checkpoint before pruning; surviving pairings keep their
      // own progressed cursors and the original lease, never the stale JS handoff.
      config?.let { service?.saveCheckpoint(it) }
      val stored = snapshot ?: SalcaraWatchVault.peek(context)
      val source = stored?.optJSONObject("config") ?: config ?: return@synchronized
      val connections = SalcaraWatchRecovery.connections(source)
      val remaining = connections.filter { item ->
        val rows = if (SalcaraWatchRecovery.deviceMode(item)) item.optJSONArray("devices") else item.optJSONArray("sessions")
        rows != null && rows.length() > 0 && (0 until rows.length()).all { SalcaraNotificationCenter.permits(context, item.optString("navigationScope"), rows.getJSONObject(it).optString("deviceId")) }
      }
      if (remaining.size == connections.size) return@synchronized
      if (remaining.isEmpty()) { clearConfiguration(context, "authorization"); service?.stopSelf(); return@synchronized }
      val next = if (source.optInt("schema") == 2) JSONObject(source.toString()).put("connections", JSONArray(remaining.map { JSONObject(it.toString()) })) else JSONObject(remaining.single().toString())
      generation++
      config = next
      if (stored != null) {
        stored.put("config", next); snapshot = stored
        recoveryReady = SalcaraWatchVault.save(context, stored)
        if (!recoveryReady) stopReason = "storage"
      } else { snapshot = null; recoveryReady = false; SalcaraWatchVault.clear(context) }
      service?.restartWorkers()
    }
    fun clearConfiguration(context: Context, reason: String = "stopped") = synchronized(configLock) {
      generation++; config = null; snapshot = null; recoveryReady = false; running = false; standby = false; startedAt = 0L; stopReason = reason
      SalcaraWatchVault.clear(context); activeService?.active = false; activeService?.retireWorkers()
    }
    fun reportConfigurationFailure(context: Context, reason: String) = synchronized(configLock) {
      clearConfiguration(context, reason); activeService?.stopSelf()
    }
    fun status(): Map<String, Any> = synchronized(configLock) {
      val values = activeService?.states ?: emptyList()
      mapOf("running" to running, "standby" to standby, "recoveryReady" to recoveryReady, "notificationStorageReady" to SalcaraNotificationCenter.storageReady,
        "expiresAt" to (snapshot?.optLong("expiresAt") ?: 0L), "reason" to stopReason, "connectionCount" to values.size,
        "connections" to values.map { mapOf("notificationScope" to it.scope, "running" to !it.retired, "reason" to it.reason, "deviceMode" to SalcaraWatchRecovery.deviceMode(it.value)) })
    }
    fun recoveredIngress(context: Context): String? = synchronized(configLock) {
      if (!SalcaraNotifyModule.notificationsAllowed(context)) return@synchronized null
      val current = config; if (current != null && !current.optBoolean("follow")) return@synchronized null
      val restored = snapshot?.takeIf { SalcaraWatchRecovery.validate(it, System.currentTimeMillis()) != null } ?: SalcaraWatchVault.peek(context) ?: return@synchronized null
      val saved = restored.getJSONObject("config"); val values = JSONArray()
      for (item in SalcaraWatchRecovery.connections(saved)) {
        if (current != null && SalcaraWatchRecovery.connections(current).none { SalcaraWatchRecovery.sameAuthority(it, item) }) continue
        val router = activeService?.states?.firstOrNull { SalcaraWatchRecovery.sameAuthority(it.value, item) }?.ingress ?: SalcaraIngressRouter()
        val publicConfig = JSONObject(item.toString())
        router.recoverySnapshot(item.optString("hubUrl").trimEnd('/'), item.optString("navigationScope"), item.optJSONObject("ingressManifest"))?.let { publicConfig.put("ingressManifest", it) }
        router.publicRecoverySnapshot(publicConfig)?.let { values.put(it) }
      }
      if (saved.optInt("schema") == 2) JSONObject().put("schema", 2).put("connections", values).toString() else values.optJSONObject(0)?.toString()
    }
    const val STANDBY_TITLE = "Salcara 正在待命"
    const val STANDBY_BODY = "电脑上的任务结果、批准请求和问题会提醒你"
  }
}
