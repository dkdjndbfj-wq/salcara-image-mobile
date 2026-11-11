package expo.modules.salcaranotify

/**
 * Presentation-only ledger shared by native watch and push receivers.
 *
 * Callers supply the same normalized identity for a turn on every channel, and
 * an independent identity for each approval/question. This class neither
 * derives an authorization scope nor invents an identity for legacy events.
 * A decision is an admission, not proof that Android displayed a notification.
 */
internal class SalcaraNotificationPolicy(
  maxEntries: Int = MAX_ENTRIES,
  private val retentionMs: Long = DEFAULT_RETENTION_MS,
) {
  init {
    require(maxEntries in 1..MAX_ENTRIES)
    require(retentionMs in 1..MAX_RETENTION_MS)
  }

  data class Decision(
    val id: String,
    val scope: String,
    val kind: String,
    val urgent: Boolean,
    val upgrade: Boolean,
    val stale: Boolean,
    val expiresAt: Long? = null,
  )

  /** Only non-secret identities and decision metadata belong in a snapshot. */
  data class Record(
    val id: String,
    val scope: String,
    val kind: String,
    val at: Long,
    val expiresAt: Long? = null,
  )

  data class Snapshot(val version: Int, val savedAt: Long, val entries: List<Record>)

  private data class Key(val scope: String, val id: String, val request: Boolean)
  private val capacity = maxEntries
  private val records = LinkedHashMap<Key, Record>()

  /** `done` is the existing push wire alias; decisions use the JS name `completed`. */
  @Synchronized
  fun decide(id: String, scope: String, kind: String, now: Long, eventTs: Long, expiresAt: Long? = null): Decision? {
    val canonical = if (kind == "done") "completed" else kind
    if (!validIdentity(id, scope) || canonical !in KINDS || now < 0 || eventTs < 0 || expiresAt != null && expiresAt < 0) return null
    prune(now)
    if (canonical == "resolved") {
      remember(Record(id, scope, "resolved", now))
      return null
    }
    val request = canonical == "approval" || canonical == "question"
    if (request && expiresAt != null && expiresAt <= now) {
      // A stale delivery must not later revive the same expired request.
      remember(Record(id, scope, "resolved", now, expiresAt))
      return null
    }
    val key = Key(scope, id, request)
    val previous = records[key]
    if (previous?.kind == "resolved" || previous?.kind == "failed") return null
    if (previous != null && canonical != "failed") return null
    remember(Record(id, scope, canonical, now, if (request) expiresAt else null))
    return Decision(id, scope, canonical, canonical == "failed" || request, previous != null,
      now >= eventTs && now - eventTs > STALE_MS, if (request) expiresAt else null)
  }

  /** Resolution is a tombstone: a delayed request cannot reopen its notification. */
  @Synchronized
  fun resolve(id: String, scope: String, now: Long): Boolean {
    if (!validIdentity(id, scope) || now < 0) return false
    prune(now)
    remember(Record(id, scope, "resolved", now))
    return true
  }

  @Synchronized
  fun clearScope(scope: String) {
    records.entries.removeAll { it.key.scope == scope }
  }

  @Synchronized
  fun clear() { records.clear() }

  @Synchronized
  fun snapshot(now: Long): Snapshot {
    require(now >= 0)
    prune(now)
    return Snapshot(SCHEMA, now, records.values.map { it.copy() })
  }

  /**
   * Restore is validated before changing live state. It merges rather than
   * replaces: a slow disk read cannot erase a newer push/watch failure or
   * resurrect a request already resolved in this process.
   *
   * Serialization and atomic private-file persistence remain the caller's
   * responsibility. The snapshot has no token, endpoint, task text or credential
   * fields; callers must also keep such values out of the supplied identities.
   */
  @Synchronized
  fun restore(snapshot: Snapshot, now: Long): Boolean {
    if (now < 0 || snapshot.version != SCHEMA || snapshot.savedAt < 0
      || tooFarInFuture(snapshot.savedAt, now) || snapshot.entries.size > MAX_ENTRIES) return false
    val restored = LinkedHashMap<Key, Record>()
    for (row in snapshot.entries) {
      if (!validIdentity(row.id, row.scope) || row.kind !in KINDS || row.at < 0
        || row.at > snapshot.savedAt || tooFarInFuture(row.at, now)
        || row.expiresAt != null && (row.expiresAt < 0 || !isRequest(row.kind))) return false
      val key = keyOf(row)
      if (restored.containsKey(key)) return false
      restored[key] = row.copy()
    }
    val merged = LinkedHashMap<Key, Record>()
    for ((key, row) in restored) if (!expired(row, now)) merged[key] = row
    for ((key, row) in records) if (!expired(row, now)) {
      val old = merged[key]
      merged[key] = when {
        old == null -> row
        priority(row.kind) > priority(old.kind) -> row
        priority(row.kind) < priority(old.kind) -> old
        row.at >= old.at -> row
        else -> old
      }
    }
    records.clear()
    // Old restored records must be evicted before newer live admissions.
    for (row in merged.values.sortedBy { it.at }.takeLast(capacity)) records[keyOf(row)] = row
    return true
  }

  private fun remember(row: Record) {
    val key = keyOf(row)
    records.remove(key)
    records[key] = row
    while (records.size > capacity) records.remove(records.keys.first())
  }

  private fun prune(now: Long) { records.entries.removeAll { expired(it.value, now) } }
  private fun expired(row: Record, now: Long) = tooFarInFuture(row.at, now) || now >= row.at && now - row.at > retentionMs
  private fun tooFarInFuture(at: Long, now: Long) = at > now && at - now > CLOCK_SKEW_MS
  private fun keyOf(row: Record) = Key(row.scope, row.id, isRequest(row.kind))
  private fun isRequest(kind: String) = kind == "approval" || kind == "question" || kind == "resolved"
  private fun priority(kind: String) = when (kind) { "resolved" -> 3; "failed" -> 2; else -> 1 }
  private fun validIdentity(id: String, scope: String) = id.isNotEmpty() && id.length <= MAX_ID_CHARS
    && scope.isNotEmpty() && scope.length <= MAX_SCOPE_CHARS
    && id.none { it.isISOControl() } && scope.none { it.isISOControl() }

  companion object {
    const val SCHEMA = 1
    const val MAX_ENTRIES = 1000
    const val MAX_ID_CHARS = 1200
    const val MAX_SCOPE_CHARS = 256
    const val DEFAULT_RETENTION_MS = 24L * 60 * 60 * 1000
    const val MAX_RETENTION_MS = 7L * 24 * 60 * 60 * 1000
    const val STALE_MS = 10L * 60 * 1000
    const val CLOCK_SKEW_MS = 60_000L
    private val KINDS = setOf("completed", "failed", "reply", "approval", "question", "resolved")
  }
}
