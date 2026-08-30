#!/usr/bin/env python3
"""Fail-closed path validation shared by sandbox utilities."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys
from typing import Sequence


class SandboxPathError(ValueError):
    """Raised when a configured path is not safely confined to the sandbox."""


def require_sandbox_root(value: str | os.PathLike[str] | None = None) -> Path:
    """Return a canonical, existing, absolute sandbox root or fail closed."""
    raw_value = value if value is not None else os.environ.get("SANDBOX_ROOT")
    if raw_value is None or not str(raw_value).strip():
        raise SandboxPathError("SANDBOX_ROOT is required")

    root = Path(raw_value)
    if not root.is_absolute():
        raise SandboxPathError("SANDBOX_ROOT must be an absolute path")

    try:
        resolved_root = root.resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise SandboxPathError(
            "SANDBOX_ROOT must name an existing directory"
        ) from error
    if not resolved_root.is_dir():
        raise SandboxPathError("SANDBOX_ROOT must name an existing directory")
    return resolved_root


def resolve_in_sandbox(
    candidate: str | os.PathLike[str],
    root: str | os.PathLike[str] | Path,
    *,
    must_exist: bool = False,
    expected_kind: str | None = None,
    allow_root: bool = False,
) -> Path:
    """Resolve a path and reject traversal, prefix, and symlink escapes."""
    resolved_root = require_sandbox_root(root)
    raw_candidate = Path(candidate)
    joined_candidate = (
        raw_candidate if raw_candidate.is_absolute() else resolved_root / raw_candidate
    )

    try:
        resolved_candidate = joined_candidate.resolve(strict=must_exist)
    except FileNotFoundError as error:
        raise SandboxPathError(f"sandbox path does not exist: {candidate}") from error
    except (OSError, RuntimeError) as error:
        raise SandboxPathError(f"sandbox path cannot be resolved: {candidate}") from error

    if resolved_candidate == resolved_root:
        if not allow_root:
            raise SandboxPathError("sandbox root itself is not a valid file path")
    elif not resolved_candidate.is_relative_to(resolved_root):
        raise SandboxPathError(f"path escapes SANDBOX_ROOT: {candidate}")

    if expected_kind not in {None, "file", "directory"}:
        raise ValueError("expected_kind must be 'file', 'directory', or None")
    if resolved_candidate.exists() and expected_kind == "file" and not resolved_candidate.is_file():
        raise SandboxPathError(f"sandbox path is not a file: {candidate}")
    if resolved_candidate.exists() and expected_kind == "directory" and not resolved_candidate.is_dir():
        raise SandboxPathError(f"sandbox path is not a directory: {candidate}")

    return resolved_candidate


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Resolve one path only if it remains inside SANDBOX_ROOT."
    )
    parser.add_argument("--root", help="Sandbox root (defaults to SANDBOX_ROOT)")
    parser.add_argument("--path", required=True, help="Path to validate")
    parser.add_argument("--must-exist", action="store_true")
    parser.add_argument("--kind", choices=("file", "directory"))
    parser.add_argument("--allow-root", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        root = require_sandbox_root(args.root)
        resolved = resolve_in_sandbox(
            args.path,
            root,
            must_exist=args.must_exist,
            expected_kind=args.kind,
            allow_root=args.allow_root,
        )
    except SandboxPathError as error:
        print(f"path_guard: error: {error}", file=sys.stderr)
        return 2

    print(resolved)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
