# Slid Phi Labs Reference Agent

**A working integration showing how an AI agent authenticates via Agent-Rider, then pays for a service over the x402 rail using AwLPay.**

Clone it. Swap in your use case. Ship.

---

## What this covers

1. Acquire a signed Agent-Rider credential (ES256 JWT, 15-minute lifespan)
2. Attach that credential to outbound requests via `X-Agent-Rider`
3. Hit a Slid Phi Labs endpoint and receive an HTTP 402 payment challenge
4. Parse the payment instructions and settle in USDC (Solana or Base)
5. Retry with the `X-PAYMENT` proof header and receive the claim token
6. Use the claim token as a Bearer credential for authenticated access

Everything runs over plain HTTP. No browser, no account, no human in the loop.

---

## Prerequisites

- A Rider seat (Solo starts at $13.31/mo — `POST /api/x402-products` with `sku: rider-solo` to buy via x402, or human checkout at `https://www.slidphilabs.com/pay?sku=rider-solo`)
- A funded Solana or Base wallet holding USDC
- Node.js 18+ (or Python 3.9+ — see the Python variant below)
- The `@solana/web3.js` + `@solana/spl-token` packages (or `coinbase/coinbase-sdk` for Base)

---

## The three-step x402 flow

Every paid endpoint in the lab speaks the same protocol. Once your agent knows how to pay one endpoint, it can pay all of them.

```
Agent                          Slid Phi Labs endpoint
  |                                     |
  |---(1) POST /api/x402-products ------>|
  |           { sku: "rider-solo" }      |
  |                                     |
  |<--(2) 402 Payment Required ----------|
  |           WWW-Authenticate: x402     |
  |           Body: { payment_rails, amount, payTo, ... }
  |                                     |
  |---(3) Settle USDC on-chain           |
  |       Build EIP-712 auth / Solana tx |
  |                                     |
  |---(4) Retry with X-PAYMENT proof --->|
  |                                     |
  |<--(5) 200 OK + claim_token ----------|
  |                                     |
  |---(6) GET /access?claim=<token> ---->|
  |<--(5) Seat activated ----------------| 
```

---

## Step 1: Discover available products

No hardcoded prices. Fetch the current catalog first.

```js
const catalog = await fetch("https://www.slidphilabs.com/api/x402-products")
  .then(r => r.json());

// catalog.products — array of SKUs with name, amount_usd, kind
// catalog.payment_rails — the chains the lab accepts right now:
//   [{ scheme, network, asset, payTo, decimals, chain }, ...]
//
// Live rails (as of October 2026):
//   Solana USDC — EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
//   Base USDC   — 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
```

**Always fetch the catalog at runtime.** `payTo` addresses and amounts are authoritative here, not in this README.

---

## Step 2: Request the product and parse the 402

```js
const TARGET_SKU = "rider-solo"; // or any sku from the catalog

const res = await fetch("https://www.slidphilabs.com/api/x402-products", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ sku: TARGET_SKU }),
});

if (res.status !== 402) {
  throw new Error(`Expected 402, got ${res.status}`);
}

const challenge = await res.json();
// challenge.payment_rails — same shape as the catalog
// challenge.amount        — exact integer amount (e.g. 1331 for $13.31)
// challenge.asset         — USDC mint address
// challenge.payTo         — destination wallet address
// challenge.decimals      — 6 for USDC
```

The `402` body contains everything the agent needs to settle the payment. Nothing is inferred.

---

## Step 3a: Settle on Solana

```js
import {
  Connection, Keypair, PublicKey, Transaction
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  createTransferInstruction
} from "@solana/spl-token";

const connection = new Connection("https://api.mainnet-beta.solana.com");
const payer = Keypair.fromSecretKey(/* your wallet key bytes */);

const mint = new PublicKey(challenge.payment_rails[0].asset);
const destination = new PublicKey(challenge.payment_rails[0].payTo);

// Amount is already in the correct integer units (USDC has 6 decimals)
const amountAtoms = BigInt(challenge.amount);

const senderATA = await getOrCreateAssociatedTokenAccount(
  connection, payer, mint, payer.publicKey
);
const destATA = await getOrCreateAssociatedTokenAccount(
  connection, payer, mint, destination, true // allowOwnerOffCurve for PDA destinations
);

const tx = new Transaction().add(
  createTransferInstruction(senderATA.address, destATA.address, payer.publicKey, amountAtoms)
);
const signature = await connection.sendTransaction(tx, [payer]);
await connection.confirmTransaction(signature, "confirmed");

// Build the X-PAYMENT proof the lab expects
const proof = {
  scheme: "exact",
  network: "solana-mainnet-beta",
  txSignature: signature,
  asset: challenge.payment_rails[0].asset,
  payTo: challenge.payment_rails[0].payTo,
  amount: challenge.amount,
};
const xPaymentHeader = Buffer.from(JSON.stringify(proof)).toString("base64");
```

