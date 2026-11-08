# 手机思考强度与触觉反馈修复（2026-10-13）

## 范围

仅修改远程编程现有模型/强度控件，不重设计布局、配色或动效，不调用真实模型。

## 已确认问题与修复

- 独立强度按钮此前普通点击只显示提示，需要发现长按手势才能调节。现支持轻点逐档循环；原有长按左右滑动、松手确认保留。
- 无障碍加减档未触发反馈，None / Minimal 没有振动定义，iOS 被整体禁用。现统一使用 `expo-haptics`，Android 使用系统选择/确认反馈，iOS 使用 selection/impact；所有有效档位以及恢复默认均有反馈。
- Android 原有 6–22 ms 定时振动改为系统语义反馈。旧二进制缺少原生模块时保留有界短振回退；原生触觉调用失败不会阻断选项或发送。
- 原生 Pressable 重入 `pressIn` 不再取消正在进行的滑动；长按松手尾随 `press`、取消后的迟到 `press` 不能再跳一档。会话、模型、API、能力目录、前后台切换的既有 epoch 防护保留。
- 普通点击/无障碍即时选档不再执行一次无用的原生截图；持续长按仍使用现有磨砂动画。
- 异步振动失败的回退有 revision 与前台检查，避免旧选择的迟到反馈覆盖新操作。

## 能力与发送边界

不按模型名推测能力。强度仍仅使用 `source=codex-model-list`、`reasoningKnown=true` 中实际报告的档位；不为 Claude 虚构 Codex 参数。模型圆弧的选中、独立强度、偏好存储和 start/send 使用同一有效值；原有不可用档位清理、API 隔离和原回执冻结逻辑不变。

## 依赖

新增 `expo-haptics ~57.0.3`，与仓库 Expo SDK 57 的 `bundledNativeModules.json` 一致。锁文件只新增该包，没有升级其他依赖。

官方依据：[Expo Haptics](https://docs.expo.dev/versions/latest/sdk/haptics/)：推荐匹配 Expo SDK 安装版本，Android 优先使用 `performAndroidHapticsAsync`。原生模块须随新的 APK/iOS 构建打包。用户系统关闭触觉、设备不支持或 iOS 省电等情况下可能没有物理振动，不强行绕过系统偏好。

## 验证

- TypeScript 检查通过。
- 完整定向 4 套、226 项通过，涵盖 `remote-haptics`、`remote-effort-scrub-boundary`、`remote-effort-new`、`remote-thread-dialogue-new`。
- 最后取消触摸与即时截图优化后：typecheck 再次通过；3 套小测试 42 项通过（7.332 秒）；ThreadView 强度相关 18 项通过、167 项按筛选跳过（17.591 秒）。未将筛选跳过记为通过。
- 验证均为合成原生事件/模拟网络，无真实 Key、付费模型请求或真机触感验收；没有发布 APK。
- 最终 `npm run typecheck` 及 `npm test -- --silent` 通过：104 个测试套件、1,710 项测试；仓库已有 8 个套件 / 8 项测试跳过，未计入通过（627.294 秒）。
