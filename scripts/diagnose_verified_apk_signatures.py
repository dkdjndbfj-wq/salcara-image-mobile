"""REVIEW-ONLY candidate: read-only diagnostics, never release acceptance.

Install beside the audited scripts/stage_verified_apk_draft.py only if approved.
No stage entry point or mutation function is called. Raw subprocess output,
environment, credentials and URLs are never printed.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess
import sys
import unicodedata

import stage_verified_apk_draft as stage


SCHEMES = ("v1", "v2", "v3", "v3.1", "v4")
PUBLIC_CANDIDATE_TOKEN = r"(?:Signer|certificate|public|key|SHA-256|digest|fingerprint|minSdkVersion|maxSdkVersion|[0-9a-fA-F]{64}|[0-9]{1,10})"
PUBLIC_CANDIDATE_SEPARATOR = r"[ #()\[\],:=.-]"
PUBLIC_CANDIDATE_LINE = re.compile(rf"{PUBLIC_CANDIDATE_TOKEN}(?:{PUBLIC_CANDIDATE_SEPARATOR}+{PUBLIC_CANDIDATE_TOKEN})*{PUBLIC_CANDIDATE_SEPARATOR}*")


def public_candidates(raw, stream):
    stage.need(stream in ("stdout", "stderr"), "Unknown diagnostic stream")
    candidates = []
    # Split only actual LF/CRLF lines: other control characters must not be
    # treated as hidden separators that turn unsafe output into a safe line.
    for original in raw.decode("utf-8", errors="replace").split("\n"):
        if original.endswith("\r"):
            original = original[:-1]
        line = original.strip(" \t")
        if not line or len(line) > 256 or "\ufffd" in line or any(unicodedata.category(char).startswith("C") for char in line):
            continue
        if not re.search(r"\bSigner\b", line) or not re.search(r"(?<![0-9A-Za-z_])[0-9a-fA-F]{64}(?![0-9A-Za-z_])", line):
            continue
        # Only a fixed public vocabulary, decimal structure and punctuation
        # may surround the digest. Unknown DN attributes, owners and suffixes
        # must not pass merely because their labels escaped a blacklist.
        if not PUBLIC_CANDIDATE_LINE.fullmatch(line):
            continue
        candidates.append({"stream": stream, "line": line,
                           "leading_ascii_whitespace": len(original) - len(original.lstrip(" \t")),
                           "trailing_ascii_whitespace": len(original) - len(original.rstrip(" \t"))})
        if len(candidates) == 16:
            break
    return candidates


def public_signature_fields(raw):
    text = raw.decode("utf-8", errors="replace")
    # Public digest lines only: bounded format evidence without guessing the
    # SDK's signer prefix. Never include DN, other output, or redirect URLs.
    certificate_lines = [candidate["line"] for candidate in public_candidates(raw, "stdout")
                         if candidate["line"].startswith("Signer") and "certificate SHA-256 digest" in candidate["line"]
                         and re.search(r"[0-9a-fA-F]{64}$", candidate["line"])]
    certificates = [{"signer": int(number), "sha256": digest} for number, digest in re.findall(
        r"^Signer #([1-9][0-9]{0,8}) certificate SHA-256 digest: ([0-9a-fA-F]{64})[ \t]*\r?$", text, re.MULTILINE)]
    sdk_range_certificates = [{"min_sdk": int(minimum), "max_sdk": int(maximum), "sha256": digest}
                              for minimum, maximum, digest in re.findall(
                                  r"^Signer \(minSdkVersion=([0-9]{1,10}), maxSdkVersion=([0-9]{1,10})\) certificate SHA-256 digest: ([0-9a-fA-F]{64})[ \t]*\r?$",
                                  text, re.MULTILINE)
                              if int(minimum) <= 2**31 - 1 and int(maximum) <= 2**31 - 1]
    # Preserve hexadecimal case and duplicate certificate matches: either may
    # explain a strict parser failure, without exposing certificate DN or keys.
    counts = re.findall(r"^Number of signers: ([0-9]{1,9})[ \t]*\r?$", text, re.MULTILINE)
    count = int(counts[0]) if counts and len(set(counts)) == 1 else None
    matched = re.findall(r"^Verified using (v1|v2|v3|v3\.1|v4) scheme[^\r\n]*: (true|false)[ \t]*\r?$", text, re.MULTILINE)
    schemes = {}
    for scheme in SCHEMES:
        values = {value == "true" for name, value in matched if name == scheme}
        schemes[scheme] = values.pop() if len(values) == 1 else None
    # Evaluate the original gate on the untrimmed text; do not normalize case
    # or whitespace before reporting why that exact gate accepted/rejected it.
    stage_certificates = re.findall(r"^Signer #(\d+) certificate SHA-256 digest: ([0-9a-fA-F]{64})\s*$", text, re.MULTILINE)
    predicates = {"cert": stage_certificates == [("1", stage.CERT)],
                  "count": bool(re.search(r"^Number of signers: 1\s*$", text, re.MULTILINE)),
                  "scheme": bool(re.search(r"^Verified using v(?:2|3|3\.1) scheme[^\r\n]*: true\s*$", text, re.MULTILINE))}
    return {"certificate_lines": certificate_lines, "certificates": certificates or None, "sdk_range_certificates": sdk_range_certificates or None,
            "signer_count": count, "schemes": schemes, "stage_predicates": predicates}


def short_version(raw):
    text = raw.decode("ascii", errors="replace").strip()
    return text if re.fullmatch(r"[0-9]{1,6}(?:\.[0-9]{1,6}){0,3}(?:[-+][A-Za-z0-9._-]{1,24})?", text) else None


def probe(args, timeout=300):
    # Do not fail after the first nonzero signature result: collect both APKs.
    # A timed-out process is killed and reaped; report its actual integer code.
    process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        process.kill()
        stdout, stderr = process.communicate()
    return process.returncode, stdout, stderr


def signature_variants(tools):
    variants = [("latest-original", tools, ["--verbose", "--print-certs"]),
                ("latest-print-certs-only", tools, ["--print-certs"]),
                ("latest-explicit-true", tools, ["--verbose", "true", "--print-certs", "true"])]
    comparison = tools.parent / "36.0.0"
    if comparison != tools and (comparison / "apksigner").is_file():
        stage.regular(comparison / "apksigner")
        variants.append(("sdk36-original", comparison, ["--verbose", "--print-certs"]))
    return variants


def collect_signatures(tools, old, current):
    variants, versions, failed = [], {}, False
    digests = {apk: stage.sha(apk) for apk in (old, current)}
    for name, sdk_tools, flags in signature_variants(tools):
        if sdk_tools not in versions:
            version_code, version_raw, _version_stderr = probe([str(sdk_tools / "apksigner"), "--version"], timeout=30)
            failed = failed or version_code != 0
            versions[sdk_tools] = (version_code, short_version(version_raw) if version_code == 0 else None)
        records = []
        for apk in (old, current):
            exit_code, stdout, stderr = probe([str(sdk_tools / "apksigner"), "verify", *flags, str(apk)])
            failed = failed or exit_code != 0
            records.append({"name": apk.name, "sha256": digests[apk], "exit_code": exit_code,
                            **public_signature_fields(stdout),
                            "public_candidates": public_candidates(stdout, "stdout") + public_candidates(stderr, "stderr")})
        sdk_version = sdk_tools.name if re.fullmatch(r"[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}(?:[-.][A-Za-z0-9.-]{1,24})?", sdk_tools.name) else None
        variants.append({"variant": name, "sdk_version": sdk_version, "version_exit_code": versions[sdk_tools][0],
                         "apksigner_version": versions[sdk_tools][1], "packages": records})
    return {"status": "diagnostics-collected-not-release-acceptance", "variants": variants}, 1 if failed else 0


def main():
    stage.need(sys.platform.startswith("linux") and os.environ.get("GITHUB_REPOSITORY") == stage.REPO
               and os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch", "Only the fixed official manual Linux workflow may collect diagnostics")
    stage.check_tag(stage.api(f"git/ref/tags/{stage.TAG}"))
    stage.check_run(stage.api(f"actions/runs/{stage.BUILD_RUN}"), stage.BUILD_RUN, "release.yml")
    stage.check_run(stage.api(f"actions/runs/{stage.VERIFY_RUN}"), stage.VERIFY_RUN, "publish-verified-apk.yml")
    stage.check_artifact(stage.api(f"actions/runs/{stage.VERIFY_RUN}/artifacts?per_page=100"))
    stage.check_notes(Path("tested-source").resolve())
    output = Path("signature-diagnostics").absolute()
    output.mkdir(exist_ok=False)
    archive = output / "artifact.zip"
    with archive.open("xb") as target:
        stage.command(["gh", "api", f"repos/{stage.REPO}/actions/artifacts/{stage.ARTIFACT_ID}/zip", "--method", "GET"], timeout=600, stdout=target)
    current = stage.unpack(archive, output)
    stage.check_apk(current)
    previous = stage.api("releases/tags/v1.8.4")
    stage.need(previous.get("tag_name") == "v1.8.4" and previous.get("draft") is False and previous.get("prerelease") is False
               and bool(previous.get("published_at")), "Previous official stable release is unavailable")
    assets = [asset for asset in previous.get("assets", []) if asset.get("name") == stage.OLD_APK]
    stage.need(len(assets) == 1 and stage.positive_id(assets[0].get("id")) and assets[0].get("state") == "uploaded"
               and assets[0].get("size") == stage.OLD_SIZE and assets[0].get("digest") == f"sha256:{stage.OLD_SHA}", "Previous exact production asset metadata mismatch")
    old = output / stage.OLD_APK
    with old.open("xb") as target:
        stage.command(["gh", "api", f"repos/{stage.REPO}/releases/assets/{assets[0]['id']}", "--method", "GET", "-H", "Accept: application/octet-stream"], timeout=600, stdout=target)
    stage.need(old.stat().st_size == stage.OLD_SIZE and stage.sha(old) == stage.OLD_SHA, "Previous exact production APK bytes mismatch")
    sdk = Path(os.environ.get("ANDROID_HOME", "")) / "build-tools"
    stage.need(sdk.is_absolute() and sdk.is_dir(), "Android SDK build tools are required")
    candidates = [str(path) for path in sdk.iterdir() if path.is_dir()]
    stage.need(bool(candidates), "Android SDK build tools are unavailable")
    tools = Path(stage.command(["sort", "-V"], input=("\n".join(candidates) + "\n").encode()).decode().splitlines()[-1])
    stage.regular(tools / "apksigner")
    facts, exit_code = collect_signatures(tools, old, current)
    print(json.dumps(facts, separators=(",", ":")), flush=True)
    return exit_code


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        # Never echo unknown exception strings, command output or URLs.
        print(json.dumps({"status": "diagnostics-incomplete-not-release-acceptance"}), file=sys.stderr)
        sys.exit(1)
