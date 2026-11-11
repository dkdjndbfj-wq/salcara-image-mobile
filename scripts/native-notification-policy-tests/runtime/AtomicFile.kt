package android.util

import java.io.File
import java.io.FileOutputStream
class AtomicFile(private val file: File) {
  fun startWrite(): FileOutputStream { if (failWrites) throw java.io.IOException("fixture storage failure"); file.parentFile.mkdirs(); return FileOutputStream(File(file.path + ".new")) }
  fun finishWrite(output: FileOutputStream) { output.close(); java.nio.file.Files.move(File(file.path + ".new").toPath(), file.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING) }
  fun failWrite(output: FileOutputStream) { output.close(); File(file.path + ".new").delete() }
  fun openRead() = file.inputStream()
  fun delete() { file.delete(); File(file.path + ".new").delete() }
  companion object { var failWrites = false }
}
