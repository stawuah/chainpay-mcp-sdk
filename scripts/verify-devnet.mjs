import { execFileSync } from "node:child_process";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  ChainPayClient,
  SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  deriveAssetAddress,
  inspectTokenCapabilities,
} from "../sdk/dist/index.js";

const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const DEFAULT_PROGRAM_ID = "3H9TV1EPR2BAQgVmcMqpufiZKPXbAMnjHp13LA9Lndv4";
const DEFAULT_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const DEFAULT_PYUSD_MINT = "CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM";
const DEFAULT_EURC_MINT = "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr";
const DEFAULT_USDG_MINT = "4F6PM96JJxngmHnZLBh9n58RH4aTVNWvDs2nuwrT5BP7";
const DEFAULT_USDC_PAYMENT = "6vvJgRXdneFkrqxgvedbkCCGqw4SUqTLvYcEgHsKnbzfZX28uWmQrt3U6ToJGmByf7AxK224Uxz8jSczAVi8x7D";
const DEFAULT_PYUSD_PAYMENT = "3yRhnwna13r5SDUsBf2LJdgqGRro7XAGZtaPHbAARfMLbCmQyFS8BWXdyK6qdtpZ48mpc2srvt2UU7LZ63vBLc7";

const rpcUrl = process.env.CHAINPAY_RPC_URL ?? "https://api.devnet.solana.com";
const programId = process.env.CHAINPAY_PROGRAM_ID ?? DEFAULT_PROGRAM_ID;
const usdcMint = process.env.CHAINPAY_USDC_MINT ?? DEFAULT_USDC_MINT;
const pyusdMint = process.env.CHAINPAY_TOKEN_2022_MINT ?? DEFAULT_PYUSD_MINT;
const eurcMint = process.env.CHAINPAY_EURC_MINT ?? DEFAULT_EURC_MINT;
const usdgMint = process.env.CHAINPAY_USDG_MINT ?? DEFAULT_USDG_MINT;
const usdcPayment = process.env.CHAINPAY_USDC_BASELINE_SIGNATURE ?? DEFAULT_USDC_PAYMENT;
const pyusdPayment = process.env.CHAINPAY_PYUSD_BASELINE_SIGNATURE ?? DEFAULT_PYUSD_PAYMENT;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function publicKey(value, label) {
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`${label} is not a valid Solana address: ${value}`);
  }
}

