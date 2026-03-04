#!/usr/bin/env node
import 'dotenv/config'
import { Command } from 'commander'
import { createReadStream } from 'fs'
import { getRecentTasks, saveMemory, listWorkflowRuns, getWorkflowRun, queryUsageSummary, queryUsageByAgent } from '../lib/memory.js'
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
                const { taskId, result, agentId } = await orchestrator.submitTaskSync(instruction, {
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

    // ── oc workflow (Phase 2) ─────────────────────────────────────────────────
    const workflowCmd = program
        .command('workflow')
        .description('Manage and run multi-step workflows')

    workflowCmd
        .command('list')
        .description('List available workflows')
        .action(() => {
            if (!orchestrator.workflowEngine) {
                console.log('Workflow engine not initialized.')
                return
            }
            const workflows = orchestrator.workflowEngine.listWorkflows()
            if (workflows.length === 0) {
                console.log('No workflows registered.')
                return
            }
            console.log('\nAvailable Workflows\n' + '─'.repeat(50))
            for (const wf of workflows) {
                console.log(`  📋 ${wf.name.padEnd(30)} ${wf.steps} step(s)`)
                if (wf.description) console.log(`     ${wf.description}`)
            }
            console.log()
        })

    workflowCmd
        .command('run <name> <input>')
        .description('Execute a workflow')
        .action(async (name, input) => {
            console.log(`⏳ Starting workflow: ${name}...`)
            try {
                const { runId, executePromise } = await orchestrator.submitWorkflow(name, input)
                console.log(`🔄 Workflow run started: ${runId.slice(0, 8)}`)
                console.log(`   Waiting for completion...`)
                await executePromise
                const run = getWorkflowRun(runId)
                if (run?.state === 'completed') {
                    console.log(`\n✅ Workflow completed!\n`)
                    console.log(run.output || '(no output)')
                } else {
                    console.log(`\n❌ Workflow failed: ${run?.error || 'unknown error'}`)
                }
            } catch (err) {
                console.error(`❌ Workflow failed: ${err.message}`)
                process.exit(1)
            }
        })

    workflowCmd
        .command('status [runId]')
        .description('Show workflow run status')
        .action((runId) => {
            if (runId) {
                const run = getWorkflowRun(runId)
                if (!run) {
                    console.log(`Run not found: ${runId}`)
                    return
                }
                console.log(`\nWorkflow Run: ${run.id.slice(0, 8)}`)
                console.log(`  State: ${run.state}`)
                console.log(`  Steps: ${run.step_results?.length || 0}`)
                if (run.error) console.log(`  Error: ${run.error}`)
                if (run.output) console.log(`  Output: ${run.output.slice(0, 200)}...`)
            } else {
                const runs = listWorkflowRuns(10)
                if (runs.length === 0) {
                    console.log('No workflow runs yet.')
                    return
                }
                console.log('\nRecent Workflow Runs\n' + '─'.repeat(60))
                for (const r of runs) {
                    const icon = r.state === 'completed' ? '✅' : r.state === 'failed' ? '❌' : '🔄'
                    console.log(`${icon} [${r.id.slice(0, 8)}] ${r.state.padEnd(12)} steps=${r.step_results?.length || 0}  ${r.created_at}`)
                }
                console.log()
            }
        })

    // ── oc cost (Phase 4) ─────────────────────────────────────────────────────
    program
        .command('cost')
        .description('Show token usage and cost breakdown')
        .action(() => {
            const summary = queryUsageSummary()
            const byAgent = queryUsageByAgent()

            console.log('\n💰 Cost Summary\n' + '─'.repeat(50))
            console.log(`  Last hour:  $${summary.hourly.toFixed(4)}`)
            console.log(`  Last day:   $${summary.daily.toFixed(4)}`)
            console.log(`  Last week:  $${summary.weekly.toFixed(4)}`)
            console.log(`  All time:   $${summary.total.toFixed(4)}`)
            console.log(`  Total tokens: ${summary.totalTokens.toLocaleString()}`)

            if (byAgent.length > 0) {
                console.log('\n  Per-Agent Breakdown:')
                for (const a of byAgent) {
                    console.log(`    ${(a.agent_id || 'unknown').padEnd(15)} ${a.request_count} reqs  ${(a.total_input + a.total_output).toLocaleString()} tokens  $${a.total_cost.toFixed(4)}`)
                }
            }
            console.log()
        })

    return program
}

