/**
 * Points .pi-sdk at the node_modules of the installed pi, so tsconfig paths
 * stay stable across pi updates.
 *
 *   node scripts/link-pi.mjs        (PI_SDK=/path/to/node_modules overrides)
 */
import { existsSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const managed = join(homedir(), ".pi", "agent", "install");
const candidates = [
	process.env.PI_SDK,
	existsSync(join(managed, "current-version")) &&
		join(managed, "releases", readFileSync(join(managed, "current-version"), "utf8").trim(), "node_modules"),
].filter(Boolean);

const sdk = candidates.find((dir) => existsSync(join(dir, "@earendil-works", "pi-coding-agent")) && existsSync(join(dir, "@earendil-works", "pi-tui")));
if (!sdk) {
	console.error(`pi not found; tried:\n  ${candidates.join("\n  ")}\nSet PI_SDK to the node_modules that holds @earendil-works/pi-coding-agent.`);
	process.exit(1);
}

const link = new URL("../.pi-sdk", import.meta.url).pathname;
rmSync(link, { force: true });
symlinkSync(sdk, link, "dir");
console.error(`.pi-sdk → ${sdk}`);
