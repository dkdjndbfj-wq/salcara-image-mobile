"""Offline candidate gates only. Never invokes the workflow or GitHub."""

import ast
import hashlib
import io
import json
from pathlib import Path
import stat
import struct
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import stage_verified_apk_draft as stage


QA = Path(__file__).parent


def http(status, body):
    return f"HTTP/2.0 {status} fixture\r\nContent-Type: application/json\r\n\r\n".encode() + json.dumps(body).encode()


def run(run_id, workflow):
    return {"id": run_id, "status": "completed", "conclusion": "success", "event": "workflow_dispatch",
            "path": f".github/workflows/{workflow}", "head_sha": stage.SOURCE,
            "repository": {"full_name": stage.REPO}, "head_repository": {"full_name": stage.REPO}}


def artifact():
    return {"id": stage.ARTIFACT_ID, "name": stage.ARTIFACT_NAME, "expired": False, "size_in_bytes": stage.ARTIFACT_SIZE,
            "digest": f"sha256:{stage.ARTIFACT_DIGEST}", "workflow_run": {"id": stage.VERIFY_RUN, "head_sha": stage.SOURCE}}


def release(release_id=123, tag=stage.TAG, draft=True):
    return {"id": release_id, "tag_name": tag, "draft": draft, "prerelease": False,
            "published_at": None if draft else "2026-11-11T00:00:00Z"}


def uploaded_draft(root):
    assets = []
    for index, name in enumerate((stage.APK, stage.APK + ".sha256")):
        path = root / name
        with path.open("xb") as output:
            output.write(("synthetic original bytes " + name).encode())
        assets.append({"id": 1000 + index, "name": name, "state": "uploaded", "size": path.stat().st_size, "digest": "sha256:" + stage.sha(path)})
    return {**release(), "assets": assets}


def apk_payload(wrong_machine=False, missing_abi=False):
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr("AndroidManifest.xml", b"unique-crc-manifest-fixture")
        archive.writestr("classes.dex", b"synthetic-bytecode")
        for abi, (elf_class, machine) in stage.ABIS.items():
            if missing_abi and abi == "armeabi-v7a":
                continue
            header = bytearray(64)
            header[:7] = b"\x7fELF" + bytes([elf_class, 1, 1])
            struct.pack_into("<HHI", header, 16, 3, 0 if wrong_machine else machine, 1)
            archive.writestr(f"lib/{abi}/libfixture.so", header)
    return data.getvalue()


