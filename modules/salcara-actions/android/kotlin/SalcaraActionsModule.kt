package expo.modules.salcaraactions

import android.content.ActivityNotFoundException
import android.content.Intent
import android.provider.AlarmClock
import android.provider.CalendarContract
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.Calendar

/**
 * Opens the system Clock and Calendar apps with typed extras. The generic
 * intent launcher passes every JS number as a Double, which AlarmClock and
 * CalendarContract ignore (they read Int / Long extras), so these three
 * intents are built natively. Nothing is scheduled silently: the Clock or
 * Calendar app shows the result and the user confirms there.
 */
class SalcaraActionsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("SalcaraActions")

    AsyncFunction("setAlarm") { hour: Int, minutes: Int, message: String, days: List<Int>, skipUi: Boolean ->
      if (hour !in 0..23 || minutes !in 0..59) throw CodedException("ERR_ARGUMENT", "闹钟时间不正确", null)
      val intent = Intent(AlarmClock.ACTION_SET_ALARM).apply {
        putExtra(AlarmClock.EXTRA_HOUR, hour)
        putExtra(AlarmClock.EXTRA_MINUTES, minutes)
        if (message.isNotBlank()) putExtra(AlarmClock.EXTRA_MESSAGE, message.take(60))
        val calendarDays = days.filter { it in 1..7 }.distinct().map { toCalendarDay(it) }
        if (calendarDays.isNotEmpty()) putIntegerArrayListExtra(AlarmClock.EXTRA_DAYS, ArrayList(calendarDays))
        putExtra(AlarmClock.EXTRA_SKIP_UI, skipUi)
      }
      start(intent, "没有找到可以设置闹钟的时钟应用")
    }

    AsyncFunction("setTimer") { seconds: Int, message: String, skipUi: Boolean ->
      if (seconds !in 1..86_400) throw CodedException("ERR_ARGUMENT", "倒计时时长不正确", null)
      val intent = Intent(AlarmClock.ACTION_SET_TIMER).apply {
        putExtra(AlarmClock.EXTRA_LENGTH, seconds)
        if (message.isNotBlank()) putExtra(AlarmClock.EXTRA_MESSAGE, message.take(60))
        putExtra(AlarmClock.EXTRA_SKIP_UI, skipUi)
      }
      start(intent, "没有找到可以设置倒计时的时钟应用")
    }

    AsyncFunction("insertEvent") { title: String, begin: Double, end: Double, allDay: Boolean, location: String, description: String ->
      val intent = Intent(Intent.ACTION_INSERT).apply {
        data = CalendarContract.Events.CONTENT_URI
        putExtra(CalendarContract.Events.TITLE, title.take(200))
        putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, begin.toLong())
        if (end > begin) putExtra(CalendarContract.EXTRA_EVENT_END_TIME, end.toLong())
        putExtra(CalendarContract.EXTRA_EVENT_ALL_DAY, allDay)
        if (location.isNotBlank()) putExtra(CalendarContract.Events.EVENT_LOCATION, location.take(300))
        if (description.isNotBlank()) putExtra(CalendarContract.Events.DESCRIPTION, description.take(4000))
      }
      start(intent, "没有找到日历应用")
    }
  }

  /** 1 = Monday … 7 = Sunday → java.util.Calendar constants (Sunday = 1). */
  private fun toCalendarDay(day: Int): Int = when (day) {
    7 -> Calendar.SUNDAY
    else -> Calendar.MONDAY + (day - 1)
  }

  private fun start(intent: Intent, missing: String): Boolean {
    // Android 10+ silently blocks activity starts from the background, so require a visible screen.
    val activity = appContext.currentActivity ?: throw CodedException("ERR_NO_ACTIVITY", "请回到 Salcara 界面后再试", null)
    try {
      activity.startActivity(intent)
    } catch (error: ActivityNotFoundException) {
      throw CodedException("ERR_NO_APP", missing, error)
    } catch (error: SecurityException) {
      throw CodedException("ERR_DENIED", "系统拒绝了这个操作：${error.message ?: ""}", error)
    }
    return true
  }
}
