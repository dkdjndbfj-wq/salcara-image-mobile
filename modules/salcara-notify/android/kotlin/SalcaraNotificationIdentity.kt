package expo.modules.salcaranotify

import org.json.JSONArray
import org.json.JSONObject

/** Identity metadata only. Text, credentials and transport endpoints never enter this ledger. */
internal class SalcaraNotificationIdentity {
  data class Notice(val id: String, val kind: String, val eventTs: Long, val expiresAt: Long? = null)
  private data class Legacy(val scope: String, var at: Long, val ref: String, var started: Boolean, val marker: String, val kinds: MutableSet<String>, var eventSeq: Long? = null, var eventTs: Long = 0)
  private data class Seen(val scope: String, val at: Long, val id: String)
  private val legacy = LinkedHashMap<String, Legacy>()
  private val events = LinkedHashMap<String, Seen>()

  fun observe(scope: String, device: String, session: String, event: JSONObject, now: Long): Notice? {
    prune(now)
    if (!validScope(scope) || !validPart(device, 128) || !validPart(session, 512)) return null
    val type = event.optString("type")
    val ts = event.optLong("ts", now).coerceAtLeast(0)
    val marker = if (event.has("seq")) event.optLong("seq").toString() else ts.toString()
    val eventSeq = if (event.has("seq")) event.optLong("seq") else null
    fun olderThan(row: Legacy) = if (eventSeq != null && row.eventSeq != null) eventSeq < row.eventSeq!! else ts < row.eventTs
    val sessionId = JSONArray().put(scope).put(device).put(session).toString()
    if (type == "turn" && event.optString("status") == "started" && event.optString("parentId").isEmpty()) {
      val startKey = JSONArray().put(sessionId).put("started").put(marker).toString()
      if (events.containsKey(startKey)) return null
      events[startKey] = Seen(scope, now, "$scope:task:$device:$session:legacy:$marker"); trim(events)
      val previous = legacy[sessionId]
      if (previous != null && olderThan(previous)) return null
      if (previous?.marker != marker) legacy[sessionId] = Legacy(scope, now, "legacy:$marker", true, marker, mutableSetOf(), eventSeq, ts)
      trim(legacy)
      return null
    }
    val kind = when {
      type == "approval.resolved" -> "resolved"
      type == "approval.request" -> if (event.optString("kind") == "question") "question" else "approval"
      type == "turn" && event.optString("parentId").isEmpty() && event.optString("status") in listOf("completed", "failed") -> event.getString("status")
      type == "message" && event.optString("role") == "assistant" && event.optBoolean("final") && event.optString("parentId").isEmpty() && event.optString("messagePhase") != "commentary" -> "reply"
      else -> return null
    }
    val request = kind in listOf("approval", "question", "resolved")
    val approval = event.optString("approvalId")
    if (request && !validPart(approval, 512)) return null
    val eventId = JSONArray().put(sessionId).put(type).put(event.optString("turnId"))
      .put(if (request) approval else "").put(if (event.has("id")) event.optString("id") else marker).put(kind).toString()
    if (!validPart(eventId, 4096)) return null
    val expiry = if (request && event.has("expiresAt")) event.optLong("expiresAt").coerceAtLeast(0) else null
    val externalRef = event.optString("_notificationTurnRef").takeIf { validPart(it, 512) }.orEmpty()
    val base = "$scope:task:$device:$session:"
    val aliasKey = JSONArray().put(sessionId).put("ref-alias").put(externalRef).toString()
    events[eventId]?.let { previous ->
      // A cold watcher can first see seq 11 while Hub knows the start at seq 10.
      // The actual source event wins; bind Hub's anchor to that already-admitted id.
      if (!request && externalRef.isNotEmpty() && previous.id.startsWith(base)) {
        events[aliasKey] = Seen(scope, now, previous.id); trim(events)
      }
      return Notice(previous.id, kind, ts, expiry)
    }
    var ref = event.optString("turnId").ifEmpty { externalRef }
    if (!request && event.optString("turnId").isEmpty() && externalRef.isNotEmpty()) {
      ref = events[aliasKey]?.id?.takeIf { it.startsWith(base) }?.removePrefix(base) ?: externalRef
      val boundary = legacy[sessionId]
      if (ref.startsWith("legacy:") && (boundary == null || !olderThan(boundary))) {
        val old = legacy[sessionId]?.takeIf { it.ref == ref }
        val current = Legacy(scope, now, ref, false, old?.marker.orEmpty(), old?.kinds ?: mutableSetOf(), eventSeq, ts)
        current.kinds.add(kind); legacy[sessionId] = current; trim(legacy)
      }
    }
    if (!request && ref.isEmpty()) {
      var current = legacy[sessionId]
      if (current == null || !current.started && (now - current.at > 60_000 || kind in current.kinds)) {
        val identity = if (event.has("seq")) marker else event.optString("id").ifEmpty { marker }
        current = Legacy(scope, now, "legacy:$identity", false, "", mutableSetOf())
      }
      current.kinds.add(kind); current.at = now; current.eventSeq = eventSeq; current.eventTs = ts
      current.started = false
      legacy.remove(sessionId); legacy[sessionId] = current; trim(legacy)
      ref = current.ref
    }
    val id = if (request) "$scope:approval:$device:$session:$approval" else "$base$ref"
    if (id.length > SalcaraNotificationPolicy.MAX_ID_CHARS) return null
    events[eventId] = Seen(scope, now, id); trim(events)
    return Notice(id, kind, ts, expiry)
  }

