/**
 * pi-minimal-tui — a clean, Grok Build-style TUI for pi.
 *
 * Supported APIs do almost everything (tools, editor, widgets, footer, header,
 * title, commands). Prompt bands, "Thought for Xs" and row stacking need small
 * guarded patches (src/messages/patches.ts).
 */
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resetSubagents, SubagentDock, trackSubagents } from "./agents/dock.ts";
import { applyConfigAndSkin } from "./apply.ts";
import { applyCaret, createEditorFactory, type EditorInfo, restoreCaret } from "./chrome/editor.ts";
import { Footer } from "./chrome/footer.ts";
import { Header } from "./chrome/header.ts";
import { activity, WorkingRow } from "./chrome/working.ts";
import { registerCommands } from "./commands.ts";
import { expandTokens, hasTokens } from "./images.ts";
import { installPatches, uninstallPatches } from "./messages/patches.ts";
import { loadThinking, trackThinking } from "./messages/thinking.ts";
import { store, ticker, toolTimes } from "./state.ts";
import { registerTools } from "./tools/index.ts";
import { displayPath } from "./util.ts";

const TOOL_VERBS: Record<string, string> = {
	read: "Reading",
	bash: "Running",
	edit: "Editing",
	write: "Writing",
	grep: "Searching",
	find: "Finding",
	ls: "Listing",
	Agent: "Delegating",
};

function toolArg(name: string, args: any, cwd: string): string {
	if (!args || typeof args !== "object") return "";
	if (name === "bash") return String(args.command ?? "").split("\n")[0] ?? "";
	if (typeof args.path === "string") return displayPath(args.path, cwd);
	if (typeof args.pattern === "string") return args.pattern;
	if (typeof args.description === "string") return args.description;
	if (typeof args.query === "string") return args.query;
	if (typeof args.url === "string") return args.url;
	return "";
}

