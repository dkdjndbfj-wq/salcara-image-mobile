# Salcara AI

一个简洁的 Android / iPhone 通用 AI 客户端：默认以 ChatGPT 风格对话为主，支持文字问答、图片理解、文件分析和图片创作。可连接兼容 OpenAI Images、Chat Completions、Responses 或 Claude Messages 的服务商；生图和对话可分别配置独立 API 地址、密钥与模型，不要求共用。应用不内置密钥或固定模型；历史与文件保存在手机本地，执行请求时必要内容会发给用户选择的服务商。

## 功能

- **像 ChatGPT / Gemini 一样的单一对话**：不分“对话模式”“生图模式”，想聊就聊、想画就画。对话模型作为 Agent 通过工具调用（function calling）自己决定何时调用图片 API
- 说“把刚才那张改成夜景”“参考图 2 做一张海报”即可继续修改，AI 会按编号自动带上对应图片，不需要“接着上一张创作”开关
- 流式输出（逐字显示），支持 OpenAI Chat Completions、Responses 与 Claude Messages 三种协议；不支持工具调用的中转会自动切换为文本协议，不会重复计费
- 对话与绘图服务商可以相同也可以分开；只配置了图片服务时，每条消息都会直接生图
- 图片理解、PDF（本地逐页渲染）、Word/Excel/PPT、代码与文本文件分析
- 一次最多 4 张图片：相册、相机、文件；首张图可“涂抹”局部区域后让 AI 只改这里
- 图片生成失败重试只重跑图片请求，下载失败只重新下载，不会再次计费对话步骤
- 侧边栏会话搜索、重命名、删除；“新对话”是未保存的草稿，连续点击不会产生多个空会话
- 全新品牌与界面：矢量 Logo、自绘 SVG 图标集、白底淡蓝渐变的商业级设计，思考、柔光绘制、流式光标与弹性动效
- **语音输入**：输入框麦克风，边说边出字；三档本地离线模型（极速 Zipformer / 均衡 Paraformer / 精准 SenseVoice，基于 sherpa-onnx，设置中自由下载、切换、删除）或你选择的云端识别 API
- **Live 语音对话**：沉浸式语音界面，极光随声音起伏，可随时插话打断；分段语音（任意对话模型 + 语音合成，可继续画图）与实时语音模型（OpenAI / Azure OpenAI / Qwen-Omni / Gemini Live / 阶跃星辰）两种引擎自动选择，详见 [docs/VOICE.md](docs/VOICE.md)
- 开机动画、图片完成后一键“换个风格 / 改成横版 / 再来一张”
- 多个对话可以同时进行：一个对话在画图时可切到别的对话继续聊
- SQLite 保存会话；API 密钥只写入系统安全存储（Expo SecureStore）

### 一个功能一个 API

Salcara 不提供模型或语音服务，所有云端能力都用你自己的 API，且对话、画图、语音识别、语音合成、实时语音可以分别选择不同服务商。内置常用服务商预设：DeepSeek、通义千问、豆包、Kimi、智谱、MiniMax、硅基流动、阶跃星辰、百度、腾讯混元、OpenAI、Claude、Gemini、Grok、Mistral、Groq、OpenRouter；语音另支持阿里云百炼、火山引擎豆包语音、Azure、Google Cloud、ElevenLabs、Deepgram、Fish Audio 等。

### Agent 能力

- 多步工具：联网搜索（带可点击引用）、读网页、画图、生成文件（CSV / Markdown / HTML）、手机操作（确认后执行）、历史对话搜索、记忆。
- 深度研究模式、追问建议、画图自检（可选）。
- 设置入口：“设置 → 个性化 / 工具与联网”，助手和聊天空间都能进入设置。

### 聊天空间与记忆匣

