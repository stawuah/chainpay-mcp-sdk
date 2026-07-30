# ChainPay backend

The backend is the reliability and orchestration boundary for ChainPay. It
provides APIs for the app and MCP server, submits Devnet transactions, tracks
confirmation, and stores non-sensitive off-chain metadata.

The backend must never override on-chain mandate policy, hold wallet keys, or
store seed phrases or raw private keys.

## Local checks

~~~bash
cargo test -p chainpay-backend
cargo run -p chainpay-backend
~~~

The binary is currently a process-level scaffold for the workspace. HTTP
relay endpoints and persistence are still to be implemented.
