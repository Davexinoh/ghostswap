
#!/usr/bin/env node
'use strict'

/**
 * GhostSwap — P2P intent-matching swap app on IntercomSwap/Trac Network.
 * Upstream IntercomSwap: https://github.com/TracSystems/intercom-swap
 *
 * "Tinder for crypto trades" — broadcast your swap intent,
 * auto-match with a counterparty, connect peer to peer.
 */

const Hyperswarm = require('hyperswarm')
const crypto = require('crypto')
const readline = require('readline')

const CHANNEL = process.env.GHOSTSWAP_CHANNEL || 'ghostswap'
const CHANNEL_TOPIC = crypto.createHash('sha256').update(CHANNEL).digest()

const intents = new Map()   // intentId -> intent object
const peers = new Set()
let swarm = null
let myPubkey = null

function uuid () {
  return crypto.randomBytes(6).toString('hex')
}

function now () {
  return Math.floor(Date.now() / 1000)
}

function broadcast (msg) {
  const data = Buffer.from(JSON.stringify(msg))
  for (const conn of peers) {
    try { conn.write(data) } catch (_) {}
  }
}

// ─── Matching Logic ────────────────────────────────────────────────────────
// A match occurs when an incoming intent is the mirror of a local open intent:
//   local:    100 USDT -> SOL
//   incoming: SOL -> USDT  (any amount)

function findMatch (incoming) {
  for (const local of intents.values()) {
    if (
      local.poster === myPubkey &&
      local.status === 'open' &&
      local.fromToken === incoming.toToken &&
      local.toToken === incoming.fromToken
    ) {
      return local
    }
  }
  return null
}

function applyMessage (msg) {
  if (!msg || !msg.kind) return

  if (msg.kind === 'intent.post') {
    if (!intents.has(msg.intentId)) {
      intents.set(msg.intentId, {
        intentId: msg.intentId,
        fromAmount: msg.fromAmount,
        fromToken: msg.fromToken,
        toToken: msg.toToken,
        poster: msg.poster,
        postedAt: msg.postedAt,
        status: 'open'
      })

      // Only try to match intents from other peers
      if (msg.poster !== myPubkey) {
        const match = findMatch(msg)
        if (match) {
          const tradeId = uuid()
          const matchMsg = {
            kind: 'intent.match',
            intentId: match.intentId,
            matchedWith: msg.intentId,
            counterparty: msg.poster,
            channel: `ghostswap:${tradeId}`,
            tradeId
          }
          match.status = 'matched'
          intents.get(msg.intentId).status = 'matched'
          broadcast(matchMsg)
          console.log(`\n🔥 MATCH FOUND!`)
          console.log(`   Your intent : [${match.intentId}] ${match.fromAmount} ${match.fromToken} → ${match.toToken}`)
          console.log(`   Matched with: [${msg.intentId}] ${msg.fromAmount} ${msg.fromToken} → ${msg.toToken}`)
          console.log(`   Private channel: ${matchMsg.channel}`)
          console.log(`   Connect with peer: ${msg.poster.slice(0, 16)}…\n`)
        }
      }
    }
  }

  if (msg.kind === 'intent.cancel') {
    const t = intents.get(msg.intentId)
    if (t) t.status = 'cancelled'
  }

  if (msg.kind === 'intent.match') {
    const t = intents.get(msg.intentId)
    if (t) t.status = 'matched'
    if (msg.counterparty !== myPubkey) return
    console.log(`\n👻 You've been matched!`)
    console.log(`   Intent      : [${msg.intentId}]`)
    console.log(`   Private channel: ${msg.channel}`)
    console.log(`   Trade with  : ${msg.counterparty.slice(0, 16)}…\n`)
  }
}

// ─── Commands ──────────────────────────────────────────────────────────────