- 顶部“助手 | 聊天”切换两个独立界面（全屏光晕转场）。聊天空间里可以创建多个角色，每个角色一条没有长度上限的对话，能看图、画图、联网、Live 语音。
- 每个角色有自己的“记忆匣”：后台把聊天整理成记忆卡片与连线，旧聊天折叠成分层“往事”摘要（MemGPT / Letta 思路），事实变化自动取代旧卡片（Mem0 / Graphiti），自动连线（A-MEM），定期反思（Generative Agents）；检索使用中文 BM25 + 可选云端向量 + 连线扩散。
- 记忆画布：可缩放拖动的图谱、时间线、列表，能查看这次回复“想起了”哪些记忆；可导出为 Obsidian 仓库。设置入口：“设置 → 插件 → 记忆匣”。

### 远程编程

手机上查看、操作电脑里的 Codex / Claude Code 会话（发任务、审批、停止），仅限中转站用户。服务端 Hub、电脑端 Bridge 和协议见仓库 `remote/` 目录（`remote/docs/PROTOCOL.md`、`remote/hub/README.md`、`remote/bridge/README.md`）。

## 安装

1. 打开本仓库的 [Releases](../../releases) 页面。
2. 下载最新的 `salcara-image-android-v*.apk` 和对应 `.sha256` 文件。
3. 校验 SHA-256 后，在 Android 手机上允许“安装未知应用”并安装 APK。

iPhone / Mac：Release 另附独立 iOS 源码 ZIP；它未签名，不能直接安装到 iPhone。Mac 上生成 Xcode 工程和模拟器构建的方法见 [iOS 构建说明](docs/IOS-MAC-BUILD.md)。

后续版本可在侧边栏进入“关于与更新”检查。发现新版本后，应用会显示版本和安装包大小；用户确认后才会下载，并交由 Android 系统安装器覆盖安装。覆盖安装会保留应用私有目录中的服务商、密钥、会话和图片。包名、签名证书或 `versionCode` 不满足覆盖条件时，发布流水线会直接失败。

Windows 校验示例：

```powershell
Get-FileHash .\salcara-image-android-v1.0.0.apk -Algorithm SHA256
```

## 配置 API

两步，互不混在一起：

1. **API 管理**（设置 → API 管理）：选择平台，只填 **地址** 和 **密钥**（豆包语音可选 APP ID、百度语音填 Secret Key、Azure 语音填区域，其余平台不需要别的）。点“连接”会用密钥读取模型列表来验证。同一平台有多个 Key 也可以分别添加。新添加的 API 会自动补上还没设置的功能（例如第一个 API 自动用于对话和绘图）。
2. **选模型**：对话、绘图在“切换模型”（点对话标题或 设置 → 对话模型 / 绘图模型），语音识别、语音合成、实时语音在“设置 → 语音”。每个功能都是 **① 先选 API → ② 再选这个 API 的模型**（音色在模型下面）。模型列表来自该 API 的 /models 接口加上平台已知模型，也可以手动填写模型 ID。

对话模型由助手空间和聊天空间共用。

### 如何使用

直接在输入框里说话即可：

- “帮我总结这份 PDF” → 只调用对话 API
- “画一只在云朵上睡觉的橘猫，竖版” → 对话模型决定调用绘图工具，并按用途选择比例（如 9:16、21:9）
- “把刚才那张改成夜景，保留猫” → 自动把上一张图作为参考图进行编辑
- 上传照片后说“换成赛博朋克风格” → 以你上传的图片为主图编辑

### 对话、图片理解和 PDF

1. 打开应用后直接输入文字，或用加号添加图片／文件；所有内容都在同一条会话中处理。
2. 对话模型必须支持所用输入类型。出现在 `/models` 中不代表支持视觉或 PDF；不支持时请自行改选模型，不会自动换接口产生重复计费。
3. 如果生图分组只支持图片，另建一个对话服务商，填写它的地址、密钥、对话模型。应用会在需要时使用这个独立对话服务商；会话不会丢失，必要历史会发送到对应模型。
4. 上传图片后说“分析/识别/描述”只会走对话 API；说“参考这张图生成海报”才会先由对话 API 整理要求，再调用图片编辑 API。上传 PDF 等文件后先分析，下一条明确要求生成时会沿用当前会话的文件上下文。
5. 图片可直接用于视觉理解；PDF 在手机本地逐页转换成图片（Android 用系统 PdfRenderer，iPhone 用 PDFKit），再由视觉模型理解，每份最多 12 页。Word/Excel/PPT/ODF 等 ZIP 文档会在本地提取正文；代码和文本直接读取；压缩包只读取目录，不执行内容。超过页数、加密、损坏的 PDF 会在请求前报错，不会偷偷截取前几页。

