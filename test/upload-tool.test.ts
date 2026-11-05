import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { confinedFile, slackUploadTool } from "../src/upload-tool.ts";

function setup() {
	const root = mkdtempSync(join(tmpdir(), "up-"));
	const ws = join(root, "thread");
	mkdirSync(join(ws, "out"), { recursive: true });
	writeFileSync(join(ws, "out", "report.md"), "# report");
	writeFileSync(join(root, "secret.txt"), "nope");
	symlinkSync(join(root, "secret.txt"), join(ws, "link.txt"));
	return { root, ws };
}

it("accepts files inside the workspace only, symlinks included", () => {
	const { root, ws } = setup();
	const report = realpathSync(join(ws, "out", "report.md"));
	expect(confinedFile(ws, "out/report.md")).toBe(report);
	expect(confinedFile(ws, join(ws, "out", "report.md"))).toBe(report);
	expect(() => confinedFile(ws, "../secret.txt")).toThrow("outside");
	expect(() => confinedFile(ws, join(root, "secret.txt"))).toThrow("outside");
	expect(() => confinedFile(ws, "link.txt")).toThrow("outside");
	expect(() => confinedFile(ws, "out")).toThrow("not a regular file");
	expect(() => confinedFile(ws, "missing.txt")).toThrow("not found");
});

it("sends the file to the thread through the upload callback", async () => {
	const { ws } = setup();
	const upload = vi.fn(async () => {});
	const tool = slackUploadTool(ws, upload);
	expect(tool.name).toBe("slack_upload");
	const r = await tool.execute("id", { path: "out/report.md", comment: "here it is" }, undefined, undefined, undefined as never);
	expect(upload).toHaveBeenCalledWith(Buffer.from("# report"), "report.md", "here it is");
	expect(r.content[0]).toEqual({ type: "text", text: "Sent report.md to the thread." });
	await expect(tool.execute("id", { path: "../secret.txt" }, undefined, undefined, undefined as never)).rejects.toThrow("outside");
	expect(upload).toHaveBeenCalledTimes(1);
});
