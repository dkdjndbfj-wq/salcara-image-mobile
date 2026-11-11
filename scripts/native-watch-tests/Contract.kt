package expo.modules.salcaranotify

import org.json.JSONArray
import org.json.JSONObject
import javax.crypto.KeyGenerator

private val now = 1_800_000_000_000L
private fun config(standby: Boolean = false) = JSONObject().put("follow", true).put("version", 1)
  .put("hubUrl", "https://hub.example.test/salcara-hub/v1").put("pairToken", "synthetic-credential")
  .put("navigationScope", "ns1_" + "a".repeat(64)).put("standby", standby)
  .put("devices", JSONArray().put(JSONObject().put("deviceId", "pc-1").put("after", 12)))
  .put("sessions", JSONArray().put(JSONObject().put("deviceId", "pc-1").put("sessionKey", "codex:1").put("after", 14)))

private var count = 0
private fun test(name: String, block: () -> Unit) { block(); count++; println("PASS $name") }
private fun rejects(block: () -> Unit) { var rejected = false; try { block() } catch (_: Exception) { rejected = true }; check(rejected) }

fun main() {
  test("a task restart keeps its original deadline and event cursor") {
    val snapshot = SalcaraWatchRecovery.create(config(), now - 60_000, false, now)!!
    check(snapshot.getLong("expiresAt") == now - 60_000 + SalcaraWatchRecovery.TASK_TTL)
    val restored = SalcaraWatchRecovery.validate(JSONObject(snapshot.toString()), now + 60_000)!!
    check(restored.getJSONObject("config").getJSONArray("sessions").getJSONObject(0).getLong("after") == 14L)
    check(restored.getLong("startedAt") == now - 60_000)
  }
  test("expired task credentials cannot be revived by a process restart") {
    val snapshot = SalcaraWatchRecovery.create(config(), now, false, now)!!
    check(SalcaraWatchRecovery.validate(snapshot, now + SalcaraWatchRecovery.TASK_TTL) == null)
  }
  test("standby keeps a bounded seven-day restart lease") {
    val snapshot = SalcaraWatchRecovery.create(config(true), now, true, now)!!
    check(SalcaraWatchRecovery.validate(snapshot, now + SalcaraWatchRecovery.STANDBY_TTL - 1) != null)
    check(SalcaraWatchRecovery.validate(snapshot, now + SalcaraWatchRecovery.STANDBY_TTL) == null)
  }
  test("foreground pause and missing credentials cannot create restart work") {
    check(SalcaraWatchRecovery.create(config().put("follow", false), now, false, now) == null)
    check(SalcaraWatchRecovery.create(config().put("pairToken", ""), now, false, now) == null)
  }
  test("clock rollback and inflated deadlines fail closed") {
    val snapshot = SalcaraWatchRecovery.create(config(), now, false, now)!!
    check(SalcaraWatchRecovery.validate(snapshot, now - 61_000) == null)
    snapshot.put("expiresAt", now + SalcaraWatchRecovery.STANDBY_TTL)
    check(SalcaraWatchRecovery.validate(snapshot, now) == null)
  }
  test("standby mode cannot extend a task checkpoint by changing one flag") {
    val snapshot = SalcaraWatchRecovery.create(config(), now, false, now)!!
    snapshot.put("standby", true)
    check(SalcaraWatchRecovery.validate(snapshot, now) == null)
  }
  test("invalid URL and pairing scopes never produce a recovery checkpoint") {
    listOf("file:///tmp/secret", "https://user:pass@hub.test", "https://hub.test?token=secret", "https://hub.test#fragment").forEach {
      check(!SalcaraWatchRecovery.validConfig(config().put("hubUrl", it)))
    }
    check(!SalcaraWatchRecovery.validConfig(config().put("navigationScope", "legacy")))
    check(!SalcaraWatchRecovery.validConfig(config().put("pairToken", "bad\r\nheader")))
  }
  test("unbounded sessions and oversized content cannot be restored") {
    val sessions = JSONArray(); repeat(17) { sessions.put(JSONObject().put("deviceId", "pc-$it").put("sessionKey", "s")) }
    check(!SalcaraWatchRecovery.validConfig(config().put("sessions", sessions)))
    check(!SalcaraWatchRecovery.validConfig(config().put("padding", "x".repeat(SalcaraWatchRecovery.MAX_BYTES))))
    check(!SalcaraWatchRecovery.validConfig(config().put("sessions", JSONArray())))
  }
  test("malformed or negative event cursors are rejected") {
    val value = config()
    value.getJSONArray("sessions").getJSONObject(0).put("after", -1)
    check(!SalcaraWatchRecovery.validConfig(value))
    value.getJSONArray("sessions").getJSONObject(0).put("after", 0).put("sessionKey", "bad|scope")
    check(!SalcaraWatchRecovery.validConfig(value))
  }
  test("new pairing with the same device ID never inherits the old pairing cursor") {
    val a = config(true)
    val b = config(true).put("navigationScope", "ns1_" + "b".repeat(64)).put("pairToken", "synthetic-new-pairing")
    b.getJSONArray("devices").getJSONObject(0).put("after", 0)
    val stale = SalcaraWatchRecovery.checkpointConfig(b, a, mapOf("pc-1" to 1000))
    val restored = SalcaraWatchRecovery.create(stale, now, true, now)!!.getJSONObject("config")
    check(restored.getJSONArray("devices").getJSONObject(0).getLong("after") == 0L)
    check(restored.getString("pairToken") == "synthetic-new-pairing")
    check(a.getJSONArray("devices").getJSONObject(0).getLong("after") == 12L)
    val owned = SalcaraWatchRecovery.checkpointConfig(b, b, mapOf("pc-1" to 19))
    check(owned.getJSONArray("devices").getJSONObject(0).getLong("after") == 19L)
    check(b.getJSONArray("devices").getJSONObject(0).getLong("after") == 0L)
    check(SalcaraWatchRecovery.checkpointConfig(b).getJSONArray("devices").getJSONObject(0).getLong("after") == 0L)
  }
  val envelope = JSONObject().put("signed_payload", "cHJlc2VydmVkLXNpZ25lZC1wYXlsb2Fk").put("signature", "s".repeat(88))
  test("verified ingress replacement preserves progressed cursors, credentials and original lease") {
    val current = config()
    val stored = SalcaraWatchRecovery.create(current, now - 60_000, false, now)!!
    stored.getJSONObject("config").getJSONArray("sessions").getJSONObject(0).put("after", 999)
    val merged = SalcaraWatchRecovery.withIngressManifest(stored, current, current, envelope, now)!!
    check(merged.getLong("startedAt") == stored.getLong("startedAt") && merged.getLong("expiresAt") == stored.getLong("expiresAt"))
    check(merged.getJSONObject("config").getJSONArray("sessions").getJSONObject(0).getLong("after") == 999L)
    check(merged.getJSONObject("config").getString("pairToken") == current.getString("pairToken"))
    check(merged.getJSONObject("config").getJSONObject("ingressManifest").toString() == envelope.toString())
    check(!stored.getJSONObject("config").has("ingressManifest") && !current.has("ingressManifest"))
  }
  test("late ingress replacement cannot cross config ownership, credential or scope boundaries") {
    val current = config(); val stored = SalcaraWatchRecovery.create(current, now, false, now)!!
    check(SalcaraWatchRecovery.withIngressManifest(stored, current, config(), envelope, now) == null)
    for ((field, value) in listOf("navigationScope" to "ns1_" + "b".repeat(64), "pairToken" to "replacement", "hubUrl" to "https://other.test/v1", "key" to "new-key")) {
      val next = JSONObject(current.toString()).put(field, value)
      check(SalcaraWatchRecovery.withIngressManifest(stored, next, next, envelope, now) == null)
    }
    check(SalcaraWatchRecovery.withIngressManifest(stored, current, current, envelope, now + SalcaraWatchRecovery.TASK_TTL) == null)
  }
  test("public ingress handoff exposes only namespace and original envelope fields") {
    val current = config().put("ingressManifest", JSONObject(envelope.toString()).put("pairToken", "must-not-export"))
    val exported = SalcaraWatchRecovery.publicIngressInfo(current)!!
    check(exported.keySet() == setOf("hubUrl", "navigationScope", "manifest"))
    check(exported.getJSONObject("manifest").keySet() == setOf("signed_payload", "signature"))
    check(!exported.toString().contains("synthetic-credential") && !exported.toString().contains("must-not-export"))
    check(exported.getJSONObject("manifest").getString("signed_payload") == envelope.getString("signed_payload"))
    check(SalcaraWatchRecovery.publicIngressInfo(current.put("follow", false)) == null)
  }
  test("native task agent labels recognize advertised DeepSeek and Hermes without inventing capabilities") {
    check(SalcaraWatchRecovery.agentDisplayName("deepseek-harness") == "DeepSeek Harness")
    check(SalcaraWatchRecovery.agentDisplayName("hermes") == "Hermes Agent")
    check(SalcaraWatchRecovery.agentDisplayName("deepseek") == "Agent")
    check(SalcaraWatchRecovery.agentDisplayName("codex") == "Codex")
    check(SalcaraWatchRecovery.agentDisplayName("claude") == "Claude Code")
    check(SalcaraWatchRecovery.agentDisplayName("new-tool") == "Agent")
  }
  val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
  val plaintext = SalcaraWatchRecovery.create(config(), now, false, now)!!.toString().toByteArray()
  test("device-key encryption round trips without readable credentials") {
    val encrypted = SalcaraWatchCipher.encrypt(plaintext, key)
    check(!String(encrypted).contains("synthetic-credential"))
    check(SalcaraWatchCipher.decrypt(encrypted, key).contentEquals(plaintext))
    check(!encrypted.contentEquals(SalcaraWatchCipher.encrypt(plaintext, key)))
  }
  test("tampering, truncation, wrong keys and format changes are rejected") {
    val encrypted = SalcaraWatchCipher.encrypt(plaintext, key)
    val tampered = encrypted.copyOf().apply { this[lastIndex] = (this[lastIndex].toInt() xor 1).toByte() }
    rejects { SalcaraWatchCipher.decrypt(tampered, key) }
    rejects { SalcaraWatchCipher.decrypt(encrypted.copyOf(20), key) }
    rejects { SalcaraWatchCipher.decrypt(encrypted.copyOf().apply { this[0] = 2 }, key) }
    val otherKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    rejects { SalcaraWatchCipher.decrypt(encrypted, otherKey) }
  }
  println("$count native watch recovery checks passed")
}
