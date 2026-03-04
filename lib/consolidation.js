/**
 * Memory Consolidation — decays confidence of stale semantic memories,
 * soft-deletes minimum-confidence entries, and hard-deletes old soft-deleted ones.
 *
 * Inspired by openfang consolidation.rs.
 */
import { runQuery, runExec, isFts5Available } from './memory.js'

/**
 * Run the full consolidation pipeline.
 * Call periodically (e.g., every 60 minutes from heartbeat).
 *
 * @param {{ decayRate?: number, stalenessDays?: number }} opts
 */
export function consolidateMemories({ decayRate = 0.05, stalenessDays = 7 } = {}) {
    let decayed = 0
    let softDeleted = 0
    let hardDeleted = 0

    try {
        // Step 1: Decay confidence of unaccessed memories
        // Memories not accessed within stalenessDays get their confidence multiplied by (1 - decayRate)
        const staleRows = runQuery(
            `SELECT id, confidence FROM semantic_memories
       WHERE deleted = 0
         AND accessed_at < datetime('now', ? || ' days')`,
            `-${stalenessDays}`
        )

        for (const row of staleRows) {
            const newConfidence = Math.max(0, row.confidence * (1 - decayRate))
            runExec(
                `UPDATE semantic_memories SET confidence = ? WHERE id = ?`,
                newConfidence, row.id
            )
            decayed++
        }

        // Step 2: Soft-delete memories at minimum confidence (<=0.1)
        const lowConfRows = runQuery(
            `SELECT id FROM semantic_memories
       WHERE deleted = 0 AND confidence <= 0.1`
        )

        for (const row of lowConfRows) {
            runExec(
                `UPDATE semantic_memories SET deleted = 1, deleted_at = datetime('now') WHERE id = ?`,
                row.id
            )
            softDeleted++
        }

        // Step 3: Hard-delete memories soft-deleted 30+ days ago
        const oldDeleted = runQuery(
            `SELECT id FROM semantic_memories
       WHERE deleted = 1
         AND deleted_at < datetime('now', '-30 days')`
        )

        for (const row of oldDeleted) {
            // Clean up FTS5 index if available
            if (isFts5Available()) {
                try {
                    runExec(
                        `DELETE FROM semantic_fts WHERE rowid = (
               SELECT rowid FROM semantic_memories WHERE id = ?
             )`,
                        row.id
                    )
                } catch { /* FTS cleanup failure is non-fatal */ }
            }

            runExec(`DELETE FROM semantic_memories WHERE id = ?`, row.id)
            hardDeleted++
        }

        if (decayed + softDeleted + hardDeleted > 0) {
            console.log(
                `[consolidation] Decayed: ${decayed}, Soft-deleted: ${softDeleted}, Hard-deleted: ${hardDeleted}`
            )
        }
    } catch (err) {
        console.error(`[consolidation] Error: ${err.message}`)
    }

    return { decayed, softDeleted, hardDeleted }
}
