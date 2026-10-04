# 测试与设备验收

[开发指南](DEVELOPMENT.md) · [文档目录](README.md)

## 自动检查

在仓库根目录安装锁定依赖后执行：

~~~bash
node scripts/verify-release-version.mjs
npm run typecheck
npm test
node --test scripts/update-manifest-core.test.mjs scripts/release-workflow-contract.test.mjs
npx expo-doctor
~~~

普通 CI 还执行 Android prebuild。手机测试覆盖 API 请求、附件、存储、备份、语音、远程会话、问答、离线恢复和更新生命周期等；发布脚本测试包含真实 Bash 版本提取以及正式产物命名和清单约束。

测试通过不等于每个厂商设备、每个服务商或原生桌面接口都已验收。已有跳过项应单独列出，不能算作通过；不要通过删除用例或增加 skip 隐藏失败。历史结果见 [1.8.0 验收记录](maintainers/RELEASE-1.8.0-VERIFICATION.md)。

## 设备验收建议

- 首次安装、同签名正式升级、权限拒绝、卸载前备份与换机恢复。
- 添加、切换和删除手机 API；不同 Key、模型分组和协议的成功／失败情况。
- 文字、图片理解、文生图、参考图／蒙版编辑；PDF 和办公附件的正常与超限输入。
- 流式回答、取消、返回页面、网络中断、图片重新下载；重试前确认是否会产生新的模型调用。
- 语音与 Live；本地模型支持、下载取消、云端失败及系统后台行为。
- 编程首页、兼容 Hub 检查、二维码失效／重复扫码、多电脑切换、配对撤销。
- 会话列表、原历史读取、发送、新任务、API／模型切换、提问／审批、停止与子智能体摘要。
- 长离线、送达不确定、安全重试窗口、时钟变化；不得在无法确认时创建重复任务。
- 可选通知权限、电池管理和后台待命；不能假定退出 App 后一定收到推送。
- APK 下载中取消、入口超时、坏文件、大小／哈希错误、系统安装授权和不同签名拒绝。
- Codex、Claude Code 和 Claude Desktop 分别验收；只读 Chat/Cowork 不应出现可发送的能力保证。

使用测试项目和专用 API Key；付费模型／图片调用必须获得密钥持有者同意并限制次数。无需为测试指定真实用户任务、服务器或固定提示词，日志和截图提交前必须脱敏。
