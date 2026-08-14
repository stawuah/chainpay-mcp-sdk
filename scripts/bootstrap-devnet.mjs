import { readFileSync } from "node:fs";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { ChainPayClient, deriveAssetAddress, deriveConfigAddress, toWeb3Transaction, tokenProgramAddress } from "../sdk/dist/index.js";

const RPC_URL = process.env.CHAINPAY_RPC_URL ?? "https://api.devnet.solana.com";
const PROGRAM_ID = process.env.CHAINPAY_PROGRAM_ID ?? "3H9TV1EPR2BAQgVmcMqpufiZKPXbAMnjHp13LA9Lndv4";
const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const DEVNET_PYUSD_TOKEN_2022_MINT = "CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM";
const TOKEN_2022_MINT = process.env.CHAINPAY_TOKEN_2022_MINT ?? DEVNET_PYUSD_TOKEN_2022_MINT;
const KEYPAIR_PATH = process.env.CHAINPAY_KEYPAIR ?? process.env.ANCHOR_WALLET;
const DEFAULT_ADDRESS = PublicKey.default;
const TOKEN_2022_PROGRAM = new PublicKey(tokenProgramAddress("token-2022"));
const SPL_TOKEN_PROGRAM = new PublicKey(tokenProgramAddress("spl-token"));

if (!KEYPAIR_PATH) {
  throw new Error("Set CHAINPAY_KEYPAIR to the Devnet authority keypair path before running this script.");
}
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEYPAIR_PATH, "utf8"))));
const connection = new (await import("@solana/web3.js")).Connection(RPC_URL, "confirmed");
const programId = new PublicKey(PROGRAM_ID);
const chainpay = new ChainPayClient({ rpcUrl: RPC_URL, programId: PROGRAM_ID, commitment: "confirmed" });
const configAddress = new PublicKey(deriveConfigAddress(PROGRAM_ID));

function pubkey(value, label) {
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`${label} is not a valid Solana address: ${value}`);
  }
}

async function simulateAndSend(transaction, signers, label) {
  const latest = await connection.getLatestBlockhash("confirmed");
  transaction.feePayer = payer.publicKey;
  transaction.recentBlockhash = latest.blockhash;
  transaction.sign(...signers);
  const simulation = await connection.simulateTransaction(transaction, signers);
  if (simulation.value.err) {
    throw new Error(`${label} simulation failed: ${JSON.stringify(simulation.value.err)}\n${(simulation.value.logs ?? []).join("\n")}`);
  }
  console.log(`${label}: simulation passed${simulation.value.unitsConsumed ? ` (${simulation.value.unitsConsumed} units)` : ""}`);
  const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true });
  await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  console.log(`${label}: ${signature}`);
  return signature;
}

async function assertMint(mintAddress, expectedProgram, label) {
  const mint = pubkey(mintAddress, label);
  const account = await connection.getAccountInfo(mint, "confirmed");
  if (!account) throw new Error(`${label} does not exist on ${RPC_URL}: ${mint.toBase58()}`);
  if (!account.owner.equals(expectedProgram)) {
    throw new Error(`${label} is owned by ${account.owner.toBase58()}, expected ${expectedProgram.toBase58()}`);
  }
  return mint;
}

async function createToken2022Mint() {
  return assertMint(TOKEN_2022_MINT, TOKEN_2022_PROGRAM, "CHAINPAY_TOKEN_2022_MINT");
}

async function registerAssetIfNeeded(mint, tokenProgram, instructions) {
  const assetAddress = new PublicKey(deriveAssetAddress(mint.toBase58(), PROGRAM_ID));
  const account = await connection.getAccountInfo(assetAddress, "confirmed");
  if (!account) {
    instructions.push(chainpay.buildRegisterAsset(mint.toBase58(), tokenProgram, payer.publicKey.toBase58()).instructions[0]);
    return { address: assetAddress, action: "register" };
  }

  const asset = await chainpay.getSupportedAsset(mint.toBase58());
  if (!asset) throw new Error(`Asset PDA exists but could not be decoded: ${assetAddress.toBase58()}`);
  if (!asset.enabled) throw new Error(`Asset is registered but disabled: ${mint.toBase58()}`);
  if (asset.authority !== payer.publicKey.toBase58()) {
    throw new Error(`Asset ${mint.toBase58()} belongs to authority ${asset.authority}, not the bootstrap signer.`);
  }
  if (asset.tokenProgram !== tokenProgramAddress(tokenProgram)) {
    throw new Error(`Asset ${mint.toBase58()} is bound to the wrong token program.`);
  }
  return { address: assetAddress, action: "already registered" };
}

