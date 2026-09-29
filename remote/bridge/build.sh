#!/usr/bin/env bash
# Build every Salcara Bridge release artifact (Go standard library only, no cgo, works on Linux/macOS/WSL):
#
#   dist/bridge/SalcaraBridge-windows-amd64.exe / -arm64.exe
#   dist/bridge/SalcaraBridge-macos-arm64 / -amd64        thin macOS binaries
#   dist/bridge/SalcaraBridge-macos-universal             fat binary (arm64 + x86_64), built by tools/lipo
#   dist/bridge/SalcaraBridge-macos.zip                   "Salcara Bridge.app" (universal, icon, LSUIElement)
#   dist/bridge/SalcaraBridge-linux-amd64 / -arm64
#   dist/downloads/                                        everything the hub serves at /salcara-hub/download/:
#                                                          install-mac.sh, install-windows.ps1, the .zip, the .exe
#                                                          files and the Linux binaries. Copy this folder to the
#                                                          hub's SALCARA_HUB_DOWNLOADS directory.
set -euo pipefail
cd "$(dirname "$0")"
VERSION="${VERSION:-1.1.0}"
ROOT="$(cd .. && pwd)"
OUT="${OUT:-$ROOT/dist/bridge}"
DL="${DL:-$ROOT/dist/downloads}"
mkdir -p "$OUT" "$DL"
LDFLAGS="-s -w -X main.version=${VERSION}"
export CGO_ENABLED=0

build() { # goos goarch output [extra ldflags]
  echo "→ $3"
  GOOS="$1" GOARCH="$2" go build -trimpath -ldflags "${LDFLAGS} ${4:-}" -o "${OUT}/$3" .
}

build windows amd64 SalcaraBridge-windows-amd64.exe "-H=windowsgui"
build windows arm64 SalcaraBridge-windows-arm64.exe "-H=windowsgui"
build darwin  arm64 SalcaraBridge-macos-arm64
build darwin  amd64 SalcaraBridge-macos-amd64
build linux   amd64 SalcaraBridge-linux-amd64
build linux   arm64 SalcaraBridge-linux-arm64

# Universal macOS binary. Go's linker ad-hoc signs darwin/arm64 executables (LC_CODE_SIGNATURE); lipo checks
# that signature is there and copies both slices byte for byte, so it stays valid.
echo "→ SalcaraBridge-macos-universal"
GOOS= GOARCH= CGO_ENABLED=0 go run ./tools/lipo -output "$OUT/SalcaraBridge-macos-universal" \
  "$OUT/SalcaraBridge-macos-arm64" "$OUT/SalcaraBridge-macos-amd64"

echo "→ SalcaraBridge-macos.zip (Salcara Bridge.app)"
GOOS= GOARCH= CGO_ENABLED=0 go run ./tools/macbundle -bin "$OUT/SalcaraBridge-macos-universal" \
  -version "$VERSION" -out "$OUT/SalcaraBridge-macos.zip"

# Hub downloads folder.
rm -rf "$DL"
mkdir -p "$DL"
cp install/install-mac.sh install/install-windows.ps1 "$DL/"
chmod 0644 "$DL/install-mac.sh" "$DL/install-windows.ps1"
for f in SalcaraBridge-macos.zip SalcaraBridge-windows-amd64.exe SalcaraBridge-windows-arm64.exe \
         SalcaraBridge-linux-amd64 SalcaraBridge-linux-arm64; do
  cp "$OUT/$f" "$DL/$f"
done
( cd "$DL" && if command -v sha256sum >/dev/null 2>&1; then sha256sum -- *; else shasum -a 256 -- *; fi > "$OUT/.sums" )
mv "$OUT/.sums" "$DL/SHA256SUMS.txt"

ls -lh "$OUT" "$DL"
