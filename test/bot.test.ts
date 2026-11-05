import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "../src/slack.ts";

// Slack and pi are replaced by fakes: no network, no model.
const h = vi.hoisted(() => ({
	calls: [] as [string, ...unknown[]][],
	handler: undefined as undefined | ((m: unknown) => Promise<void>),
	run: undefined as undefined | ((thread: unknown, text: string) => Promise<{ text: string; aborted: boolean; tools: number }>),
	busy: false,
}));

vi.mock("../src/slack.ts", async (orig) => {
	const real = await orig<typeof import("../src/slack.ts")>();
	class FakeBot {
		botUserId = "UBOT";
		onConnections?: (n: number) => void;
		api = {
			post: async (c: string, t: string, text: string) => { h.calls.push(["post", c, t, text]); return "status.1"; },
			update: async (c: string, ts: string, text: string) => { h.calls.push(["update", c, ts, text]); },
			dm: async (u: string, text: string) => { h.calls.push(["dm", u, text]); },
			react: async (c: string, ts: string, name: string) => { h.calls.push(["react", c, ts, name]); },
			unreact: async (c: string, ts: string, name: string) => { h.calls.push(["unreact", c, ts, name]); },
			upload: async () => {},
			download: async () => Buffer.from(""),
			userName: async (id: string) => (id === "U1" ? "Ada" : id),
			resolveMentions: async (t: string) => t.replace("<@U2>", "@Bob"),
		};
		constructor(_a: string, _b: string, handler: (m: unknown) => Promise<void>) { h.handler = handler; }
		trackThread() {}
		async start() { this.onConnections?.(2); }
		async stop() {}
	}
	return { ...real, SlackBot: FakeBot };
});

vi.mock("../src/agent.ts", async (orig) => {
	const real = await orig<typeof import("../src/agent.ts")>();
	class FakeAgents {
		dataDir: string;
		constructor(o: { dataDir: string }) { this.dataDir = o.dataDir; }
		workspaceOf(key: string) { return join(this.dataDir, "threads", key); }
		isBusy() { return h.busy; }
		busyInfo() { return h.busy ? { since: Date.now(), user: "U1" } : undefined; }
		run(thread: unknown, text: string) { return h.run!(thread, text); }
		async modelLabel() { return "anthropic/claude-opus-5-5"; }
		async describeModels() { return "models…"; }
		async switchModel(_t: unknown, spec: string, persist: boolean) { return `switched ${spec} ${persist}`; }
		async abort() { return false; }
		async disposeAll() {}
	}
	return { ...real, ThreadAgents: FakeAgents };
});

const { createSlackBot } = await import("../src/bot.ts");
const { RunMarkers } = await import("../src/run-markers.ts");

const msg = (text: string, extra: Partial<IncomingMessage> = {}): IncomingMessage => ({ channel: "C1", threadTs: "1.1", ts: "1.1", user: "U1", text, isDirect: false, files: [], ...extra });
const posts = () => h.calls.filter(([k]) => k === "post").map((c) => c[3] as string);
const reactions = () => h.calls.filter(([k]) => k === "react" || k === "unreact").map((c) => `${c[0]}:${c[3]}`);

async function started(opts: Record<string, unknown> = {}) {
	const dataDir = mkdtempSync(join(tmpdir(), "bot-"));
	const bot = createSlackBot({ appToken: "xapp-1", botToken: "xoxb-1", allowedUsers: ["U1"], dataDir, ...opts });
	await bot.start();
	return { bot, dataDir };
}

beforeEach(() => {
	h.calls = [];
	h.busy = false;
	h.run = async () => ({ text: "All done.", aborted: false, tools: 3 });
});