**Claude / Salcara 对话分组配置：**新建独立服务商，填写对话密钥，接口选择「Claude Messages」，读取模型后选择所需 Claude 模型。实际测试的 Salcara 上游在两种协议里都没有读到直接发送的 PDF，但识图正常；因此本版统一把 PDF 渲染成逐页图片上传，不依赖上游的原始 PDF 透传能力。临时页图在组装请求后清理，原文件不被修改；最长边 1600 像素，细小文字建议拆成局部清晰截图。

限制：每次最多 4 张图片、4 个文件；单个附件最多 20MB，图片与文件合计最多 30MB。对话没有轮数上限：应用按当前模型的上下文大小携带尽可能多的原始消息，更早的内容在后台自动整理成“滚动摘要”继续带上，所以长对话不用新建；完整文件只在最近的文件轮次里重发，更早的只提文件名。历史附件合计超过 30MB 时会在请求前提示。最终编码后请求体还受 32MB 限制，Base64 会增加体积，因此可能需要进一步缩小附件。文本上下文也有大小保护。旧版二进制 Word/Excel/PPT 的正文可能无法本地提取，应用会在支持的 Responses / 兼容文件协议中保留原文件，否则向模型提供文件元数据。

### 无节点连接与故障排查

网站、API、图床和 APK 下载站点可能是不同域名，不能只根据首页能打开判断所有链路。特别是 sub2api，建议在生图上游账户启用「生图结果 URL 转 base64」，由中转服务器取回图片。**这项服务器设置需要管理员实际开启，安装新版 App 不会自动修改服务器。** 操作步骤和网络诊断见 [网络排障说明](./docs/NETWORK.md)。

GitHub APK 的可达性仍取决于手机网络。应用会按“Salcara 更新站 → GitHub API 资源 → GitHub 发布资源”顺序尝试，所有入口都必须通过同一份 SHA-256 校验；如果目标地区无法连接 GitHub，请按[更新镜像部署说明](./docs/UPDATE-MIRROR.md)在 Salcara 域名提供可信下载源，本版不会把 APK、密钥或图片发到不明代理。

应用请求：

- 文生图：`POST {baseUrl}/images/generations`
- 图片编辑：`POST {baseUrl}/images/edits`，图片字段为 `image[]`
- 对话／解析：`POST {baseUrl}/chat/completions`、`POST {baseUrl}/responses` 或 `POST {baseUrl}/messages`，非流式返回文本
- 固定发送 `n: 1` 与 `output_format: png`
- 透明按钮开启时才发送 `background: transparent`

透明背景和精确尺寸能否生效最终取决于服务商。应用会显示“请求尺寸”和图片加载后的“实际尺寸”；如果服务商忽略 `background: transparent`，应用不会伪造透明结果。

## 尺寸映射

画幅可选自动、1:1、3:4、4:3、2:3、3:2、9:16、16:9、4:5、21:9、1:2、3:1 或自定义“宽:高”（1:3～3:1）。尺寸按模型换算（`src/image-sizes.ts`）：

- **GPT Image 2**：任意尺寸，宽高为 16 的倍数、最长边 ≤ 3840、像素 655,360～8,294,400；1K / 2K / 4K 目标约 1.05M / 4.19M / 8.29M 像素。例：16:9 → 1360×768 / 2736×1536 / 3840×2160；1:1 → 1024×1024 / 2048×2048 / 2880×2880。“自动”发送 `size: auto`。
- **GPT Image 1 / 1.5 / mini**：只用 1024×1024、1536×1024、1024×1536，取最接近的比例。
- **DALL·E 3**：1024×1024、1792×1024、1024×1792；DALL·E 2 固定 1024×1024。
- **其他模型**：按同样的像素目标换算，64 像素对齐、最长边 ≤ 4096。

