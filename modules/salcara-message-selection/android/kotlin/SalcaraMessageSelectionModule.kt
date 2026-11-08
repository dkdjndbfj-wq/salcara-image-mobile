package expo.modules.salcaramessageselection

import android.os.Handler
import android.os.Looper
import android.graphics.Color
import android.graphics.Rect
import android.text.Spannable
import android.text.SpannableString
import android.text.Spanned
import android.text.style.BackgroundColorSpan
import android.view.ActionMode
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.TextView
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.lang.ref.WeakReference

/** Adds actions to Android's real text-selection toolbar without changing text. */
class SalcaraMessageSelectionModule : Module() {
  private val owners = mutableMapOf<String, MutableList<Binding>>()
  private val addId = View.generateViewId()
  private val askId = View.generateViewId()

  override fun definition() = ModuleDefinition {
    Name("SalcaraMessageSelection")
    Events("onSelectionAction")
    AsyncFunction("attach") { tag: Int, token: String, allowAsk: Boolean ->
      val root = try { appContext.findView<View>(tag) } catch (_: Exception) { null }
      if (root == null || token.length > 200) false
      else {
        val views = mutableListOf<TextView>()
        fun visit(view: View) {
          if (view is TextView && view !is EditText && view.isTextSelectable) views.add(view)
          else if (view is ViewGroup) for (index in 0 until view.childCount) visit(view.getChildAt(index))
        }
        visit(root)
        val old = owners[token] ?: mutableListOf()
        val current = mutableListOf<Binding>()
        views.forEachIndexed { index, view ->
          // A Fabric layout callback can bind the new owner before JS effect
          // cleanup detaches the old one. Never chain an inactive owner callback.
          val conflicts = owners.values.flatMap { it.toList() }.filter { it.token != token && it.view.get() === view }
          conflicts.forEach { conflict -> conflict.release(); owners[conflict.token]?.remove(conflict) }
          val reused = old.firstOrNull { it.view.get() === view && view.customSelectionActionModeCallback === it.callback }
          val binding = reused ?: Binding(view, token, index, allowAsk)
          binding.blockIndex = index
          binding.allowAsk = allowAsk
          current.add(binding)
        }
        old.filter { it !in current }.forEach { it.release() }
        owners[token] = current
        current.isNotEmpty()
      }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("detach") { token: String -> owners.remove(token)?.forEach { it.release() }; Unit }.runOnQueue(Queues.MAIN)
    AsyncFunction("highlight") { token: String, blockIndex: Int, start: Int, end: Int, expected: String ->
      owners[token]?.firstOrNull { it.blockIndex == blockIndex }?.highlight(start, end, expected) ?: false
    }.runOnQueue(Queues.MAIN)
    OnDestroy {
      Handler(Looper.getMainLooper()).post {
        owners.values.flatten().forEach { it.release() }
        owners.clear()
      }
    }
  }

  private inner class Binding(textView: TextView, val token: String, var blockIndex: Int, var allowAsk: Boolean) {
    val view = WeakReference(textView)
    private val previous = textView.customSelectionActionModeCallback
    private var active = true
    private var mode: ActionMode? = null
    private var selectedVersion: String? = null
    private var highlightedText: Spannable? = null
    private var highlightSpan: BackgroundColorSpan? = null
    private val clearHighlightTask = Runnable { clearHighlight() }
    val callback = object : ActionMode.Callback {
      override fun onCreateActionMode(actionMode: ActionMode, menu: Menu): Boolean {
        if (!active) return false
        if (previous?.onCreateActionMode(actionMode, menu) == false) return false
        mode = actionMode
        selectedVersion = view.get()?.text?.toString()
        populate(menu)
        return true
      }
      override fun onPrepareActionMode(actionMode: ActionMode, menu: Menu): Boolean {
        previous?.onPrepareActionMode(actionMode, menu)
        populate(menu)
        return true
      }
      override fun onActionItemClicked(actionMode: ActionMode, item: MenuItem): Boolean {
        if (item.itemId != addId && item.itemId != askId) return previous?.onActionItemClicked(actionMode, item) ?: false
        val target = view.get()
        if (!active || target == null || !target.isAttachedToWindow || owners[token]?.contains(this@Binding) != true
          || target.customSelectionActionModeCallback !== this || item.itemId == askId && !allowAsk) return true
        val rendered = target.text?.toString() ?: return true
        // Streaming/recycled text must never turn a stale selection into a different quote.
        if (rendered != selectedVersion) { actionMode.finish(); return true }
        val start = minOf(target.selectionStart, target.selectionEnd)
        val end = maxOf(target.selectionStart, target.selectionEnd)
        if (start < 0 || end <= start || end > rendered.length) return true
        val selected = rendered.substring(start, end)
        if (selected.isBlank()) return true
        sendEvent("onSelectionAction", mapOf(
          "token" to token, "action" to if (item.itemId == addId) "add" else "ask",
          "text" to selected, "start" to start, "end" to end,
          "blockIndex" to blockIndex, "renderedText" to rendered
        ))
        actionMode.finish()
        return true
      }
      override fun onDestroyActionMode(actionMode: ActionMode) {
        previous?.onDestroyActionMode(actionMode)
        mode = null
        selectedVersion = null
      }
    }
    init { textView.customSelectionActionModeCallback = callback }
    private fun populate(menu: Menu) {
      if (menu.findItem(addId) == null) menu.add(Menu.NONE, addId, 1, "添加到对话").setShowAsAction(MenuItem.SHOW_AS_ACTION_IF_ROOM)
      if (allowAsk) {
        if (menu.findItem(askId) == null) menu.add(Menu.NONE, askId, 2, "在侧边聊天中提问").setShowAsAction(MenuItem.SHOW_AS_ACTION_IF_ROOM)
      } else menu.removeItem(askId)
    }
    fun highlight(start: Int, end: Int, expected: String): Boolean {
      val target = view.get() ?: return false
      val text = target.text ?: return false
      val layout = target.layout ?: return false
      if (!active || !target.isAttachedToWindow || target.customSelectionActionModeCallback !== callback
        || start < 0 || end <= start || end > text.length || text.subSequence(start, end).toString() != expected) return false
      clearHighlight()
      val spannable = text as? Spannable ?: run {
        target.setText(SpannableString(text), TextView.BufferType.SPANNABLE)
        target.text as? Spannable ?: return false
      }
      val span = BackgroundColorSpan(Color.argb(100, 255, 196, 71))
      spannable.setSpan(span, start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      highlightedText = spannable
      highlightSpan = span
      target.invalidate()
      val line = layout.getLineForOffset(start)
      val left = layout.getPrimaryHorizontal(start).toInt() + target.compoundPaddingLeft
      target.requestRectangleOnScreen(Rect(left, layout.getLineTop(line) + target.compoundPaddingTop,
        left + 2, layout.getLineBottom(line) + target.compoundPaddingTop), true)
      target.postDelayed(clearHighlightTask, 2600)
      return true
    }
    private fun clearHighlight() {
      val target = view.get()
      target?.removeCallbacks(clearHighlightTask)
      highlightSpan?.let { highlightedText?.removeSpan(it) }
      highlightedText = null
      highlightSpan = null
      target?.invalidate()
    }
    fun release() {
      active = false
      clearHighlight()
      mode?.finish()
      val target = view.get()
      if (target?.customSelectionActionModeCallback === callback) target.customSelectionActionModeCallback = previous
    }
  }
}
