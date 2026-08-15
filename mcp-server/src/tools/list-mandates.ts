import { PublicKey } from "@solana/web3.js";
import type { Address, Mandate, TokenProgram } from "@chainpay/sdk";
import { SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@chainpay/sdk";
import type { ChainPayMcpContext } from "./context.js";
import { solanaAddress, tokenProgram, toolResult, unsignedInteger } from "./common.js";
import { displayTokenAmounts } from "./token-amount.js";

type TokenAccountState = {
  valid: boolean;
  delegatedAmount: bigint;
  reason?: string;
};

function readLittleEndianU64(bytes: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let index = 0; index < 8; index += 1) value |= BigInt(bytes[offset + index] ?? 0) << BigInt(index * 8);
  return value;
}

async function sourceTokenAccountState(
  context: ChainPayMcpContext,
  mandate: Mandate,
): Promise<TokenAccountState> {
  const account = await context.client.connection.getAccountInfo(new PublicKey(mandate.sourceTokenAccount), context.client.commitment);
  if (!account) return { valid: false, delegatedAmount: 0n, reason: "Source token account was not found" };
  const expectedProgram = mandate.tokenProgram === "token-2022" ? TOKEN_2022_PROGRAM_ID : SPL_TOKEN_PROGRAM_ID;
  if (account.owner.toBase58() !== expectedProgram) {
    return { valid: false, delegatedAmount: 0n, reason: "Source token account uses a different token program" };
  }
  if (account.data.length < 129) return { valid: false, delegatedAmount: 0n, reason: "Source token account data is truncated" };
  const delegateOption = account.data[72] === 1;
  const delegate = new PublicKey(Buffer.from(account.data.subarray(76, 108))).toBase58();
  const delegatedAmount = readLittleEndianU64(account.data, 121);
  if (!delegateOption || delegate !== mandate.address) {
    return { valid: false, delegatedAmount, reason: "Source token account is not delegated to this mandate" };
  }
  if (delegatedAmount <= 0n) return { valid: false, delegatedAmount, reason: "Source token account has no delegated allowance" };
  return { valid: true, delegatedAmount };
}

async function presentMandate(context: ChainPayMcpContext, mandate: Mandate) {
  const source = await sourceTokenAccountState(context, mandate);
  const display = await displayTokenAmounts(context.client, mandate.allowedMint, {
    maxPerPayment: mandate.maxPerPayment,
    totalLimit: mandate.totalLimit,
    amountSpent: mandate.amountSpent,
    delegatedAmount: source.delegatedAmount,
  });
  return { mandate, source, display };
}

export async function listMandates(
  context: ChainPayMcpContext,
  args: Record<string, unknown>,
) {
  const owner = solanaAddress(args.owner, "owner");
  const mandates = await context.client.getMandatesByOwner(owner);
  const presented = await Promise.all(mandates.map((mandate) => presentMandate(context, mandate)));
  return toolResult({ owner, count: presented.length, mandates: presented });
}

export async function findCompatibleMandate(
  context: ChainPayMcpContext,
  args: Record<string, unknown>,
) {
  const owner = solanaAddress(args.owner, "owner");
  const mint = solanaAddress(args.mint, "mint");
  const amount = unsignedInteger(args.amount, "amount");
  const selectedTokenProgram: TokenProgram | undefined = args.tokenProgram === undefined
    ? undefined
    : tokenProgram(args.tokenProgram);
  const agent = args.agent === undefined ? undefined : solanaAddress(args.agent, "agent");
  const mandates = await context.client.getMandatesByOwner(owner);
  const candidates = await Promise.all(mandates.map(async (mandate) => {
    const source = await sourceTokenAccountState(context, mandate);
    const checks = {
      active: mandate.status === "active",
      agent: agent === undefined || mandate.approvedAgent === agent,
      mint: mandate.allowedMint === mint,
      tokenProgram: selectedTokenProgram === undefined || mandate.tokenProgram === selectedTokenProgram,
      perPayment: amount <= mandate.maxPerPayment,
      totalLimit: mandate.amountSpent + amount <= mandate.totalLimit,
      sourceDelegate: source.valid,
      delegatedAllowance: source.delegatedAmount >= amount,
    };
    return {
      ...(await presentMandate(context, mandate)),
      checks,
      compatible: Object.values(checks).every(Boolean),
    };
  }));
  const match = candidates.find((candidate) => candidate.compatible);
  return toolResult({
    owner,
    request: { mint, amount: amount.toString(), tokenProgram: selectedTokenProgram, agent },
    compatible: Boolean(match),
    match: match ?? null,
    candidates,
  }, !match);
}
