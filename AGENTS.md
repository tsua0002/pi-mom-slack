# pi-mom-slack: notes for agents working on this repository

A Slack bot for the pi coding agent, published on npm. One pi session per Slack thread.
Goal: the simplest setup (manifest, three variables, `npx pi-mom-slack`), robust, always on the latest pi.

## Layout

- `src/slack.ts`: Socket Mode transport and Slack Web API calls. `@slack/socket-mode` 3.x never emits `events_api`:
  listen to `slack_event` and filter on `type === "events_api"`.
- `src/agent.ts`: pi sessions (`createAgentSession`, `SessionManager.continueRecent`), one working directory per thread.
- `src/bot.ts`: `createSlackBot`, commands, reactions, run markers, resume after restart, startup message.
- `src/cli.ts`: the `npx` entry point. `src/index.ts`: the public API.
- `test/`: vitest. `test/pi-session.test.ts` runs a real pi session against a local scripted OpenAI-compatible server.

## Rules

- `npm run check` and `npm test` must pass before any commit. Tests never use the network.
- TypeScript runs with Node's type stripping: no enums, no parameter properties, relative imports end in `.ts`.
  `npm run build` compiles to `dist/` and rewrites the extensions.
- Dependencies on pi are pinned exactly; `typebox` is pinned to the version pi uses, so there is one copy.
- Never put a token in argv, logs or Slack messages. The agent's shell gets a scrubbed environment (`src/agent-env.ts`).
- Public API changes go in `README.md` and `CHANGELOG.md`.
- No em dash in user-facing text.