精确模型 `gpt-image-2` 只显示 `auto/low/medium/high`；其他模型显示 `auto/low/medium/high/xhigh/max`，最终以服务端校验为准。

## 本地开发

要求 Node.js 22.13+、JDK 21 和 Android SDK。

```bash
npm ci
npm run typecheck
npm test
npx expo prebuild --platform android --no-install
npx expo run:android
```

## iOS 构建

iPhone 版与 Android 共用同一套代码（`app.json` 中 `ios.bundleIdentifier` 为 `top.salcara.image`，`ios.buildNumber` 与 Android `versionCode` 保持一致），三个本地原生模块（`modules/salcara-voice`、`salcara-pdf`、`salcara-actions`）都带有 iOS 实现（Swift，最低 iOS 15.1）。

**推荐：EAS 云端构建**（不需要自己的 Mac）

```bash
npm i -g eas-cli
eas login
eas build -p ios --profile production   # App Store / TestFlight 包
eas submit -p ios --profile production  # 上传到 App Store Connect，再在 TestFlight 分发
# 内部测试包（Ad Hoc，需先 eas device:create 登记测试机 UDID）：
eas build -p ios --profile preview
```

- 需要付费的 **Apple Developer 账号**（个人或公司，99 美元/年）。首次构建时 EAS 会引导登录并自动创建证书和描述文件。
- iPhone **不能像 APK 那样下载安装包直接装**：正式分发走 App Store，测试分发走 **TestFlight**（最多 1 万名外部测试者，每个构建 90 天有效）；`preview` 配置是内部分发，只能装在已登记 UDID 的设备上。
- 上架或开放 TestFlight 公开链接后，把链接填到 `src/update.ts` 的 `IOS_UPDATE_URL`，应用内“检查更新”就会显示“前往更新”。留空时 iPhone 只显示新版本说明、不提供安装按钮，也不会在启动时自动提醒。

**备选：本机 Xcode 构建**（需要 macOS + Xcode 26 与 CocoaPods）

```bash
npm ci
npx expo prebuild -p ios        # 生成 ios/ 工程并执行 pod install
open ios/SalcaraAI.xcworkspace  # 在 Xcode 里选择 Team 签名后运行或 Archive
# 或直接：npx expo run:ios --device
```

**iPhone 版与 Android 版的区别**

- 语音输入与语音对话使用你在“设置 → 语音”选择的**云端识别服务**；iPhone 没有本地离线语音模型（sherpa-onnx 只打包在 Android 版），设置里也不提供模型下载。
- **不能设置闹钟和倒计时**：iOS 不允许其他应用创建“时钟”闹钟，AI 不会再提供这两种操作，会建议你在“时钟”App 设置或改为添加日程。
- **日程可以添加**：确认日程卡片后直接写入系统默认日历（iOS 17+ 只申请“仅添加日程”权限，不读取已有日程）。
- 短信、邮件、电话、地图分别打开“信息”“邮件”“电话”和 Apple 地图。
- 更新走 App Store / TestFlight，应用内不会下载 APK。
- 语音对话使用 iOS 的语音处理（回声消除、降噪、扬声器外放）；锁屏或切到后台时 iOS 会暂停麦克风，对话中请保持应用在前台（应用会保持屏幕常亮）。

## 隐私与安全

详见 [PRIVACY.md](./PRIVACY.md)。项目不提供账户、云同步、遥测或广告。服务商仍可按其隐私政策处理你提交的文字、图片、文档及必要历史。

反馈交流 QQ 群：`881490534`（应用内“关于”可一键复制）。

## 许可证

[MIT](./LICENSE)
