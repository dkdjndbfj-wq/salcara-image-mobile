package expo.modules.salcaranotify

import android.content.Intent
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLStreamHandler
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.Signature
import java.util.Base64
import java.util.concurrent.Delayed
import java.util.concurrent.FutureTask
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit

private val serviceScope = "ns1_" + "a".repeat(64)
private const val botUrl = "https://fixture.invalid/v1"
private val botKeyA = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
private val botKeyB = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
private fun serviceBotPin(key: KeyPair = botKeyA) = JSONObject().put("instanceId", "a".repeat(32))
  .put("publicKey", Base64.getEncoder().encodeToString(key.public.encoded.takeLast(32).toByteArray()))
private fun sign(key: KeyPair, value: ByteArray): String = Base64.getEncoder().encodeToString(Signature.getInstance("Ed25519").run { initSign(key.private); update(value); sign() })
private fun serviceManifest(key: KeyPair = botKeyA, signed: Boolean = true): JSONObject {
  val now = System.currentTimeMillis()
  val value = JSONObject().put("version", 1).put("hub_instance_id", "a".repeat(32)).put("identity_public_key", serviceBotPin(key).getString("publicKey"))
    .put("canonical_url", botUrl).put("revision", 1).put("issued_at", now - 1000).put("expires_at", now + 60_000)
    .put("endpoints", JSONArray().put(JSONObject().put("id", "canonical").put("url", botUrl).put("priority", 0)))
  if (!signed) return value
  val payload = value.toString().toByteArray()
  return JSONObject().put("signed_payload", Base64.getEncoder().encodeToString(payload)).put("signature", sign(key, "salcara-ingress-manifest-v1\n".toByteArray() + payload))
}
private fun serviceProof(url: URL, key: KeyPair): JSONObject {
  val nonce = url.toString().substringAfter("nonce="); val issued = System.currentTimeMillis(); val expires = issued + 30_000
  return JSONObject().put("version", 1).put("hub_instance_id", "a".repeat(32)).put("nonce", nonce).put("issued_at", issued).put("expires_at", expires)
    .put("signature", sign(key, "salcara-ingress-proof-v1\n${"a".repeat(32)}\n$nonce\n$issued\n$expires".toByteArray()))
}
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
  var serviceKey = botKeyA
  var manifestMode = "signed"
  var beforeEvents: (() -> Unit)? = null
  val publicHeaders = mutableListOf<Map<String, String>>()
  fun install() {
    URL.setURLStreamHandlerFactory { protocol -> if (protocol !in listOf("https", "http")) null else object : URLStreamHandler() {
      override fun openConnection(url: URL): HttpURLConnection {
        if (url.path.endsWith("/app/events")) beforeEvents?.invoke()
        return object : HttpURLConnection(url) {
        private val sent = LinkedHashMap<String, String>()
        private var body = ""
        override fun setRequestProperty(key: String, value: String) { sent[key] = value }
        override fun getResponseCode(): Int {
          if (url.path.contains("/ingress/")) {
            publicHeaders.add(sent.toMap()); check(sent.keys.all { it == "Accept" })
            if (manifestMode == "missing") return 404
            body = if (url.path.endsWith("/manifest")) serviceManifest(serviceKey, manifestMode != "unsigned").toString() else serviceProof(url, serviceKey).toString()
          } else { calls++; headers.add(sent.toMap()); body = if (pages.isEmpty()) "{\"events\":[]}" else pages.removeFirst() }
          return 200
        }
        override fun getContentLengthLong() = body.toByteArray().size.toLong()
        override fun getInputStream() = body.byteInputStream()
        override fun connect() { }; override fun disconnect() { }; override fun usingProxy() = false
      }
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
private fun botWatchConfig(standby: Boolean = false) = watchConfig(standby).put("hubUrl", botUrl)
  .put("botToken", "synthetic-bot-only").put("botPin", serviceBotPin())
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
  NetworkFixture.publicHeaders.clear(); NetworkFixture.serviceKey = botKeyA; NetworkFixture.manifestMode = "signed"; NetworkFixture.beforeEvents = null
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
      SalcaraWatchService.configure(service, botWatchConfig(true))
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
  test("cold Bot handoff rejects a self-consistent replacement identity before any credential reaches HTTP") {
    serviceFixture { service, executor ->
      NetworkFixture.serviceKey = botKeyB
      service.onStartCommand(SalcaraWatchService.prepareStart(Intent()), 0, 1)
      SalcaraWatchService.configure(service, botWatchConfig(true)); executor.next()
      check(NetworkFixture.calls == 0 && NetworkFixture.headers.isEmpty() && NetworkFixture.publicHeaders.isNotEmpty())
      check(SalcaraWatchService.status()["reason"] == "identity")
      check(service.manager.records["$serviceScope:watch-status" to 0]?.body?.contains("身份") == true)
    }
  }
  for (mode in listOf("missing", "unsigned")) test("Bot $mode manifest cannot use legacy URL fallback") {
    serviceFixture { service, executor ->
      NetworkFixture.manifestMode = mode
      service.onStartCommand(SalcaraWatchService.prepareStart(Intent()), 0, 1)
      SalcaraWatchService.configure(service, botWatchConfig(true)); executor.next()
      check(NetworkFixture.calls == 0 && SalcaraWatchService.status()["reason"] == "identity")
    }
  }
  test("foreground pause followed by cold handoff does not adopt another identity") {
    serviceFixture { service, executor ->
      service.onStartCommand(SalcaraWatchService.prepareStart(Intent()), 0, 1)
      SalcaraWatchService.configure(service, botWatchConfig(true)); executor.next(); check(NetworkFixture.calls == 1)
      SalcaraWatchService.configure(service, JSONObject().put("follow", false))
      NetworkFixture.serviceKey = botKeyB
      SalcaraWatchService.configure(service, botWatchConfig(true))
      executor.next(); executor.next() // One old queued step, then the new owner.
      check(NetworkFixture.calls == 1 && SalcaraWatchService.status()["reason"] == "identity")
    }
  }
  test("cold checkpoint recovery checks its original Bot pin even when a new server is self-signed") {
    serviceFixture { service, executor ->
      val now = System.currentTimeMillis()
      val saved = SalcaraWatchRecovery.create(botWatchConfig(true).put("ingressManifest", serviceManifest()), now, true, now)!!
      val encryptionKey = javax.crypto.KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
      val encrypted = SalcaraWatchCipher.encrypt(saved.toString().toByteArray(), encryptionKey)
      SalcaraWatchVault.saved = JSONObject(String(SalcaraWatchCipher.decrypt(encrypted, encryptionKey)))
      NetworkFixture.serviceKey = botKeyB
      check(service.onStartCommand(null, 0, 1) == android.app.Service.START_STICKY); executor.next()
      check(NetworkFixture.calls == 0 && SalcaraWatchService.status()["reason"] == "identity")
    }
  }
  test("an identity-blocked Bot does not stop a healthy Pair or repeatedly alert") {
    serviceFixture { service, executor ->
      val otherScope = "ns1_" + "b".repeat(64)
      SalcaraNotificationCenter.setTargets(service, JSONArray().put(JSONObject().put("notificationScope", serviceScope).put("deviceId", "pc-a"))
        .put(JSONObject().put("notificationScope", otherScope).put("deviceId", "pc-b")).toString())
      NetworkFixture.serviceKey = botKeyB
      service.onStartCommand(SalcaraWatchService.prepareStart(Intent().putExtra("standby", true)), 0, 1)
      SalcaraWatchService.configure(service, JSONObject().put("schema", 2).put("follow", true).put("standby", true)
        .put("connections", JSONArray().put(botWatchConfig(true)).put(watchConfig(true, otherScope, "pc-b"))))
      executor.next(); val alerts = service.manager.posts.count { it.tag == "$serviceScope:watch-status" }
      executor.next(); executor.next()
      check(NetworkFixture.calls == 2 && NetworkFixture.headers.all { !it.containsKey("X-Salcara-Bot-Token") })
      check(!service.stopped && alerts == 1 && service.manager.posts.count { it.tag == "$serviceScope:watch-status" } == alerts)
      val rows = SalcaraWatchService.status()["connections"] as List<*>
      check(rows.any { (it as Map<*, *>)["reason"] == "identity" })
    }
  }
  test("a proof lease expiring during preparation cannot send the Bot credential") {
    serviceFixture { service, executor ->
      var now = System.currentTimeMillis()
      service.onStartCommand(SalcaraWatchService.prepareStart(Intent()), 0, 1)
      SalcaraWatchService.configure(service, botWatchConfig(true))
      val owned = state(service)
      owned.javaClass.getDeclaredField("ingress").apply { isAccessible = true }.set(owned, SalcaraIngressRouter(clock = { now }))
      NetworkFixture.beforeEvents = { now += 11_000 }
      executor.next()
      check(NetworkFixture.calls == 0 && NetworkFixture.headers.isEmpty() && !service.stopped)
      check((SalcaraWatchService.status()["connections"] as List<*>).any { (it as Map<*, *>)["reason"] == "connection" })
    }
  }
  test("replacement configuration during preparation prevents the old Bot HTTP dispatch") {
    serviceFixture { service, executor ->
      service.onStartCommand(SalcaraWatchService.prepareStart(Intent()), 0, 1)
      SalcaraWatchService.configure(service, botWatchConfig(true))
      NetworkFixture.beforeEvents = {
        NetworkFixture.beforeEvents = null
        SalcaraWatchService.configure(service, watchConfig(true))
      }
      executor.next(); check(NetworkFixture.calls == 0)
      executor.next()
      check(NetworkFixture.calls == 1 && NetworkFixture.headers.single().keys == setOf("Accept", "X-Salcara-Pair-Token"))
      check(!service.stopped)
    }
  }
  test("legacy Bot configuration never silently enrolls or emits its credential") {
    serviceFixture { service, _ ->
      service.onStartCommand(SalcaraWatchService.prepareStart(Intent()), 0, 1)
      val legacy = botWatchConfig(true).also { it.remove("botPin") }
      SalcaraWatchService.configure(service, legacy)
      check(NetworkFixture.calls == 0 && SalcaraWatchService.status()["reason"] == "identity")
      check(legacy.getString("botToken") == "synthetic-bot-only")
    }
  }
  test("legacy unpinned Bot checkpoint stays closed with an explicit identity status") {
    serviceFixture { service, _ ->
      val now = System.currentTimeMillis()
      val old = SalcaraWatchRecovery.create(watchConfig(true), now, true, now)!!
      old.getJSONObject("config").put("botToken", "synthetic-bot-only")
      SalcaraWatchVault.saved = old
      check(service.onStartCommand(null, 0, 1) == android.app.Service.START_NOT_STICKY)
      check(NetworkFixture.calls == 0 && SalcaraWatchService.status()["reason"] == "identity")
    }
  }
  test("restored identity retirement is not renamed authorization or successful completion") {
    serviceFixture { service, _ ->
      val now = System.currentTimeMillis()
      SalcaraWatchVault.saved = SalcaraWatchRecovery.create(botWatchConfig(true).put("retiredReason", "identity"), now, true, now)
      service.onStartCommand(null, 0, 1)
      check(NetworkFixture.calls == 0 && SalcaraWatchService.status()["reason"] == "identity")
    }
  }
  for (cold in listOf(false, true)) test("mixed legacy Bot isolation keeps healthy Pair notifications alive (cold=$cold)") {
    serviceFixture { service, executor ->
      val otherScope = "ns1_" + "b".repeat(64)
      SalcaraNotificationCenter.setTargets(service, JSONArray().put(JSONObject().put("notificationScope", serviceScope).put("deviceId", "pc-a"))
        .put(JSONObject().put("notificationScope", otherScope).put("deviceId", "pc-b")).toString())
      val bot = botWatchConfig(true)
      val multi = JSONObject().put("schema", 2).put("follow", true).put("standby", true)
        .put("connections", JSONArray().put(bot).put(watchConfig(true, otherScope, "pc-b")))
      if (cold) {
        val now = System.currentTimeMillis(); val old = SalcaraWatchRecovery.create(multi, now - 1000, true, now)!!
        SalcaraWatchRecovery.connections(old.getJSONObject("config")).first().remove("botPin")
        SalcaraWatchVault.saved = old
        check(service.onStartCommand(null, 0, 1) == android.app.Service.START_STICKY)
        check(SalcaraWatchVault.saved!!.getLong("expiresAt") == old.getLong("expiresAt"))
      } else {
        bot.remove("botPin")
        service.onStartCommand(SalcaraWatchService.prepareStart(Intent().putExtra("standby", true)), 0, 1)
        SalcaraWatchService.configure(service, multi)
      }
      executor.next(); executor.next()
      check(!service.stopped && NetworkFixture.calls == 2 && NetworkFixture.headers.none { it.containsKey("X-Salcara-Bot-Token") })
      check(SalcaraWatchVault.saved?.toString()?.contains("synthetic-bot-only") == false)
      check((SalcaraWatchService.status()["connections"] as List<*>).any { (it as Map<*, *>)["notificationScope"] == serviceScope && it["reason"] == "identity" })
      check(service.manager.posts.count { it.tag == "$serviceScope:watch-status" } == 1)
    }
  }
  return count
}
