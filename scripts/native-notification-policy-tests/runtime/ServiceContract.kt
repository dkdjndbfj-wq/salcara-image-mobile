package expo.modules.salcaranotify

import android.content.Intent
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLStreamHandler
import java.util.concurrent.Delayed
import java.util.concurrent.FutureTask
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit

private val serviceScope = "ns1_" + "a".repeat(64)
private class RecordedFuture : FutureTask<Unit>(Runnable {}, Unit), ScheduledFuture<Unit> {
  override fun getDelay(unit: TimeUnit) = 0L
  override fun compareTo(other: Delayed) = 0
}
private class RecordedExecutor : ScheduledThreadPoolExecutor(1) {
  val pending = java.util.ArrayDeque<Runnable>()
  override fun schedule(command: Runnable, delay: Long, unit: TimeUnit): ScheduledFuture<*> { pending.add(command); return RecordedFuture() }
  fun next() { check(pending.isNotEmpty()); pending.removeFirst().run() }
}
private object NetworkFixture {
  val pages = java.util.ArrayDeque<String>()
  val headers = mutableListOf<Map<String, String>>()
  var calls = 0
  fun install() {
    URL.setURLStreamHandlerFactory { protocol -> if (protocol !in listOf("https", "http")) null else object : URLStreamHandler() {
      override fun openConnection(url: URL) = object : HttpURLConnection(url) {
        private val sent = LinkedHashMap<String, String>()
        override fun setRequestProperty(key: String, value: String) { sent[key] = value }
        override fun getResponseCode(): Int { calls++; headers.add(sent.toMap()); return 200 }
        override fun getInputStream() = (if (pages.isEmpty()) "{\"events\":[]}" else pages.removeFirst()).byteInputStream()
        override fun connect() { }; override fun disconnect() { }; override fun usingProxy() = false
      }
    } }
  }
  fun page(vararg rows: JSONObject) { pages.add(JSONObject().put("events", JSONArray(rows.toList())).toString()) }
}
private fun field(instance: Any, name: String): Any? = instance.javaClass.getDeclaredField(name).apply { isAccessible = true }.get(instance)
private fun state(service: SalcaraWatchService) = (field(service, "states") as List<*>).first()!!
private fun drain(service: SalcaraWatchService): SalcaraWatchDrain {
  val target = (field(state(service), "targets") as Map<*, *>).values.first()!!
  return field(target, "drain") as SalcaraWatchDrain
}
private fun watchConfig(standby: Boolean = false, scope: String = serviceScope, device: String = "pc-a") = JSONObject().put("follow", true).put("standby", standby)
  .put("hubUrl", "https://fixture.invalid").put("pairToken", "synthetic-test-only").put("navigationScope", scope).put("wait", false)
  .put("sessions", JSONArray().put(JSONObject().put("deviceId", device).put("sessionKey", "codex:1").put("after", 0)))
  .put("devices", JSONArray().put(JSONObject().put("deviceId", device).put("after", 0)))
private fun wire(type: String, seq: Long, status: String = "") = JSONObject().put("type", type).put("seq", seq).put("ts", System.currentTimeMillis())
  .put("deviceId", "pc-a").put("sessionKey", "codex:1").put("status", status).put("turnId", "turn-1")
private inline fun serviceFixture(block: (SalcaraWatchService, RecordedExecutor) -> Unit) {
  reload()
  val service = SalcaraWatchService()
  SalcaraWatchService.clearConfiguration(service)
  val original = field(service, "executor") as ScheduledThreadPoolExecutor; original.shutdownNow()
  val executor = RecordedExecutor()
  service.javaClass.getDeclaredField("executor").apply { isAccessible = true }.set(service, executor)
  SalcaraNotificationCenter.setTargets(service, JSONArray().put(JSONObject().put("notificationScope", serviceScope).put("deviceId", "pc-a")).toString())
  NetworkFixture.pages.clear(); NetworkFixture.headers.clear(); NetworkFixture.calls = 0
  try { block(service, executor) } finally { SalcaraWatchService.clearConfiguration(service); service.onDestroy(); executor.shutdownNow(); android.os.Handler.flush(); android.os.Handler.delayed.clear() }
}

