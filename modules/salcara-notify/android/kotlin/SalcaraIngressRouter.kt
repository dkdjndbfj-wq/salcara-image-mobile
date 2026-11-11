package expo.modules.salcaranotify

import com.google.crypto.tink.subtle.Base64
import com.google.crypto.tink.subtle.Ed25519Verify
import org.json.JSONObject
import java.net.CookieHandler
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.security.SecureRandom
import java.util.concurrent.CancellationException

internal class SalcaraIngressUnavailable(message: String) : IllegalStateException(message)

/** Worker-thread transport selection. Pairing and event cursors stay on the saved logical Hub. */
internal class SalcaraIngressRouter(
  private val clock: () -> Long = { System.currentTimeMillis() },
  private val monotonicClock: () -> Long = { System.nanoTime() / 1_000_000 }
) {
  private data class Endpoint(val id: String, val url: String, val priority: Int)
  private data class Manifest(val hubId: String, val key: String, val revision: Long, val expires: Long, val endpoints: List<Endpoint>, val signed: Boolean, val envelope: String)
  private data class RecoveryAuthority(val logicalUrl: String, val scope: String, val manifest: Manifest)
  private var canonical = ""
  private var credentialScope = ""
  private var manifest: Manifest? = null
  private var refreshAt = 0L
  private var lastSuccessfulEndpoint: String? = null
  private var discoveryCursor = 0
  private var proofCursor = 0
  @Volatile private var recoveryAuthority: RecoveryAuthority? = null
  private val failed = HashMap<String, Long>()
  private val leases = HashMap<String, Long>()
  private val random = SecureRandom()

  @Synchronized
  fun fail(endpoint: String) {
    failed[endpoint] = clock() + 30_000; leases.remove(endpoint)
    // Transport loss may mean the signed catalog changed. Retry discovery
    // after the endpoint cooldown, not six hours later or on every event poll.
    refreshAt = minOf(refreshAt, clock() + 30_000)
  }

  // The notification worker normally calls serially. The monitor also merges
  // concurrent callers into the same refresh result/backoff rather than scans.
  @Synchronized
  fun resolve(url: String, handedOver: JSONObject?, pairingScope: String = "", active: () -> Boolean): String {
    if (!active()) throw CancellationException()
    if (canonical != url || credentialScope != pairingScope) { canonical = url; credentialScope = pairingScope; manifest = null; recoveryAuthority = null; refreshAt = 0; lastSuccessfulEndpoint = null; discoveryCursor = 0; proofCursor = 0; failed.clear(); leases.clear() }
    if (!validUrl(url)) return url
    val now = clock()
    val deadline = monotonicClock() + 12_000
    // JS hands over a previously pinned authority. Expired signed endpoints
    // remain anonymous discovery hints, never authorization to send a token.
    try { if (handedOver != null) accept(parse(handedOver, url, now, true, false)) }
    catch (error: Exception) {
      // A corrupt saved pin is not an opt-out from identity verification.
      if (manifest == null) throw IllegalStateException("Saved Hub identity could not be verified", error)
    }
    if (!active()) throw CancellationException()
    if (refreshAt <= now) {
      refreshAt = now + 60_000
      val pinned = manifest
      val preferred = listOfNotNull(lastSuccessfulEndpoint, url).distinct()
      val hints = if (pinned?.signed == true) pinned.endpoints.sortedBy { it.priority }.map { it.url }.filterNot { it in preferred } else emptyList()
      val start = if (hints.isEmpty()) 0 else discoveryCursor % hints.size
      val candidates = preferred + (hints.drop(start) + hints.take(start)).take(8 - preferred.size)
      for (candidate in candidates) {
        if (!active()) throw CancellationException()
        if (monotonicClock() >= deadline) break
        // Advance only for an actually attempted hint. Both the eight-entry
        // cap and a mid-round timeout must leave the next hint reachable.
        val hintIndex = hints.indexOf(candidate)
        if (hintIndex >= 0) discoveryCursor = (hintIndex + 1) % hints.size
        try {
          val next = parse(publicJson("$candidate/ingress/manifest", active, deadline), url, clock(), requireLogicalMembership = pinned == null)
          // An invalid/changed candidate never replaces the pin or prevents
          // another signed-cache entry from refreshing the same identity.
          val previous = manifest
          if (accept(next)) {
            refreshAt = minOf(clock() + 6 * 60 * 60_000, manifest!!.expires)
            // An unchanged, still-fresh public cache must not indefinitely
            // hide a newer catalog on another already-trusted candidate.
            if (previous == null || next.revision > previous.revision || next.expires > previous.expires || next.signed && !previous.signed) break
          }
        } catch (error: CancellationException) { throw error }
        catch (_: Exception) { }
      }
    }
    if (!active()) throw CancellationException()
    val authority = manifest ?: return url
    if (authority.expires <= clock()) throw SalcaraIngressUnavailable("Hub authority must be refreshed before sending pairing credentials")
    val proofHints = authority.endpoints.sortedBy { it.priority }
    // A still-valid member lease must not be hidden behind this round's
    // bounded attempts at higher-priority, previously unavailable endpoints.
    proofHints.firstOrNull { (failed[it.url] ?: 0) <= clock() && (leases[it.url] ?: 0) > clock()
      && (it.url == url || authority.signed) }?.let { return it.url }
    val proofStart = if (proofHints.isEmpty()) 0 else proofCursor % proofHints.size
    var checks = 0
    for (endpoint in proofHints.drop(proofStart) + proofHints.take(proofStart)) {
      if (!active()) throw CancellationException()
      if ((failed[endpoint.url] ?: 0) > clock()) continue
      if (endpoint.url != url && !authority.signed) continue
      if ((leases[endpoint.url] ?: 0) > clock()) return endpoint.url
      if (++checks > 3) break
      if (monotonicClock() >= deadline) break
      // Cooldowns alone cannot guarantee fairness when polls are farther
      // apart than the cooldown. Rotate the bounded nonce attempts as well.
      val proofIndex = proofHints.indexOf(endpoint)
      if (proofIndex >= 0) proofCursor = (proofIndex + 1) % proofHints.size
      try {
        val nonce = ByteArray(32).also { random.nextBytes(it) }.joinToString("") { "%02x".format(it.toInt() and 255) }
        val proof = publicJson("${endpoint.url}/ingress/identity?nonce=$nonce", active, deadline)
        val checkedAt = clock()
        if (authority.expires <= checkedAt) throw SalcaraIngressUnavailable("Hub authority expired while verifying the endpoint")
        val issued = number(proof, "issued_at")
        val expires = number(proof, "expires_at")
        require(number(proof, "version") == 1L && proof.getString("hub_instance_id") == authority.hubId && proof.getString("nonce") == nonce)
        require(issued in (checkedAt - 30_000)..(checkedAt + 30_000) && expires > checkedAt && expires > issued && expires - issued <= 30_000)
        val message = "salcara-ingress-proof-v1\n${authority.hubId}\n$nonce\n$issued\n$expires".toByteArray(Charsets.UTF_8)
        // Tink provides Ed25519 on supported Android versions without depending
        // on a platform provider. Any parsing or verification failure stays closed.
        Ed25519Verify(bytes(authority.key, 32)).verify(bytes(proof.getString("signature"), 64), message)
        if (!active()) throw CancellationException()
        if (authority.expires <= clock() || expires <= clock()) throw SalcaraIngressUnavailable("Hub verification expired before the endpoint could be used")
        leases[endpoint.url] = minOf(expires, authority.expires, checkedAt + 10_000)
        failed.remove(endpoint.url)
        lastSuccessfulEndpoint = endpoint.url
        proofCursor = 0
        return endpoint.url
      } catch (error: CancellationException) { throw error }
      catch (error: SalcaraIngressUnavailable) { throw error }
      catch (_: Exception) { fail(endpoint.url) }
    }
    if (!active()) throw CancellationException()
    throw SalcaraIngressUnavailable("No currently reachable verified Hub endpoint")
  }

  /** Non-blocking, public-only export. The exact caller namespace and pinned
   * identity must match; the original signed payload is never reconstructed. */
  fun recoverySnapshot(url: String, pairingScope: String, expected: JSONObject?, persistedConfig: JSONObject? = null): JSONObject? {
    if (expected == null) return null
    return try {
      val prior = parse(expected, url, clock(), true, false)
      val candidates = mutableListOf<Manifest>()
      recoveryAuthority?.takeIf { it.logicalUrl == url && it.scope == pairingScope }?.let { candidates.add(it.manifest) }
      if (persistedConfig?.optString("hubUrl")?.trimEnd('/') == url && persistedConfig.optString("navigationScope") == pairingScope) {
        try { persistedConfig.optJSONObject("ingressManifest")?.let { candidates.add(parse(it, url, clock(), true, false)) } }
        catch (_: Exception) { /* A damaged persisted candidate cannot hide a valid live same-pin authority. */ }
      }
      val next = candidates.filter { it.signed && it.hubId == prior.hubId && it.key == prior.key
        && (it.revision > prior.revision || it.revision == prior.revision && it.expires >= prior.expires) }
        .maxWithOrNull(compareBy<Manifest> { it.revision }.thenBy { it.expires }) ?: return null
      val envelope = JSONObject(next.envelope)
      if (expected.optString("signed_payload") == envelope.optString("signed_payload")
        && expected.optString("signature") == envelope.optString("signature")) return null
      envelope
    } catch (_: Exception) { null }
  }

  /** Only public, signature-checked fields cross the native-to-JS boundary. */
  fun publicRecoverySnapshot(config: JSONObject): JSONObject? {
    return try {
      val result = SalcaraWatchRecovery.publicIngressInfo(config) ?: return null
      if (!parse(result.getJSONObject("manifest"), result.getString("hubUrl"), clock(), true, false).signed) null else result
    } catch (_: Exception) { null }
  }

  private fun accept(next: Manifest): Boolean {
    val previous = manifest
    if (previous != null && (previous.hubId != next.hubId || previous.key != next.key || previous.revision > next.revision || previous.signed && !next.signed)) return false
    if (previous != null && previous.revision == next.revision && previous.expires >= next.expires && (!next.signed || previous.signed)) return true
    manifest = next; recoveryAuthority = RecoveryAuthority(canonical, credentialScope, next)
    refreshAt = minOf(refreshAt, next.expires); leases.clear(); failed.clear()
    return true
  }

  private fun parse(input: JSONObject, url: String, now: Long, allowExpired: Boolean = false, requireLogicalMembership: Boolean = true): Manifest {
    val signed = input.has("signed_payload") || input.has("signature")
    val value = if (signed) {
      val encoded = input.getString("signed_payload")
      require(encoded.length <= 12_000 && encoded.matches(Regex("[A-Za-z0-9+/]+={0,2}")))
      val payload = Base64.decode(encoded, Base64.NO_WRAP)
      require(Base64.encodeToString(payload, Base64.NO_WRAP) == encoded)
      val decoded = JSONObject(Charsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(payload)).toString())
      require(!decoded.has("signed_payload") && !decoded.has("signature"))
      val prefix = "salcara-ingress-manifest-v1\n".toByteArray(Charsets.UTF_8)
      Ed25519Verify(bytes(decoded.getString("identity_public_key"), 32)).verify(bytes(input.getString("signature"), 64), prefix + payload)
      decoded
    } else input
    val hubId = value.getString("hub_instance_id")
    val key = value.getString("identity_public_key")
    val revision = number(value, "revision")
    val issued = number(value, "issued_at")
    val expires = number(value, "expires_at")
    val manifestCanonical = if (signed) value.getString("canonical_url") else url
    require(validUrl(manifestCanonical) && number(value, "version") == 1L && value.getString("canonical_url") == manifestCanonical && hubId.matches(Regex("[a-f0-9]{32}")))
    require(revision > 0 && issued <= now + 30_000 && (allowExpired || expires > now) && expires > issued && expires - issued <= 86_400_000)
    bytes(key, 32)
    val rows = value.getJSONArray("endpoints")
    require(rows.length() in 1..8)
    val endpoints = (0 until rows.length()).map {
      val item = rows.getJSONObject(it)
      val id = item.getString("id")
      val endpoint = item.getString("url")
      val priority = number(item, "priority")
      require(id.matches(Regex("[A-Za-z0-9._-]{1,64}")) && validUrl(endpoint) && priority <= 1000)
      Endpoint(id, endpoint, priority.toInt())
    }
    require(endpoints.map { it.id }.distinct().size == endpoints.size && endpoints.map { it.url }.distinct().size == endpoints.size)
    require(endpoints.any { it.id == "canonical" && it.url == manifestCanonical })
    require(!signed || !requireLogicalMembership || endpoints.any { it.url == url })
    return Manifest(hubId, key, revision, expires, endpoints, signed, input.toString())
  }

  private fun publicJson(url: String, active: () -> Boolean, roundDeadline: Long): JSONObject {
    if (!active()) throw CancellationException()
    // HttpURLConnection may otherwise consult a process-wide cookie handler
    // even though this request sets no Cookie header. Do not mutate that global
    // handler or risk sending its cookies to a discovery candidate.
    require(CookieHandler.getDefault() == null) { "Anonymous Hub discovery cannot use a global cookie handler" }
    val deadline = minOf(roundDeadline, monotonicClock() + 2500)
    val remaining = deadline - monotonicClock()
    require(remaining > 0) { "Hub discovery timed out" }
    val connection = URL(url).openConnection() as HttpURLConnection
    connection.instanceFollowRedirects = false
    connection.useCaches = false
    // Bound connection + initial response together, not 2.5 seconds each.
    connection.connectTimeout = maxOf(1, (remaining / 2).toInt())
    connection.readTimeout = maxOf(1, (remaining / 2).toInt())
    connection.setRequestProperty("Accept", "application/json")
    try {
      require(connection.responseCode in 200..299 && connection.url.toString() == url)
      require(connection.contentLengthLong <= 16_384)
      val body = connection.inputStream.use { input ->
        val output = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(2048)
        while (true) {
          if (!active()) throw CancellationException()
          val bodyRemaining = deadline - monotonicClock()
          require(bodyRemaining > 0) { "Hub discovery timed out" }
          connection.readTimeout = bodyRemaining.toInt()
          val count = input.read(buffer)
          if (count < 0) break
          require(output.size() + count <= 16_384)
          output.write(buffer, 0, count)
        }
        output.toString("UTF-8")
      }
      return JSONObject(body)
    } finally { connection.disconnect() }
  }

  companion object {
    private fun number(value: JSONObject, key: String): Long {
      val result = value.get(key)
      require(result is Int || result is Long)
      return (result as Number).toLong().also { require(it in 0..9_007_199_254_740_991L) }
    }
    private fun bytes(value: String, length: Int): ByteArray {
      require(value.matches(Regex("[A-Za-z0-9+/]+={0,2}")))
      val decoded = Base64.decode(value, Base64.NO_WRAP)
      require(decoded.size == length && Base64.encodeToString(decoded, Base64.NO_WRAP) == value)
      return decoded
    }
    private fun validUrl(value: String): Boolean = try {
      val url = URI(value)
      val host = url.host?.lowercase().orEmpty().removePrefix("[").removeSuffix("]")
      val privateHost = host.isEmpty() || host == "localhost" || host.endsWith(".localhost") || host.endsWith(".local")
        || host.contains(':') && (host == "::" || host == "::1" || Regex("^(fc|fd|fe[89ab]|::ffff:)").containsMatchIn(host))
        || Regex("^\\d+\\.\\d+\\.\\d+\\.\\d+$").matches(host) && host.split('.').map { it.toIntOrNull() ?: -1 }.let {
          it.any { part -> part !in 0..255 } || it[0] in listOf(0, 10, 127) || it[0] >= 224 || it[0] == 169 && it[1] == 254
            || it[0] == 172 && it[1] in 16..31 || it[0] == 192 && it[1] == 168 || it[0] == 100 && it[1] in 64..127
        }
      value.length <= 512 && value.startsWith("https://") && !Regex("[\\\\\\s]").containsMatchIn(value) && url.scheme == "https"
        && url.rawUserInfo == null && url.rawQuery == null && url.rawFragment == null && !privateHost
        && url.rawPath.endsWith("/v1") && !url.rawPath.contains("//") && url.rawPath.split('/').drop(1).all { it.matches(Regex("[A-Za-z0-9._~-]+")) && it != "." && it != ".." }
        && url.port != 443 && (url.port == -1 || url.port in 1..65535)
    } catch (_: Exception) { false }
  }
}
