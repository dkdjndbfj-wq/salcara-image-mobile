package expo.modules.salcaranotify

import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLStreamHandler
import java.security.KeyPairGenerator
import java.security.Signature
import java.util.Base64
import java.util.concurrent.CancellationException

/** Standalone JVM contract checks using the production Kotlin router and Tink. */
private const val canonical = "https://hub.example/salcara-hub/v1"
private const val backup = "https://entry.example/salcara-hub/v1"
private val key = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
private val hubId = "a".repeat(32)
private val publicKey = Base64.getEncoder().encodeToString(key.public.encoded.takeLast(32).toByteArray())
private val calls = mutableListOf<String>()
private var response: (String) -> Pair<Int, String> = { throw IOException("offline") }
private var publicChecks = 0

private fun manifest(expires: Long = System.currentTimeMillis() + 86_400_000): JSONObject = JSONObject()
  .put("version", 1).put("hub_instance_id", hubId).put("identity_public_key", publicKey).put("canonical_url", canonical)
  .put("revision", 3).put("issued_at", expires - 86_400_000).put("expires_at", expires)
  .put("endpoints", JSONArray().put(JSONObject().put("id", "canonical").put("url", canonical).put("priority", 100))
    .put(JSONObject().put("id", "backup").put("url", backup).put("priority", 50)))

private fun proof(url: String, wrongNonce: Boolean = false, stale: Boolean = false, forged: Boolean = false): JSONObject {
  val nonce = if (wrongNonce) "f".repeat(64) else url.substringAfter("nonce=")
  val issued = System.currentTimeMillis() - if (stale) 90_000 else 0
  val expires = issued + 30_000
  val bytes = "salcara-ingress-proof-v1\n$hubId\n$nonce\n$issued\n$expires".toByteArray()
  val signer = Signature.getInstance("Ed25519").apply { initSign(key.private); update(bytes) }
  val signature = if (forged) ByteArray(64) else signer.sign()
  return JSONObject().put("version", 1).put("hub_instance_id", hubId).put("nonce", nonce)
    .put("issued_at", issued).put("expires_at", expires).put("signature", Base64.getEncoder().encodeToString(signature))
}

fun main() {
  URL.setURLStreamHandlerFactory { protocol -> if (protocol != "https") null else object : URLStreamHandler() {
    override fun openConnection(url: URL): HttpURLConnection = object : HttpURLConnection(url) {
      private var body = ""
      override fun connect() { }
      override fun disconnect() { }
      override fun usingProxy() = false
      override fun getResponseCode(): Int {
        check(!instanceFollowRedirects && connectTimeout == 2500 && readTimeout == 2500)
        check(requestProperties.keys.all { it == "Accept" })
        calls.add(url.toString()); publicChecks++
        val result = response(url.toString()); body = result.second; return result.first
      }
      override fun getContentLengthLong() = body.toByteArray().size.toLong()
      override fun getInputStream() = ByteArrayInputStream(body.toByteArray())
    }
  } }

  var passed = 0
  fun test(name: String, run: () -> Unit) { calls.clear(); publicChecks = 0; run(); passed++; println("PASS $name") }
  fun network(m: JSONObject, bad: (String) -> JSONObject = { proof(it) }) {
    response = { url -> when {
      url == "$canonical/ingress/manifest" -> 200 to m.toString()
      url.startsWith("$canonical/ingress/identity?") -> throw IOException("primary unavailable")
      url.startsWith("$backup/ingress/identity?") -> 200 to bad(url).toString()
      else -> error("unexpected URL: $url")
    } }
  }
  test("real signed fallback and proof lease") {
    val m = manifest(); network(m); val router = SalcaraIngressRouter()
    check(router.resolve(canonical, m) { true } == backup)
    val first = publicChecks
    check(router.resolve(canonical, m) { true } == backup && publicChecks == first)
    check(calls.all { it.startsWith(canonical) || it.startsWith(backup) })
  }
  test("lost transport invalidates proof lease") {
    val m = manifest(); network(m); val router = SalcaraIngressRouter()
    check(router.resolve(canonical, m) { true } == backup); router.fail(backup)
    check(router.resolve(canonical, m) { true } == canonical)
  }
  test("forged signature stays closed") { val m = manifest(); network(m) { proof(it, forged = true) }; check(SalcaraIngressRouter().resolve(canonical, m) { true } == canonical) }
  test("signed wrong nonce stays closed") { val m = manifest(); network(m) { proof(it, wrongNonce = true) }; check(SalcaraIngressRouter().resolve(canonical, m) { true } == canonical) }
  test("signed expired proof stays closed") { val m = manifest(); network(m) { proof(it, stale = true) }; check(SalcaraIngressRouter().resolve(canonical, m) { true } == canonical) }
  test("expired cache cannot authorize backup") {
    val m = manifest(System.currentTimeMillis() - 1); response = { throw IOException("offline") }
    check(SalcaraIngressRouter().resolve(canonical, m) { true } == canonical && calls.size == 1)
  }
  test("private backup is rejected") {
    val m = manifest(); m.getJSONArray("endpoints").getJSONObject(1).put("url", "https://127.0.0.1/salcara-hub/v1")
    response = { 200 to m.toString() }; check(SalcaraIngressRouter().resolve(canonical, m) { true } == canonical)
    check(calls == listOf("$canonical/ingress/manifest"))
  }
  test("changed Hub identity cannot replace handover authority") {
    val m = manifest(); val changed = JSONObject(m.toString()).put("hub_instance_id", "f".repeat(32)); network(changed)
    check(SalcaraIngressRouter().resolve(canonical, m) { true } == backup)
  }
  test("redirected identity is never accepted or followed") {
    val m = manifest(); response = { if (it.endsWith("/manifest")) 200 to m.toString() else 302 to "" }
    check(SalcaraIngressRouter().resolve(canonical, m) { true } == canonical); check(calls.size == 2)
  }
  test("oversized manifest is rejected before parse") {
    response = { 200 to "x".repeat(16_385) }
    check(SalcaraIngressRouter().resolve(canonical, null) { true } == canonical && calls.size == 1)
  }
  test("cancelled configuration performs no network request") {
    var cancelled = false
    try { SalcaraIngressRouter().resolve(canonical, manifest()) { false } } catch (_: CancellationException) { cancelled = true }
    check(cancelled && calls.isEmpty())
  }
  test("HTTPS downgrade is never considered a backup") {
    val m = manifest(); m.getJSONArray("endpoints").getJSONObject(1).put("url", "http://entry.example/salcara-hub/v1")
    response = { 200 to m.toString() }; check(SalcaraIngressRouter().resolve(canonical, m) { true } == canonical)
    check(calls == listOf("$canonical/ingress/manifest"))
  }
  test("healthy canonical needs no proof; failure switches to verified backup") {
    val m = manifest(); m.getJSONArray("endpoints").getJSONObject(1).put("priority", 200); network(m)
    val router = SalcaraIngressRouter()
    check(router.resolve(canonical, m) { true } == canonical)
    check(calls == listOf("$canonical/ingress/manifest"))
    router.fail(canonical)
    check(router.resolve(canonical, m) { true } == backup)
  }
  println("$passed native ingress contract checks passed")
}
