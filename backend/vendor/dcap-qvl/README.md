# dcap-qvl (vendored)

A copy of [dcap-qvl](https://github.com/Phala-Network/dcap-qvl) 0.6.5 (MIT, see `LICENSE`). Axum uses it to verify the Intel DCAP chain of MagicBlock's TEE quotes (`backend/src/connectors/card_issuer/tee.rs`).

## Why it is vendored

Upstream's `std` feature turns on `serde_json/preserve_order`. Cargo merges features across a build, so depending on the published crate switched every `serde_json::Map` in the backend from sorted keys to insertion order. That changed JSON key order in existing routes and in canonical digests.

## Changes from upstream

The verification code (`verify.rs`, `quote.rs`, `tcb_info.rs`, `qe_identity.rs`, `intel.rs`, `x509.rs`, `policy/`) is unchanged. What did change:

- **`Cargo.toml`:**
  - `serde_json` no longer has `preserve_order`. It has `raw_value` instead.
  - The python, go, js, borsh and ring features are gone, along with their dependencies.
  - A new `collateral` feature replaces `report`.
- **`collateral.rs`:**
  - `tcbInfo` and `enclaveIdentity` are read as borrowed `RawValue`s, so the signed bytes go to the verifier exactly as Intel served them. Upstream re-serialized a `Value`, which only round-trips with `preserve_order`.
  - The reqwest constructors (`with_default_http`, `from_env`) are removed.
- **`http.rs`:** the reqwest adapter is removed. Axum supplies its own `HttpClient`, built on reqwest 0.12.
- **`lib.rs`:** the python and go bindings are removed. `collateral` and `http` are gated on `collateral`.
- **`constants.rs`:** the network test that downloads Intel's root CA is removed. Upstream's other unit tests run with the backend workspace.

Cargo treats this path dependency as a member of the root workspace, so `cargo test --workspace` runs upstream's in-crate unit tests against this copy. The crate is rustfmt-formatted.

## Updating

To upgrade, copy the new upstream `src/`, then reapply the changes listed above.
