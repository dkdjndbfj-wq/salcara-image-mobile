package expo.modules.salcaranotify

import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

private const val now = 1_800_000_000_000L
private val scopeA = "ns1_" + "a".repeat(64)
private val scopeB = "ns1_" + "b".repeat(64)
private const val task = "task:pc:hermes:task:turn-1"
private const val request = "approval:pc:hermes:task:request-1"
private var passed = 0
private fun test(name: String, block: () -> Unit) { block(); passed++; println("PASS $name") }
private fun rejects(block: () -> Unit) { var rejected = false; try { block() } catch (_: IllegalArgumentException) { rejected = true }; check(rejected) }
private fun decision(policy: SalcaraNotificationPolicy, kind: String, at: Long = now, id: String = task, scope: String = scopeA) = policy.decide(id, scope, kind, at, at)

fun main() {
  test("reply then completed and completed then reply each admit one ordinary notice") {
    for ((first, second) in listOf("reply" to "completed", "completed" to "reply")) {
      val policy = SalcaraNotificationPolicy()
      val result = decision(policy, first)!!
      check(!result.urgent && !result.upgrade && !result.stale)
      check(decision(policy, second, now + 1) == null)
    }
  }
  test("the existing wire kind done normalizes to completed") {
    val policy = SalcaraNotificationPolicy()
    check(decision(policy, "done")!!.kind == "completed")
    check(decision(policy, "reply", now + 1) == null)
    check(policy.snapshot(now + 1).entries.single().kind == "completed")
  }
  test("a failure upgrades reply or completion once and cannot be overwritten") {
    for (first in listOf("reply", "completed")) {
      val policy = SalcaraNotificationPolicy()
      decision(policy, first)
      val failed = decision(policy, "failed", now + 9000)!!
      check(failed.id == task && failed.scope == scopeA && failed.urgent && failed.upgrade)
      check(decision(policy, "failed", now + 10_000) == null)
      check(decision(policy, "reply", now + 11_000) == null)
      check(decision(policy, "completed", now + 12_000) == null)
    }
  }
  test("a failure that arrives first is urgent and not an upgrade") {
    val result = decision(SalcaraNotificationPolicy(), "failed")!!
    check(result.urgent && !result.upgrade)
  }
  test("different failed turns within eight seconds are never rate limited away") {
    val policy = SalcaraNotificationPolicy()
    check(decision(policy, "failed") != null)
    check(decision(policy, "failed", now + 1, "$task-next") != null)
  }
  test("different notification scopes with identical task ids stay isolated") {
    val policy = SalcaraNotificationPolicy()
    check(decision(policy, "completed") != null)
    val other = decision(policy, "failed", now + 1, scope = scopeB)!!
    check(other.scope == scopeB && !other.upgrade)
  }
  test("composite identity keys cannot collide at string separator boundaries") {
    val policy = SalcaraNotificationPolicy()
    check(decision(policy, "reply", id = "c", scope = "a:b") != null)
    check(decision(policy, "reply", id = "b:c", scope = "a") != null)
  }
  test("approval and question ids remain independent from the task result") {
    val policy = SalcaraNotificationPolicy()
    decision(policy, "reply")
    for (kind in listOf("approval", "question")) {
      val id = "$request-$kind"
      val result = decision(policy, kind, id = id)!!
      check(result.kind == kind && result.urgent && !result.upgrade)
      check(decision(policy, kind, now + 1, id) == null)
    }
  }
  test("even a caller identity collision cannot let a result swallow a request") {
    val policy = SalcaraNotificationPolicy()
    check(decision(policy, "completed") != null)
    check(decision(policy, "question", id = task) != null)
    check(policy.snapshot(now).entries.size == 2)
  }
  test("resolving a request suppresses replay without touching the task") {
    val policy = SalcaraNotificationPolicy()
    decision(policy, "approval", id = request)
    check(policy.resolve(request, scopeA, now + 1))
    check(decision(policy, "approval", now + 2, request) == null)
    check(decision(policy, "failed", now + 3) != null)
  }
  test("a resolution arriving before the request keeps its tombstone") {
    val policy = SalcaraNotificationPolicy()
    check(decision(policy, "resolved", id = request) == null)
    check(decision(policy, "question", now + 1, request) == null)
    check(decision(policy, "question", now + 2, "$request-new") != null)
  }
  test("an expired approval is not delivered or revived without its expiry") {
    val policy = SalcaraNotificationPolicy()
    check(policy.decide(request, scopeA, "approval", now, now - 1000, now) == null)
    check(decision(policy, "approval", now + 1, request) == null)
  }
  test("an old still-valid question remains urgent and available for a digest") {
    val result = SalcaraNotificationPolicy().decide(request, scopeA, "question", now, now - 20 * 60_000, now + 1000)!!
    check(result.urgent && result.stale && result.expiresAt == now + 1000)
  }
  test("old completed and failed results are not silently discarded") {
    for (kind in listOf("completed", "failed")) {
      val result = SalcaraNotificationPolicy().decide(task, scopeA, kind, now, now - 20 * 60_000)!!
      check(result.stale && result.urgent == (kind == "failed"))
    }
  }
  test("process noise and invalid ids do not create ledger entries") {
    val policy = SalcaraNotificationPolicy()
    for (kind in listOf("started", "interrupted", "tool", "reasoning", "other")) check(decision(policy, kind) == null)
    check(decision(policy, "failed", id = "") == null)
    check(decision(policy, "failed", id = "bad\nidentity") == null)
    check(decision(policy, "failed", id = "x".repeat(SalcaraNotificationPolicy.MAX_ID_CHARS + 1)) == null)
    check(decision(policy, "failed", scope = "") == null)
    check(decision(policy, "failed", scope = "x".repeat(SalcaraNotificationPolicy.MAX_SCOPE_CHARS + 1)) == null)
    check(policy.decide(task, scopeA, "failed", now, -1) == null)
    check(policy.decide(task, scopeA, "failed", -1, now) == null)
    check(policy.decide(request, scopeA, "question", now, now, -1) == null)
    check(policy.snapshot(now).entries.isEmpty())
  }
  test("scope cleanup does not erase another saved computer's ledger") {
    val policy = SalcaraNotificationPolicy()
    decision(policy, "failed")
    decision(policy, "failed", scope = scopeB)
    policy.clearScope(scopeA)
    check(decision(policy, "failed", now + 1) != null)
    check(decision(policy, "failed", now + 1, scope = scopeB) == null)
    policy.clear()
    check(policy.snapshot(now + 1).entries.isEmpty())
  }
  test("record retention is bounded and duplicates do not renew it") {
    val policy = SalcaraNotificationPolicy(retentionMs = 1000)
    decision(policy, "failed")
    check(decision(policy, "failed", now + 500) == null)
    check(decision(policy, "failed", now + 1001) != null)
  }
  test("capacity evicts oldest admissions and never grows past its bound") {
    val policy = SalcaraNotificationPolicy(maxEntries = 2)
    repeat(5) { check(decision(policy, "failed", now + it, "$task-$it") != null) }
    val snapshot = policy.snapshot(now + 5)
    check(snapshot.entries.map { it.id } == listOf("$task-3", "$task-4"))
    check(decision(policy, "failed", now + 6, "$task-4") == null)
  }
  test("invalid unbounded constructor options are rejected") {
    rejects { SalcaraNotificationPolicy(maxEntries = 0) }
    rejects { SalcaraNotificationPolicy(maxEntries = SalcaraNotificationPolicy.MAX_ENTRIES + 1) }
    rejects { SalcaraNotificationPolicy(retentionMs = 0) }
    rejects { SalcaraNotificationPolicy(retentionMs = SalcaraNotificationPolicy.MAX_RETENTION_MS + 1) }
  }
  test("restored ordinary result still allows one failure upgrade across channels") {
    val original = SalcaraNotificationPolicy()
    decision(original, "reply")
    val restored = SalcaraNotificationPolicy()
    check(restored.restore(original.snapshot(now), now + 1))
    check(decision(restored, "completed", now + 2) == null)
    check(decision(restored, "failed", now + 3)!!.upgrade)
    check(decision(restored, "failed", now + 4) == null)
  }
  test("restored failures and resolved requests are not notified again") {
    val original = SalcaraNotificationPolicy()
    decision(original, "failed")
    original.resolve(request, scopeA, now)
    val restored = SalcaraNotificationPolicy()
    check(restored.restore(original.snapshot(now), now + 1))
    check(decision(restored, "failed", now + 2) == null)
    check(decision(restored, "approval", now + 2, request) == null)
  }
  test("a delayed snapshot cannot erase a live failure or revive a resolved request") {
    val disk = SalcaraNotificationPolicy()
    decision(disk, "reply")
    decision(disk, "approval", id = request)
    val live = SalcaraNotificationPolicy()
    decision(live, "failed", now + 1)
    live.resolve(request, scopeA, now + 1)
    check(live.restore(disk.snapshot(now), now + 2))
    check(decision(live, "reply", now + 3) == null)
    check(decision(live, "approval", now + 3, request) == null)
    check(live.snapshot(now + 3).entries.map { it.kind }.toSet() == setOf("failed", "resolved"))
  }
  test("snapshot merge evicts old disk rows before newer live rows") {
    val disk = SalcaraNotificationPolicy()
    repeat(3) { decision(disk, "reply", now + it, "$task-disk-$it") }
    val live = SalcaraNotificationPolicy(maxEntries = 2)
    decision(live, "failed", now + 10, "$task-live")
    check(live.restore(disk.snapshot(now + 3), now + 11))
    check(live.snapshot(now + 11).entries.map { it.id } == listOf("$task-disk-2", "$task-live"))
  }
  test("old snapshot records expire instead of extending delivery dedup indefinitely") {
    val disk = SalcaraNotificationPolicy()
    decision(disk, "failed")
    val live = SalcaraNotificationPolicy(retentionMs = 1000)
    check(live.restore(disk.snapshot(now), now + 2000))
    check(live.snapshot(now + 2000).entries.isEmpty())
  }
  test("malformed and duplicate snapshot records fail without changing live state") {
    val live = SalcaraNotificationPolicy()
    decision(live, "failed")
    val good = live.snapshot(now)
    val row = good.entries.single()
    val malformed = listOf(
      good.copy(version = 2), good.copy(savedAt = -1), good.copy(savedAt = now + 61_000),
      good.copy(entries = listOf(row.copy(kind = "done"))),
      good.copy(entries = listOf(row.copy(kind = "unknown"))),
      good.copy(entries = listOf(row.copy(at = now + 1))),
      good.copy(entries = listOf(row.copy(id = "bad\nidentity"))),
      good.copy(entries = listOf(row.copy(expiresAt = now + 1000))),
      good.copy(entries = listOf(row, row)),
      good.copy(entries = List(SalcaraNotificationPolicy.MAX_ENTRIES + 1) { row.copy(id = "$task-$it") }),
    )
    for (snapshot in malformed) {
      check(!live.restore(snapshot, now))
      check(live.snapshot(now) == good)
    }
  }
  test("backward clock jumps cannot retain future-dated records indefinitely") {
    val policy = SalcaraNotificationPolicy()
    decision(policy, "failed")
    check(policy.snapshot(now - 61_000).entries.isEmpty())
  }
  test("snapshots do not alias mutable live storage") {
    val policy = SalcaraNotificationPolicy()
    decision(policy, "reply")
    val old = policy.snapshot(now)
    policy.clear()
    check(old.entries.size == 1)
    val rows = old.entries.toMutableList()
    val restored = SalcaraNotificationPolicy()
    check(restored.restore(old.copy(entries = rows), now))
    rows.clear()
    check(restored.snapshot(now).entries.size == 1)
  }
  test("concurrent push and watch admission is atomic") {
    val policy = SalcaraNotificationPolicy()
    val start = CountDownLatch(1)
    val admitted = AtomicInteger()
    val workers = List(16) { thread(start = true) { start.await(); if (decision(policy, "reply") != null) admitted.incrementAndGet() } }
    start.countDown(); workers.forEach { it.join() }
    check(admitted.get() == 1)
    val upgrades = AtomicInteger()
    val failures = List(16) { thread(start = true) { if (decision(policy, "failed", now + 1) != null) upgrades.incrementAndGet() } }
    failures.forEach { it.join() }
    check(upgrades.get() == 1)
  }
  println("PASS $passed native notification policy contracts")
}
