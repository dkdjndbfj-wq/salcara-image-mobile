/** Switch failures are status messages, never raw transport/provider diagnostics. */
export function apiSwitchMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/待确认消息/.test(message)) return '请先核对待确认消息，再切换 API';
  if (/正在切换/.test(message)) return 'API 正在切换，请稍候';
  if (/运行中|进行中|正在处理任务|任务.*(?:结束|完成)|停止.*任务/.test(message)) return '请等待当前任务结束，再切换 API';
  if (/离线|不在线|未连接/.test(message)) return '电脑已断开连接，请连接后重试';
  if (/连接已切换|API 或连接已切换|归属不一致/.test(message)) return '连接或任务已变化，请刷新后重试';
  if (/已移除|不存在|没有这个 Agent|刷新|目录/.test(message)) return '配置已变化，请刷新后重新选择';
  if (/中转站|远程能力|远程/.test(message)) return '当前连接不支持此 API，请选择支持的中转站';
  return '暂未确认切换结果，请稍后重新选择';
}
