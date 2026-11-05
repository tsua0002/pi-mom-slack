/**
 * Slack attachments: every file is saved in the thread workspace (files/<stamp>/), so the agent can use it with its
 * tools; images are also returned inline, for models that read images.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { SlackFile } from "./slack.ts";

export const MAX_FILE = 25 * 1024 * 1024;
const MAX_IMAGE = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export interface Attachments {
	/** Paths relative to the workspace. */
	saved: string[];
	images: ImageContent[];
	errors: string[];
}

export function safeName(name: string, index: number): string {
	const clean = basename(name).replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^\.+/, "") || "file";
	return `${String(index + 1).padStart(2, "0")}-${clean}`.slice(0, 120);
}

export async function saveAttachments(
	files: SlackFile[],
	workspace: string,
	download: (url: string, maxBytes: number) => Promise<Buffer>,
	stamp = Date.now(),
): Promise<Attachments> {
	const out: Attachments = { saved: [], images: [], errors: [] };
	if (files.length === 0) return out;
	const rel = join("files", String(stamp));
	mkdirSync(join(workspace, rel), { recursive: true });
	for (const [i, f] of files.entries()) {
		try {
			const buf = await download(f.url, MAX_FILE);
			const path = join(rel, safeName(f.name, i));
			writeFileSync(join(workspace, path), buf);
			out.saved.push(path);
			if (IMAGE_TYPES.has(f.mimetype) && buf.length <= MAX_IMAGE) out.images.push({ type: "image", data: buf.toString("base64"), mimeType: f.mimetype });
		} catch (e) {
			out.errors.push(`${f.name}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	return out;
}
