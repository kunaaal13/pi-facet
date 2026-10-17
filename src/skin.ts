/**
 * Skins: the colour + glyph system for everything pi-minimal-tui draws.
 *
 * A skin is JSON: { name, appearance, piTheme?, shiki?, colors, glyphs }.
 * Colour values may be "#rrggbb", any pi colour syntax (oklch(), okhsl(), 0-255),
 * the name of another skin token ("accent"), or "pi:<token>" to borrow from the
 * active pi theme. Built-in skins live in ../skins, user skins in
 * ~/.pi/agent/pi-minimal-tui/skins (same name overrides a built-in).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Theme, ThemeToken } from "@earendil-works/pi-coding-agent";
import { backgroundAnsi, type Color, colorToHex, foregroundAnsi, mixColors, parseColor } from "@earendil-works/pi-tui";
import { type Config, LEGACY_USER_SKINS_DIR, USER_SKINS_DIR } from "./config.ts";

export const COLOR_TOKENS = [
	"band", // user prompt band, popups
	"panel", // code / output panels
	"text",
	"textSecondary",
	"muted",
	"dim",
	"accent", // spinners, focus, labels
	"toolBullet", // ◆ on finished tool rows
	"replyBullet", // ◆ on the model's replies
	"prompt", // ❯ in the input and your message boxes
	"thinking",
	"running",
	"path",
	"pattern",
	"command",
	"success",
	"error",
	"warning",
	"info",
	"model",
	"timestamp",
	"border",
	"borderActive",
	"borderBash",
	"diffAddBg",
	"diffDelBg",
	"diffAddWordBg",
	"diffDelWordBg",
	"diffAddFg",
	"diffDelFg",
	"diffContextFg",
	"gutter",
	"stripe",
	"h1",
	"h2",
	"h3",
	"h4",
	"code",
	"link",
	"bullet",
] as const;
export type ColorToken = (typeof COLOR_TOKENS)[number];

export interface Glyphs {
	prompt: string;
	bullet: string;
	/** Thinking rows (Claude Code's "∴"). */
	thinking: string;
	/** Markdown list marker ("•", or "-" like Claude Code). */
	listBullet: string;
	bulletHollow: string;
	group: string;
	rail: string;
	success: string;
	error: string;
	ellipsis: string;
	tokens: string;
	sep: string;
	stripe: string;
	expand: string;
	collapse: string;
	spinner: string[];
	agentSpinner: string[];
	border: { tl: string; tr: string; bl: string; br: string; h: string; v: string };
}

export const DEFAULT_GLYPHS: Glyphs = {
	prompt: "❯",
	bullet: "◆",
	thinking: "∴",
	listBullet: "•",
	bulletHollow: "◇",
	group: "◈",
	rail: "┃",
	success: "✓",
	error: "✗",
	ellipsis: "…",
	tokens: "⇣",
	sep: "·",
	stripe: "╱",
	expand: "▸",
	collapse: "▾",
	spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"],
	agentSpinner: ["⋅", ":", "⸬", "⁙"],
	border: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
};

export interface SkinFile {
	name?: string;
	appearance?: "dark" | "light";
	piTheme?: string;
	shiki?: string;
	colors?: Partial<Record<ColorToken, string>>;
	glyphs?: Partial<Glyphs>;
	style?: { codeBold?: boolean };
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const BUILTIN_SKINS_DIR = join(HERE, "..", "skins");

/** The "auto" skin: derive everything from the active pi theme so any pi theme works. */
const AUTO_SKIN: SkinFile = {
	name: "auto",
	colors: {
		band: "pi:userMessageBg",
		panel: "pi:toolPendingBg",
		text: "pi:text",
		textSecondary: "pi:userMessageText",
		muted: "pi:muted",
		dim: "pi:dim",
		accent: "pi:accent",
		toolBullet: "accent",
		replyBullet: "textSecondary",
		prompt: "accent",
		thinking: "pi:thinkingText",
		running: "pi:accent",
		path: "pi:mdLink",
		pattern: "pi:success",
		command: "pi:warning",
		success: "pi:success",
		error: "pi:error",
		warning: "pi:warning",
		info: "pi:mdLink",
		model: "pi:accent",
		timestamp: "pi:dim",
		border: "pi:borderMuted",
		borderActive: "pi:border",
		borderBash: "pi:bashMode",
		diffAddFg: "pi:toolDiffAdded",
		diffDelFg: "pi:toolDiffRemoved",
		diffContextFg: "pi:toolDiffContext",
		gutter: "pi:dim",
		stripe: "pi:borderMuted",
		h1: "pi:mdHeading",
		h2: "pi:mdHeading",
		h3: "pi:mdHeading",
		h4: "pi:mdHeading",
		code: "pi:mdCode",
		link: "pi:mdLink",
		bullet: "pi:mdListBullet",
	},
};

export function listSkins(): string[] {
	const names = new Set<string>(["auto"]);
	for (const dir of [BUILTIN_SKINS_DIR, LEGACY_USER_SKINS_DIR, USER_SKINS_DIR]) {
		if (!existsSync(dir)) continue;
		for (const file of readdirSync(dir)) if (file.endsWith(".json")) names.add(basename(file, ".json"));
	}
	return [...names].sort();
}

export function readSkinFile(name: string): { skin?: SkinFile; error?: string } {
	if (name === "auto") return { skin: AUTO_SKIN };
	for (const dir of [USER_SKINS_DIR, LEGACY_USER_SKINS_DIR, BUILTIN_SKINS_DIR]) {
		const path = join(dir, `${name}.json`);
		if (!existsSync(path)) continue;
		try {
			return { skin: JSON.parse(readFileSync(path, "utf8")) as SkinFile };
		} catch (err) {
			return { error: `${path}: ${err instanceof Error ? err.message : String(err)}` };
		}
	}
	return { error: `Unknown skin "${name}"` };
}

const ESC = "\x1b[";
export const RESET_FG = `${ESC}39m`;
export const RESET_BG = `${ESC}49m`;
export const RESET = `${ESC}0m`;

/** A resolved skin bound to the current terminal colour mode. */
export class Skin {
	readonly name: string;
	readonly appearance: "dark" | "light";
	readonly piTheme?: string;
	readonly shikiDefault: string;
	readonly glyphs: Glyphs;
	readonly codeBold: boolean;
	private readonly hex = new Map<ColorToken, string>();
	private readonly fgCache = new Map<string, string>();
	private readonly bgCache = new Map<string, string>();
	private readonly mode: ReturnType<Theme["getColorMode"]>;

