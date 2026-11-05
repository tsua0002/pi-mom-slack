/**
 * `slack_upload`: the agent sends a file from its thread workspace into the thread. Paths are resolved against the
 * workspace and must stay inside it, symlinks included.
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const MAX_UPLOAD = 50 * 1024 * 1024;

/** Absolute real path of `path` if it is a regular file inside `workspace`; throws otherwise. */
export function confinedFile(workspace: string, path: string): string {
	const root = realpathSync(workspace);
	let real: string;
	try {
		real = realpathSync(resolve(root, path));
	} catch {
		throw new Error(`file not found: ${path}`);
	}
	const rel = relative(root, real);
	if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`refused: ${path} is outside the thread workspace`);
	const st = statSync(real);
	if (!st.isFile()) throw new Error(`not a regular file: ${path}`);
	if (st.size > MAX_UPLOAD) throw new Error(`file too large (${Math.round(st.size / 1e6)} MB, max ${MAX_UPLOAD / 1e6} MB)`);
	return real;
}

export function slackUploadTool(workspace: string, upload: (file: Buffer, filename: string, comment?: string) => Promise<void>) {
	return defineTool({
		name: "slack_upload",
		label: "Send a file to Slack",
		description:
			"Send a file from the working directory into this Slack thread (a report, an image, a build output). The path is relative to the working directory; files outside it are refused.",
		promptSnippet: "slack_upload: send a file of the working directory into the Slack thread",
		parameters: Type.Object({
			path: Type.String({ description: "File path, relative to the working directory" }),
			comment: Type.Optional(Type.String({ description: "Short message posted with the file" })),
		}),
		execute: async (_id, { path, comment }) => {
			const real = confinedFile(workspace, path);
			await upload(readFileSync(real), basename(real), comment);
			return { content: [{ type: "text", text: `Sent ${basename(real)} to the thread.` }], details: {} };
		},
	});
}
