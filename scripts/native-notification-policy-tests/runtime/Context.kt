package android.content

import android.app.NotificationManager
import java.io.File

/** JVM fixture, not Android runtime code. */
open class Context(val noBackupFilesDir: File = java.nio.file.Files.createTempDirectory("salcara-service-fixture-").toFile()) {
  val manager = NotificationManager()
  var allowed = true
  var foreground = false
  fun getSystemService(name: String): Any = manager
  companion object { const val NOTIFICATION_SERVICE = "notification" }
}
