---
name: dotnet-to-rust
description: Use when translating C#/.NET code to Rust — type and idiom mapping rules, with the semantic traps (decimal/rounding, nullability, string comparison, collection order) called out explicitly.
---

# C# → Rust mapping rules

Translate for **observable-behavior equivalence**, not line-for-line. Tag every
non-trivial decision with a confidence level:

- `EXACT` — the mapping preserves behavior with certainty
- `SEMANTIC` — behavior is preserved but the mechanism differs (document it)
- `REQUIRES_REVIEW` — you are not certain; flag it in the generation report
- `UNSUPPORTED` — no faithful mapping; escalate

## Money — the one that matters

| C# | Rust | Notes |
|---|---|---|
| `decimal` | `rust_decimal::Decimal` | **Never `f64`.** `f64` cannot represent `0.10` and accumulates error across arithmetic. |
| `Math.Round(x, n, MidpointRounding.ToEven)` | `x.round_dp_with_strategy(n, RoundingStrategy::MidpointNearestEven)` | Banker's rounding. This is the default for `round_dp`, but be explicit. |
| `Math.Round(x, n, MidpointRounding.AwayFromZero)` | `RoundingStrategy::MidpointAwayFromZero` | |
| `decimal` literal `1.5m` | `dec!(1.5)` (from `rust_decimal_macros`) | Not `Decimal::from_f64(1.5)` — that reintroduces float error. |
| serialized as `"12.50"` | format with fixed scale: `format!("{:.2}", d)` on a `Decimal`, or `d.round_dp(2).to_string()` after normalizing scale | Match the source's string form exactly. |

Reproduce the **order of operations** from the source — round after each
multiplication if the source does, not once at the end.

## Types

| C# | Rust |
|---|---|
| `string` | `String` / `&str` |
| `string?` | `Option<String>` |
| `int` / `long` | `i32` / `i64` (watch for overflow semantics: C# unchecked wraps, Rust debug panics — use `wrapping_*` only if the source relies on it) |
| `bool` | `bool` |
| `T[]` / `List<T>` | `Vec<T>` |
| `Dictionary<K,V>` | `HashMap<K,V>` (or `IndexMap` if iteration order is observable) |
| `IEnumerable<T>` | `impl Iterator<Item = T>` |
| `enum` | `enum` with `#[derive(Serialize, Deserialize)]` and `#[serde(rename_all = "...")]` to match the wire form |
| `record` | `struct` with `#[derive(Clone, PartialEq)]` |
| `Nullable<T>` / `T?` (value types) | `Option<T>` |
| `DateTime` / `DateTimeOffset` | `chrono::NaiveDateTime` / `DateTime<Utc>` — preserve the exact serialized format and offset handling |
| `Guid` | `uuid::Uuid` |

## Control flow & errors

| C# | Rust |
|---|---|
| `throw new XException(...)` | `return Err(AppError::X(...))` — exceptions become `Result` |
| `try/catch` | `match` / `?` on `Result` |
| `Task<T>` / `async`/`await` | `async fn -> T`, `.await`, Tokio runtime |
| `T?.Member` (null-conditional) | `opt.map(|v| v.member)` / `opt.and_then(...)` |
| `x ?? y` | `opt.unwrap_or(y)` / `opt.unwrap_or_else(\|\| y)` |
| LINQ `Where/Select/OrderBy` | iterator `filter/map`, `sorted_by` — **preserve sort stability and key**; C# `OrderBy` is stable |
| `string.Equals(a, b, StringComparison.OrdinalIgnoreCase)` | `a.eq_ignore_ascii_case(b)` (ASCII) or `a.to_lowercase() == b.to_lowercase()` — match the comparison the source used, ordinal vs culture |

## Serialization

- `System.Text.Json` camelCase policy → `#[serde(rename_all = "camelCase")]`
- a property that is always emitted (even when null) → do **not** add
  `#[serde(skip_serializing_if = "Option::is_none")]`
- `[JsonPropertyName("x")]` → `#[serde(rename = "x")]`
- `JsonNumberHandling.Strict` → default serde behavior (don't accept strings for numbers)

## What to flag in the generation report

Every `SEMANTIC` and `REQUIRES_REVIEW` decision, and specifically: every place a
`decimal` was mapped, every rounding call, every nullable field, and every place
collection ordering could be observable.
