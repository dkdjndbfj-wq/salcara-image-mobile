package expo.modules.salcarapdf

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.ParcelFileDescriptor
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.UUID
import kotlin.math.max
import kotlin.math.roundToInt

private const val MAX_PAGES = 12
private const val MAX_EDGE = 1600
private const val MAX_BYTES = 20L * 1024L * 1024L
private const val RENDER_DIRECTORY = "salcara-pdf-renders"

class SalcaraPdfModule : Module() {
  // Rendering is serialized; at most one page bitmap is retained by this module.
  private val renderLock = Any()

  override fun definition() = ModuleDefinition {
    Name("SalcaraPdf")
    AsyncFunction("renderPdfAsync") { uri: String ->
      synchronized(renderLock) {
        val context = appContext.reactContext
          ?: throw pdfError("ERR_PDF_CONTEXT", "PDF 解析暂不可用，请重新打开应用")
        renderPdf(context, uri)
      }
    }.runOnQueue(Queues.DEFAULT)
  }

  private fun renderPdf(context: Context, rawUri: String): Map<String, Any> {
    var outputDirectory: File? = null
    var completed = false
    try {
      val source = privateSource(context, rawUri)
      val descriptor = ParcelFileDescriptor.open(source, ParcelFileDescriptor.MODE_READ_ONLY)
      // PdfRenderer owns the descriptor after successful construction.
      val renderer = try { PdfRenderer(descriptor) } catch (error: Throwable) {
        descriptor.close()
        throw error
      }
      renderer.use { pdf ->
        val count = pdf.pageCount
        if (count <= 0) throw pdfError("ERR_PDF_EMPTY", "PDF 没有可读取的页面")
        if (count > MAX_PAGES) throw pdfError("ERR_PDF_PAGES", "PDF 共 ${count} 页，最多支持 ${MAX_PAGES} 页；请先拆分文件，不会只处理部分页面")

        val cache = context.cacheDir.canonicalFile
        val root = File(cache, RENDER_DIRECTORY)
        if (root.canonicalFile != root.absoluteFile || (root.exists() && !root.isDirectory)) {
          throw pdfError("ERR_PDF_CACHE", "PDF 缓存目录不可用，请重新打开应用")
        }
        if (!root.exists() && !root.mkdir()) throw IOException("Cannot create PDF cache")
        val destination = File(root, UUID.randomUUID().toString())
        if (!destination.mkdir()) throw IOException("Cannot create unique PDF cache")
        outputDirectory = destination

        val pages = ArrayList<Map<String, Any>>(count)
        var totalBytes = 0L
        for (index in 0 until count) {
          pdf.openPage(index).use { page ->
            if (page.width <= 0 || page.height <= 0) throw pdfError("ERR_PDF_PAGE", "PDF 第 ${index + 1} 页尺寸无效，请重新导出 PDF")
            val scale = MAX_EDGE.toDouble() / max(page.width, page.height).toDouble()
            val width = (page.width * scale).roundToInt().coerceIn(1, MAX_EDGE)
            val height = (page.height * scale).roundToInt().coerceIn(1, MAX_EDGE)
            val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            try {
              bitmap.eraseColor(Color.WHITE)
              val matrix = Matrix().apply { setScale(width.toFloat() / page.width, height.toFloat() / page.height) }
              page.render(bitmap, null, matrix, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
              val target = File(destination, "page-${(index + 1).toString().padStart(3, '0')}.jpg")
              FileOutputStream(target).use { output ->
                if (!bitmap.compress(Bitmap.CompressFormat.JPEG, 90, output)) throw IOException("Cannot encode PDF page")
              }
              val bytes = target.length()
              if (bytes <= 0L) throw IOException("Empty PDF page image")
              totalBytes += bytes
              if (totalBytes > MAX_BYTES) throw pdfError("ERR_PDF_SIZE", "PDF 页面图片合计超过 20MB，请拆分文件后重试；本次未上传任何页面")
              pages.add(mapOf("uri" to Uri.fromFile(target).toString(), "page" to index + 1, "width" to width, "height" to height, "size" to bytes))
            } finally {
              bitmap.recycle()
            }
          }
        }
        val result = mapOf("directory" to Uri.fromFile(destination).toString(), "pageCount" to count, "pages" to pages)
        completed = true
        return result
      }
    } catch (error: CodedException) {
      throw error
    } catch (_: SecurityException) {
      throw pdfError("ERR_PDF_ENCRYPTED", "PDF 已加密或需要密码，请解除密码保护后重新导入")
    } catch (_: OutOfMemoryError) {
      throw pdfError("ERR_PDF_MEMORY", "PDF 页面过于复杂或设备内存不足，请拆分文件后重试")
    } catch (_: Exception) {
      throw pdfError("ERR_PDF_INVALID", "无法读取 PDF，文件可能已损坏、加密或存储空间不足；请重新导出 PDF 后再试")
    } finally {
      if (!completed) outputDirectory?.let { cleanupOwnDirectory(context, it) }
    }
  }

  private fun privateSource(context: Context, rawUri: String): File {
    val uri = Uri.parse(rawUri)
    if (uri.scheme != "file" || !uri.authority.isNullOrEmpty() || uri.query != null || uri.fragment != null) {
      throw pdfError("ERR_PDF_URI", "请先通过附件按钮导入 PDF；仅支持应用内保存的本地文件")
    }
    val source = File(uri.path ?: "").canonicalFile
    val allowedRoots = listOf(context.filesDir.canonicalFile, context.cacheDir.canonicalFile)
    if (allowedRoots.none { source.path.startsWith(it.path + File.separator) }) {
      throw pdfError("ERR_PDF_URI", "PDF 必须先导入应用私有目录")
    }
    if (!source.isFile || !source.canRead() || source.length() <= 0L) throw pdfError("ERR_PDF_MISSING", "本地 PDF 不存在或无法读取，请重新添加附件")
    if (source.length() > MAX_BYTES) throw pdfError("ERR_PDF_INPUT_SIZE", "PDF 超过 20MB，请缩小文件后重新导入")
    return source
  }

  private fun cleanupOwnDirectory(context: Context, directory: File) {
    try {
      val root = File(context.cacheDir.canonicalFile, RENDER_DIRECTORY).canonicalFile
      val target = directory.canonicalFile
      if (target.parentFile == root && target.name.matches(Regex("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"))) {
        target.deleteRecursively()
      }
    } catch (_: Exception) { /* Clean up only this render's disposable directory. */ }
  }

  private fun pdfError(code: String, message: String) = CodedException(code, message, null)
}
