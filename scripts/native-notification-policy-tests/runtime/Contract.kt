package expo.modules.salcaranotify

import android.content.Context
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject

private val scope = "ns1_" + "a".repeat(64)
private val other = "ns1_" + "b".repeat(64)
private var passed = 0
private fun test(name: String, block: () -> Unit) { block(); passed++; println("PASS $name") }
internal fun reload() {
  val type = SalcaraNotificationCenter.javaClass
  fun put(name: String, value: Any?) { type.getDeclaredField(name).apply { isAccessible = true }.set(null, value) }
  put("loaded", false); put("policy", SalcaraNotificationPolicy()); put("identity", SalcaraNotificationIdentity())
  put("allowed", emptyMap<String, String>()); put("lastNormalSound", 0L); put("protectedUntil", 0L)
  (type.getDeclaredField("ordinary").apply { isAccessible = true }.get(null) as MutableMap<*, *>).clear()
  SalcaraNotificationCenter.setVisible(null, null)
}
private fun fixture(): Context {
  reload()
  val context = Context(java.nio.file.Files.createTempDirectory("salcara-notification-contract-").toFile())
  check(SalcaraNotificationCenter.setTargets(context, JSONArray().put(JSONObject().put("notificationScope", scope).put("deviceId", "pc-a")).put(JSONObject().put("notificationScope", other).put("deviceId", "pc-b")).toString()))
  return context
}
private fun payload(kind: String, turn: String = "turn-1", s: String = scope, device: String = "pc-a") = JSONObject().put("notificationScope", s).put("deviceId", device).put("sessionKey", "codex:1").put("kind", kind).put("eventTs", System.currentTimeMillis()).put("turnId", turn)
private fun id(turn: String = "turn-1", s: String = scope, device: String = "pc-a") = "$s:task:$device:codex:1:$turn"
private fun submit(context: Context, kind: String, turn: String = "turn-1") = SalcaraNotificationCenter.submit(context, id(turn), kind, "task", payload(kind, turn))
private fun event(type: String, seq: Long, status: String = "") = JSONObject().put("type", type).put("seq", seq).put("ts", System.currentTimeMillis()).put("status", status)

