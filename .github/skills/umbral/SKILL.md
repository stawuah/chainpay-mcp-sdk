---
name: umbral
description: 'Use when building or planning Umbral, a Solana-based confidential stablecoin settlement protocol. Covers the required architecture, build order, milestone gates, and non-negotiable constraints for native Token-2022 confidential transfers, Anchor hooks, SDK work, and backend relay flows.'
argument-hint: 'Build the next Umbral phase, verify a milestone gate, or review the architecture'
user-invocable: true
disable-model-invocation: false
---

# Umbral Build Skill

## When to Use
- Start or continue the Umbral implementation.
- Plan or review Week 1 through Week 4 work.
- Check whether a proposed design violates the protocol constraints.
- Prepare a devnet demo, SDK flow, backend relay, or security write-up.

## What This Skill Produces
A build-ready implementation plan and execution workflow for Umbral that stays aligned with the core architecture:
- confidential stablecoin settlement on Solana,
- native Token-2022 Confidential Transfer usage,
- no privileged decryption authority,
- no custom ZK circuit implementation,
- a clear milestone-driven build sequence.

## Non-Negotiable Architecture Constraints
Do not deviate from these without asking first.

1. Use native Solana Token-2022 Confidential Transfer extension.
   - This includes ElGamal encryption and the native validity/equality/range proofs.
   - Do not write a custom ZK circuit, Noir program, or custom verifier crate.

2. Umbral holds no policy authority and no decryption key.
   - No allow-list, no admin-gated recipient checks, no auditor key, no PolicyConfig-style account.
   - Any compliance logic belongs outside the core protocol.

3. Do not add a custom nullifier/double-spend PDA.
   - Replay/double-spend protection is inherited from the native confidential-transfer balance model and proof system.

4. Scope is stablecoin settlement only.
   - Focus on USDC/USDT transfers.
   - Do not add swaps, lending, DEX routing, or general-purpose privacy features.

5. Explicitly out of scope.
   - Hiding sender/recipient identity.
   - Hiding pre-confirmation timing/visibility.
   - Real-time amount-based on-chain policy enforcement.

## Working Mental Model
Umbral is a transaction-level confidentiality layer for settlement, not a consumer privacy app and not a block-level MEV prevention system.

The design intent is:
- hide the transfer amount cryptographically,
- make transfers structurally uniform,
- ensure only sender and recipient can ever see the real amount,
- provide a public, verifiable settlement proof without revealing the amount.

## Build Order
Follow the phases strictly in order. Do not skip ahead or merge phases.

### Week 1 — Native CT Primitive, No Umbral Logic
Goal: prove the base confidential transfer primitive works end to end.

Tasks:
1. Create or configure a devnet Token-2022 mint with Confidential Transfer and Transfer Hook extensions enabled.
2. Use the Solana SPL token CT helpers to perform a basic confidential transfer between two test keypairs.
3. Capture the ciphertext and the three proof types: validity, equality, and range.
4. Confirm the transfer settles correctly.

Milestone gate:
- Show the ciphertext and proof artifacts.
- Confirm settlement.
- If this fails, stop and report the blocker before continuing.

### Week 2 — Anchor Program
Goal: add the Umbral bookkeeping and settlement hook layer.

Tasks:
1. Implement a one-time registration flow for a confidential account.
2. Create a ConfidentialAccountRegistry PDA with seeds ["conf_acct", owner_pubkey].
3. Implement confirm_settlement as a Transfer Hook.
   - It confirms settlement occurred.
   - It emits a TransferSettled event.
   - It does not gate on recipient, amount, or policy.
4. Define the required errors: UnregisteredAccount and StaleSimulation.

Milestone gate:
- Demonstrate registration plus hook-confirmed settlement.
- Prove a duplicate/replay submission fails automatically through the inherited native CT proof model.

### Week 3 — SDK
Goal: make the client-side transfer flow confidential and uniform.

Tasks:
1. Generate and manage an ElGamal keypair separate from the wallet signing key.
2. Encrypt the amount and produce the three native CT proofs client-side.
3. Enforce the three hard uniformity requirements at all times:
   - always use the same instruction set, including registration as a no-op when already done,
   - always attach an SPL Memo instruction as a receipt reference,
   - never scale priority fee or compute unit budget to perceived transfer size.
4. Integrate wallet-adapter signing flow:
   - request signMessage for the transfer intent first,
   - then signTransaction for final submission,
   - support Phantom, Backpack, and Solflare through the standard adapter interface.

Milestone gate:
- Connect wallet, encrypt/prove client-side, submit transfer, and observe settlement.

### Week 4 — Backend, Demo, and Security Write-Up
Goal: package the flow into a minimal relay-based product experience.

Tasks:
1. Implement backend endpoints:
   - POST /v1/transfer for relaying a built transaction,
   - GET /v1/transfer/:id for status lookup,
   - optional POST /v1/proof/simulate for pre-flight dry run.
2. Keep the backend stateless and non-authoritative:
   - no keys,
   - no policy decisions,
   - no plaintext amount or recipient storage.
3. Use minimal Postgres/Redis storage only for transfer status and rate limiting.
4. Produce a security write-up covering:
   - replay/double-spend prevention,
   - proof forgery resistance,
   - what a malicious backend can and cannot do,
   - which MEV vectors are closed vs. still out of scope.

Milestone gate:
- End-to-end devnet demo completes successfully and matches the intended flow.

## Practical Implementation Checklist
Before coding, do the following:
- Confirm the current library and RPC support for Token-2022 confidential transfers.
- Decide whether the current milestone is feasible with the available tooling.
- Write or review the minimal test case for the current phase before expanding scope.
- Record evidence for each milestone gate.

When working on a phase:
- Prefer the smallest change that proves the current milestone.
- Avoid introducing policy logic or decryption authority into the core program.
- Avoid adding custom logic that duplicates native CT protections.
- If a later phase requires a change to an earlier assumption, stop and explain the mismatch before silently patching around it.

## Red Flags
Stop and ask before proceeding if any of the following appear:
- A custom ZK circuit or custom verifier is being proposed.
- The program begins to hold policy or decryption authority.
- The SDK starts conditionally skipping registration or memo instructions based on transfer context.
- The transfer flow tries to infer or assign amount-based priority or compute cost.
- Identity-hiding or pre-confirmation timing features are being folded into core MVP work.

## Suggested Prompt Patterns
Use prompts like these to drive the implementation:
- “Build the Week 1 confidential transfer flow on devnet and show the proof artifacts.”
- “Implement the Register and Confirm settlement flow for the Anchor program.”
- “Review this SDK change for the three uniformity constraints.”
- “Draft the backend relay endpoints and a minimal transfer-status schema.”
- “Write the security rationale for replay protection and the no-privileged-party model.”
