package expo.modules.salcaraskillinput

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.Spanned
import android.text.Layout
import android.text.StaticLayout
import android.text.TextWatcher
import android.text.style.ReplacementSpan
import android.util.Base64
import android.view.View
import android.widget.EditText
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.lang.ref.WeakReference
import kotlin.math.ceil

/** Draw over canonical text without adding marker characters or changing IME offsets. */
class SalcaraSkillInputModule : Module() {
  private val bindings = mutableMapOf<Int, InputBinding>()

  override fun definition() = ModuleDefinition {
    Name("SalcaraSkillInput")
    AsyncFunction("setMentions") { tag: Int, expected: String, entries: List<Map<String, Any?>>, promise: Promise ->
      // Expo's public resolver also reaches Fabric inputs inside modal roots.
      val input = try { appContext.findView<View>(tag) as? EditText } catch (_: Exception) { null }
      bindings.remove(tag)?.release()
      if (input == null || entries.size > 8) promise.resolve(null)
      else InputBinding(tag, input, expected, entries, promise).also { bindings[tag] = it; it.schedule() }
    }.runOnQueue(Queues.MAIN)
    OnDestroy {
      Handler(Looper.getMainLooper()).post {
        bindings.values.toList().forEach { it.release() }
        bindings.clear()
      }
    }
  }

  /** Fabric may submit text after the JS layout effect and the first posted task.
   * Wait for that exact text via the public watcher, without changing IME text. */
  private inner class InputBinding(private val tag: Int, input: EditText, private val expected: String,
    private val entries: List<Map<String, Any?>>, private val promise: Promise) : TextWatcher, View.OnAttachStateChangeListener {
    private val view = WeakReference(input)
    private var active = true
    private var applying = false
    private var settled = false
    private val task = Runnable {
      val target = view.get()
      if (active && bindings[tag] === this && target != null && target.text?.toString() == expected) {
        applying = true
        try {
          applyMentions(target, expected, entries)
          // Fabric measures before these external spans exist. Report the real
          // decorated height rather than touching private RN measurement APIs.
          val width = target.width - target.compoundPaddingLeft - target.compoundPaddingRight
          val text = target.text
          val height = if (text != null && width > 0) StaticLayout.Builder.obtain(text, 0, text.length, target.paint, width)
            .setAlignment(Layout.Alignment.ALIGN_NORMAL).setIncludePad(target.includeFontPadding)
            .setLineSpacing(target.lineSpacingExtra, target.lineSpacingMultiplier)
            .setBreakStrategy(target.breakStrategy).setHyphenationFrequency(target.hyphenationFrequency)
            .build().height + target.compoundPaddingTop + target.compoundPaddingBottom else 0
          if (!settled) { settled = true; promise.resolve(mapOf("height" to height / target.resources.displayMetrics.density)) }
        } finally { applying = false }
      }
    }
    init { input.addTextChangedListener(this); input.addOnAttachStateChangeListener(this) }
    fun schedule() {
      if (!active || applying) return
      view.get()?.let { it.removeCallbacks(task); it.post(task) }
    }
    override fun beforeTextChanged(text: CharSequence?, start: Int, count: Int, after: Int) = Unit
    override fun onTextChanged(text: CharSequence?, start: Int, before: Int, count: Int) = Unit
    override fun afterTextChanged(text: Editable?) { if (text?.toString() == expected) schedule() }
    override fun onViewAttachedToWindow(view: View) { schedule() }
    override fun onViewDetachedFromWindow(view: View) {
      if (bindings[tag] === this) bindings.remove(tag)
      release()
    }
    fun release() {
      active = false
      view.get()?.let { it.removeCallbacks(task); it.removeTextChangedListener(this); it.removeOnAttachStateChangeListener(this) }
      if (!settled) { settled = true; promise.resolve(null) }
    }
  }

