package expo.modules.salcaranotify

import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** One durable, process-wide admission gate for JS, Firebase and native watching. */
internal object SalcaraNotificationCenter {
  private const val MAX_TARGETS = 64
  private const val MAX_STATE_BYTES = 16 * 1024 * 1024
  private var loaded = false
  private var allowed = emptyMap<String, String>()
  private var policy = SalcaraNotificationPolicy()
  private var identity = SalcaraNotificationIdentity()
  private val ordinary = LinkedHashMap<String, LinkedHashMap<String, JSONObject>>()
  private var lastNormalSound = 0L
  private var protectedUntil = 0L
  private var visibleScope: String? = null
  private var visibleSession: String? = null
  @Volatile var storageReady = true; private set

  private fun targetFile(context: Context) = AtomicFile(File(context.noBackupFilesDir, "notification-targets-v1.json"))
  private fun stateFile(context: Context) = AtomicFile(File(context.noBackupFilesDir, "notification-ledger-v1.json"))
  private fun manager(context: Context) = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

  /** Durable before returning. Missing/corrupt state fails closed; a legacy push has no authority. */
  @Synchronized fun setTargets(context: Context, json: String): Boolean {
    require(json.toByteArray(Charsets.UTF_8).size <= 64 * 1024) { "Too many notification targets" }
    val next = parseTargets(JSONArray(json))
    ensureLoaded(context)
    if (!write(targetFile(context), JSONArray().also { rows -> next.forEach { (scope, device) -> rows.put(JSONObject().put("notificationScope", scope).put("deviceId", device)) } }.toString())) {
      storageReady = false
      blockTargets(context)
      return false
    }
    val removed = allowed.filter { (scope, device) -> next[scope] != device }.keys
    allowed = next
    for (scope in removed) {
      policy.clearScope(scope); identity.clearScope(scope); ordinary.remove(scope)
      if (Build.VERSION.SDK_INT >= 23) manager(context).activeNotifications.filter { it.tag?.startsWith("$scope:") == true }.forEach { manager(context).cancel(it.tag, it.id) }
    }
    persist(context, System.currentTimeMillis())
    return true
  }

  @Synchronized fun blockTargets(context: Context) {
    allowed.keys.forEach { policy.clearScope(it); identity.clearScope(it) }
    allowed = emptyMap(); ordinary.clear()
    targetFile(context).delete()
    if (Build.VERSION.SDK_INT >= 23) manager(context).activeNotifications.filter { it.tag?.startsWith("ns1_") == true }.forEach { manager(context).cancel(it.tag, it.id) }
  }

  @Synchronized fun permits(context: Context, scope: String, device: String): Boolean {
    ensureLoaded(context)
    return allowed[scope] == device
  }

  @Synchronized fun setVisible(scope: String?, session: String?) {
    visibleScope = scope?.takeIf { SalcaraNotificationIdentity.validScope(it) }
    visibleSession = session?.takeIf { SalcaraNotificationIdentity.validPart(it, 512) }
  }

  /** Foreground UI calls only when it is actually delivering its toast. */
  @Synchronized fun admit(context: Context, suppliedId: String, payload: JSONObject): Boolean {
    ensureLoaded(context)
    val scope = payload.optString("notificationScope")
    if (allowed[scope] != payload.optString("deviceId")) return false
    val now = System.currentTimeMillis()
    val notice = identity.fromPayload(suppliedId, payload, now)
    if (notice == null) { persist(context, now); return false }
    if (notice.kind == "resolved" || notice.expiresAt?.let { it <= now } == true && notice.kind in listOf("approval", "question")) {
      policy.resolve(notice.id, scope, now); manager(context).cancel(notice.id, 0); persist(context, now); return false
    }
    val result = policy.decide(notice.id, scope, notice.kind, now, notice.eventTs, notice.expiresAt) != null
    if (result && notice.kind == "failed") { ordinary[scope]?.remove(notice.id); refreshOrdinary(context, scope, now, false) }
    persist(context, now)
    return result
  }

