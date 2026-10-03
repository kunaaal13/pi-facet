/**
 * Configuration: ~/.pi/agent/pi-facet.json, overridden per project by
 * <cwd>/.pi/pi-facet.json. Loaded once per session (and on /tui reload),
 * never on render paths.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type DiffLayout = "auto" | "unified" | "split";

export interface Config {
	/** Skin name: a built-in (groknight, grokday, auto) or a file in ~/.pi/agent/pi-facet/skins. */
	theme: string;
	/** Also switch pi's own theme to the skin's `piTheme` when the skin is applied. */
	applyPiTheme: boolean;
	/** Per-token colour overrides layered on top of the skin. */
	colors: Record<string, string>;
	/** Glyph overrides layered on top of the skin. */
	glyphs: Record<string, string | string[]>;
	shiki: {
		/** Shiki theme for dark skins: a bundled name ("tokyo-night") or a path to a VS Code/TextMate theme JSON. Empty = skin default. */
		theme: string;
		/** Shiki theme for light skins. Empty = skin default. */
		lightTheme: string;
		/** Skip highlighting above this many characters. */
		maxChars: number;
		cacheSize: number;
		/** Lift token colours that are too dark (or too light on light skins) to read. */
		fixContrast: boolean;
	};
	diff: {
		layout: DiffLayout;
		splitMinWidth: number;
		splitMinCodeWidth: number;
		wordDiff: boolean;
		/** Max diff rows when collapsed (Ctrl+O shows everything). */
		maxLines: number;
		/** Max wrapped rows per long line. */
		maxWrapRows: number;
	};
	tools: {
		/** Edits/writes are expanded by default (Grok style). */
		expandEdits: boolean;
		bashHead: number;
		bashTail: number;
		/** Max rows when a tool is expanded with Ctrl+O. */
		expandedMaxLines: number;
		lineNumbers: boolean;
		/** Give other extensions' tools our bullet/indent instead of pi's grey box. */
		restyleOthers: boolean;
	};
	messages: {
		/** Time in the border of your message boxes. */
		timestamps: boolean;
		/** Time at the right edge of the model's replies. */
		replyTimestamps: boolean;
		/** "12h" → 8:19 PM, "24h" → 20:19 */
		timeFormat: "12h" | "24h";
		/** Collapse long prompts to this many lines (0 = never). */
		collapseUserAfter: number;
		/** How your messages (prompts, skills, !commands) look in the chat. */
		userStyle: "box" | "band" | "plain";
	};
	thinking: {
		showDuration: boolean;
		/** Trailing lines of live reasoning shown while thinking streams (0 = none). */
		streamPreviewLines: number;
	};
	chrome: {
		editor: boolean;
		/** Blank rows inside the input box above and below the text. */
		editorPaddingY: number;
		/** Input caret: the terminal's own cursor as a thin bar / underline, or pi's painted block. */
		caret: "bar" | "underline" | "block";
		caretBlink: boolean;
		/** Tint the terminal cursor with the skin accent (bar/underline only). */
		caretAccent: boolean;
		workingRow: boolean;
		footer: boolean;
		title: boolean;
		header: boolean;
		placeholder: string;
		/** Footer (off by default): hint list as [key, label] pairs. */
		hints: Array<[string, string]>;
		/** Show other extensions' setStatus() entries on the right of the footer. */
		showStatuses: boolean;
	};
	subagents: {
		dock: boolean;
		maxRows: number;
		/** Keep finished agents visible for this long (ms). */
		lingerMs: number;
	};
	layout: {
		/** Fold runs of finished read/search/list rows into one summary line (Claude Code style). */
		groupTools: boolean;
		/** Stack consecutive one-line tool/thinking rows with no blank line between (Grok style). Off = one even blank line between every block. */
		stackRows: boolean;
	};
	animation: {
		intervalMs: number;
	};
}

