package expo.modules.salcaranotify

import android.content.Context
import org.json.JSONObject

/** No network, platform keystore or service scheduling is exercised by these recording fixtures. */
internal object SalcaraWatchVault {
  var saved: JSONObject? = null
  fun load(context: Context) = saved?.let { JSONObject(it.toString()) }
  fun peek(context: Context) = load(context)
  fun save(context: Context, value: JSONObject): Boolean { saved = JSONObject(value.toString()); return true }
  fun clear(context: Context) { saved = null }
}
internal class SalcaraIngressRouter {
  fun resolve(url: String, handed: JSONObject?, scope: String, active: () -> Boolean): String { check(active()); return url }
  fun fail(url: String) { }
  fun recoverySnapshot(url: String, scope: String, handed: JSONObject?, persisted: JSONObject? = null): JSONObject? = null
  fun publicRecoverySnapshot(value: JSONObject): JSONObject? = null
}
