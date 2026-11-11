"""Pure synthetic diagnostic checks; no network, workflow or APK execution."""

import ast
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import Mock, patch

import diagnose_verified_apk_signatures as diagnose


class DiagnosticTests(unittest.TestCase):
    def test_public_field_allowlist_never_echoes_unknown_output(self):
        raw = ("PRIVATE-FIXTURE-DO-NOT-ECHO https://example.invalid/private\n"
               "Signer #1 certificate DN: PRIVATE-FIXTURE-DO-NOT-ECHO\n"
               "Signer #1 certificate SHA-256 digest: " + "A" * 64 + "\n"
               "Number of signers: 1\nVerified using v2 scheme (APK Signature Scheme v2): true\n"
               "Verified using v3 scheme (APK Signature Scheme v3): false\n").encode()
        fields = diagnose.public_signature_fields(raw)
        self.assertEqual(set(fields), {"certificate_lines", "certificates", "sdk_range_certificates", "signer_count", "schemes", "stage_predicates"})
        self.assertEqual(fields["certificates"], [{"signer": 1, "sha256": "A" * 64}])
        self.assertEqual(fields["signer_count"], 1)
        self.assertEqual(fields["schemes"], {"v1": None, "v2": True, "v3": False, "v3.1": None, "v4": None})
        self.assertEqual(fields["stage_predicates"], {"cert": False, "count": True, "scheme": True})
        encoded = json.dumps(fields)
        self.assertNotIn("PRIVATE-FIXTURE", encoded)
        self.assertNotIn("https://", encoded)

    def test_sdk_range_only_signer_is_visible_without_changing_original_gate(self):
        digest = diagnose.stage.CERT.upper()
        raw = ("Verified using v3.1 scheme (APK Signature Scheme v3.1): true\nNumber of signers: 1\n"
               "Signer (minSdkVersion=33, maxSdkVersion=2147483647) certificate SHA-256 digest: " + digest + "\n"
               "Signer (minSdkVersion=33, maxSdkVersion=2147483647) certificate DN: PRIVATE-DN-FIXTURE\n"
               "Unrecognized output: PRIVATE-OTHER-FIXTURE\n").encode()
        fields = diagnose.public_signature_fields(raw)
        self.assertIsNone(fields["certificates"])
        self.assertEqual(fields["sdk_range_certificates"], [{"min_sdk": 33, "max_sdk": 2147483647, "sha256": digest}])
        self.assertEqual(fields["stage_predicates"], {"cert": False, "count": True, "scheme": True})
        self.assertTrue(fields["schemes"]["v3.1"])
        self.assertNotIn("PRIVATE", json.dumps(fields))
        for invalid in [raw.replace(b"minSdkVersion=33", b"minSdkVersion=secret"), raw.replace(b"2147483647", b"2147483648"), raw.replace(digest.encode(), b"not-a-public-fingerprint")]:
            self.assertIsNone(diagnose.public_signature_fields(invalid)["sdk_range_certificates"])

    def test_unmatched_or_conflicting_values_are_null(self):
        fields = diagnose.public_signature_fields(b"Number of signers: 1\nNumber of signers: 2\nVerified using v2 scheme: true\nVerified using v2 scheme: false\n")
        self.assertIsNone(fields["signer_count"])
        self.assertIsNone(fields["certificates"])
        self.assertIsNone(fields["schemes"]["v2"])
        for value in (b"version with secret", b"1.2\nPRIVATE", b"https://example.invalid", b""):
            self.assertIsNone(diagnose.short_version(value))
        self.assertEqual(diagnose.short_version(b"0.9\n"), "0.9")

    def test_nonzero_old_signature_still_collects_new_and_returns_nonzero(self):
        old, current = Path("old.apk"), Path("new.apk")
        results = [(0, b"0.9", b"PRIVATE-VERSION"), (1, b"PRIVATE-OLD-ERROR", b"PRIVATE-OLD-STDERR")]
        results += [(0, b"Number of signers: 1\n", b"PRIVATE-STDERR")] * 5
        with patch.object(diagnose, "probe", side_effect=results) as probe, patch.object(diagnose.stage, "sha", return_value="a" * 64):
            facts, code = diagnose.collect_signatures(Path("36.0.0"), old, current)
        self.assertEqual(probe.call_count, 7)
        self.assertEqual(code, 1)
        self.assertEqual([record["exit_code"] for record in facts["variants"][0]["packages"]], [1, 0])
        self.assertEqual(set(facts), {"status", "variants"})
        self.assertEqual(len(facts["variants"]), 3)
        for variant in facts["variants"]:
            self.assertEqual(set(variant), {"variant", "sdk_version", "version_exit_code", "apksigner_version", "packages"})
            for record in variant["packages"]:
                self.assertEqual(set(record), {"name", "sha256", "exit_code", "certificate_lines", "certificates", "sdk_range_certificates", "signer_count", "schemes", "stage_predicates", "public_candidates"})
        self.assertNotIn("PRIVATE", json.dumps(facts))
        self.assertEqual(facts["status"], "diagnostics-collected-not-release-acceptance")

    def test_public_digest_line_evidence_is_bounded_without_guessing_signer_prefix(self):
        digest = "a" * 64
        public = "Signer #1 (minSdkVersion=24,maxSdkVersion=2147483647) certificate SHA-256 digest: " + digest
        rejected = ["PRIVATE " + public, "Signer certificate DN: PRIVATE certificate SHA-256 digest: " + digest,
                    "Signer https://example.invalid/private certificate SHA-256 digest: " + digest,
                    "Signer " + "x" * 256 + " certificate SHA-256 digest: " + digest,
                    "Signer certificate SHA-256 digest: " + digest + " PRIVATE"]
        fields = diagnose.public_signature_fields(("\n".join(rejected + [public] * 20)).encode())
        self.assertEqual(fields["certificate_lines"], [public] * 16)
        self.assertNotIn("PRIVATE", json.dumps(fields))
        self.assertFalse(fields["stage_predicates"]["cert"])

    def test_two_zero_exit_codes_mean_collection_only_not_release_acceptance(self):
        with patch.object(diagnose, "probe", side_effect=[(0, b"bad version private", b"")] + [(0, b"", b"")] * 6), patch.object(diagnose.stage, "sha", return_value="a" * 64):
            facts, code = diagnose.collect_signatures(Path("36.0.0"), Path("old.apk"), Path("new.apk"))
        self.assertEqual(code, 0)
        for variant in facts["variants"]:
            self.assertIsNone(variant["apksigner_version"])
            self.assertTrue(all(record["signer_count"] is None for record in variant["packages"]))
        self.assertIn("not-release-acceptance", facts["status"])

    def test_nonzero_version_is_reported_without_skipping_signature_variants(self):
        with patch.object(diagnose, "probe", side_effect=[(4, b"0.9", b"PRIVATE-VERSION-ERROR")] + [(0, b"", b"")] * 6) as probe, patch.object(diagnose.stage, "sha", return_value="a" * 64):
            facts, code = diagnose.collect_signatures(Path("36.0.0"), Path("old.apk"), Path("new.apk"))
        self.assertEqual(code, 1)
        self.assertEqual(probe.call_count, 7)
        for variant in facts["variants"]:
            self.assertEqual(variant["version_exit_code"], 4)
            self.assertIsNone(variant["apksigner_version"])
            self.assertEqual([record["exit_code"] for record in variant["packages"]], [0, 0])
        self.assertNotIn("PRIVATE", json.dumps(facts))

    def test_dual_stream_candidates_trim_ascii_edges_and_exclude_other_output(self):
        line = "Signer #1 certificate SHA-256 digest: " + "a" * 64
        unsafe = ["unrelated stdout or stderr PRIVATE", "Signer certificate DN: CN=PRIVATE " + "a" * 64,
                  "Signer Subject: PRIVATE " + "a" * 64, "Signer CN=PRIVATE " + "a" * 64,
                  "Signer https://example.invalid/PRIVATE " + "a" * 64, "Signer www.example.invalid " + "a" * 64,
                  "Signer file:/PRIVATE " + "a" * 64, "Signer token=PRIVATE " + "a" * 64]
        raw = ("\n".join(unsafe) + "\n \t " + line + "\t \r\n").encode()
        for stream in ("stdout", "stderr"):
            candidates = diagnose.public_candidates(raw, stream)
            self.assertEqual(candidates, [{"stream": stream, "line": line, "leading_ascii_whitespace": 3, "trailing_ascii_whitespace": 2}])
            self.assertNotIn("PRIVATE", json.dumps(candidates))

    def test_candidate_control_chars_and_nonindependent_hash_are_rejected(self):
        digest = "a" * 64
        for control in ("\x00", "\x1b", "\x7f", "\x85", "\v", "\f", "\r", "\u202e", "\t"):
            raw = ("Signer #1" + control + " certificate SHA-256 digest: " + digest).encode()
            with self.subTest(control=repr(control)):
                self.assertEqual(diagnose.public_candidates(raw, "stdout"), [])
        for invalid in ("Signer " + "a" * 65, "Signer X" + digest + "Z", "No signer " + digest):
            self.assertEqual(diagnose.public_candidates(invalid.encode(), "stderr"), [])

    def test_candidate_fixed_vocabulary_rejects_unknown_dn_owner_and_suffixes(self):
        digest = "a" * 64
        public = "Signer #1 certificate SHA-256 digest: " + digest
        rejected = ["Signer 2.5.4.3=Alice Family " + digest,
                    "Signer certificate owner Alice Family " + digest,
                    public + " Alice Family", public + " (Alice)",
                    "Signer certificate SHA-256 digest: Alice " + digest,
                    "Signer certificate SHA-256 digest: " + digest + " 未知姓名",
                    "Signer certificate SHA-256 digest: " + digest + " owner=12345",
                    "Signer certificate SHA-256 digest: " + digest + " subjectAltName=example",
                    "Signer certificate SHA-256 digest: " + digest + " api-key=12345",
                    "Signer callback //192.0.2.1/download?sig=opaque " + digest,
                    "Signer //192.0.2.1/12345 " + digest]
        allowed = [public,
                   "Signer #1 (minSdkVersion=24,maxSdkVersion=2147483647) certificate SHA-256 digest: " + digest,
                   "Signer (minSdkVersion=33, maxSdkVersion=2147483647) certificate SHA-256 digest: " + digest,
                   "Signer #1 [minSdkVersion=24, maxSdkVersion=2147483647] certificate SHA-256 digest: " + digest,
                   "Signer #1 public key SHA-256 digest: " + digest,
                   "Signer #1 fingerprint: " + digest]
        for stream in ("stdout", "stderr"):
            for line in rejected:
                with self.subTest(stream=stream, rejected=line):
                    self.assertEqual(diagnose.public_candidates(line.encode(), stream), [])
                    self.assertEqual(diagnose.public_signature_fields(line.encode())["certificate_lines"], [])
            self.assertEqual([row["line"] for row in diagnose.public_candidates("\n".join(allowed).encode(), stream)], allowed)

    def test_candidate_256_character_and_16_per_stream_boundaries(self):
        digest = "a" * 64
        prefix = "Signer #1 certificate SHA-256 digest:"
        exact = prefix + " " * (256 - len(prefix) - len(digest)) + digest
        self.assertEqual(len(exact), 256)
        too_long = exact.replace("Signer ", "Signer  ", 1)
        raw = (too_long + "\n" + "\n".join([" \t" + exact + "\t "] * 20)).encode()
        for stream in ("stdout", "stderr"):
            candidates = diagnose.public_candidates(raw, stream)
            self.assertEqual(len(candidates), 16)
            self.assertTrue(all(item["line"] == exact and len(item["line"]) == 256 for item in candidates))

    def test_probe_retains_both_streams_and_reaps_timeout_without_printing(self):
        process = Mock(returncode=7)
        process.communicate.return_value = (b"public stdout", b"private stderr")
        with patch.object(diagnose.subprocess, "Popen", return_value=process) as launch:
            self.assertEqual(diagnose.probe(["synthetic-tool"]), (7, b"public stdout", b"private stderr"))
        self.assertEqual(launch.call_args.kwargs, {"stdout": subprocess.PIPE, "stderr": subprocess.PIPE})
        process = Mock(returncode=-9)
        process.communicate.side_effect = [subprocess.TimeoutExpired("synthetic-tool", 1), (b"partial", b"private")]
        with patch.object(diagnose.subprocess, "Popen", return_value=process):
            self.assertEqual(diagnose.probe(["synthetic-tool"], timeout=1), (-9, b"partial", b"private"))
        process.kill.assert_called_once_with()

    def test_all_flags_sdk36_comparison_and_both_streams_are_sampled_without_short_circuit(self):
        tools, comparison = Path("sdk/37.0.0"), Path("sdk/36.0.0")
        old, current = Path("old.apk"), Path("new.apk")
        public = ("Signer #1 fingerprint: " + "a" * 64).encode()
        calls = []
        def result(arguments, timeout=300):
            calls.append(arguments)
            if "--version" in arguments:
                return 0, b"0.9", b"PRIVATE-VERSION"
            code = 5 if arguments == [str(tools / "apksigner"), "verify", "--verbose", "--print-certs", str(old)] else 0
            return code, b"PRIVATE-STDOUT\n" + public, b"PRIVATE-STDERR\n" + public
        with patch.object(Path, "is_file", return_value=True), patch.object(diagnose.stage, "regular") as regular, patch.object(diagnose, "probe", side_effect=result), patch.object(diagnose.stage, "sha", return_value="a" * 64):
            facts, code = diagnose.collect_signatures(tools, old, current)
        self.assertEqual(code, 1)
        regular.assert_called_once_with(comparison / "apksigner")
        expected = [[str(tools / "apksigner"), "--version"]]
        for flags in (["--verbose", "--print-certs"], ["--print-certs"], ["--verbose", "true", "--print-certs", "true"]):
            expected += [[str(tools / "apksigner"), "verify", *flags, str(apk)] for apk in (old, current)]
        expected += [[str(comparison / "apksigner"), "--version"]]
        expected += [[str(comparison / "apksigner"), "verify", "--verbose", "--print-certs", str(apk)] for apk in (old, current)]
        self.assertEqual(calls, expected)
        self.assertEqual([variant["variant"] for variant in facts["variants"]], ["latest-original", "latest-print-certs-only", "latest-explicit-true", "sdk36-original"])
        for variant in facts["variants"]:
            self.assertEqual(variant["version_exit_code"], 0)
            self.assertEqual([record["name"] for record in variant["packages"]], ["old.apk", "new.apk"])
            for record in variant["packages"]:
                self.assertEqual([candidate["stream"] for candidate in record["public_candidates"]], ["stdout", "stderr"])
        self.assertNotIn("PRIVATE", json.dumps(facts))

    def test_stage_predicates_still_use_original_untrimmed_stdout(self):
        raw = ("Number of signers: 1\nVerified using v2 scheme (APK Signature Scheme v2): true\n"
               "  Signer #1 certificate SHA-256 digest: " + diagnose.stage.CERT + " \n").encode()
        fields = diagnose.public_signature_fields(raw)
        self.assertEqual(fields["stage_predicates"], {"cert": False, "count": True, "scheme": True})
        self.assertEqual(fields["certificate_lines"], ["Signer #1 certificate SHA-256 digest: " + diagnose.stage.CERT])
        self.assertEqual(diagnose.public_candidates(raw, "stdout")[0]["leading_ascii_whitespace"], 2)

    def test_workflow_and_calls_are_read_only(self):
        root = Path(__file__).parent
        workflow = (root.parent / ".github" / "workflows" / "diagnose-verified-apk-signatures.yml").read_text(encoding="utf-8")
        self.assertIn("  workflow_dispatch:\n", workflow)
        self.assertIn("  contents: read\n  actions: read", workflow)
        self.assertNotIn("write", workflow)
        self.assertNotIn("inputs:", workflow)
        self.assertIn("          java-version: 21", workflow)
        source = (root / "diagnose_verified_apk_signatures.py").read_text(encoding="utf-8")
        tree = ast.parse(source)
        stage_calls = {node.func.attr for node in ast.walk(tree) if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                       and isinstance(node.func.value, ast.Name) and node.func.value.id == "stage"}
        self.assertEqual(stage_calls, {"need", "check_tag", "api", "check_run", "check_artifact", "check_notes", "command", "unpack", "check_apk", "positive_id", "sha", "regular"})
        self.assertNotIn("create_draft", stage_calls)
        self.assertNotIn("main", stage_calls)
        for forbidden in ("--draft", "--clobber", "--target", "publish-update", "release\", \"create", "--method\", \"POST", "--method\", \"PUT", "--method\", \"PATCH", "--method\", \"DELETE"):
            self.assertNotIn(forbidden, source)


if __name__ == "__main__":
    unittest.main()
