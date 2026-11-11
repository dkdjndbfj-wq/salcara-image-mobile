"""Pure synthetic diagnostic checks; no network, workflow or APK execution."""

import ast
import json
from pathlib import Path
import unittest
from unittest.mock import patch

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
        with patch.object(diagnose, "probe", side_effect=[(0, b"0.9"), (1, b"PRIVATE-OLD-ERROR"), (0, b"Number of signers: 1\n")]) as probe, patch.object(diagnose.stage, "sha", return_value="a" * 64):
            facts, code = diagnose.collect_signatures(Path("36.0.0"), old, current)
        self.assertEqual(probe.call_count, 3)
        self.assertEqual(code, 1)
        self.assertEqual([record["exit_code"] for record in facts["packages"]], [1, 0])
        self.assertEqual(set(facts), {"status", "sdk_version", "apksigner_version", "packages"})
        for record in facts["packages"]:
            self.assertEqual(set(record), {"name", "sha256", "exit_code", "certificate_lines", "certificates", "sdk_range_certificates", "signer_count", "schemes", "stage_predicates"})
        self.assertNotIn("PRIVATE-OLD-ERROR", json.dumps(facts))
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
        with patch.object(diagnose, "probe", side_effect=[(0, b"bad version private"), (0, b""), (0, b"")]), patch.object(diagnose.stage, "sha", return_value="a" * 64):
            facts, code = diagnose.collect_signatures(Path("36.0.0"), Path("old.apk"), Path("new.apk"))
        self.assertEqual(code, 0)
        self.assertIsNone(facts["apksigner_version"])
        self.assertTrue(all(record["signer_count"] is None for record in facts["packages"]))
        self.assertIn("not-release-acceptance", facts["status"])

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
