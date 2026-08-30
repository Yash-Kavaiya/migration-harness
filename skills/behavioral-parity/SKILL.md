---
name: behavioral-parity
description: Use when designing the fixture matrix for a service migration or when comparing a ported service's responses to golden responses — the coverage matrix and the response-normalization rules.
---

# Behavioral parity: fixtures and comparison

Two jobs: (1) build a request matrix that exercises every observable behavior,
(2) compare responses so that only *meaningful* differences count.

## Fixture matrix

Build a deterministic cross-product. Vary, per endpoint:

- **Enums**: every value of every enum in the request (tier, country, category…).
- **Numeric inputs**: `0`, the smallest unit (`0.01`), a normal value, a large
  value, and — critically — values engineered to land on a **half-cent** after the
  service's discount or tax multiplication (e.g. an amount whose 50%-off is
  `x.xx5`). These are where rounding-mode bugs surface.
- **Optional modifiers** (coupons, flags): absent, valid, expired, unknown,
  just-below-threshold, exactly-at-threshold.
- **Collections**: empty (expect rejection if required), one item, many items,
  duplicate items, items that sum to a boundary.
- **Error inputs**: one per validation rule — wrong enum, missing required field,
  wrong type, negative where non-negative required, unknown reference.
- **Adversarial**: unicode in string fields, very large quantities, extra unknown
  JSON fields, leading/trailing whitespace, wrong-case enum values.

Each fixture: `{ id, endpoint: {method, route}, request: {query?, headers?, body?}, category }`
with `category ∈ {happy, boundary, adversarial, error, regression}`. Aim for 200+.
Any behavior with no fixture is unverified.

## Golden capture

Run the **original** service, send each fixture's request, and record:

- `status` — the HTTP status code
- `headers` — only the allow-list (see below)
- `body` — the parsed JSON (or raw text if not JSON)

Commit these as the goldens. The ported service is never compared to a live
original — only to the committed goldens.

## Normalization (apply to BOTH sides before comparing)

| Aspect | Rule |
|---|---|
| JSON object key order | irrelevant — compare as maps |
| JSON array order | **significant** — arrays are ordered data |
| Money fields | compare as decimals at the contract's `decimalScale`. `"170.0"` == `"170.00"`; `"170.00"` != `"169.99"` |
| Floating whitespace in strings | significant — do not trim |
| Headers | compare only `content-type`. Ignore `Date`, `Server`, `Connection`, trace/correlation ids, `Content-Length` |
| Status | exact integer match |
| Absent key vs `null` | significant unless the contract says `nullSemantics: "lenient"` |

## Reporting a mismatch

For every failing fixture record: `fixtureId`, `endpoint` (`{method, route}` copied
from the fixture — the api-compatibility gate needs it to attribute the failure to
a route), the request as `input`, both full (un-normalized) responses, a
**field-level diff** (`path`, `expected`, `actual`), and a specific root-cause
`hypothesis`. Good hypotheses name the mechanism:

- "monetary rounding: source uses half-to-even, port uses half-up — diverges on
  exact half-cent results"
- "port maps `decimal` to `f64`; `0.1 + 0.2` style accumulation error"
- "null vs absent: source omits `appliedCoupon`, port emits `null`"

Group mismatches by hypothesis so a repair can fix a whole class at once. A parity
run passes only at **100%** — `passed == total`.
