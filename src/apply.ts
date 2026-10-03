/**
 * Loading config + skins and applying them (also used by /tui).
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyCaret } from "./chrome/editor.ts";
import { loadConfig } from "./config.ts";
import { invalidateChat } from "./messages/patches.ts";
import { onThemeLoaded, resetShiki, warmUp } from "./shiki.ts";

onThemeLoaded(() => {
	invalidateChat();
	store.changed();
});
import { readSkinFile, Skin } from "./skin.ts";
import { store } from "./state.ts";

export function applyConfigAndSkin(ctx: ExtensionContext, opts: { reloadConfig?: boolean; switchPiTheme?: boolean } = {}): string[] {
	const errors: string[] = [];
	if (opts.reloadConfig !== false) {
		const loaded = loadConfig(ctx.cwd);
		store.config = loaded.config;
		errors.push(...loaded.errors);
	}
	let { skin: file, error } = readSkinFile(store.config.theme);
	if (!file) {
		errors.push(error ?? `Unknown skin ${store.config.theme}`);
		({ skin: file } = readSkinFile("groknight"));
		file ??= readSkinFile("auto").skin!;
	}
	if (opts.switchPiTheme !== false && store.config.applyPiTheme && file.piTheme && ctx.hasUI) {
		const current = ctx.ui.theme?.name;
		if (current !== file.piTheme && ctx.ui.getTheme(file.piTheme)) {
			const result = ctx.ui.setTheme(file.piTheme);
			if (!result.success) errors.push(`pi theme "${file.piTheme}": ${result.error ?? "failed"}`);
		}
	}
	store.piTheme = ctx.ui.theme;
	themeKey = piThemeKey(ctx);
	store.skin = new Skin(file, ctx.ui.theme, store.config);
	resetShiki();
	void warmUp();
	invalidateChat();
	if (store.tui) applyCaret(store.tui);
	store.changed();
	return errors;
}

let themeKey = "";

// ctx.ui.theme is a stable proxy over the active theme, so compare by name/mode.
function piThemeKey(ctx: ExtensionContext): string {
	try {
		const t = ctx.ui.theme;
		return `${t.name ?? ""}:${t.sourcePath ?? ""}:${t.getColorMode()}`;
	} catch {
		return "";
	}
}

/** Rebuild the skin if pi's theme changed underneath us (e.g. via /settings). */
export function syncWithPiTheme(): void {
	const ctx = store.ctx;
	if (!ctx?.hasUI || !store.skin) return;
	if (piThemeKey(ctx) !== themeKey) applyConfigAndSkin(ctx, { reloadConfig: false, switchPiTheme: false });
}
