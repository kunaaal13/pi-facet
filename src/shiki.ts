/**
 * Shiki highlighting, modelled on pi-claude-code-ui: lazy-loaded, LRU-cached,
 * contrast-normalised. Differences: we turn tokens into ANSI ourselves (no full
 * resets, so diff/panel backgrounds survive), custom theme JSON files are
 * supported, and once a grammar is loaded highlighting is synchronous — the
 * async path only runs the first time a language/theme is seen.
 */
import { existsSync, readFileSync } from "node:fs";
import { extname, basename } from "node:path";
import { getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import { foregroundAnsi, mixColors, parseColor } from "@earendil-works/pi-tui";
import type { BundledLanguage, Highlighter, ThemeRegistrationAny } from "shiki";
import { store } from "./state.ts";
import { expandTabs } from "./util.ts";

const FG_RESET = "\x1b[39m\x1b[22m\x1b[23m\x1b[24m";

const EXT_LANG: Record<string, string> = {
	ts: "typescript",
	mts: "typescript",
	cts: "typescript",
	tsx: "tsx",
	js: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	jsx: "jsx",
	py: "python",
	rb: "ruby",
	rs: "rust",
	go: "go",
	java: "java",
	kt: "kotlin",
	swift: "swift",
	c: "c",
	h: "c",
	cc: "cpp",
	cpp: "cpp",
	hpp: "cpp",
	cs: "csharp",
	php: "php",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	fish: "fish",
	json: "json",
	jsonc: "jsonc",
	json5: "json5",
	yml: "yaml",
	yaml: "yaml",
	toml: "toml",
	md: "markdown",
	mdx: "mdx",
	html: "html",
	css: "css",
	scss: "scss",
	less: "less",
	sql: "sql",
	vue: "vue",
	svelte: "svelte",
	astro: "astro",
	lua: "lua",
	zig: "zig",
	ex: "elixir",
	exs: "elixir",
	erl: "erlang",
	hs: "haskell",
	ml: "ocaml",
	scala: "scala",
	dart: "dart",
	r: "r",
	tf: "hcl",
	hcl: "hcl",
	proto: "proto",
	graphql: "graphql",
	gql: "graphql",
	xml: "xml",
	svg: "xml",
	dockerfile: "dockerfile",
	makefile: "makefile",
	nix: "nix",
	diff: "diff",
	patch: "diff",
	ini: "ini",
	env: "dotenv",
};

const FILE_LANG: Record<string, string> = {
	dockerfile: "dockerfile",
	makefile: "makefile",
	gemfile: "ruby",
	rakefile: "ruby",
	".bashrc": "bash",
	".zshrc": "bash",
	".env": "dotenv",
};

let shikiModule: typeof import("shiki") | undefined;
let highlighter: Highlighter | undefined;
let initPromise: Promise<void> | undefined;
let hlPromise: Promise<Highlighter> | undefined;
let initFailed = false;
let loadedKey = "";
const loadedLangs = new Set<string>();
const loadingLangs = new Map<string, Promise<void>>();
const failedLangs = new Set<string>();
const waiters = new Set<() => void>();
let themeName = "";
let themeKey = "";
let themeBg = "";
let themeFg = "";

const cache = new Map<string, string[]>();

export function langFromPath(path: string | undefined): string | undefined {
	if (!path) return undefined;
	const name = basename(path).toLowerCase();
	if (FILE_LANG[name]) return FILE_LANG[name];
	const ext = extname(name).slice(1);
	return EXT_LANG[ext] ?? getLanguageFromPath(path) ?? undefined;
}

function wantedTheme(): string {
	const { config, skin } = store;
	const dark = skin?.appearance !== "light";
	const configured = dark ? config.shiki.theme : config.shiki.lightTheme;
	return configured || skin?.shikiDefault || (dark ? "tokyo-night" : "github-light");
}

function notify(): void {
	const list = [...waiters];
	waiters.clear();
	for (const fn of list) {
		try {
			fn();
		} catch {
			// a stale component; ignore
		}
	}
	store.requestRender();
}

async function loadTheme(spec: string): Promise<void> {
	if (!highlighter || !shikiModule) return;
	let name = spec;
	if (spec.endsWith(".json") || spec.includes("/")) {
		const path = spec.startsWith("~") ? spec.replace("~", process.env.HOME ?? "") : spec;
		if (!existsSync(path)) throw new Error(`Shiki theme file not found: ${path}`);
		const json = JSON.parse(readFileSync(path, "utf8")) as ThemeRegistrationAny & { name?: string };
		json.name = json.name || basename(path, ".json");
		await highlighter.loadTheme(json);
		name = json.name;
	} else if (!highlighter.getLoadedThemes().includes(name)) {
		if (!(name in shikiModule.bundledThemes)) throw new Error(`Unknown Shiki theme "${name}"`);
		await highlighter.loadTheme(name as keyof typeof shikiModule.bundledThemes);
	}
	const reg = highlighter.getTheme(name);
	themeName = name;
	themeBg = reg.bg;
	themeFg = reg.fg;
}

/** Called after a (new) theme finishes loading so cached rows can repaint. */
let onThemeLoadedFn: (() => void) | undefined;
export function onThemeLoaded(fn: () => void): void {
	onThemeLoadedFn = fn;
}

/**
 * Load Shiki + the configured theme. Loads are chained so concurrent theme
 * switches settle on the latest one; highlighting waits until it's loaded.
 */
export function warmUp(): Promise<void> {
	const key = wantedTheme();
	if (initFailed) return Promise.resolve();
	if (initPromise && themeKey === key) return initPromise;
	themeKey = key;
	const previous = initPromise ?? Promise.resolve();
	initPromise = previous
		.catch(() => undefined)
		.then(async () => {
			if (themeKey !== key) return; // superseded by a newer switch
			try {
				shikiModule ??= await import("shiki");
				hlPromise ??= shikiModule.createHighlighter({ themes: [], langs: [] });
				highlighter = await hlPromise;
				try {
					await loadTheme(key);
				} catch (err) {
					store.ctx?.ui.notify(`pi-minimal-tui: ${err instanceof Error ? err.message : String(err)} — using tokyo-night`, "warning");
					await loadTheme("tokyo-night");
				}
				if (themeKey !== key) return;
				loadedKey = key;
				cache.clear();
				ansiCache.clear();
			} catch {
				initFailed = true; // don't retry on every frame; /tui reload resets
			}
			notify();
			onThemeLoadedFn?.();
		});
	return initPromise;
}

function ensureLang(lang: string): boolean {
	if (loadedLangs.has(lang)) return true;
	if (failedLangs.has(lang) || !highlighter || !shikiModule) return false;
	if (!loadingLangs.has(lang)) {
		const bundled = shikiModule.bundledLanguages as Record<string, unknown>;
		if (!(lang in bundled)) {
			failedLangs.add(lang);
			return false;
		}
		const p = highlighter
			.loadLanguage(lang as BundledLanguage)
			.then(() => {
				loadedLangs.add(lang);
			})
			.catch(() => {
				failedLangs.add(lang);
			})
			.finally(() => {
				loadingLangs.delete(lang);
				notify();
			});
		loadingLangs.set(lang, p);
	}
	return false;
}

function relLuminance(hex: string): number | undefined {
	const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
	if (!m) return undefined;
	const [r, g, b] = [m[1], m[2], m[3]].map((x) => {
		const c = Number.parseInt(x!, 16) / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	}) as [number, number, number];
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Replace token colours with too little contrast against the panel (WCAG ratio < 2). */
function fixContrast(hex: string): string {
	if (!store.config.shiki.fixContrast) return hex;
	const fg = relLuminance(hex);
	const bg = relLuminance(store.skin?.color("panel") ?? (store.skin?.appearance === "light" ? "#ffffff" : "#1c1c1c"));
	if (fg === undefined || bg === undefined) return hex;
	const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
	return ratio < 2 ? (store.skin?.color("muted") ?? hex) : hex;
}

const ansiCache = new Map<string, string>();
function colorAnsi(color: string): string {
	let out = ansiCache.get(color);
	if (out !== undefined) return out;
	try {
		let hex = color;
		// #rrggbbaa → blend over the theme background
		if (/^#[0-9a-f]{8}$/i.test(hex) && themeBg) {
			const alpha = Number.parseInt(hex.slice(7, 9), 16) / 255;
			hex = hex.slice(0, 7);
			const mixed = mixColors(parseColor(themeBg.slice(0, 7)), parseColor(hex), alpha);
			out = foregroundAnsi(mixed, store.piTheme?.getColorMode() ?? "truecolor");
		} else {
			out = foregroundAnsi(parseColor(fixContrast(hex.slice(0, 7))), store.piTheme?.getColorMode() ?? "truecolor");
		}
	} catch {
		out = "";
	}
	ansiCache.set(color, out);
	return out;
}

function touch(key: string, value: string[]): string[] {
	cache.delete(key);
	cache.set(key, value);
	const limit = Math.max(8, store.config.shiki.cacheSize);
	while (cache.size > limit) {
		const first = cache.keys().next().value;
		if (first === undefined) break;
		cache.delete(first);
	}
	return value;
}

/**
 * Highlight `code` synchronously if Shiki, the theme and the grammar are ready.
 * Returns undefined (and schedules loading) otherwise; `onReady` is called once
 * highlighting becomes possible so the caller can invalidate itself.
 */
export function highlight(code: string, lang: string | undefined, onReady?: () => void): string[] | undefined {
	if (!lang || code.length > store.config.shiki.maxChars) return undefined;
	const key = `${themeName}\0${lang}\0${code}`;
	const hit = cache.get(key);
	if (hit) return touch(key, hit);
	if (initFailed) return undefined;
	if (!highlighter || loadedKey !== wantedTheme()) {
		if (onReady) waiters.add(onReady);
		void warmUp();
		return undefined;
	}
	if (!ensureLang(lang)) {
		if (onReady && !failedLangs.has(lang)) waiters.add(onReady);
		return undefined;
	}
	try {
		const lines = highlighter.codeToTokensBase(expandTabs(code), { lang: lang as BundledLanguage, theme: themeName as never });
		const out = lines.map((tokens) => {
			let line = "";
			for (const token of tokens) {
				const color = token.color || themeFg;
				let text = token.content;
				const style = token.fontStyle ?? 0;
				if (style & 1) text = `\x1b[3m${text}\x1b[23m`;
				if (style & 2) text = `\x1b[1m${text}\x1b[22m`;
				if (style & 4) text = `\x1b[4m${text}\x1b[24m`;
				line += (color ? colorAnsi(color) : "") + text;
			}
			return line + FG_RESET;
		});
		return touch(key, out);
	} catch {
		failedLangs.add(lang);
		return undefined;
	}
}

/** Highlight, falling back to plain (but tab-expanded) lines. */
export function highlightOrPlain(code: string, lang: string | undefined, onReady?: () => void): string[] {
	return highlight(code, lang, onReady) ?? expandTabs(code).split("\n");
}

export function currentShikiTheme(): string {
	return themeName || themeKey;
}

export async function listBundledShikiThemes(): Promise<string[]> {
	shikiModule ??= await import("shiki");
	return Object.keys(shikiModule.bundledThemes).sort();
}

/** Drop cached colours (skin changed); the loaded theme is kept if still wanted. */
export function resetShiki(): void {
	cache.clear();
	ansiCache.clear();
	initFailed = false;
}
