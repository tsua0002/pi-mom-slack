import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { RunProcesses } from "../src/run-processes.ts";

it("ends background processes started by the run", async () => {
	const runs = new RunProcesses();
	let output = "";
	try {
		const result = await runs.operations().exec("sleep 60 >/dev/null 2>&1 & echo $!", "/tmp", { onData: (buf) => { output += buf.toString(); }, env: process.env });
		expect(result.exitCode).toBe(0);
		const pid = Number(output.trim());
		expect(() => process.kill(pid, 0)).not.toThrow();
		runs.cleanup();
		await new Promise((r) => setTimeout(r, 100));
		let state = "";
		try { state = readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[2] ?? ""; } catch {}
		expect(["", "Z"]).toContain(state); // a zombie may linger briefly; it no longer runs
	} finally { runs.cleanup(); }
});
