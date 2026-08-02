# ChainPay Scope

## One-Line Definition

ChainPay is an agentic, policy-controlled stablecoin payment protocol on Solana.

It is not an AI agent. It is the payment rail that AI agents, applications,
and MCP servers can use to initiate stablecoin payments safely, with spending
rules enforced on-chain and settlement performed directly in supported Solana
stablecoins such as USDC and PYUSD.

## Core Goal

The goal is to let a user authorize controlled stablecoin payments once, then
allow an approved agent or application to execute only the payments that fit
those rules.

ChainPay should answer one question:

> How can AI agents make stablecoin payments on Solana without receiving unrestricted wallet access?

## Scope Reminder

This project must be built according to this scope.md and the decisions
already made in the ChainPay discussion:

- ChainPay is a protocol and payment rail, not a standalone agent.
- The MVP runs on Solana Devnet first.
- The first stablecoin flow should support Devnet demonstration tokens, with
  USDC and PYUSD treated as target production assets.
- The user remains the owner of funds.
- The agent can only spend through user-approved on-chain policy.
- Every successful payment must produce a verifiable receipt.
- x402 challenge normalization is part of the first connector bundle; hosted
  facilitators and custody remain out of scope.
- Stripe, PayPal, Visa, OpenUSD, and other connectors are extensions, not core
  settlement dependencies.

## Product Positioning

ChainPay is programmable payment permissioning for stablecoins.

It sits between:

- a user wallet;
- an AI agent or MCP server;
- a merchant, service, or recipient;
- Solana stablecoin settlement.

The user does not sign every payment manually. Instead, the user creates a
limited payment mandate. The mandate defines who can initiate payments, which
token can be spent, where funds can go, how much can be spent, when the
permission expires, and how duplicate payments are prevented.

## Separation of Concerns

ChainPay should be designed as separate layers that connect into one payment
flow.

### 1. Wallet and User Authorization Layer

Responsibility:

- connect the user's Solana wallet;
- let the user create, pause, update, or revoke a mandate;
- get the user's explicit signature for mandate creation;
- approve a limited delegate authority where required;
- display the real payment policy before signing.

This layer must never give an agent the user's private key.

### 2. On-Chain Policy Layer

Responsibility:

- store the payment mandate;
- enforce the mandate rules;
- reject payments outside policy;
- prevent replayed invoice or payment IDs;
- track spent amount and payment counters;
- create durable payment receipts.

This is the core ChainPay protocol.

### 3. Payment Execution Layer

Responsibility:

- receive a payment request from an agent, app, or MCP tool;
- validate the request against the on-chain mandate;
- transfer supported stablecoins through SPL Token or Token-2022;
- emit a receipt and settlement event;
- return payment status to the caller.

This layer connects intent to actual settlement.

### 4. Agent and MCP Interface Layer

Responsibility:

- expose safe payment tools to AI agents;
- prepare payment requests;
- check mandate limits before submission;
- submit payment transactions;
- fetch receipts and payment status.

MCP is the interface. ChainPay is the settlement and policy system underneath
it.

MCP tools:

~~~
get_mandate
get_protocol_config
get_asset
create_mandate
update_mandate
prepare_payment
quote_payment
verify_payment_request
prepare_x402_payment
execute_payment
get_payment
wait_for_payment
pause_mandate
revoke_mandate
~~~

### 5. Backend Orchestration Layer

Responsibility:

- provide APIs for the UI and MCP server;
- handle Devnet RPC submission;
- simulate transactions;
- refresh blockhashes;
- track confirmation status;
- store off-chain metadata that should not live on-chain;
- expose webhook or polling endpoints for payment status.

The backend improves reliability, but it must not be trusted to override
on-chain policy.

### 6. UI and Dashboard Layer

Responsibility:

- show the user their mandates;
- let the user create and revoke policies;
- show pending and completed payments;
- show receipts, transaction signatures, and settlement status;
- provide a Devnet demo flow from wallet connection to completed payment.

The UI should feel like a payment operations dashboard, not a landing page.

### 7. Connector Layer

Responsibility:

- connect ChainPay to external payment systems or payment protocols;
- translate external payment requests into ChainPay payment intents;
- verify external settlement requirements.

Connectors are extension work. They should not block the core ChainPay MVP.

Possible connectors:

- x402 for paid HTTP resources;
- Stripe for invoices, merchant records, or fiat-side reconciliation;
- PayPal for merchant payment metadata or settlement references;
- Visa for enterprise payment network integrations;
- OpenUSD for supported stablecoin routing if appropriate;
- merchant APIs for invoices and receipts.

## End-to-End Flow

The canonical ChainPay MVP flow should be:

~~~
User opens ChainPay UI
        |
        v
User connects wallet on Devnet
        |
        v
User creates payment mandate
        |
        v
ChainPay program stores mandate on-chain
        |
        v
User approves limited token delegate authority
        |
        v
Agent or MCP server prepares payment request
        |
        v
