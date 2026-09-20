#!/usr/bin/env node
import { ChainPayClient } from "./client.js";
import { address } from "./encoding.js";
import {
  formatOpsAnsi,
  formatPaymentLookupAnsi,
  formatPreparePolicyAnsi,
  formatReceiptListAnsi,
  loadOpsSnapshot,
  receiptListFromSnapshot,
  receiptUrlForAddress,
  tokenLabel,
  humanTokenAmount,
} from "./ops-snapshot.js";

type Flags = {
  owner?: string;
  mandate?: string;
  rpc?: string;
  program?: string;
  json?: boolean;
  help?: boolean;
};

function usage(): string {
  return [
    "chainpay — read spend, receipts, and prepare pause/revoke without signing.",
    "",
    "Usage:",
    "  chainpay status [--owner <wallet>]",
    "  chainpay receipts [--owner <wallet>] [--mandate <pda>]",
    "  chainpay receipt <pda>",
    "  chainpay pause <mandate> --owner <wallet>",
    "  chainpay revoke <mandate> --owner <wallet>",
    "",
    "Flags: --owner --mandate --rpc --program --json --help",
    "Env:   CHAINPAY_OWNER CHAINPAY_RPC_URL CHAINPAY_PROGRAM_ID CHAINPAY_APP_URL",
    "",
    "This CLI never signs, stores keys, or submits a transaction.",
  ].join("\n");
}

function parseArgs(argv: string[]): { command: string; positional: string[]; flags: Flags } {
  const flags: Flags = {};
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--owner" || arg === "--mandate" || arg === "--rpc" || arg === "--program") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) throw new Error(`${arg} needs a value`);
      if (arg === "--owner") flags.owner = value;
      if (arg === "--mandate") flags.mandate = value;
      if (arg === "--rpc") flags.rpc = value;
      if (arg === "--program") flags.program = value;
      index += 1;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  return { command: positional[0] ?? "help", positional: positional.slice(1), flags };
}

type Env = Record<string, string | undefined>;

function clientFrom(flags: Flags, env: Env): ChainPayClient {
  return new ChainPayClient({
    rpcUrl: flags.rpc ?? env.CHAINPAY_RPC_URL,
    programId: flags.program ?? env.CHAINPAY_PROGRAM_ID,
    commitment: "confirmed",
  });
}

function ownerFrom(flags: Flags, env: Env): string {
  const owner = flags.owner ?? env.CHAINPAY_OWNER;
  if (!owner) throw new Error("Pass --owner or set CHAINPAY_OWNER");
  return address(owner);
}

function print(value: unknown, text: string, asJson: boolean | undefined): void {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${text}\n`);
}

export async function runChainPayCli(argv: string[], env: Env = process.env): Promise<number> {
  const { command, positional, flags } = parseArgs(argv);
  if (flags.help || command === "help" || command === "") {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const appUrl = env.CHAINPAY_APP_URL;
  const client = clientFrom(flags, env);

  if (command === "status") {
    const owner = ownerFrom(flags, env);
    const snapshot = await loadOpsSnapshot(client, {
      owner,
      mandateFilter: flags.mandate ? [address(flags.mandate)] : undefined,
      appUrl,
    });
    print(snapshot, formatOpsAnsi(snapshot), flags.json);
    return 0;
  }

  if (command === "receipts") {
    const owner = ownerFrom(flags, env);
    const snapshot = await loadOpsSnapshot(client, {
      owner,
      mandateFilter: flags.mandate ? [address(flags.mandate)] : undefined,
      appUrl,
    });
    const list = receiptListFromSnapshot(snapshot);
    print(list, formatReceiptListAnsi(list), flags.json);
    return 0;
  }

  if (command === "receipt") {
    const raw = positional[0] ?? flags.mandate;
    if (!raw) throw new Error("Pass a receipt PDA: chainpay receipt <pda>");
    const receiptAddress = address(raw);
    const proof = await client.readPublicReceipt(receiptAddress);
    const found = proof.receipt.valid;
    const symbol = found ? tokenLabel(proof.receipt.receipt.mint) : undefined;
    const amount = proof.amount
      ? humanTokenAmount(proof.receipt.valid ? proof.receipt.receipt.amount : 0n, proof.amount.decimals).display
      : undefined;
    const card = {
      kind: "payment_lookup" as const,
      found,
      receiptAddress,
      ...(found
        ? {
          amount,
          symbol,
          status: proof.receipt.receipt.status,
          mandate: proof.receipt.receipt.mandate,
          receiptUrl: receiptUrlForAddress(receiptAddress, appUrl),
        }
        : {}),
    };
    print(card, formatPaymentLookupAnsi(card), flags.json);
    return found ? 0 : 1;
  }

  if (command === "pause" || command === "revoke") {
    const owner = ownerFrom(flags, env);
    const raw = positional[0] ?? flags.mandate;
    if (!raw) throw new Error(`Pass a mandate PDA: chainpay ${command} <mandate> --owner <wallet>`);
    const mandate = address(raw);
    if (command === "pause") client.buildPauseMandate(owner, mandate);
    else client.buildRevokeMandate(owner, mandate);
    const card = {
      action: "owner_wallet_signature_required" as const,
      mandate,
      owner,
      message: formatPreparePolicyAnsi(command, mandate),
    };
    print(card, formatPreparePolicyAnsi(command, mandate), flags.json);
    return 0;
  }

  process.stderr.write(`${usage()}\n`);
  return 1;
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`
  || process.argv[1]?.endsWith("/cli.js")
  || process.argv[1]?.endsWith("\\cli.js");

if (invokedDirectly) {
  runChainPayCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
