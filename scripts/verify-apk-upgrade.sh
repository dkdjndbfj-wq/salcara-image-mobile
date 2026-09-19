#!/usr/bin/env bash
set -euo pipefail

current_apk="$1"
previous_apk="${2:-}"
build_tools="$(find "$ANDROID_HOME/build-tools" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -n 1)"
apksigner="$build_tools/apksigner"
aapt="$build_tools/aapt"

read_badging() {
  "$aapt" dump badging "$1" | head -n 1
}

read_value() {
  local line="$1"
  local key="$2"
  sed -n "s/.*${key}='\([^']*\)'.*/\1/p" <<<"$line"
}

current_badging="$(read_badging "$current_apk")"
current_package="$(read_value "$current_badging" name)"
current_code="$(read_value "$current_badging" versionCode)"
current_cert="$("$apksigner" verify --print-certs "$current_apk" | sed -n 's/^Signer #1 certificate SHA-256 digest: //p' | head -n 1)"

test "$current_package" = 'top.salcara.image'
test -n "$current_code"
test -n "$current_cert"

if [[ -n "$previous_apk" && -f "$previous_apk" ]]; then
  if [[ ! -s "$previous_apk" ]]; then
    echo "Previous APK is empty; skipping previous-version comparison: $previous_apk" >&2
    exit 0
  fi
  if ! previous_badging="$(read_badging "$previous_apk")"; then
    echo "Previous APK is not a readable Android package; skipping previous-version comparison: $previous_apk" >&2
    exit 0
  fi
  previous_package="$(read_value "$previous_badging" name)"
  previous_code="$(read_value "$previous_badging" versionCode)"
  previous_cert="$("$apksigner" verify --print-certs "$previous_apk" | sed -n 's/^Signer #1 certificate SHA-256 digest: //p' | head -n 1)"

  test "$current_package" = "$previous_package"
  test "$current_cert" = "$previous_cert"
  if (( current_code <= previous_code )); then
    echo "versionCode must increase: previous=$previous_code current=$current_code" >&2
    exit 1
  fi
  echo "Upgrade compatibility OK: package=$current_package versionCode=$previous_code->$current_code certificate=$current_cert"
else
  echo "No previous APK found; verified current package and signing certificate."
fi
