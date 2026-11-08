# 手机远程可靠性修复（2026-10-09）

本轮只修改远程内核和测试，没有修改手机端布局、文案或动画。

## 已完成

- `ThreadView` 的观察窗口到期会主动结束。打开对话后的 120 秒窗口结束后，不会因为没有新的 React 渲染而继续长轮询。
- 事件页的 `nextSeq` 不再信任过时的零值：客户端至少推进到本页有效事件的最大序号；负数或非安全整数游标会被拒绝，避免漏消息或乱序。
- 解除配对时同步删除该配对 scope 的图片缓存目录，SQLite 会话缓存和 Expo 文件缓存都不再残留旧图片。
- 图片消息采用可恢复事务：先保存待送达回执，再上传附件，确认上传完成后才发送任务。重启、网络中断或 Hub 丢回执时继续使用原 request ID 和附件 ID，不创建重复任务。
- 待上传图片只保存本地文件 URI、尺寸和附件 ID，不把 Base64 写入 SQLite；手机重启后按需读取本地文件。原文件消失时停止自动重试并保留原回执，避免空附件或无限轮询。
- 兼容旧版待送达记录：没有 `attachmentsUploaded` 字段的记录按“已经上传”处理。

## 验证

```text
npm run typecheck
npx jest src/__tests__/remote.test.ts src/__tests__/remote-history-recovery.test.ts src/__tests__/remote-cache-kernel-new.test.ts src/__tests__/remote-attachments-kernel.test.ts src/__tests__/remote-delivery.test.ts --runInBand --forceExit --silent
```

本轮新增并覆盖事件游标回退、非法序号、图片上传事务和恢复失败场景。真实 Hub 重启、电脑离线恢复、Android 进程被系统回收等仍需在发布前做设备级验收。