class DraftGates(unittest.TestCase):
    def test_read_apis_require_200_and_never_treat_404_as_draft_absence(self):
        self.assertEqual(stage.parse_api_response(http(200, {"ok": True}), 0), {"ok": True})
        for raw, code in [(http(403, {"message": "Resource not accessible by integration"}), 1),
                          (http(401, {"message": "Bad credentials"}), 1), (b"", 1),
                          (b'{"message":"Not Found","status":"404"}', 1),
                          (http(404, {"message": "Not Found"}), 0),
                          (http(404, {"message": "Not Found"}), 1)]:
            with self.subTest(raw=raw), self.assertRaises(stage.GateError):
                stage.parse_api_response(raw, code)

    def test_existing_draft_or_release_is_never_reused(self):
        for existing in (release(draft=True), release(draft=False)):
            with patch.object(stage, "all_releases", return_value=[existing]), self.assertRaises(stage.GateError):
                stage.require_absent_release()

    def test_tag_endpoint_404_cannot_hide_an_existing_draft_in_full_listing(self):
        # A published-only lookup would report 404; the gate must never use it.
        with patch.object(stage, "api", side_effect=stage.GateError("HTTP 404")) as tag_lookup, patch.object(stage, "command", return_value=json.dumps([[release()]]).encode()) as listing:
            with self.assertRaises(stage.GateError):
                stage.require_absent_release()
            tag_lookup.assert_not_called()
            arguments = listing.call_args.args[0]
            self.assertIn(f"repos/{stage.REPO}/releases?per_page=100", arguments)
            self.assertIn("--paginate", arguments)
            self.assertIn("--slurp", arguments)

    def test_full_listing_checks_pages_rows_ids_and_duplicates(self):
        first = [release(index + 1, f"v0.0.{index}") for index in range(100)]
        self.assertEqual(len(stage.parse_release_pages(json.dumps([first, [release(101)]]).encode())), 101)
        self.assertEqual(stage.parse_release_pages(b"[[]]"), [])
        invalid_pages = [[], {}, [release()], [[None]], [[release(0)]], [[release(True)]], [[release("123")]],
                         [[release(), release()]], [first, [release(1)]], [[release()], [release(124)]],
                         [[{**release(), "draft": "true"}]], [[{**release(), "published_at": "2026-11-11T00:00:00Z"}]],
                         [[{**release(), "tag_name": "bad\nname"}]], [[{**release(draft=False), "published_at": None}]]]
        for pages in invalid_pages:
            with self.subTest(pages=pages), self.assertRaises(stage.GateError):
                stage.parse_release_pages(json.dumps(pages).encode())
        with self.assertRaises(ValueError):
            stage.parse_release_pages(b"[[")

    def test_created_draft_is_read_back_by_numeric_id_and_exact_assets(self):
        with tempfile.TemporaryDirectory(prefix="draft-test-", dir=QA) as temporary:
            root = Path(temporary)
            draft = uploaded_draft(root)
            with patch.object(stage, "all_releases", return_value=[release()]), patch.object(stage, "api", return_value=draft) as details:
                self.assertEqual(stage.verify_created_draft(root)["id"], 123)
                details.assert_called_once_with("releases/123")

    def test_created_draft_rejects_nonuploaded_bad_asset_ids_and_changed_identity(self):
        with tempfile.TemporaryDirectory(prefix="draft-test-", dir=QA) as temporary:
            root = Path(temporary)
            good = uploaded_draft(root)
            for change in [{"state": "new"}, {"state": "starter"}, {"id": 0}, {"id": -1}, {"id": True}, {"id": "1000"},
                           {"id": good["assets"][1]["id"]}, {"size": 999}, {"digest": "sha256:" + "0" * 64}]:
                bad = {**good, "assets": [{**good["assets"][0], **change}, good["assets"][1]]}
                with self.subTest(change=change), patch.object(stage, "all_releases", return_value=[release()]), patch.object(stage, "api", return_value=bad), self.assertRaises(stage.GateError):
                    stage.verify_created_draft(root)
            for change in [{"id": 124}, {"id": True}, {"tag_name": "v1.8.4"}, {"draft": False}, {"published_at": "2026-11-11T00:00:00Z"}]:
                with self.subTest(change=change), patch.object(stage, "all_releases", return_value=[release()]), patch.object(stage, "api", return_value={**good, **change}), self.assertRaises(stage.GateError):
                    stage.verify_created_draft(root)

    def test_created_draft_requires_a_unique_listing_match_before_numeric_read(self):
        for entries in ([], [release(), release(124)], [release(draft=False)]):
            with self.subTest(entries=entries), patch.object(stage, "all_releases", return_value=entries), patch.object(stage, "api") as details:
                with self.assertRaises(stage.GateError):
                    stage.verify_created_draft(Path("not-read"))
                details.assert_not_called()

    def test_failed_create_reports_possible_partial_draft_and_never_retries(self):
        with patch.object(stage, "create_attempted", False), patch.object(stage, "command", side_effect=stage.GateError("Synthetic create failure")) as create:
            with self.assertRaises(stage.GateError) as caught:
                stage.create_draft(Path("fixture.apk"), Path("fixture.sha256"), Path("notes.md"))
            self.assertEqual(create.call_count, 1)
            self.assertTrue(stage.create_attempted)
            facts = stage.failure_facts(caught.exception)
            self.assertTrue(facts["create_attempted"])
            self.assertTrue(facts["draft_may_exist"])
        with patch.object(stage, "create_attempted", False):
            self.assertNotIn("draft_may_exist", stage.failure_facts(stage.GateError("Read gate failed")))

    def test_tag_must_already_be_a_direct_commit_at_exact_source(self):
        valid = {"ref": f"refs/tags/{stage.TAG}", "object": {"type": "commit", "sha": stage.SOURCE}}
        stage.check_tag(valid)
        for invalid in [{**valid, "ref": "refs/tags/v1.8.4"}, {**valid, "object": {"type": "tag", "sha": stage.SOURCE}},
                        {**valid, "object": {"type": "commit", "sha": "0" * 40}}, {}]:
            with self.subTest(invalid=invalid), self.assertRaises(stage.GateError):
                stage.check_tag(invalid)

    def test_both_exact_successful_manual_runs(self):
        for run_id, workflow in [(stage.BUILD_RUN, "release.yml"), (stage.VERIFY_RUN, "publish-verified-apk.yml")]:
            valid = run(run_id, workflow)
            stage.check_run(valid, run_id, workflow)
            for field, value in {"id": 1, "status": "in_progress", "conclusion": "failure", "event": "push", "path": ".github/workflows/ci.yml", "head_sha": "0" * 40, "head_repository": {"full_name": "fork/repo"}}.items():
                with self.subTest(run=run_id, field=field), self.assertRaises(stage.GateError):
                    stage.check_run({**valid, field: value}, run_id, workflow)

    def test_unique_artifact_must_match_all_frozen_facts(self):
        valid = artifact()
        stage.check_artifact({"total_count": 1, "artifacts": [valid]})
        for field, value in {"id": 1, "name": "other", "expired": True, "size_in_bytes": stage.ARTIFACT_SIZE + 1, "digest": "sha256:" + "0" * 64, "workflow_run": {"id": 1, "head_sha": stage.SOURCE}}.items():
            with self.subTest(field=field), self.assertRaises(stage.GateError):
                stage.check_artifact({"total_count": 1, "artifacts": [{**valid, field: value}]})
        for data in [{"total_count": 2, "artifacts": [valid]}, {"total_count": 2, "artifacts": [valid, valid]}]:
            with self.assertRaises(stage.GateError):
                stage.check_artifact(data)

    def test_zip_path_links_and_directories_fail_closed(self):
        for name in ["../escape", "/absolute", "folder\\file", "C:drive", "directory/"]:
            with self.subTest(name=name), self.assertRaises(stage.GateError):
                stage.check_entry(zipfile.ZipInfo(name))
        link = zipfile.ZipInfo(stage.APK)
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        with self.assertRaises(stage.GateError):
            stage.check_entry(link)

    def test_exact_zip_digest_two_file_extraction_and_checksum(self):
        with tempfile.TemporaryDirectory(prefix="draft-test-", dir=QA) as temporary:
            root = Path(temporary)
            payload = apk_payload()
            source = root / "artifact.zip"
            with zipfile.ZipFile(source, "x", compression=zipfile.ZIP_DEFLATED) as archive:
                archive.writestr(stage.APK, payload)
                archive.writestr(stage.APK + ".sha256", hashlib.sha256(payload).hexdigest() + "  " + stage.APK + "\n")
            output = root / "output"
            output.mkdir()
            with patch.object(stage, "ARTIFACT_SIZE", source.stat().st_size), patch.object(stage, "ARTIFACT_DIGEST", stage.sha(source)):
                apk = stage.unpack(source, output)
            self.assertEqual(stage.check_apk(apk), {"arm64-v8a": 1, "armeabi-v7a": 1})
            self.assertEqual({path.name for path in output.iterdir()}, {stage.APK, stage.APK + ".sha256"})
            with self.assertRaises(stage.GateError):
                stage.unpack(source, output)  # Frozen real ZIP size/digest reject fixture.

    def test_crc_and_elf_mismatch_are_not_hidden_by_a_valid_apk_zip(self):
        valid = apk_payload()
        cases = [apk_payload(wrong_machine=True), apk_payload(missing_abi=True), valid.replace(b"unique-crc-manifest-fixture", b"Xnique-crc-manifest-fixture", 1)]
        with tempfile.TemporaryDirectory(prefix="draft-test-", dir=QA) as temporary:
            root = Path(temporary)
            for index, content in enumerate(cases):
                path = root / f"case-{index}.apk"
                with path.open("xb") as target:
                    target.write(content)
                with self.subTest(index=index), self.assertRaises(stage.GateError):
                    stage.check_apk(path)

    def test_android_certificate_package_and_code_are_required(self):
        signature = f"Verified using v2 scheme (APK Signature Scheme v2): true\nNumber of signers: 1\nSigner #1 certificate SHA-256 digest: {stage.CERT}\n".encode()
        package = b"package: name='top.salcara.image' versionCode='26' versionName='1.8.5'\n"
        with patch.object(stage, "command", side_effect=[signature, package]):
            stage.android_identity(Path("fixture.apk"), Path("tools"), "1.8.5", 26)
        for output in [[signature.replace(stage.CERT.encode(), b"a" * 64)], [signature.replace(b": true", b": false")], [signature, package.replace(b"26", b"25")], [signature, package.replace(b"1.8.5", b"1.8.4")]]:
            with self.subTest(output=output), patch.object(stage, "command", side_effect=output), self.assertRaises(stage.GateError):
                stage.android_identity(Path("fixture.apk"), Path("tools"), "1.8.5", 26)

    def test_workflow_has_no_inputs_or_publication_and_only_one_remote_mutation(self):
        workflow = (QA.parent / ".github" / "workflows" / "stage-verified-apk-draft.yml").read_text(encoding="utf-8")
        self.assertIn("  workflow_dispatch:\n", workflow)
        self.assertNotIn("inputs:", workflow)
        self.assertNotIn("  push:", workflow)
        self.assertIn("permissions: {}", workflow)
        self.assertIn("      contents: write\n      actions: read", workflow)
        self.assertIn(f"          ref: {stage.SOURCE}", workflow)
        source = (QA / "stage_verified_apk_draft.py").read_text(encoding="utf-8")
        tree = ast.parse(source)
        mutations = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "command" and node.args and isinstance(node.args[0], ast.List):
                values = [item.value for item in node.args[0].elts if isinstance(item, ast.Constant)]
                if values[:2] == ["gh", "release"]:
                    mutations.append(values)
        self.assertEqual(len(mutations), 1)
        self.assertEqual(mutations[0][:3], ["gh", "release", "create"])
        for flag in ("--verify-tag", "--draft", "--notes-file"):
            self.assertIn(flag, mutations[0])
        self.assertNotIn("--target", mutations[0])
        for forbidden in ("--target", "--clobber", "--generate-notes", "release\", \"edit", "git/refs\",", "publish-update-manifest"):
            self.assertNotIn(forbidden, source)


if __name__ == "__main__":
    unittest.main()
