import ExpoModulesCore
import PDFKit
import UIKit

/**
 * Renders every page of a local PDF to JPEG files in a fresh cache folder:
 *   <Caches>/salcara-pdf-renders/<uuid>/page-001.jpg …
 * Same contract as the Android module (see src/pdf-inputs.ts): at most 12
 * pages, each side at most 1600 px, and either every page or an error — a
 * failed render removes its folder.
 */
public class SalcaraPdfModule: Module {
  private static let maxPages = 12
  private static let maxSide: CGFloat = 1600
  private static let maxSourceBytes: Int64 = 20 * 1024 * 1024

  public func definition() -> ModuleDefinition {
    Name("SalcaraPdf")

    AsyncFunction("renderPdfAsync") { (uri: String, promise: Promise) in
      do {
        promise.resolve(try SalcaraPdfModule.render(uri: uri))
      } catch let error as PdfRenderError {
        promise.reject(error.code, error.message)
      } catch {
        promise.reject("ERR_PDF_RENDER", "PDF 解析失败：\(error.localizedDescription)")
      }
    }
  }

  private static func sourceURL(_ uri: String) -> URL? {
    if uri.hasPrefix("file://"), let url = URL(string: uri), url.isFileURL { return url }
    if uri.hasPrefix("/") { return URL(fileURLWithPath: uri) }
    return nil
  }

  private static func render(uri: String) throws -> [String: Any] {
    guard let source = sourceURL(uri) else {
      throw PdfRenderError("ERR_PDF_SOURCE", "请先通过附件按钮导入本地 PDF")
    }
    let attributes = try? FileManager.default.attributesOfItem(atPath: source.path)
    let bytes = (attributes?[.size] as? NSNumber)?.int64Value ?? 0
    if bytes <= 0 { throw PdfRenderError("ERR_PDF_SOURCE", "本地 PDF 不存在，请重新添加附件") }
    if bytes > maxSourceBytes { throw PdfRenderError("ERR_PDF_SIZE", "PDF 超过 20MB，请缩小文件后重试") }

    guard let document = PDFDocument(url: source) else {
      throw PdfRenderError("ERR_PDF_OPEN", "无法打开这个 PDF，文件可能已损坏")
    }
    if document.isLocked {
      throw PdfRenderError("ERR_PDF_LOCKED", "这个 PDF 设置了密码，请先解除密码后再添加")
    }
    let pageCount = document.pageCount
    if pageCount < 1 { throw PdfRenderError("ERR_PDF_EMPTY", "这个 PDF 没有页面") }
    if pageCount > maxPages {
      throw PdfRenderError("ERR_PDF_PAGES", "PDF 共 \(pageCount) 页，超过 12 页；请拆分为最多 12 页的 PDF")
    }

    let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
    let root = caches.appendingPathComponent("salcara-pdf-renders", isDirectory: true)
    let directory = root.appendingPathComponent(UUID().uuidString.lowercased(), isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: nil)
    // expo-file-system reports directories with a trailing slash; JS strips it again.
    let directoryUri = directory.absoluteString.hasSuffix("/") ? String(directory.absoluteString.dropLast()) : directory.absoluteString

    do {
      var pages: [[String: Any]] = []
      for index in 0..<pageCount {
        let entry: [String: Any] = try autoreleasepool {
          guard let page = document.page(at: index), let cgPage = page.pageRef else {
            throw PdfRenderError("ERR_PDF_PAGE", "第 \(index + 1) 页无法读取")
          }
          let name = String(format: "page-%03d.jpg", index + 1)
          let file = directory.appendingPathComponent(name, isDirectory: false)
          let (data, width, height) = try renderPage(cgPage, index: index)
          try data.write(to: file, options: .atomic)
          return [
            "uri": "\(directoryUri)/\(name)",
            "page": index + 1,
            "width": width,
            "height": height,
            "size": data.count,
          ]
        }
        pages.append(entry)
      }
      return ["directory": directoryUri, "pageCount": pageCount, "pages": pages]
    } catch {
      try? FileManager.default.removeItem(at: directory)
      throw error
    }
  }

  /** Draws one page on white at up to 1600 px on the long side, honouring /Rotate and the crop box. */
  private static func renderPage(_ page: CGPDFPage, index: Int) throws -> (Data, Int, Int) {
    let box = page.getBoxRect(.cropBox)
    let rotation = ((Int(page.rotationAngle) % 360) + 360) % 360
    let quarterTurn = rotation == 90 || rotation == 270
    let pageWidth = quarterTurn ? box.height : box.width
    let pageHeight = quarterTurn ? box.width : box.height
    if pageWidth <= 0 || pageHeight <= 0 {
      throw PdfRenderError("ERR_PDF_PAGE", "第 \(index + 1) 页尺寸无效")
    }
    let scale = maxSide / max(pageWidth, pageHeight)
    let width = max(1, min(Int(maxSide), Int((pageWidth * scale).rounded(.down))))
    let height = max(1, min(Int(maxSide), Int((pageHeight * scale).rounded(.down))))

    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    format.opaque = true
    let size = CGSize(width: width, height: height)
    let image = UIGraphicsImageRenderer(size: size, format: format).image { context in
      UIColor.white.setFill()
      context.fill(CGRect(origin: .zero, size: size))
      let cg = context.cgContext
      cg.saveGState()
      // UIKit's origin is top-left; PDF's is bottom-left.
      cg.translateBy(x: 0, y: CGFloat(height))
      cg.scaleBy(x: CGFloat(width) / pageWidth, y: -CGFloat(height) / pageHeight)
      // A 1:1 target rect: getDrawingTransform never scales up, so scaling is done above.
      let transform = page.getDrawingTransform(.cropBox, rect: CGRect(x: 0, y: 0, width: pageWidth, height: pageHeight), rotate: 0, preserveAspectRatio: true)
      cg.concatenate(transform)
      cg.interpolationQuality = .high
      cg.setRenderingIntent(.defaultIntent)
      cg.drawPDFPage(page)
      cg.restoreGState()
    }
    guard let data = image.jpegData(compressionQuality: 0.85), !data.isEmpty else {
      throw PdfRenderError("ERR_PDF_ENCODE", "第 \(index + 1) 页图片编码失败")
    }
    return (data, width, height)
  }
}

private struct PdfRenderError: Error {
  let code: String
  let message: String
  init(_ code: String, _ message: String) {
    self.code = code
    self.message = message
  }
}
