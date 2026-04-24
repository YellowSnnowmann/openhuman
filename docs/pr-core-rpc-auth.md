# Core RPC auth

## Why

The local `/rpc` endpoint was protected with a bearer token, but some callers were still reaching it without that token.

This showed up as:

- remote socket auth succeeding
- local `/rpc` requests failing with unauthorized

The main gaps were:

- the Tauri app needed a consistent way to get and send the local RPC token
- background Rust helpers were posting to `/rpc` without auth
- the frontend could silently fall back to unauthenticated local RPC calls

## What changed

### 1. Protect local core RPC

- added bearer auth middleware for protected core HTTP routes
- initialized a per-process local RPC token at core startup
- kept public routes like `/`, `/health`, and `/auth/telegram` open

### 2. Pass the local RPC token through Tauri

- generated and stored a per-process token in the Tauri core handle
- passed that token to the spawned core process
- used the same token for Tauri-side version checks and local RPC access

### 3. Authenticate Tauri background callers

- added a shared helper for authenticated local core RPC requests
- updated iMessage, Slack, Telegram, and WhatsApp scanner calls to send the bearer token

### 4. Fail closed in the frontend

- allowed the `core_rpc_token` Tauri command
- updated the frontend core RPC client to fetch and cache the token
- stopped Tauri mode from sending anonymous `/rpc` requests if the token is unavailable

## What this helps

- local `/rpc` is now consistently protected
- background services use the same auth path as the UI
- frontend failures are clearer instead of turning into silent unauthorized spam
- the local state token stays separate from remote user session auth

## Checks run

- `cargo check --manifest-path app/src-tauri/Cargo.toml --features cef`
- `cargo test --manifest-path app/src-tauri/Cargo.toml --features cef`
- `yarn --cwd app test`

All passed in the updated auth flow.