function readToken2022Extensions(mintAddress, label) {
  let output;
  try {
    output = execFileSync("spl-token", [
      "--program-id",
      TOKEN_2022_PROGRAM_ID,
      "display",
      mintAddress,
      "--url",
      rpcUrl,
      "--output",
      "json",
    ], {
      encoding: "utf8",
      env: { ...process.env, NO_DNA: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error
      ? String(error.stderr).trim()
      : "";
    throw new Error(`Could not inspect ${label} Token-2022 extensions with spl-token${stderr ? `: ${stderr}` : ""}`);
  }

  const mint = JSON.parse(output);
  const extensions = Array.isArray(mint.extensions) ? mint.extensions : [];
  const byName = new Map(extensions.map((extension) => [extension.extension, extension.state]));
  const transferFee = byName.get("transferFeeConfig");
  const transferHook = byName.get("transferHook");
  assert(transferFee, `${label} transferFeeConfig extension is missing`);
  assert(transferHook, `${label} transferHook extension is missing`);
  assert(transferFee.olderTransferFee?.transferFeeBasisPoints === 0, `${label} older transfer fee is no longer zero`);
  assert(transferFee.newerTransferFee?.transferFeeBasisPoints === 0, `${label} newer transfer fee is no longer zero`);
  assert(transferFee.olderTransferFee?.maximumFee === 0, `${label} older maximum transfer fee is no longer zero`);
  assert(transferFee.newerTransferFee?.maximumFee === 0, `${label} newer maximum transfer fee is no longer zero`);
  assert(transferHook.programId === null, `${label} now has an active transfer-hook program and requires resolved extra accounts`);
  return extensions.map((extension) => extension.extension);
}

async function verifyPayment(connection, signature, mint, tokenProgram, label) {
  const transaction = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  assert(transaction, `${label} baseline transaction was not found`);
  assert(transaction.meta?.err === null, `${label} baseline transaction failed`);
  assert(
    transaction.meta?.logMessages?.some((line) => line.includes("Instruction: ExecutePayment")),
    `${label} baseline is not a ChainPay execute_payment transaction`,
  );
  assert(
    transaction.meta?.logMessages?.some((line) => line.includes(`Program ${tokenProgram} success`)),
    `${label} baseline did not complete through the expected token program`,
  );
  assert(
    transaction.meta?.postTokenBalances?.some((balance) => balance.mint === mint),
    `${label} baseline does not contain the expected mint balance change`,
  );
  const accountKeys = transaction.transaction.message.getAccountKeys({
    accountKeysFromLookups: transaction.meta?.loadedAddresses,
  });
  const paymentInstruction = transaction.transaction.message.compiledInstructions.find(
    (instruction) => accountKeys.get(instruction.programIdIndex)?.toBase58() === programId,
  );
  assert(paymentInstruction, `${label} baseline is missing the ChainPay instruction`);
  assert(paymentInstruction.accountKeyIndexes.length >= 9, `${label} ChainPay instruction account list is truncated`);
  const sourceTokenAccount = accountKeys.get(paymentInstruction.accountKeyIndexes[6])?.toBase58();
  const recipientTokenAccount = accountKeys.get(paymentInstruction.accountKeyIndexes[7])?.toBase58();
  assert(sourceTokenAccount, `${label} source token account could not be resolved`);
  assert(recipientTokenAccount, `${label} recipient token account could not be resolved`);
  const capabilityProfile = await inspectTokenCapabilities(connection, {
    mint,
    sourceTokenAccount,
    recipientTokenAccount,
    tokenProgram: tokenProgram === TOKEN_2022_PROGRAM_ID ? "token-2022" : "spl-token",
    commitment: "confirmed",
  });
  assert(capabilityProfile.compatible, `${label} capability scan failed: ${capabilityProfile.blockers.join("; ")}`);
  if (tokenProgram === TOKEN_2022_PROGRAM_ID) {
    assert(capabilityProfile.transferFee?.basisPoints === 0, `${label} capability scan found a non-zero transfer fee`);
    assert(capabilityProfile.transferFee?.maximumFee === 0n, `${label} capability scan found a non-zero maximum fee`);
    assert(capabilityProfile.transferHookProgram === undefined, `${label} capability scan found an active transfer hook`);
  }
  return {
    signature,
    slot: transaction.slot,
    blockTime: transaction.blockTime,
    computeUnitsConsumed: transaction.meta?.computeUnitsConsumed,
    sourceTokenAccount,
    recipientTokenAccount,
    capabilityProfile,
  };
}

const connection = new Connection(rpcUrl, "confirmed");
const client = new ChainPayClient({ rpcUrl, programId, commitment: "confirmed" });
const genesisHash = await connection.getGenesisHash();
assert(genesisHash === DEVNET_GENESIS_HASH, `Refusing non-Devnet RPC with genesis hash ${genesisHash}`);

const programKey = publicKey(programId, "CHAINPAY_PROGRAM_ID");
const usdcKey = publicKey(usdcMint, "CHAINPAY_USDC_MINT");
const pyusdKey = publicKey(pyusdMint, "CHAINPAY_TOKEN_2022_MINT");
const eurcKey = publicKey(eurcMint, "CHAINPAY_EURC_MINT");
const usdgKey = publicKey(usdgMint, "CHAINPAY_USDG_MINT");
const usdcAssetAddress = deriveAssetAddress(usdcMint, programId);
const pyusdAssetAddress = deriveAssetAddress(pyusdMint, programId);
const eurcAssetAddress = deriveAssetAddress(eurcMint, programId);
const usdgAssetAddress = deriveAssetAddress(usdgMint, programId);
const accounts = await connection.getMultipleAccountsInfo([
  programKey,
  usdcKey,
  pyusdKey,
  eurcKey,
  usdgKey,
  publicKey(usdcAssetAddress, "USDC asset PDA"),
  publicKey(pyusdAssetAddress, "PYUSD asset PDA"),
  publicKey(eurcAssetAddress, "EURC asset PDA"),
  publicKey(usdgAssetAddress, "USDG asset PDA"),
], "confirmed");

const [
  programAccount,
  usdcMintAccount,
  pyusdMintAccount,
  eurcMintAccount,
  usdgMintAccount,
  usdcAssetAccount,
  pyusdAssetAccount,
  eurcAssetAccount,
  usdgAssetAccount,
] = accounts;
assert(programAccount?.executable, "ChainPay program is not executable on Devnet");
assert(usdcMintAccount?.owner.toBase58() === SPL_TOKEN_PROGRAM_ID, "USDC mint is not owned by classic SPL Token");
assert(pyusdMintAccount?.owner.toBase58() === TOKEN_2022_PROGRAM_ID, "PYUSD mint is not owned by Token-2022");
assert(eurcMintAccount?.owner.toBase58() === SPL_TOKEN_PROGRAM_ID, "EURC mint is not owned by classic SPL Token");
assert(usdgMintAccount?.owner.toBase58() === TOKEN_2022_PROGRAM_ID, "USDG mint is not owned by Token-2022");
assert(usdcAssetAccount?.owner.equals(programKey), "USDC asset PDA is missing or has the wrong owner");
assert(pyusdAssetAccount?.owner.equals(programKey), "PYUSD asset PDA is missing or has the wrong owner");
assert(eurcAssetAccount?.owner.equals(programKey), "EURC asset PDA is missing or has the wrong owner");
assert(usdgAssetAccount?.owner.equals(programKey), "USDG asset PDA is missing or has the wrong owner");

const [config, usdcAsset, pyusdAsset, eurcAsset, usdgAsset, usdcBaseline, pyusdBaseline] = await Promise.all([
  client.getConfig(),
  client.getSupportedAsset(usdcMint),
  client.getSupportedAsset(pyusdMint),
  client.getSupportedAsset(eurcMint),
  client.getSupportedAsset(usdgMint),
  verifyPayment(connection, usdcPayment, usdcMint, SPL_TOKEN_PROGRAM_ID, "USDC"),
  verifyPayment(connection, pyusdPayment, pyusdMint, TOKEN_2022_PROGRAM_ID, "PYUSD"),
]);

assert(config, "ChainPay config PDA is missing");
assert(usdcAsset?.enabled, "USDC asset is not enabled");
assert(usdcAsset.mint === usdcMint, "USDC asset PDA contains the wrong mint");
assert(usdcAsset.tokenProgram === SPL_TOKEN_PROGRAM_ID, "USDC asset is bound to the wrong token program");
assert(pyusdAsset?.enabled, "PYUSD asset is not enabled");
assert(pyusdAsset.mint === pyusdMint, "PYUSD asset PDA contains the wrong mint");
assert(pyusdAsset.tokenProgram === TOKEN_2022_PROGRAM_ID, "PYUSD asset is bound to the wrong token program");
assert(eurcAsset?.enabled, "EURC asset is not enabled");
assert(eurcAsset.mint === eurcMint, "EURC asset PDA contains the wrong mint");
assert(eurcAsset.tokenProgram === SPL_TOKEN_PROGRAM_ID, "EURC asset is bound to the wrong token program");
assert(usdgAsset?.enabled, "USDG asset is not enabled");
assert(usdgAsset.mint === usdgMint, "USDG asset PDA contains the wrong mint");
assert(usdgAsset.tokenProgram === TOKEN_2022_PROGRAM_ID, "USDG asset is bound to the wrong token program");

const pyusdExtensions = readToken2022Extensions(pyusdMint, "PYUSD");
const usdgExtensions = readToken2022Extensions(usdgMint, "USDG");
console.log(JSON.stringify({
  verified: true,
  cluster: "devnet",
  rpcUrl,
  genesisHash,
  programId,
  config: config.address,
  assets: {
    usdc: { ...usdcAsset, baseline: usdcBaseline },
    pyusd: { ...pyusdAsset, extensions: pyusdExtensions, baseline: pyusdBaseline },
    eurc: { ...eurcAsset, acceptance: "registry_and_mint_only" },
    usdg: { ...usdgAsset, extensions: usdgExtensions, acceptance: "registry_and_mint_only" },
  },
}, (_key, value) => typeof value === "bigint" ? value.toString() : value, 2));
