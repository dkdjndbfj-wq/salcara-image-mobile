#!/usr/bin/env bash
# 端到端测试：编译 Hub、Bridge 和假的 codex / claude，模拟“手机 → 中转站(nginx) → Hub ⇄ Bridge → 工具”全链路，
# 并通过 Hub 的下载接口跑一遍 install-mac.sh（用假的 macOS 命令）。只需要 Go 和 bash（可选 unzip）。
#
#   ./scripts/e2e.sh            # 详细输出
#   RACE=1 ./scripts/e2e.sh     # 测试进程开启 -race
set -euo pipefail
cd "$(dirname "$0")/../bridge"
args=(-count=1 -v)
[ "${RACE:-}" = "1" ] && args+=(-race)
exec go test "${args[@]}" ./e2e/
