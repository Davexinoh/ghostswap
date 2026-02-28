#!/usr/bin/env node
'use strict'

/**
 * GhostSwap — P2P intent-matching swap app on IntercomSwap/Trac Network.
 * Upstream IntercomSwap: https://github.com/TracSystems/intercom-swap
 */

const Hyperswarm = require('hyperswarm')
const crypto = require('crypto')
const readline = require('readline')
const fs = require('fs')
const path = require('path')

const CHANNEL = process.env.GHOSTSWAP_CHANNEL || 'ghostswap'
const CHANNEL_TOPIC = crypto.createHash('sha256').update(CHANNEL).digest()
const HISTORY_FILE = path.join(__dirname, 'history.json')
const REPUTATION_FILE = path.join(__dirname, 'reputation.json')
const EXPIRY_SECONDS = 600 // 10 minutes
const isDemo = process.argv.includes('--demo')

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  whiteBold: '\x1b[1m\x1b[37m'
}

const intents = new Map()   // intentId -> intent object
const peers = new Set()
let swarm = null
let myPubkey = null
let rl = null

// ─── Persistence ───────────────────────────────────────────────────────────

function loadJSON(file, defaultVal) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {}
  return defaultVal
}

function saveJSON(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2))
  } catch (e) {}
}

let reputations = loadJSON(REPUTATION_FILE, {})

function getRep(pubkey) {
  return reputations[pubkey] || 0
}

function updateRep(pubkey, delta) {
  reputations[pubkey] = getRep(pubkey) + delta
  saveJSON(REPUTATION_FILE, reputations)
}

function addHistory(event) {
  const history = loadJSON(HISTORY_FILE, [])
  history.push({ ...event, timestamp: Date.now() })
  saveJSON(HISTORY_FILE, history.slice(-100))
}

// ─── Helpers ───────────────────────────────────────────────────────────────

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

function getPrompt() {
  const openCount = [...intents.values()].filter(i => i.status === 'open' && i.poster === myPubkey).length
  const matchedCount = [...intents.values()].filter(i => i.status === 'matched' && i.poster === myPubkey).length
  return `ghostswap [${COLORS.yellow}${openCount} open${COLORS.reset} | ${COLORS.green}${matchedCount} matched${COLORS.reset}]> `
}

function updatePrompt() {
  if (rl) {
    rl.setPrompt(getPrompt())
    rl.prompt(true)
  }
}

// ─── Matching Logic ────────────────────────────────────────────────────────

function findMatch (incoming) {
  for (const local of intents.values()) {
    if (
      (isDemo || local.poster === myPubkey) &&
      local.status === 'open' &&
      local.fromToken === incoming.toToken &&
      local.toToken === incoming.fromToken &&
      local.intentId !== incoming.intentId
    ) {
      const isExact = local.fromAmount === incoming.fromAmount
      return { match: local, partial: !isExact }
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

      if (isDemo || msg.poster !== myPubkey) {
        const result = findMatch(msg)
        if (result && !result.partial) {
          const { match } = result
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
          if (!isDemo || msg.poster !== myPubkey) broadcast(matchMsg)
          addHistory({ type: 'match', intentId: match.intentId, with: msg.intentId })
          updateRep(myPubkey, 1)
          if (msg.poster !== myPubkey) updateRep(msg.poster, 1)
          
          console.log(`\n${COLORS.green}${COLORS.bold}🔥 MATCH FOUND!${COLORS.reset}`)
          console.log(`   Your intent : [${match.intentId}] ${match.fromAmount} ${match.fromToken} → ${match.toToken}`)
          console.log(`   Matched with: [${msg.intentId}] ${msg.fromAmount} ${msg.fromToken} → ${msg.toToken}`)
          console.log(`   Private channel: ${matchMsg.channel}`)
          console.log(`   Connect with peer: ${msg.poster.slice(0, 16)}… (Rep: ${getRep(msg.poster)})\n`)
        }
      }
      updatePrompt()
    }
  }

  if (msg.kind === 'intent.cancel') {
    const t = intents.get(msg.intentId)
    if (t) {
      if (t.status === 'matched') {
        updateRep(msg.cancelledBy || msg.poster, -1)
      }
      t.status = 'cancelled'
      addHistory({ type: 'cancel', intentId: msg.intentId, by: msg.cancelledBy || 'system' })
      console.log(`\n${COLORS.red}❌ Intent cancelled [${msg.intentId}]${COLORS.reset}\n`)
      updatePrompt()
    }
  }

  if (msg.kind === 'intent.match') {
    const t = intents.get(msg.intentId)
    if (t) t.status = 'matched'
    if (msg.counterparty !== myPubkey) return
    console.log(`\n${COLORS.green}${COLORS.bold}👻 You've been matched!${COLORS.reset}`)
    console.log(`   Intent      : [${msg.intentId}]`)
    console.log(`   Private channel: ${msg.channel}`)
    console.log(`   Trade with  : ${msg.counterparty.slice(0, 16)}… (Rep: ${getRep(msg.counterparty)})\n`)
    updatePrompt()
  }
}