const programAccount = await connection.getAccountInfo(programId, "confirmed");
if (!programAccount?.executable) {
  throw new Error(`ChainPay program is not executable at ${programId.toBase58()} on ${RPC_URL}.`);
}

const usdcMint = await assertMint(USDC_MINT, SPL_TOKEN_PROGRAM, "Devnet USDC mint");
const existingConfig = await connection.getAccountInfo(configAddress, "confirmed");
const pendingProtocolInstructions = [];

if (!existingConfig) {
  pendingProtocolInstructions.push(
    chainpay.buildInitializeConfig(
      [usdcMint.toBase58(), DEFAULT_ADDRESS.toBase58(), DEFAULT_ADDRESS.toBase58()],
      payer.publicKey.toBase58(),
    ).instructions[0],
  );
  console.log(`config: initialize ${configAddress.toBase58()}`);
} else {
  const config = await chainpay.getConfig();
  if (!config) throw new Error(`Config PDA exists but could not be decoded: ${configAddress.toBase58()}`);
  if (config.authority !== payer.publicKey.toBase58()) {
    throw new Error(`Config authority is ${config.authority}; use that authority keypair to register assets.`);
  }
  if (!config.supportedMints.includes(usdcMint.toBase58())) {
    throw new Error(`Existing config does not include Devnet USDC ${usdcMint.toBase58()}; refusing to silently change protocol policy.`);
  }
  console.log(`config: already initialized ${configAddress.toBase58()}`);
}

const usdcAsset = await registerAssetIfNeeded(usdcMint, "spl-token", pendingProtocolInstructions);
if (pendingProtocolInstructions.length > 0) {
  const prepared = {
    instructions: pendingProtocolInstructions,
    requiredSigners: [payer.publicKey.toBase58()],
    feePayer: payer.publicKey.toBase58(),
  };
  const latest = await connection.getLatestBlockhash("confirmed");
  const transaction = toWeb3Transaction(prepared, latest.blockhash);
  await simulateAndSend(transaction, [payer], "initialize config and register Devnet USDC");
} else {
  console.log(`USDC asset: ${usdcAsset.action} ${usdcAsset.address.toBase58()}`);
}

const token2022Mint = await createToken2022Mint();
const pendingToken2022 = [];
const token2022Asset = await registerAssetIfNeeded(token2022Mint, "token-2022", pendingToken2022);
if (pendingToken2022.length > 0) {
  const prepared = {
    instructions: pendingToken2022,
    requiredSigners: [payer.publicKey.toBase58()],
    feePayer: payer.publicKey.toBase58(),
  };
  const latest = await connection.getLatestBlockhash("confirmed");
  const transaction = toWeb3Transaction(prepared, latest.blockhash);
  await simulateAndSend(transaction, [payer], "register Token-2022 asset");
} else {
  console.log(`Token-2022 asset: ${token2022Asset.action} ${token2022Asset.address.toBase58()}`);
}

const finalConfig = await chainpay.getConfig();
const finalUsdc = await chainpay.getSupportedAsset(usdcMint.toBase58());
const finalToken2022 = await chainpay.getSupportedAsset(token2022Mint.toBase58());
if (!finalConfig || !finalUsdc?.enabled || !finalToken2022?.enabled) {
  throw new Error("Bootstrap verification failed: config and both enabled assets were not readable after submission.");
}

console.log(JSON.stringify({
  cluster: "devnet",
  programId: programId.toBase58(),
  authority: payer.publicKey.toBase58(),
  config: finalConfig.address,
  assets: {
    usdc: { mint: usdcMint.toBase58(), tokenProgram: finalUsdc.tokenProgram, address: finalUsdc.address },
    token2022: { mint: token2022Mint.toBase58(), tokenProgram: finalToken2022.tokenProgram, address: finalToken2022.address },
  },
}, null, 2));
