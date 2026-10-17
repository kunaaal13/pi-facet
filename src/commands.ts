/**
 * /tui — switch skins, Shiki themes, diff layout, timestamps; reload config.
 *
 *   /tui                     menu
 *   /tui theme [name]        skin (groknight, grokday, auto, or your own)
 *   /tui shiki [name|path]   code theme (bundled name or VS Code theme JSON)
 *   /tui diff [auto|unified|split]
 *   /tui timestamps [on|off]
 *   /tui reload              re-read config + skins
 *   /tui paths               where config and custom skins live
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { applyConfigAndSkin } from "./apply.ts";
import { GLOBAL_CONFIG_PATH, projectConfigPath, saveGlobalKey, USER_SKINS_DIR } from "./config.ts";
import { currentShikiTheme, listBundledShikiThemes } from "./shiki.ts";
import { BUILTIN_SKINS_DIR, listSkins } from "./skin.ts";
import { store } from "./state.ts";

const SUBCOMMANDS = ["theme", "shiki", "diff", "timestamps", "reload", "paths"];

async function setKey(ctx: ExtensionCommandContext, key: string, value: unknown, label: string): Promise<void> {
	try {
		saveGlobalKey(key, value);
	} catch (err) {
		ctx.ui.notify(`Couldn't save ${GLOBAL_CONFIG_PATH}: ${err instanceof Error ? err.message : String(err)}`, "error");
	}
	const errors = applyConfigAndSkin(ctx);
	for (const e of errors) ctx.ui.notify(e, "warning");
	ctx.ui.notify(label, "info");
}

async function pickTheme(ctx: ExtensionCommandContext, name?: string): Promise<void> {
	const choice = name || (await ctx.ui.select(`Skin (current: ${store.config.theme})`, listSkins()));
	if (!choice) return;
	if (!listSkins().includes(choice)) {
		ctx.ui.notify(`Unknown skin "${choice}". Available: ${listSkins().join(", ")}`, "warning");
		return;
	}
	await setKey(ctx, "theme", choice, `Skin: ${choice}`);
}

async function pickShiki(ctx: ExtensionCommandContext, name?: string): Promise<void> {
	const light = store.skin?.appearance === "light";
	const key = light ? "shiki.lightTheme" : "shiki.theme";
	let choice = name;
	if (!choice) {
		const themes = await listBundledShikiThemes();
		choice = await ctx.ui.select(`Code theme (current: ${currentShikiTheme()})`, ["(skin default)", ...themes]);
		if (!choice) return;
		if (choice === "(skin default)") choice = "";
	}
	await setKey(ctx, key, choice, `Code theme: ${choice || "skin default"}`);
}

async function pickDiff(ctx: ExtensionCommandContext, value?: string): Promise<void> {
	const choice = value || (await ctx.ui.select(`Diff layout (current: ${store.config.diff.layout})`, ["auto", "unified", "split"]));
	if (!choice) return;
	if (!["auto", "unified", "split"].includes(choice)) {
		ctx.ui.notify("Diff layout must be auto, unified or split", "warning");
		return;
	}
	await setKey(ctx, "diff.layout", choice, `Diff layout: ${choice}`);
}

async function toggleTimestamps(ctx: ExtensionCommandContext, value?: string): Promise<void> {
	const on = value ? value === "on" || value === "true" : !store.config.messages.timestamps;
	await setKey(ctx, "messages.timestamps", on, `Timestamps ${on ? "on" : "off"}`);
}

export function registerCommands(pi: ExtensionAPI): void {
	pi.registerCommand("tui", {
		description: "pi-minimal-tui: skin, code theme, diff layout, timestamps, reload",
		getArgumentCompletions: (prefix: string) => {
			const [sub, arg = ""] = prefix.split(/\s+/, 2);
			if (prefix.includes(" ")) {
				const options =
					sub === "theme"
						? listSkins()
						: sub === "diff"
							? ["auto", "unified", "split"]
							: sub === "timestamps"
								? ["on", "off"]
								: [];
				return options.filter((o) => o.startsWith(arg)).map((o) => ({ value: `${sub} ${o}`, label: o }));
			}
			return SUBCOMMANDS.filter((s) => s.startsWith(sub ?? "")).map((s) => ({ value: s, label: s }));
		},
		handler: async (args, ctx) => {
			const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const value = rest.join(" ");
			switch (sub) {
				case "theme":
				case "skin":
					return pickTheme(ctx, value);
				case "shiki":
				case "code":
					return pickShiki(ctx, value);
				case "diff":
					return pickDiff(ctx, value);
				case "timestamps":
					return toggleTimestamps(ctx, value);
				case "reload": {
					const errors = applyConfigAndSkin(ctx);
					for (const e of errors) ctx.ui.notify(e, "warning");
					ctx.ui.notify("pi-minimal-tui reloaded", "info");
					return;
				}
				case "paths":
					ctx.ui.notify(
						[
							`config:  ${GLOBAL_CONFIG_PATH}`,
							`project: ${projectConfigPath(ctx.cwd)}`,
							`skins:   ${USER_SKINS_DIR}`,
							`builtin: ${BUILTIN_SKINS_DIR}`,
						].join("\n"),
						"info",
					);
					return;
				case undefined: {
					const choice = await ctx.ui.select("pi-minimal-tui", [
						`Skin… (${store.config.theme})`,
						`Code theme… (${currentShikiTheme()})`,
						`Diff layout… (${store.config.diff.layout})`,
						`Timestamps: ${store.config.messages.timestamps ? "on" : "off"}`,
						"Reload config",
						"Show paths",
					]);
					if (!choice) return;
					if (choice.startsWith("Skin")) return pickTheme(ctx);
					if (choice.startsWith("Code")) return pickShiki(ctx);
					if (choice.startsWith("Diff")) return pickDiff(ctx);
					if (choice.startsWith("Timestamps")) return toggleTimestamps(ctx);
					if (choice.startsWith("Reload")) {
						for (const e of applyConfigAndSkin(ctx)) ctx.ui.notify(e, "warning");
						return;
					}
					ctx.ui.notify(`config: ${GLOBAL_CONFIG_PATH}\nskins:  ${USER_SKINS_DIR}`, "info");
					return;
				}
				default:
					ctx.ui.notify(`Unknown subcommand "${sub}". Try: ${SUBCOMMANDS.join(", ")}`, "warning");
			}
		},
	});
}
