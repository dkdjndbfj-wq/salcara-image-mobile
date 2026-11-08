# 远程链路第二轮：手机连接与通知生命周期

日期：2026-10-16。此报告记录本轮新增复核，不替代此前报告。

## 范围

检查手机冷启动恢复、重叠扫码、连接选择持久化、通知后台服务和推送登记；
交叉核实 Hub 新增的配对保存失败合同。保留既有界面风格，只补必要错误状态。
本轮没有打包、发布或运行手机端全量测试。

## 已复现并修复

| 触发场景 | 原问题 | 当前处理 |
| --- | --- | --- |
| 旧版站点启动读取尚未结束，用户已扫码切到新站点 | 迟到的选择、API Key 或配对 token 读取会改回旧 serviceId，甚至实际 hub 与当前界面站点不一致 | 在每个异步恢复点校验连接世代、当前服务及连接归属 |
| 同站点同电脑连续扫码，较旧的 HTTP 回执较晚到达 | 旧 token 覆盖已保存的新 token，当前内存仍用新 token，重启后失效 | 同站点/电脑按最新交换序号保存，检查放入既有持久化串行队列；其它电脑的成功凭证仍可留存 |
| 直接扫码成功发布 ready 状态 | 发布时 hub/能力尚未设置，通知订阅只能看到无凭证状态 | ready 状态、hub 与能力一起发布 |
| 扫码后正在写入启动选择，用户关闭扫码页 | 写入返回后仍会切换当前电脑 | 页面有效性同时纳入启动选择写前、写后校验；新凭证留存，当前选择不变 |
| 原生任务观察/后台待命启动慢，App 先进入后台 | 唯一一次后台事件发生时服务还未确认，之后一直没有交接连接 | 启动回执后再次检查服务世代与当前前后台状态，补交接当前连接 |
| 后台待命偏好读取或写入较慢；服务启动中被关闭 | 迟到读取/较早写入复活旧偏好，或物理服务迟到启动后无人停止 | 偏好读取有修改序号，写入串行；启动中关闭也会停止迟到服务，并保留必要的任务观察 |
| A 站已推送登记成功，切 B 站登记失败 | 沿用 A 的 fcm 成功状态，误报关闭 App 后可接收提醒，并抑制备用待命 | 退休旧登记时清除成功状态；当前登记失败显示“推送连接暂时不可用” |

这些问题先以旧代码失败的行为回归确认，再实施修复。没有以放宽来源校验或
重新派发不确定请求的方式绕过失败。

## Hub 合同交叉核实

- QR `/app/pair/qr` 与旧配对码 `/app/pair/confirm` 的
  `503 pair_persistence_failed`、`409 pair_state_changed` 保留原始错误文字、状态和 code。
- 手机请求层不自动重试这两个接口；同一二维码的并发摄像头回调只发一次 HTTP。
- 失败不替换现用连接，不清除现用凭证；扫码 UI 走错误分支，不显示配对成功。
- `pair_persistence_pending` 用于 Bridge 的状态/standby 接口，手机不直接消费。

## 最终源码验证

生产代码停止修改后，在同一最终源码上一次执行以下 **8 套，164 项全部通过**，
没有把前面失败复现、局部重跑或上一轮结果重复计数：

- `src/__tests__/remote-connection-lifecycle-races.test.ts`
- `src/__tests__/remote-notification-lifecycle.test.ts`
- `src/__tests__/remote-device-pairing.test.ts`
- `src/__tests__/remote-home-flow-new.test.tsx`
- `src/__tests__/remote-qr-camera.test.tsx`
- `src/__tests__/remote-station-navigation-new.test.ts`
- `src/__tests__/remote-long-offline.test.ts`
- `src/__tests__/remote-home-lifecycle-new.test.tsx`

`npm run typecheck` 和本轮修改文件的 `git diff --check` 通过。
最后两项边界修复之后，上述八套均已重新执行，不需要为本轮改动再补旧批次测试。

## 修改文件

- `src/remote/store.ts`：启动恢复与扫码提交归属。
- `src/remote/connections.ts`：凭证保存的归属条件。
- `src/remote/notifications.ts`：慢启动交接和迟到后台待命停止。
- `src/remote/push.ts`：偏好并发与当前推送登记状态。
- `src/remote/RemoteScreen.tsx`：必要错误文字。
- `src/__tests__/remote-connection-lifecycle-races.test.ts`：新增连接竞态、发布顺序及 Hub 错误合同回归。
- `src/__tests__/remote-notification-lifecycle.test.ts`：扩展通知生命周期回归。
- `remote/docs/PROTOCOL.md`：补充相关约束。

## 验证边界

以上是带可控网络/存储延迟的 JavaScript 行为回归与静态类型检查。没有运行
Kotlin/Android 编译、真实 Firebase、Android 后台调度或实体机测试；本轮没有
修改 Kotlin。真实通知到达和系统服务行为仍需设备验收。Hub/Bridge 的测试由
相应代理负责，不计入本报告的 164 项。
