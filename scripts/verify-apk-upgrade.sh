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
  sed -n "s/.*[[:space:]]$key='\([^']*\)'.*/\1/p" <<<"$line"
}

read_cert() {
  local output
  output="$("$apksigner" verify --print-certs "$1")"
  sed -nE 's/.*SHA-256[^:]*:[[:space:]]*([0-9A-Fa-f]+).*/\1/p' <<<"$output" | head -n 1
}

current_badging="$(read_badging "$current_apk")"
current_package="$(read_value "$current_badging" name)"
current_code="$(read_value "$current_badging" versionCode)"
current_cert="$(read_cert "$current_apk")"

echo "Current APK: package=$current_package versionCode=$current_code certificate=$current_cert"
if [[ "$current_package" != 'top.salcara.image' || -z "$current_code" || -z "$current_cert" ]]; then
  echo "Current APK metadata/signature is invalid." >&2
  exit 1
fi

if [[ -n "$previous_apk" && -f "$previous_apk" ]]; then
  if [[ ! -s "$previous_apk" ]]; then
    echo "Previous APK is empty; cannot verify upgrade compatibility: $previous_apk" >&2
    exit 1
  fi
  if ! previous_badging="$(read_badging "$previous_apk")"; then
    echo "Previous APK is unreadable; cannot verify upgrade compatibility: $previous_apk" >&2
    exit 1
  fi
  previous_package="$(read_value "$previous_badging" name)"
  previous_code="$(read_value "$previous_badging" versionCode)"
  previous_cert="$(read_cert "$previous_apk")"

  echo "Previous APK: package=$previous_package versionCode=$previous_code certificate=$previous_cert"
  if [[ "$current_package" != "$previous_package" ]]; then
    echo "Package name changed: previous=$previous_package current=$current_package" >&2
    exit 1
  fi
  if [[ "$current_cert" != "$previous_cert" ]]; then
    echo "Signing certificate changed; overwrite installation would be blocked." >&2
    exit 1
  fi
  if (( current_code <= previous_code )); then
    echo "versionCode must increase: previous=$previous_code current=$current_code" >&2
    exit 1
  fi
  echo "Upgrade compatibility OK: package=$current_package versionCode=$previous_code->$current_code certificate=$current_cert"
else
  echo "No previous APK found; verified current package and signing certificate."
fi