describe("createSlackBot", () => {
	it("validates its options", () => {
		expect(() => createSlackBot({ appToken: "xoxb-1", botToken: "xoxb-1", allowedUsers: ["U1"], dataDir: "/tmp" })).toThrow("appToken");
		expect(() => createSlackBot({ appToken: "xapp-1", botToken: "xoxb-1", allowedUsers: [" "], dataDir: "/tmp" })).toThrow("allowedUsers");
	});

	it("greets allowed users at startup and warns about a second process", async () => {
		await started();
		const dms = h.calls.filter(([k]) => k === "dm").map((c) => c[2] as string);
		expect(dms.some((t) => t.includes("2 connections"))).toBe(true);
		expect(dms.some((t) => t.startsWith("pi-mom-slack is up.\nFirst start."))).toBe(true);
	});

	it("refuses unknown users without running anything", async () => {
		await started();
		h.run = vi.fn();
		await h.handler!(msg("hi", { user: "U9", mentioned: true }));
		expect(posts().at(-1)).toContain("Not authorized");
		expect(h.run).not.toHaveBeenCalled();
		// A colleague replying in a thread the bot follows, without mentioning it: ignored silently.
		const before = posts().length;
		await h.handler!(msg("on se voit à 14 h ?", { user: "U9" }));
		expect(posts().length).toBe(before);
	});

	it("runs a request: 👀, status, reply with the sender name, then ✅, marker cleared", async () => {
		const beforeRun = vi.fn();
		const afterRun = vi.fn();
		const { dataDir } = await started({ hooks: { beforeRun, afterRun } });
		let seen = "";
		h.run = async (_t, text) => { seen = text; return { text: "All done.", aborted: false, tools: 3 }; };
		await h.handler!(msg("ask <@U2> about it"));
		expect(seen).toBe("[Ada] ask @Bob about it");
		expect(reactions()).toEqual(["react:eyes", "unreact:eyes", "react:white_check_mark"]);
		expect(posts()).toEqual(["_Working…_", "All done."]);
		expect(h.calls.some(([k, , , t]) => k === "update" && String(t).startsWith("_Done · 3 action(s)"))).toBe(true);
		expect(beforeRun).toHaveBeenCalledWith(expect.objectContaining({ user: "U1", resumed: false }));
		expect(afterRun).toHaveBeenCalledWith(expect.anything(), { text: "All done.", aborted: false, tools: 3 }, undefined);
		expect(new RunMarkers(dataDir).list()).toEqual([]);
	});

	it("lets beforeRun replace the text given to the model", async () => {
		await started({ hooks: { beforeRun: ({ text }: { text: string }) => `${text} (be brief)` } });
		let seen = "";
		h.run = async (_t, text) => { seen = text; return { text: "ok", aborted: false, tools: 0 }; };
		await h.handler!(msg("hi"));
		expect(seen).toBe("[Ada] hi (be brief)");
	});

	it("reports a failed run in the thread with ⚠️", async () => {
		await started();
		h.run = async () => { throw new Error("no API key for anthropic"); };
		await h.handler!(msg("hi"));
		expect(posts().at(-1)).toBe("_Error: no API key for anthropic_");
		expect(reactions()).toEqual(["react:eyes", "unreact:eyes", "react:warning"]);
	});

	it("answers built-in and custom commands without starting a run", async () => {
		const deploy = vi.fn(async ({ args }: { args: string }) => `deploying ${args}`);
		await started({ commands: { deploy } });
		h.run = vi.fn();
		await h.handler!(msg("!status"));
		await h.handler!(msg("!model default opus"));
		await h.handler!(msg("!deploy staging"));
		await h.handler!(msg("!help"));
		expect(posts()[0]).toContain("idle · model `anthropic/claude-opus-5-5`");
		expect(posts()[1]).toBe("switched opus true");
		expect(posts()[2]).toBe("deploying staging");
		expect(posts()[3]).toContain("`!deploy`");
		expect(h.run).not.toHaveBeenCalled();
	});

	it("refuses a second request while the thread is busy", async () => {
		await started();
		h.busy = true;
		h.run = vi.fn();
		await h.handler!(msg("again"));
		expect(posts().at(-1)).toContain("Still working");
		expect(h.run).not.toHaveBeenCalled();
	});

	it("resumes a run interrupted by a restart, then gives up after two attempts", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "bot-"));
		new RunMarkers(dataDir).start({ channel: "C1", threadTs: "1.1", user: "U1" });
		const resumed = vi.fn(async () => ({ text: "Resumed and finished.", aborted: false, tools: 1 }));
		h.run = resumed;
		const opts = { appToken: "xapp-1", botToken: "xoxb-1", allowedUsers: ["U1"], dataDir };
		await createSlackBot(opts).start();
		await vi.waitFor(() => expect(posts()).toContain("Resumed and finished."));
		expect(posts()).toContain("Resuming after a restart.");
		expect(new RunMarkers(dataDir).list()).toEqual([]);

		// A marker that already failed twice is abandoned instead of looping.
		h.calls = [];
		new RunMarkers(dataDir).start({ channel: "C1", threadTs: "1.1", user: "U1", attempts: 2 });
		await createSlackBot(opts).start();
		await vi.waitFor(() => expect(posts().some((p) => p.includes("abandoned after 2 attempts"))).toBe(true));
		expect(resumed).toHaveBeenCalledTimes(1);
		expect(readdirSync(join(dataDir, "active-runs"))).toEqual([]);
	});

	it("records a clean stop for the next startup message", async () => {
		const { bot, dataDir } = await started();
		await bot.stop("SIGTERM");
		expect(existsSync(join(dataDir, "bot-state.json"))).toBe(true);
		h.calls = [];
		await createSlackBot({ appToken: "xapp-1", botToken: "xoxb-1", allowedUsers: ["U1"], dataDir }).start();
		expect(h.calls.some(([k, , t]) => k === "dm" && /Stopped on request at .* \(SIGTERM\)|clean stop/.test(String(t)))).toBe(true);
	});
});
