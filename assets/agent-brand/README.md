# Official Agent icons

These assets identify the external tools integrated by Salcara. They are not Salcara logos, are not AI-generated, and do not imply partnership or endorsement.

## Sources and provenance

| File | Original official asset | SHA-256 |
| --- | --- | --- |
| `codex-app-official.png` | OpenAI's installed Windows Store package `OpenAI.Codex_26.930.2377.0_x64__2p2nqsd0c76g0`, `app/resources/app.asar` → `webview/assets/codex-app-ga-logo-3e5209898ca3.png` (104 × 104) | `8e82b26c98a10e45798ce48124515720657f7735fb8d0853b3f087eaa8a6b74e` |
| `claude-app-official.png` | Anthropic's installed Windows Store package `Claude_2.16120.0.0_x64__pzs8sxrjxfjjc`, `assets/Square44x44Logo.targetsize-256_altform-unplated.png` (256 × 256) | `28f6dfd7bc66bffe9ac40dac94dc90b7bae9b4a60b123f687c90ab2b86a63eb0` |
| `deepseek-harness-app-official.png` | [Official DeepSeek Harness Windows icon](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/apps/desktop/resources/icon-windows.png) (1024 × 1024) | `12064ff340e65872715cb18e56cfa9d3afe294fed98c81807d39e230a030d972` |
| `hermes-app-official.png` | [Official Hermes Agent desktop icon](https://github.com/NousResearch/hermes-agent/blob/8d7061f1a74980a7549356a4e5e57b603475ddf0/apps/desktop/assets/icon.png) (1024 × 1024) | `2e69dd9a8a1d3f9e3f627efc37102aed416f703e22f599e31c5d86b212a4d6de` |

DeepSeek Harness and Hermes Agent assets were copied unchanged from those pinned official repository commits on 2026-11-08 and are shared with the desktop integration. Their names and marks belong to DeepSeek and Nous Research respectively. Display is local and proportional, with no recolouring or network image requests.

Copied on 2026-10-03. Both PNGs preserve the original bytes and colours; the app only scales them proportionally using `resizeMode="contain"`. They are bundled locally: rendering does not contact OpenAI, Anthropic, or a logo CDN.

The installed OpenAI package's Windows launcher assets now use the generic OpenAI Blossom. They were deliberately **not** used as a substitute for Codex: the selected asset is the separately named Codex app icon from the official application bundle, visually confirmed as the blue-purple Codex mark. OpenAI documents that the updated desktop app can retain the Codex icon in its settings: [Moving to the new ChatGPT desktop app](https://help.openai.com/en/articles/20001276-moving-to-the-new-chatgpt-desktop-app).

The Claude app's official asterisk is used unchanged for both Claude Code and Claude Desktop. Their surrounding product names distinguish the two integrations; no unverified separate Claude Code icon, recolouring, or custom outline is introduced. Official product pages: [Claude](https://claude.com/) and [Claude Code](https://claude.com/product/claude-code).

## Copyright, trademark, and redistribution

OpenAI/Codex names and icons belong to OpenAI; Claude names and icons belong to Anthropic, PBC. No ownership of these marks is claimed, and these assets are not placed under Salcara's project licence. Extracting an installed asset is provenance, not an independent copyright licence grant.

Use and redistribution remain subject to the owners' applicable terms and trademark rules. See [OpenAI brand guidelines](https://openai.com/brand/) and [Anthropic commercial terms](https://www.anthropic.com/legal/commercial-terms). Before a public release, the maintainer must check that the intended distribution and brand use comply with the relevant terms or obtain permission where required. This isolated implementation does not publish the assets.
