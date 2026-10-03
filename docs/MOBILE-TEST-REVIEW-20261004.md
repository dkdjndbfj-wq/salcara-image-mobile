# 2026-10-04 手机发布测试复查（交给 Claude）

## 范围

本次只处理独立发布副本 `work/salcara-mobile-release-20261004` 的测试环境和过时断言，不修改 Claude 的原副本，也没有修改手机运行 UI、文案、布局、样式或动效。没有删除、跳过测试来消除失败。

原全量结果：77 套中 59 套通过、10 套失败、8 套原有跳过；741 项通过、179 项失败、8 项原有跳过。

## 修改与依据

| 文件 | 修改 | 依据 / 保留的验证 |
| --- | --- | --- |
| `package.json`、`src/jest.setup.ts` | Jest 使用 safe-area 包自带的官方测试 mock | 运行入口已有 SafeAreaProvider，孤立渲染测试缺宿主；不改运行入口 |
| `src/__tests__/memorybox.test.ts` | SQLite 测试 mock 实现事务方法，执行 BEGIN / COMMIT / ROLLBACK | 新运行实现调用 `withTransactionAsync`，旧 mock 缺方法；8 项实际数据库管线用例保持 |
| `src/__tests__/AppContext.test.tsx` | 按 role 取 user.prompt / assistant.text，并显式断言 assistant 保留原问题 prompt | `prompt || text` 错把助手携带的问题当回复；编辑、删除、附件保留/删除断言全部保留 |
| `src/__tests__/remote-question-dock-new.test.tsx` | 使用当前 640ms 时长常量等待；对照现有 bezier 曲线 | 不回改 Claude 已设计的动效；保留草稿、退出中到达新问题、无障碍与 reduce-motion 用例 |
| `src/__tests__/remote-dialogue-new.test.tsx` | 当前问答正文上限为 220px | 仅测试适配既有尺寸；没有改变问答卡高度 |
| `src/__tests__/remote-qr-camera.test.tsx` | AppDialog mock 渲染 children，电脑名称用包含匹配 | 电脑信息已从 message 移入 children；重复扫码 gate、扫码只接收 QR、确认前不得交换票据等断言全部保留 |
| `src/__tests__/remote-api-library-ui-new.test.tsx` | 电脑名称断言支持既有“电脑名 · 电脑密钥库”组合文案 | 只修测试取值，不改文案或界面 |
| `src/__tests__/remote-home-lifecycle-new.test.tsx` | parts mock 补齐 `osName` | 保留隐藏、重开、切站、切电脑、卸载后的旧入口不执行用例 |
| `src/__tests__/remote-api-picker-new.test.tsx` | 模拟当前 ProgrammingSheet 可见性与 dismissible；每次重置 setAgentApi mock 的 once 队列 | 清除跨测试假回执污染；提交只用电脑 opaque API handle、同会话、不重复提交、异步迟到、删除 key、失败重试等 34 项用例全部保留 |
| `src/__tests__/remote-home-flow-new.test.tsx` | 给 optional speech 独立手机语音 fixture；Agent/API 列表仍必须来自电脑；模拟当前 Panel / Sheet 宿主和 Pressable 语义；模拟 useRemote 数据更新重渲染；更新现有标题断言 | 手机语音 fixture 名称和模型不得出现在编程 API 目录；不删任何电脑密钥来源、扫码、导航、冷会话、安全生命周期测试 |
| `src/__tests__/remote-thread-dialogue-new.test.tsx` | 捕获真正问答 Pressable 提交回调而非旧 PrimaryButton；测试 host 保留 Pressable 回调/默认 accessible/disabled 合并；用当前强度 scrub 手势；阻塞期间允许按钮为“发送”或“排队发送”，但必须 disabled | 原同 tick 重复提交、晚到旧会话失败、隐藏/卸载/撤回问题后旧 JS 回调不得发出任务等断言继续执行，避免原测试捕获空回调造成假通过 |
| `src/__tests__/programming-panel-host-new.test.tsx` | 新增 2 项真实 ProgrammingPanel 原生容器回归，不 mock Panel | 验证隐藏/开启/关闭后内容挂载，以及保存锁定时拒绝 Android 返回、无关闭按钮，解锁后正常关闭；避免可控导航 host 掩盖真实容器问题 |

Pressable 测试 host 参考本地已安装 React Native 的实际语义：`accessible` 默认 true，`disabled` 合并到 accessibilityState；没有改变生产 Pressable。

## 复跑结果

- 原 77 套完整重跑：**69 套通过、0 套失败、8 套原有跳过；920 项通过、0 项失败、8 项原有跳过**。没有新增 skip。
- 随后补充的真实 ProgrammingPanel 套：**1 套 / 2 项通过**。两部分合计已验证 70 套 / 922 项通过。
- `tsc --noEmit` 在所有测试修改（含新真实 Panel 套）之后退出 0。
- 本地日志不纳入发布源码：`output/jest-full-adapted-20261004.json`、`output/jest-panel-host-20261004.json`。

## 不改 UI 的证据

以下运行文件与 Claude 原目录 `work/salcara-phone-dialog-review` 比对 SHA-256 均完全一致：

`ThreadView.tsx`、`RemoteScreen.tsx`、`ProgrammingUi.tsx`、`ComposerDissolve.tsx`、`QuestionDock.tsx`、`QuestionCard.tsx`、`ApiPicker.tsx`、`RemoteHome.tsx`、`EffortScrub.tsx`（全部位于 `src/remote`）。

本次测试排查没有引入新的手机运行内核修改。APK 自动更新内核及发布工作流是另一部分工作，记录在 `docs/PUBLISH-20261004.md`。

## 仍不能代替的验收

这些测试是合成宿主 / 单元回归，不是实机联网验收；8 套原有跳过也不能算执行通过。发布 CI、Android 正式签名及升级覆盖、真实手机与电脑配对、原生 Agent 接口、后台通知仍需分别验收，不因 Jest 全绿就宣称所有设备场景已验证。
