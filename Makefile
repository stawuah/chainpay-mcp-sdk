.PHONY: check fmt cargo-check test build start-backend sdk-typecheck mcp-typecheck app-typecheck frontend-typecheck frontend-build app-dev frontend-dev contract-check contract-build contract-idl contract-smoke

ANCHOR ?= anchor

check: fmt cargo-check sdk-typecheck mcp-typecheck app-typecheck frontend-typecheck

fmt:
	cargo fmt --all -- --check

cargo-check:
	cargo check --workspace

test:
	cargo test --workspace

build:
	cargo build --workspace

start-backend:
	cargo run -p chainpay-backend

sdk-typecheck:
	npm run check:sdk

mcp-typecheck:
	npm run check:mcp

app-typecheck:
	npm run check:app

frontend-typecheck:
	npm run check:frontend

frontend-build:
	npm run build:frontend

app-dev:
	npm run dev:app

frontend-dev:
	npm run dev:frontend

contract-check:
	cargo check -p chainpay

contract-build:
	$(ANCHOR) build --ignore-keys --no-docs

contract-idl:
	$(ANCHOR) idl build -p chainpay --no-docs

contract-smoke: contract-build
	cargo test -p chainpay --features settlement-tests --test settlement -- --nocapture
