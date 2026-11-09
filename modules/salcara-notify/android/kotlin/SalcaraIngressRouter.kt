package expo.modules.salcaranotify

import com.google.crypto.tink.subtle.Base64
import com.google.crypto.tink.subtle.Ed25519Verify
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.security.SecureRandom
import java.util.concurrent.CancellationException

/** Worker-thread transport selection. Pairing and event cursors stay on the canonical Hub. */
internal class SalcaraIngressRouter {
  private data class Endpoint(val id: String, val url: String, val priority: Int)
  private data class Manifest(val hubId: String, val key: String, val revision: Long, val expires: Long, val endpoints: List<Endpoint>, val signed: Boolean)
  private var canonical = ""
  private var credentialScope = ""
  private var manifest: Manifest? = null
  private var refreshAt = 0L
  private val failed = HashMap<String, Long>()
  private val leases = HashMap<String, Long>()
  private val random = SecureRandom()

  fun fail(endpoint: String) { failed[endpoint] = System.currentTimeMillis() + 30_000; leases.remove(endpoint) }

  fun resolve(url: String, handedOver: JSONObject?, pairingScope: String = "", active: () -> Boolean): String {
    if (canonical != url || credentialScope != pairingScope) { canonical = url; credentialScope = pairingScope; manifest = null; refreshAt = 0; failed.clear(); leases.clear() }
    if (!validUrl(url)) return url
    val now = System.currentTimeMillis()
    // The caller hands over only a manifest previously read from the original
    // canonical HTTPS address. Validate its shape and expiration again here.
    try { if (handedOver != null) accept(parse(handedOver, url, now, true, false)) } catch (_: Exception) { }
    if (!active()) throw CancellationException()
    if (refreshAt <= now) {
      refreshAt = now + 60_000
      try {
        val next = parse(publicJson("$url/ingress/manifest", active), url, System.currentTimeMillis(), requireLogicalMembership = manifest == null)
        if (accept(next)) refreshAt = System.currentTimeMillis() + 6 * 60 * 60_000
      } catch (_: Exception) { }
    }
    if (!active()) throw CancellationException()
    val authority = manifest ?: return url
    require(authority.expires > System.currentTimeMillis()) { "Hub identity must be refreshed before sending pairing credentials" }
    var checks = 0
    for (endpoint in authority.endpoints.sortedBy { it.priority }) {
      if (!active()) throw CancellationException()
      if ((failed[endpoint.url] ?: 0) > System.currentTimeMillis()) continue
      if (endpoint.url != url && !authority.signed) continue
      if ((leases[endpoint.url] ?: 0) > System.currentTimeMillis()) return endpoint.url
      if (++checks > 3) break
      try {
        val nonce = ByteArray(32).also { random.nextBytes(it) }.joinToString("") { "%02x".format(it.toInt() and 255) }
        val proof = publicJson("${endpoint.url}/ingress/identity?nonce=$nonce", active)
        val checkedAt = System.currentTimeMillis()
        val issued = number(proof, "issued_at")
        val expires = number(proof, "expires_at")
        require(number(proof, "version") == 1L && proof.getString("hub_instance_id") == authority.hubId && proof.getString("nonce") == nonce)
        require(issued in (checkedAt - 30_000)..(checkedAt + 30_000) && expires > checkedAt && expires > issued && expires - issued <= 30_000 && authority.expires > checkedAt)
        val message = "salcara-ingress-proof-v1\n${authority.hubId}\n$nonce\n$issued\n$expires".toByteArray(Charsets.UTF_8)
        // Tink provides Ed25519 on supported Android versions without depending
        // on a platform provider. Any parsing or verification failure stays closed.
        Ed25519Verify(bytes(authority.key, 32)).verify(bytes(proof.getString("signature"), 64), message)
        if (!active()) throw CancellationException()
        leases[endpoint.url] = minOf(expires, authority.expires, checkedAt + 10_000)
        return endpoint.url
      } catch (error: CancellationException) { throw error }
      catch (_: Exception) { fail(endpoint.url) }
    }
    if (!active()) throw CancellationException()
    throw IllegalStateException("Cannot verify the saved Hub identity")
  }

  private fun accept(next: Manifest): Boolean {
    val previous = manifest
    if (previous != null && (previous.hubId != next.hubId || previous.key != next.key || previous.revision > next.revision || previous.signed && !next.signed)) return false
    if (previous != null && previous.revision == next.revision && previous.expires >= next.expires && (!next.signed || previous.signed)) return true
    manifest = next; leases.clear(); failed.clear()
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
    return Manifest(hubId, key, revision, expires, endpoints, signed)
  }

  private fun publicJson(url: String, active: () -> Boolean): JSONObject {
    if (!active()) throw CancellationException()
    val connection = URL(url).openConnection() as HttpURLConnection
    connection.instanceFollowRedirects = false
    connection.connectTimeout = 2500
    connection.readTimeout = 2500
    connection.setRequestProperty("Accept", "application/json")
    try {
      require(connection.responseCode in 200..299 && connection.url.toString() == url)
      require(connection.contentLengthLong <= 16_384)
      val body = connection.inputStream.use { input ->
        val output = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(2048)
        val deadline = System.nanoTime() + 2_500_000_000L
        while (true) {
          if (!active()) throw CancellationException()
          require(System.nanoTime() < deadline)
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
