from __future__ import annotations

import contextlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

SANDBOX_DIR = Path(__file__).resolve().parents[1]
if str(SANDBOX_DIR) not in sys.path:
    sys.path.insert(0, str(SANDBOX_DIR))

from differential_test import compare_result_files, main, write_report  # noqa: E402
from path_guard import (  # noqa: E402
    SandboxPathError,
    require_sandbox_root,
    resolve_in_sandbox,
)


def result(
    fixture_id: str,
    *,
    status: int = 200,
    amount_literal: str = "1.00",
    content_type: str = "application/json",
) -> str:
    return (
        '{"fixtureId":'
        + json.dumps(fixture_id)
        + f',"status":{status},"headers":{{"Content-Type":{json.dumps(content_type)}}},'
        + f'"body":{{"amount":{amount_literal},"labels":["a","b"]}}}}'
    )


class PathGuardTests(unittest.TestCase):
    def test_sandbox_root_is_required(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(SandboxPathError, "SANDBOX_ROOT"):
                require_sandbox_root()

    def test_sandbox_root_must_be_absolute(self) -> None:
        with self.assertRaisesRegex(SandboxPathError, "absolute"):
            require_sandbox_root("relative/root")

    def test_sandbox_root_must_exist(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            missing = Path(temporary_directory) / "missing"
            with self.assertRaisesRegex(SandboxPathError, "existing directory"):
                require_sandbox_root(missing)

    def test_relative_path_inside_root_is_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = require_sandbox_root(temporary_directory)
            fixture = root / "fixtures" / "source.json"
            fixture.parent.mkdir()
            fixture.write_text("[]", encoding="utf-8")

            self.assertEqual(
                resolve_in_sandbox(fixture.relative_to(root), root, must_exist=True),
                fixture.resolve(),
            )

    def test_absolute_path_inside_root_is_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = require_sandbox_root(temporary_directory)
            fixture = root / "fixture.json"
            fixture.write_text("[]", encoding="utf-8")

            self.assertEqual(
                resolve_in_sandbox(fixture, root, must_exist=True), fixture.resolve()
            )

    def test_parent_traversal_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory) / "sandbox"
            root.mkdir()

            with self.assertRaisesRegex(SandboxPathError, "escapes"):
                resolve_in_sandbox("../outside.json", root)

    def test_prefix_sibling_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            base = Path(temporary_directory)
            root = base / "sandbox"
            sibling = base / "sandbox-evil" / "fixture.json"
            root.mkdir()
            sibling.parent.mkdir()
            sibling.write_text("[]", encoding="utf-8")

            with self.assertRaisesRegex(SandboxPathError, "escapes"):
                resolve_in_sandbox(sibling, root, must_exist=True)

    def test_symlink_escape_is_rejected_when_symlinks_are_available(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            base = Path(temporary_directory)
            root = base / "sandbox"
            outside = base / "outside"
            root.mkdir()
            outside.mkdir()
            (outside / "fixture.json").write_text("[]", encoding="utf-8")
            link = root / "link"
            try:
                link.symlink_to(outside, target_is_directory=True)
            except OSError as error:
                self.skipTest(f"symlinks unavailable: {error}")

            with self.assertRaisesRegex(SandboxPathError, "escapes"):
                resolve_in_sandbox(link / "fixture.json", root, must_exist=True)

    def test_missing_input_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = require_sandbox_root(temporary_directory)
            with self.assertRaisesRegex(SandboxPathError, "does not exist"):
                resolve_in_sandbox("missing.json", root, must_exist=True)

    def test_root_itself_is_not_a_valid_file_path(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = require_sandbox_root(temporary_directory)
            with self.assertRaisesRegex(SandboxPathError, "root itself"):
                resolve_in_sandbox(root, root)


class DifferentialComparatorTests(unittest.TestCase):
    def write_results(self, root: Path, name: str, records: list[str]) -> Path:
        path = root / name
        path.write_text("[" + ",".join(records) + "]", encoding="utf-8")
        return path

    def test_equal_results_match_despite_object_key_and_header_name_order(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            source = self.write_results(root, "source.json", [result("b"), result("a")])
            target = root / "target.json"
            target.write_text(
                '[{"body":{"labels":["a","b"],"amount":1.00},'
                '"headers":{"content-type":"application/json"},"status":200,"fixtureId":"a"},'
                + result("b")
                + "]",
                encoding="utf-8",
            )

            report = compare_result_files(source, target, root=root)

            self.assertTrue(report["matched"])
            self.assertEqual(report["summary"], {"matched": 2, "mismatched": 0, "total": 2})
            self.assertEqual(report["mismatches"], [])

    def test_decimal_scale_is_exact_by_default(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            source = self.write_results(root, "source.json", [result("rounding", amount_literal="1.00")])
            target = self.write_results(root, "target.json", [result("rounding", amount_literal="1.0")])

            report = compare_result_files(source, target, root=root)

            self.assertFalse(report["matched"])
            self.assertEqual(report["mismatches"][0]["kind"], "body")
            self.assertEqual(report["mismatches"][0]["path"], "$.amount")

    def test_status_mismatch_is_reported(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            source = self.write_results(root, "source.json", [result("status")])
            target = self.write_results(root, "target.json", [result("status", status=422)])

            report = compare_result_files(source, target, root=root)

            self.assertEqual(report["mismatches"][0]["kind"], "status")
            self.assertEqual(report["mismatches"][0]["source"], 200)
            self.assertEqual(report["mismatches"][0]["target"], 422)

    def test_selected_header_mismatch_is_case_insensitive_by_name(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            source = self.write_results(root, "source.json", [result("header")])
            target = self.write_results(
                root,
                "target.json",
                [result("header", content_type="application/problem+json")],
            )

            report = compare_result_files(source, target, root=root)

            self.assertEqual(report["mismatches"][0]["kind"], "header")
            self.assertEqual(report["mismatches"][0]["header"], "content-type")

    def test_missing_fixture_is_a_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            source = self.write_results(root, "source.json", [result("present")])
            target = self.write_results(root, "target.json", [])

            report = compare_result_files(source, target, root=root)

            self.assertEqual(report["mismatches"][0], {
                "fixtureId": "present",
                "kind": "missing_target",
            })

    def test_duplicate_fixture_id_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            source = self.write_results(root, "source.json", [result("duplicate"), result("duplicate")])
            target = self.write_results(root, "target.json", [result("duplicate")])

            with self.assertRaisesRegex(ValueError, "duplicate fixtureId"):
                compare_result_files(source, target, root=root)

    def test_invalid_record_shape_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            source = root / "source.json"
            target = self.write_results(root, "target.json", [result("fixture")])
            source.write_text('[{"fixtureId":"fixture","status":"200","headers":{},"body":{}}]', encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "status must be an integer"):
                compare_result_files(source, target, root=root)

    def test_input_path_escape_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            base = Path(temporary_directory)
            root = base / "sandbox"
            root.mkdir()
            outside = self.write_results(base, "outside.json", [result("fixture")])
            target = self.write_results(root, "target.json", [result("fixture")])

            with self.assertRaises(SandboxPathError):
                compare_result_files(outside, target, root=root)

    def test_report_serialization_is_deterministic_and_confined(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            report = {
                "matched": True,
                "summary": {"matched": 0, "mismatched": 0, "total": 0},
                "mismatches": [],
            }
            output = root / "reports" / "parity.json"

            write_report(report, output, root=root)

            self.assertEqual(
                output.read_text(encoding="utf-8"),
                '{\n  "matched": true,\n  "mismatches": [],\n  "summary": {\n    "matched": 0,\n    "mismatched": 0,\n    "total": 0\n  }\n}\n',
            )
            with self.assertRaises(SandboxPathError):
                write_report(report, root.parent / "outside.json", root=root)

    def test_cli_returns_one_for_parity_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            source = self.write_results(root, "source.json", [result("fixture")])
            target = self.write_results(root, "target.json", [result("fixture", status=500)])
            output = io.StringIO()

            with contextlib.redirect_stdout(output):
                exit_code = main([
                    "--source", str(source),
                    "--target", str(target),
                    "--sandbox-root", str(root),
                ])

            self.assertEqual(exit_code, 1)
            self.assertFalse(json.loads(output.getvalue())["matched"])

    def test_cli_returns_two_for_configuration_error_without_traceback(self) -> None:
        stderr = io.StringIO()
        with mock.patch.dict(os.environ, {}, clear=True), contextlib.redirect_stderr(stderr):
            exit_code = main(["--source", "source.json", "--target", "target.json"])

        self.assertEqual(exit_code, 2)
        self.assertIn("SANDBOX_ROOT", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
