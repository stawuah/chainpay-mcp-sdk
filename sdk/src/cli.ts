#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import { ChainPayClient } from "./client.js";
import { address } from "./encoding.js";
import {
  buildMandateRequestPayload,
  encodeMandateRequestLink,
  mandateRequestSummary,
  parseHumanTokenAmount,
  signMandateRequest,
} from "./mandate-request.js";
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
import { assetLabel } from "./known-assets.js";
import { receiptPolicy, receiptsToCsv, type ReceiptCsvRow } from "./receipt-export.js";
import type { Mandate, PaymentReceipt, PreparedTransaction, TokenProgram } from "./types.js";

const VALUE_FLAGS = {
  "--owner": "owner",
  "--mandate": "mandate",
  "--rpc": "rpc",
  "--program": "program",
  "--out": "out",
  "--keypair": "keypair",
  "--mint": "mint",
  "--recipient": "recipient",
  "--agent": "agent",
  "--per-payment": "perPayment",
  "--total": "total",
  "--days": "days",
  "--link-days": "linkDays",
  "--description": "description",
  "--po": "po",
  "--name": "name",
  "--app-url": "appUrl",
  "--decimals": "decimals",
  "--token-program": "tokenProgram",
} as const;

type ValueFlag = (typeof VALUE_FLAGS)[keyof typeof VALUE_FLAGS];

type Flags = Partial<Record<ValueFlag, string>> & {
  json?: boolean;
  help?: boolean;
};

/** The default public app, the same one the MCP server links to. */
export const DEFAULT_APP_URL = "https://chainpay-frontend.onrender.com";

function usage(): string {
  return [
    "chainpay — read spend and receipts, and prepare pause/revoke without signing.",
    "",
    "Usage:",
    "  chainpay status [--owner <wallet>]",
    "  chainpay receipts [--owner <wallet>] [--mandate <pda>]",
    "  chainpay receipt <pda>",
    "  chainpay export [--owner <wallet>] [--mandate <pda>] [--out <file.csv>]",
    "  chainpay pause <mandate> --owner <wallet>",
    "  chainpay revoke <mandate> --owner <wallet>",
    "  chainpay request-mandate --keypair <file> --mint <mint> --recipient <addr>",
    "      --per-payment <amount> --total <amount> --days <n> --description <text>",
    "      [--po <id>] [--name <name>] [--app-url <url>]",
    "  chainpay request-budget --keypair <file> --agent <addr> --mint <mint>",
    "      --total <amount> [--per-payment <amount>] --days <n> --description <text>",
    "      [--name <name>] [--app-url <url>]",
    "",
    "Flags: --owner --mandate --rpc --program --out --json --help",
    "       export writes receipts as CSV to --out, or to stdout.",
    "       --json prints the snapshot, or for pause/revoke the unsigned transaction.",
    "       Requests also take --decimals --token-program --link-days (default 7).",
    "       Amounts are whole tokens, e.g. 5 or 2.5, converted exactly.",
    "Env:   CHAINPAY_OWNER CHAINPAY_RPC_URL CHAINPAY_PROGRAM_ID CHAINPAY_APP_URL",
    "",
    "This CLI never submits a transaction or prints a key. request-mandate and",
    "request-budget sign only an off-chain request with your keypair file; the",
    "owner who opens the link decides the limits and signs in their own wallet.",
  ].join("\n");
}

