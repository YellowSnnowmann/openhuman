# embeddings

Embedding providers for the OpenHuman memory system. Converts text into numerical vectors for semantic search, abstracting over multiple backends behind a single `EmbeddingProvider` trait. Owns provider construction (factory + slug catalog), per-endpoint client-side rate limiting, 429/503 retry-with-backoff logic, and the JSON-RPC surface that the Settings UI uses to pick a provider, store API keys, test connectivity, and embed text. The default provider is the OpenHuman backend ("managed" / "cloud", Voyage-backed); other paths include direct Voyage, OpenAI, Cohere, local Ollama, any OpenAI-compatible `custom:<url>` endpoint, and a no-op (keyword-only) fallback.

## Responsibilities

- Define `EmbeddingProvider` (async trait) and the canonical embedding-space signature format (`provider=…;model=…;dims=…`) — the single source of truth so config-derived and live-provider signatures stay byte-identical (#1574).
- Implement each provider: cloud/managed, Voyage, OpenAI(-compatible), Cohere, Ollama, noop.
- Construct providers from a slug + model + dims (with or without credentials) via the factory.
- Maintain the static provider/model catalog (slugs, labels, API-key/endpoint requirements, dimension presets) consumed by the frontend picker.
- Throttle outbound cloud-embedding HTTP requests with a process-global, per-endpoint token bucket (loopback exempt).
- Parse `Retry-After` and apply 429/503 exponential backoff in HTTP-based providers.
- Auto-fall back from the managed cloud embedder to a local one when the backend session expires mid-run (#3312): latch confirmed 401/403 auth failures and, when a local embedder is preloaded at matching dimensions, persist a provider switch (no destructive wipe) so indexing survives without a restart.
- Expose RPC handlers for settings, API-key management, embed, and connection testing; trigger memory wipe / re-embed backfill when the embedding signature changes.

## Key files

| File | Role |
| --- | --- |
| `src/openhuman/embeddings/mod.rs` | Module docstring + module decls + `pub use` re-exports; re-exports `VectorStore` et al. from `memory_store::vectors`; exposes `all_embeddings_controller_schemas` / `all_embeddings_registered_controllers`. |
| `src/openhuman/embeddings/provider_trait.rs` | `EmbeddingProvider` trait (`name`/`model_id`/`dimensions`/`signature`/`embed`/`embed_one`) and `format_embedding_signature`. |
| `src/openhuman/embeddings/factory.rs` | `create_embedding_provider`, `create_embedding_provider_with_credentials`, `default_embedding_provider` (cloud), `default_local_embedding_provider` (Ollama). Maps provider slugs to concrete impls; unknown slugs error. |
| `src/openhuman/embeddings/catalog.rs` | Static catalog of `EmbeddingProviderEntry` + `EmbeddingModelPreset`; slug constants; `all_providers` / `find_provider` / `find_model` / `default_model_for`. |
| `src/openhuman/embeddings/cloud.rs` | `OpenHumanCloudEmbedding` — default provider; resolves session JWT + API URL per call, delegates HTTP to `OpenAiEmbedding` against `<api>/openai/v1`. `DEFAULT_CLOUD_EMBEDDING_MODEL` = `embedding-v1`, dims 1024. |
| `src/openhuman/embeddings/openai.rs` | `OpenAiEmbedding` — OpenAI-compatible `POST /v1/embeddings`; URL inference, 429/503 retry, rate-limit gating, dimension/count validation. Used directly by cloud, voyage, and custom paths. |
| `src/openhuman/embeddings/cloud_fallback.rs` | Process-global auth-failure latch + `maybe_switch_cloud_to_local` — on a confirmed cloud 401/403 with a reachable, dimension-matched local embedder, persists a managed-cloud → local switch (signature-safe, no wipe) so a session expiry can't permanently brick indexing (#3312). Consumed by the memory-queue worker each tick. |
| `src/openhuman/embeddings/voyage.rs` | `VoyageEmbedding` — thin wrapper delegating to `OpenAiEmbedding` against `api.voyageai.com`. |
| `src/openhuman/embeddings/cohere.rs` | `CohereEmbedding` — Cohere-native `POST /v2/embed` wire format (`texts`, `embedding_types`, nested `embeddings.float`) with its own 429/503 retry loop. |
| `src/openhuman/embeddings/ollama.rs` | `OllamaEmbedding` — local Ollama `POST /api/embed`; base-url/model normalization, blank-input zero-vector preservation, NaN-encoding 500 per-text recovery (TAURI-RUST-AZ). Defaults `bge-m3`/1024. |
| `src/openhuman/embeddings/noop.rs` | `NoopEmbedding` — returns empty vectors; keyword-only fallback (`name`/`model_id` = "none", dims 0). |
| `src/openhuman/embeddings/rate_limit.rs` | Process-global, per-endpoint token-bucket request limiter; `set_embedding_rate_limit`, `embedding_rate_limit`, `acquire_embedding_slot`. Default 60/min; loopback exempt; `0` disables. |
| `src/openhuman/embeddings/retry_after.rs` | `parse_retry_after_ms`, `backoff_ms_for_attempt`, and the `MAX_429_RETRIES` / backoff constants. |
| `src/openhuman/embeddings/rpc.rs` | RPC business logic: `get_settings`, `update_settings`, `set_api_key`, `clear_api_key`, `embed`, `test_connection`, plus `provider_from_config` and `resolve_api_key`. |
| `src/openhuman/embeddings/schemas.rs` | Controller schemas + `handle_*` param-deserializing wrappers delegating to `rpc.rs`. |
| `src/openhuman/embeddings/mod_tests.rs` | Module-level tests (via `#[path]`). |
| `src/openhuman/embeddings/openai_tests.rs` / `ollama_tests.rs` | Sibling test suites for the OpenAI and Ollama providers (via `#[path]`). |

## Public surface

From `mod.rs` re-exports:

- Trait + helper: `EmbeddingProvider`, `format_embedding_signature`.
- Providers: `OpenHumanCloudEmbedding`, `OpenAiEmbedding`, `OllamaEmbedding`, `NoopEmbedding` (Voyage/Cohere are public via their submodules through the factory).
- Factory fns: `create_embedding_provider`, `default_embedding_provider`, `default_local_embedding_provider`.
- Config-driven builder: `provider_from_config` (re-exported from `rpc`) — same construction `embed` uses, for callers like `codegraph` that need a provider without a JSON-RPC round-trip.
- Defaults/consts: `DEFAULT_CLOUD_EMBEDDING_MODEL`, `DEFAULT_CLOUD_EMBEDDING_DIMENSIONS`, `DEFAULT_OLLAMA_MODEL`, `DEFAULT_OLLAMA_DIMENSIONS`.
- Vector-store re-exports (moved to `memory_store::vectors`, re-exported here for callers): `store`, `bytes_to_vec`, `cosine_similarity`, `vec_to_bytes`, `SearchResult`, `VectorStore`.
- RPC registry: `all_embeddings_controller_schemas`, `all_embeddings_registered_controllers`.

## RPC / controllers

Namespace `embeddings` (6 controllers, registered through `src/core/all.rs`):

| Method | Description |
| --- | --- |
| `embeddings.get_settings` | Current provider/model/dims/rate-limit + full provider catalog with `has_api_key` flags and `vector_search_enabled`. |
| `embeddings.update_settings` | Update provider/model/dimensions/custom_endpoint/rate_limit. Requires `confirm_wipe=true` when **dimensions** change (returns `EMBEDDINGS_DIMENSION_CHANGE_REQUIRES_WIPE` otherwise); wipes memory on dim change and queues a re-embed backfill on any signature change. Also syncs `config.embeddings_provider` workload routing. |
| `embeddings.set_api_key` | Store an API key under credential provider `embeddings:<slug>`. |
| `embeddings.clear_api_key` | Remove the stored key for `embeddings:<slug>`. |
| `embeddings.embed` | Embed input texts using the configured provider; returns vectors, dimensions, count. |
| `embeddings.test_connection` | Run a single test embed against the configured or specified provider/model/dims. |

All handlers return `RpcOutcome<serde_json::Value>` via `into_cli_compatible_json`.

## Agent tools

None. This module owns no `tools.rs`; agent-facing memory tools live in `memory/tools/` and consume embeddings indirectly through the memory store.

## Events

None. No `bus.rs` / `EventHandler` impls. Cross-module side effects in `update_settings` are direct calls (`memory::read_rpc::wipe_all_rpc`, `memory_queue::ensure_reembed_backfill`), not domain events.

## Persistence

No `store.rs`. Settings live in the global `Config` (`config.memory.embedding_provider` / `embedding_model` / `embedding_dimensions` / `embedding_rate_limit_per_min`, plus `config.embeddings_provider`). API keys are persisted via the credentials domain (`AuthService`) under provider key `embeddings:<slug>`. Vectors themselves are stored by `memory_store::vectors` (re-exported here, not owned).

## Dependencies

- `crate::openhuman::config` — `Config`, `config::ops::load_config_with_timeout`, `build_runtime_proxy_client` (proxy-aware reqwest), config save.
- `crate::openhuman::credentials` — `AuthService`, `APP_SESSION_PROVIDER` for resolving the session JWT (cloud) and storing/loading provider API keys.
- `crate::openhuman::memory_store::vectors` — vector store types re-exported from `mod.rs`.
- `crate::openhuman::memory::read_rpc` — `wipe_all_rpc` on a dimension change.
- `crate::openhuman::memory_queue` — `ensure_reembed_backfill` on a signature change.
- `crate::openhuman::inference::local` — `ollama_base_url()` when constructing the Ollama provider.
- `crate::api::config` — `effective_api_url` for the cloud backend base URL.
- `crate::core::all` — `ControllerFuture`, `RegisteredController` for the RPC registry.
- `crate::core::{ControllerSchema, FieldSchema, TypeSchema}` — schema definitions.
- `crate::core::observability` — `report_error_or_expected` so transient upstream HTTP failures demote to warning breadcrumbs instead of Sentry errors.
- `crate::rpc::RpcOutcome` — handler return contract.

## Used by

- `memory_store/*` — factories, vectors store, chunks store, unified store, retrieval, client (primary consumer; constructs providers and uses signatures to partition the embedding space).
- `memory/*` — ingestion queue, preferences, tools (recall/store/forget), `read_rpc`.
- `memory_tree/score/embed/cloud.rs` — scoring path.
- `codegraph/*` — index/search/tools obtain a provider via `provider_from_config` for `signature()` + direct embedding.
- `voice/factory.rs`, `screen_intelligence`, `channels`, `agent` tools — indirect consumers.
- `config/schema/load.rs` — wires `memory.embedding_rate_limit_per_min` into `rate_limit::set_embedding_rate_limit`.
- `core/all.rs` — registers the RPC controllers; `core/observability.rs` — classifies the canonical embedding error strings.

## Notes / gotchas

- **Signature drift is the core hazard.** `format_embedding_signature` is the single source of truth; both config-derived and live-provider signatures route through it. A mismatch silently splits one embedding space into two (#1574). `update_settings` keys memory wipe off **dimension** change (vectors stay comparable across provider/model swaps at the same dimensionality) but queues a re-embed backfill on **any** signature change.
- **Rate limiting is account-wide and process-global**, keyed by resolved base URL, with capacity = 1 token (no burst) to stay strictly under a hard per-minute cap. Ephemeral provider instances share one budget per endpoint. Loopback hosts are exempt; `limit==0` disables. The acquire chokepoint sits **inside** the retry loop so retried attempts consume tokens.
- **Cloud provider resolves auth lazily per call** — it can be constructed before login; the first `embed()` errors clearly if unauthenticated. It honors `OPENHUMAN_WORKSPACE` for the auth-profiles directory so non-default workspaces (tests/multi-instance) don't silently lose their session.
- **Ollama NaN recovery (TAURI-RUST-AZ):** a single bad input can poison a whole batch with a 500 `unsupported value: NaN`; the provider re-issues per-text and substitutes empty embeddings for the offending entries. Blank/whitespace inputs are preserved as zero-vectors so result length always matches input length. `local-*` model IDs are rejected (they're virtual routing aliases).
- **Custom endpoints** are encoded in the provider slug as `custom:<url>`; `resolve_api_key` and the RPC handlers normalize this back to the `custom` credential slug.
- **Voyage and cloud reuse `OpenAiEmbedding`** for HTTP plumbing (Voyage's API is an OpenAI superset). **Cohere** speaks a distinct wire format and has its own retry loop.
- Error strings from OpenAI/Cohere providers intentionally preserve the `(429 ` / status substring so `core::observability`'s `TransientUpstreamHttp` classifier downgrades them.
