# Slid Phi Labs Reference Agent — Python
# Env vars required: RIDER_MERCHANT_KEY
# Run: python agent.py

import os
import json
import base64
import requests
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
