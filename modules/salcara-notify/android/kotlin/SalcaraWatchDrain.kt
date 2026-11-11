package expo.modules.salcaranotify

/** Terminal news can straddle pages; completion is not permission to abandon the tail. */
internal class SalcaraWatchDrain(done: Boolean = false, completedAt: Long = 0, emptyTail: Boolean = false) {
  var done = done; private set
  var completedAt = completedAt; private set
  var emptyTail = emptyTail; private set

  fun started() { done = false; completedAt = 0; emptyTail = false }
  fun terminal(now: Long) { done = true; completedAt = now; emptyTail = false }
  fun page(empty: Boolean, now: Long) {
    if (!done) return
    if (completedAt <= 0 || completedAt > now) completedAt = now
    emptyTail = empty
  }
  fun finished(now: Long) = done && emptyTail && completedAt > 0 && now >= completedAt && now - completedAt >= DRAIN_MS
  companion object { const val DRAIN_MS = 30_000L }
}