function cmdPost (args) {
  // Format: post <amount> <fromToken> for <toToken>
  // Example: post 100 USDT for SOL
  const forIdx = args.indexOf('for')
  if (forIdx < 2 || !args[forIdx + 1]) {
    return console.log('Usage: post <amount> <fromToken> for <toToken>\nExample: post 100 USDT for SOL')
  }
  const fromAmount = args[0]
  const fromToken = args[1].toUpperCase()
  const toToken = args[forIdx + 1].toUpperCase()

  const msg = {
    kind: 'intent.post',
    intentId: uuid(),
    fromAmount,
    fromToken,
    toToken,
    poster: myPubkey,
    postedAt: now()
  }
  applyMessage(msg)
  broadcast(msg)
  console.log(`\n✅ Intent posted [${msg.intentId}]: ${fromAmount} ${fromToken} → ${toToken}\n`)
}

function cmdList () {
  const open = [...intents.values()].filter(i => i.status === 'open')
  if (open.length === 0) {
    console.log('\n  (no open intents — be the first to post one!)\n')
    return
  }
  console.log('\n─── Open Swap Intents ───────────────────────────')
  for (const i of open) {
    const mine = i.poster === myPubkey ? ' (you)' : ` (peer: ${i.poster.slice(0, 8)}…)`
    console.log(`  ○ [${i.intentId}] ${i.fromAmount} ${i.fromToken} → ${i.toToken}${mine}`)
  }
  console.log('─────────────────────────────────────────────────\n')
}

function cmdCancel (args) {
  const intentId = args[0]
  if (!intentId) return console.log('Usage: cancel <intentId>')
  const t = intents.get(intentId)
  if (!t) return console.log(`Intent ${intentId} not found.`)
  if (t.poster !== myPubkey) return console.log(`You can only cancel your own intents.`)
  if (t.status !== 'open') return console.log(`Intent ${intentId} is already ${t.status}.`)
  const msg = { kind: 'intent.cancel', intentId, cancelledBy: myPubkey }
  applyMessage(msg)
  broadcast(msg)
  console.log(`\n❌ Intent cancelled [${intentId}]\n`)
}

function cmdHelp () {
  console.log(`
  Commands:
    post <amount> <fromToken> for <toToken>   Broadcast a swap intent
    list                                      List all open intents
    cancel <intentId>                         Cancel your intent
    help                                      Show this help
    exit                                      Quit

  Examples:
    post 100 USDT for SOL
    post 2 SOL for USDT
    list
    cancel a1b2c3
`)
}

// ─── Network ───────────────────────────────────────────────────────────────

async function start () {
  swarm = new Hyperswarm()
  myPubkey = swarm.keyPair.publicKey.toString('hex')

  swarm.on('connection', (conn) => {
    peers.add(conn)
    conn.on('data', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        applyMessage(msg)
      } catch (_) {}
    })
    conn.on('close', () => peers.delete(conn))
    conn.on('error', () => peers.delete(conn))
  })

  await swarm.join(CHANNEL_TOPIC, { server: true, client: true })
  await swarm.flush()

  console.log(`
╔══════════════════════════════════════════╗
║         GhostSwap  👻                   ║
║   P2P Intent Matching on IntercomSwap   ║
╚══════════════════════════════════════════╝

  Channel : ${CHANNEL}
  Peer ID : ${myPubkey.slice(0, 16)}…
  Peers   : ${peers.size} connected

  Type "help" for commands.
  Example : post 100 USDT for SOL
`)

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'ghostswap> '
  })
  rl.prompt()

  rl.on('line', (line) => {
    const parts = line.trim().split(/\s+/)
    const cmd = parts[0]
    const args = parts.slice(1)
    switch (cmd) {
      case 'post':   cmdPost(args);   break
      case 'list':   cmdList();       break
      case 'cancel': cmdCancel(args); break
      case 'help':   cmdHelp();       break
      case 'exit':
        console.log('Goodbye 👋')
        swarm.destroy().then(() => process.exit(0))
        return
      case '': break
      default:
        console.log(`Unknown command: "${cmd}". Type "help".`)
    }
    rl.prompt()
  })

  rl.on('close', () => {
    swarm.destroy().then(() => process.exit(0))
  })
}

start().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