  fun fromPayload(id: String, payload: JSONObject, now: Long): Notice? {
    val scope = payload.optString("notificationScope")
    val device = payload.optString("deviceId")
    val session = payload.optString("sessionKey")
    if (!validScope(scope) || !validPart(device, 128) || !validPart(session, 512)) return null
    payload.optJSONObject("event")?.let { event ->
      val metadata = JSONObject(event.toString())
      // New Hubs share their legacy anchor so a phone that never saw the start
      // still agrees with push/watch/JS about which reply and result are one turn.
      val suppliedRef = payload.optString("turnRef").ifEmpty {
        val prefix = "$scope:task:$device:$session:"
        if (id.startsWith(prefix)) id.removePrefix(prefix) else ""
      }
      suppliedRef.takeIf { validPart(it, 512) && metadata.optString("turnId").isEmpty() }?.let {
        metadata.put("_notificationTurnRef", it)
      }
      return observe(scope, device, session, metadata, now)
    }
    val kind = payload.optString("kind").let { if (it == "done") "completed" else it }
    if (kind !in listOf("completed", "failed", "reply", "approval", "question", "resolved")) return null
    val canonical = when {
      id.startsWith("$scope:task:$device:$session:") || id.startsWith("$scope:approval:$device:$session:") -> id
      id.startsWith("task:$device:$session:") || id.startsWith("approval:$device:$session:") -> "$scope:$id"
      kind in listOf("approval", "question", "resolved") && validPart(payload.optString("approvalId"), 512) -> "$scope:approval:$device:$session:${payload.getString("approvalId")}"
      else -> return null
    }
    if (canonical.length > SalcaraNotificationPolicy.MAX_ID_CHARS || canonical.any { it.isISOControl() }) return null
    return Notice(canonical, kind, payload.optLong("eventTs", payload.optLong("ts", now)).coerceAtLeast(0),
      if (payload.has("expiresAt")) payload.optLong("expiresAt").coerceAtLeast(0) else null)
  }

  fun clearScope(scope: String) { legacy.entries.removeAll { it.value.scope == scope }; events.entries.removeAll { it.value.scope == scope } }
  fun snapshot(now: Long): JSONObject {
    prune(now)
    return JSONObject().put("legacy", JSONArray().also { rows -> legacy.forEach { (key, row) -> rows.put(JSONObject().put("key", key).put("scope", row.scope).put("at", row.at).put("ref", row.ref).put("started", row.started).put("marker", row.marker).put("kinds", JSONArray(row.kinds.toList())).put("eventSeq", row.eventSeq ?: JSONObject.NULL).put("eventTs", row.eventTs)) } })
      .put("events", JSONArray().also { rows -> events.forEach { (key, row) -> rows.put(JSONObject().put("key", key).put("scope", row.scope).put("at", row.at).put("id", row.id)) } })
  }
  fun restore(value: JSONObject, now: Long) {
    val oldLegacy = value.optJSONArray("legacy") ?: JSONArray()
    val oldEvents = value.optJSONArray("events") ?: JSONArray()
    if (oldLegacy.length() > LIMIT || oldEvents.length() > LIMIT) return
    for (index in 0 until oldLegacy.length()) {
      val row = oldLegacy.optJSONObject(index) ?: continue
      val at = row.optLong("at", -1); val scope = row.optString("scope"); val key = row.optString("key"); val ref = row.optString("ref")
      if (!validScope(scope) || !validPart(key, 4096) || !validPart(ref, 1200) || !live(at, now)) continue
      val kinds = row.optJSONArray("kinds") ?: JSONArray()
      legacy[key] = Legacy(scope, at, ref, row.optBoolean("started"), row.optString("marker").take(128), (0 until kinds.length()).map { kinds.optString(it) }.filter { it in listOf("completed", "failed", "reply") }.toMutableSet(), if (row.isNull("eventSeq")) null else row.optLong("eventSeq"), row.optLong("eventTs"))
    }
    for (index in 0 until oldEvents.length()) {
      val row = oldEvents.optJSONObject(index) ?: continue
      val at = row.optLong("at", -1); val scope = row.optString("scope"); val key = row.optString("key"); val id = row.optString("id")
      if (validScope(scope) && validPart(key, 4096) && validPart(id, 1200) && id.startsWith("$scope:") && live(at, now)) events[key] = Seen(scope, at, id)
    }
  }
  private fun prune(now: Long) { legacy.entries.removeAll { !live(it.value.at, now) }; events.entries.removeAll { !live(it.value.at, now) } }
  private fun <T> trim(map: LinkedHashMap<String, T>) { while (map.size > LIMIT) map.remove(map.keys.first()) }
  private fun live(at: Long, now: Long) = at >= 0 && at <= now + 60_000 && now - at <= SalcaraNotificationPolicy.DEFAULT_RETENTION_MS
  companion object {
    const val LIMIT = 1000
    fun validScope(scope: String) = Regex("ns1_[a-f0-9]{64}").matches(scope)
    fun validPart(value: String, max: Int) = value.isNotEmpty() && value.length <= max && value.none { it.isISOControl() }
  }
}
