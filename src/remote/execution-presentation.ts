import type { TimelineItem } from './store';
import { fileEdits } from './blocks';
import { formatDuration } from './thread-stats';
import {computerActionLabel,parseComputerActivity} from './computer-activity';

type Tool = Extract<TimelineItem, { kind: 'tool' }>;

/** Labels describe observed host events; missing counts/durations stay unknown. */
export function executionLabel(item: Tool, durationMs = item.durationMs): string {
  const running = item.status === 'running';
  const computer=parseComputerActivity(item.computer);
  if(computer)return `${computer.surface==='browser'?'浏览器操作':'电脑操作'} · ${computerActionLabel(computer)} · ${running?'正在执行':item.status==='done'?'已完成':item.status==='failed'?'失败':'已中断'}`;
  const target = item.title.replace(/^(?:正在|已经|已)?(?:运行|执行|读取|查看|搜索|编辑|修改|调用)\s*[·:：]?\s*/, '').trim();
  const duration = durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0 ? formatDuration(durationMs) : undefined;
  let label: string;
  switch (item.tool) {
    case 'command':
      // The summary title may only say "运行命令". Preserve the observed
      // command as the live preview; never manufacture it from a tool name.
      const command = running && item.detail?.trim() ? item.detail.trim().replace(/\s+/g,' ') : target;
      label = `${running ? '正在运行' : duration ? `已在 ${duration} 内运行` : '运行了命令'}${command ? ` ${command}` : ''}`;
      break;
    case 'file_change': {
      const files = fileEdits(item);
      const path = files.length === 1 ? files[0].path : `${files.length} 个文件`;
      label = `${running ? '正在编辑' : '编辑了'}${path ? ` ${path}` : '文件'}`;
      break;
    }
    case 'image_view': {
      const count = item.attachments?.length;
      label = running ? '正在查看图片' : count ? `已查看 ${count} 张图像` : '已查看图片';
      break;
    }
    case 'read': label = `${running ? '正在读取' : '已读取'}${target ? ` ${target}` : '文件'}`; break;
    case 'search': label = `${running ? '正在搜索' : '已搜索'}${target ? ` ${target}` : ''}`; break;
    default: label = item.title;
  }
  // An attempted action is never described as successfully completed on failure.
  if (item.status === 'failed' || item.status === 'interrupted') {
    const name = item.tool === 'command' ? '命令' : item.tool === 'file_change' ? '文件编辑' : item.tool === 'image_view' ? '图片查看' : '操作';
    return `${name}${item.status === 'failed' ? '失败' : '已中断'}${target ? ` · ${target}` : ''}${duration ? ` · ${duration}` : ''}`;
  }
  return label;
}
