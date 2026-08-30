#!/usr/bin/env python3
"""Run the same deterministic HTTP workload against two already-running services."""

from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import statistics
import sys
import time
from typing import Any, Iterable, Sequence
from urllib import error, parse, request

from path_guard import SandboxPathError, require_sandbox_root, resolve_in_sandbox


class _NoRedirectHandler(request.HTTPRedirectHandler):
    """Treat redirects as responses instead of following them to another host."""

    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:
        return None


_HTTP_OPENER = request.build_opener(request.ProxyHandler({}), _NoRedirectHandler())
_DEFAULT_ALLOWED_HOSTS = {"127.0.0.1", "::1", "localhost"}
_ALLOWED_METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE"}
_MAX_RESPONSE_BYTES = 1_048_576
_REQUIRED_FIXTURE_FIELDS = {"fixtureId", "method", "path"}
_OPTIONAL_FIXTURE_FIELDS = {"headers", "body"}


def _positive_integer(value: str, *, minimum: int, maximum: int, name: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise ValueError(f"{name} must be an integer") from error
    if parsed < minimum or parsed > maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return parsed


def _positive_float(value: str, *, minimum: float, maximum: float, name: str) -> float:
    try:
        parsed = float(value)
    except ValueError as error:
        raise ValueError(f"{name} must be numeric") from error
    if not math.isfinite(parsed) or parsed < minimum or parsed > maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return parsed


def _allowed_hosts() -> set[str]:
    configured = os.environ.get("BENCHMARK_ALLOWED_HOSTS", "")
    additions = {host.strip().lower() for host in configured.split(",") if host.strip()}
    return _DEFAULT_ALLOWED_HOSTS | additions


def _validate_base_url(value: str, label: str, allowed_hosts: set[str]) -> str:
    parsed = parse.urlsplit(value)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError(f"{label} URL scheme must be http or https")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError(f"{label} URL must not contain credentials")
    if parsed.hostname is None or parsed.hostname.lower() not in allowed_hosts:
        raise ValueError(
            f"{label} URL host is not allowlisted; configure BENCHMARK_ALLOWED_HOSTS explicitly"
        )
    if parsed.query or parsed.fragment:
        raise ValueError(f"{label} URL must not contain a query or fragment")
    try:
        parsed.port
    except ValueError as error:
        raise ValueError(f"{label} URL contains an invalid port") from error
    return value.rstrip("/")


def _load_fixtures(path: Path) -> list[dict[str, Any]]:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(f"benchmark fixtures must be valid UTF-8 JSON: {path.name}") from error
    if not isinstance(document, list) or not document:
        raise ValueError("benchmark fixtures must be a non-empty JSON array")

    fixtures: list[dict[str, Any]] = []
    fixture_ids: set[str] = set()
    allowed_fields = _REQUIRED_FIXTURE_FIELDS | _OPTIONAL_FIXTURE_FIELDS
    for index, fixture in enumerate(document):
        if not isinstance(fixture, dict):
            raise ValueError(f"fixture at index {index} must be an object")
        fields = set(fixture)
        if not _REQUIRED_FIXTURE_FIELDS.issubset(fields) or not fields.issubset(allowed_fields):
            raise ValueError(f"fixture at index {index} has invalid fields")
        fixture_id = fixture["fixtureId"]
        if not isinstance(fixture_id, str) or not fixture_id.strip():
            raise ValueError(f"fixture at index {index}: fixtureId must be a non-empty string")
        if fixture_id in fixture_ids:
            raise ValueError(f"duplicate fixtureId: {fixture_id!r}")
        fixture_ids.add(fixture_id)

        method = fixture["method"]
        if not isinstance(method, str) or method.upper() not in _ALLOWED_METHODS:
            raise ValueError(f"fixture {fixture_id!r}: unsupported HTTP method")
        path_value = fixture["path"]
        if (
            not isinstance(path_value, str)
            or not path_value.startswith("/")
            or path_value.startswith("//")
            or parse.urlsplit(path_value).scheme
            or parse.urlsplit(path_value).netloc
            or parse.urlsplit(path_value).fragment
        ):
            raise ValueError(f"fixture {fixture_id!r}: path must be an absolute URL path")
        headers = fixture.get("headers", {})
        if not isinstance(headers, dict) or any(
            not isinstance(name, str)
            or not name.strip()
            or not isinstance(header_value, str)
            for name, header_value in headers.items()
        ):
            raise ValueError(f"fixture {fixture_id!r}: headers must map strings to strings")
        denied_headers = {name.lower() for name in headers} & {"host", "content-length"}
        if denied_headers:
            raise ValueError(f"fixture {fixture_id!r}: reserved headers are not allowed")

        fixtures.append(
            {
                "fixtureId": fixture_id,
                "method": method.upper(),
                "path": path_value,
                "headers": dict(sorted(headers.items(), key=lambda item: item[0].lower())),
                "body": fixture.get("body"),
            }
        )
    return fixtures


def _request_once(base_url: str, fixture: dict[str, Any], timeout_seconds: float) -> tuple[float, int]:
    body = fixture["body"]
    payload = None
    headers = dict(fixture["headers"])
    if body is not None:
        payload = json.dumps(
            body, ensure_ascii=False, separators=(",", ":"), sort_keys=True
        ).encode("utf-8")
        headers.setdefault("Content-Type", "application/json")

    http_request = request.Request(
        base_url + fixture["path"],
        data=payload,
        headers=headers,
        method=fixture["method"],
    )
    started = time.perf_counter_ns()
    try:
        response = request.urlopen(http_request, timeout=timeout_seconds)
    except error.HTTPError as http_error:
        response = http_error
    try:
        status = response.status
        response_body = response.read(_MAX_RESPONSE_BYTES + 1)
    finally:
        response.close()
    elapsed_ms = (time.perf_counter_ns() - started) / 1_000_000
    if len(response_body) > _MAX_RESPONSE_BYTES:
        raise ValueError("benchmark response exceeded the 1 MiB safety limit")
    return elapsed_ms, status


def _nearest_rank(values: list[float], percentile: float) -> float:
    ordered = sorted(values)
    rank = max(1, math.ceil(percentile * len(ordered)))
    return ordered[rank - 1]


def _summarize(samples: list[float], statuses: Iterable[int]) -> dict[str, Any]:
    status_counts: dict[str, int] = {}
    for status in statuses:
        key = str(status)
        status_counts[key] = status_counts.get(key, 0) + 1
    return {
        "requests": len(samples),
        "latencyMs": {
            "min": round(min(samples), 3),
            "mean": round(statistics.fmean(samples), 3),
            "p50": round(_nearest_rank(samples, 0.50), 3),
            "p95": round(_nearest_rank(samples, 0.95), 3),
            "max": round(max(samples), 3),
        },
        "statusCounts": dict(sorted(status_counts.items())),
    }


def run_benchmark(
    source_url: str,
    target_url: str,
    fixtures: list[dict[str, Any]],
    *,
    warmups: int,
    iterations: int,
    timeout_seconds: float,
) -> dict[str, Any]:
    """Run a fixed, sequential, alternating workload; never starts either service."""
    samples = {"source": [], "target": []}
    statuses = {"source": [], "target": []}
    implementations = (("source", source_url), ("target", target_url))

    for _ in range(warmups):
        for fixture in fixtures:
            for _, base_url in implementations:
                _request_once(base_url, fixture, timeout_seconds)

    for _ in range(iterations):
        for fixture in fixtures:
            for label, base_url in implementations:
                elapsed_ms, status = _request_once(base_url, fixture, timeout_seconds)
                samples[label].append(elapsed_ms)
                statuses[label].append(status)

    return {
        "methodology": {
            "fixtureCount": len(fixtures),
            "iterations": iterations,
            "order": "fixture-major, source-then-target, sequential",
            "warmups": warmups,
        },
        "source": _summarize(samples["source"], statuses["source"]),
        "target": _summarize(samples["target"], statuses["target"]),
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Benchmark two already-running, explicitly allowlisted HTTP services."
    )
    parser.add_argument("--sandbox-root", help="Defaults to SANDBOX_ROOT")
    parser.add_argument("--fixtures", required=True, help="Fixture JSON inside SANDBOX_ROOT")
    parser.add_argument("--source-url", help="Defaults to SOURCE_BASE_URL")
    parser.add_argument("--target-url", help="Defaults to TARGET_BASE_URL")
    parser.add_argument("--warmups", default=os.environ.get("BENCHMARK_WARMUPS", "1"))
    parser.add_argument("--iterations", default=os.environ.get("BENCHMARK_ITERATIONS", "10"))
    parser.add_argument("--timeout", default=os.environ.get("BENCHMARK_TIMEOUT_SECONDS", "5"))
    parser.add_argument("--report", help="Optional output path inside SANDBOX_ROOT")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        sandbox_root = require_sandbox_root(args.sandbox_root)
        fixture_path = resolve_in_sandbox(
            args.fixtures, sandbox_root, must_exist=True, expected_kind="file"
        )
        source_url = args.source_url or os.environ.get("SOURCE_BASE_URL")
        target_url = args.target_url or os.environ.get("TARGET_BASE_URL")
        if not source_url or not target_url:
            raise ValueError("both source and target base URLs are required")
        allowed_hosts = _allowed_hosts()
        validated_source_url = _validate_base_url(source_url, "source", allowed_hosts)
        validated_target_url = _validate_base_url(target_url, "target", allowed_hosts)
        warmups = _positive_integer(args.warmups, minimum=0, maximum=1000, name="warmups")
        iterations = _positive_integer(args.iterations, minimum=1, maximum=10000, name="iterations")
        timeout_seconds = _positive_float(args.timeout, minimum=0.1, maximum=60, name="timeout")
        report = run_benchmark(
            validated_source_url,
            validated_target_url,
            _load_fixtures(fixture_path),
            warmups=warmups,
            iterations=iterations,
            timeout_seconds=timeout_seconds,
        )
        rendered = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        if args.report:
            report_path = resolve_in_sandbox(args.report, sandbox_root, expected_kind="file")
            report_path.parent.mkdir(parents=True, exist_ok=True)
            report_path.write_text(rendered, encoding="utf-8")
        print(rendered, end="")
        return 0
    except (OSError, SandboxPathError, ValueError, error.URLError) as benchmark_error:
        print(f"benchmark: error: {benchmark_error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
