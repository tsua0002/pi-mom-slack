/**
 * A durable marker per running thread, outside the agent's workspace. A marker still present at startup means the
 * previous process stopped in the middle of a run: the bot resumes it, at most MAX_RESUMES times.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MAX_RESUMES = 2;

export interface RunMarker {
	channel: string;
	threadTs: string;
	user: string;
	/** Resumes already attempted. */
	attempts?: number;
}

export class RunMarkers {
	private dir: string;

	constructor(dataDir: string) {
		this.dir = join(dataDir, "active-runs");
	}

	private path(marker: Pick<RunMarker, "channel" | "threadTs">): string {
		return join(this.dir, `${createHash("sha256").update(JSON.stringify([marker.channel, marker.threadTs])).digest("hex")}.json`);
	}

	start(marker: RunMarker): void {
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		const target = this.path(marker);
		const temp = `${target}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temp, JSON.stringify(marker), { mode: 0o600, flag: "wx" });
			renameSync(temp, target);
		} finally {
			rmSync(temp, { force: true });
		}
	}

	/** Counts one more resume attempt and returns the new total (guards against a crash loop on restart). */
	bump(marker: RunMarker): number {
		const attempts = (marker.attempts ?? 0) + 1;
		this.start({ ...marker, attempts });
		return attempts;
	}

	finish(marker: Pick<RunMarker, "channel" | "threadTs">): void {
		rmSync(this.path(marker), { force: true });
	}

	/** Valid markers, ignoring (and reporting) unreadable ones instead of failing the whole startup. */
	list(onInvalid: (file: string) => void = () => {}): RunMarker[] {
		let entries: string[];
		try {
			entries = readdirSync(this.dir);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw e;
		}
		const out: RunMarker[] = [];
		for (const entry of entries.filter((e) => /^[0-9a-f]{64}\.json$/.test(e))) {
			try {
				const m = JSON.parse(readFileSync(join(this.dir, entry), "utf8")) as Partial<RunMarker>;
				const ok =
					typeof m.channel === "string" && /^[A-Z0-9]+$/.test(m.channel) &&
					typeof m.threadTs === "string" && /^\d+\.\d+$/.test(m.threadTs) &&
					typeof m.user === "string" && /^[A-Z0-9]+$/.test(m.user) &&
					(m.attempts === undefined || Number.isInteger(m.attempts)) &&
					this.path(m as RunMarker) === join(this.dir, entry);
				if (ok) out.push(m as RunMarker);
				else onInvalid(entry);
			} catch {
				onInvalid(entry);
			}
		}
		return out;
	}
}
