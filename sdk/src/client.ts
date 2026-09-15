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
  SupportedAsset,
  TokenProgram,
} from "./types.js";
import { DEFAULT_PROGRAM_ID, DEVNET_RPC_URL, SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "./constants.js";
import { decodeMandate, decodeProtocolConfig, decodeSupportedAsset } from "./accounts.js";
import {
  address,
  publicKey,
  tokenProgramFromAddress,
} from "./encoding.js";
import {
  type CreateMandateInput,
  buildCreateMandateTransaction,
  buildInitializeConfigInstruction,
  buildPauseMandateInstruction,
  buildRevokeDelegateInstruction,
  buildRevokeMandateInstruction,
  buildRegisterAssetInstruction,
  buildSetAssetStatusInstruction,
  buildUpdateMandateInstruction,
} from "./mandate.js";
import {
  buildExecutePaymentInstruction,
  preflightPayment,
  preparePayment as preparePaymentRequest,
  preparedPaymentTransaction,
  type PreparePaymentInput,
} from "./payment.js";
import { deriveAssetAddress, deriveConfigAddress, deriveReceiptAddress } from "./pda.js";
import { paymentPreflightContextFromTokenAccount } from "./token.js";
import {
  amountDisplayFromMint,
  readCurrentMandateFields,
  readPaymentReceiptAccount,
  readPublicSettledReceipt,
  readVerifiedMintDecimals,
  type CurrentMandateRead,
  type PublicReceiptProof,
  type ReceiptReadResult,
} from "./receipt.js";
import { inspectTokenCapabilities } from "./token-capabilities.js";

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

  private async getMandateCreationMetadata(mandateAddress: Address): Promise<Pick<Mandate, "createdAt" | "createdAtSlot">> {
    try {
      let before: string | undefined;
      let oldest: Awaited<ReturnType<Connection["getSignaturesForAddress"]>>[number] | undefined;

      // Signatures are returned newest first. Walk pages so updates and
      // payments do not make the creation time look newer than it is.
      const historyCommitment: "confirmed" | "finalized" =
        this.commitment === "finalized" ? "finalized" : "confirmed";
      for (let page = 0; page < 100; page += 1) {
        const options: { limit: number; before?: string } = { limit: 100 };
        if (before) options.before = before;
        const signatures = await this.connection.getSignaturesForAddress(
          publicKey(mandateAddress),
          options,
          historyCommitment,
        );
        if (signatures.length === 0) break;
        oldest = signatures[signatures.length - 1];
        if (signatures.length < 100) break;
        before = oldest.signature;
      }

      if (!oldest) return {};
      return {
        ...(oldest.blockTime === null ? {} : { createdAt: oldest.blockTime }),
        createdAtSlot: BigInt(oldest.slot),
      };
    } catch {
      // History is display metadata only. A temporary history RPC failure
      // must not hide a valid mandate or block payment preparation.
      return {};
    }
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
    const creation = await this.getMandateCreationMetadata(decoded.address);
    return { ...decoded, tokenProgram, ...creation };
  }

  async getMandatesByOwner(owner: Address): Promise<Mandate[]> {
    const currentSlot = await this.getCurrentSlot();
    const accounts = await this.connection.getProgramAccounts(publicKey(this.programId), {
      commitment: this.commitment,
      filters: [
        { dataSize: 235 },
        { memcmp: { offset: 8, bytes: owner } },
      ],
    });

    const sourceAccounts = new Map<string, ReturnType<Connection["getAccountInfo"]>>();
    return Promise.all(accounts.map(async (account) => {
      const address = account.pubkey.toBase58();
      const decoded = decodeMandate(new Uint8Array(account.account.data), address, currentSlot);
      let sourceRequest = sourceAccounts.get(decoded.sourceTokenAccount);
      if (!sourceRequest) {
        sourceRequest = this.connection.getAccountInfo(
          publicKey(decoded.sourceTokenAccount),
          this.commitment,
        );
        sourceAccounts.set(decoded.sourceTokenAccount, sourceRequest);
      }
      const source = await sourceRequest;
      const tokenProgram = source ? tokenProgramFromAddress(source.owner.toBase58()) : undefined;
      const creation = await this.getMandateCreationMetadata(decoded.address);
      return { ...decoded, tokenProgram, ...creation };
    }));
  }

  async getSupportedAsset(mint: Address): Promise<SupportedAsset | null> {
    const assetAddress = deriveAssetAddress(mint, this.programId);
    const account = await this.getProgramAccount(assetAddress);
    return account ? decodeSupportedAsset(account.data, account.address) : null;
  }

  async getSupportedAssets(): Promise<SupportedAsset[]> {
    const accounts = await this.connection.getProgramAccounts(publicKey(this.programId), {
      commitment: this.commitment,
      filters: [{ dataSize: 106 }],
    });
    return accounts
      .map((account) => decodeSupportedAsset(
        new Uint8Array(account.account.data),
        account.pubkey.toBase58(),
      ))
      .sort((left, right) => left.mint.localeCompare(right.mint));
  }

  async getPayment(lookup: PaymentLookup): Promise<PaymentReceipt | null> {
    const receiptAddress = typeof lookup === "string"
      ? address(lookup)
      : deriveReceiptAddress(lookup.mandate, lookup.invoiceHash, this.programId);
    const account = await this.getProgramAccount(receiptAddress);
    if (!account) return null;
    const result = readPaymentReceiptAccount(
      { address: account.address, owner: this.programId, data: account.data },
      { programId: this.programId, requireSettled: false },
    );
    if (!result.valid) throw new Error(result.reason);
    return result.receipt;
  }

  /**
   * Current mandate account fields only. Does not page creation history or
   * load source token metadata. Public verify uses this for optional
   * enrichment; failure must not invalidate a settled receipt.
   */
  async getCurrentMandateFields(mandateAddress: Address): Promise<CurrentMandateRead> {
    const currentSlot = await this.getCurrentSlot();
    try {
      const account = await this.getProgramAccount(mandateAddress);
      return readCurrentMandateFields(
        account ? { address: account.address, owner: this.programId, data: account.data } : null,
        { programId: this.programId, currentSlot, expectedAddress: mandateAddress },
      );
    } catch (error) {
      return {
        status: "unavailable",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async getVerifiedSettledPayment(receiptAddress: Address): Promise<ReceiptReadResult> {
    const normalized = address(receiptAddress);
    const info = await this.connection.getAccountInfo(publicKey(normalized), this.commitment);
    if (!info) {
      return { valid: false, code: "not_found", reason: "Receipt account not found" };
    }
    return readPublicSettledReceipt(
      { address: normalized, owner: info.owner.toBase58(), data: new Uint8Array(info.data) },
      { programId: this.programId },
    );
  }

  async readPublicReceipt(receiptAddress: Address): Promise<PublicReceiptProof> {
    const receipt = await this.getVerifiedSettledPayment(receiptAddress);
    if (!receipt.valid) {
      return { receipt, amount: null, currentMandate: { status: "absent" } };
    }

    let mintAccount: { owner: Address; data: Uint8Array } | null = null;
    try {
      const mintInfo = await this.connection.getAccountInfo(publicKey(receipt.receipt.mint), this.commitment);
      if (mintInfo) {
        mintAccount = { owner: mintInfo.owner.toBase58(), data: new Uint8Array(mintInfo.data) };
      }
    } catch {
      mintAccount = null;
    }

    let currentMandate: CurrentMandateRead = { status: "absent" };
    try {
      currentMandate = await this.getCurrentMandateFields(receipt.receipt.mandate);
    } catch (error) {
      currentMandate = {
        status: "unavailable",
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    return {
      receipt,
      amount: amountDisplayFromMint(receipt.receipt.amount, mintAccount),
      currentMandate,
    };
  }

  async getPaymentsByMandate(mandateAddress: Address): Promise<PaymentReceipt[]> {
    const mandate = address(mandateAddress);
    const accounts = await this.connection.getProgramAccounts(publicKey(this.programId), {
      commitment: this.commitment,
      filters: [
        { dataSize: 282 },
        { memcmp: { offset: 8, bytes: mandate } },
      ],
    });
    const historyCommitment: "confirmed" | "finalized" =
      this.commitment === "finalized" ? "finalized" : "confirmed";
    const receipts = await Promise.all(accounts.map(async (account) => {
      let transactionSignature: string | undefined;
      try {
        const history = await this.connection.getSignaturesForAddress(
          account.pubkey,
          { limit: 1 },
          historyCommitment,
        );
        transactionSignature = history[0]?.signature;
      } catch {
        // The receipt itself remains verifiable if transaction history is
        // temporarily unavailable. The dashboard can retry enrichment.
      }
      const result = readPaymentReceiptAccount(
        {
          address: account.pubkey.toBase58(),
          owner: account.account.owner.toBase58(),
          data: new Uint8Array(account.account.data),
        },
        { programId: this.programId, requireSettled: false, transactionSignature },
      );
      // The getProgramAccounts filter is dataSize plus a memcmp on the mandate;
      // it does not check the receipt discriminator. Any program-owned 282-byte
      // account matching those bytes lands here, and a partially initialized or
      // future account type would otherwise reject the whole Promise.all and
      // empty an owner's entire history. Skip the row, keep the rest.
      return result.valid ? result.receipt : null;
    }));
    return receipts.filter((receipt): receipt is PaymentReceipt => receipt !== null).sort((left, right) => (
      left.executedAtSlot === right.executedAtSlot
        ? right.address.localeCompare(left.address)
        : left.executedAtSlot > right.executedAtSlot ? -1 : 1
    ));
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
    const decimals = readVerifiedMintDecimals({
      owner: account.owner.toBase58(),
      data: new Uint8Array(account.data),
    });
    if (!decimals.ok && decimals.reason === "unsupported_owner") {
      throw new Error(`Mint is not owned by a supported token program: ${account.owner.toBase58()}`);
    }
    if (!decimals.ok) throw new Error("Mint account data is truncated");
    return decimals.decimals;
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
    const decimals = await this.getMintDecimals(input.allowedMint);
    return buildCreateMandateTransaction(input, owner, this.programId, decimals);
  }

  buildInitializeConfig(
    supportedMints: readonly Address[],
    authority: Address,
  ): PreparedTransaction {
    return {
      instructions: [buildInitializeConfigInstruction(supportedMints, authority, this.programId)],
      requiredSigners: [authority],
      feePayer: authority,
    };
  }

  buildUpdateMandate(
    input: Parameters<typeof buildUpdateMandateInstruction>[0],
    owner: Address,
    mandateAddress?: Address,
  ): PreparedTransaction {
    return {
      instructions: [buildUpdateMandateInstruction(input, owner, this.programId, mandateAddress)],
      requiredSigners: [owner],
      feePayer: owner,
    };
  }

  buildRegisterAsset(
    mint: Address,
    tokenProgram: TokenProgram,
    authority: Address,
  ): PreparedTransaction {
    return {
      instructions: [buildRegisterAssetInstruction({ mint, tokenProgram }, authority, this.programId)],
      requiredSigners: [authority],
      feePayer: authority,
    };
  }

  buildSetAssetStatus(
    mint: Address,
    authority: Address,
    enabled: boolean,
  ): PreparedTransaction {
    return {
      instructions: [buildSetAssetStatusInstruction(mint, authority, enabled, this.programId)],
      requiredSigners: [authority],
      feePayer: authority,
    };
  }

  buildPauseMandate(owner: Address, mandateAddress?: Address): PreparedTransaction {
    return {
      instructions: [buildPauseMandateInstruction(owner, this.programId, mandateAddress)],
      requiredSigners: [owner],
      feePayer: owner,
    };
  }

  buildRevokeMandate(owner: Address, mandateAddress?: Address): PreparedTransaction {
    return {
      instructions: [buildRevokeMandateInstruction(owner, this.programId, mandateAddress)],
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
    const untrustedRemainingAccounts = (input as PreparePaymentInput & { remainingAccounts?: unknown[] }).remainingAccounts;
    if (untrustedRemainingAccounts?.length) {
      throw new Error("Caller-supplied remainingAccounts are not accepted; extension accounts must be resolved from verified on-chain state");
    }
    const asset = await this.getSupportedAsset(input.mint);
    const expectedProgram = tokenProgram === "token-2022" ? TOKEN_2022_PROGRAM_ID : SPL_TOKEN_PROGRAM_ID;
    if (!asset || !asset.enabled) {
      throw new Error("Payment mint is not enabled in the ChainPay SupportedAsset registry");
    }
    if (asset.mint !== input.mint || asset.tokenProgram !== expectedProgram) {
      throw new Error("SupportedAsset mint or token program does not match the payment request");
    }
    const capabilityProfile = await inspectTokenCapabilities(this.connection, {
      mint: input.mint,
      sourceTokenAccount: mandate.sourceTokenAccount,
      recipientTokenAccount: input.recipient,
      tokenProgram,
      commitment: this.commitment,
    });
    if (!capabilityProfile.compatible) {
      throw new Error(`Token capability check failed: ${capabilityProfile.blockers.join("; ")}`);
    }
    const request: PaymentRequest = preparePaymentRequest({ ...input, tokenProgram });
    const currentSlot = await this.getCurrentSlot();
    const executionAgent = agent ?? mandate.approvedAgent;
    const receiptAddress = deriveReceiptAddress(mandate.address, request.invoiceHash, this.programId);
    const existingReceipt = await this.getPayment(receiptAddress);
    const sourceAccountInfo = await this.connection.getAccountInfo(
      publicKey(mandate.sourceTokenAccount),
      this.commitment,
    );
    const sourceContext = sourceAccountInfo
      ? paymentPreflightContextFromTokenAccount(new Uint8Array(sourceAccountInfo.data))
      : undefined;
    const preflight = preflightPayment(
      request,
      mandate,
      currentSlot,
      executionAgent,
      existingReceipt !== null,
      sourceContext ?? undefined,
    );
    const instruction = buildExecutePaymentInstruction(request, executionAgent, mandate, this.programId);

    return {
      request,
      mandate,
      receiptAddress,
      instruction,
      transaction: preparedPaymentTransaction(instruction, executionAgent),
      preflight,
      capabilityProfile,
    };
  }

  async executePayment(
    prepared: PreparedPayment,
    adapter: PaymentSubmissionAdapter,
  ) {
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
      };
    } catch (error) {
      return {
        status: "failed" as const,
        receiptAddress: prepared.receiptAddress,
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