export const DEFAULT_CONFIG: Config = {
	theme: "groknight",
	applyPiTheme: true,
	colors: {},
	glyphs: {},
	shiki: { theme: "", lightTheme: "", maxChars: 32_000, cacheSize: 128, fixContrast: true },
	diff: { layout: "auto", splitMinWidth: 150, splitMinCodeWidth: 60, wordDiff: true, maxLines: 60, maxWrapRows: 3 },
	tools: {
		expandEdits: true,
		bashHead: 2,
		bashTail: 3,
		expandedMaxLines: 4000,
		lineNumbers: true,
		restyleOthers: true,
	},
	messages: { timestamps: true, replyTimestamps: false, timeFormat: "12h", collapseUserAfter: 0, userStyle: "box" },
	thinking: { showDuration: true, streamPreviewLines: 3 },
	chrome: {
		editor: true,
		editorPaddingY: 0,
		caret: "bar",
		caretBlink: true,
		caretAccent: true,
		workingRow: true,
		footer: false,
		title: true,
		header: true,
		placeholder: "Build anything",
		hints: [
			["Shift+Tab", "thinking"],
			["Esc", "stop"],
			["Ctrl+o", "expand"],
			["Ctrl+t", "thoughts"],
		],
		showStatuses: false,
	},
	subagents: { dock: true, maxRows: 8, lingerMs: 4000 },
	layout: { groupTools: true, stackRows: false },
	animation: { intervalMs: 100 },
};

export const GLOBAL_CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-facet.json");
export const USER_SKINS_DIR = join(homedir(), ".pi", "agent", "pi-facet", "skins");

/** Paths from before the rename to pi-facet, read when the new ones don't exist yet. */
const LEGACY_NAME = "pi-minimal-tui";
export const LEGACY_USER_SKINS_DIR = join(homedir(), ".pi", "agent", LEGACY_NAME, "skins");

export function projectConfigPath(cwd: string): string {
	return join(cwd, ".pi", "pi-facet.json");
}

/** A config path if it exists, else its pre-rename sibling if that exists, else the new path. */
function withLegacy(path: string): string {
	if (existsSync(path)) return path;
	const legacy = join(dirname(path), `${LEGACY_NAME}.json`);
	return existsSync(legacy) ? legacy : path;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep merge where arrays and scalars from `over` replace those in `base`. */
export function deepMerge<T>(base: T, over: unknown): T {
	if (!isPlainObject(over)) return base;
	const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [key, value] of Object.entries(over)) {
		const current = out[key];
		out[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
	}
	return out as T;
}

function readJson(path: string): { value?: unknown; error?: string } {
	if (!existsSync(path)) return {};
	try {
		return { value: JSON.parse(readFileSync(path, "utf8")) };
	} catch (err) {
		return { error: `${path}: ${err instanceof Error ? err.message : String(err)}` };
	}
}

export interface LoadedConfig {
	config: Config;
	errors: string[];
}

export function loadConfig(cwd: string): LoadedConfig {
	const errors: string[] = [];
	let config = structuredClone(DEFAULT_CONFIG);
	for (const path of [withLegacy(GLOBAL_CONFIG_PATH), withLegacy(projectConfigPath(cwd))]) {
		const { value, error } = readJson(path);
		if (error) errors.push(error);
		if (value !== undefined) config = deepMerge(config, value);
	}
	return { config, errors };
}

/** Persist a single dotted key (e.g. "diff.layout") to the global config file. */
export function saveGlobalKey(path: string, value: unknown): void {
	// Seeds from the pre-rename file if that's all there is; the write below goes to the new path.
	const { value: existing } = readJson(withLegacy(GLOBAL_CONFIG_PATH));
	const root: Record<string, unknown> = isPlainObject(existing) ? existing : {};
	const parts = path.split(".");
	let node = root;
	for (const part of parts.slice(0, -1)) {
		if (!isPlainObject(node[part])) node[part] = {};
		node = node[part] as Record<string, unknown>;
	}
	node[parts[parts.length - 1]!] = value;
	mkdirSync(dirname(GLOBAL_CONFIG_PATH), { recursive: true });
	const tmp = `${GLOBAL_CONFIG_PATH}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(root, null, 2)}\n`);
	renameSync(tmp, GLOBAL_CONFIG_PATH);
}
