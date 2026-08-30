#!/usr/bin/env python3
"""Deterministically compare captured .NET and Rust HTTP result sets."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import sys
from typing import Any, Iterable, Mapping, Sequence

from path_guard import SandboxPathError, require_sandbox_root, resolve_in_sandbox


_INTEGER_PATTERN = re.compile(r"-?(?:0|[1-9][0-9]*)\Z")
_SIMPLE_PROPERTY_PATTERN = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")
_REQUIRED_RESULT_FIELDS = {"fixtureId", "status", "headers", "body"}
_DEFAULT_HEADERS = ("content-type",)


@dataclass(frozen=True)
class JsonNumber:
    """A JSON number whose original lexical representation is preserved."""

    literal: str


def _reject_non_json_number(value: str) -> None:
    raise ValueError(f"non-standard JSON number is not allowed: {value}")


def _load_json(path: Path) -> Any:
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(
                handle,
                parse_float=JsonNumber,
                parse_int=JsonNumber,
                parse_constant=_reject_non_json_number,
            )
    except UnicodeDecodeError as error:
        raise ValueError(f"result file is not valid UTF-8: {path.name}") from error
    except json.JSONDecodeError as error:
        raise ValueError(
            f"result file is not valid JSON at line {error.lineno}, column {error.colno}: {path.name}"
        ) from error


def _normalize_headers(value: Any, fixture_id: str) -> dict[str, str]:
    if not isinstance(value, dict):
        raise ValueError(f"fixture {fixture_id!r}: headers must be an object")

    normalized: dict[str, str] = {}
    for name, header_value in value.items():
        if not isinstance(name, str) or not name.strip():
            raise ValueError(f"fixture {fixture_id!r}: header names must be non-empty strings")
        if not isinstance(header_value, str):
            raise ValueError(f"fixture {fixture_id!r}: header values must be strings")
        normalized_name = name.strip().lower()
        if normalized_name in normalized:
            raise ValueError(
                f"fixture {fixture_id!r}: duplicate header after case normalization: {normalized_name}"
            )
        normalized[normalized_name] = header_value.strip()
    return normalized


def _normalize_status(value: Any, fixture_id: str) -> int:
    if not isinstance(value, JsonNumber) or not _INTEGER_PATTERN.fullmatch(value.literal):
        raise ValueError(f"fixture {fixture_id!r}: status must be an integer")
    status = int(value.literal)
    if status < 100 or status > 599:
        raise ValueError(f"fixture {fixture_id!r}: status must be between 100 and 599")
    return status


def _index_results(document: Any, label: str) -> dict[str, dict[str, Any]]:
    if not isinstance(document, list):
        raise ValueError(f"{label} result document must be a JSON array")

    indexed: dict[str, dict[str, Any]] = {}
    for index, record in enumerate(document):
        if not isinstance(record, dict):
            raise ValueError(f"{label} result at index {index} must be an object")
        fields = set(record)
        if fields != _REQUIRED_RESULT_FIELDS:
            missing = sorted(_REQUIRED_RESULT_FIELDS - fields)
            extra = sorted(fields - _REQUIRED_RESULT_FIELDS)
            raise ValueError(
                f"{label} result at index {index} has invalid fields; missing={missing}, extra={extra}"
            )
        fixture_id = record["fixtureId"]
        if not isinstance(fixture_id, str) or not fixture_id.strip():
            raise ValueError(f"{label} result at index {index}: fixtureId must be a non-empty string")
        if fixture_id in indexed:
            raise ValueError(f"{label}: duplicate fixtureId {fixture_id!r}")

        indexed[fixture_id] = {
            "status": _normalize_status(record["status"], fixture_id),
            "headers": _normalize_headers(record["headers"], fixture_id),
            "body": record["body"],
        }
    return indexed


def _json_path(parent: str, property_name: str) -> str:
    if _SIMPLE_PROPERTY_PATTERN.fullmatch(property_name):
        return f"{parent}.{property_name}"
    return f"{parent}[{json.dumps(property_name, ensure_ascii=False)}]"


def _report_value(value: Any) -> Any:
    if isinstance(value, JsonNumber):
        return {"jsonNumber": value.literal}
    if isinstance(value, list):
        return [_report_value(item) for item in value]
    if isinstance(value, dict):
        return {key: _report_value(value[key]) for key in sorted(value)}
    return value


def _first_body_difference(source: Any, target: Any, path: str = "$") -> dict[str, Any] | None:
    if isinstance(source, JsonNumber) or isinstance(target, JsonNumber):
        if isinstance(source, JsonNumber) and isinstance(target, JsonNumber) and source.literal == target.literal:
            return None
        return {
            "kind": "body",
            "path": path,
            "source": _report_value(source),
            "target": _report_value(target),
        }

    if type(source) is not type(target):
        return {
            "kind": "body",
            "path": path,
            "source": _report_value(source),
            "target": _report_value(target),
        }

    if isinstance(source, dict):
        source_keys = set(source)
        target_keys = set(target)
        for key in sorted(source_keys | target_keys):
            child_path = _json_path(path, key)
            if key not in source:
                return {"kind": "body", "path": child_path, "source": {"missing": True}, "target": _report_value(target[key])}
            if key not in target:
                return {"kind": "body", "path": child_path, "source": _report_value(source[key]), "target": {"missing": True}}
            difference = _first_body_difference(source[key], target[key], child_path)
            if difference is not None:
                return difference
        return None

    if isinstance(source, list):
        shared_length = min(len(source), len(target))
        for index in range(shared_length):
            difference = _first_body_difference(source[index], target[index], f"{path}[{index}]")
            if difference is not None:
                return difference
        if len(source) != len(target):
            return {
                "kind": "body",
                "path": f"{path}[length]",
                "source": len(source),
                "target": len(target),
            }
        return None

    if source != target:
        return {"kind": "body", "path": path, "source": source, "target": target}
    return None


def _normalize_header_selection(headers: Iterable[str]) -> tuple[str, ...]:
    normalized = {header.strip().lower() for header in headers if header.strip()}
    if not normalized:
        raise ValueError("at least one response header must be selected")
    return tuple(sorted(normalized))


def compare_result_files(
    source_path: str | os.PathLike[str],
    target_path: str | os.PathLike[str],
    *,
    root: str | os.PathLike[str],
    headers: Iterable[str] = _DEFAULT_HEADERS,
) -> dict[str, Any]:
    """Compare two captured result arrays and return a deterministic report."""
    sandbox_root = require_sandbox_root(root)
    source_file = resolve_in_sandbox(
        source_path, sandbox_root, must_exist=True, expected_kind="file"
    )
    target_file = resolve_in_sandbox(
        target_path, sandbox_root, must_exist=True, expected_kind="file"
    )
    selected_headers = _normalize_header_selection(headers)

    source_results = _index_results(_load_json(source_file), "source")
    target_results = _index_results(_load_json(target_file), "target")
    fixture_ids = sorted(set(source_results) | set(target_results))
    mismatches: list[dict[str, Any]] = []
    mismatched_fixture_ids: set[str] = set()

    for fixture_id in fixture_ids:
        if fixture_id not in source_results:
            mismatches.append({"fixtureId": fixture_id, "kind": "missing_source"})
            mismatched_fixture_ids.add(fixture_id)
            continue
        if fixture_id not in target_results:
            mismatches.append({"fixtureId": fixture_id, "kind": "missing_target"})
            mismatched_fixture_ids.add(fixture_id)
            continue

        source = source_results[fixture_id]
        target = target_results[fixture_id]
        if source["status"] != target["status"]:
            mismatches.append(
                {
                    "fixtureId": fixture_id,
                    "kind": "status",
                    "source": source["status"],
                    "target": target["status"],
                }
            )
            mismatched_fixture_ids.add(fixture_id)

        for header in selected_headers:
            source_header = source["headers"].get(header)
            target_header = target["headers"].get(header)
            if source_header != target_header:
                mismatches.append(
                    {
                        "fixtureId": fixture_id,
                        "kind": "header",
                        "header": header,
                        "source": source_header,
                        "target": target_header,
                    }
                )
                mismatched_fixture_ids.add(fixture_id)

        body_difference = _first_body_difference(source["body"], target["body"])
        if body_difference is not None:
            mismatches.append({"fixtureId": fixture_id, **body_difference})
            mismatched_fixture_ids.add(fixture_id)

    mismatched_count = len(mismatched_fixture_ids)
    matched_count = len(fixture_ids) - mismatched_count
    return {
        "matched": mismatched_count == 0,
        "mismatches": mismatches,
        "summary": {
            "matched": matched_count,
            "mismatched": mismatched_count,
            "total": len(fixture_ids),
        },
    }


def write_report(
    report: Mapping[str, Any],
    output_path: str | os.PathLike[str],
    *,
    root: str | os.PathLike[str],
) -> Path:
    sandbox_root = require_sandbox_root(root)
    output = resolve_in_sandbox(
        output_path, sandbox_root, must_exist=False, expected_kind="file"
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return output


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Compare captured .NET and Rust HTTP results without executing either service."
    )
    parser.add_argument("--source", required=True, help="Source (.NET) result JSON")
    parser.add_argument("--target", required=True, help="Target (Rust) result JSON")
    parser.add_argument("--sandbox-root", help="Defaults to SANDBOX_ROOT")
    parser.add_argument(
        "--header",
        action="append",
        dest="headers",
        help="Header to compare; repeat as needed (default: content-type)",
    )
    parser.add_argument("--report", help="Optional report path inside SANDBOX_ROOT")
    return parser


def _configured_headers(command_line_headers: list[str] | None) -> tuple[str, ...]:
    if command_line_headers is not None:
        return tuple(command_line_headers)
    environment_headers = os.environ.get("PARITY_HEADERS")
    if environment_headers is None:
        return _DEFAULT_HEADERS
    return tuple(environment_headers.split(","))


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        sandbox_root = require_sandbox_root(args.sandbox_root)
        report = compare_result_files(
            args.source,
            args.target,
            root=sandbox_root,
            headers=_configured_headers(args.headers),
        )
        if args.report:
            write_report(report, args.report, root=sandbox_root)
        print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
        return 0 if report["matched"] else 1
    except (OSError, SandboxPathError, ValueError) as error:
        print(f"differential_test: error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
