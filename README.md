# Salcara Image

一个简洁的 Android AI 生图客户端，可连接任意兼容 OpenAI Images API 的服务商。应用不内置服务地址、API 密钥或固定模型，所有数据都保存在手机本地。

## 功能

- ChatGPT 风格的图片对话与会话管理
- 保存并切换多个服务商
- 自动读取 `/v1/models` 中的 `gpt-image*` 模型，也可手动填写模型 ID
- 自由选择画质、比例和 1K/2K/4K 清晰度
- 文生图与最多四张参考图编辑
- 相册、相机和系统文件选择器
- 主图蒙版：画笔、橡皮擦、笔刷大小、撤销、重做和清空
- 一键透明背景、保存到相册、系统分享、历史图片复用
- 10 分钟超时、实时等待时间、取消与手动重试
- SQLite 保存会话；API 密钥只写入 Android Keystore/Expo SecureStore

## 安装

1. 打开本仓库的 [Releases](../../releases) 页面。
2. 下载最新的 `salcara-image-android-v*.apk` 和对应 `.sha256` 文件。
3. 校验 SHA-256 后，在 Android 手机上允许“安装未知应用”并安装 APK。

Windows 校验示例：

```powershell
Get-FileHash .\salcara-image-android-v1.0.0.apk -Algorithm SHA256
```

## 配置服务商

首次打开应用会自动进入“添加服务商”：

1. 填写便于识别的名称。
2. 填写服务商根地址，例如 `https://example.com`，或完整地址 `https://example.com/v1`。应用会自动规范化地址。
3. 填写 API 密钥。
4. 点“测试连接并读取模型”。接口不可用或模型列表不完整时，可继续手动填写模型 ID。
5. 必须主动选择模型、画质和清晰度后保存；比例属于每次生成的“生成设置”，可在对话框中调整。应用不会暗中预设模型或 max 画质。

应用请求：

- 文生图：`POST {baseUrl}/images/generations`
- 图片编辑：`POST {baseUrl}/images/edits`，图片字段为 `image[]`
- 固定发送 `n: 1` 与 `output_format: png`
- 透明按钮开启时才发送 `background: transparent`

透明背景和精确尺寸能否生效最终取决于服务商。应用会显示“请求尺寸”和图片加载后的“实际尺寸”；如果服务商忽略 `background: transparent`，应用不会伪造透明结果。

## 尺寸映射

| 比例 | 1K | 2K | 4K |
|---|---|---|---|
| 1:1 | 1024×1024 | 2048×2048 | 2880×2880 |
| 16:9 | 1536×1024 | 2048×1152 | 3840×2160 |
| 9:16 | 1024×1536 | 1152×2048 | 2160×3840 |

精确模型 `gpt-image-2` 只显示 `auto/low/medium/high`；其他模型显示 `auto/low/medium/high/xhigh/max`，最终以服务端校验为准。

## 本地开发

要求 Node.js 20+、JDK 21 和 Android SDK。

```bash
npm ci
npm run typecheck
npm test
npx expo prebuild --platform android --no-install
npx expo run:android
```

## 隐私与安全

详见 [PRIVACY.md](./PRIVACY.md)。项目不提供账户、云同步、遥测或广告。服务商仍可按其隐私政策处理你主动提交的提示词和图片。

## 许可证

[MIT](./LICENSE)
