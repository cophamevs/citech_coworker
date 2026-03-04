/**
 * Metering — cost estimation and budget enforcement for LLM usage.
 *
 * Inspired by openfang metering.rs.
 */
import { queryHourlyCost, queryDailyCost } from './memory.js'

// ─── Pricing Table ──────────────────────────────────────────────────────────────
// Prices in USD per 1M tokens (input / output)

const PRICING = {
    // Anthropic
    'claude-3-5-sonnet': { input: 3.00, output: 15.00 },
    'claude-3-5-haiku': { input: 0.25, output: 1.25 },
    'claude-3-opus': { input: 15.00, output: 75.00 },
    'claude-3-sonnet': { input: 3.00, output: 15.00 },
    'claude-3-haiku': { input: 0.25, output: 1.25 },
    'claude-sonnet': { input: 3.00, output: 15.00 },
    'claude-haiku': { input: 0.25, output: 1.25 },

    // OpenAI
    'gpt-4o': { input: 2.50, output: 10.00 },
    'gpt-4o-mini': { input: 0.15, output: 0.60 },
    'gpt-4-turbo': { input: 10.00, output: 30.00 },
    'gpt-4': { input: 30.00, output: 60.00 },
    'gpt-3.5-turbo': { input: 0.50, output: 1.50 },
    'o1-preview': { input: 15.00, output: 60.00 },
    'o1-mini': { input: 3.00, output: 12.00 },

    // Google
    'gemini-2.0-flash': { input: 0.10, output: 0.40 },
    'gemini-1.5-pro': { input: 1.25, output: 5.00 },
    'gemini-1.5-flash': { input: 0.075, output: 0.30 },

    // DeepSeek
    'deepseek-chat': { input: 0.14, output: 0.28 },
    'deepseek-coder': { input: 0.14, output: 0.28 },
    'deepseek-reasoner': { input: 0.55, output: 2.19 },

    // Open-source / local (free or near-free)
    'llama': { input: 0.00, output: 0.00 },
    'codellama': { input: 0.00, output: 0.00 },
    'mistral': { input: 0.00, output: 0.00 },
    'qwen': { input: 0.00, output: 0.00 },
    'phi': { input: 0.00, output: 0.00 },

    // Default / unknown
    '_default': { input: 1.00, output: 3.00 },
}

/**
 * Find the best matching pricing entry for a model name.
 * Pattern-matches against known model prefixes.
 */
function findPricing(model) {
    if (!model) return PRICING['_default']

    const lower = model.toLowerCase()

    // Exact match first
    if (PRICING[lower]) return PRICING[lower]

    // Prefix/pattern match
    for (const [key, pricing] of Object.entries(PRICING)) {
        if (key === '_default') continue
        if (lower.includes(key)) return pricing
    }

    return PRICING['_default']
}

/**
 * Estimate the cost of a single LLM call.
 * @param {string} model - Model name (e.g., 'claude-3-5-sonnet-20241022')
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @returns {{ costUsd: number, pricing: { input: number, output: number } }}
 */
export function estimateCost(model, inputTokens, outputTokens) {
    const pricing = findPricing(model)
    const costUsd = (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000
    return { costUsd, pricing }
}

/**
 * Check if an agent is within budget.
 * @param {string} agentId
 * @param {{ hourly?: number, daily?: number }} budget - max USD per period
 * @returns {{ withinBudget: boolean, hourlySpend: number, dailySpend: number, reason?: string }}
 */
export function checkBudget(agentId, budget = {}) {
    const hourlySpend = queryHourlyCost(1)
    const dailySpend = queryDailyCost(1)

    if (budget.hourly && hourlySpend >= budget.hourly) {
        return {
            withinBudget: false,
            hourlySpend,
            dailySpend,
            reason: `Hourly budget exceeded ($${hourlySpend.toFixed(4)} >= $${budget.hourly})`
        }
    }

    if (budget.daily && dailySpend >= budget.daily) {
        return {
            withinBudget: false,
            hourlySpend,
            dailySpend,
            reason: `Daily budget exceeded ($${dailySpend.toFixed(4)} >= $${budget.daily})`
        }
    }

    return { withinBudget: true, hourlySpend, dailySpend }
}
