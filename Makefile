.PHONY: check fmt cargo-check test build start-backend sdk-typecheck mcp-typecheck app-typecheck frontend-typecheck frontend-build app-dev frontend-dev contract-check contract-build contract-idl contract-smoke card-policy-build card-policy-test

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

# Anchor's key sync rewrites declare_id!/Anchor.toml during the build; the
# script restores both on exit so a run leaves `git status` clean.
contract-build:
	ANCHOR=$(ANCHOR) scripts/anchor-build-clean.sh

contract-idl:
	$(ANCHOR) idl build -p chainpay --no-docs

contract-smoke:
	ANCHOR=$(ANCHOR) scripts/anchor-build-clean.sh --smoke

# programs/card_policy is its own Cargo + Anchor workspace (MagicBlock PER).
card-policy-build:
	cd programs/card_policy && cargo build-sbf

card-policy-test:
	cd programs/card_policy && cargo build-sbf --features litesvm-mock --sbf-out-dir target/mock && cargo test --locked
