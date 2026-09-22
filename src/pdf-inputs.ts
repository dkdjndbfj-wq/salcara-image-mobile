import { requireOptionalNativeModule } from 'expo';
import { Directory, File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';

import { abortError } from './api/network';

export interface PdfRenderedPage {
  uri: string;
  /** One-based PDF page number. */
  page: number;
  width: number;
  height: number;
  size: number;
}

export interface PdfRenderResult {
  directory: string;
  pageCount: number;
  pages: PdfRenderedPage[];
}

type PdfModule = { renderPdfAsync(uri: string): Promise<PdfRenderResult> };
const knownRenderDirectories = new Set<string>();
const MAX_RENDER_BYTES = 20 * 1024 * 1024;
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';

function renderDirectory(uri: string): string | null {
  const root = new Directory(Paths.cache, 'salcara-pdf-renders').uri.replace(/\/+$/, '');
  const normalized = uri.replace(/\/+$/, '');
  const suffix = normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : '';
  return new RegExp(`^${UUID}$`).test(suffix) ? normalized : null;
}

/** Returns every page, or rejects before any API call; no partial document. */
export async function renderPdfPages(uri: string, signal?: AbortSignal): Promise<PdfRenderResult> {
  if (signal?.aborted) throw abortError();
  if (Platform.OS !== 'android') throw new Error('PDF 页面解析目前仅支持 Android 安装版');
  if (!uri.startsWith('file://')) throw new Error('请先通过附件按钮导入本地 PDF');
  const source = new File(uri);
  if (!source.exists || (source.size ?? 0) <= 0) throw new Error('本地 PDF 不存在，请重新添加附件');
  if ((source.size ?? 0) > MAX_RENDER_BYTES) throw new Error('PDF 超过 20MB，请缩小文件后重试');
  const native = requireOptionalNativeModule<PdfModule>('SalcaraPdf');
  if (!native) throw new Error('当前安装包缺少 PDF 页面解析组件，请安装最新完整 APK（Expo Go 不支持）');
  const result = await native.renderPdfAsync(uri);
  const directory = typeof result?.directory === 'string' ? renderDirectory(result.directory) : null;
  if (!directory) throw new Error('PDF 解析返回了无效缓存路径');
  knownRenderDirectories.add(directory);
  try {
    if (signal?.aborted) throw abortError();
    if (!Number.isInteger(result.pageCount) || result.pageCount < 1 || result.pageCount > 12
      || !Array.isArray(result.pages) || result.pages.length !== result.pageCount) {
      throw new Error('PDF 页面不完整，已停止处理；请重新导出或拆分为最多 12 页的 PDF');
    }
    let total = 0;
    result.pages.forEach((page, index) => {
      const expected = `${directory}/page-${String(index + 1).padStart(3, '0')}.jpg`;
      if (page.page !== index + 1 || page.uri !== expected
        || !Number.isInteger(page.width) || page.width < 1 || page.width > 1600
        || !Number.isInteger(page.height) || page.height < 1 || page.height > 1600
        || !Number.isSafeInteger(page.size) || page.size <= 0) throw new Error('PDF 页面解析结果无效，已停止处理');
      const file = new File(page.uri);
      if (!file.exists || file.size !== page.size) throw new Error('PDF 页面文件不完整，请重新解析');
      total += page.size;
    });
    if (total > MAX_RENDER_BYTES) throw new Error('PDF 页面图片合计超过 20MB，请拆分文件后重试');
    return result;
  } catch (error) {
    cleanupPdfRender(result);
    throw error;
  }
}

/** Delete only a UUID cache directory actually returned and registered above. */
export function cleanupPdfRender(result: PdfRenderResult): void {
  const directory = typeof result?.directory === 'string' ? renderDirectory(result.directory) : null;
  if (!directory || !knownRenderDirectories.has(directory)) return;
  try {
    const target = new Directory(directory);
    if (target.exists) target.delete();
    knownRenderDirectories.delete(directory);
  } catch { /* Retain registration so a later cleanup attempt can retry. */ }
}