	constructor(file: SkinFile, piTheme: Theme, config: Config) {
		this.name = file.name ?? "custom";
		this.mode = piTheme.getColorMode();
		this.appearance = file.appearance ?? (piTheme.appearance === "light" ? "light" : "dark");
		this.piTheme = file.piTheme;
		this.shikiDefault = file.shiki ?? (this.appearance === "light" ? "github-light" : "tokyo-night");

		// Missing tokens fall back to the auto skin, so partial custom skins are fine.
		const raw: Record<string, string> = { ...AUTO_SKIN.colors, ...file.colors, ...config.colors } as Record<string, string>;
		const resolving = new Set<string>();
		const resolve = (token: string): string | undefined => {
			const value = raw[token];
			if (value === undefined || resolving.has(token)) return undefined;
			resolving.add(token);
			try {
				return this.resolveValue(value, piTheme, resolve);
			} finally {
				resolving.delete(token);
			}
		};
		for (const token of COLOR_TOKENS) {
			const value = resolve(token);
			if (value) this.hex.set(token, value);
		}
		this.deriveMissing();

		const glyphs = { ...DEFAULT_GLYPHS, ...file.glyphs, ...config.glyphs } as Glyphs;
		glyphs.border = { ...DEFAULT_GLYPHS.border, ...(file.glyphs?.border ?? {}), ...((config.glyphs as Partial<Glyphs>).border ?? {}) };
		this.glyphs = glyphs;
		this.codeBold = file.style?.codeBold ?? true;
	}

	private resolveValue(value: string, piTheme: Theme, resolve: (token: string) => string | undefined): string | undefined {
		if (value.startsWith("pi:")) {
			const color = (piTheme.colors as Record<string, Color | undefined>)[value.slice(3) as ThemeToken];
			return color ? safeHex(color) : undefined;
		}
		if ((COLOR_TOKENS as readonly string[]).includes(value)) return resolve(value);
		try {
			return safeHex(parseColor(value));
		} catch {
			return undefined;
		}
	}

	/** Diff backgrounds are mixed from the diff foregrounds when a skin doesn't set them. */
	private deriveMissing(): void {
		const base = this.hex.get("panel") ?? (this.appearance === "light" ? "#ffffff" : "#1c1c1c");
		const mix = (token: ColorToken, from: ColorToken, amount: number) => {
			if (this.hex.has(token)) return;
			const fg = this.hex.get(from);
			if (!fg) return;
			this.hex.set(token, colorToHex(mixColors(parseColor(base), parseColor(fg), amount)));
		};
		mix("diffAddBg", "diffAddFg", 0.16);
		mix("diffDelBg", "diffDelFg", 0.16);
		mix("diffAddWordBg", "diffAddFg", 0.34);
		mix("diffDelWordBg", "diffDelFg", 0.34);
	}

	color(token: ColorToken): string | undefined {
		return this.hex.get(token);
	}

	fgAnsi(token: ColorToken | string): string {
		const hex = this.hex.get(token as ColorToken) ?? (token.startsWith("#") ? token : undefined);
		if (!hex) return "";
		let cached = this.fgCache.get(hex);
		if (cached === undefined) {
			cached = foregroundAnsi(parseColor(hex), this.mode);
			this.fgCache.set(hex, cached);
		}
		return cached;
	}

	bgAnsi(token: ColorToken | string): string {
		const hex = this.hex.get(token as ColorToken) ?? (token.startsWith("#") ? token : undefined);
		if (!hex) return "";
		let cached = this.bgCache.get(hex);
		if (cached === undefined) {
			cached = backgroundAnsi(parseColor(hex), this.mode);
			this.bgCache.set(hex, cached);
		}
		return cached;
	}

	fg(token: ColorToken, text: string): string {
		const code = this.fgAnsi(token);
		return code ? `${code}${text}${RESET_FG}` : text;
	}

	bg(token: ColorToken, text: string): string {
		const code = this.bgAnsi(token);
		return code ? `${code}${text}${RESET_BG}` : text;
	}

	bold(text: string): string {
		return `${ESC}1m${text}${ESC}22m`;
	}

	italic(text: string): string {
		return `${ESC}3m${text}${ESC}23m`;
	}

	/** Blend two tokens (0 = a, 1 = b); used for pulses and fades. */
	blendAnsi(a: ColorToken, b: ColorToken, amount: number): string {
		const ha = this.hex.get(a);
		const hb = this.hex.get(b);
		if (!ha || !hb) return this.fgAnsi(a);
		const key = `${ha}${hb}${Math.round(amount * 20)}`;
		let cached = this.fgCache.get(key);
		if (cached === undefined) {
			cached = foregroundAnsi(mixColors(parseColor(ha), parseColor(hb), Math.round(amount * 20) / 20), this.mode);
			this.fgCache.set(key, cached);
		}
		return cached;
	}
}

function safeHex(color: Color): string | undefined {
	try {
		return colorToHex(color);
	} catch {
		return undefined;
	}
}
