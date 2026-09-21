#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
} from "./ops-snapshot.js";
import type { Mandate, PreparedTransaction } from "./types.js";

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
    "chainpay — read spend and receipts, and prepare pause/revoke without signing.",
    "",
    "Usage:",
    "  chainpay status [--owner <wallet>]",
    "  chainpay receipts [--owner <wallet>] [--mandate <pda>]",
    "  chainpay receipt <pda>",
    "  chainpay pause <mandate> --owner <wallet>",
    "  chainpay revoke <mandate> --owner <wallet>",
    "",
    "Flags: --owner --mandate --rpc --program --json --help",
    "       --json prints the snapshot, or for pause/revoke the unsigned transaction.",
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

function mandateFilterFrom(flags: Flags): ((mandate: Mandate) => boolean) | undefined {
  if (!flags.mandate) return undefined;
  const wanted = address(flags.mandate);
  return (mandate) => mandate.address === wanted;
}

/** The same shape the MCP pause_mandate tool returns, so a wallet flow can take either. */
function serializeTransaction(transaction: PreparedTransaction) {
  return {
    feePayer: transaction.feePayer,
    requiredSigners: transaction.requiredSigners,
    instructions: transaction.instructions.map((item) => ({
      name: item.name,
      programId: item.programId,
      keys: item.keys,
      dataBase64: Buffer.from(item.data).toString("base64"),
    })),
  };
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
      mandateFilter: mandateFilterFrom(flags),
      appUrl,
    });
    print(snapshot, formatOpsAnsi(snapshot), flags.json);
    return 0;
  }

  if (command === "receipts") {
    const owner = ownerFrom(flags, env);
    const snapshot = await loadOpsSnapshot(client, {
      owner,
      mandateFilter: mandateFilterFrom(flags),
      appUrl,
    });
    const list = receiptListFromSnapshot(snapshot);
    print(list, formatReceiptListAnsi(list), flags.json);
    return 0;
  }

  if (command === "receipt") {
    const raw = positional[0];
    if (!raw) throw new Error("Pass a receipt PDA: chainpay receipt <pda>");
    const receiptAddress = address(raw);
    const proof = await client.readPublicReceipt(receiptAddress);
    const card = {
      kind: "payment_lookup" as const,
      found: proof.receipt.valid,
      receiptAddress,
      ...(proof.receipt.valid
        ? {
          amount: proof.amount?.display,
          symbol: tokenLabel(proof.receipt.receipt.mint),
          status: proof.receipt.receipt.status,
          mandate: proof.receipt.receipt.mandate,
          receiptUrl: receiptUrlForAddress(receiptAddress, appUrl),
        }
        : {}),
    };
    print(card, formatPaymentLookupAnsi(card), flags.json);
    return card.found ? 0 : 1;
  }

  if (command === "pause" || command === "revoke") {
    const owner = ownerFrom(flags, env);
    const raw = positional[0] ?? flags.mandate;
    if (!raw) throw new Error(`Pass a mandate PDA: chainpay ${command} <mandate> --owner <wallet>`);
    const mandate = address(raw);
    const transaction = command === "pause"
      ? client.buildPauseMandate(owner, mandate)
      : client.buildRevokeMandate(owner, mandate);
    const card = {
      action: "owner_wallet_signature_required" as const,
      mandate,
      owner,
      transaction: serializeTransaction(transaction),
    };
    print(card, formatPreparePolicyAnsi(command, mandate), flags.json);
    return 0;
  }

  process.stderr.write(`${usage()}\n`);
  return 1;
}

// Compare paths, not URLs: a space in the directory name is percent-encoded in
// import.meta.url and literal in argv, and a suffix match would also fire for
// any other package's cli.js that happens to import this module.
const invokedDirectly = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) {
  runChainPayCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
