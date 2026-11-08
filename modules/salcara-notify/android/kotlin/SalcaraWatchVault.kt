package expo.modules.salcaranotify

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

/** Device-bound, app-private storage. noBackupFilesDir excludes Android cloud/device transfer backups. */
internal object SalcaraWatchVault {
  private const val ALIAS = "salcara.remote.watch.v1"
  private fun file(context: Context) = AtomicFile(File(context.noBackupFilesDir, "remote-watch-v1.enc"))
  private fun key(create: Boolean): SecretKey? {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
    if (!create) return null
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
      init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256).setRandomizedEncryptionRequired(true).build())
    }.generateKey()
  }

  @Synchronized fun save(context: Context, snapshot: JSONObject): Boolean {
    if (SalcaraWatchRecovery.validate(snapshot, System.currentTimeMillis()) == null) { clear(context); return false }
    val target = file(context)
    var output: java.io.FileOutputStream? = null
    return try {
      val bytes = SalcaraWatchCipher.encrypt(snapshot.toString().toByteArray(Charsets.UTF_8), key(true) ?: return false)
      output = target.startWrite()
      output.write(bytes)
      target.finishWrite(output)
      true
    } catch (_: Exception) {
      output?.let { target.failWrite(it) }
      // Never restore an older credential after a failed update.
      clear(context)
      false
    }
  }

  @Synchronized fun load(context: Context): JSONObject? {
    return try {
      val bytes = file(context).openRead().use { input ->
        val buffer = java.io.ByteArrayOutputStream()
        val chunk = ByteArray(4096)
        while (true) {
          val count = input.read(chunk)
          if (count < 0) break
          if (buffer.size() + count > SalcaraWatchRecovery.MAX_BYTES + 29) throw IllegalArgumentException("Invalid watch size")
          buffer.write(chunk, 0, count)
        }
        buffer.toByteArray()
      }
      val snapshot = JSONObject(String(SalcaraWatchCipher.decrypt(bytes, key(false) ?: throw IllegalStateException("Missing watch key")), Charsets.UTF_8))
      SalcaraWatchRecovery.validate(snapshot, System.currentTimeMillis()).also { if (it == null) clear(context) }
    } catch (_: Exception) { clear(context); null }
  }

  @Synchronized fun clear(context: Context) {
    file(context).delete()
    // Retire the key as well: even if a filesystem deletion is interrupted,
    // a leftover checkpoint must never revive an explicitly stopped pairing.
    try { KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(ALIAS) } catch (_: Exception) { }
  }
}
