package expo.modules.salcaranotify

import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.CookieHandler
import java.net.CookieManager
import java.net.URL
import java.net.URLStreamHandler
import java.security.KeyPairGenerator
import java.security.KeyPair
import java.security.Signature
import java.util.Base64
import java.util.concurrent.CancellationException

/** Standalone JVM checks compile the production router with real Tink verification. */
private const val canonical = "https://hub.example/salcara-hub/v1"
private const val backup = "https://entry.example/salcara-hub/v1"
private const val migrated = "https://new.example/salcara-hub/v1"
private val key = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
private val hubId = "a".repeat(32)
private val publicKey = Base64.getEncoder().encodeToString(key.public.encoded.takeLast(32).toByteArray())
private val otherKey = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
private val otherId = "b".repeat(32)
private val otherPublicKey = Base64.getEncoder().encodeToString(otherKey.public.encoded.takeLast(32).toByteArray())
private fun botPin() = JSONObject().put("instanceId", hubId).put("publicKey", publicKey)
private fun otherBotPin() = JSONObject().put("instanceId", otherId).put("publicKey", otherPublicKey)
private val calls = mutableListOf<String>()
private var response: (String) -> Pair<Int, String> = { throw IOException("offline") }
private val scope = "ns1_" + "a".repeat(64)
private fun watchConfig(envelope: JSONObject) = JSONObject().put("follow", true).put("hubUrl", canonical)
  .put("navigationScope", scope).put("pairToken", "synthetic-private-token").put("key", "synthetic-private-key")
  .put("ingressManifest", envelope).put("standby", false)
  .put("sessions", JSONArray().put(JSONObject().put("deviceId", "pc-1").put("sessionKey", "codex:1").put("after", 12)))

private fun manifest(expires: Long = System.currentTimeMillis() + 86_400_000, revision: Long = 3, logical: String = canonical, entries: List<String> = listOf(canonical, backup)): JSONObject = JSONObject()
  .put("version", 1).put("hub_instance_id", hubId).put("identity_public_key", publicKey).put("canonical_url", logical)
  .put("revision", revision).put("issued_at", expires - 86_400_000).put("expires_at", expires)
  .put("endpoints", JSONArray().also { rows -> entries.forEachIndexed { index, url -> rows.put(JSONObject()
    .put("id", if (url == logical) "canonical" else "entry-$index").put("url", url).put("priority", if (url == logical) 100 else 50)) } })

private fun signed(value: JSONObject, signingKey: KeyPair = key): JSONObject {
  val payload = value.toString().toByteArray(Charsets.UTF_8)
  val signer = Signature.getInstance("Ed25519").apply { initSign(signingKey.private); update("salcara-ingress-manifest-v1\n".toByteArray() + payload) }
  return JSONObject().put("signed_payload", Base64.getEncoder().encodeToString(payload)).put("signature", Base64.getEncoder().encodeToString(signer.sign()))
}

private fun proof(url: String, wrongNonce: Boolean = false, stale: Boolean = false, forged: Boolean = false, now: Long = System.currentTimeMillis(), identity: String = hubId, signingKey: KeyPair = key): JSONObject {
  val nonce = if (wrongNonce) "f".repeat(64) else url.substringAfter("nonce=")
  val issued = now - if (stale) 90_000 else 0
  val expires = issued + 30_000
  val signer = Signature.getInstance("Ed25519").apply { initSign(signingKey.private); update("salcara-ingress-proof-v1\n$identity\n$nonce\n$issued\n$expires".toByteArray()) }
  val signature = if (forged) ByteArray(64) else signer.sign()
  return JSONObject().put("version", 1).put("hub_instance_id", identity).put("nonce", nonce)
    .put("issued_at", issued).put("expires_at", expires).put("signature", Base64.getEncoder().encodeToString(signature))
}

private fun blocked(action: () -> Unit) {
  var rejected = false
  try { action() } catch (_: IllegalArgumentException) { rejected = true } catch (_: IllegalStateException) { rejected = true }
  check(rejected) { "Pinned authority must not fall back to an unverified credential destination" }
}

private fun identityBlocked(action: () -> Unit) {
  var rejected = false
  try { action() } catch (_: SalcaraBotIdentityUnavailable) { rejected = true }
  check(rejected) { "Bot identity failure must be explicit and cannot become a legacy fallback" }
}

private fun temporarilyUnavailable(action: () -> Unit) {
  var rejected = false
  try { action() } catch (_: SalcaraIngressUnavailable) { rejected = true }
  check(rejected) { "Expired verification or transport loss must remain retryable" }
}

