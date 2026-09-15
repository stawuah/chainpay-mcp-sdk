import { createPrivateKey, sign } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, Transaction, SystemProgram } from "@solana/web3.js";
import { getTransactionEncoder } from "@solana/transactions";
import { getCompiledTransactionMessageEncoder } from "@solana/transaction-messages";
import { decodeSupportedTransaction, verifyPaymentRequest } from "../dist/index.js";

test("official read codec decodes signed legacy and real v1 wire layouts",()=>{
  const signer=Keypair.generate();
  const legacy=new Transaction({feePayer:signer.publicKey,recentBlockhash:Keypair.generate().publicKey.toBase58()}).add(SystemProgram.transfer({fromPubkey:signer.publicKey,toPubkey:Keypair.generate().publicKey,lamports:1}));
  legacy.sign(signer);
  assert.equal(decodeSupportedTransaction(legacy.serialize()).message.version,"legacy");
  const message={version:1,header:{numSignerAccounts:1,numReadonlySignerAccounts:0,numReadonlyNonSignerAccounts:1},configMask:12,configValues:[{kind:"u32",value:200000},{kind:"u32",value:1000000}],lifetimeToken:Keypair.generate().publicKey.toBase58(),numInstructions:1,numStaticAccounts:2,staticAccounts:[signer.publicKey.toBase58(),SystemProgram.programId.toBase58()],instructionHeaders:[{numInstructionAccounts:1,numInstructionDataBytes:2,programAccountIndex:1}],instructionPayloads:[{instructionAccountIndices:[0],instructionData:new Uint8Array([1,2])}]};
  const messageBytes=getCompiledTransactionMessageEncoder().encode(message);
  const privateKey=createPrivateKey({key:Buffer.concat([Buffer.from("302e020100300506032b657004220420","hex"),Buffer.from(signer.secretKey.subarray(0,32))]),format:"der",type:"pkcs8"});
  const signature=sign(null,messageBytes,privateKey);
  const bytes=getTransactionEncoder().encode({messageBytes,signatures:{[signer.publicKey.toBase58()]:signature}});
  const result=decodeSupportedTransaction(bytes);
  assert.equal(result.message.version,1);
  assert.deepEqual(result.message.staticAccounts,message.staticAccounts);
  assert.throws(()=>decodeSupportedTransaction(bytes.slice(0,-1)));
  assert.throws(()=>decodeSupportedTransaction(new Uint8Array([...bytes,0])));
  assert.throws(()=>decodeSupportedTransaction(new Uint8Array(4097)));
});
test("rejects original unsupported payment-request version before canonicalizing",async()=>{
  const result=await verifyPaymentRequest({payload:{version:2},signature:""});
  assert.equal(result.valid,false);
  assert.match(result.reason,/Unsupported payment request version/);
});
