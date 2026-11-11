package expo.modules.salcaranotify

import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** The restart lease never outlives its original task, and never includes another pairing. */
internal object SalcaraWatchRecovery {
  const val TASK_TTL = 2L * 60 * 60 * 1000
  const val STANDBY_TTL = 7L * 24 * 60 * 60 * 1000
  const val MAX_BYTES = 128 * 1024
  private val scopePattern = Regex("ns1_[a-f0-9]{64}")

  /** Progress belongs to a particular handoff, not merely matching device IDs. */
  fun checkpointConfig(current: JSONObject, cursorOwner: JSONObject? = null, cursors: Map<String, Long> = emptyMap()): JSONObject {
    val result = JSONObject(current.toString())
    if (!current.optBoolean("standby") || current !== cursorOwner) return result
    val devices = result.optJSONArray("devices") ?: return result
    for (index in 0 until devices.length()) devices.optJSONObject(index)?.let {
      it.put("after", cursors[it.optString("deviceId")] ?: it.optLong("after", 0))
    }
    return result
  }

  /** The caller supplies an envelope already verified/exported by the router.
   * Replace only that public locator, never rebuild progress from a stale
   * handoff or renew the original credential lease. */
  fun withIngressManifest(snapshot: JSONObject, current: JSONObject, owner: JSONObject, verifiedManifest: JSONObject, now: Long): JSONObject? {
    if (current !== owner || validate(snapshot, now) == null) return null
    val stored = snapshot.getJSONObject("config")
    if (stored.optString("hubUrl").trimEnd('/') != current.optString("hubUrl").trimEnd('/')
      || stored.optString("navigationScope") != current.optString("navigationScope")
      || stored.optString("pairToken") != current.optString("pairToken") || stored.optString("key") != current.optString("key")) return null
    if (!verifiedManifest.has("signed_payload") || !verifiedManifest.has("signature")) return null
    return JSONObject(snapshot.toString()).also {
      it.getJSONObject("config").put("ingressManifest", JSONObject(verifiedManifest.toString()))
    }.takeIf { validate(it, now) != null }
  }

  fun agentDisplayName(tool: String): String = when (tool.lowercase()) {
    "codex" -> "Codex"
    "claude" -> "Claude Code"
    "deepseek-harness" -> "DeepSeek Harness"
    "hermes" -> "Hermes Agent"
    else -> "Agent"
  }

  /** Whitelist export; the router verifies the preserved signature before
   * returning this across the module boundary. Never serialize the config. */
  fun publicIngressInfo(config: JSONObject): JSONObject? {
    if (!validConfig(config)) return null
    val manifest = config.optJSONObject("ingressManifest") ?: return null
    val payload = manifest.opt("signed_payload") as? String ?: return null
    val signature = manifest.opt("signature") as? String ?: return null
    if (payload.isEmpty() || payload.length > 12_000 || signature.length != 88) return null
    return JSONObject().put("hubUrl", config.getString("hubUrl").trimEnd('/')).put("navigationScope", config.getString("navigationScope"))
      .put("manifest", JSONObject().put("signed_payload", payload).put("signature", signature))
  }

  fun create(config: JSONObject, startedAt: Long, standby: Boolean, now: Long): JSONObject? {
    if (!validConfig(config)) return null
    val start = if (startedAt > 0) startedAt else now
    val ttl = if (standby) STANDBY_TTL else TASK_TTL
    return validate(JSONObject().put("schema", 1).put("startedAt", start).put("expiresAt", start + ttl)
      .put("standby", standby).put("config", JSONObject(config.toString())), now)
  }

  fun validate(snapshot: JSONObject, now: Long): JSONObject? {
    if (snapshot.toString().toByteArray(Charsets.UTF_8).size > MAX_BYTES || snapshot.optInt("schema") != 1) return null
    val startedAt = snapshot.optLong("startedAt")
    val expiresAt = snapshot.optLong("expiresAt")
    val ttl = if (snapshot.optBoolean("standby")) STANDBY_TTL else TASK_TTL
    // A backwards clock jump cannot turn an expired credential into an unlimited lease.
    if (startedAt <= 0 || startedAt > now + 60_000 || expiresAt <= now || expiresAt <= startedAt || expiresAt - startedAt > ttl) return null
    val config = snapshot.optJSONObject("config") ?: return null
    if (!validConfig(config) || snapshot.optBoolean("standby") != config.optBoolean("standby")) return null
    return snapshot
  }

  fun validConfig(config: JSONObject): Boolean {
    if (!config.optBoolean("follow") || !scopePattern.matches(config.optString("navigationScope"))) return false
    if (config.toString().toByteArray(Charsets.UTF_8).size > MAX_BYTES - 1024) return false
    val url = try { URI(config.optString("hubUrl")) } catch (_: Exception) { return false }
    if (url.scheme !in listOf("https", "http") || url.host.isNullOrBlank() || url.rawUserInfo != null || url.rawQuery != null || url.rawFragment != null) return false
    val pairToken = config.optString("pairToken")
    val key = config.optString("key")
    if (pairToken.isBlank() && key.isBlank()) return false
    if (pairToken.length > 8192 || key.length > 8192 || pairToken.any { it < ' ' } || key.any { it < ' ' }) return false
    val items = if (config.optBoolean("standby")) config.optJSONArray("devices") else config.optJSONArray("sessions")
    if (items == null || items.length() !in 1..16) return false
    for (index in 0 until items.length()) {
      val item = items.optJSONObject(index) ?: return false
      if (!Regex("[A-Za-z0-9._-]{1,128}").matches(item.optString("deviceId"))) return false
      if (!config.optBoolean("standby")) {
        val session = item.optString("sessionKey")
        if (session.isEmpty() || session.length > 512 || session.any { it < ' ' || it == '|' } || item.optLong("after", 0) < 0) return false
      }
    }
    return true
  }
}

/** Authenticated encryption, with a format tag bound as AAD; ciphertext contains no readable credentials. */
internal object SalcaraWatchCipher {
  private val aad = "salcara-watch-recovery-v1".toByteArray(Charsets.UTF_8)
  fun encrypt(plain: ByteArray, key: SecretKey): ByteArray {
    require(plain.size <= SalcaraWatchRecovery.MAX_BYTES)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, key)
    cipher.updateAAD(aad)
    require(cipher.iv.size == 12)
    return byteArrayOf(1) + cipher.iv + cipher.doFinal(plain)
  }
  fun decrypt(bytes: ByteArray, key: SecretKey): ByteArray {
    require(bytes.size in 30..SalcaraWatchRecovery.MAX_BYTES + 29 && bytes[0] == 1.toByte())
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, bytes.copyOfRange(1, 13)))
    cipher.updateAAD(aad)
    return cipher.doFinal(bytes.copyOfRange(13, bytes.size))
  }
}