fun main() {
  URL.setURLStreamHandlerFactory { protocol -> if (protocol != "https") null else object : URLStreamHandler() {
    override fun openConnection(url: URL): HttpURLConnection = object : HttpURLConnection(url) {
      private var body = ""
      override fun connect() { }
      override fun disconnect() { }
      override fun usingProxy() = false
      override fun getResponseCode(): Int {
        check(!instanceFollowRedirects && !useCaches && connectTimeout in 1..1250 && readTimeout in 1..1250)
        check(requestProperties.keys.all { it == "Accept" }) { "Anonymous discovery must carry no credentials" }
        calls.add(url.toString())
        val result = response(url.toString()); body = result.second; return result.first
      }
      override fun getContentLengthLong() = body.toByteArray().size.toLong()
      override fun getInputStream() = ByteArrayInputStream(body.toByteArray())
    }
  } }

  var passed = 0
  fun test(name: String, run: () -> Unit) { calls.clear(); run(); passed++; println("PASS $name") }
  fun network(m: JSONObject, bad: ((String) -> JSONObject)? = null) {
    response = { url -> when {
      url.endsWith("/ingress/manifest") -> 200 to m.toString()
      url.contains("/ingress/identity?") -> 200 to (bad?.invoke(url) ?: proof(url)).toString()
      else -> error("unexpected URL: $url")
    } }
  }

  test("signed fallback proves identity and reuses only a short proof lease") {
    val m = signed(manifest()); network(m); val router = SalcaraIngressRouter()
    check(router.resolve(canonical, m, "scope-A") { true } == backup)
    val first = calls.size
    check(router.resolve(canonical, m, "scope-A") { true } == backup && calls.size == first)
    check(calls.size == 3 && calls.last().startsWith("$backup/ingress/identity?"))
  }
  test("failed endpoint invalidates its proof lease and verifies the other member") {
    val m = signed(manifest()); network(m); val router = SalcaraIngressRouter()
    check(router.resolve(canonical, m) { true } == backup); router.fail(backup)
    check(router.resolve(canonical, m) { true } == canonical)
    check(calls.last().startsWith("$canonical/ingress/identity?"))
  }
  for (bad in listOf("signature", "nonce", "expiry")) test("invalid $bad proof stays closed on every endpoint") {
    val m = signed(manifest()); network(m) { proof(it, forged = bad == "signature", wrongNonce = bad == "nonce", stale = bad == "expiry") }
    blocked { SalcaraIngressRouter().resolve(canonical, m) { true } }
  }
  test("expired signed cache is only anonymous discovery and cannot authorize any endpoint") {
    val m = signed(manifest(System.currentTimeMillis() - 1)); response = { throw IOException("offline") }
    blocked { SalcaraIngressRouter().resolve(canonical, m) { true } }
    check(calls == listOf("$canonical/ingress/manifest", "$backup/ingress/manifest"))
  }
  test("expired signed cache recovers through a fresh same-pin backup manifest") {
    val old = signed(manifest(System.currentTimeMillis() - 1)); val fresh = signed(manifest(revision = 4))
    response = { url -> when {
      url == "$canonical/ingress/manifest" -> throw IOException("old domain offline")
      url == "$backup/ingress/manifest" -> 200 to fresh.toString()
      url.startsWith("$backup/ingress/identity?") -> 200 to proof(url).toString()
      else -> error("unexpected URL: $url")
    } }
    check(SalcaraIngressRouter().resolve(canonical, old, "unchanged-history-scope") { true } == backup)
    check(calls.size == 3)
  }
  test("migration keeps the logical anchor even when neither old endpoint is a new member") {
    val old = signed(manifest(System.currentTimeMillis() - 1))
    val next = signed(manifest(revision = 4, logical = migrated, entries = listOf(migrated)))
    response = { url -> when {
      url == "$canonical/ingress/manifest" -> throw IOException("old domain offline")
      url == "$backup/ingress/manifest" -> 200 to next.toString()
      url.startsWith("$migrated/ingress/identity?") -> 200 to proof(url).toString()
      else -> error("unexpected URL: $url")
    } }
    val router = SalcaraIngressRouter()
    check(router.resolve(canonical, old, "fixed-credential-scope") { true } == migrated)
    check(router.resolve(canonical, old, "fixed-credential-scope") { true } == migrated && calls.size == 3)
  }
  test("changed identity at one candidate cannot block another same-pin recovery") {
    val old = signed(manifest(System.currentTimeMillis() - 1))
    val changed = signed(manifest(revision = 4).put("hub_instance_id", "f".repeat(32)))
    val fresh = signed(manifest(revision = 4))
    response = { url -> when {
      url == "$canonical/ingress/manifest" -> 200 to changed.toString()
      url == "$backup/ingress/manifest" -> 200 to fresh.toString()
      else -> 200 to proof(url).toString()
    } }
    check(SalcaraIngressRouter().resolve(canonical, old) { true } == backup)
    check(calls[1] == "$backup/ingress/manifest")
  }
  test("replaced instance cannot receive credentials when no matching authority survives") {
    val old = signed(manifest(System.currentTimeMillis() - 1))
    network(signed(manifest(revision = 4).put("hub_instance_id", "f".repeat(32))))
    blocked { SalcaraIngressRouter().resolve(canonical, old) { true } }
    check(calls.size == 2 && calls.all { it.endsWith("/manifest") })
  }
  test("a fresh lower revision cannot replace expired pinned authority") {
    val old = signed(manifest(System.currentTimeMillis() - 1)); network(signed(manifest(revision = 2)))
    blocked { SalcaraIngressRouter().resolve(canonical, old) { true } }
    check(calls.all { it.endsWith("/manifest") })
  }
  test("unsigned refresh cannot downgrade signed authority") {
    val old = signed(manifest(System.currentTimeMillis() - 1)); network(manifest(revision = 4))
    blocked { SalcaraIngressRouter().resolve(canonical, old) { true } }
  }
  test("an unsigned legacy manifest does not authorize alternate endpoints") {
    val m = manifest(); network(m)
    check(SalcaraIngressRouter().resolve(canonical, m) { true } == canonical)
    check(calls.none { it.startsWith(backup) })
  }
  test("a legacy Hub without ingress retains only its exact user-selected URL") {
    response = { 404 to "{}" }
    check(SalcaraIngressRouter().resolve(canonical, null) { true } == canonical)
    check(calls == listOf("$canonical/ingress/manifest"))
  }
  test("redirected discovery and proof are never accepted or followed") {
    val m = signed(manifest()); response = { 302 to "" }
    blocked { SalcaraIngressRouter().resolve(canonical, m) { true } }
    check(calls.all { it.startsWith(canonical) || it.startsWith(backup) })
    check(calls.count { it.endsWith("/manifest") } == 2)
  }
  test("oversized refresh cannot discard an expired pin") {
    val old = signed(manifest(System.currentTimeMillis() - 1)); response = { 200 to "x".repeat(16_385) }
    blocked { SalcaraIngressRouter().resolve(canonical, old) { true } }
    check(calls.size == 2)
  }
  for (invalid in listOf("https://127.0.0.1/salcara-hub/v1", "http://entry.example/salcara-hub/v1")) test("unsafe signed-cache endpoint is rejected: $invalid") {
    val bad = signed(manifest(entries = listOf(canonical, invalid)))
    response = { throw IOException("offline") }
    blocked { SalcaraIngressRouter().resolve(canonical, bad) { true } }
    check(calls.isEmpty())
  }
  test("corrupt saved signature cannot silently disable pinned routing") {
    val bad = signed(manifest()).put("signature", Base64.getEncoder().encodeToString(ByteArray(64)))
    response = { throw IOException("offline") }
    blocked { SalcaraIngressRouter().resolve(canonical, bad) { true } }
    check(calls.isEmpty())
  }
  test("anonymous discovery cannot use process-wide cookies") {
    val previous = CookieHandler.getDefault()
    val old = signed(manifest(System.currentTimeMillis() - 1))
    try {
      CookieHandler.setDefault(CookieManager())
      blocked { SalcaraIngressRouter().resolve(canonical, old) { true } }
      check(calls.isEmpty())
    } finally { CookieHandler.setDefault(previous) }
  }
  test("canceled configuration performs no network request") {
    var canceled = false
    try { SalcaraIngressRouter().resolve(canonical, signed(manifest())) { false } } catch (_: CancellationException) { canceled = true }
    check(canceled && calls.isEmpty())
  }
  test("cancellation during discovery does not continue scanning or use a saved lease") {
    var active = true; var canceled = false
    val m = signed(manifest()); response = { active = false; 200 to m.toString() }
    try { SalcaraIngressRouter().resolve(canonical, m) { active } } catch (_: CancellationException) { canceled = true }
    check(canceled && calls.size == 1)
  }
  test("discovery considers at most eight unique signed-cache candidates") {
    val entries = listOf(canonical) + (1..7).map { "https://entry$it.example/salcara-hub/v1" }
    val old = signed(manifest(System.currentTimeMillis() - 1, entries = entries)); response = { throw IOException("offline") }
    blocked { SalcaraIngressRouter().resolve(canonical, old) { true } }
    check(calls.size == 8 && calls.distinct().size == 8)
  }
  test("one discovery round also has a twelve-second monotonic budget") {
    var elapsed = 0L
    val entries = listOf(canonical) + (1..7).map { "https://entry$it.example/salcara-hub/v1" }
    val old = signed(manifest(System.currentTimeMillis() - 1, entries = entries))
    response = { elapsed += 2500; throw IOException("timeout") }
    blocked { SalcaraIngressRouter(monotonicClock = { elapsed }).resolve(canonical, old) { true } }
    check(calls.size == 5)
  }
  test("the ninth candidate is eventually reached when the old logical URL is no longer a member") {
    var now = System.currentTimeMillis()
    val entries = listOf(migrated) + (1..7).map { "https://entry$it.example/salcara-hub/v1" }
    val old = signed(manifest(now - 1, logical = migrated, entries = entries))
    val router = SalcaraIngressRouter(clock = { now })
    response = { url -> when {
      url == "$migrated/ingress/manifest" -> 200 to signed(manifest(now + 86_400_000, revision = 4, logical = migrated, entries = listOf(migrated))).toString()
      url.startsWith("$migrated/ingress/identity?") -> 200 to proof(url, now = now).toString()
      else -> throw IOException("offline")
    } }
    blocked { router.resolve(canonical, old) { true } }
    check(calls.size == 8 && calls.none { it.startsWith(migrated) })
    now += 60_001
    check(router.resolve(canonical, old) { true } == migrated)
    check(calls.contains("$migrated/ingress/manifest"))
  }
  test("ten candidates rotate the remaining hints after prioritizing old last-success and logical URLs") {
    var now = System.currentTimeMillis()
    val first = signed(manifest(now + 1000)); network(first)
    val router = SalcaraIngressRouter(clock = { now })
    check(router.resolve(canonical, first) { true } == backup)
    now += 1001; calls.clear()
    val entries = listOf(migrated) + (1..7).map { "https://entry$it.example/salcara-hub/v1" }
    val old = signed(manifest(now - 1, revision = 4, logical = migrated, entries = entries))
    response = { url -> when {
      url == "$migrated/ingress/manifest" -> 200 to signed(manifest(now + 86_400_000, revision = 5, logical = migrated, entries = listOf(migrated))).toString()
      url.startsWith("$migrated/ingress/identity?") -> 200 to proof(url, now = now).toString()
      else -> throw IOException("offline")
    } }
    blocked { router.resolve(canonical, old) { true } }
    check(calls.size == 8 && calls.take(2) == listOf("$backup/ingress/manifest", "$canonical/ingress/manifest"))
    now += 60_001
    check(router.resolve(canonical, old) { true } == migrated)
    check(calls.drop(8).take(2) == listOf("$backup/ingress/manifest", "$canonical/ingress/manifest"))
  }
  test("a round stopped by its time budget resumes at the first unattempted signed hint") {
    var now = System.currentTimeMillis(); var elapsed = 0L
    val entries = listOf(migrated) + (1..7).map { "https://entry$it.example/salcara-hub/v1" }
    val old = signed(manifest(now - 1, logical = migrated, entries = entries))
    val router = SalcaraIngressRouter(clock = { now }, monotonicClock = { elapsed })
    response = { url -> when {
      url == "$migrated/ingress/manifest" -> 200 to signed(manifest(now + 86_400_000, revision = 4, logical = migrated, entries = listOf(migrated))).toString()
      url.startsWith("$migrated/ingress/identity?") -> 200 to proof(url, now = now).toString()
      else -> { elapsed += 2500; throw IOException("timeout") }
    } }
    blocked { router.resolve(canonical, old) { true } }; check(calls.size == 5)
    val firstRound = calls.toList(); now += 60_001
    check(router.resolve(canonical, old) { true } == migrated)
    val nextHints = calls.drop(firstRound.size).filter { it.endsWith("/manifest") && it != "$canonical/ingress/manifest" }
    check(nextHints.isNotEmpty() && nextHints.none { it in firstRound })
    check(nextHints.last() == "$migrated/ingress/manifest")
  }
  test("proof attempts rotate even when the polling interval outlasts failed-endpoint cooldowns") {
    var now = System.currentTimeMillis()
    val entries = listOf(canonical) + (1..7).map { "https://entry$it.example/salcara-hub/v1" }
    val m = signed(manifest(now + 86_400_000, entries = entries))
    val router = SalcaraIngressRouter(clock = { now })
    response = { url -> when {
      url.endsWith("/manifest") -> 200 to m.toString()
      url.startsWith("$canonical/ingress/identity?") -> 200 to proof(url, now = now).toString()
      else -> throw IOException("offline")
    } }
    blocked { router.resolve(canonical, m) { true } }; now += 31_001
    blocked { router.resolve(canonical, m) { true } }; now += 31_001
    check(router.resolve(canonical, m) { true } == canonical)
    check(calls.count { it.contains("/identity?") } == 8)
    val verifiedCalls = calls.size
    check(router.resolve(canonical, m) { true } == canonical && calls.size == verifiedCalls)
  }
  test("failed refresh backs off rather than rescanning for every notification poll") {
    var now = System.currentTimeMillis()
    val old = signed(manifest(now - 1)); response = { throw IOException("offline") }
    val router = SalcaraIngressRouter(clock = { now })
    blocked { router.resolve(canonical, old) { true } }; check(calls.size == 2)
    blocked { router.resolve(canonical, old) { true } }; check(calls.size == 2)
    now += 60_001
    blocked { router.resolve(canonical, old) { true } }; check(calls.size == 4)
  }
  test("successful refresh is scheduled no later than manifest expiry and tries last success first") {
    var now = System.currentTimeMillis()
    val first = signed(manifest(now + 1000)); network(first)
    val router = SalcaraIngressRouter(clock = { now })
    check(router.resolve(canonical, first) { true } == backup)
    now += 1001; val next = signed(manifest(now + 86_400_000, revision = 4))
    response = { url -> if (url.endsWith("/manifest")) 200 to next.toString() else 200 to proof(url, now = now).toString() }
    val previousCalls = calls.size
    check(router.resolve(canonical, first) { true } == backup)
    check(calls[previousCalls] == "$backup/ingress/manifest")
  }
  test("changing credential scope never reuses another computer proof lease") {
    val m = signed(manifest()); network(m); val router = SalcaraIngressRouter()
    check(router.resolve(canonical, m, "scope-A") { true } == backup)
    val first = calls.size
    check(router.resolve(canonical, m, "scope-B") { true } == backup)
    check(calls.size == first * 2)
  }
  test("transport loss schedules a catalog refresh after the thirty-second cooldown") {
    var now = System.currentTimeMillis()
    val m = signed(manifest()); network(m)
    val router = SalcaraIngressRouter(clock = { now })
    check(router.resolve(canonical, m) { true } == backup); router.fail(backup)
    check(router.resolve(canonical, m) { true } == canonical)
    val previousCalls = calls.size
    now += 30_001
    network(signed(manifest(revision = 4))) { proof(it, now = now) }
    check(router.resolve(canonical, m) { true } == backup)
    check(calls[previousCalls] == "$canonical/ingress/manifest")
  }
  test("concurrent callers share the serialized refresh and short proof lease") {
    val m = signed(manifest()); network(m); val router = SalcaraIngressRouter()
    val results = java.util.Collections.synchronizedList(mutableListOf<String>())
    val workers = (1..6).map { Thread { results.add(router.resolve(canonical, m, "scope-A") { true }) }.also { it.start() } }
    workers.forEach { it.join() }
    check(results.size == 6 && results.all { it == backup } && calls.size == 3)
  }
  test("an unchanged fresh cache does not hide a newer same-pin migration catalog") {
    val old = signed(manifest()); val fresh = signed(manifest(revision = 4, logical = migrated, entries = listOf(migrated)))
    response = { url -> when {
      url == "$canonical/ingress/manifest" -> 200 to old.toString()
      url == "$backup/ingress/manifest" -> 200 to fresh.toString()
      url.startsWith("$migrated/ingress/identity?") -> 200 to proof(url).toString()
      else -> throw IOException("old control endpoint retired")
    } }
    check(SalcaraIngressRouter().resolve(canonical, old) { true } == migrated)
    check(calls.none { it.startsWith("$canonical/ingress/identity?") || it.startsWith("$backup/ingress/identity?") })
  }
  test("authority expiring during a valid nonce response is unavailable, not an identity change") {
    var now = System.currentTimeMillis()
    val m = signed(manifest(now + 500, entries = listOf(canonical)))
    response = { url -> if (url.endsWith("/manifest")) 200 to m.toString() else { now += 600; 200 to proof(url, now = now).toString() } }
    var unavailable = false
    try { SalcaraIngressRouter(clock = { now }).resolve(canonical, m) { true } } catch (_: SalcaraIngressUnavailable) { unavailable = true }
    check(unavailable)
  }
  test("one changed candidate does not block a healthy member of the still-fresh authority") {
    val old = signed(manifest()); val replaced = signed(manifest().put("hub_instance_id", "f".repeat(32)))
    response = { url -> when {
      url == "$canonical/ingress/manifest" -> 200 to replaced.toString()
      url == "$backup/ingress/manifest" -> throw IOException("catalog temporarily unavailable")
      url.startsWith("$backup/ingress/identity?") -> 200 to proof(url).toString()
      else -> error("unexpected identity destination")
    } }
    check(SalcaraIngressRouter().resolve(canonical, old) { true } == backup)
  }
  test("a production recovery checkpoint restores a native-discovered locator after every old host is retired") {
    val now = System.currentTimeMillis()
    val old = signed(manifest(now - 1)); val fresh = signed(manifest(revision = 4, logical = migrated, entries = listOf(migrated)))
    response = { url -> when {
      url == "$backup/ingress/manifest" || url == "$migrated/ingress/manifest" -> 200 to fresh.toString()
      url.startsWith("$migrated/ingress/identity?") -> 200 to proof(url).toString()
      else -> throw IOException("old domain offline")
    } }
    val current = watchConfig(old); val router = SalcaraIngressRouter()
    check(router.resolve(canonical, old, scope) { true } == migrated)
    val envelope = router.recoverySnapshot(canonical, scope, old)!!
    check(envelope.getString("signed_payload") == fresh.getString("signed_payload") && envelope.getString("signature") == fresh.getString("signature"))
    val checkpoint = SalcaraWatchRecovery.create(current, now - 60_000, false, now)!!
    checkpoint.getJSONObject("config").getJSONArray("sessions").getJSONObject(0).put("after", 345)
    val updated = SalcaraWatchRecovery.withIngressManifest(checkpoint, current, current, envelope, now)!!
    check(updated.getLong("expiresAt") == checkpoint.getLong("expiresAt"))
    val restored = SalcaraWatchRecovery.validate(JSONObject(updated.toString()), now)!!.getJSONObject("config")
    check(restored.getJSONArray("sessions").getJSONObject(0).getLong("after") == 345L)
    check(restored.getString("hubUrl") == canonical && restored.getString("navigationScope") == scope && restored.getString("pairToken") == "synthetic-private-token")
    calls.clear()
    response = { url -> when {
      url == "$migrated/ingress/manifest" -> 200 to fresh.toString()
      url.startsWith("$migrated/ingress/identity?") -> 200 to proof(url).toString()
      else -> throw IOException("every old host retired")
    } }
    check(SalcaraIngressRouter().resolve(restored.getString("hubUrl"), restored.getJSONObject("ingressManifest"), restored.getString("navigationScope")) { true } == migrated)
    check(calls.none { it.startsWith(backup) })
  }
  test("recovery export requires the exact scope and pin and never downgrades a handoff") {
    val old = signed(manifest()); val fresh = signed(manifest(revision = 4))
    network(fresh); val router = SalcaraIngressRouter(); router.resolve(canonical, old, scope) { true }
    check(router.recoverySnapshot(canonical, scope, old) != null)
    check(router.recoverySnapshot(canonical, "other-computer", old) == null)
    check(router.recoverySnapshot(backup, scope, old) == null)
    check(router.recoverySnapshot(canonical, scope, null) == null)
    check(router.recoverySnapshot(canonical, scope, signed(manifest(revision = 5))) == null)
    check(router.recoverySnapshot(canonical, scope, signed(manifest().put("hub_instance_id", "f".repeat(32)))) == null)
    check(router.recoverySnapshot(canonical, scope, fresh) == null)
  }
  test("an old same-scope JS handoff can retain the persisted new pin before the native router warms up") {
    val old = signed(manifest()); val fresh = signed(manifest(revision = 4, logical = migrated, entries = listOf(migrated)))
    val persisted = watchConfig(fresh)
    val router = SalcaraIngressRouter()
    check(router.recoverySnapshot(canonical, scope, old, persisted)?.getString("signed_payload") == fresh.getString("signed_payload"))
    check(router.recoverySnapshot(canonical, "different-scope", old, persisted) == null)
    val public = router.publicRecoverySnapshot(persisted)!!
    check(public.keySet() == setOf("hubUrl", "navigationScope", "manifest"))
    check(public.getJSONObject("manifest").keySet() == setOf("signed_payload", "signature"))
    check(!public.toString().contains("synthetic-private") && !public.has("sessions") && !public.has("expiresAt"))
    val invalid = watchConfig(JSONObject(fresh.toString()).put("signature", Base64.getEncoder().encodeToString(ByteArray(64))))
    check(router.publicRecoverySnapshot(invalid) == null)
  }
  test("Bot cold discovery uses its independent durable pin and checks dispatch") {
    val m = signed(manifest()); network(m)
    val router = SalcaraIngressRouter()
    check(router.resolve(canonical, null, scope, botPin()) { true } == backup)
    router.assertDispatch(canonical, scope, backup, botPin()) { true }
    identityBlocked { router.assertDispatch(canonical, scope, backup, otherBotPin()) { true } }
    identityBlocked { router.assertDispatch(canonical, "other-scope", backup, botPin()) { true } }
    identityBlocked { router.assertDispatch(canonical, scope, migrated, botPin()) { true } }
    identityBlocked { router.assertDispatch(canonical, scope, backup, null) { true } }
  }
  test("Bot rejects another signed identity at cold and warm handoff before network") {
    val m = signed(manifest())
    val changed = signed(manifest().put("hub_instance_id", otherId).put("identity_public_key", otherPublicKey), otherKey)
    network(m)
    identityBlocked { SalcaraIngressRouter().resolve(canonical, changed, scope, botPin()) { true } }
    check(calls.isEmpty())
    val router = SalcaraIngressRouter(); router.resolve(canonical, m, scope, botPin()) { true }
    calls.clear()
    identityBlocked { router.resolve(canonical, changed, scope, botPin()) { true } }
    check(calls.isEmpty())
  }
  test("Bot rejects unsigned handoff and discovery even when fields match") {
    val unsigned = manifest(); network(unsigned)
    identityBlocked { SalcaraIngressRouter().resolve(canonical, unsigned, scope, botPin()) { true } }
    check(calls.isEmpty())
    identityBlocked { SalcaraIngressRouter().resolve(canonical, null, scope, botPin()) { true } }
    check(calls == listOf("$canonical/ingress/manifest"))
    val router = SalcaraIngressRouter(); val m = signed(manifest()); network(m)
    router.resolve(canonical, m, scope, botPin()) { true }; calls.clear()
    identityBlocked { router.resolve(canonical, unsigned, scope, botPin()) { true } }
    check(calls.isEmpty())
  }
  test("Bot cannot enroll a replacement global identity through public discovery") {
    val changed = signed(manifest().put("hub_instance_id", otherId).put("identity_public_key", otherPublicKey), otherKey)
    network(changed)
    identityBlocked { SalcaraIngressRouter().resolve(canonical, null, scope, botPin()) { true } }
    check(calls == listOf("$canonical/ingress/manifest"))
  }
  test("Bot missing ingress never falls back while valid Pair legacy behavior is retained") {
    response = { 404 to "{}" }
    identityBlocked { SalcaraIngressRouter().resolve(canonical, null, scope, botPin()) { true } }
    check(SalcaraIngressRouter().resolve(canonical, null, scope) { true } == canonical)
  }
  test("Bot warm authority cannot turn a later 404 into a legacy dispatch") {
    var now = System.currentTimeMillis()
    val m = signed(manifest(now + 86_400_000)); network(m) { proof(it, now = now) }
    val router = SalcaraIngressRouter(clock = { now })
    router.resolve(canonical, m, scope, botPin()) { true }
    now += 10_001; response = { 404 to "{}" }
    identityBlocked { router.resolve(canonical, null, scope, botPin()) { true } }
    temporarilyUnavailable { router.assertDispatch(canonical, scope, backup, botPin()) { true } }
  }
  test("changing Bot pin clears old manifests and leases even within one scope") {
    val m = signed(manifest()); network(m); val router = SalcaraIngressRouter()
    router.resolve(canonical, m, scope, botPin()) { true }; calls.clear()
    identityBlocked { router.resolve(canonical, m, scope, otherBotPin()) { true } }
    identityBlocked { router.assertDispatch(canonical, scope, backup, botPin()) { true } }
    check(calls.isEmpty())
    val replacement = signed(manifest().put("hub_instance_id", otherId).put("identity_public_key", otherPublicKey), otherKey)
    network(replacement) { proof(it, identity = otherId, signingKey = otherKey) }
    check(router.resolve(canonical, replacement, scope, otherBotPin()) { true } == backup)
    check(calls.any { it.contains("/identity?") })
    router.assertDispatch(canonical, scope, backup, otherBotPin()) { true }
  }
  test("a Pair lease cannot be reused by a newly supplied Bot pin") {
    val m = signed(manifest()); network(m); val router = SalcaraIngressRouter()
    router.resolve(canonical, m, scope) { true }; calls.clear()
    check(router.resolve(canonical, m, scope, botPin()) { true } == backup)
    check(calls.any { it.contains("/identity?") })
  }
  test("Bot pin parser requires exact string instance and canonical 32-byte Ed25519 key") {
    val invalid = listOf(
      botPin().put("instanceId", hubId.uppercase()), botPin().put("instanceId", "a".repeat(31)),
      botPin().put("instanceId", 123), botPin().put("publicKey", publicKey + "="),
      botPin().put("publicKey", publicKey.trimEnd('=')), botPin().put("publicKey", Base64.getEncoder().encodeToString(ByteArray(31))),
      botPin().put("publicKey", Base64.getEncoder().encodeToString(ByteArray(33))),
      botPin().put("publicKey", "A".repeat(42) + "B="), botPin().put("extra", true), JSONObject()
    )
    for (pin in invalid) identityBlocked { SalcaraIngressRouter().resolve(canonical, null, scope, pin) { true } }
    check(calls.isEmpty())
  }
  test("Bot export without an old envelope still requires a matching signed identity") {
    val m = signed(manifest()); network(m); val router = SalcaraIngressRouter()
    router.resolve(canonical, null, scope, botPin()) { true }
    check(router.recoverySnapshot(canonical, scope, null, botPin = botPin())?.getString("signature") == m.getString("signature"))
    check(router.recoverySnapshot(canonical, scope, null, botPin = otherBotPin()) == null)
    check(router.recoverySnapshot(canonical, "other-scope", null, botPin = botPin()) == null)
    val persisted = watchConfig(m).put("botToken", "synthetic-bot-token").put("botPin", botPin())
    val cold = SalcaraIngressRouter()
    check(cold.recoverySnapshot(canonical, scope, null, persisted, botPin())?.getString("signature") == m.getString("signature"))
    check(cold.recoverySnapshot(canonical, scope, null, persisted, otherBotPin()) == null)
    check(cold.publicRecoverySnapshot(persisted) != null)
    persisted.put("botPin", otherBotPin())
    check(cold.publicRecoverySnapshot(persisted) == null)
    persisted.remove("botPin")
    check(cold.publicRecoverySnapshot(persisted) == null)
    persisted.put("botPin", botPin()).put("ingressManifest", manifest())
    check(cold.recoverySnapshot(canonical, scope, null, persisted, botPin()) == null)
    check(cold.publicRecoverySnapshot(watchConfig(m).put("botPin", otherBotPin())) != null)
  }
  test("cold Bot pin alone accepts a same-identity signed migration that retired its logical URL") {
    val fresh = signed(manifest(revision = 4, logical = migrated, entries = listOf(migrated)))
    response = { url -> when {
      url == "$canonical/ingress/manifest" -> 200 to fresh.toString()
      url.startsWith("$migrated/ingress/identity?") -> 200 to proof(url).toString()
      else -> error("Unexpected migration destination")
    } }
    val router = SalcaraIngressRouter()
    check(router.resolve(canonical, null, scope, botPin()) { true } == migrated)
    router.assertDispatch(canonical, scope, migrated, botPin()) { true }
    check(router.recoverySnapshot(canonical, scope, null, botPin = botPin())?.getString("signature") == fresh.getString("signature"))
    check(calls.size == 2)
  }
  test("Bot checkpoint keeps its pin through a same-identity signed endpoint migration") {
    val now = System.currentTimeMillis()
    val old = signed(manifest(now - 1))
    val fresh = signed(manifest(revision = 4, logical = migrated, entries = listOf(migrated)))
    response = { url -> when {
      url == "$backup/ingress/manifest" || url == "$migrated/ingress/manifest" -> 200 to fresh.toString()
      url.startsWith("$migrated/ingress/identity?") -> 200 to proof(url).toString()
      else -> throw IOException("old domain offline")
    } }
    val config = watchConfig(old).put("botToken", "synthetic-bot-token").put("botPin", botPin())
    val router = SalcaraIngressRouter()
    check(router.resolve(canonical, old, scope, botPin()) { true } == migrated)
    val envelope = router.recoverySnapshot(canonical, scope, old, botPin = botPin())!!
    val checkpoint = SalcaraWatchRecovery.create(config, now - 60_000, false, now)!!
    val updated = SalcaraWatchRecovery.withIngressManifest(checkpoint, config, config, envelope, now)!!
    check(updated.getLong("expiresAt") == checkpoint.getLong("expiresAt"))
    val restored = SalcaraWatchRecovery.validate(JSONObject(updated.toString()), now)!!.getJSONObject("config")
    check(restored.getJSONObject("botPin").toString() == botPin().toString())
    check(SalcaraIngressRouter().resolve(canonical, restored.getJSONObject("ingressManifest"), scope, restored.getJSONObject("botPin")) { true } == migrated)
  }
  test("Bot final dispatch rejects expired lease and manifest as retryable and observes cancellation") {
    var now = System.currentTimeMillis()
    val m = signed(manifest(now + 20_000)); network(m) { proof(it, now = now) }
    val router = SalcaraIngressRouter(clock = { now })
    router.resolve(canonical, m, scope, botPin()) { true }
    var canceled = false
    try { router.assertDispatch(canonical, scope, backup, botPin()) { false } } catch (_: CancellationException) { canceled = true }
    check(canceled)
    now += 10_001
    temporarilyUnavailable { router.assertDispatch(canonical, scope, backup, botPin()) { true } }
    now += 10_000
    temporarilyUnavailable { router.assertDispatch(canonical, scope, backup, botPin()) { true } }
  }
  test("Bot discovery and proof transport loss remain retryable without legacy fallback") {
    response = { throw IOException("offline") }
    temporarilyUnavailable { SalcaraIngressRouter().resolve(canonical, null, scope, botPin()) { true } }
    temporarilyUnavailable { SalcaraIngressRouter().resolve(canonical, signed(manifest()), scope, botPin()) { true } }
    val expired = signed(manifest(System.currentTimeMillis() - 1)); network(expired)
    temporarilyUnavailable { SalcaraIngressRouter().resolve(canonical, expired, scope, botPin()) { true } }
  }
  test("Bot cold expired public authority stays retryable and cannot authorize dispatch") {
    network(signed(manifest(System.currentTimeMillis() - 1)))
    val router = SalcaraIngressRouter()
    temporarilyUnavailable { router.resolve(canonical, null, scope, botPin()) { true } }
    check(calls == listOf("$canonical/ingress/manifest"))
    identityBlocked { router.assertDispatch(canonical, scope, canonical, botPin()) { true } }
  }
  test("Bot expired public candidate cannot hide a later fresh matching recovery") {
    val old = signed(manifest(System.currentTimeMillis() - 1))
    val fresh = signed(manifest(revision = 4))
    response = { url -> when {
      url == "$canonical/ingress/manifest" -> 200 to old.toString()
      url == "$backup/ingress/manifest" -> 200 to fresh.toString()
      url.startsWith("$backup/ingress/identity?") -> 200 to proof(url).toString()
      else -> error("Unexpected expired-cache recovery destination")
    } }
    val router = SalcaraIngressRouter()
    check(router.resolve(canonical, old, scope, botPin()) { true } == backup)
    router.assertDispatch(canonical, scope, backup, botPin()) { true }
    check(calls.take(2) == listOf("$canonical/ingress/manifest", "$backup/ingress/manifest"))
  }
  test("Bot correctly signed stale proof stays retryable without granting a lease") {
    val m = signed(manifest()); network(m) { proof(it, stale = true) }
    val router = SalcaraIngressRouter()
    temporarilyUnavailable { router.resolve(canonical, m, scope, botPin()) { true } }
    temporarilyUnavailable { router.assertDispatch(canonical, scope, backup, botPin()) { true } }
    check(calls.count { it.contains("/identity?") } == 2)
  }
  test("Bot proof expiring during its response can use another fresh same-pin endpoint") {
    var now = System.currentTimeMillis()
    val m = signed(manifest(now + 86_400_000))
    response = { url -> when {
      url.endsWith("/manifest") -> 200 to m.toString()
      url.startsWith("$backup/ingress/identity?") -> {
        val delayed = proof(url, now = now); now += 30_001; 200 to delayed.toString()
      }
      url.startsWith("$canonical/ingress/identity?") -> 200 to proof(url, now = now).toString()
      else -> error("Unexpected proof expiry destination")
    } }
    val router = SalcaraIngressRouter(clock = { now })
    check(router.resolve(canonical, m, scope, botPin()) { true } == canonical)
    router.assertDispatch(canonical, scope, canonical, botPin()) { true }
    temporarilyUnavailable { router.assertDispatch(canonical, scope, backup, botPin()) { true } }
  }
  test("Bot expired forged proof and nonce mismatch remain identity failures") {
    val m = signed(manifest())
    network(m) { proof(it, stale = true, forged = true) }
    identityBlocked { SalcaraIngressRouter().resolve(canonical, m, scope, botPin()) { true } }
    network(m) { proof(it, wrongNonce = true) }
    identityBlocked { SalcaraIngressRouter().resolve(canonical, m, scope, botPin()) { true } }
  }
  test("Bot rejected candidate cannot hide a healthy same-pin member") {
    val m = signed(manifest())
    val changed = signed(manifest().put("hub_instance_id", otherId).put("identity_public_key", otherPublicKey), otherKey)
    response = { url -> when {
      url == "$canonical/ingress/manifest" -> 200 to changed.toString()
      url == "$backup/ingress/manifest" -> 200 to m.toString()
      url.startsWith("$backup/ingress/identity?") -> 200 to proof(url).toString()
      else -> error("Unexpected Bot destination")
    } }
    val router = SalcaraIngressRouter()
    check(router.resolve(canonical, m, scope, botPin()) { true } == backup)
    router.assertDispatch(canonical, scope, backup, botPin()) { true }
  }
  println("$passed native ingress contract checks passed")
}
