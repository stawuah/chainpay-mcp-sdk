.PHONY: check fmt cargo-check test build start-backend sdk-typecheck mcp-typecheck app-typecheck frontend-typecheck frontend-build app-dev frontend-dev contract-check contract-build contract-idl contract-smoke splitter-test splitter-release-check

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

# Builds the splitter with throwaway test keys, then runs the adversarial suite.
# The test .so goes to target/splitter-test, never target/deploy, so it can't be
# mistaken for a release build. scripts/check-release.mjs refuses it anyway.
SPLITTER_TEST_OUT := target/splitter-test
splitter-test:
	cargo build-sbf --manifest-path programs/support-splitter/Cargo.toml --features test-config --sbf-out-dir $(SPLITTER_TEST_OUT)
	cargo test -p support-splitter --features splitter-tests

# Run before any splitter deploy: refuses a .so built with the test keys or
# for the wrong cluster. Usage: make splitter-release-check SO=path/to.so [DEVNET=1]
splitter-release-check:
	node programs/support-splitter/scripts/check-release.mjs $(SO) $(if $(DEVNET),--devnet)