  @Synchronized fun submit(context: Context, suppliedId: String, title: String, body: String, payload: JSONObject): Boolean {
    ensureLoaded(context)
    val scope = payload.optString("notificationScope")
    val device = payload.optString("deviceId")
    if (allowed[scope] != device) return false
    val now = System.currentTimeMillis()
    val notice = identity.fromPayload(suppliedId, payload, now)
    if (notice == null) { persist(context, now); return false }
    val before = policy.snapshot(now)
    if (notice.kind == "resolved" || notice.expiresAt?.let { it <= now } == true && notice.kind in listOf("approval", "question")) {
      policy.resolve(notice.id, scope, now)
      manager(context).cancel(notice.id, 0)
      manager(context).cancel(notice.id.hashCode()) // Retire pre-ledger notifications on upgrade.
      persist(context, now)
      return true
    }
    if (!SalcaraNotifyModule.notificationsAllowed(context)) return false
    // Visible state is process-local and expires with the JS module. Other computers
    // must still deliver even while the app itself is in the foreground.
    if (visibleScope == scope && visibleSession == payload.optString("sessionKey") && SalcaraPushService.inForeground(context)) {
      policy.decide(notice.id, scope, notice.kind, now, notice.eventTs, notice.expiresAt)
      if (notice.kind == "failed") { ordinary[scope]?.remove(notice.id); refreshOrdinary(context, scope, now, false) }
      persist(context, now)
      return false
    }
    val decision = policy.decide(notice.id, scope, notice.kind, now, notice.eventTs, notice.expiresAt)
    if (decision == null) { persist(context, now); return false }
    val navigation = JSONObject().put("deviceId", device).put("sessionKey", payload.optString("sessionKey")).put("notificationScope", scope)
      .apply { payload.optString("approvalId").takeIf { it.isNotEmpty() }?.let { put("approvalId", it) } }
    SalcaraNotifyModule.ensureChannels(context)
    try {
      if (decision.urgent) {
        protectedUntil = now + 4000
        ordinary[scope]?.remove(notice.id)
        val notification = SalcaraNotifyModule.build(context, SalcaraNotifyModule.TASK_CHANNEL, title, body, navigation.toString(), false,
          alertOnce = false, expiresAt = notice.expiresAt)
        if (!SalcaraNotifyModule.postTaggedNotification(context, notice.id, notification)) throw SecurityException("Notification delivery disabled")
        refreshOrdinary(context, scope, now, false)
      } else {
        if (Build.VERSION.SDK_INT >= 23 && manager(context).activeNotifications.none { it.tag == "$scope:summary" }) ordinary.remove(scope)
        val rows = ordinary.getOrPut(scope) { LinkedHashMap() }
        rows[notice.id] = navigation.put("kind", notice.kind).put("at", now)
        while (rows.size > 1000) rows.remove(rows.keys.first())
        while (ordinary.values.sumOf { it.size } > 1000) {
          val oldest = ordinary.entries.flatMap { (key, items) -> items.entries.map { Triple(key, it.key, it.value.optLong("at")) } }.minByOrNull { it.third } ?: break
          ordinary[oldest.first]?.remove(oldest.second)
        }
        val sound = !decision.stale && now >= protectedUntil && (lastNormalSound == 0L || now - lastNormalSound >= 10_000)
        refreshOrdinary(context, scope, now, sound, if (rows.size == 1) title else null, if (rows.size == 1) body else null)
        if (sound) lastNormalSound = now
      }
      persist(context, now)
      return true
    } catch (_: SecurityException) {
      // Permission can change after admission. Do not permanently consume undelivered news.
      policy = SalcaraNotificationPolicy().also { it.restore(before, now) }
      ordinary[scope]?.remove(notice.id)
      return false
    } catch (_: RuntimeException) {
      policy = SalcaraNotificationPolicy().also { it.restore(before, now) }
      ordinary[scope]?.remove(notice.id)
      return false
    }
  }

  /** Process observation loss is important, but it must not masquerade as a task result. */
  @Synchronized fun observationStopped(context: Context, scope: String, device: String, reason: String) {
    if (!permits(context, scope, device) || !SalcaraNotifyModule.notificationsAllowed(context)) return
    val body = when (reason) {
      "authentication" -> "连接授权已失效，请打开应用重新连接。这台电脑的后台提醒已暂停。"
      "identity" -> "Bot 服务身份需要重新确认，请打开应用检查绑定。该连接的后台提醒已暂停，其他连接不受影响。"
      "expired" -> "本次后台观察已到时限，请打开应用继续关注任务。"
      "configuration", "capacity" -> "后台连接配置超出可用范围，请打开应用检查通知状态。"
      "storage" -> "后台恢复状态未能保存，应用关闭后可能无法继续提醒。"
      else -> "系统已暂停后台观察，请打开应用继续关注任务。"
    }
    SalcaraNotifyModule.ensureChannels(context)
    try { SalcaraNotifyModule.postTaggedNotification(context, "$scope:watch-status", SalcaraNotifyModule.build(context, SalcaraNotifyModule.TASK_CHANNEL,
      "后台提醒需要关注", body, JSONObject().put("deviceId", device).put("notificationScope", scope).put("notificationStatus", reason).toString(), false, alertOnce = true)) } catch (_: SecurityException) { }
  }

