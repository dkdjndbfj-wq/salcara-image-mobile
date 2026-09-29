#!/usr/bin/env sh
# Salcara Hub 冒烟测试：检查 ping / me / devices。
#
# 用法：
#   HUB_URL=https://relay.example.com/salcara-hub KEY=sk-xxx ./scripts/smoke.sh
#   HUB_URL=http://127.0.0.1:8787 KEY=sk-xxx ./scripts/smoke.sh      # 直连（不带前缀）
#
# KEY 不传时只测 /v1/ping 和无 Key 时的 401。
set -eu

HUB_URL="${HUB_URL:-http://127.0.0.1:8787/salcara-hub}"
HUB_URL="${HUB_URL%/}"
KEY="${KEY:-}"
fail=0

# check <名称> <期望状态码> <curl 参数...>
check() {
	name="$1"
	want="$2"
	shift 2
	body_file="$(mktemp)"
	code="$(curl -sS -o "$body_file" -w '%{http_code}' --max-time 15 "$@" || echo 000)"
	body="$(cat "$body_file")"
	rm -f "$body_file"
	if [ "$code" = "$want" ]; then
		printf '通过  %-22s %s  %s\n' "$name" "$code" "$body"
	else
		printf '失败  %-22s 期望 %s 实际 %s  %s\n' "$name" "$want" "$code" "$body"
		fail=1
	fi
}

check "ping" 200 "$HUB_URL/v1/ping"
check "me（无 Key）" 401 "$HUB_URL/v1/me"
check "me（错误 Key）" 401 -H "Authorization: Bearer sk-salcara-smoke-invalid" "$HUB_URL/v1/me"

if [ -n "$KEY" ]; then
	check "me" 200 -H "Authorization: Bearer $KEY" "$HUB_URL/v1/me"
	check "app/devices" 200 -H "Authorization: Bearer $KEY" "$HUB_URL/v1/app/devices"
	# SSE：3 秒内应该收到 ": connected"
	sse="$(curl -sS -N --max-time 3 -H "Authorization: Bearer $KEY" "$HUB_URL/v1/app/stream" 2>/dev/null || true)"
	case "$sse" in
	*": connected"*) printf '通过  %-22s 收到 SSE\n' "app/stream" ;;
	*)
		printf '失败  %-22s 没有收到 SSE（检查 nginx 的 proxy_buffering off）\n' "app/stream"
		fail=1
		;;
	esac
else
	echo "（没有设置 KEY，跳过 me / devices / stream）"
fi

# 安装包下载（可选）：脚本里的地址应该是公网地址，而不是 127.0.0.1
dl_file="$(mktemp)"
dl_code="$(curl -sS -o "$dl_file" -w '%{http_code}' --max-time 15 "$HUB_URL/download/install-mac.sh" || echo 000)"
dl_hub="$(grep -o 'SALCARA_HUB:-[^}]*' "$dl_file" | head -n 1 | cut -d- -f2-)"
rm -f "$dl_file"
if [ "$dl_code" = "404" ]; then
	printf '提示  %-22s 没有上传安装包（可选，见 README“安装包下载”）\n' "download"
elif [ "$dl_code" != "200" ]; then
	printf '失败  %-22s 状态码 %s\n' "download" "$dl_code"
	fail=1
else
	case "$dl_hub" in
	*127.0.0.1* | *localhost* | "")
		printf '失败  %-22s 安装脚本里的地址是 %s（nginx 需要 X-Forwarded-Proto / X-Forwarded-Host，或设置 SALCARA_HUB_PUBLIC_URL）\n' "download" "$dl_hub"
		fail=1
		;;
	*) printf '通过  %-22s 安装脚本地址 %s\n' "download" "$dl_hub" ;;
	esac
fi

if [ "$fail" -ne 0 ]; then
	echo "有检查失败"
	exit 1
fi
echo "全部通过"
