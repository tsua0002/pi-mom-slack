import { spawn } from "node:child_process";
import type { BashOperations } from "@earendil-works/pi-coding-agent";

/** Tracks the process groups started by bash during one run, so they can be ended without touching other threads. */
export class RunProcesses {
	private groups = new Set<number>();

	operations(): BashOperations {
		return {
			exec: (command, cwd, options) =>
				new Promise((resolve, reject) => {
					const child = spawn("/bin/bash", ["-c", command], { cwd, env: options.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
					if (child.pid) this.groups.add(child.pid);
					let settled = false;
					const kill = () => {
						if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch {}
					};
					const timer = options.timeout ? setTimeout(kill, options.timeout * 1000) : undefined;
					const abort = () => kill();
					if (options.signal?.aborted) kill();
					else options.signal?.addEventListener("abort", abort, { once: true });
					child.stdout.on("data", options.onData);
					child.stderr.on("data", options.onData);
					const done = () => {
						settled = true;
						if (timer) clearTimeout(timer);
						options.signal?.removeEventListener("abort", abort);
					};
					child.once("error", (e) => { if (!settled) { done(); reject(e); } });
					child.once("exit", (code, signal) => { if (!settled) { done(); resolve({ exitCode: code ?? (signal ? 128 : 1) }); } });
				}),
		};
	}

	cleanup(): void {
		for (const group of this.groups) try { process.kill(-group, "SIGKILL"); } catch {}
		this.groups.clear();
	}
}
