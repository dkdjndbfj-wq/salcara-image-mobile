/** Which part of a turn failed, so the message can say so (“读取附件时出错：…”). */
export type ErrorStage = 'attachments' | 'chat' | 'drawing';

const PREFIX: Record<ErrorStage, string> = { attachments: '读取附件时出错：', chat: '对话模型出错：', drawing: '绘图服务出错：' };

/** Marks an error with its stage. The first mark wins: a drawing failure inside a chat turn stays a drawing failure. */
export function tagErrorStage<T>(error: T, stage: ErrorStage): T {
  if (error instanceof Error && error.name !== 'AbortError' && !(error as Error & { stage?: ErrorStage }).stage) {
    try { Object.assign(error, { stage }); } catch { /* frozen error */ }
  }
  return error;
}

export function errorStage(error: unknown): ErrorStage | undefined {
  return error instanceof Error ? (error as Error & { stage?: ErrorStage }).stage : undefined;
}

/** `message` with its stage's prefix, once. */
export function withStagePrefix(message: string, error: unknown): string {
  const stage = errorStage(error);
  if (!stage || !message || Object.values(PREFIX).some((prefix) => message.startsWith(prefix))) return message;
  return `${PREFIX[stage]}${message}`;
}
