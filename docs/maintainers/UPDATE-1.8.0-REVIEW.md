# 2026-10-04 手机自动更新独立复查

历史维护记录；当时的待发布状态保留为审查证据，最终结果见 [1.8.0 发布验收](RELEASE-1.8.0-VERIFICATION.md)。用户更新方法见 [使用教程](../USER-GUIDE.zh.md)。

本次核验范围仅 Android 更新内核、发布工作流及相应测试；不改手机/桌面 UI、文案、样式或动效。CodeRabbit CLI 在 Windows 不受支持的失败已另记录；以下不是 CodeRabbit 审查结果。

## 发现并修复

1. **取消下载后的晚到安装窗口**：旧流程在验证完 APK 后异步转换 content URI、动态加载 Android intent launcher；这期间卸载组件/取消使 download AbortSignal 失效，但安装函数未检查，可能继续唤起安装器。现在 `src/apk-installer.ts` 在 URI await、动态 loader await 后和 OEM VIEW fallback 前检查同一 AbortSignal；`UpdateManager.tsx` 传递下载 signal，取消不转成“安装权限”流程。
2. **上版包身份不精确**：旧 CI 下载 `*.apk` 并取找到的第一个；同 Release 混有测试包时可能错误比对。现在只下载并选择 `salcara-image-android-${previous_tag}.apk`，旧 Release 存在却缺这个生产资产时直接失败。
3. **不同 tag 并行公告更新**：旧 concurrency group 按 ref 分开，两个版本可以同时写 updates 清单。现在按 repository 串行，`cancel-in-progress: false`，已运行发布不会被另一个版本打断。既有单调/同版本字节不可变检查保留。

安装逻辑只提取为可注入 URI resolver / loader 的小函数，生产仍只在 Android 动态加载 `expo-intent-launcher`；没有改成 iOS 可导入的静态依赖。仍由 Android 系统安装器显示确认、校验现有应用签名并阻止不兼容覆盖，不存在静默安装或绕过签名。

## 已核验并保持的逻辑

- 已取消的更新检查不会接受晚到 valid manifest；Android test applicationId 不取正式更新。
- 下载每个入口 90 秒无进度超时、有效进度续期、总 10 分钟上限。已安装 Expo SDK 57 的 JS / Android 原生实现支持 signal 取消、UUID 隔离及 progress 回调；没有使用不存在的原生选项。
- `.part` 临时文件、大小、ZIP 开头、流式 SHA-256 校验均保持；只有验证通过后才移到最终安装路径；取消/坏包不得安装。
- 清单只接受固定官方仓库、精确生产 APK 名/URL、稳定正式 Release、大小与 SHA-256；mirror 仅 HTTPS Salcara 域名且无 credentials/query/hash。
- 发布器只在正式 Release 已公开之后写清单，只把 HTTP 404 当初次发布，不吞权限/限流/网络失败；前版证书/包名/versionCode 校验保持。

## 验证

```text
node node_modules/jest/bin/jest.js src/__tests__/update-installer-lifecycle.test.tsx src/__tests__/apk-download.test.ts src/__tests__/update.test.ts src/__tests__/update-test-build.test.tsx --runInBand
4 套 / 30 项通过，0 失败

node --test scripts/update-manifest-core.test.mjs scripts/release-workflow-contract.test.mjs
7 项通过，0 失败

node node_modules/typescript/bin/tsc --noEmit
退出 0
```

新增安装测试覆盖：正常单次安装、URI await 期间取消、动态 loader await 期间取消、第一次安装器失败后取消禁止 VIEW fallback、未取消的 OEM fallback 与原始错误保留。新 workflow contract 测试在普通 CI 与发布 CI 都执行。

比对 `UpdateManager.tsx` 从 `const close = () => setPhase` 到文件末尾的所有 UI 状态文案、actions、JSX 与 styles：本次修改前后完全一致。

本地没有重复全量耗时回归；上一轮全量 920 项通过 + 真实 Panel 2 项通过已另记录，新增范围跑上述专项。APK、真实手机覆盖安装/未知来源授权、手机网络取消行为仍需 GitHub 构建和实机验收；单元测试不等价于设备验收。

## 本次 staging 清单

- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`
- `src/components/UpdateManager.tsx`
- `src/apk-installer.ts`
- `src/__tests__/update-installer-lifecycle.test.tsx`
- `scripts/release-workflow-contract.test.mjs`
- `docs/MOBILE-UPDATE-INDEPENDENT-REVIEW-20261004.md`

未 commit、push、创建 tag 或执行外部发布，由主代理统一纳入新源码并重新启动 GitHub APK 构建。
