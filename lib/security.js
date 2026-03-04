/**
 * Security module — rate limiting, input validation, auth
 */

// ─── Rate Limiter ────────────────────────────────────────────────────────────

/** userId → array of request timestamps */
const rateLimiter = new Map()

/**
 * Check and enforce per-user rate limit (sliding window)
 * Throws if limit exceeded
 * @param {string|number} userId
 * @param {number} maxPerMinute
 */
export function checkRateLimit(userId, maxPerMinute = 5) {
    const now = Date.now()
    const window = 60_000  // 1 minute

    const requests = (rateLimiter.get(String(userId)) || [])
        .filter((t) => now - t < window)

    if (requests.length >= maxPerMinute) {
        throw Object.assign(
            new Error(`Rate limit exceeded. Max ${maxPerMinute} tasks/minute. Try again later.`),
            { code: 'RATE_LIMIT' }
        )
    }

    rateLimiter.set(String(userId), [...requests, now])
}

// ─── Input Validation ─────────────────────────────────────────────────────────

const DANGEROUS_PATTERNS = [
    /<script/i,
    /javascript:/i,
    /on\w+\s*=/i,    // HTML event handlers
]

/**
 * Validate and sanitize a task instruction
 * Throws on invalid input
 * @param {string} instruction
 * @param {number} maxLength
 * @returns {string} trimmed instruction
 */
export function validateInstruction(instruction, maxLength = 2000) {
    if (typeof instruction !== 'string') {
        throw new Error('Instruction must be a string')
    }

    const trimmed = instruction.trim()

    if (trimmed.length === 0) {
        throw new Error('Instruction cannot be empty')
    }

    if (trimmed.length > maxLength) {
        throw new Error(`Instruction too long (${trimmed.length} chars, max ${maxLength})`)
    }

    for (const pattern of DANGEROUS_PATTERNS) {
        if (pattern.test(trimmed)) {
            throw Object.assign(
                new Error('Instruction contains prohibited content'),
                { code: 'INVALID_INPUT' }
            )
        }
    }

    return trimmed
}

// ─── Telegram Auth ────────────────────────────────────────────────────────────

/**
 * Check if a Telegram user ID is in the allowed list
 * @param {number|string} userId
 * @param {(number|string)[]} allowedUsers
 * @returns {boolean}
 */
export function isAllowedUser(userId, allowedUsers) {
    if (!allowedUsers || allowedUsers.length === 0) return true  // Open if no list set
    return allowedUsers.map(String).includes(String(userId))
}

// ─── CLI Command Whitelist ────────────────────────────────────────────────────

const DEFAULT_ALLOWED_COMMANDS = ['task', 'status', 'logs', 'spawn', 'history', 'memory']

/**
 * Check if a CLI command name is allowed
 * @param {string} cmd
 * @param {string[]} allowedCommands
 */
export function isAllowedCommand(cmd, allowedCommands = DEFAULT_ALLOWED_COMMANDS) {
    return allowedCommands.includes(cmd)
}
