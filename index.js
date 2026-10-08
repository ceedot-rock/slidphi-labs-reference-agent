// Slid Phi Labs Reference Agent — Node.js
// Env vars required: RIDER_MERCHANT_KEY, SOLANA_WALLET_KEY (JSON array of bytes)
// Run: node index.js

import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, createTransferInstruction } from "@solana/spl-token";

const MERCHANT_KEY = process.env.RIDER_MERCHANT_KEY;
const WALLET_KEY   = JSON.parse(process.env.SOLANA_WALLET_KEY); // Uint8Array

async function buyRiderSeat() {
  // 1. Discover catalog
  const { payment_rails } = await fetch(
    "https://www.slidphilabs.com/api/x402-products"
  ).then(r => r.json());

  // 2. Request product, expect 402
  const challengeRes = await fetch("https://www.slidphilabs.com/api/x402-products", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sku: "rider-solo" }),
  });
  if (challengeRes.status !== 402) throw new Error("Expected 402");
  const challenge = await challengeRes.json();

  // 3. Settle on Solana
  const connection = new Connection("https://api.mainnet-beta.solana.com");
  const payer = Keypair.fromSecretKey(Uint8Array.from(WALLET_KEY));
  const rail  = challenge.payment_rails.find(r => r.chain === "solana");
  const mint  = new PublicKey(rail.asset);
  const dest  = new PublicKey(rail.payTo);

  const senderATA = await getOrCreateAssociatedTokenAccount(connection, payer, mint, payer.publicKey);
  const destATA   = await getOrCreateAssociatedTokenAccount(connection, payer, mint, dest, true);

  const tx = new Transaction().add(
    createTransferInstruction(senderATA.address, destATA.address, payer.publicKey, BigInt(rail.amount ?? challenge.amount))
  );
  const sig = await connection.sendTransaction(tx, [payer]);
  await connection.confirmTransaction(sig, "confirmed");

  const proof = {
    scheme: "exact",
    network: rail.network,
    txSignature: sig,
    asset: rail.asset,
    payTo: rail.payTo,
    amount: challenge.amount,
  };

  // 4. Retry with proof
  const paidRes = await fetch("https://www.slidphilabs.com/api/x402-products", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-PAYMENT": Buffer.from(JSON.stringify(proof)).toString("base64"),
    },
    body: JSON.stringify({ sku: "rider-solo" }),
  });
  if (!paidRes.ok) throw new Error(`Payment rejected: ${await paidRes.text()}`);

  const { claim_token } = await paidRes.json();
  return claim_token;
}

async function issueRider(merchantKey, agentId) {
  const res = await fetch("https://agentrider.fly.dev/api/rider/issue", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Merchant-Key": merchantKey,
    },
    body: JSON.stringify({ agent_id: agentId, operator_id: "my-fleet", level: "L2" }),
  });
  return res.json(); // { rider, expires_in }
}

// Entry point
(async () => {
  const claimToken = await buyRiderSeat();
  console.log("Seat active, claim token:", claimToken.slice(0, 12) + "...");

  const { rider, expires_in } = await issueRider(MERCHANT_KEY, "agent-001");
  console.log(`Rider issued, expires in ${expires_in}s`);

  // Your agent loop here — refresh `rider` before expires_in seconds
})();
