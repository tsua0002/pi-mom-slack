import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { VERSION as piVersion } from "@earendil-works/pi-coding-agent";

// Same relative location from src/ (tests) and dist/ (published package).
const root = new URL("../", import.meta.url);

export const VERSION: string = (JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as { version: string }).version;
export const PI_VERSION: string = piVersion;
export const CHANGELOG_PATH = fileURLToPath(new URL("CHANGELOG.md", root));
