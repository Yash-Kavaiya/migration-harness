# Sandbox and parity utilities

These small utilities are intentionally fail-closed. They support the MigrationHarness demo without treating generated code as trusted host code.

## Safety contract

- Every filesystem entry point requires an **absolute, existing `SANDBOX_ROOT`**.
- Input, project, and report paths are canonicalized and must remain below that root. Parent traversal, sibling-prefix tricks, and symlink escapes are rejected.
- `run_dotnet.sh` and `run_rust.sh` deny execution unless an isolated runtime explicitly sets both `SANDBOX_EXECUTION_MODE=isolated` and `MIGRATIONHARNESS_ISOLATED_SANDBOX=1`.
- The execution marker is an acknowledgement, not a sandbox implementation. A host process must not set it merely to bypass the guard. Provision an OS/container/TrueForge sandbox first.
- Build actions and timeouts are allowlisted. There is no `eval`, shell-command pass-through, or arbitrary command option.
- `differential_test.py` only reads captured result files. It never starts or invokes either implementation.
- `benchmark.py` only calls already-running HTTP services. It never starts generated code. Hosts are loopback-only by default; additional hosts require the explicit `BENCHMARK_ALLOWED_HOSTS` allowlist.
- These checks are defense in depth. They do not replace process, network, resource, and filesystem isolation supplied by the sandbox runtime.

All configuration errors exit with code `2`. A parity mismatch exits with code `1`. Successful comparisons/executions exit with code `0`.

## Path guard

`path_guard.py` is shared by every utility that accesses the filesystem:

```bash
export SANDBOX_ROOT=/absolute/path/to/isolated/workspace
python path_guard.py --path fixtures/source.json --must-exist --kind file
```

The command prints the canonical path only after confinement succeeds.

## Differential comparator

The comparator accepts two UTF-8 JSON arrays. Each result has this exact envelope:

```json
{
  "fixtureId": "gold-in-summer10",
  "status": 200,
  "headers": { "content-type": "application/json" },
  "body": { "total": 253.65 }
}
```

Fixture order and JSON object property order are ignored. Fixture IDs must be unique. Status is exact. Header names are case-insensitive, while selected header values are exact after outer whitespace is removed. JSON values and array order are exact. Number **lexemes** are exact by design, so `1.0` and `1.00` differ; this preserves the migration contract's monetary scale semantics.

```bash
export SANDBOX_ROOT=/absolute/path/to/repo/sandbox
python differential_test.py \
  --source examples/source-results.json \
  --target examples/target-results.json \
  --report reports/parity.json
```

The default selected header is `content-type`. Repeat `--header` to choose others, or set a comma-separated `PARITY_HEADERS` value when no `--header` is supplied.

Reports are deterministic: fixtures, object keys, header selections, and mismatches have stable ordering. No timestamps or generated IDs are added.

## Guarded .NET and Rust runners

Run these only *inside* an already-provisioned isolated sandbox:

```bash
export SANDBOX_ROOT=/absolute/path/to/isolated/workspace
export SANDBOX_EXECUTION_MODE=isolated
export MIGRATIONHARNESS_ISOLATED_SANDBOX=1
export SANDBOX_TIMEOUT_SECONDS=300

./run_dotnet.sh projects/OrderPricingService all
./run_rust.sh projects/order-pricing-rust all
```

The .NET action allowlist is `restore`, `build`, `test`, and `all`. `build` and `test` use `--no-restore`; `all` performs restore first. The Rust allowlist is `fmt`, `check`, `build`, `test`, `clippy`, and `all`; Cargo operations use `--locked`. Tool caches and build output are redirected below `SANDBOX_ROOT/.migrationharness`.

`PYTHON_BIN` may select the Python executable used by the shell runners. The default is `python3`.

### Default-deny check

This command must fail before checking for an SDK because host execution has not been licensed:

```bash
SANDBOX_ROOT="$PWD" ./run_dotnet.sh . test
# run_dotnet.sh: error: SANDBOX_EXECUTION_MODE=isolated is required; host execution is denied by default
```

## Benchmark

The benchmark runs a fixed, sequential workload in fixture-major, source-then-target order. It reports measured latency and status counts only—there are no placeholder or invented numbers. Results are demo-environment observations, not general .NET-versus-Rust claims.

It accepts fixtures such as `examples/benchmark-fixtures.json`:

```json
[
  { "fixtureId": "health", "method": "GET", "path": "/health" },
  {
    "fixtureId": "quote",
    "method": "POST",
    "path": "/quote",
    "body": {
      "customerTier": "gold",
      "subtotal": 249.95,
      "coupon": "SUMMER10",
      "country": "IN"
    }
  }
]
```

Start both services in isolated environments, then run:

```bash
export SANDBOX_ROOT=/absolute/path/to/repo/sandbox
python benchmark.py \
  --fixtures examples/benchmark-fixtures.json \
  --source-url http://127.0.0.1:5080 \
  --target-url http://127.0.0.1:5081 \
  --warmups 2 \
  --iterations 50 \
  --report reports/benchmark.json
```

Equivalent environment variables are `SOURCE_BASE_URL`, `TARGET_BASE_URL`, `BENCHMARK_WARMUPS`, `BENCHMARK_ITERATIONS`, and `BENCHMARK_TIMEOUT_SECONDS`. Non-loopback hosts require `BENCHMARK_ALLOWED_HOSTS=host1,host2`. URLs containing credentials are rejected. Response bodies are capped at 1 MiB.

## Tests

Only the Python standard library is required:

```bash
python -m unittest discover -s tests -v
```

From the repository root:

```bash
python -m unittest discover -s sandbox/tests -v
```

The suite covers required roots, traversal, sibling prefixes, symlink escapes (where supported), missing inputs, exact numeric scale, object-order normalization, status/header/body mismatches, duplicate fixture IDs, deterministic reports, path confinement, and CLI exit codes.