// ─── Commands ──────────────────────────────────────────────────────────────

function cmdPost (args) {
  const forIdx = args.indexOf('for')
  if (forIdx < 2 || !args[forIdx + 1]) {
    return console.log(`${COLORS.red}Usage: post <amount> <fromToken> for <toToken>\nExample: post 100 TNK for BTC${COLORS.reset}`)
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
  addHistory({ type: 'post', intentId: msg.intentId, from: fromToken, to: toToken })
  console.log(`\n${COLORS.yellow}✅ Intent posted [${msg.intentId}]: ${fromAmount} ${fromToken} → ${toToken}${COLORS.reset}\n`)
}

function cmdList () {
  const open = [...intents.values()].filter(i => i.status === 'open')
  if (open.length === 0) {
    console.log(`\n  ${COLORS.yellow}(no open intents — be the first to post one!)${COLORS.reset}\n`)
    return
  }
  console.log(`\n${COLORS.whiteBold}─── Open Swap Intents ───────────────────────────${COLORS.reset}`)
  for (const i of open) {
    const isMine = i.poster === myPubkey
    const mine = isMine ? ' (you)' : ` (peer: ${i.poster.slice(0, 8)}… Rep: ${getRep(i.poster)})`
    
    let symbol = '○'
    if (!isMine || isDemo) {
        const result = findMatch(i)
        if (result && result.partial) symbol = '~'
    }

    console.log(`  ${COLORS.yellow}${symbol} [${i.intentId}] ${i.fromAmount} ${i.fromToken} → ${i.toToken}${mine}${COLORS.reset}`)
  }
  console.log(`${COLORS.whiteBold}─────────────────────────────────────────────────${COLORS.reset}\n`)
}

function cmdCancel (args) {
  const intentId = args[0]
  if (!intentId) return console.log('Usage: cancel <intentId>')
  const t = intents.get(intentId)
  if (!t) return console.log(`${COLORS.red}Intent ${intentId} not found.${COLORS.reset}`)
  if (t.poster !== myPubkey) return console.log(`${COLORS.red}You can only cancel your own intents.${COLORS.reset}`)
  
  const msg = { kind: 'intent.cancel', intentId, cancelledBy: myPubkey }
  applyMessage(msg)
  broadcast(msg)
}

function cmdAccept(args) {
    const intentId = args[0]
    const isPartial = args[1] === 'partial'
    if (!intentId || !isPartial) {
        return console.log(`${COLORS.red}Usage: accept <intentId> partial${COLORS.reset}`)
    }
    const target = intents.get(intentId)
    if (!target || target.status !== 'open') {
        return console.log(`${COLORS.red}Valid open intent not found.${COLORS.reset}`)
    }
    
    const result = findMatch(target)
    if (!result) return console.log(`${COLORS.red}No matching intent found in your list.${COLORS.reset}`)
    
    const { match } = result
    const tradeId = uuid()
    const matchMsg = {
        kind: 'intent.match',
        intentId: match.intentId,
        matchedWith: target.intentId,
        counterparty: target.poster,
        channel: `ghostswap:${tradeId}`,
        tradeId
    }
    match.status = 'matched'
    target.status = 'matched'
    broadcast(matchMsg)
    addHistory({ type: 'match-partial', intentId: match.intentId, with: target.intentId })
    updateRep(myPubkey, 1)
    updateRep(target.poster, 1)
    
    console.log(`\n${COLORS.green}${COLORS.bold}🔥 PARTIAL MATCH ACCEPTED!${COLORS.reset}`)
    console.log(`   Your intent : [${match.intentId}] ${match.fromAmount} ${match.fromToken} → ${match.toToken}`)
    console.log(`   Matched with: [${target.intentId}] ${target.fromAmount} ${target.fromToken} → ${target.toToken}`)
    console.log(`   Private channel: ${matchMsg.channel}\n`)
    updatePrompt()
}

function cmdHistory() {
    const history = loadJSON(HISTORY_FILE, [])
    console.log(`\n${COLORS.whiteBold}─── Recent History ──────────────────────────────${COLORS.reset}`)
    history.slice(-10).forEach(h => {
        const date = new Date(h.timestamp).toLocaleTimeString()
        console.log(`  [${date}] ${h.type.toUpperCase()}: ${h.intentId || ''} ${h.from || ''} ${h.to || ''}`)
    })
    console.log(`${COLORS.whiteBold}─────────────────────────────────────────────────${COLORS.reset}\n`)
}

function cmdHelp () {
  console.log(`
  ${COLORS.whiteBold}Commands:${COLORS.reset}
    post <amount> <fromToken> for <toToken>   Broadcast a swap intent
    list                                      List all open intents (~ indicates partial match)
    cancel <intentId>                         Cancel your intent
    accept <intentId> partial                 Accept a partial match
    history                                   Show last 10 events
    help                                      Show this help
    exit                                      Quit

  ${COLORS.whiteBold}Examples:${COLORS.reset}
    post 100 TNK for BTC
    post 0.5 BTC for TNK
    list
    cancel a1b2c3
    accept x1y2z3 partial
`)
}

// ─── Network ───────────────────────────────────────────────────────────────

async function start () {
  swarm = new Hyperswarm()
  myPubkey = swarm.keyPair.publicKey.toString('hex')

  swarm.on('connection', (conn) => {
    peers.add(conn)
    console.log(`\n${COLORS.cyan}󱘖 Peer connected! Total peers: ${peers.size}${COLORS.reset}`)
    updatePrompt()

    conn.on('data', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        applyMessage(msg)
      } catch (_) {}
    })
    conn.on('close', () => {
      peers.delete(conn)
      console.log(`\n${COLORS.cyan}󱘖 Peer disconnected. Total peers: ${peers.size}${COLORS.reset}`)
      updatePrompt()
    })
    conn.on('error', () => {
      peers.delete(conn)
      updatePrompt()
    })
  })

  await swarm.join(CHANNEL_TOPIC, { server: true, client: true })
  await swarm.flush()

  console.log(`
${COLORS.whiteBold}╔══════════════════════════════════════════╗
║         GhostSwap  👻                   ║
║   P2P Intent Matching on IntercomSwap   ║${isDemo ? "\n║          (DEMO MODE ENABLED)            ║" : ""}
╚══════════════════════════════════════════╝${COLORS.reset}

  Channel : ${CHANNEL}
  Peer ID : ${myPubkey.slice(0, 16)}… (Rep: ${getRep(myPubkey)})
  Peers   : ${COLORS.cyan}${peers.size} connected${COLORS.reset}

  Type "help" for commands.
  Example : ${COLORS.yellow}post 100 TNK for BTC${COLORS.reset}
`)

  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: getPrompt()
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
      case 'accept': cmdAccept(args); break
      case 'history': cmdHistory();   break
      case 'help':   cmdHelp();       break
      case 'exit':
        console.log('Goodbye 👋')
        swarm.destroy().then(() => process.exit(0))
        return
      case '': break
      default:
        console.log(`Unknown command: "${cmd}". Type "help".`)
    }
    updatePrompt()
  })

  rl.on('close', () => {
    swarm.destroy().then(() => process.exit(0))
  })

  // Expiry Timer
  setInterval(() => {
    const currentTime = now()
    for (const [id, intent] of intents) {
      if (intent.status === 'open' && intent.poster === myPubkey) {
        if (currentTime - intent.postedAt > EXPIRY_SECONDS) {
          const msg = { kind: 'intent.cancel', intentId: id, cancelledBy: 'system-expiry' }
          applyMessage(msg)
          broadcast(msg)
          console.log(`\n${COLORS.red}⏰ Intent [${id}] expired after 10m${COLORS.reset}`)
          updatePrompt()
        }
      }
    }
  }, 30000)
}

start().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
