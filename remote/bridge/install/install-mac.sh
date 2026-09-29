#!/bin/bash
# Salcara Bridge · macOS 一键安装
#
#   curl -fsSL {{SALCARA_BASE_URL}}/download/install-mac.sh | bash
#
# 这个脚本由中转站的远程编程服务（Salcara Hub）提供，下载时会自动填好中转站地址。
# 它会：下载通用版（Apple 芯片 + Intel）Salcara Bridge.app → 装到 ~/Applications（不需要管理员密码）
# → 去掉“隔离”标记（用 curl 下载本来就没有，这里只是保险）→ 打开它，浏览器里出现控制台。
#
# 可选环境变量：
#   SALCARA_HUB=https://中转站/salcara-hub   下载来源（通常不用填）
#   INSTALL_DIR=/Applications               安装到别的文件夹（默认 ~/Applications）
#   NO_OPEN=1                                只安装，不打开
set -euo pipefail

HUB="${SALCARA_HUB:-{{SALCARA_BASE_URL}}}"
RELAY="${SALCARA_RELAY:-{{SALCARA_RELAY_URL}}}"
APP_NAME="Salcara Bridge.app"
INSTALL_DIR="${INSTALL_DIR:-$HOME/Applications}"
APP="$INSTALL_DIR/$APP_NAME"
ZIP_NAME="SalcaraBridge-macos.zip"

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m注意：\033[0m%s\n' "$*" >&2; }
die()  { printf '\033[1;31m安装失败：\033[0m%s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "这个脚本只用于 macOS。Windows 请在 PowerShell 里运行：irm $HUB/download/install-windows.ps1 | iex"
case "$HUB" in
  *"{{"*|"") die "没有中转站地址。请用：SALCARA_HUB=https://你的中转站/salcara-hub bash install-mac.sh" ;;
esac
HUB="${HUB%/}"
case "$RELAY" in *"{{"*) RELAY="" ;; esac

# 系统和芯片
ver="$(sw_vers -productVersion 2>/dev/null || echo 0)"
major="${ver%%.*}"
if [ "${major:-0}" -lt 11 ] 2>/dev/null; then
  die "需要 macOS 11 (Big Sur) 或更新版本，当前是 $ver"
fi
arch="$(uname -m)"
if [ "$arch" = "x86_64" ] && [ "$(sysctl -in sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
  arch="arm64（当前终端在 Rosetta 下运行）"
fi
case "$arch" in
  arm64*) chip="Apple 芯片" ;;
  x86_64) chip="Intel" ;;
  *) chip="$arch" ;;
esac
say "macOS $ver · $chip · 安装通用版（同时支持 Apple 芯片和 Intel）"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/salcara-install.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

say "下载 $HUB/download/$ZIP_NAME"
curl -fL --retry 3 --connect-timeout 15 --progress-bar -o "$TMP/$ZIP_NAME" "$HUB/download/$ZIP_NAME" \
  || die "下载失败，请检查网络，或确认中转站已经上传安装包（$HUB/download/$ZIP_NAME）"

say "解压"
mkdir -p "$TMP/x"
if command -v ditto >/dev/null 2>&1; then
  ditto -x -k "$TMP/$ZIP_NAME" "$TMP/x" || die "安装包损坏，请重新运行"
else
  unzip -q "$TMP/$ZIP_NAME" -d "$TMP/x" || die "安装包损坏，请重新运行"
fi
[ -x "$TMP/x/$APP_NAME/Contents/MacOS/SalcaraBridge" ] || die "安装包里没有找到 $APP_NAME"

# 已经在运行的旧版本先退出（SIGTERM：正常关闭，保存状态）
if pgrep -x SalcaraBridge >/dev/null 2>&1 || pgrep -f 'SalcaraBridge-macos-' >/dev/null 2>&1; then
  say "退出正在运行的 Salcara Bridge"
  pkill -x SalcaraBridge 2>/dev/null || true
  pkill -f 'SalcaraBridge-macos-' 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pgrep -x SalcaraBridge >/dev/null 2>&1 || break
    sleep 0.5
  done
fi

say "安装到 $APP"
mkdir -p "$INSTALL_DIR" || die "无法创建 $INSTALL_DIR"
if [ -e "$APP" ]; then
  rm -rf "$APP" || die "无法删除旧版本 $APP"
fi
mv "$TMP/x/$APP_NAME" "$APP" || die "无法写入 $INSTALL_DIR"
# curl 下载的文件本来就没有隔离标记；这里再清一次，保证不会出现“已损坏 / 无法验证开发者”
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
chmod +x "$APP/Contents/MacOS/SalcaraBridge"

if ! "$APP/Contents/MacOS/SalcaraBridge" version >/dev/null 2>&1; then
  warn "程序无法运行（可能被系统拦截）。可以在“系统设置 → 隐私与安全性”底部点“仍要打开”。"
fi
say "已安装 $("$APP/Contents/MacOS/SalcaraBridge" version 2>/dev/null || echo "Salcara Bridge")"

if [ "${NO_OPEN:-}" != "1" ]; then
  say "启动 Salcara Bridge，浏览器会打开控制台（http://127.0.0.1:47831）"
  args=()
  [ -n "$RELAY" ] && args=(--relay "$RELAY")
  if ! open "$APP" --args "${args[@]+"${args[@]}"}"; then
    ( nohup "$APP/Contents/MacOS/SalcaraBridge" "${args[@]+"${args[@]}"}" >/dev/null 2>&1 & )
  fi
fi

cat <<TXT

安装完成
  1. 在打开的控制台里填写 API Key${RELAY:+（中转站地址已填好：$RELAY）}，点「保存并登录」。
  2. 在「项目文件夹」添加你写代码的文件夹。
  3. 手机 Salcara → 远程编程，用同一个 Key 登录，就能看到这台 Mac。

以后可以在“访达 → 应用程序（个人）”里找到 Salcara Bridge；登录后会开机自动启动。
第一次让 AI 读写“文稿 / 桌面 / 下载”里的文件时，macOS 会询问“Salcara Bridge”想访问…，请点「允许」。
TXT