ChainPay validates mandate, amount, mint, recipient, expiry, and nonce
        |
        v
ChainPay executes stablecoin transfer
        |
        v
Receipt PDA is created
        |
        v
UI and MCP server return final settlement status
~~~

## On-Chain Design

The Solana program should use Program Derived Addresses for mandates and
receipts.

### Payment Mandate Account

Stores:

~~~
owner
approved_agent
source_token_account
allowed_mint
allowed_recipient
max_per_payment
total_limit
amount_spent
payment_count
expires_at_slot
paused
bump
~~~

For the MVP, keep the mandate narrow while making the policy deterministic:

- one user;
- one approved agent;
- one stablecoin mint;
- one source token account;
- one recipient or merchant;
- per-payment and total spend limits;
- optional payment-count cap;
- optional slot cooldown between payments;
- pause, revoke, and expiry controls.

The protocol authority maintains a scalable `SupportedAsset` registry. Each
registered mint is explicitly bound to either classic SPL Token or Token-2022;
unregistered and disabled mints cannot be used to create or execute mandates.

### Payment Receipt Account

Stores:

~~~
mandate
invoice_hash
payment_id
mint
source_token_account
recipient_token_account
amount
agent
executed_at_slot
signature_reference
status
bump
~~~

Receipt PDA seed:

~~~
["receipt", mandate, invoice_hash]
~~~

This prevents duplicate execution for the same invoice hash.

### Core Instructions

The MVP program should implement:

~~~
create_mandate
register_asset
set_asset_status
update_mandate
pause_mandate
revoke_mandate
execute_payment
~~~

Optional later instructions:

~~~
create_merchant
create_agent_identity
create_payment_intent
cancel_payment_intent
settle_escrow
execute_subscription_payment
execute_batch_payment
~~~

## Technical Architecture

Suggested repository structure:

~~~
programs/chainpay/
  src/lib.rs
  src/state.rs
  src/instructions/
    create_mandate.rs
    update_mandate.rs
    pause_mandate.rs
    revoke_mandate.rs
    execute_payment.rs

sdk/
  src/client.ts
  src/mandate.ts
  src/payment.ts
  src/receipt.ts
  src/types.ts

mcp-server/
  src/index.ts
  src/tools/
    get_mandate.ts
    prepare_payment.ts
    execute_payment.ts
    get_payment.ts

backend/
  src/api/
  src/rpc/
  src/status/
  src/storage/

app/
  src/pages/
  src/components/
  src/lib/
~~~

## UI Design Scope

The UI must support the full Devnet payment demo.

Required screens:

- wallet connection and Devnet status;
- dashboard overview;
- create mandate form;
- mandate detail page;
- payment request simulator;
- payment execution status;
- receipt detail page;
- revoke or pause mandate flow.

Required visible fields:

- connected wallet;
- stablecoin mint;
- source token account;
- approved agent;
- recipient or merchant;
- max per payment;
- total spend limit;
- amount already spent;
- expiry;
- mandate status;
- payment status;
- transaction signature;
- receipt address.

Important UI behavior:

- show a clear warning when the app is not on Devnet;
- show what the agent is allowed to do before the user signs;
- never imply that the agent owns the wallet;
- show failed policy checks clearly;
- make revocation easy to find;
- include a demo payment flow that can be completed end to end.

## Devnet Demo Requirement

Everything must run on Devnet first.

The demo should prove:

- a user can connect a wallet;
- a Devnet stablecoin-like token can be minted or funded;
- the user can create a mandate;
- the user can approve the ChainPay mandate authority as a limited delegate;
- an agent-like caller can request a payment;
- the on-chain program rejects invalid payments;
- the on-chain program executes valid payments;
- the recipient receives tokens;
- the UI shows the payment receipt and final status.

For the MVP, a custom Devnet stablecoin mint is acceptable. Production USDC and
PYUSD support should be treated as integration targets after the Devnet
protocol works.

## Product Achievables

By the end of the MVP, ChainPay should deliver:

- a working Solana Devnet program;
- a TypeScript SDK;
- a minimal MCP server exposing safe payment tools;
- a web UI for mandate and payment management;
- a backend or lightweight API layer for status tracking;
- tests for mandate enforcement and replay protection;
- an end-to-end Devnet demo;
- documentation explaining what ChainPay is and what it is not.

## Technical Achievables

The MVP must verify:

- only the mandate owner can create, update, pause, or revoke a mandate;
- only the approved agent can execute payment requests;
- payment amount cannot exceed max_per_payment;
- total spent cannot exceed total_limit;
- expired mandates cannot execute;
- paused or revoked mandates cannot execute;
- unsupported mints are rejected;
- unsupported recipients are rejected;
- duplicate invoice hashes are rejected;
- successful payments move tokens through the token program;
- successful payments create exactly one receipt;
- failed payments do not update spend counters.

## Checks and Balances

Required checks:

