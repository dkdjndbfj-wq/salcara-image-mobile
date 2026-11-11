package expo.modules.salcaranotify

import android.content.Context
import org.json.JSONObject

/** No network, platform keystore or service scheduling is exercised by these recording fixtures. */
internal object SalcaraWatchVault {
  var saved: JSONObject? = null
  var lastReadFailure = ""
  fun load(context: Context): JSONObject? {
    lastReadFailure = ""
    val value = saved?.let { JSONObject(it.toString()) } ?: return null
    return SalcaraWatchRecovery.restore(value, System.currentTimeMillis()).also {
      if (it == null) { if (value.optJSONObject("config")?.let(SalcaraWatchRecovery::needsBotIdentity) == true) lastReadFailure = "identity"; saved = null }
    }
  }
  fun peek(context: Context) = saved?.let { SalcaraWatchRecovery.restore(JSONObject(it.toString()), System.currentTimeMillis()) }
  fun save(context: Context, value: JSONObject): Boolean { saved = JSONObject(value.toString()); return true }
  fun clear(context: Context) { saved = null }
}
