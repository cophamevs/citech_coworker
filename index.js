import 'dotenv/config'
import { readFileSync } from 'fs'
import { mkdirSync } from 'fs'
import { resolve } from 'path'

// ── Load config ───────────────────────────────────────────────────────────────
const config = JSON.parse(readFileSync('./config.json', 'utf-8'))

// ── Bootstrap modules ─────────────────────────────────────────────────────────
import { initDB, closeDB, buildContextPrompt } from './lib/memory.js'
import { AgentRegistry } from './lib/registry.js'
import { AgentSpawner } from './lib/agent-spawner.js'
import { Orchestrator } from './lib/orchestrator.js'
import { Heartbeat } from './lib/heartbeat.js'
import { createTelegramAdapter } from './adapters/telegram.js'
import { createCLI } from './adapters/cli.js'

// ── Globals (set inside main after await initDB) ─────────────────────────────
const registry = new AgentRegistry()
let orchestrator
let heartbeat

// ── Spawn initial agents from config ──────────────────────────────────────────
async function spawnConfiguredAgents() {
    for (const agentDef of (config.agents || [])) {
        const workdir = resolve(agentDef.workdir)
        mkdirSync(workdir, { recursive: true })

        const memory = buildContextPrompt(agentDef.id, config.memory_inject_count)

        const agent = new AgentSpawner({
            agentId: agentDef.id,
            port: agentDef.port,
            role: agentDef.role,
            workdir,
            memoryContext: memory,
        })

        try {
            await agent.start()
            registry.register(agent)
            console.log(`[index] ✅ ${agentDef.id} (${agentDef.role}) — port ${agentDef.port}`)
        } catch (err) {
            console.error(`[index] ❌ Failed to start ${agentDef.id}: ${err.message}`)
        }
    }
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitAllIdle(agents, timeoutMs = 60_000) {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
        const busy = agents.filter((a) => a.status === 'busy')
        if (busy.length === 0) return
        await sleep(1000)
    }
}

async function gracefulShutdown(signal) {
    console.log(`\n[shutdown] Received ${signal}. Shutting down gracefully...`)

    // 1. Stop heartbeat + orchestrator watcher
    heartbeat.stop()
    orchestrator.stopWatcher()

    // 2. Stop worker loops + mark agents as shutting down
    const agents = registry.getInstances()
    for (const agent of agents) {
        agent.stopWorkerLoop()
        await agent.markShuttingDown()
    }

    // 3. Wait for in-flight tasks (max shutdown_timeout seconds)
    console.log('[shutdown] Waiting for active tasks to finish...')
    await Promise.race([
        waitAllIdle(agents),
        sleep(config.shutdown_timeout * 1000)
    ])

    // 4. Kill all agent processes
    for (const agent of agents) {
        agent.kill()
    }

    // 5. Close SQLite
    closeDB()

    console.log('[shutdown] Done. Goodbye.')
    process.exit(0)
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))

// ── Wire CLI directly if invoked as oc ───────────────────────────────────────
const isDirectCLI = process.argv[1]?.endsWith('cli.js')

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    console.log('════════════════════════════════════════')
    console.log('  OpenCode Multi-Agent Plugin Layer')
    console.log('════════════════════════════════════════')

    // Init DB (async — supports WASM fallback)
    const dbFile = process.env.DB_FILE || './data/oc-plugin.db'
    await initDB(dbFile)

    // Init core services
    orchestrator = new Orchestrator(registry, {
        portStart: parseInt(process.env.OPENCODE_PORT_START || '4096'),
        workdir: resolve(process.env.AGENT_WORKDIR || './workspace'),
        maxRetries: config.max_retries,
        taskTimeout: config.task_timeout,
        memoryInjectCount: config.memory_inject_count,
    })
    heartbeat = new Heartbeat(registry, config.heartbeat_interval * 1000)

    // Spawn agents
    await spawnConfiguredAgents()

    // ── Start worker loops on all agents ──
    for (const agent of registry.getInstances()) {
        agent.startWorkerLoop(3000)  // poll DB every 3s
    }

    // Start heartbeat
    heartbeat.start()

    // Start Telegram bot (if token present)
    const bot = createTelegramAdapter(orchestrator, registry, {
        rateLimitPerMinute: config.telegram?.rate_limit_per_minute || 5,
        maxTaskLength: config.security?.max_task_length || 2000,
    })
    if (bot) {
        bot.launch()
        console.log('[index] Telegram bot launched')

        // ── Start orchestrator watcher — sends results back to Telegram ──
        orchestrator.startWatcher(async (task) => {
            await bot.onTaskResult(task)
        }, 2000)
        console.log('[index] Orchestrator watcher started')
    }

    // Expose CLI for interactive use
    const cli = createCLI(orchestrator, registry)
    // If launched with arguments, treat as CLI
    if (process.argv.length > 2) {
        await cli.parseAsync(process.argv)
        process.exit(0)
    }

    console.log(`\n[index] 🚀 System ready. ${registry.size} agent(s) online.`)
    console.log('[index] Press Ctrl+C to exit gracefully.\n')
}

main().catch((err) => {
    console.error('[fatal]', err)
    process.exit(1)
})
