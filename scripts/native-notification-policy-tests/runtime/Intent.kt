package android.content

class Intent {
  private val extras = mutableMapOf<String, Any>()
  fun putExtra(key: String, value: Long) = apply { extras[key] = value }
  fun putExtra(key: String, value: Boolean) = apply { extras[key] = value }
  fun putExtra(key: String, value: String) = apply { extras[key] = value }
  fun getLongExtra(key: String, default: Long) = extras[key] as? Long ?: default
  fun getBooleanExtra(key: String, default: Boolean) = extras[key] as? Boolean ?: default
  fun getStringExtra(key: String) = extras[key] as? String
}
