// Error log: saves every MinAgent error to logs/errors.jsonl in the MinAgent
// install folder (not in the user's project). One JSON object per line.
// Why: errors used to be printed in the terminal only and were lost after the
// session. With a log, we can read real failures later and improve MinAgent.
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { redactLikelySecrets } from "./secrets.mjs";

// When the log grows past this size, it is renamed to errors.old.jsonl
// (replacing the previous old file) and a new log starts.
const DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024;

export function createErrorLog(logDirectory, maxLogBytes = DEFAULT_MAX_LOG_BYTES) {
	const logPath = join(logDirectory, "errors.jsonl");
	const oldLogPath = join(logDirectory, "errors.old.jsonl");

	// Writes one entry. It never throws: a broken log must not break MinAgent.
	// Sync calls are used on purpose, so the entry is written even right
	// before the process exits after a fatal error.
	function logError(entry) {
		try {
			// Redact secrets (API keys, tokens, passwords) in every string value.
			// Done per value, not on the final JSON text: redacting the JSON text
			// could swallow a closing quote and break the line.
			const line = JSON.stringify(
				{ time: new Date().toISOString(), ...entry },
				(key, value) => (typeof value === "string" ? redactLikelySecrets(value) : value),
			);
			mkdirSync(logDirectory, { recursive: true });
			try {
				if (statSync(logPath).size > maxLogBytes) renameSync(logPath, oldLogPath);
			} catch {
				// No log file yet: nothing to rotate.
			}
			appendFileSync(logPath, `${line}\n`, "utf8");
		} catch {
			// Ignore logging failures (read-only folder, disk full, ...).
		}
	}

	return { logError, logPath };
}
