"""REVIEW-ONLY QA candidate: validate immutable inputs, then create one draft.

If explicitly adopted, install at scripts/stage_verified_apk_draft.py with the
adjacent workflow. Do not run locally: main performs the one authorized draft
creation only after every gate. No tag creation, rebuild, signing, publication,
feed update, overwrite, or alternative credential path is implemented.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import stat
import struct
import subprocess
import sys
import zipfile


REPO = "dkdjndbfj-wq/salcara-image-mobile"
SOURCE = "0ac29da63fd6f9049ecb0da011faf19361dda73e"
BUILD_RUN = 42983925914
VERIFY_RUN = 42986745992
ARTIFACT_ID = 13839792455
ARTIFACT_SIZE = 53753558
ARTIFACT_DIGEST = "cec46ba671cd06d4941e1437c6aee47d380a07560652feea373d159e731e2944"
TAG, VERSION, CODE = "v1.8.5", "1.8.5", 26
ARTIFACT_NAME = "salcara-verified-release-v1.8.5"
APK = "salcara-image-android-v1.8.5.apk"
OLD_APK = "salcara-image-android-v1.8.4.apk"
OLD_SIZE = 117277758
OLD_SHA = "15557d56cde7eebe4ba1a4752a7d4f4ad648fa4fa089ecc464600c2848acd905"
PACKAGE = "top.salcara.image"
CERT = "9714443d4c0679227ff3bf1dd43ee13bfdd05c1a8253ab46d6c6608f29d8bc33"
ABIS = {"arm64-v8a": (2, 183), "armeabi-v7a": (1, 40)}
MAX_APK = 512 * 1024 * 1024
create_attempted = False


class GateError(Exception):
    pass


def need(condition, message):
    if not condition:
        raise GateError(message)


def command(args, timeout=180, stdout=subprocess.PIPE, input=None):
    try:
        result = subprocess.run(args, stdout=stdout, stderr=subprocess.PIPE, input=input, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise GateError("Required command could not complete; no fallback is permitted") from None
    need(result.returncode == 0, "Required command failed; no retry, overwrite, or credential fallback is permitted")
    return result.stdout


def parse_api_response(raw, returncode):
    # --include exposes the actual HTTP status. Do not infer absence from an
    # exception, stderr wording, network failure, 403, or a JSON message alone.
    parts = re.split(br"\r?\n\r?\n", raw, maxsplit=1)
    match = re.match(br"HTTP/[^\s]+ ([0-9]{3})(?:[^\r\n]*)\r?\n", raw)
    need(len(parts) == 2 and match is not None, "GitHub HTTP status is unavailable")
    status = int(match.group(1))
    need(status == 200 and returncode == 0, "GitHub API did not return the required success status")
    data = json.loads(parts[1])
    need(isinstance(data, dict), "GitHub API object is invalid")
    return data


def api(path):
    try:
        result = subprocess.run(["gh", "api", f"repos/{REPO}/{path}", "--method", "GET", "--include"],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise GateError("GitHub read-only API could not complete") from None
    return parse_api_response(result.stdout, result.returncode)


def positive_id(value):
    return type(value) is int and 0 < value < 2**63


def parse_release_pages(raw):
    need(isinstance(raw, bytes) and len(raw) <= 32 * 1024 * 1024, "Release listing response is invalid or too large")
    pages = json.loads(raw)
    need(isinstance(pages, list) and 1 <= len(pages) <= 1000, "Complete paginated release listing is required")
    releases, seen = [], set()
    for index, page in enumerate(pages):
        need(isinstance(page, list) and len(page) <= 100 and (index == len(pages) - 1 or len(page) == 100),
             "Release pagination is malformed or incomplete")
        for release in page:
            need(isinstance(release, dict) and positive_id(release.get("id")) and release["id"] not in seen,
                 "Release listing contains an invalid or duplicate ID")
            tag = release.get("tag_name")
            need(isinstance(tag, str) and 0 < len(tag) <= 256 and not any(ord(char) < 32 for char in tag)
                 and type(release.get("draft")) is bool and type(release.get("prerelease")) is bool,
                 "Release listing row identity is invalid")
            published = release.get("published_at")
            need("published_at" in release and (published is None if release["draft"] else
                 isinstance(published, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z", published) is not None),
                 "Release listing publication state is invalid")
            seen.add(release["id"])
            releases.append(release)
    return releases


def all_releases():
    # The tag endpoint is published-only; authenticated pagination also includes
    # drafts. gh fails if any page fails, so partial output is never accepted.
    raw = command(["gh", "api", f"repos/{REPO}/releases?per_page=100", "--method", "GET", "--paginate", "--slurp"])
    return parse_release_pages(raw)


def regular(path):
    for item in (path, *path.parents):
        need(not item.is_symlink(), "Symlink paths are not permitted")
    need(path.is_file() and stat.S_ISREG(path.stat().st_mode), "Required regular file is missing")


def sha(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def check_tag(data):
    need(data.get("ref") == f"refs/tags/{TAG}" and data.get("object", {}).get("type") == "commit"
         and data["object"].get("sha") == SOURCE, "The existing tag must directly reference the exact tested commit")


def check_run(data, run_id, workflow):
    need(type(data.get("id")) is int and data["id"] == run_id and data.get("status") == "completed"
         and data.get("conclusion") == "success" and data.get("event") == "workflow_dispatch"
         and data.get("path") == f".github/workflows/{workflow}" and data.get("head_sha") == SOURCE,
         "Signed build or independent verification run identity/status mismatch")
    for field in ("repository", "head_repository"):
        need(isinstance(data.get(field), dict) and data[field].get("full_name") == REPO, "Run repository mismatch")


def check_artifact(data):
    rows = data.get("artifacts")
    need(isinstance(rows, list) and type(data.get("total_count")) is int and data["total_count"] == len(rows)
         and len(rows) <= 100 and all(isinstance(item, dict) for item in rows), "Complete artifact listing is required")
    matches = [item for item in rows if item.get("name") == ARTIFACT_NAME and item.get("expired") is False]
    need(len(matches) == 1, "Exactly one live named verification artifact is required")
    artifact = matches[0]
    need(type(artifact.get("id")) is int and artifact["id"] == ARTIFACT_ID
         and type(artifact.get("size_in_bytes")) is int and artifact["size_in_bytes"] == ARTIFACT_SIZE
         and artifact.get("digest") == f"sha256:{ARTIFACT_DIGEST}", "Artifact ID, size, or official ZIP digest mismatch")
    workflow = artifact.get("workflow_run")
    need(isinstance(workflow, dict) and workflow.get("id") == VERIFY_RUN and workflow.get("head_sha") == SOURCE,
         "Artifact provenance mismatch")


def check_notes(tested):
    need(command(["git", "-C", str(tested), "rev-parse", "HEAD"]).decode().strip() == SOURCE, "Tested-source checkout mismatch")
    need(not command(["git", "-C", str(tested), "status", "--porcelain"]).strip(), "Tested-source checkout is not clean")
    pkg = json.loads((tested / "package.json").read_text(encoding="utf-8"))
    app = json.loads((tested / "app.json").read_text(encoding="utf-8"))["expo"]
    need(pkg.get("version") == VERSION and app.get("version") == VERSION
         and app.get("android", {}).get("package") == PACKAGE and app["android"].get("versionCode") == CODE
         and app.get("ios", {}).get("bundleIdentifier") == PACKAGE and app["ios"].get("buildNumber") == str(CODE),
         "Exact release source version identities are required")
    notes = tested / "docs" / f"RELEASE-{VERSION}.md"
    other = tested / "docs" / f"RELEASE-{TAG}.md"
    regular(notes)
    need(not other.exists() and not other.is_symlink() and 0 < notes.stat().st_size <= 1024 * 1024
         and bool(notes.read_text(encoding="utf-8").strip()), "Exactly one non-empty fixed-version notes file is required")
    return notes


def check_entry(info, allow_dirs=False):
    name = info.filename
    need(bool(name) and info.orig_filename == name and not name.startswith("/") and "\\" not in name
         and ":" not in name and "\x00" not in name and all(part not in ("", ".", "..") for part in name.rstrip("/").split("/")),
         "ZIP entry path is unsafe")
    mode = stat.S_IFMT(info.external_attr >> 16)
    need((allow_dirs and info.is_dir() and mode in (0, stat.S_IFDIR))
         or (not info.is_dir() and mode in (0, stat.S_IFREG) and not info.external_attr & 0x10), "ZIP directory, link, or special file is forbidden")
    need(not info.flag_bits & 1 and info.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED), "ZIP encryption/compression is unsupported")


def unpack(archive_path, output):
    need(archive_path.stat().st_size == ARTIFACT_SIZE and sha(archive_path) == ARTIFACT_DIGEST, "Downloaded ZIP size or official digest mismatch")
    with zipfile.ZipFile(archive_path) as archive:
        entries = archive.infolist()
        need(len(entries) == 2 and {item.filename for item in entries} == {APK, APK + ".sha256"}, "ZIP must contain exactly the APK and sidecar")
        for item in entries:
            check_entry(item)
            need(0 < item.file_size <= (MAX_APK if item.filename == APK else 1024), "ZIP entry size is invalid")
        for item in entries:
            count = 0
            with archive.open(item) as source, (output / item.filename).open("xb") as target:
                while chunk := source.read(1024 * 1024):
                    count += len(chunk)
                    need(count <= item.file_size, "ZIP entry exceeds declared size")
                    target.write(chunk)
            need(count == item.file_size, "ZIP entry is truncated")
    sidecar = (output / (APK + ".sha256")).read_text(encoding="ascii")
    match = re.fullmatch(r"([0-9a-fA-F]{64}) [ *]" + re.escape(APK) + r"(?:\r?\n)?", sidecar)
    need(match is not None and sha(output / APK) == match.group(1).lower(), "Exact APK sidecar check failed")
    return output / APK


def check_apk(apk):
    counts = {abi: 0 for abi in ABIS}
    with zipfile.ZipFile(apk) as archive:
        entries = archive.infolist()
        names = {item.filename for item in entries}
        need(0 < len(entries) <= 100000 and len(entries) == len(names)
             and sum(item.file_size for item in entries) <= 2 * 1024**3 and {"AndroidManifest.xml", "classes.dex"} <= names,
             "APK entries, expanded size, manifest, or bytecode are invalid")
        found = set()
        for item in entries:
            check_entry(item, allow_dirs=True)
            parts = item.filename.rstrip("/").split("/")
            if parts[0] == "lib" and len(parts) > 1:
                found.add(parts[1])
            if not item.is_dir() and item.filename.endswith(".so"):
                need(len(parts) == 3 and parts[0] == "lib" and parts[1] in ABIS, "Unexpected native ABI or library path")
                with archive.open(item) as library:
                    header = library.read(64)
                elf_class, machine = ABIS[parts[1]]
                need(len(header) >= (64 if elf_class == 2 else 52) and header[:7] == b"\x7fELF" + bytes([elf_class, 1, 1])
                     and struct.unpack_from("<HHI", header, 16) == (3, machine, 1), "Native ELF class/machine/type mismatch")
                counts[parts[1]] += 1
        need(found == set(ABIS) and all(counts.values()) and archive.testzip() is None, "APK CRC or exact two-ABI validation failed")
    return counts


def android_identity(apk, tools, version, code):
    output = command([str(tools / "apksigner"), "verify", "--verbose", "--print-certs", str(apk)], timeout=300).decode()
    certificates = re.findall(r"^Signer #(\d+) certificate SHA-256 digest: ([0-9a-fA-F]{64})\s*$", output, re.MULTILINE)
    need(certificates == [("1", CERT)] and re.search(r"^Number of signers: 1\s*$", output, re.MULTILINE)
         and re.search(r"^Verified using v(?:2|3|3\.1) scheme[^\r\n]*: true\s*$", output, re.MULTILINE), "Official APK cryptographic signing identity is invalid")
    lines = command([str(tools / "aapt"), "dump", "badging", str(apk)]).decode().splitlines()
    need(bool(lines) and lines[0].startswith("package: "), "APK package metadata is missing")
    pairs = re.findall(r"([A-Za-z][A-Za-z0-9_]*)='([^']*)'", lines[0])
    fields = dict(pairs)
    need(len(pairs) == len(fields) and fields.get("name") == PACKAGE and fields.get("versionName") == version
         and fields.get("versionCode") == str(code), "APK package/version/code mismatch")


def require_absent_release():
    need(not any(release["tag_name"] == TAG for release in all_releases()), "An existing release or draft must not be changed")


def create_draft(apk, sidecar, notes):
    global create_attempted
    # Set before starting gh: timeout/403/upload failure may leave a partial
    # draft. Never claim no external change or retry automatically afterwards.
    create_attempted = True
    command(["gh", "release", "create", TAG, str(apk), str(sidecar), "--repo", REPO,
             "--verify-tag", "--draft", "--title", f"Salcara AI {TAG}", "--notes-file", str(notes)], timeout=600)


def verify_created_draft(output):
    matches = [release for release in all_releases() if release["tag_name"] == TAG]
    need(len(matches) == 1 and matches[0]["draft"] is True and matches[0]["prerelease"] is False
         and matches[0]["published_at"] is None, "The complete listing must contain exactly one unpublished target draft")
    release_id = matches[0]["id"]
    need(positive_id(release_id), "Draft listing release ID is invalid")
    # Numeric IDs address drafts; do not read the published-only tag endpoint.
    draft = api(f"releases/{release_id}")
    need(positive_id(draft.get("id")) and draft["id"] == release_id and draft.get("tag_name") == TAG
         and draft.get("draft") is True and draft.get("prerelease") is False
         and "published_at" in draft and draft["published_at"] is None, "Created release identity or unpublished draft state changed")
    assets = draft.get("assets")
    need(isinstance(assets, list) and len(assets) == 2 and all(isinstance(asset, dict) for asset in assets)
         and {asset.get("name") for asset in assets} == {APK, APK + ".sha256"}, "Draft must contain only the two verified original assets")
    asset_ids = [asset.get("id") for asset in assets]
    need(all(positive_id(asset_id) for asset_id in asset_ids) and len(set(asset_ids)) == len(asset_ids)
         and all(asset.get("state") == "uploaded" for asset in assets), "Draft assets have invalid IDs or are not fully uploaded")
    for asset in assets:
        local = output / asset["name"]
        regular(local)
        need(type(asset.get("size")) is int and asset["size"] == local.stat().st_size
             and asset.get("digest") == f"sha256:{sha(local)}", "Draft asset bytes differ from runner-verified bytes")
    return draft


def main():
    global create_attempted
    create_attempted = False
    need(sys.platform.startswith("linux") and os.environ.get("GITHUB_REPOSITORY") == REPO
         and os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch", "Only the fixed official manual Linux workflow may stage this draft")
    check_tag(api(f"git/ref/tags/{TAG}"))
    require_absent_release()
    check_run(api(f"actions/runs/{BUILD_RUN}"), BUILD_RUN, "release.yml")
    check_run(api(f"actions/runs/{VERIFY_RUN}"), VERIFY_RUN, "publish-verified-apk.yml")
    check_artifact(api(f"actions/runs/{VERIFY_RUN}/artifacts?per_page=100"))
    tested = Path("tested-source").resolve()
    notes = check_notes(tested)
    output = Path("verified-stage").absolute()
    output.mkdir(exist_ok=False)
    archive = output / "artifact.zip"
    with archive.open("xb") as target:
        command(["gh", "api", f"repos/{REPO}/actions/artifacts/{ARTIFACT_ID}/zip", "--method", "GET"], timeout=600, stdout=target)
    apk = unpack(archive, output)
    counts = check_apk(apk)
    previous = api("releases/tags/v1.8.4")
    need(previous.get("tag_name") == "v1.8.4" and previous.get("draft") is False and previous.get("prerelease") is False
         and bool(previous.get("published_at")), "Previous official stable release is unavailable")
    old_assets = [asset for asset in previous.get("assets", []) if asset.get("name") == OLD_APK]
    need(len(old_assets) == 1 and type(old_assets[0].get("id")) is int and old_assets[0]["id"] > 0
         and old_assets[0].get("size") == OLD_SIZE and old_assets[0].get("digest") == f"sha256:{OLD_SHA}", "Previous exact production asset metadata mismatch")
    old = output / OLD_APK
    with old.open("xb") as target:
        command(["gh", "api", f"repos/{REPO}/releases/assets/{old_assets[0]['id']}", "--method", "GET", "-H", "Accept: application/octet-stream"], timeout=600, stdout=target)
    need(old.stat().st_size == OLD_SIZE and sha(old) == OLD_SHA, "Previous exact production APK bytes mismatch")
    sdk = Path(os.environ.get("ANDROID_HOME", "")) / "build-tools"
    need(sdk.is_absolute() and sdk.is_dir(), "Android SDK build tools are required")
    candidates = [str(path) for path in sdk.iterdir() if path.is_dir()]
    need(bool(candidates), "Android SDK build tools are unavailable")
    tools = Path(command(["sort", "-V"], input=("\n".join(candidates) + "\n").encode()).decode().splitlines()[-1])
    for executable in (tools / "apksigner", tools / "aapt"):
        regular(executable)
    android_identity(old, tools, "1.8.4", 25)
    android_identity(apk, tools, VERSION, CODE)
    upgrade_script = tested / "scripts" / "verify-apk-upgrade.sh"
    regular(upgrade_script)
    command(["bash", str(upgrade_script), str(apk), str(old)], timeout=300)
    facts = {"status": "verified-for-draft", "source_sha": SOURCE, "build_run": BUILD_RUN, "verify_run": VERIFY_RUN,
             "artifact_id": ARTIFACT_ID, "artifact_zip_size": ARTIFACT_SIZE, "artifact_zip_sha256": ARTIFACT_DIGEST,
             "apk": APK, "apk_size": apk.stat().st_size, "apk_sha256": sha(apk), "package": PACKAGE,
             "version": VERSION, "version_code": CODE, "certificate_sha256": CERT, "native_libraries": counts}
    print(json.dumps(facts, separators=(",", ":")), flush=True)
    # Recheck immediately before the only remote mutation. --verify-tag must
    # never be replaced by implicit tag creation. Any 403/nonzero exits here.
    check_tag(api(f"git/ref/tags/{TAG}"))
    require_absent_release()
    create_draft(apk, output / (APK + ".sha256"), notes)
    check_tag(api(f"git/ref/tags/{TAG}"))
    draft = verify_created_draft(output)
    print(json.dumps({"status": "draft-staged", "tag": TAG, "source_sha": SOURCE, "release_id": draft.get("id"),
                      "apk_sha256": facts["apk_sha256"], "published": False}, separators=(",", ":")), flush=True)


def failure_facts(error):
    return {"status": "failed", "error": str(error) if isinstance(error, GateError) else f"Validation failed ({type(error).__name__})",
            "create_attempted": create_attempted, **({"draft_may_exist": True} if create_attempted else {})}


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Never echo tokens, native/API stderr, or authenticated download URLs.
        print(json.dumps(failure_facts(error)), file=sys.stderr)
        sys.exit(1)
