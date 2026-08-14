# ChainPay token account and payment flow

## The simple idea

Solana tokens are held in token accounts. A wallet owns those accounts, but
the tokens are not stored directly in the wallet address itself.

Think of each token account as a dedicated compartment:

```text
Wallet
├── USDC token account
└── PYUSD Token-2022 account
```

One wallet can hold both USDC and PYUSD. Each token uses a separate account.

## 1. Prepare the wallet

The `Prepare wallet` button creates the wallet's associated token account for
the selected mint if it does not already exist.

For example, selecting PYUSD creates the wallet's PYUSD Token-2022 account.

It does not:

- move funds;
- mint tokens;
- create a mandate; or
- give the AI access to the wallet key.

The account remains owned and controlled by the connected wallet.

If the wallet already has the selected token account, preparation simply uses
that account.

## 2. Fund the token account

The selected token account must contain the token being spent.

For example:

```text
Your wallet's PYUSD account: 100 PYUSD
```

Preparing the account does not put tokens into it. Tokens must be received or
transferred into the account separately.

## 3. Create the mandate

Your wallet creates a mandate that defines:

- the approved AI agent;
- the allowed mint, such as USDC or PYUSD;
- the source token account;
- the maximum amount per payment;
- the total spending limit; and
- the expiry.

Your wallet then approves the mandate PDA as a limited token delegate.

The mandate PDA is allowed to spend only within those rules.

## 4. The AI requests a payment

The AI agent uses ChainPay MCP to request a payment. It supplies:

- the mandate;
- the token mint;
- the amount;
- the invoice or payment reference; and
- the recipient.

The AI receives no wallet private key and does not receive unrestricted access
to the funds.

## 5. ChainPay checks the payment

ChainPay checks the request against the mandate and the on-chain asset
registry:

- Is the agent approved?
- Is the mint allowed?
- Is the token program correct?
- Is the recipient valid?
- Is the amount below the per-payment limit?
- Is the total limit still available?
- Has the mandate expired or been revoked?
- Has this invoice already been paid?

The payment is blocked if any check fails.

## 6. The recipient receives the funds

The transfer uses the recipient's token account for the selected mint:

```text
Your source token account → Recipient token account
```

If a wallet address is supplied, ChainPay derives the recipient's associated
token account for that exact mint. If the account does not exist, it can be
created before the payment.

The recipient receives the actual token:

- USDC goes to the recipient's USDC account.
- PYUSD goes to the recipient's PYUSD Token-2022 account.

The recipient does not receive SOL. They need a wallet that supports the
selected token and the correct network.

## Complete flow

```text
1. Prepare wallet
   └── Create the wallet's token account if missing

2. Fund token account
   └── Put USDC or PYUSD into the account

3. Create mandate
   └── Set agent, mint, limits, and expiry

4. Approve mandate PDA
   └── Give ChainPay limited delegate authority

5. AI calls ChainPay MCP
   └── Request a specific payment

6. ChainPay validates the rules
   └── Block or approve the request on-chain

7. Payment settles
   └── Source token account → recipient token account

8. Receipt is written
   └── The settlement can be looked up later
```

The wallet remains the owner of the funds throughout the flow. The AI can
request and sign an approved payment transaction, but it cannot spend outside
the mandate or take control of the wallet.

