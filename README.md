# Salcara AI

开源的 AI 手机工作台。使用你自己的 API，在手机上对话、创作图片、处理文件、语音交流；也可以配合 Salcara Desktop 和 Hub，在外出时查看电脑上的编程进度、继续已有任务。

Salcara 不提供模型账号或内置 API Key，不要求使用指定中转站。对话、图片和语音可以分别选择服务商；普通手机功能不需要部署服务器。

[下载 Android 安装包](https://github.com/dkdjndbfj-wq/salcara-image-mobile/releases/download/v1.8.0/salcara-image-android-v1.8.0.apk) · [全部版本](https://github.com/dkdjndbfj-wq/salcara-image-mobile/releases) · [使用教程](docs/USER-GUIDE.zh.md) · [远程编程教程](docs/REMOTE-PROGRAMMING.zh.md) · [反馈问题](https://github.com/dkdjndbfj-wq/salcara-image-mobile/issues)

## 可以做什么

- **助手**：文字对话、图片理解、文件分析和图片生成／编辑，在同一条会话里完成。
- **语音**：语音输入和 Live 语音交流；Android 可在支持的设备上下载本地识别模型，也可使用自己的云端语音 API。
- **聊天伙伴**：创建不同角色，每个角色拥有独立会话和可管理的记忆匣。
- **远程编程**：选择已配对的电脑、Agent 与电脑保存的 API，加载支持的项目和会话，查看历史并继续发送任务。
- **本地记录**：保存会话和附件，支持对话导出及备份恢复；手机助手 API Key 使用系统安全存储。
- **应用内更新**：检查正式版本，校验 Android 安装包的大小与 SHA-256，再交给系统确认安装。

功能取决于所选 API 的协议与模型能力。模型目录中出现某个名字，不代表它一定支持图片、工具调用或语音；API 调用费用由服务商收取。

## 下载与安装

当前正式提供 **Android APK**，支持 ARM64 与 ARMv7。下载文件是：

- salcara-image-android-v1.8.0.apk：手机安装包。
- [对应的 SHA-256 校验文件](https://github.com/dkdjndbfj-wq/salcara-image-mobile/releases/download/v1.8.0/salcara-image-android-v1.8.0.apk.sha256)：用于核对下载完整性。

在 Android 手机打开安装包，只为实际使用的下载来源授权“安装未知应用”，按系统提示安装。已经安装正式版时直接覆盖更新，不要先卸载；应用数据会继续沿用。不要用测试包或不同签名的包覆盖正式版。

GitHub 的 Source code 是源码，不是安装包。目前**没有面向普通用户的 iPhone / TestFlight 安装包**；iOS 源码构建说明仅供开发者使用，见 [iOS 开发指南](docs/IOS-MAC-BUILD.md)。

## 第一次使用

1. 打开应用，在 **设置 → API 管理** 添加服务商地址和密钥。
2. 选择这组 API 的对话模型；需要创作图片时，再选择绘图 API 和模型，可以与对话服务商不同。
3. 回到助手，直接输入问题，或添加图片／文件开始使用。

例如：“总结这份文件”“画一张竖版海报”“把刚才的图片改成夜景”。不需要在每条消息前重新选择功能。只配置图片服务时，可以直接生成图片；聊天、识图或文件分析还需要合适的对话模型。

模型配置、语音、聊天伙伴、备份与常见问题见 [完整使用教程](docs/USER-GUIDE.zh.md)。

## 手机远程编程（可选）

远程编程需要三部分：

| 项目 | 作用 |
| --- | --- |
| Salcara AI 手机 App | 查看项目、会话和进度，发送任务与处理支持的提问、审批 |
| [Salcara Desktop](https://github.com/dkdjndbfj-wq/salcara-desktop) | 连接这台电脑的 Agent 和项目，管理编程使用的 API |
| [Salcara Hub](https://github.com/dkdjndbfj-wq/salcara-hub-plugin) | 提供设备配对和消息中继，可由可信站点或自己部署 |

手机打开 **编程** 首页，选择绑定电脑；填写电脑端显示的 Hub 站点地址，检查兼容性后扫码配对。随后选择 Agent、确认电脑 API，进入项目与会话列表，点开原会话继续工作。不是一进入编程就强制绑定。

**编程使用电脑的 API 密钥库**。新增或修改密钥在电脑端进行，手机读取名称及模型目录并选择使用，不需要再建立一套手机编程密钥库。设备配对也不要求手机和电脑共用一把模型 API Key。

只要站点提供兼容 Hub 并允许该设备配对，就可以使用，不限于 Salcara 中转站用户。电脑必须联网、保持桌面 App 运行且不休眠。具体步骤见 [远程编程教程](docs/REMOTE-PROGRAMMING.zh.md)。

### 远程能力边界

这不是整台电脑的远程桌面或屏幕投影。Codex 支持的编程记录可通过后端继续；Claude Desktop 的 Code 会话通过 Claude Code 继续。普通 Chat / Cowork 只支持兼容的本地记录读取，不支持原生远程发送或停止。

原桌面窗口不保证即时刷新手机发送的内容；可使用“在电脑上打开”入口。子智能体、进度、问题和审批以 Agent 实际提供的接口与授权为准，不把一个工具的能力当成另一个工具的保证。

## 数据、更新与隐私

手机普通会话和附件保存在本机，必要内容会发送给你选择的 API 服务商。远程编程内容会经过你选择的 Hub；当前中继**不是端到端加密**，只连接自己管理或信任的站点。

在“关于与更新”检查新版本，下载和安装均需用户确认。备份不包含 API Key、电脑配对和应用设置；卸载前先导出需要保留的记录，换手机后需重新配置 API 和扫码绑定。

应用可能显示官方服务推荐，但不要求购买该服务，也不限制使用其他兼容 API。数据处理、语音和可选通知的说明见 [隐私说明](PRIVACY.md)。敏感问题请按 [安全政策](SECURITY.md) 私下反馈，不要在 Issue 中发布密钥、二维码或用户记录。

## 开发与贡献

这是完整的手机项目，正式源码统一维护在 main；安装包统一在本仓库 Releases 发布。桌面和 Hub 各自独立维护，手机仓库不再附带其旧内核。

构建、测试与目录说明见 [开发指南](docs/DEVELOPMENT.md)，更多文档见 [文档目录](docs/README.md)。欢迎提交 Issue 和 Pull Request；提交前请删除真实 API Key、配对凭证、私钥和设备配置。

## 许可

使用 [MIT 许可证](LICENSE)，可以按许可证使用、修改及分发，也可用于商业用途。依赖和第三方品牌仍遵循各自的许可证与权利；Salcara 是独立项目，不代表 Codex、Claude 等工具的官方产品。