- wallet signature for mandate creation;
- explicit token delegate approval;
- agent signer verification;
- recipient allowlist check;
- mint allowlist check;
- per-payment limit check;
- total-limit check;
- expiry check;
- paused/revoked check;
- invoice hash uniqueness check;
- transaction simulation before submission;
- finality confirmation before marking payment final.

Operational checks:

- do not log private wallet material;
- do not store seed phrases;
- do not store raw private keys;
- do not allow backend-only authorization;
- keep off-chain invoice details separate from on-chain receipt hashes;
- make all Devnet and production configuration explicit.

## Risk Mitigations

### Risk: Agent gets too much spending power

Mitigation:

- use narrow mandates;
- require max per payment;
- require total spend limit;
- require expiry;
- support pause and revoke.

### Risk: Duplicate payment execution

Mitigation:

- derive receipt PDA from mandate and invoice hash;
- reject if receipt already exists;
- use idempotency keys in backend and MCP server.

### Risk: Backend bypasses policy

Mitigation:

- enforce all critical checks on-chain;
- treat backend checks as preflight only;
- test direct program calls, not only UI flows.

### Risk: Wrong token or wrong recipient

Mitigation:

- store allowed mint and recipient in the mandate;
- validate token accounts against mint and owner;
- show recipient and mint clearly before user signs.

### Risk: Delegate authority is unsafe

Mitigation:

- delegate only to the mandate PDA;
- limit practical exposure through mandate constraints;
- make revocation obvious in the UI;
- test revoke behavior before demo.

### Risk: Three-week scope expands too much

Mitigation:

- keep connectors out of the MVP;
- use one Devnet mint;
- use one agent;
- use one merchant or recipient;
- build direct stablecoin transfer before x402 or external payments.

## Three-Week Delivery Plan

### Week 1: Core Solana Payment Rail

Goal:

Prove that a user-approved on-chain mandate can control a stablecoin transfer on
Devnet.

Build:

- Anchor project setup;
- Devnet stablecoin mint setup;
- mandate account;
- receipt account;
- create mandate instruction;
- pause and revoke instructions;
- execute payment instruction;
- SPL token transfer through program-controlled delegate authority;
- first unit and integration tests.

Exit criteria:

- user can create a mandate;
- valid payment succeeds;
- invalid amount fails;
- invalid agent fails;
- duplicate invoice hash fails;
- revoke prevents future payments.

### Week 2: SDK, MCP, and Backend Status

Goal:

Make the protocol usable outside raw scripts.

Build:

- TypeScript SDK;
- payment request builder;
- receipt fetcher;
- MCP server with safe payment tools;
- lightweight backend API for status tracking;
- transaction simulation and confirmation tracking;
- better test coverage for policy failures.

Exit criteria:

- an MCP-style caller can prepare and execute a payment;
- SDK can fetch mandate and receipt state;
- backend can return payment status;
- all critical policy checks have automated tests.

### Week 3: UI, Demo, and Documentation

Goal:

Deliver a complete Devnet demonstration.

Build:

- wallet-connected UI;
- mandate creation screen;
- mandate detail screen;
- payment simulator screen;
- receipt and status screen;
- pause and revoke controls;
- Devnet demo script;
- product and technical documentation;
- risk and security notes.

Exit criteria:

- complete demo runs on Devnet;
- user can create a mandate from UI;
- agent-like flow executes a valid payment;
- invalid payment is visibly rejected;
- receipt appears in UI;
- final documentation explains ChainPay clearly.

## Extension Roadmap

Only after the core Devnet MVP works, add connectors.

Suggested order:

1. x402 connector for paid HTTP resources.
2. Stripe connector for invoice and merchant reconciliation.
3. PayPal connector for merchant-side payment references.
4. OpenUSD or additional stablecoin support.
5. Visa or enterprise connector exploration.
6. Escrow payments.
7. Subscription payments.
8. Batch payouts.
9. Multi-merchant routing.
10. Advanced Token-2022 extension support.

Each connector should translate external payment demand into the same ChainPay
primitive:

~~~
payment request -> mandate validation -> stablecoin settlement -> receipt
~~~

## Out of Scope for MVP

Do not build these in the first three weeks:

- Visa integration;
- Stripe live payments;
- PayPal live payments;
- OpenUSD production support;
- x402 production integration;
- escrow;
- subscriptions;
- batch payouts;
- fiat conversion;
- merchant underwriting;
- mainnet deployment;
- mobile app;
- confidential transfers;
- MEV-reduction layer;
- full accounting suite.

The current implementation explicitly expands the MVP to support basic
Token-2022 settlement alongside classic SPL Token settlement. Token-2022
transfer hooks, confidential transfers, and other extension-specific flows
remain out of scope until their additional accounts and policy behavior are
tested separately.

## Success Definition

ChainPay succeeds if the demo proves this:

> A user can safely authorize an AI agent to make limited stablecoin payments on Solana Devnet, and the on-chain program enforces every payment rule before settlement.

That is the project.
