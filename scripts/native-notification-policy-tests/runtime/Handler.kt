package android.os

interface IBinder
class Looper { companion object { fun getMainLooper() = Looper() } }
class Handler(looper: Looper) {
  private val tasks = mutableListOf<Runnable>()
  fun post(task: Runnable): Boolean { if (holdPosts) posted.add(task) else task.run(); return true }
  fun postDelayed(task: Runnable, delay: Long): Boolean { tasks.add(task); delayed.add(task); return true }
  fun removeCallbacks(task: Runnable) { tasks.remove(task) }
  fun removeCallbacksAndMessages(token: Any?) { tasks.clear() }
  companion object {
    var holdPosts = false
    val posted = java.util.ArrayDeque<Runnable>()
    val delayed = mutableListOf<Runnable>()
    fun flush() { holdPosts = false; while (posted.isNotEmpty()) posted.removeFirst().run() }
  }
}
object SystemClock { fun elapsedRealtime() = System.nanoTime() / 1_000_000 }