function parseArgs(argv: string[]): { command: string; positional: string[]; flags: Flags } {
  const flags: Flags = {};
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--json") flags.json = true;
    else if (Object.prototype.hasOwnProperty.call(VALUE_FLAGS, arg)) {
      const value = argv[index + 1];
      if (value === undefined || value === "" || (value.startsWith("-") && arg !== "--description")) {
        throw new Error(`${arg} needs a value`);
      }
      flags[VALUE_FLAGS[arg as keyof typeof VALUE_FLAGS]] = value;
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

type ExportClient = Pick<ChainPayClient, "getMandatesByOwner" | "getPaymentsByMandate" | "getMintDecimals"> & {
  connection: Pick<ChainPayClient["connection"], "getBlockTime">;
};

/**
 * Every receipt under the owner's mandates as one CSV, newest first. Limits
 * come from each receipt's on-chain snapshot or read "not-recorded": the CLI
 * has no relay session, so it never shows a relay observation. Dates come from
 * block time and stay empty when unknown.
 */
export async function exportReceiptsCsv(
  client: ExportClient,
  options: { owner: string; mandateFilter?: (mandate: Mandate) => boolean; appUrl?: string },
): Promise<{ csv: string; rowCount: number }> {
  const mandates = (await client.getMandatesByOwner(options.owner))
    .filter((mandate) => !options.mandateFilter || options.mandateFilter(mandate));
  const receipts: PaymentReceipt[] = (await Promise.all(
    mandates.map((mandate) => client.getPaymentsByMandate(mandate.address)),
  ))
    .flat()
    .sort((left, right) => (right.executedAtSlot > left.executedAtSlot ? 1 : right.executedAtSlot < left.executedAtSlot ? -1 : 0));
  const decimals = new Map<string, number | null>();
  await Promise.all([...new Set(receipts.map((receipt) => receipt.mint))].map(async (mint) => {
    decimals.set(mint, await client.getMintDecimals(mint).catch(() => null));
  }));
  const blockTimes = new Map<bigint, number | null>();
  await Promise.all([...new Set(receipts.map((receipt) => receipt.executedAtSlot))].map(async (slot) => {
    blockTimes.set(slot, await client.connection.getBlockTime(Number(slot)).catch(() => null));
  }));
  const rows: ReceiptCsvRow[] = receipts.map((receipt) => {
    const verifyUrl = receiptUrlForAddress(receipt.address, options.appUrl);
    return {
      receipt,
      decimals: decimals.get(receipt.mint) ?? null,
      symbol: assetLabel(receipt.mint, receipt.mint),
      blockTime: blockTimes.get(receipt.executedAtSlot) ?? null,
      policy: receiptPolicy(receipt),
      ...(verifyUrl ? { verifyUrl } : {}),
    };
  });
  return { csv: receiptsToCsv(rows), rowCount: rows.length };
}

/** What a request command reads from the network. Injected in tests. */
export type RequestCommandDependencies = {
  getCurrentSlot(): Promise<bigint>;
  getMintDecimals(mint: string): Promise<number>;
  getTokenProgram(mint: string): Promise<TokenProgram>;
};

function required(flags: Flags, name: ValueFlag, flag: string): string {
  const value = flags[name]?.trim();
  if (!value) throw new Error(`Pass ${flag}`);
  return value;
}

function wholeNumber(value: string, flag: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${flag} must be a whole number`);
  return Number(value);
}

/** Solana CLI keypair file: a JSON array of 64 bytes. The secret is never printed. */
function readKeypairFile(path: string): Keypair {
  let values: unknown;
  try {
    values = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Keypair file must be a Solana CLI JSON keypair");
  }
  if (
    !Array.isArray(values)
    || values.length !== 64
    || !values.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
  ) {
    throw new Error("Keypair file must be a Solana CLI JSON keypair");
  }
  try {
    return Keypair.fromSecretKey(Uint8Array.from(values as number[]));
  } catch {
    throw new Error("Keypair file must be a Solana CLI JSON keypair");
  }
}

async function runRequestCommand(
  role: "vendor" | "grantee",
  flags: Flags,
  env: Env,
  deps: RequestCommandDependencies,
): Promise<number> {
  const keypairPath = required(flags, "keypair", "--keypair <file>");
  const mint = address(required(flags, "mint", "--mint <mint>"));
  const recipient = role === "vendor" ? address(required(flags, "recipient", "--recipient <addr>")) : undefined;
  const agent = role === "grantee" ? address(required(flags, "agent", "--agent <addr>")) : undefined;
  const total = required(flags, "total", "--total <amount>");
  const perPayment = role === "vendor"
    ? required(flags, "perPayment", "--per-payment <amount>")
    : flags.perPayment?.trim();
  const days = wholeNumber(required(flags, "days", "--days <n>"), "--days");
  const linkValidDays = flags.linkDays === undefined ? undefined : wholeNumber(flags.linkDays, "--link-days");
  const description = required(flags, "description", "--description <text>");
  if (flags.tokenProgram && flags.tokenProgram !== "spl-token" && flags.tokenProgram !== "token-2022") {
    throw new Error("--token-program must be spl-token or token-2022");
  }
  const keypair = readKeypairFile(keypairPath);
  const decimals = flags.decimals === undefined
    ? await deps.getMintDecimals(mint)
    : wholeNumber(flags.decimals, "--decimals");
  const tokenProgram = (flags.tokenProgram as TokenProgram | undefined) ?? await deps.getTokenProgram(mint);
  const currentSlot = await deps.getCurrentSlot();
  const totalUnits = parseHumanTokenAmount(total, decimals);
  const payload = buildMandateRequestPayload({
    role,
    requester: keypair.publicKey.toBase58(),
    ...(flags.name ? { requesterName: flags.name } : {}),
    ...(agent ? { agent } : {}),
    ...(recipient ? { recipient } : {}),
    mint,
    tokenProgram,
    total: totalUnits,
    ...(perPayment ? { maxPerPayment: parseHumanTokenAmount(perPayment, decimals) } : {}),
    decimals,
    currentSlot,
    days,
    ...(linkValidDays === undefined ? {} : { linkValidDays }),
    description,
    ...(flags.po ? { poNumber: flags.po } : {}),
  });
  const signed = await signMandateRequest(payload, keypair.secretKey);
  const appUrl = flags.appUrl ?? env.CHAINPAY_APP_URL?.trim() ?? DEFAULT_APP_URL;
  const link = encodeMandateRequestLink(signed, appUrl || DEFAULT_APP_URL);
  const summary = mandateRequestSummary(signed.payload, currentSlot);
  print(
    { link, summary, request: signed },
    `${link}\n\n${summary}\nDays are estimated from 400 ms slots. Nothing moves until the owner signs a mandate.`,
    flags.json,
  );
  return 0;
}

export async function runChainPayCli(
  argv: string[],
  env: Env = process.env,
  requestDeps?: RequestCommandDependencies,
): Promise<number> {
  const { command, positional, flags } = parseArgs(argv);
  if (flags.help || command === "help" || command === "") {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const appUrl = env.CHAINPAY_APP_URL;
  const client = clientFrom(flags, env);

  if (command === "request-mandate" || command === "request-budget") {
    const deps: RequestCommandDependencies = requestDeps ?? {
      getCurrentSlot: () => client.getCurrentSlot(),
      getMintDecimals: (mint) => client.getMintDecimals(mint),
      getTokenProgram: (mint) => client.getTokenProgram(mint),
    };
    return runRequestCommand(command === "request-mandate" ? "vendor" : "grantee", flags, env, deps);
  }

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

  if (command === "export") {
    const owner = ownerFrom(flags, env);
    const { csv, rowCount } = await exportReceiptsCsv(client, {
      owner,
      mandateFilter: mandateFilterFrom(flags),
      appUrl,
    });
    if (flags.out) {
      await writeFile(flags.out, csv, "utf8");
      process.stderr.write(`Wrote ${rowCount} ${rowCount === 1 ? "receipt" : "receipts"} to ${flags.out}\n`);
    } else {
      process.stdout.write(csv);
    }
    return 0;
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