fun serviceContracts(): Int {
  NetworkFixture.install()
  var count = 0
  fun test(name: String, action: () -> Unit) { action(); count++; println("PASS $name") }
  test("real service can start before any credential handoff and pause without stopping foreground readiness") {
    serviceFixture { service, executor ->
      val intent = SalcaraWatchService.prepareStart(Intent().putExtra("title", "Running"))
      check(service.onStartCommand(intent, 0, 1) == android.app.Service.START_STICKY)
      check(service.foregroundStarted && !service.stopped && SalcaraWatchService.running)
      check(executor.pending.isEmpty() && SalcaraWatchVault.saved == null)
      SalcaraWatchService.configure(service, JSONObject().put("follow", false))
      check(!service.stopped && SalcaraWatchService.running && SalcaraWatchVault.saved == null)
      SalcaraWatchService.configure(service, watchConfig())
      check(executor.pending.size == 1 && SalcaraWatchVault.saved != null)
      SalcaraWatchService.configure(service, JSONObject().put("follow", false))
      executor.next() // Already scheduled old work cannot issue a request after handoff back to JS.
      check(NetworkFixture.calls == 0 && SalcaraWatchVault.saved == null && !service.stopped)
    }
  }
  test("standby can start with no config; later handoff creates only its bounded standby lease") {
    serviceFixture { service, executor ->
      check(service.onStartCommand(SalcaraWatchService.prepareStart(Intent().putExtra("standby", true)), 0, 1) == android.app.Service.START_STICKY)
      check(SalcaraWatchService.standby && service.foregroundType == android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
      SalcaraWatchService.configure(service, watchConfig(true))
      val saved = SalcaraWatchVault.saved!!
      check(saved.getLong("expiresAt") - saved.getLong("startedAt") == SalcaraWatchRecovery.STANDBY_TTL)
      executor.next(); check(NetworkFixture.calls == 1 && !service.stopped)
    }
  }
  test("sticky process restart requires an encrypted valid checkpoint, never an idle foreground placeholder") {
    serviceFixture { service, _ ->
      check(service.onStartCommand(null, 0, 1) == android.app.Service.START_NOT_STICKY)
      check(service.stopped && !SalcaraWatchService.running)
    }
    serviceFixture { service, executor ->
      val now = System.currentTimeMillis()
      SalcaraWatchVault.saved = SalcaraWatchRecovery.create(watchConfig(), now - 1000, false, now)
      check(service.onStartCommand(null, 0, 1) == android.app.Service.START_STICKY)
      check(!service.stopped && executor.pending.size == 1)
    }
  }
  test("terminal pages drain for thirty seconds and a successful empty tail; late failure and resolution are delivered") {
    serviceFixture { service, executor ->
      service.onStartCommand(SalcaraWatchService.prepareStart(Intent()), 0, 1)
      SalcaraWatchService.configure(service, watchConfig())
      NetworkFixture.page(wire("session.updated", 1).put("session", JSONObject().put("status", "idle")))
      executor.next(); check(!drain(service).done && !service.stopped)
      NetworkFixture.page(wire("turn", 2, "completed")); executor.next()
      check(drain(service).done && !drain(service).emptyTail && !service.stopped)
      NetworkFixture.page(wire("approval.request", 3).put("approvalId", "a"))
      executor.next(); check(service.manager.records.containsKey("$serviceScope:approval:pc-a:codex:1:a" to 0))
      NetworkFixture.page(wire("turn", 4, "failed"), wire("approval.resolved", 5).put("approvalId", "a"))
      executor.next(); check(!service.manager.records.containsKey("$serviceScope:approval:pc-a:codex:1:a" to 0))
      check(service.manager.records.containsKey("$serviceScope:task:pc-a:codex:1:turn-1" to 0))
      drain(service).terminal(System.currentTimeMillis() - SalcaraWatchDrain.DRAIN_MS - 1)
      check(!service.stopped); NetworkFixture.page(); executor.next()
      check(drain(service).finished(System.currentTimeMillis()) && !service.stopped)
      executor.next(); check(service.stopped && SalcaraWatchService.status()["reason"] == "completed")
    }
  }
  test("a new parent start during terminal drain keeps that session watched") {
    serviceFixture { service, executor ->
      service.onStartCommand(SalcaraWatchService.prepareStart(Intent()), 0, 1); SalcaraWatchService.configure(service, watchConfig())
      NetworkFixture.page(wire("turn", 1, "completed")); executor.next()
      NetworkFixture.page(wire("turn", 2, "started").put("turnId", "turn-2")); executor.next()
      check(!drain(service).done && !service.stopped)
      NetworkFixture.page(); executor.next(); check(!service.stopped)
    }
  }
  test("real request construction uses only Bot token and retired scope cannot poll again") {
    serviceFixture { service, executor ->
      service.onStartCommand(SalcaraWatchService.prepareStart(Intent()), 0, 1)
      SalcaraWatchService.configure(service, watchConfig(true).put("botToken", "synthetic-bot-only"))
      executor.next(); check(NetworkFixture.headers.single()["X-Salcara-Bot-Token"] == "synthetic-bot-only")
      check(!NetworkFixture.headers.single().containsKey("X-Salcara-Pair-Token"))
      SalcaraNotificationCenter.setTargets(service, "[]"); SalcaraWatchService.targetsChanged(service)
      executor.next(); check(NetworkFixture.calls == 1 && SalcaraWatchVault.saved == null && service.stopped)
    }
  }
  test("queued stop and old deadline callbacks cannot clear a replacement watch configuration") {
    serviceFixture { service, executor ->
      service.onStartCommand(SalcaraWatchService.prepareStart(Intent()), 0, 1)
      SalcaraWatchService.configure(service, watchConfig().put("version", 1))
      val oldDeadline = android.os.Handler.delayed.last()
      service.allowed = false; android.os.Handler.holdPosts = true; executor.next()
      check(android.os.Handler.posted.size == 1)
      service.allowed = true
      SalcaraWatchService.configure(service, watchConfig().put("version", 2))
      android.os.Handler.flush(); oldDeadline.run()
      check(!service.stopped && SalcaraWatchService.running && SalcaraWatchService.config!!.getInt("version") == 2)
      service.onStartCommand(SalcaraWatchService.prepareStart(Intent()), 0, 2)
      service.onTimeout(1); check(!service.stopped && SalcaraWatchService.running)
    }
  }
  return count
}
