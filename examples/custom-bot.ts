/**
 * A bot with team notes: a pi tool to add a note, a `!notes` command to read them, and a hook that gives the notes
 * to the model before every run. Shows every extension point of createSlackBot.
 *
 *   SLACK_APP_TOKEN=xapp-… SLACK_BOT_TOKEN=xoxb-… PI_SLACK_ALLOWED_USERS=U… node examples/custom-bot.ts
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { configFromEnv, createSlackBot, DEFAULT_SYSTEM_NOTE } from "pi-mom-slack";

const config = configFromEnv();
const notesFile = join(config.dataDir, "team-notes.md");
const readNotes = () => (existsSync(notesFile) ? readFileSync(notesFile, "utf8").trim() : "");

const bot = createSlackBot({
	...config,
	systemNote: `${DEFAULT_SYSTEM_NOTE}\nWhen someone states a team convention or decision, save it with team_note.`,

	// Built once per thread: `thread` gives the channel, the workspace, and post/upload helpers.
	customTools: (thread) => [
		defineTool({
			name: "team_note",
			label: "Save a team note",
			description: "Save a short note (convention, decision) shared by every thread.",
			parameters: Type.Object({ note: Type.String() }),
			execute: async (_id, { note }) => {
				mkdirSync(config.dataDir, { recursive: true });
				appendFileSync(notesFile, `- ${note} (from thread ${thread.key})\n`);
				return { content: [{ type: "text", text: "Saved." }], details: {} };
			},
		}),
	],

	// `!notes` in any thread. Returned text is posted in the thread.
	commands: {
		notes: () => readNotes() || "_No notes yet._",
	},

	hooks: {
		// Return a string to replace what the model receives.
		beforeRun: ({ text }) => {
			const notes = readNotes();
			return notes ? `Team notes:\n${notes}\n\n${text}` : text;
		},
		afterRun: ({ thread }, result, error) => {
			console.log(`[notes-bot] ${thread.key}: ${error ? "failed" : `${result?.tools ?? 0} tool call(s)`}`);
		},
	},
});

process.on("SIGINT", () => void bot.stop("SIGINT").finally(() => process.exit(0)));
process.on("SIGTERM", () => void bot.stop("SIGTERM").finally(() => process.exit(0)));
await bot.start();