---

## Step 3b: Settle on Base (EIP-712 gasless auth)

```js
import { ethers } from "ethers";

const provider = new ethers.JsonRpcProvider("https://mainnet.base.org");
const wallet = new ethers.Wallet(/* your private key */, provider);

const rail = challenge.payment_rails.find(r => r.chain === "base");

// ERC-20 transfer: USDC on Base
const usdcABI = ["function transfer(address to, uint256 amount) returns (bool)"];
const usdc = new ethers.Contract(rail.asset, usdcABI, wallet);
const amount = BigInt(challenge.amount); // integer-exact, 6 decimals

const tx = await usdc.transfer(rail.payTo, amount);
const receipt = await tx.wait();

const proof = {
  scheme: "exact",
  network: "eip155:8453",
  txHash: receipt.hash,
  asset: rail.asset,
  payTo: rail.payTo,
  amount: challenge.amount,
};
const xPaymentHeader = Buffer.from(JSON.stringify(proof)).toString("base64");
```

**No float arithmetic near money.** The lab's integer-exact amounts (`decimals: 6`) mean 1331 = $13.31. Keep everything as `BigInt`.

---

## Step 4: Retry with payment proof

```js
const paid = await fetch("https://www.slidphilabs.com/api/x402-products", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-PAYMENT": xPaymentHeader,
  },
  body: JSON.stringify({ sku: TARGET_SKU }),
});

if (!paid.ok) {
  const err = await paid.json();
  throw new Error(`Payment rejected: ${JSON.stringify(err)}`);
}

const result = await paid.json();
const claimToken = result.claim_token;
// claimToken is your credential — store it, don't log it
```

---

## Step 5: Activate the seat

```js
const access = await fetch(
  `https://www.slidphilabs.com/access?claim=${claimToken}`
);
const seat = await access.json();
console.log("Seat activated:", seat);
```

---

## Step 6: Issue a Rider credential

With the seat active, the agent can issue its own signed JWT via the Agent-Rider API at `agentrider.fly.dev`.

```js
// POST /api/rider/issue — requires your merchant key
const issueRes = await fetch("https://agentrider.fly.dev/api/rider/issue", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Merchant-Key": process.env.RIDER_MERCHANT_KEY,
  },
  body: JSON.stringify({
    agent_id: "my-agent-001",       // stable identifier for this agent
    operator_id: "your-org-id",     // your fleet namespace
    level: "L2",                    // L0–L4 clearance levels
  }),
});

const { rider, expires_in } = await issueRes.json();
// rider      — signed ES256 JWT string
// expires_in — 900 (seconds; credential is valid for 15 minutes)
```

**Mint a fresh credential for each task window.** After 15 minutes the JWT expires and peers will reject it. Build a refresh loop around `expires_in`.

---

## Step 7: Attach the credential to outbound requests

```js
// Any downstream service that supports Rider verification reads this header
const response = await fetch("https://some-agent-service.example.com/api/task", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Agent-Rider": rider,
    "Authorization": `Bearer ${claimToken}`,  // for Slid Phi Labs services
  },
  body: JSON.stringify({ task: "compress", payload: myData }),
});
```

---

## Step 8: Verify a Rider credential (any gate, no auth required)

Any service receiving an `X-Agent-Rider` header can verify it for free, with no API key and no call back to the lab.

```js
// POST /api/rider/verify — no authentication required
const verifyRes = await fetch("https://agentrider.fly.dev/api/rider/verify", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ rider }),
});

const { valid, rider: claims } = await verifyRes.json();
// valid          — boolean
// claims.agent_id — the agent_id from the issuing call
// claims.level   — the clearance level (L0–L4)
```

---

## Putting it together: a minimal autonomous agent

```js
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
```

---

## Python variant

```python
import os, json, base64, requests
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.transaction import Transaction
from spl.token.client import Token
from solana.rpc.api import Client

