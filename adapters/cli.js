#!/usr/bin/env node
import 'dotenv/config'
import { Command } from 'commander'
import { createReadStream } from 'fs'
import { getRecentTasks, saveMemory } from '../lib/memory.js'
import { validateInstruction } from '../lib/security.js'

/**
 * Build and return a configured Commander CLI program
 * @param {import('../lib/orchestrator.js').Orchestrator} orchestrator
 * @param {import('../lib/registry.js').AgentRegistry} registry
 */
export function createCLI(orchestrator, registry) {
    const program = new Command()

    program
        .name('oc')
        .description('OpenCode Multi-Agent CLI')
        .version('1.0.0')

    // ── oc task ───────────────────────────────────────────────────────────────
    program
        .command('task <instruction>')
        .description('Submit a task to the agent pool')
        .option('-r, --role <role>', 'Force a specific agent role (coder|sysadmin|researcher)')
        .option('-a, --agent <id>', 'Force a specific agent ID')
        .action(async (instruction, opts) => {
            try {
                instruction = validateInstruction(instruction)
            } catch (err) {
                console.error(`Error: ${err.message}`)
                process.exit(1)
            }

            console.log(`⏳ Submitting task${opts.role ? ` (role: ${opts.role})` : ''}...`)
            try {
                const { taskId, result, agentId } = await orchestrator.submitTask(instruction, {
                    role: opts.role,
                    agentId: opts.agent
                })
                console.log(`\n✅ Task #${taskId.slice(0, 8)} completed by ${agentId}\n`)
                console.log(result)
            } catch (err) {
                console.error(`❌ Task failed: ${err.message}`)
                process.exit(1)
            }
        })

    // ── oc status ─────────────────────────────────────────────────────────────
    program
        .command('status')
        .description('List all agents and their status')
        .action(() => {
            const agents = registry.getAll()
            if (agents.length === 0) {
                console.log('No agents registered.')
                return
            }
            console.log('\nAgent Pool Status\n' + '─'.repeat(50))
            for (const a of agents) {
                const icon = a.status === 'idle' ? '🟢' : a.status === 'busy' ? '🟡' : '🔴'
                console.log(`${icon}  ${a.id.padEnd(15)} role=${a.role.padEnd(12)} port=${a.port}  ${a.status}`)
            }
            console.log()
        })

    // ── oc logs ───────────────────────────────────────────────────────────────
    program
        .command('logs <agentId>')
        .description('View agent process logs')
        .option('-t, --tail <n>', 'Number of lines to show', '20')
        .action((agentId, opts) => {
            const agent = registry.getById(agentId)
            if (!agent) {
                console.error(`Agent not found: ${agentId}`)
                process.exit(1)
            }
            const lines = agent.getLogs(parseInt(opts.tail, 10))
            console.log(lines.join('\n') || '(no logs yet)')
        })

    // ── oc spawn ──────────────────────────────────────────────────────────────
    program
        .command('spawn')
        .description('Spawn a new agent')
        .requiredOption('-r, --role <role>', 'Agent role (coder|sysadmin|researcher)')
        .option('-p, --port <port>', 'Port to listen on (auto-assigned if not set)')
        .action(async (opts) => {
            console.log(`⏳ Spawning ${opts.role} agent...`)
            try {
                const { AgentSpawner } = await import('../lib/agent-spawner.js')
                const { AgentRegistry } = await import('../lib/registry.js')

                // Use orchestrator's internal spawn if available
                const agent = await orchestrator._spawnAgent(opts.role)
                console.log(`✅ Spawned: ${agent.agentId} on port ${agent.port}`)
            } catch (err) {
                console.error(`❌ Spawn failed: ${err.message}`)
                process.exit(1)
            }
        })

    // ── oc history ────────────────────────────────────────────────────────────
    program
        .command('history')
        .description('Show recent task history')
        .option('-n, --limit <n>', 'Number of tasks to show', '10')
        .option('-a, --agent <id>', 'Filter by agent ID')
        .action((opts) => {
            const tasks = getRecentTasks(parseInt(opts.limit, 10), opts.agent || null)
            if (tasks.length === 0) {
                console.log('No task history yet.')
                return
            }
            console.log('\nRecent Tasks\n' + '─'.repeat(60))
            for (const t of tasks) {
                const icon = t.status === 'done' ? '✅' : t.status === 'failed' ? '❌' : '⏳'
                console.log(`${icon} [${t.id.slice(0, 8)}] ${t.instruction.slice(0, 60)}`)
                console.log(`   Agent: ${t.agent_id}  Status: ${t.status}  At: ${t.created_at}`)
            }
            console.log()
        })

    // ── oc memory ─────────────────────────────────────────────────────────────
    program
        .command('memory set <key> <value>')
        .description('Store a shared memory entry')
        .option('-a, --agent <id>', 'Store for specific agent (default: shared)')
        .action((key, value, opts) => {
            saveMemory({ agentId: opts.agent || null, key, value })
            console.log(`✅ Memory saved: ${key}`)
        })

    return program
}
