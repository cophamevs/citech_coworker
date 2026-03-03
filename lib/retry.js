const RETRY_CONFIG = {
    maxRetries: 3,
    baseDelay: 1000,    // ms
    maxDelay: 30_000,   // ms
    timeout: 300_000,   // 5 minutes per task
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Create a promise that rejects after `ms` milliseconds
 * @param {number} ms
 * @param {string} message
 */
function timeout(ms, message = 'Operation timed out') {
    return new Promise((_, reject) =>
        setTimeout(() => reject(Object.assign(new Error(message), { code: 'ETIMEOUT' })), ms)
    )
}

/**
 * Classify an error as transient (retriable) vs fatal
 * @param {Error} err
 */
function isTransient(err) {
    return (
        err.code === 'ECONNRESET' ||
        err.code === 'ETIMEOUT' ||
        err.message?.includes('ECONNREFUSED') ||
        err.message?.includes('timeout') ||
        err.statusCode === 429 ||    // rate limit
        err.statusCode >= 500        // server error
    )
}

/**
 * Run an async function with retry and timeout logic
 * @template T
 * @param {() => Promise<T>} fn
 * @param {string} [label] - task label for logging
 * @param {Partial<typeof RETRY_CONFIG>} [config] - override defaults
 * @returns {Promise<T>}
 */
export async function withRetry(fn, label = 'operation', config = {}) {
    const cfg = { ...RETRY_CONFIG, ...config }

    for (let attempt = 0; attempt < cfg.maxRetries; attempt++) {
        try {
            return await Promise.race([
                fn(),
                timeout(cfg.timeout, `${label} timed out after ${cfg.timeout / 1000}s`)
            ])
        } catch (err) {
            const isLast = attempt >= cfg.maxRetries - 1

            if (isTransient(err) && !isLast) {
                const delay = Math.min(cfg.baseDelay * 2 ** attempt, cfg.maxDelay)
                console.warn(`[retry] ${label} attempt ${attempt + 1}/${cfg.maxRetries} failed: ${err.message}. Retrying in ${delay}ms...`)
                await sleep(delay)
                continue
            }

            // Fatal error or last attempt
            throw err
        }
    }
}
