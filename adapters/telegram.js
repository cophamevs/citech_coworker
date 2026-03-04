import 'dotenv/config'
import { Telegraf, Markup } from 'telegraf'
import { checkRateLimit, validateInstruction, isAllowedUser } from '../lib/security.js'
import { getRecentTasks, queryUsageSummary, queryUsageByAgent } from '../lib/memory.js'

/**
 * Create and configure a Telegram bot adapter (DB-Centric async pattern)
 * @param {import('../lib/orchestrator.js').Orchestrator} orchestrator
 * @param {import('../lib/registry.js').AgentRegistry} registry
 * @param {Object} config
 */
export function createTelegramAdapter(orchestrator, registry, config = {}) {
    const token = process.env.TELEGRAM_TOKEN
    if (!token) {
        console.warn('[telegram] TELEGRAM_TOKEN not set — Telegram adapter disabled')
        return null
    }

    const allowedUsers = (process.env.TELEGRAM_ALLOWED_USERS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)

    const rateLimit = config.rateLimitPerMinute || 5
    const maxTaskLength = config.maxTaskLength || 2000

    const bot = new Telegraf(token, { handlerTimeout: 900_000 })

    // Track user preferences: userId -> role
    const userPreferences = new Map()

    // Track pending "⏳" messages so watcher can reply inline
    // Map<taskId, { chatId, processingMsgId }>
    const pendingNotifications = new Map()

    /**
     * Submit a task to the DB queue and reply "⏳ Processing..."
     * The watcher callback (set up in index.js) will call onTaskResult() when done.
     */
    async function submitTaskAsync(ctx, instruction, opts = {}) {
        const chatId = ctx.chat.id
        const roleLabel = opts.role ? ` (via ${opts.role})` : ' (via Orchestrator)'

        // Send processing message
        const processingMsg = await ctx.reply(`⏳ Processing...${roleLabel}`)

        // Submit to DB queue
        const taskId = orchestrator.submitTask(instruction, {
            ...opts,
            telegramChatId: String(chatId),
            telegramMsgId: String(processingMsg.message_id)
        })

        // Track for watcher callback
        pendingNotifications.set(taskId, {
            chatId,
            processingMsgId: processingMsg.message_id
        })

        console.log(`[telegram] Task ${taskId} queued for chat ${chatId}`)
    }
    /**
     * Called by the orchestrator watcher when a task completes.
     * Sends the result back to the Telegram chat.
     */
    async function onTaskResult(task) {
        const chatId = task.telegram_chat_id
        if (!chatId) return

        const pending = pendingNotifications.get(task.id)
        pendingNotifications.delete(task.id)

        try {
            let text
            if (task.status === 'done') {
                const result = task.result || '(empty response)'
                const preview = result.length > 3000
                    ? result.slice(0, 3000) + '\n...(truncated)'
                    : result
                const agentLabel = task.agent_id || 'unknown'
                text = `✅ Task #${task.id.slice(0, 8)} done by ${agentLabel}\n\n${preview}`
            } else if (task.status === 'failed') {
                const errorMsg = task.error || 'Unknown error'
                text = `❌ Task #${task.id.slice(0, 8)} failed:\n${errorMsg}`
            } else {
                return
            }

            // Try to edit the "⏳ Processing..." message, then fallback to new message
            // Strategy: try Markdown → fallback to plain text (no parse_mode)
            const sent = await trySendTelegram(chatId, text, pending?.processingMsgId)
            if (sent) {
                console.log(`[telegram] ✅ Result sent for task ${task.id.slice(0, 8)}`)
            } else {
                console.error(`[telegram] ❌ All send attempts failed for task ${task.id.slice(0, 8)}`)
            }
        } catch (err) {
            console.error(`[telegram] Failed to send result for task ${task.id}: ${err.message}`)
        }
    }

    /**
     * Try multiple strategies to send a message to Telegram.
     * Returns true if any succeeded.
     */
    async function trySendTelegram(chatId, text, editMsgId = null) {
        // 1. Try edit existing message (plain text — safest)
        if (editMsgId) {
            try {
                await bot.telegram.editMessageText(chatId, editMsgId, undefined, text)
                return true
            } catch (err) {
                console.warn(`[telegram] editMessage failed: ${err.message}`)
            }
        }

        // 2. Try send new message (plain text)
        try {
            await bot.telegram.sendMessage(chatId, text)
            return true
        } catch (err) {
            console.warn(`[telegram] sendMessage failed: ${err.message}`)
        }

        // 3. Last resort — send truncated
        try {
            const short = text.slice(0, 1000) + '\n...(message too long)'
            await bot.telegram.sendMessage(chatId, short)
            return true
        } catch (err) {
            console.error(`[telegram] All send attempts failed: ${err.message}`)
        }

        return false
    }

    // Expose onTaskResult for watcher callback
    bot.onTaskResult = onTaskResult

    // ── Auth middleware ──────────────────────────────────────────────────────
    bot.use(async (ctx, next) => {
        const userId = ctx.from?.id
        if (allowedUsers.length > 0 && !isAllowedUser(userId, allowedUsers)) {
            return ctx.reply('⛔ Unauthorized.')
        }
        await next()
    })

    // ── /start ───────────────────────────────────────────────────────────────
    bot.command('start', (ctx) => {
        ctx.reply(
            '👋 *OpenCode Multi-Agent Bot*\n\n' +
            'Commands:\n' +
            '`/agents` — List available agents to talk to\n' +
            '`/agent` — Switch to a specific agent\n' +
            '`/status` — Show agent status\n' +
            '`/workflow` — Run multi-step workflows\n' +
            '`/cost` — Show token usage and costs\n' +
            '`/help` — Show help\n\n' +
            'Tip: After choosing an agent via `/agent`, you can just chat directly!',
            { parse_mode: 'Markdown' }
        )
    })

    bot.command('help', (ctx) => ctx.reply(
        '📖 *Help*\n\n' +
        '`/agent` — Choose your default agent (Coder, Sysadmin, Researcher, or Auto)\n' +
        'Once chosen, just send plain text to chat with them!\n\n' +
        'Or use specific commands:\n' +
        '`/task fix the login bug in auth.js` — Ask coder agent\n' +
        '`/task check disk usage on server` — Ask sysadmin agent\n' +
        '`/task explain how JWT works` — Ask researcher agent\n\n',
        { parse_mode: 'Markdown' }
    ))

    // ── /agent & /agents ──────────────────────────────────────────────────────
    bot.command(['agent', 'agents'], (ctx) => {
        return ctx.reply('🤖 Choose an agent to talk to or use Orchestrator:', Markup.inlineKeyboard([
            [Markup.button.callback('💻 Coder', 'role_coder'), Markup.button.callback('🛠️ Sysadmin', 'role_sysadmin')],
            [Markup.button.callback('🔍 Researcher', 'role_researcher'), Markup.button.callback('📅 Planner', 'role_planner')],
            [Markup.button.callback('📧 Email', 'role_email-assistant'), Markup.button.callback('🧠 Orchestrator', 'role_auto')]
        ]))
    })

    bot.action(/^role_(.+)$/, async (ctx) => {
        const userId = ctx.from.id
        const role = ctx.match[1]

        if (role === 'auto') {
            userPreferences.delete(userId)
            await ctx.answerCbQuery('Orchestrator enabled')
            try {
                await ctx.editMessageText('🧠 *Orchestrator* enabled.\n\nSend me a message and I will intelligently delegate it to the best agent.', { parse_mode: 'Markdown' })
            } catch (err) {
                // Ignore "message is not modified" error
            }
        } else {
            userPreferences.set(userId, role)
            const roleNames = {
                coder: '💻 Coder',
                sysadmin: '🛠️ Sysadmin',
                researcher: '🔍 Researcher',
                planner: '📅 Planner',
                'email-assistant': '📧 Email Assistant',
                orchestrator: '🧠 Orchestrator'
            }
            await ctx.answerCbQuery(`${roleNames[role] || role} selected`)
            try {
                await ctx.editMessageText(`${roleNames[role] || role} selected.\n\nYou can now send plain text messages directly to this agent!`, { parse_mode: 'Markdown' })
            } catch (err) {
                // Ignore "message is not modified" error
            }
        }
    })

    // ── /task ─────────────────────────────────────────────────────────────────
    bot.command('task', async (ctx) => {
        const userId = ctx.from?.id
        const raw = ctx.message.text.replace(/^\/task\s*/i, '').trim()

        try {
            validateInstruction(raw, maxTaskLength)
            checkRateLimit(userId, rateLimit)
        } catch (err) {
            return ctx.reply(`❌ ${err.message}`)
        }

        await submitTaskAsync(ctx, raw)
    })

    // ── /status ───────────────────────────────────────────────────────────────
    bot.command('status', (ctx) => {
        const agents = registry.getAll()
        if (agents.length === 0) {
            return ctx.reply('No agents registered.')
        }
        const text = agents.map((a) =>
            `${a.status === 'idle' ? '🟢' : a.status === 'busy' ? '🟡' : '🔴'} \`${a.id}\` (${a.role}) — ${a.status}`
        ).join('\n')
        ctx.reply(`*Agent Status*\n\n${text}`, { parse_mode: 'Markdown' })
    })

    // ── /history ──────────────────────────────────────────────────────────────
    bot.command('history', async (ctx) => {
        const tasks = getRecentTasks(10)
        if (tasks.length === 0) {
            return ctx.reply('No task history yet.')
        }
        const text = tasks.map((t) => {
            const icon = t.status === 'done' ? '✅' : t.status === 'failed' ? '❌' : '⏳'
            return `${icon} [${t.status}] ${t.instruction.slice(0, 50)}...`
        }).join('\n')
        ctx.reply(`*Recent Tasks*\n\n${text}`, { parse_mode: 'Markdown' })
    })

    // ── text handler (auto route to preferred agent) ──────────────────────────
    bot.on('text', async (ctx) => {
        if (ctx.message.text.startsWith('/')) return

        const userId = ctx.from?.id
        const instruction = ctx.message.text.trim()

        try {
            validateInstruction(instruction, maxTaskLength)
            checkRateLimit(userId, rateLimit)
        } catch (err) {
            return ctx.reply(`❌ ${err.message}`)
        }

        const preferredRole = userPreferences.get(userId)
        const opts = preferredRole ? { role: preferredRole } : {}
        await submitTaskAsync(ctx, instruction, opts)
    })

    // ── /workflow (Phase 2) ───────────────────────────────────────────────────
    bot.command('workflow', async (ctx) => {
        const args = ctx.message.text.replace(/^\/workflow\s*/i, '').trim()

        if (!args || args === 'list') {
            // List available workflows
            if (!orchestrator.workflowEngine) {
                return ctx.reply('Workflow engine not initialized.')
            }
            const workflows = orchestrator.workflowEngine.listWorkflows()
            if (workflows.length === 0) {
                return ctx.reply('No workflows registered.')
            }
            const text = workflows.map(wf =>
                `📋 *${wf.name}* (${wf.steps} steps)\n   ${wf.description || 'No description'}`
            ).join('\n\n')
            return ctx.reply(`*Available Workflows*\n\n${text}\n\nUsage: \`/workflow run <name> <input>\``, { parse_mode: 'Markdown' })
        }

        const runMatch = args.match(/^run\s+(\S+)\s+(.+)$/s)
        if (runMatch) {
            const [, name, input] = runMatch
            const chatId = ctx.chat.id

            try {
                validateInstruction(input, config.maxTaskLength || 2000)
                checkRateLimit(ctx.from?.id, rateLimit)
            } catch (err) {
                return ctx.reply(`❌ ${err.message}`)
            }

            const processingMsg = await ctx.reply(`🔄 Starting workflow: ${name}...`)

            try {
                await orchestrator.submitWorkflow(name, input, {
                    telegramChatId: String(chatId)
                })
            } catch (err) {
                return ctx.reply(`❌ Workflow error: ${err.message}`)
            }
            return
        }

        return ctx.reply('Usage:\n`/workflow list` — List workflows\n`/workflow run <name> <input>` — Run a workflow', { parse_mode: 'Markdown' })
    })

    // ── /cost (Phase 4) ───────────────────────────────────────────────────────
    bot.command('cost', (ctx) => {
        const summary = queryUsageSummary()
        const byAgent = queryUsageByAgent()

        let text = `💰 *Cost Summary*\n\n`
        text += `Last hour: $${summary.hourly.toFixed(4)}\n`
        text += `Last day: $${summary.daily.toFixed(4)}\n`
        text += `Last week: $${summary.weekly.toFixed(4)}\n`
        text += `All time: $${summary.total.toFixed(4)}\n`
        text += `Total tokens: ${summary.totalTokens.toLocaleString()}`

        if (byAgent.length > 0) {
            text += `\n\n*Per-Agent:*\n`
            for (const a of byAgent) {
                text += `\`${a.agent_id || 'unknown'}\`: ${(a.total_input + a.total_output).toLocaleString()} tokens, $${a.total_cost.toFixed(4)}\n`
            }
        }

        ctx.reply(text, { parse_mode: 'Markdown' })
    })

    return bot
}