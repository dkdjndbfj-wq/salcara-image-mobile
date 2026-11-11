package android.app

import android.content.Context
import android.content.Intent
import android.os.IBinder

open class Service : Context() {
  var stopped = false
  var foregroundStarted = false
  var foregroundType = 0
  open fun onBind(intent: Intent?): IBinder? = null
  open fun onStartCommand(intent: Intent?, flags: Int, startId: Int) = 0
  open fun onTimeout(startId: Int) { }
  open fun onTimeout(startId: Int, fgsType: Int) { }
  open fun onDestroy() { }
  fun stopSelf() { stopped = true }
  fun stopSelf(startId: Int) { stopped = true }
  fun startForeground(id: Int, notification: Notification) { foregroundStarted = true; manager.notify(null, id, notification) }
  fun startForeground(id: Int, notification: Notification, type: Int) { foregroundType = type; startForeground(id, notification) }
  companion object { const val START_STICKY = 1; const val START_NOT_STICKY = 2 }
}
