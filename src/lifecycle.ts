/**
 * Why did the bot (re)start? The previous process leaves a small state file in the data directory: "running" while
 * alive, then "stopped" (signal) or "crashed" (uncaught error) on its way out. A file still saying "running" means the
 * process was killed without a chance to write (kill -9, out of memory, power loss). Machine uptime tells a server
 * reboot apart, and the recorded versions tell an update apart, with the changelog entries in between.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface BotState {
	status: "running" | "stopped" | "crashed";
	pid: number;
	startedAt: string;
	version: string;
	piVersion: string;
	endedAt?: string;
	signal?: string;
	error?: string;
}

export const stateFile = (dataDir: string) => join(dataDir, "bot-state.json");

export function readState(file: string): BotState | null {
	try {
		return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as BotState) : null;
	} catch {
		return null;
	}
}

export function writeState(file: string, state: BotState): void {
	try {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
	} catch (e) {
		console.warn("[pi-mom-slack] state file not written:", e instanceof Error ? e.message : e);
	}
}

const num = (v: string) => v.split(/[.+-]/).slice(0, 3).map((p) => Number.parseInt(p, 10) || 0);
export function compareVersions(a: string, b: string): number {
	const [x, y] = [num(a), num(b)];
	for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
	return 0;
}

/**
 * Bullet lines of the changelog sections newer than `prev`, up to `now` included.
 * Expects "## 0.1.1" style headings (an optional "[", "v" or trailing text is accepted).
 */
export function changesSince(changelog: string, prev: string, now: string): string[] {
	const out: string[] = [];
	let take = false;
	for (const line of changelog.split("\n")) {
		const h = /^##\s+\[?v?(\d+\.\d+\.\d+[^\]\s]*)/.exec(line);
		if (h) {
			take = compareVersions(h[1]!, prev) > 0 && compareVersions(h[1]!, now) <= 0;
			continue;
		}
		const item = /^\s*[-*]\s+(.*)$/.exec(line);
		if (take && item) out.push(item[1]!.trim());
	}
	return out;
}

const MAX_CHANGES = 12;
const fmt = (iso: string | undefined) => (iso ? new Date(iso).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "?");

export function restartReason(
	prev: BotState | null,
	now: { version: string; piVersion: string; machineUptimeSec: number; changes?: string[] },
): string {
	const lines: string[] = [];
	const rebooted = now.machineUptimeSec < 300;
	if (!prev) lines.push("First start.");
	else if (prev.status === "crashed") lines.push(`The previous process crashed at ${fmt(prev.endedAt)}:`, "```", (prev.error ?? "unknown error").slice(0, 1500), "```");
	else if (prev.status === "stopped") lines.push(rebooted ? `Server restart (clean stop at ${fmt(prev.endedAt)}).` : `Stopped on request at ${fmt(prev.endedAt)} (${prev.signal ?? "signal"}).`);
	else lines.push(rebooted ? "Server restart without a clean stop (power loss or forced reboot)." : "The previous process was killed without a trace (kill -9, out of memory…). Check the service logs.");
	if (prev?.version && prev.version !== now.version) {
		lines.push(`Updated: pi-mom-slack ${prev.version} → ${now.version}.`);
		const changes = now.changes ?? [];
		const shown = changes.slice(0, MAX_CHANGES);
		if (shown.length) lines.push(...shown.map((c) => `• ${c}`));
		if (changes.length > shown.length) lines.push(`… and ${changes.length - shown.length} more in the changelog.`);
	}
	if (prev?.piVersion && prev.piVersion !== now.piVersion) lines.push(`pi ${prev.piVersion} → ${now.piVersion}.`);
	return lines.join("\n");
}
