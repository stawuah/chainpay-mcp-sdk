import {
  Connection,
  type Commitment,
} from "@solana/web3.js";
import type {
  Address,
  ChainPayClientOptions,
  Mandate,
  PaymentReceipt,
  PaymentRequest,
  PaymentSubmissionAdapter,
  PreparedMandate,
  PreparedPayment,
  PreparedTransaction,
  TokenProgram,
} from "./types.js";
import { DEFAULT_PROGRAM_ID, DEVNET_RPC_URL, SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "./constants.js";
import { decodeMandate, decodePaymentReceipt, decodeProtocolConfig } from "./accounts.js";
import {
  address,
  publicKey,
  tokenProgramFromAddress,
} from "./encoding.js";
import {
  type CreateMandateInput,
  buildCreateMandateTransaction,
  buildPauseMandateInstruction,
  buildRevokeDelegateInstruction,
  buildRevokeMandateInstruction,
  buildUpdateMandateInstruction,
} from "./mandate.js";
import {
  buildExecutePaymentInstruction,
  preflightPayment,
  preparePayment as preparePaymentRequest,
  preparedPaymentTransaction,
  type PreparePaymentInput,
} from "./payment.js";
import { deriveConfigAddress, deriveReceiptAddress } from "./pda.js";
import { simulatePrepared } from "./solana.js";

export type PaymentLookup =
  | Address
  | {
      mandate: Address;
      invoiceHash: Uint8Array;
    };

export class ChainPayClient {
  readonly connection: Connection;
  readonly programId: Address;
  readonly commitment: Commitment;

  constructor(options: ChainPayClientOptions | Connection = {}) {
    if (options instanceof Connection) {
      this.connection = options;
      this.programId = DEFAULT_PROGRAM_ID;
      this.commitment = "confirmed";
      return;
    }

    this.connection = new Connection(options.rpcUrl ?? DEVNET_RPC_URL, options.commitment ?? "confirmed");
    this.programId = address(options.programId ?? DEFAULT_PROGRAM_ID);
    this.commitment = options.commitment ?? "confirmed";
  }

  async getCurrentSlot(): Promise<bigint> {
    return BigInt(await this.connection.getSlot(this.commitment));
  }

  async getConfig(): Promise<ReturnType<typeof decodeProtocolConfig> | null> {
    const account = await this.getProgramAccount(deriveConfigAddress(this.programId));
    return account ? decodeProtocolConfig(account.data, account.address) : null;
  }

  async getMandate(mandateAddress: Address): Promise<Mandate | null> {
    const currentSlot = await this.getCurrentSlot();
    const account = await this.getProgramAccount(mandateAddress);
    if (!account) return null;

    const decoded = decodeMandate(account.data, account.address, currentSlot);
    const source = await this.connection.getAccountInfo(
      publicKey(decoded.sourceTokenAccount),
      this.commitment,
    );
    const tokenProgram = source ? tokenProgramFromAddress(source.owner.toBase58()) : undefined;
    return { ...decoded, tokenProgram };
  }

  async getPayment(lookup: PaymentLookup): Promise<PaymentReceipt | null> {
    const receiptAddress = typeof lookup === "string"
      ? address(lookup)
      : deriveReceiptAddress(lookup.mandate, lookup.invoiceHash, this.programId);
    const account = await this.getProgramAccount(receiptAddress);
    return account ? decodePaymentReceipt(account.data, account.address) : null;
  }

  async getTokenProgram(accountAddress: Address): Promise<TokenProgram> {
    const account = await this.connection.getAccountInfo(publicKey(accountAddress), this.commitment);
    if (!account) throw new Error(`Token account not found: ${accountAddress}`);
    const tokenProgram = tokenProgramFromAddress(account.owner.toBase58());
    if (!tokenProgram) throw new Error(`Unsupported token program: ${account.owner.toBase58()}`);
    return tokenProgram;
  }

  async getMintDecimals(mint: Address): Promise<number> {
    const account = await this.connection.getAccountInfo(publicKey(mint), this.commitment);
    if (!account) throw new Error(`Mint account not found: ${mint}`);
    const owner = account.owner.toBase58();
    if (owner !== SPL_TOKEN_PROGRAM_ID && owner !== TOKEN_2022_PROGRAM_ID) {
      throw new Error(`Mint is not owned by a supported token program: ${owner}`);
    }
    if (account.data.length <= 44) throw new Error("Mint account data is truncated");
    return account.data[44];
  }

  async buildCreateMandate(
    input: CreateMandateInput,
    owner: Address,
  ): Promise<PreparedMandate> {
    const mintProgram = await this.getTokenProgram(input.allowedMint);
    if (mintProgram !== input.tokenProgram) {
      throw new Error(`Mint token program is ${mintProgram}, but mandate requested ${input.tokenProgram}`);
    }
    const sourceProgram = await this.getTokenProgram(input.sourceTokenAccount);
    if (sourceProgram !== input.tokenProgram) {
      throw new Error(`Source token account uses ${sourceProgram}, but mandate requested ${input.tokenProgram}`);
    }
    const recipientProgram = await this.getTokenProgram(input.allowedRecipient);
    if (recipientProgram !== input.tokenProgram) {
      throw new Error(`Recipient token account uses ${recipientProgram}, but mandate requested ${input.tokenProgram}`);
    }
    const decimals = await this.getMintDecimals(input.allowedMint);
    return buildCreateMandateTransaction(input, owner, this.programId, decimals);
  }

  buildUpdateMandate(input: Parameters<typeof buildUpdateMandateInstruction>[0], owner: Address): PreparedTransaction {
    return {
      instructions: [buildUpdateMandateInstruction(input, owner, this.programId)],
      requiredSigners: [owner],
      feePayer: owner,
    };
  }

  buildPauseMandate(owner: Address): PreparedTransaction {
    return {
      instructions: [buildPauseMandateInstruction(owner, this.programId)],
      requiredSigners: [owner],
      feePayer: owner,
    };
  }

  buildRevokeMandate(owner: Address): PreparedTransaction {
    return {
      instructions: [buildRevokeMandateInstruction(owner, this.programId)],
      requiredSigners: [owner],
      feePayer: owner,
    };
  }

  buildRevokeDelegate(
    sourceTokenAccount: Address,
    owner: Address,
    tokenProgram: TokenProgram,
  ): PreparedTransaction {
    return {
      instructions: [buildRevokeDelegateInstruction(sourceTokenAccount, owner, tokenProgram)],
      requiredSigners: [owner],
      feePayer: owner,
    };
  }

  async preparePayment(
    input: PreparePaymentInput,
    agent?: Address,
  ): Promise<PreparedPayment> {
    const mandate = await this.getMandate(input.mandate);
    if (!mandate) throw new Error(`Mandate not found: ${input.mandate}`);
    const tokenProgram = input.tokenProgram ?? mandate.tokenProgram ?? await this.getTokenProgram(mandate.sourceTokenAccount);
    const request: PaymentRequest = preparePaymentRequest({ ...input, tokenProgram });
    const currentSlot = await this.getCurrentSlot();
    const executionAgent = agent ?? mandate.approvedAgent;
    const receiptAddress = deriveReceiptAddress(mandate.address, request.invoiceHash, this.programId);
    const existingReceipt = await this.getPayment(receiptAddress);
    const preflight = preflightPayment(
      request,
      mandate,
      currentSlot,
      executionAgent,
      existingReceipt !== null,
    );
    const instruction = buildExecutePaymentInstruction(request, executionAgent, mandate, this.programId);

    return {
      request,
      mandate,
      receiptAddress,
      instruction,
      transaction: preparedPaymentTransaction(instruction, executionAgent),
      preflight,
    };
  }

  async simulate(prepared: PreparedTransaction) {
    return simulatePrepared(this.connection, prepared, this.commitment);
  }

  async executePayment(
    prepared: PreparedPayment,
    adapter: PaymentSubmissionAdapter,
  ) {
    let simulation;
    try {
      simulation = await adapter.simulate(prepared.transaction);
    } catch (error) {
      return {
        status: "failed" as const,
        receiptAddress: prepared.receiptAddress,
        simulation: {
          ok: false,
          logs: [],
          error: error instanceof Error ? error.message : String(error),
        },
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (!simulation.ok) {
      return {
        status: "failed" as const,
        receiptAddress: prepared.receiptAddress,
        simulation,
        error: simulation.error ?? "Transaction simulation failed",
      };
    }

    try {
      const submission = await adapter.submit(prepared.transaction);
      let status = submission.status ?? "submitted";
      let slot = submission.slot;
      if (adapter.confirm) {
        const confirmation = await adapter.confirm(submission.signature);
        status = "confirmed";
        slot = confirmation.slot ?? slot;
      }
      return {
        status,
        receiptAddress: prepared.receiptAddress,
        signature: submission.signature,
        slot,
        simulation,
      };
    } catch (error) {
      return {
        status: "failed" as const,
        receiptAddress: prepared.receiptAddress,
        simulation,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async getProgramAccount(accountAddress: Address) {
    const normalized = address(accountAddress);
    const info = await this.connection.getAccountInfo(publicKey(normalized), this.commitment);
    if (!info) return null;
    if (info.owner.toBase58() !== this.programId) {
      throw new Error(`Account ${normalized} is not owned by ChainPay program`);
    }
    return { address: normalized, data: new Uint8Array(info.data) };
  }
}