fun main() {
  test("JS, watch and push share durable ordinary admission") {
    val c = fixture(); check(submit(c, "reply")); check(!submit(c, "completed")); check(!submit(c, "reply"))
    check(c.manager.posts.size == 1); reload(); check(!submit(c, "completed")); check(c.manager.posts.size == 1)
  }
  test("failed upgrades once, alerts again and removes the ordinary summary") {
    val c = fixture(); check(submit(c, "reply")); check(submit(c, "failed"))
    check(c.manager.records.keys == setOf(id() to 0)); check(!c.manager.records.values.single().alertOnce)
    check(!submit(c, "completed") && !submit(c, "failed"))
  }
  test("ordinary bursts stay visible in one quiet summary; urgent does not inherit only-alert-once") {
    val c = fixture(); check(submit(c, "completed", "a")); check(submit(c, "completed", "b"))
    val digest = c.manager.records.values.single(); check(digest.channel == "quiet" && JSONObject(digest.payload!!).getInt("notificationCount") == 2)
    check(submit(c, "failed", "c")); check(c.manager.records[id("c") to 0]!!.channel == "task")
    check(submit(c, "reply", "d")); check(c.manager.records["$scope:summary" to 0]!!.channel == "quiet")
  }
  test("independent approval/question ids are revoked only by their own resolution") {
    val c = fixture(); val a = "$scope:approval:pc-a:codex:1:a"; val b = "$scope:approval:pc-a:codex:1:b"
    check(SalcaraNotificationCenter.submit(c, a, "approval", "", payload("approval").put("expiresAt", System.currentTimeMillis() + 60_000)))
    check(SalcaraNotificationCenter.submit(c, b, "question", "", payload("question")))
    check(SalcaraNotificationCenter.submit(c, a, "", "", payload("resolved")))
    check(c.manager.records.keys == setOf(b to 0)); reload()
    check(!SalcaraNotificationCenter.submit(c, a, "approval", "", payload("approval")))
  }
  test("expired requests are tombstoned while old still-pending questions are not discarded") {
    val c = fixture(); val a = "$scope:approval:pc-a:codex:1:a"
    SalcaraNotificationCenter.submit(c, a, "", "", payload("approval").put("expiresAt", System.currentTimeMillis() - 1))
    check(!SalcaraNotificationCenter.submit(c, a, "", "", payload("approval"))); check(c.manager.records.isEmpty())
    check(SalcaraNotificationCenter.submit(c, "$scope:approval:pc-a:codex:1:b", "", "", payload("question").put("eventTs", 1)))
  }
  test("viewing A does not suppress B; resolution always cancels A") {
    val c = fixture(); c.foreground = true
    val a = "$scope:approval:pc-a:codex:1:a"
    check(SalcaraNotificationCenter.submit(c, a, "", "", payload("approval")))
    SalcaraNotificationCenter.setVisible(scope, "codex:1")
    check(!submit(c, "reply"))
    check(SalcaraNotificationCenter.submit(c, id("b", other, "pc-b"), "B", "", payload("reply", "b", other, "pc-b")))
    SalcaraNotificationCenter.submit(c, a, "", "", payload("resolved")); check(!c.manager.records.containsKey(a to 0))
    SalcaraNotificationCenter.setVisible(null, null); check(!submit(c, "reply"))
  }
  test("foreground toast admission and native notifications cannot both claim the same update") {
    val c = fixture(); check(SalcaraNotificationCenter.admit(c, id(), payload("reply")))
    check(!submit(c, "completed")); check(c.manager.records.isEmpty())
    check(submit(c, "failed")); check(!SalcaraNotificationCenter.admit(c, id(), payload("failed")))
  }
  test("legacy start reply and terminal use one identity across restart") {
    val c = fixture()
    SalcaraNotificationCenter.submit(c, "", "", "", payload("started").put("event", event("turn", 10, "started")))
    check(SalcaraNotificationCenter.submit(c, "", "reply", "", payload("reply").put("event", event("message", 11).put("id", "m1").put("role", "assistant").put("final", true))))
    reload()
    check(!SalcaraNotificationCenter.submit(c, "", "done", "", payload("completed").put("event", event("turn", 12, "completed"))))
    check(c.manager.records.size == 1)
    check(SalcaraNotificationCenter.submit(c, "", "done", "", payload("completed").put("event", event("turn", 15, "completed"))))
    check(JSONObject(c.manager.records.values.single().payload!!).getInt("notificationCount") == 2)
  }
  test("foreground started admission survives process restart and cannot replay over a newer boundary") {
    val c = fixture(); val start = payload("started").put("event", event("turn", 20, "started"))
    check(!SalcaraNotificationCenter.admit(c, "", start)); reload()
    check(SalcaraNotificationCenter.submit(c, "", "done", "", payload("completed").put("event", event("turn", 21, "completed"))))
    check(c.manager.records.containsKey("$scope:summary" to 0))
    check(!SalcaraNotificationCenter.submit(c, id("legacy:20"), "done", "", payload("completed").put("turnRef", "legacy:20").put("event", event("turn", 21, "completed"))))
    check(SalcaraNotificationCenter.submit(c, "", "done", "", payload("completed").put("event", event("turn", 22, "completed"))))
    SalcaraNotificationCenter.admit(c, "", start)
    check(SalcaraNotificationCenter.submit(c, "", "done", "", payload("completed").put("event", event("turn", 23, "completed"))))
    check(JSONObject(c.manager.records.values.single().payload!!).getInt("notificationCount") == 3)
  }
  test("a second legacy final message after a start is a new ordinary result unless it replays the same message id") {
    val c = fixture(); SalcaraNotificationCenter.admit(c, "", payload("started").put("event", event("turn", 10, "started")))
    fun reply(seq: Long, message: String) = payload("reply").put("event", event("message", seq).put("id", message).put("role", "assistant").put("final", true))
    check(SalcaraNotificationCenter.submit(c, "", "", "", reply(11, "m1")))
    check(SalcaraNotificationCenter.submit(c, "", "", "", reply(12, "m2")))
    check(!SalcaraNotificationCenter.submit(c, "", "", "", reply(13, "m1")))
    check(JSONObject(c.manager.records.values.single().payload!!).getInt("notificationCount") == 2)
  }
  test("shared Hub turnRef aligns a cold push receiver with later watch metadata") {
    val c = fixture(); val ref = "legacy:10"
    check(SalcaraNotificationCenter.submit(c, id(ref), "", "", payload("reply").put("turnRef", ref).put("event", event("message", 11).put("id", "m1").put("role", "assistant").put("final", true))))
    check(!SalcaraNotificationCenter.submit(c, "", "", "", payload("completed").put("event", event("turn", 12, "completed"))))
    check(SalcaraNotificationCenter.submit(c, "", "", "", payload("reply").put("event", event("message", 15).put("id", "m2").put("role", "assistant").put("final", true))))
    check(JSONObject(c.manager.records.values.single().payload!!).getInt("notificationCount") == 2)
  }
  test("cold watch source event aliases a later Hub anchor and failure upgrades that original notification") {
    val c = fixture()
    val reply = event("message", 11).put("id", "m").put("role", "assistant").put("final", true)
    check(SalcaraNotificationCenter.submit(c, "", "", "", payload("reply").put("event", reply)))
    check(!SalcaraNotificationCenter.submit(c, id("legacy:10"), "", "", payload("reply").put("turnRef", "legacy:10").put("event", reply)))
    check(c.manager.posts.size == 1); reload()
    check(SalcaraNotificationCenter.submit(c, id("legacy:10"), "", "", payload("failed").put("turnRef", "legacy:10").put("event", event("turn", 12, "failed"))))
    check(c.manager.records.keys == setOf(id("legacy:11") to 0)); check(c.manager.posts.size == 2)
  }
  test("late failure from an old Hub anchor cannot replace a newer observed start boundary") {
    val c = fixture()
    SalcaraNotificationCenter.admit(c, "", payload("started").put("event", event("turn", 10, "started")))
    check(SalcaraNotificationCenter.submit(c, "", "", "", payload("completed").put("event", event("turn", 11, "completed"))))
    SalcaraNotificationCenter.admit(c, "", payload("started").put("event", event("turn", 20, "started")))
    check(SalcaraNotificationCenter.submit(c, id("legacy:10"), "", "", payload("failed").put("turnRef", "legacy:10").put("event", event("turn", 12, "failed"))))
    reload()
    check(SalcaraNotificationCenter.submit(c, "", "", "", payload("reply").put("event", event("message", 21).put("id", "new").put("role", "assistant").put("final", true))))
    check(c.manager.records.keys == setOf(id("legacy:10") to 0, "$scope:summary" to 0))
  }
  test("foreground failure admission removes a prior ordinary system summary") {
    val c = fixture(); check(submit(c, "reply")); check(SalcaraNotificationCenter.admit(c, id(), payload("failed"))); check(c.manager.records.isEmpty())
  }
  test("old unscoped or retired pairings cannot create notifications after restart") {
    val c = fixture(); check(submit(c, "reply")); check(SalcaraNotificationCenter.setTargets(c, "[]")); check(c.manager.records.isEmpty())
    reload(); check(!submit(c, "failed")); check(!SalcaraNotificationCenter.submit(c, id(), "", "", payload("reply").put("notificationScope", "legacy")))
  }
  test("failed target persistence fails closed instead of retaining old authorization") {
    val c = fixture(); AtomicFile.failWrites = true
    try { check(!SalcaraNotificationCenter.setTargets(c, "[]")) } finally { AtomicFile.failWrites = false }
    check(!SalcaraNotificationCenter.permits(c, scope, "pc-a")); reload(); check(!SalcaraNotificationCenter.permits(c, scope, "pc-a"))
  }
  test("a dismissed digest starts a new count without replaying consumed results") {
    val c = fixture(); check(submit(c, "reply", "a")); check(submit(c, "reply", "b"))
    c.manager.cancel("$scope:summary", 0); check(submit(c, "reply", "c"))
    check(JSONObject(c.manager.records.values.single().payload!!).getInt("notificationCount") == 1)
    check(!submit(c, "completed", "a"))
  }
  val servicePassed = serviceContracts()
  println("PASS $passed notification-center + $servicePassed real-service integration contracts (recording platform boundary)")
}