MERCHANT_KEY = os.environ["RIDER_MERCHANT_KEY"]
BASE_URL     = "https://www.slidphilabs.com"

def buy_rider_seat(wallet: Keypair, sku="rider-solo") -> str:
    # 1. Expect 402
    r = requests.post(f"{BASE_URL}/api/x402-products", json={"sku": sku})
    assert r.status_code == 402, f"Expected 402, got {r.status_code}"
    challenge = r.json()

    # 2. Settle on Solana (pseudocode — use solders/solana-py for real txs)
    rail = next(x for x in challenge["payment_rails"] if x["chain"] == "solana")
    # ... build and send SPL token transfer ...
    sig = "<tx_signature>"

    proof = {
        "scheme": "exact",
        "network": rail["network"],
        "txSignature": sig,
        "asset": rail["asset"],
        "payTo": rail["payTo"],
        "amount": challenge["amount"],
    }

    # 3. Retry with proof
    paid = requests.post(
        f"{BASE_URL}/api/x402-products",
        headers={"X-PAYMENT": base64.b64encode(json.dumps(proof).encode()).decode()},
        json={"sku": sku},
    )
    paid.raise_for_status()
    return paid.json()["claim_token"]

def issue_rider(agent_id: str) -> dict:
    r = requests.post(
        "https://agentrider.fly.dev/api/rider/issue",
        headers={"X-Merchant-Key": MERCHANT_KEY},
        json={"agent_id": agent_id, "operator_id": "my-fleet", "level": "L2"},
    )
    r.raise_for_status()
    return r.json()  # {"rider": "eyJ...", "expires_in": 900}

if __name__ == "__main__":
    # claim_token = buy_rider_seat(my_keypair)
    creds = issue_rider("agent-001")
    print(f"Rider issued, expires in {creds['expires_in']}s")
```

---

## Error reference

| Status | Body field | Meaning | Action |
|--------|-----------|---------|--------|
| `402` | `payment_rails` | Payment required — this is expected | Parse rails and settle |
| `401` | `"invalid_claim"` | Claim token expired or malformed | Fetch a new seat |
| `400` | — | Missing or bad request body | Check `sku` spelling against the catalog |
| `200` with `claim_token` | — | Payment accepted | Store token, proceed |

**Replay protection.** Each payment proof is bound to the `proof-id` (tx signature) plus the network. Submitting the same proof twice returns a `402` rather than granting a duplicate seat.

---

## Credential refresh loop (production pattern)

```js
let riderJwt = null;
let riderExpiry = 0;

async function getValidRider(merchantKey, agentId) {
  const nowSec = Date.now() / 1000;
  // Refresh 60 seconds before expiry to avoid edge-case rejections
  if (!riderJwt || nowSec >= riderExpiry - 60) {
    const { rider, expires_in } = await issueRider(merchantKey, agentId);
    riderJwt    = rider;
    riderExpiry = nowSec + expires_in;
  }
  return riderJwt;
}
```

---

## What to build next

- **Quikgater** — pay per fetch, same protocol. Hit `https://quikgater-worker.ceedotrock.workers.dev/?url=<target>`, expect 402, pay, get the page back.
- **PCC compression** — `POST /api/x402-suite` quotes 8¢/GB after the first 2 GB/month free. Use your `claim_token` as `Authorization: Bearer <token>`.
- **Warrant** — bind a signed mandate to the Rider: allowed hosts, spend cap, expiry. Every job files a receipt. SKU `warrant-month`, $29/mo.
- **MCP tools** — the lab's full surface (32 tools) is available at `https://www.slidphilabs.com/mcp` with no signup for the first 60 req/hr.

---

## Links

- Home: https://www.slidphilabs.com
- Agent-Rider walkthrough: https://agentrider.fly.dev
- x402 rail: https://www.slidphilabs.com/x402
- AwLPay: https://www.slidphilabs.com/awlpay
- Product catalog (live JSON): https://www.slidphilabs.com/api/x402-products
- MCP server: https://www.slidphilabs.com/mcp
- GitHub: https://github.com/ceedot-rock
- Contact: corey@slidphilabs.com

---

## License

AGPL-3.0. Commercial embed grant available — see https://www.slidphilabs.com/license or email corey@slidphilabs.com.
