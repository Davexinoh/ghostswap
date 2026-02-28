# GhostSwap 👻

A peer-to-peer intent-matching swap app built on [IntercomSwap](https://github.com/TracSystems/intercom-swap) — the Trac Network stack for autonomous agents.

> This app is based on upstream IntercomSwap: https://github.com/TracSystems/intercom-swap

Think of it as **Tinder for crypto trades**. You broadcast what you want to swap, and GhostSwap automatically finds a matching peer on the network and connects you both into a private swap room.

No orderbooks. No middlemen. No centralized exchange. Just peer-to-peer intent matching.

---

## How it works

1. **Broadcast your intent** — post what you want to swap (e.g. 100 USDT → SOL)
2. **Network scans for a match** — GhostSwap listens for the opposite intent on the sidechannel
3. **Private room opens** — when a match is found, both peers are connected into an invite-only swap channel
4. **Trade happens** — peers coordinate the swap directly, peer to peer

---

## What it does

- **Post intent** — broadcast your swap intent to the `ghostswap` sidechannel
- **List intents** — see all open swap intents on the network
- **Auto-match** — automatically detect a matching counterparty
- **Connect** — open a private P2P channel with your match
- **Cancel** — withdraw an open intent

---

## Install

```bash
git clone https://github.com/Davexinoh/ghostswap
cd ghostswap
npm install
Requires Pear Runtime and Node.js 20+.
Bootstrap (first time only):
bash scripts/bootstrap.sh
Run
node index.js
Commands available in the interactive prompt:
Command
Description
post <amount> <fromToken> for <toToken>
Broadcast a swap intent
list
List all open intents
cancel <intentId>
Cancel your intent
help
Show available commands
exit
Quit
Example
ghostswap> post 100 USDT for SOL
✅ Intent posted [a1b2c3]: "100 USDT → SOL"

ghostswap> list
─── Open Intents ─────────────────────────────
  ○ [a1b2c3] 100 USDT → SOL  (you)
  ○ [d4e5f6] 50 SOL → USDT   (peer: 7f99a4...)
  🔥 MATCH FOUND! Connecting to peer...
─────────────────────────────────────────────
Architecture
GhostSwap uses a shared IntercomSwap sidechannel (ghostswap) as a broadcast bus for swap intents. Each peer:
Joins the ghostswap sidechannel on startup
Broadcasts signed intent messages
Scans incoming intents for matches against its own open intents
On match — opens an invite-only private channel for the trade
Message kinds:
intent.post — new swap intent broadcast
intent.cancel — intent withdrawal
intent.match — match notification sent to counterparty
intent.ack — match acknowledgement
Skill file
See SKILL.md for agent instructions.
Trac Address
trac13davzpd3yervezs8zzvszu2dx8pap2nmqgqm7aets0lap60wjlzq335rrp