  private fun refreshOrdinary(context: Context, scope: String, now: Long, sound: Boolean, singleTitle: String? = null, singleBody: String? = null) {
    val rows = ordinary[scope] ?: return
    rows.entries.removeAll { now - it.value.optLong("at") > SalcaraNotificationPolicy.DEFAULT_RETENTION_MS }
    val tag = "$scope:summary"
    if (rows.isEmpty()) { manager(context).cancel(tag, 0); ordinary.remove(scope); return }
    val last = rows.values.last()
    val count = rows.size
    val payload = JSONObject(last.toString()).put("notificationCount", count).toString()
    val title = singleTitle ?: if (count == 1) "远程任务有新结果" else "$count 个任务有新结果"
    val body = singleBody ?: "任务完成与回复已合并；点开查看最近一项，其他结果保留在任务列表中。"
    val delivered = SalcaraNotifyModule.postTaggedNotification(context, tag, SalcaraNotifyModule.build(context,
      if (sound) SalcaraNotifyModule.TASK_CHANNEL else SalcaraNotifyModule.QUIET_CHANNEL,
      title, body, payload, false, alertOnce = !sound))
    if (!delivered) throw SecurityException("Notification delivery disabled")
  }

  private fun ensureLoaded(context: Context) {
    if (loaded) return
    loaded = true
    allowed = try { parseTargets(JSONArray(read(targetFile(context), 64 * 1024))) } catch (_: Exception) { emptyMap() }
    try {
      val value = JSONObject(read(stateFile(context), MAX_STATE_BYTES))
      if (value.optInt("schema") != 1) return
      val now = System.currentTimeMillis()
      val entries = value.optJSONArray("entries") ?: JSONArray()
      if (entries.length() > SalcaraNotificationPolicy.MAX_ENTRIES) return
      val records = (0 until entries.length()).map { index -> entries.getJSONObject(index).let {
        SalcaraNotificationPolicy.Record(it.getString("id"), it.getString("scope"), it.getString("kind"), it.getLong("at"), if (it.has("expiresAt")) it.getLong("expiresAt") else null)
      } }
      policy.restore(SalcaraNotificationPolicy.Snapshot(1, value.getLong("savedAt"), records), now)
      value.optJSONObject("identity")?.let { identity.restore(it, now) }
      val summaries = value.optJSONArray("ordinary") ?: JSONArray()
      if (summaries.length() <= 1000) for (index in 0 until summaries.length()) {
        val row = summaries.optJSONObject(index) ?: continue
        val scope = row.optString("notificationScope"); val id = row.optString("id")
        if (allowed[scope] == row.optString("deviceId") && id.startsWith("$scope:task:") && id.length <= 1200 && now - row.optLong("at") in 0..SalcaraNotificationPolicy.DEFAULT_RETENTION_MS) ordinary.getOrPut(scope) { LinkedHashMap() }[id] = row
      }
      records.filter { allowed[it.scope] == null }.forEach { policy.clearScope(it.scope); identity.clearScope(it.scope) }
    } catch (_: Exception) { /* A corrupt presentation ledger cannot authorize any target. */ }
  }

  private fun persist(context: Context, now: Long) {
    val snapshot = policy.snapshot(now)
    val value = JSONObject().put("schema", 1).put("savedAt", snapshot.savedAt)
      .put("entries", JSONArray().also { rows -> snapshot.entries.forEach { row -> rows.put(JSONObject().put("id", row.id).put("scope", row.scope).put("kind", row.kind).put("at", row.at).apply { row.expiresAt?.let { put("expiresAt", it) } }) } })
      .put("identity", identity.snapshot(now))
      .put("ordinary", JSONArray().also { rows -> ordinary.forEach { (_, items) -> items.forEach { (id, item) -> rows.put(JSONObject(item.toString()).put("id", id)) } } })
    storageReady = write(stateFile(context), value.toString())
  }
  private fun parseTargets(rows: JSONArray): Map<String, String> {
    require(rows.length() <= MAX_TARGETS) { "At most $MAX_TARGETS notification targets are supported" }
    val result = LinkedHashMap<String, String>()
    for (index in 0 until rows.length()) {
      val row = rows.getJSONObject(index); val scope = row.getString("notificationScope"); val device = row.getString("deviceId")
      require(SalcaraNotificationIdentity.validScope(scope) && Regex("[A-Za-z0-9._-]{1,128}").matches(device)) { "Invalid notification target" }
      require(result[scope] == null || result[scope] == device) { "Ambiguous notification scope" }
      result[scope] = device
    }
    return result
  }
  private fun read(file: AtomicFile, max: Int) = file.openRead().use { stream ->
    val bytes = java.io.ByteArrayOutputStream(); val buffer = ByteArray(4096)
    while (true) { val count = stream.read(buffer); if (count < 0) break; require(bytes.size() + count <= max); bytes.write(buffer, 0, count) }
    String(bytes.toByteArray(), Charsets.UTF_8)
  }
  private fun write(file: AtomicFile, text: String): Boolean {
    val bytes = text.toByteArray(Charsets.UTF_8)
    if (bytes.size > MAX_STATE_BYTES) return false
    var output: java.io.FileOutputStream? = null
    return try { output = file.startWrite(); output.write(bytes); file.finishWrite(output); true }
    catch (_: Exception) { output?.let { file.failWrite(it) }; false }
  }
}