export default function piMinimalTui(pi: ExtensionAPI): void {
	registerTools(pi);
	trackThinking(pi);
	trackSubagents(pi);
	registerCommands(pi);

	const editorInfo: EditorInfo = {};
	let titleTimer: ReturnType<typeof setInterval> | undefined;
	let lastTitle = "";
	let titleFrame = 0;

	const setTitle = () => {
		const ctx = store.ctx;
		if (!ctx?.hasUI || !store.skin || !store.config.chrome.title) return;
		const name = pi.getSessionName() || basename(ctx.cwd);
		let title = `${name} - pi`;
		if (activity.working) {
			const { verb } = activity.describe();
			const frames = store.s.glyphs.spinner;
			title = `${frames[titleFrame % frames.length] ?? ""} ${verb} - ${name} - pi`;
		}
		if (title !== lastTitle) {
			lastTitle = title;
			ctx.ui.setTitle(title);
		}
	};
	const startTitle = () => {
		if (titleTimer) return;
		titleTimer = setInterval(() => {
			titleFrame++;
			setTitle();
		}, 264);
		titleTimer.unref?.();
	};
	const stopTitle = () => {
		if (titleTimer) clearInterval(titleTimer);
		titleTimer = undefined;
		setTitle();
	};

	let animateHeader = false;
	const mountChrome = (ctx: ExtensionContext) => {
		const { chrome } = store.config;
		if (chrome.editor) ctx.ui.setEditorComponent(createEditorFactory(pi, editorInfo));
		if (chrome.workingRow) ctx.ui.setWorkingVisible(false);
		ctx.ui.setWidget(
			"pmt-subagents",
			(tui) => {
				store.tui = tui;
				return new SubagentDock();
			},
			{ placement: "aboveEditor" },
		);
		ctx.ui.setWidget(
			"pmt-working",
			(tui) => {
				store.tui = tui;
				return new WorkingRow();
			},
			{ placement: "aboveEditor" },
		);
		{
			ctx.ui.setFooter((tui, _theme, footerData) => {
				store.tui = tui;
				editorInfo.branch = footerData.getGitBranch() ?? undefined;
				const unsub = footerData.onBranchChange(() => {
					editorInfo.branch = footerData.getGitBranch() ?? undefined;
					store.requestRender();
				});
				return Object.assign(new Footer(footerData), { dispose: unsub });
			});
		}
		if (chrome.header) ctx.ui.setHeader(() => new Header(pi, editorInfo, animateHeader));
	};

	pi.on("session_start", (event, ctx) => {
		store.ctx = ctx;
		animateHeader = event.reason === "startup";
		if (!ctx.hasUI) return;
		const failed = installPatches();
		const errors = applyConfigAndSkin(ctx);
		loadThinking(ctx);
		mountChrome(ctx);
		setTitle();
		for (const e of errors) ctx.ui.notify(`pi-minimal-tui: ${e}`, "warning");
		if (failed.length) ctx.ui.notify(`pi-minimal-tui: couldn't hook ${failed.join(", ")} (pi internals changed) — using stock rendering there`, "warning");
	});

	pi.on("session_shutdown", () => {
		restoreCaret();
		uninstallPatches();
		ticker.clear();
		resetSubagents();
		toolTimes.clear();
		if (titleTimer) clearInterval(titleTimer);
		titleTimer = undefined;
		activity.finish();
		store.tui = undefined;
	});

	pi.on("agent_start", () => {
		activity.start();
		startTitle();
	});

	pi.on("message_update", (event) => {
		const msg = event.message as { role?: string; usage?: { output?: number } };
		if (msg.role !== "assistant") return;
		const e = event.assistantMessageEvent as { type: string; delta?: string };
		if (e.type.startsWith("thinking")) {
			if (activity.phase !== "thinking") activity.set("thinking");
		} else if (e.type.startsWith("text")) {
			if (activity.phase !== "responding") activity.set("responding");
		} else if (e.type.startsWith("toolcall") && activity.phase !== "tool") {
			activity.set("working");
		}
		if (typeof e.delta === "string") activity.tokensLive += e.delta.length / 4;
		const reported = msg.usage?.output;
		if (typeof reported === "number" && reported > activity.tokensLive) activity.tokensLive = reported;
	});

	pi.on("message_end", (event) => {
		const msg = event.message as { role?: string; usage?: { output?: number } };
		if (msg.role !== "assistant") return;
		activity.tokensSettled += msg.usage?.output || activity.tokensLive;
		activity.tokensLive = 0;
	});

	pi.on("tool_execution_start", (event, ctx) => {
		toolTimes.set(event.toolCallId, { start: Date.now() });
		activity.tools++;
		const verb = TOOL_VERBS[event.toolName] ?? `Running ${event.toolName}`;
		activity.set("tool", verb, toolArg(event.toolName, event.args, ctx.cwd));
	});

	pi.on("tool_execution_end", (event) => {
		const t = toolTimes.get(event.toolCallId);
		if (t) t.end = Date.now();
		setTimeout(() => toolTimes.delete(event.toolCallId), 60_000).unref?.();
		activity.set("working");
		store.requestRender();
	});

	pi.on("agent_settled", () => {
		activity.finish();
		stopTitle();
		ticker.releasePrefix("tool:");
		ticker.releasePrefix("thinking:");
	});
	pi.on("agent_end", () => {
		// agent_settled follows; keep the row alive until then, but don't leave timers if it never comes
		setTimeout(() => {
			if (activity.working && store.ctx?.isIdle()) {
				activity.finish();
				stopTitle();
			}
		}, 1500).unref?.();
	});

	pi.on("session_before_compact", () => {
		activity.set("compacting");
		startTitle();
	});
	// pi clears its compaction flag only after emitting session_compact, and a manual
	// /compact is never followed by agent_settled, so re-check idleness next tick.
	pi.on("session_compact", () => {
		setTimeout(() => {
			if (store.ctx?.isIdle()) {
				activity.finish();
				stopTitle();
			} else activity.set("working");
		}, 0);
	});
	pi.on("session_compact_failed", () => {
		setTimeout(() => {
			if (store.ctx?.isIdle()) {
				activity.finish();
				stopTitle();
			}
		}, 0);
	});

	let phaseBeforePrompt: typeof activity.phase = "idle";
	pi.on("ui_prompt_start", () => {
		if (!activity.working) return;
		phaseBeforePrompt = activity.phase;
		activity.set("waiting");
	});
	pi.on("ui_prompt_end", () => {
		if (activity.phase === "waiting") activity.set(phaseBeforePrompt === "waiting" ? "working" : phaseBeforePrompt);
	});

	// "[Image #n]" tokens in the prompt go to the model as the real file paths.
	pi.on("input", (event) => {
		if (!hasTokens(event.text)) return { action: "continue" as const };
		return { action: "transform" as const, text: expandTokens(event.text), images: event.images };
	});

	pi.on("session_info_changed", () => setTitle());
	pi.on("model_select", () => store.requestRender());
	pi.on("thinking_level_select", () => store.requestRender());
}
