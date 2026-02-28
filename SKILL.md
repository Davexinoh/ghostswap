# GhostSwap — SKILL.md

This file is the canonical install and operations guide for GhostSwap. If you are an agent, treat this as the source of truth.

---

## What This App Does

GhostSwap is a P2P intent-matching swap app built on IntercomSwap. It uses a shared sidechannel (`ghostswap`) to broadcast swap intents and automatically match counterparties peer to peer.

Upstream IntercomSwap: https://github.com/TracSystems/intercom-swap

Supported message kinds:
- `intent.post` — broadcast a new swap intent
- `intent.cancel` — withdraw an open intent
- `intent.match` — notify a peer of a match
- `intent.ack` — acknowledge a match

---

## Requirements

- Node.js 20+
- Pear Runtime (`npm install -g pear` or see https://docs.pears.com)
- npm

---

## Install

```bash
git clone https://github.com/Davexinoh/ghostswap
cd ghostswap
npm install
bash scripts/bootstrap.sh
Run
node index.js
Agent Instructions
Start the peer:
node index.js
Post a swap intent:
post 100 USDT for SOL
List open intents:
list
Cancel your intent:
cancel <intentId>
Matching Logic
When a new intent arrives on the sidechannel, GhostSwap checks all local open intents for a mirror match:
Local intent: 100 USDT → SOL
Incoming intent: SOL → USDT
Result: MATCH — both peers are notified and a private channel opens
Match conditions:
fromToken of incoming == toToken of local
toToken of incoming == fromToken of local
Message Format
intent.post
{
  "kind": "intent.post",
  "intentId": "<uuid>",
  "fromAmount": "100",
  "fromToken": "USDT",
  "toToken": "SOL",
  "poster": "<peerPubkeyHex>",
  "postedAt": 1709000000
}
intent.cancel
{
  "kind": "intent.cancel",
  "intentId": "<uuid>",
  "cancelledBy": "<peerPubkeyHex>"
}
intent.match
{
  "kind": "intent.match",
  "intentId": "<uuid>",
  "matchedWith": "<intentId>",
  "counterparty": "<peerPubkeyHex>",
  "channel": "ghostswap:<tradeId>"
}
Sidechannel
Default sidechannel: ghostswap
Custom channel:
GHOSTSWAP_CHANNEL=my-swap-room node index.js
Trac Address
trac13davzpd3yervezs8zzvszu2dx8pap2nmqgqm7aets0lap60wjlzq335rrp
