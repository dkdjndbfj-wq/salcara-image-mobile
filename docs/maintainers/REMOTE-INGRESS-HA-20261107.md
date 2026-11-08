# 手机透明多入口验证（2026-11-07）

## 实现范围

- `src/remote/ingress.ts`：原 HTTPS 地址发布的清单、期限与结构校验、持久缓存恢复、备用入口随机 nonce 与 Ed25519 签名验证、优先级、失败冷却、并发证明合并、10 秒短期证明缓存、最多三次入口检查、GET 一次故障切换。公开响应限制 16 KiB，单次公开查询超时 2.5 秒。
- `src/remote/client.ts`：HTTP 与 SSE 使用实际传输地址，业务对象仍保存 canonical URL。原 HTTPS 地址不做额外身份探测。SSE 保持原游标恢复，写入 POST 传输不重放。原业务层只读命令重试保持现有语义。
- `src/remote/notifications.ts` 与 `SalcaraWatchService.kt`：Android 前后台交接附带已验证的公开清单，后台原生选择备用入口。配对和通知命名空间、设备及会话游标不因入口变化而改变。
- `SalcaraIngressRouter.kt`：Android 使用 Tink 1.15.0 验签，不依赖不同 Android 版本的 Ed25519 系统提供者。只从原 canonical HTTPS 刷新清单，拒绝重定向、过期、错误身份、错误 nonce 和无效签名。

## 已执行验证

1. `npm run typecheck` 全量通过。
2. 六套 Jest 回归覆盖 ingress、HTTP/SSE、设备配对、送达回执、通知生命周期、连接诊断；真实签名使用 Node Ed25519 生成，由生产 Noble 验签实现校验。新增测试还覆盖并发合并、POST 不重放、认证错误不切换、过期清单、超长流式响应和无响应传输超时。
3. `scripts/test-native-ingress.ps1` 编译生产 Kotlin router，并以实际 Tink 验证 Java 生成的 Ed25519 签名。13 项合同检查全部通过。网络层使用受控 URL handler，未触碰公网用户服务。
4. 生产 `SalcaraIngressRouter.kt`、`SalcaraWatchService.kt` 用 Kotlin 2.1.20、Android 36 `android.jar`、实际 Tink jar 与现有通知模块接口直接编译通过。

原生合同检查复现命令：

```powershell
./scripts/test-native-ingress.ps1 `
  -TinkJar 'D:\salcara-proxy-pool-qa-20261107\tink-android-1.15.0.jar' `
  -OutputDirectory 'D:\salcara-proxy-pool-qa-20261107\mobile-ingress-contract'
```

`TinkJar` 来自 Maven Central 固定版本 `com.google.crypto.tink:tink-android:1.15.0`。脚本读取本机 Gradle 缓存中的编译器和 JSON 库，不下载依赖，也不写入生产状态。

## 尚未验证的边界

完整 Gradle 模块编译在 Android 工程配置阶段被本机 NDK 安装不完整阻挡：`ndk/27.1.12297006` 缺少 `source.properties`。中文项目路径检查已通过单次命令参数绕开，没有修改项目配置。直接 Kotlin 编译和 JVM 合同测试不能替代完整 APK 构建、签名、真机后台生命周期验证。

没有部署生产入口，没有使用管理员 VPN 凭据，也没有声称公网延迟已降低。管理员仍需部署可公开访问、证书有效且连接同一 Hub 的入口。只有出口代理订阅时，用户到 Hub 的入站链路不会自动经由机场节点。