  private fun applyMentions(input: EditText, expected: String, entries: List<Map<String, Any?>>) {
    val text = input.text ?: return
    if (text.toString() != expected || entries.size > 8) return
    text.getSpans(0, text.length, SkillSpan::class.java).forEach { text.removeSpan(it) }
    var previousEnd = 0
    for (entry in entries) {
      val start = (entry["start"] as? Number)?.toInt() ?: continue
      val end = (entry["end"] as? Number)?.toInt() ?: continue
      val name = entry["name"] as? String ?: continue
      val label = entry["label"] as? String ?: name
      if (start < previousEnd || start < 0 || end > text.length || end <= start || text.subSequence(start, end).toString() != "$$name"
        || label.length !in 1..200 || label.any { it.code < 32 || it.code == 127 }) continue
      val color = (entry["color"] as? String)?.takeIf { it.matches(Regex("#[0-9a-fA-F]{6}")) }?.let { Color.parseColor(it) } ?: Color.rgb(46, 130, 210)
      val bitmap = tinyPng(entry["iconSmall"] as? String)
      text.setSpan(SkillSpan(label, color, bitmap, input.resources.displayMetrics.density), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      previousEnd = end
    }
    input.invalidate()
    input.requestLayout()
  }

  private fun tinyPng(uri: String?): Bitmap? = try {
    if (uri == null || uri.length > 5486 || !uri.startsWith("data:image/png;base64,iVBORw0KGgo")) null
    else {
      val data = Base64.decode(uri.substring(22), Base64.NO_WRAP)
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeByteArray(data, 0, data.size, bounds)
      if (data.size > 4096 || bounds.outWidth !in 1..32 || bounds.outHeight !in 1..32 || bounds.outMimeType != "image/png") null
      else BitmapFactory.decodeByteArray(data, 0, data.size)
    }
  } catch (_: Exception) { null }
}

private class SkillSpan(private val label: String, private val color: Int, private val bitmap: Bitmap?, private val density: Float) : ReplacementSpan() {
  private fun labelPaint(paint: Paint) = Paint(paint).apply {
    color = this@SkillSpan.color
    typeface = if (Build.VERSION.SDK_INT >= 28) Typeface.create(paint.typeface, 500, false) else Typeface.create("sans-serif-medium", Typeface.NORMAL)
  }
  private fun iconSize(paint: Paint) = minOf(16f * density, paint.textSize)
  override fun getSize(paint: Paint, text: CharSequence, start: Int, end: Int, fm: Paint.FontMetricsInt?): Int =
    ceil(iconSize(paint) + 3f * density + labelPaint(paint).measureText(label)).toInt()

  override fun draw(canvas: Canvas, text: CharSequence, start: Int, end: Int, x: Float, top: Int, y: Int, bottom: Int, paint: Paint) {
    val ink = labelPaint(paint)
    val size = iconSize(paint)
    val iconTop = y + (paint.fontMetrics.ascent + paint.fontMetrics.descent - size) / 2f
    if (bitmap != null) canvas.drawBitmap(bitmap, null, RectF(x, iconTop, x + size, iconTop + size), Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG))
    else {
      canvas.save(); canvas.translate(x, iconTop); canvas.scale(size / 20f, size / 20f)
      val path = Path().apply {
        moveTo(10.8f, 1.9f); lineTo(4.2f, 6f); lineTo(4.2f, 14.5f); lineTo(8.8f, 18f); lineTo(15.8f, 13.7f); lineTo(15.8f, 5.1f); close()
        moveTo(4.2f, 6f); lineTo(8.8f, 9.1f); lineTo(15.8f, 5.1f)
        moveTo(8.8f, 9.1f); lineTo(8.8f, 18f)
        moveTo(4.2f, 10.7f); lineTo(8.8f, 13.8f); lineTo(15.8f, 9.6f)
      }
      canvas.drawPath(path, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = this@SkillSpan.color; style = Paint.Style.STROKE; strokeWidth = 1.35f; strokeJoin = Paint.Join.ROUND; strokeCap = Paint.Cap.ROUND })
      canvas.restore()
    }
    canvas.drawText(label, x + size + 3f * density, y.toFloat(), ink)
  }
}
