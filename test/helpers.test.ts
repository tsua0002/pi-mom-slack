import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scrubEnv } from "../src/agent-env.ts";
import { looksLikeAnnouncement, threadKey } from "../src/agent.ts";
import { safeName, saveAttachments } from "../src/attachments.ts";
import { configFromEnv, loadEnvFile, parseUsers } from "../src/config.ts";
import { formatModels, resolveModel } from "../src/models.ts";
import { RunMarkers } from "../src/run-markers.ts";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

describe("config", () => {
	it("reads KEY=VALUE, ignores comments, never overrides the environment", () => {
		const f = join(tmp("env-"), ".env");
		writeFileSync(f, "# x\nA=1\nexport B=\"two\"\nC = 3\n");
		const env: NodeJS.ProcessEnv = { C: "env" };
		expect(loadEnvFile(f, env)).toEqual(["A", "B", "C"]);
		expect(env).toEqual({ A: "1", B: "two", C: "env" });
		expect(loadEnvFile(join(tmpdir(), "missing.env"), env)).toEqual([]);
	});

	it("requires the three variables and never prints their values", () => {
		expect(() => configFromEnv({})).toThrow(/SLACK_APP_TOKEN[\s\S]*SLACK_BOT_TOKEN[\s\S]*PI_SLACK_ALLOWED_USERS/);
		try {
			configFromEnv({ SLACK_APP_TOKEN: "xoxb-secret-in-wrong-place", SLACK_BOT_TOKEN: "xoxb-1", PI_SLACK_ALLOWED_USERS: "U1" });
		} catch (e) {
			expect(String(e)).not.toContain("secret");
		}
		const c = configFromEnv({ SLACK_APP_TOKEN: "xapp-1", SLACK_BOT_TOKEN: "xoxb-1", PI_SLACK_ALLOWED_USERS: " U1, U2 ,", PI_SLACK_DATA_DIR: "/srv/pi" });
		expect(c.allowedUsers).toEqual(["U1", "U2"]);
		expect(c.dataDir).toBe("/srv/pi");
		expect(parseUsers(undefined)).toEqual([]);
	});
});

describe("scrubEnv", () => {
	it("removes env-file names and credential-looking variables, keeps the rest", () => {
		const env = { PATH: "/bin", HOME: "/h", SLACK_BOT_TOKEN: "x", SLACK_APP_TOKEN: "y", OPENAI_API_KEY: "k", MY_SETTING: "s", PI_SLACK_ALLOWED_USERS: "U1" };
		expect(scrubEnv(env, ["MY_SETTING"])).toEqual({ PATH: "/bin", HOME: "/h", PI_SLACK_ALLOWED_USERS: "U1" });
		expect(env.SLACK_BOT_TOKEN).toBe("x");
	});
});

describe("attachments", () => {
	it("saves every file, returns images inline, and reports failures", async () => {
		const ws = tmp("att-");
		const files = [
			{ name: "mockup.png", mimetype: "image/png", size: 3, url: "u1" },
			{ name: "../../spec sheet.pdf", mimetype: "application/pdf", size: 3, url: "u2" },
			{ name: "broken.png", mimetype: "image/png", size: 3, url: "u3" },
		];
		const r = await saveAttachments(files, ws, async (url) => {
			if (url === "u3") throw new Error("HTTP 403");
			return Buffer.from(url);
		}, 42);
		expect(r.saved).toEqual(["files/42/01-mockup.png", "files/42/02-spec_sheet.pdf"]);
		expect(readFileSync(join(ws, r.saved[1]!), "utf8")).toBe("u2");
		expect(r.images).toEqual([{ type: "image", data: Buffer.from("u1").toString("base64"), mimeType: "image/png" }]);
		expect(r.errors[0]).toContain("HTTP 403");
		expect(safeName("", 0)).toBe("01-file");
	});
});

describe("models", () => {
	const models = [
		{ provider: "anthropic", id: "claude-opus-5-5", input: ["text", "image"], reasoning: true },
		{ provider: "anthropic", id: "claude-sonnet-5-5", input: ["text", "image"] },
		{ provider: "openrouter", id: "anthropic/claude-sonnet-5-5" },
		{ provider: "mistral", id: "mistral-large" },
	];
	it("resolves exact, short and ambiguous names", () => {
		expect(resolveModel("anthropic/claude-opus-5-5", models)).toEqual({ model: models[0] });
		expect(resolveModel("opus", models)).toEqual({ model: models[0] });
		expect(resolveModel("mistral-large", models)).toEqual({ model: models[3] });
		const amb = resolveModel("sonnet", models);
		expect("error" in amb && amb.error).toContain("Several models");
		expect("error" in resolveModel("gpt", models)).toBe(true);
	});
	it("lists models by provider, marks the current one, explains an empty list", () => {
		const out = formatModels(models, models[0]);
		expect(out).toContain("Model of this thread: `anthropic/claude-opus-5-5`");
		expect(out).toContain("→ `claude-opus-5-5` (images, reasoning)");
		expect(out).toContain("*mistral*");
		expect(formatModels([], undefined)).toContain("/login");
		const many = Array.from({ length: 50 }, (_, i) => ({ provider: i < 45 ? "openai" : "anthropic", id: `m${i}` }));
		const short = formatModels(many, many[47]);
		expect(short.indexOf("*anthropic*")).toBeLessThan(short.indexOf("*openai*"));
		expect(short).toContain("→ `m47`");
		expect(short).toContain("… and 20 more across 2 provider(s).");
	});
});

describe("run markers", () => {
	it("persist across instances and clear only the finished thread", () => {
		const dir = tmp("runs-");
		try {
			const a = { channel: "C123", threadTs: "123.456", user: "U123" };
			const b = { channel: "D123", threadTs: "123.457", user: "U123" };
			const first = new RunMarkers(dir);
			first.start(a);
			first.start(b);
			const restarted = new RunMarkers(dir);
			expect(restarted.list()).toEqual(expect.arrayContaining([a, b]));
			restarted.finish(a);
			expect(first.list()).toEqual([b]);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});
	it("count resume attempts and skip invalid files", () => {
		const dir = tmp("runs-");
		try {
			const m = new RunMarkers(dir);
			m.start({ channel: "C1", threadTs: "1.2", user: "U1" });
			expect(m.bump(m.list()[0]!)).toBe(1);
			expect(new RunMarkers(dir).bump(new RunMarkers(dir).list()[0]!)).toBe(2);
			writeFileSync(join(dir, "active-runs", `${"0".repeat(64)}.json`), "{not json");
			const bad: string[] = [];
			expect(new RunMarkers(dir).list((f) => bad.push(f))).toHaveLength(1);
			expect(bad).toHaveLength(1);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});
});

describe("agent helpers", () => {
	it("thread keys are filesystem safe", () => {
		expect(threadKey("C123", "1730630400.123456")).toBe("C123-1730630400_123456");
	});
	it("detects a reply that only announces work", () => {
		expect(looksLikeAnnouncement("Got it. I'll now write the script and run it.")).toBe(true);
		expect(looksLikeAnnouncement("Parfait, je vais créer le fichier.")).toBe(true);
		expect(looksLikeAnnouncement("Here is the plan:")).toBe(true);
		expect(looksLikeAnnouncement("Done: `report.md` is in the working directory. Nothing left.")).toBe(false);
		expect(looksLikeAnnouncement("Should I use Postgres or SQLite? I'll go with your choice.")).toBe(false);
		expect(looksLikeAnnouncement("")).toBe(false);
	});
});
