---
name: rust-axum
description: Use when generating an idiomatic Axum + Tokio HTTP service — project layout, router and extractors, error-to-status mapping, serde models with exact JSON field names, and tracing.
---

# Idiomatic Axum service skeleton

Target: a small, single-crate HTTP service that reproduces an existing API's wire
behavior exactly.

## Cargo.toml

```toml
[package]
name = "..."
version = "0.1.0"
edition = "2021"

[dependencies]
axum = "0.7"
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
rust_decimal = { version = "1", features = ["serde-with-str"] }
rust_decimal_macros = "1"
tower = "0.5"
tower-http = { version = "0.6", features = ["trace"] }
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }

[dev-dependencies]
tower = { version = "0.5", features = ["util"] }
http-body-util = "0.1"
```

## Layout

```
src/
  main.rs        # runtime setup, bind, serve
  router.rs      # route table -> handler fns
  models.rs      # request/response structs (serde)
  domain.rs      # pure computation — no axum types in here
  error.rs       # AppError enum + IntoResponse
```

Keep `domain.rs` free of framework types so it can be unit-tested directly and
diffed against the source logic.

## Router

```rust
pub fn app() -> Router {
    Router::new()
        .route("/health", get(handlers::health))
        .route("/quote", post(handlers::quote))
        .layer(tower_http::trace::TraceLayer::new_for_http())
}
```

## Extractors & handlers

- Body: `Json(req): Json<QuoteRequest>`. A malformed body yields a
  `JsonRejection` — handle it so the response matches the source's error shape,
  not Axum's default.
- Return `Result<Json<QuoteResponse>, AppError>` and let `?` propagate.
- Do not use `unwrap()` / `expect()` on anything request-derived.

## Error → status mapping

```rust
pub enum AppError {
    Validation { code: &'static str, message: String }, // -> 400
    // add only what the contract needs
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code, message) = match self {
            AppError::Validation { code, message } => (StatusCode::BAD_REQUEST, code, message),
        };
        (status, Json(json!({ "error": message, "code": code }))).into_response()
    }
}
```

The error body shape must match the source exactly — same keys, same casing.

## serde models

- `#[derive(Debug, Clone, Serialize, Deserialize)]`
- `#[serde(rename_all = "camelCase")]` on every DTO if the source uses camelCase
- money fields: `Decimal` with `features = ["serde-with-str"]` so they serialize
  as `"12.50"`, or keep them as pre-formatted `String` if the source emits a
  specific fixed scale — whichever reproduces the bytes
- optional-but-always-present fields stay `Option<T>` **without** `skip_serializing_if`

## main.rs

```rust
#[tokio::main]
async fn main() {
    tracing_subscriber::fmt().with_env_filter(EnvFilter::from_default_env()).init();
    let listener = tokio::net::TcpListener::bind("0.0.0.0:8080").await.unwrap();
    axum::serve(listener, app()).await.unwrap();
}
```

## Tests

Use `tower::ServiceExt::oneshot` against `app()` for endpoint tests — no network,
no port. Mirror the .NET test cases one-for-one.

## Clippy

Build must pass `cargo clippy -- -D warnings`. Do not silence a lint with `#[allow]`
unless you note why in the generation report.
