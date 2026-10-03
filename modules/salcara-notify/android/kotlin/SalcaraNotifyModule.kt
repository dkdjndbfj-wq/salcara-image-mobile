package expo.modules.salcaranotify

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import expo.modules.interfaces.permissions.Permissions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging

/**
 * Local notifications for the 编程 space:
 * - notify(): "task finished / needs approval" with a tap that reopens that thread.
 * - startWatch()/stopWatch(): a low-priority foreground service that keeps the
 *   app process (and its single long-poll) alive only while a remote task runs.
 * Nothing here talks to the network; the JS side decides what to show.
 */
class SalcaraNotifyModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("React context lost")

  override fun definition() = ModuleDefinition {
    Name("SalcaraNotify")
    Events("onOpen", "onPushToken")

    OnCreate {
      tokenListener = { token -> try { sendEvent("onPushToken", mapOf("token" to token)) } catch (error: Exception) { } }
    }

    OnDestroy {
      tokenListener = null
    }

    // Firebase token for Hub push, or null when this build / phone cannot receive
    // Firebase messages (no google-services.json, or no Google Play services).
    AsyncFunction("pushToken") { promise: Promise ->
      try {
        val ready = FirebaseApp.getApps(context).isNotEmpty() || FirebaseApp.initializeApp(context) != null
        if (!ready) promise.resolve(null)
        else FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
          promise.resolve(if (task.isSuccessful) task.result?.takeIf { it.isNotEmpty() } else null)
        }
      } catch (error: Exception) {
        promise.resolve(null)
      }
    }

    // 后台待命: keep one quiet connection to the Hub for the whole computer.
    AsyncFunction("startStandby") {
      val intent = Intent(context, SalcaraWatchService::class.java).putExtra("standby", true)
      try {
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
        true
      } catch (error: Exception) {
        false
      }
    }

    Function("canNotify") {
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      val granted = Build.VERSION.SDK_INT < 33 ||
        context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
      granted && manager.areNotificationsEnabled()
    }

    AsyncFunction("requestPermission") { promise: Promise ->
      if (Build.VERSION.SDK_INT < 33) {
        promise.resolve(null)
      } else {
        Permissions.askForPermissionsWithPermissionsManager(appContext.permissions, promise, Manifest.permission.POST_NOTIFICATIONS)
      }
    }

    AsyncFunction("notify") { id: String, title: String, body: String, payload: String ->
      ensureChannels(context)
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      manager.notify(id.hashCode(), build(context, TASK_CHANNEL, title, body, payload, false))
    }

    AsyncFunction("startWatch") { title: String, body: String ->
      val intent = Intent(context, SalcaraWatchService::class.java).putExtra("title", title).putExtra("body", body)
      try {
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
        true
      } catch (error: Exception) {
        // Android 12+ refuses a foreground start from background; the caller falls back gracefully.
        false
      }
    }

    AsyncFunction("stopWatch") {
      SalcaraWatchService.config = null
      context.stopService(Intent(context, SalcaraWatchService::class.java))
    }

    // Sessions to follow natively while the app is in background. Kept in memory only.
    Function("configureWatch") { json: String ->
      SalcaraWatchService.config = try { org.json.JSONObject(json) } catch (error: Exception) { null }
    }

    // Runs on the module's background queue, not the JS thread. Used instead of
    // setTimeout, which React Native pauses while the app is in background.
    AsyncFunction("wait") { ms: Int ->
      Thread.sleep(ms.coerceIn(0, 30_000).toLong())
    }

    Function("consumeLaunchPayload") {
      val intent = appContext.currentActivity?.intent
      val payload = intent?.getStringExtra(EXTRA_PAYLOAD)
      if (payload != null) intent.removeExtra(EXTRA_PAYLOAD)
      payload
    }

    OnNewIntent { intent ->
      val payload = intent.getStringExtra(EXTRA_PAYLOAD)
      if (payload != null) {
        intent.removeExtra(EXTRA_PAYLOAD)
        sendEvent("onOpen", mapOf("payload" to payload))
      }
    }
  }

  companion object {
    /** Set while the JS module is alive; SalcaraPushService reports new Firebase tokens here. */
    @Volatile var tokenListener: ((String) -> Unit)? = null
    const val TASK_CHANNEL = "salcara_tasks"
    const val WATCH_CHANNEL = "salcara_watch"
    const val EXTRA_PAYLOAD = "salcara_notification"

    fun ensureChannels(context: Context) {
      if (Build.VERSION.SDK_INT < 26) return
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      manager.createNotificationChannel(NotificationChannel(TASK_CHANNEL, "编程任务", NotificationManager.IMPORTANCE_HIGH).apply {
        description = "电脑上的任务完成、失败或需要你批准时提醒"
      })
      manager.createNotificationChannel(NotificationChannel(WATCH_CHANNEL, "正在运行的任务", NotificationManager.IMPORTANCE_LOW).apply {
        description = "任务运行期间保持连接，完成后自动消失"
        setShowBadge(false)
      })
    }

    private fun smallIcon(context: Context): Int {
      val custom = context.resources.getIdentifier("notification_icon", "drawable", context.packageName)
      return if (custom != 0) custom else context.applicationInfo.icon
    }

    fun build(context: Context, channel: String, title: String, body: String, payload: String?, ongoing: Boolean, actions: List<Notification.Action> = emptyList()): Notification {
      val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)?.apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        if (payload != null) putExtra(EXTRA_PAYLOAD, payload)
      }
      val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0)
      val content = launch?.let { PendingIntent.getActivity(context, (payload ?: channel).hashCode(), it, flags) }
      val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(context, channel) else @Suppress("DEPRECATION") Notification.Builder(context)
      builder
        .setSmallIcon(smallIcon(context))
        .setContentTitle(title.take(80))
        .setContentText(body.take(200))
        .setStyle(Notification.BigTextStyle().bigText(body.take(400)))
        .setColor(0xFF3D7BFA.toInt())
        .setCategory(if (ongoing) Notification.CATEGORY_PROGRESS else Notification.CATEGORY_STATUS)
        .setOngoing(ongoing)
        .setOnlyAlertOnce(ongoing)
        .setAutoCancel(!ongoing)
      if (content != null) builder.setContentIntent(content)
      actions.forEach { builder.addAction(it) }
      return builder.build()
    }
  }
}
