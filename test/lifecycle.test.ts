import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type BotState, changesSince, compareVersions, readState, restartReason, writeState } from "../src/lifecycle.ts";

const base: BotState = { status: "running", pid: 1, startedAt: "2026-11-03T14:00:00Z", version: "0.1.0", piVersion: "1.5.0" };
const now = { version: "0.1.0", piVersion: "1.5.0", machineUptimeSec: 86_400 };

describe("restartReason", () => {
	it("first start", () => expect(restartReason(null, now)).toContain("First start"));
	it("crash, with the error", () => {
		const r = restartReason({ ...base, status: "crashed", endedAt: "2026-11-03T14:05:00Z", error: "TypeError: x is undefined" }, now);
		expect(r).toContain("crashed");
		expect(r).toContain("TypeError: x is undefined");
	});
	it("requested stop, killed process, server reboot", () => {
		expect(restartReason({ ...base, status: "stopped", signal: "SIGTERM", endedAt: "2026-11-03T14:05:00Z" }, now)).toContain("SIGTERM");
		expect(restartReason(base, now)).toContain("killed");
		expect(restartReason(base, { ...now, machineUptimeSec: 60 })).toContain("Server restart");
	});
	it("updates of the package and of pi, with the changes", () => {
		const many = Array.from({ length: 14 }, (_, i) => `change ${i}`);
		const r = restartReason({ ...base, status: "stopped" }, { ...now, version: "0.2.0", piVersion: "1.6.0", changes: many });
		expect(r).toContain("pi-mom-slack 0.1.0 → 0.2.0");
		expect(r).toContain("• change 0");
		expect(r).not.toContain("change 12");
		expect(r).toContain("2 more");
		expect(r).toContain("pi 1.5.0 → 1.6.0");
	});
});

describe("changelog", () => {
	const log = "# Changelog\n\n## 0.3.0\n\n- c\n\n## [0.2.1] - 2026-11-10\n\n- b2\n* b1\n\n## v0.2.0\n\n- a\n\n## 0.1.0\n\n- first\n";
	it("returns the entries between two versions", () => {
		expect(changesSince(log, "0.1.0", "0.2.1")).toEqual(["b2", "b1", "a"]);
		expect(changesSince(log, "0.2.1", "0.3.0")).toEqual(["c"]);
		expect(changesSince(log, "0.3.0", "0.3.0")).toEqual([]);
	});
	it("compares versions numerically", () => {
		expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
		expect(compareVersions("1.5.0", "1.5.0")).toBe(0);
	});
});

it("state file round trip", () => {
	const file = join(mkdtempSync(join(tmpdir(), "state-")), "sub", "bot-state.json");
	expect(readState(file)).toBeNull();
	writeState(file, base);
	expect(readState(file)).toEqual(base);
});
