import 'dotenv/config'
import { Telegraf, Markup } from 'telegraf'
import { checkRateLimit, validateInstruction, isAllowedUser } from '../lib/security.js'
import { getRecentTasks } from '../lib/memory.js'

/**
 * Create and configure a Telegram bot adapter
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

    // Track user preferences: userId -> role ('coder', 'sysadmin', 'researcher', or null for auto)
    const userPreferences = new Map()

    // Per-user task queue: userId -> Array of { instruction, opts, ctx }
    const userQueues = new Map()
    // Per-user processing flag (prevents concurrent queue runners)
    const userProcessing = new Set()

    /**
     * Enqueue a task for a user and start processing if idle.
     * Tasks are processed sequentially — new tasks wait in queue.
     */
    async function enqueueTask(userId, ctx, instruction, opts = {}) {
        if (!userQueues.has(userId)) userQueues.set(userId, [])
        const queue = userQueues.get(userId)
        queue.push({ instruction, opts, ctx })

        const position = queue.length
        if (position > 1) {
            await ctx.reply(
                `📋 Task added to queue (position *#${position}*).\nWaiting for previous task to complete...`,
                { parse_mode: 'Markdown' }
            )
        }

        // Start processing loop if not already running for this user
        if (!userProcessing.has(userId)) {
            processQueue(userId)
        }
    }

    /**
     * Sequential queue processor — runs tasks one by one until queue is empty.
     */
    async function processQueue(userId) {
        if (userProcessing.has(userId)) return
        userProcessing.add(userId)

        while (true) {
            const queue = userQueues.get(userId) || []
            if (queue.length === 0) break

            const { instruction, opts, ctx } = queue[0]

            try {
                const roleLabel = opts.role ? ` (via ${opts.role})` : ' (via Orchestrator)'
                await ctx.reply(`⏳ Processing...${roleLabel}`)

                const { taskId, result, agentId } = await orchestrator.submitTask(instruction, opts)
                const preview = result.length > 3000
                    ? result.slice(0, 3000) + '\n...(truncated)'
                    : result

                await ctx.reply(
                    `✅ Task \`#${taskId.slice(0, 8)}\` done by \`${agentId}\`${opts.role ? '' : ' (delegated by Orchestrator)'}\n\n${preview}`,
                    { parse_mode: 'Markdown' }
                )
            } catch (err) {
                await ctx.reply(`❌ Task failed: ${err.message}`)
            } finally {
                queue.shift()
                const remaining = queue.length
                if (remaining > 0) {
                    await ctx.reply(
                        `📋 *${remaining}* tasks remaining in queue. Continuing...`,
                        { parse_mode: 'Markdown' }
                    )
                }
            }
        }

        userProcessing.delete(userId)
    }

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
            '`/queue` — View your current task queue\n' +
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
        '`/task explain how JWT works` — Ask researcher agent\n\n' +
        '`/queue` — View your pending tasks\n' +
        '`/clearqueue` — Clear all pending tasks\n',
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
            await ctx.editMessageText('🧠 *Orchestrator* enabled.\n\nSend me a message and I will intelligently delegate it to the best agent.', { parse_mode: 'Markdown' })
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
            await ctx.editMessageText(`${roleNames[role] || role} selected.\n\nYou can now send plain text messages directly to this agent!`, { parse_mode: 'Markdown' })
        }
    })

    // ── /queue ────────────────────────────────────────────────────────────────
    bot.command('queue', (ctx) => {
        const userId = ctx.from?.id
        const queue = userQueues.get(userId) || []

        if (queue.length === 0) {
            return ctx.reply('✅ Queue is empty.')
        }

        const isProcessing = userProcessing.has(userId)
        const lines = queue.map((item, i) => {
            const label = i === 0 && isProcessing ? '⏳ (processing)' : `#${i + 1}`
            const preview = item.instruction.slice(0, 60)
            const ellipsis = item.instruction.length > 60 ? '...' : ''
            return `${label} ${preview}${ellipsis}`
        })

        ctx.reply(`*Task Queue (${queue.length})*\n\n${lines.join('\n')}`, { parse_mode: 'Markdown' })
    })

    // ── /clearqueue ───────────────────────────────────────────────────────────
    bot.command('clearqueue', (ctx) => {
        const userId = ctx.from?.id
        const queue = userQueues.get(userId) || []

        if (queue.length === 0) {
            return ctx.reply('✅ Queue is empty.')
        }

        const isProcessing = userProcessing.has(userId)
        if (isProcessing && queue.length > 0) {
            // Keep the currently-processing task, clear the rest
            const current = queue[0]
            userQueues.set(userId, [current])
            ctx.reply(`🗑️ Removed ${queue.length - 1} tasks from queue.\nCurrent task will continue.`)
        } else {
            userQueues.set(userId, [])
            ctx.reply(`🗑️ Removed ${queue.length} tasks from queue.`)
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

        await enqueueTask(userId, ctx, raw)
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
        await enqueueTask(userId, ctx, instruction, opts)
    })

    return bot
}