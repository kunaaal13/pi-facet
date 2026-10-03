/**
 * Render harness: runs the real tools against a temp project and renders our
 * components with pi's real classes, without starting the TUI.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/harness.ts [width] [out.ansi]
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AssistantMessageComponent,
	BashExecutionComponent,
	SkillInvocationMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { KeybindingsManager } from "@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { getEditorTheme, loadThemeFromPath, setThemeInstance, theme } from "@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { Container } from "@earendil-works/pi-tui";
import { SubagentDock } from "../src/agents/dock.ts";
import { applyConfigAndSkin } from "../src/apply.ts";
import { MinimalEditor } from "../src/chrome/editor.ts";
import { Footer } from "../src/chrome/footer.ts";
import { activity, WorkingRow } from "../src/chrome/working.ts";
import { installPatches, setChatContainer } from "../src/messages/patches.ts";
import { highlight, warmUp } from "../src/shiki.ts";
import { store, toolTimes } from "../src/state.ts";
import { registerTools } from "../src/tools/index.ts";

const width = Number(process.argv[2] ?? 100);
const outFile = process.argv[3];
const skinName = process.argv[4] ?? "groknight";
const root = new URL("..", import.meta.url).pathname;

const themeFile = ["grokday", "claudecode"].includes(skinName) ? `${skinName}.json` : "groknight.json";
const piTheme = loadThemeFromPath(join(root, "themes", themeFile));
setThemeInstance(piTheme);

const defs = new Map<string, any>();
const events: Record<string, Function[]> = {};
const fakePi: any = {
	registerTool: (d: any) => defs.set(d.name, d),
	getSettings: () => ({}),
	getThinkingLevel: () => "high",
	events: { on: (name: string, fn: Function) => (events[name] ??= []).push(fn), emit: (name: string, data: unknown) => events[name]?.forEach((f) => f(data)) },
	registerCommand() {},
	appendEntry() {},
	on() {},
};

const cwd = mkdtempSync(join(tmpdir(), "pmt-"));
const fakeCtx: any = {
	cwd,
	hasUI: true,
	model: { id: "gpt-6.1-sol", name: "gpt-6.1-sol", reasoning: true, contextWindow: 500_000, input: ["text", "image"] },
	getContextUsage: () => ({ tokens: 9_500, contextWindow: 500_000, percent: 1.9 }),
	sessionManager: { getEntries: () => [], getSessionId: () => "harness", getSessionFile: () => undefined, getCwd: () => cwd },
	ui: {
		theme: piTheme,
		getTheme: () => piTheme,
		setTheme: () => ({ success: true }),
		notify: (m: string) => console.error("notify:", m),
	},
};
store.ctx = fakeCtx;
store.config.theme = skinName;
const errs = applyConfigAndSkin(fakeCtx, { reloadConfig: false });
if (errs.length) console.error(errs);
store.config.theme = skinName;
applyConfigAndSkin(fakeCtx, { reloadConfig: false });
if (process.env.PMT_DIFF) store.config.diff.layout = process.env.PMT_DIFF as any;
if (process.env.PMT_SHIKI) store.config.shiki.theme = process.env.PMT_SHIKI;
registerTools(fakePi);
const failed = installPatches();
if (failed.length) console.error("patch failures:", failed);

await warmUp();
for (const lang of ["typescript", "bash", "json", "python"]) highlight("x", lang);
await new Promise((r) => setTimeout(r, 1500));

const ui: any = { requestRender() {} };
const chat = new Container();
setChatContainer(chat);
(store as any).tui = ui;

async function runTool(name: string, args: any, opts: { expanded?: boolean } = {}) {
	const def = defs.get(name)!;
	const id = `call_${name}_${Math.random().toString(36).slice(2, 7)}`;
	toolTimes.set(id, { start: Date.now() - 1234 });
	let result: any;
	try {
		result = await def.execute(id, args, undefined, undefined, fakeCtx);
	} catch (err: any) {
		result = { content: [{ type: "text", text: err.message }], isError: true };
	}
	toolTimes.get(id)!.end = Date.now() - 800;
	const comp = new ToolExecutionComponent(name, id, args, { showImages: false }, def, ui, cwd);
	comp.setArgsComplete();
	comp.markExecutionStarted();
	comp.updateResult(result, false);
	if (opts.expanded) comp.setExpanded(true);
	chat.addChild(comp);
	return comp;
}

// a small project to work on
writeFileSync(
	join(cwd, "checkout.ts"),
	`import { calculateTotal, ValidationError } from "./cart";\n\nexport async function checkout(cart: Cart) {\n\tconst total = sum(cart.items);\n\n\tconst charge = await stripe.charges.create({\n\t\tamount: total,\n\t\tcurrency: "usd",\n\t});\n\treturn charge;\n}\n`,
);
writeFileSync(join(cwd, "notes.md"), "# Notes\n\nhello\n");

// ── transcript ──
const skill = new SkillInvocationMessageComponent({ name: "ask-matt", content: "# Ask Matt\n\nSome skill body." } as any);
chat.addChild(skill);
const bashRun = new BashExecutionComponent("git status --short", ui);
bashRun.appendOutput(" M src/index.ts\n?? notes.md\n");
bashRun.setComplete(0, false);
chat.addChild(bashRun);
const imgUser = new UserMessageComponent("what's wrong in this screenshot /var/folders/tj/x/T/pi-clipboard-e172b73b-6e1f-43b0-9489-34495703ea32.png");
(imgUser as any).__pmtTs = new Date("2026-10-02T20:18:00").getTime();
chat.addChild(imgUser);
chat.addChild(new (await import("@earendil-works/pi-tui")).Spacer(1));
const user = new UserMessageComponent("add validation to the checkout flow so empty carts can't be charged");
(user as any).__pmtTs = new Date("2026-10-02T20:19:00").getTime();
chat.addChild(user);

const ts1 = Date.now() - 60_000;
const a1 = new AssistantMessageComponent(
	{ role: "assistant", timestamp: ts1, content: [{ type: "thinking", thinking: "Let me look at the checkout file first." }, { type: "toolCall", id: "x", name: "read", arguments: {} }], stopReason: "toolUse" } as any,
	true,
);
chat.addChild(a1);
await runTool("read", { path: "checkout.ts" });
await runTool("read", { path: "/var/folders/tj/x/T/pi-clipboard-e172b73b-6e1f-43b0-9489-34495703ea32.png" });
await runTool("grep", { pattern: "calculateTotal", path: "." });
await runTool("ls", { path: "." });
await runTool("read", { path: "notes.md" }); // grep2: extends the run
await runTool("grep", { pattern: "total", path: "." });
await runTool("edit", {
	path: "checkout.ts",
	edits: [
		{
			oldText: "\tconst total = sum(cart.items);\n",
			newText: "\tconst total = calculateTotal(cart.items);\n\tif (total <= 0) {\n\t\tthrow new ValidationError('Cart total must be positive');\n\t}\n",
		},
	],
});
await runTool("bash", { command: "cd /tmp && for i in 1 2 3 4 5 6 7 8; do echo \"line $i\"; done" });
await runTool("bash", { command: "echo 'boom' >&2; exit 3" });
await runTool("write", { path: "src/new-file.ts", content: "export const answer = 42;\n\nexport function hello(name: string) {\n\treturn `hi ${name}`;\n}\n" });
writeFileSync(join(cwd, "AGENTS.md"), "# AGENTS.md\n\nEssel — an autonomous AI SEO content engine (SvelteKit web app + Hono RPC API in a Bun monorepo).\n\n**Package manager: Bun 1.4.0.** Never npm, pnpm, or yarn — `pnpm-lock.yaml` was deleted on purpose.\n\n## Commands\n\n```bash\nbun run dev   # all apps\n```\n");
await runTool("write", { path: "AGENTS.md", content: "# Essel\n\nEssel is an AI SEO content engine that plans, writes, publishes, and measures blog content.\n\n## Stack\n\n- SvelteKit + Svelte 5 web app, Hono RPC API, shadcn-svelte UI.\n- Bun 1.4.0 monorepo. Use Bun for all package commands; no npm, pnpm, or yarn.\n\n## Commands\n\n```bash\nbun run dev   # all apps (turbo)\n```\n" });
await runTool("write", { path: "notes.md", content: "# Notes\n\nhello world\n\n- one\n- two\n" });
await runTool("read", { path: "checkout.ts", offset: 3, limit: 6 }, { expanded: true });

chat.addChild(new AssistantMessageComponent(
	{ role: "assistant", timestamp: Date.now() - 5000, content: [{ type: "thinking", thinking: "**Implementing line reduction**\n\nI'm looking to implement a straightforward version that reduces the 55 lines by about 25%. I'll keep it *concise* and proceed with `edit`." }, { type: "toolCall", id: "y", name: "read", arguments: {} }], stopReason: "toolUse" } as any,
	false,
));
// foreign tools: pi default shell (like pi-fff / pi-web-access) and no definition at all
{
	const { Text } = await import("@earendil-works/pi-tui");
	const foreignDef: any = {
		name: "fffind",
		renderCall: (args: any, theme: any) => new Text(`${theme.fg("toolTitle", theme.bold("fffind"))} ${theme.fg("accent", args.query)} in ${args.path} (limit 10)`, 0, 0),
		renderResult: () => new Text("node_modules/@aws-sdk/core/dist-types/ConfigurableSerdeContext.d.ts ... (11 more lines)", 0, 0),
	};
	const f1 = new ToolExecutionComponent("fffind", "f1", { query: "durable", path: "/opt/homebrew/lib/node_modules/pi" }, {}, foreignDef, ui, cwd);
	f1.updateResult({ content: [{ type: "text", text: "x" }] } as any, false);
	chat.addChild(f1);
	const f2 = new ToolExecutionComponent("web_enable", "f2", {}, {}, { name: "web_enable", renderCall: (_a: any, t: any) => new Text(t.bold("web_enable"), 0, 0), renderResult: () => new Text("Enabled: web_search, source_check, fetch_content, get_search_content.", 0, 0) } as any, ui, cwd);
	f2.updateResult({ content: [{ type: "text", text: "x" }] } as any, false);
	chat.addChild(f2);
	const f3 = new ToolExecutionComponent("mystery_tool", "f3", { a: 1 }, {}, undefined, ui, cwd);
	f3.updateResult({ content: [{ type: "text", text: "some output" }] } as any, false);
	chat.addChild(f3);
}
const a2 = new AssistantMessageComponent(
	{
		role: "assistant",
		timestamp: Date.now(),
		content: [
			{ type: "thinking", thinking: "Done, summarise." },
			{
				type: "text",
				text: "## Checkout validation\n\nAdded a guard so **empty carts** can't be charged.\n\n- `calculateTotal` replaces `sum`\n- throws `ValidationError` when total ≤ 0\n\n---\n\n```ts\nif (total <= 0) throw new ValidationError('x');\n```\n\n### Next\n\nRun the tests.",
			},
		],
		stopReason: "stop",
	} as any,
	true,
);
chat.addChild(a2);

const out: string[] = [];
out.push(...chat.render(width));
out.push("");

// subagents + working row + editor + footer
fakePi.events.emit("subagents:started", { id: "a1", type: "explore", description: "Explore pricing engine" });
fakePi.events.emit("subagents:started", { id: "a2", type: "general", description: "Check cache hit rates" });
fakePi.events.emit("subagents:completed", { id: "a2", type: "general", description: "Check cache hit rates", toolUses: 12, tokens: 21300 });
out.push(...new SubagentDock().render(width));
activity.start();
activity.set("responding");
activity.tokensSettled = 9450;
out.push(...new WorkingRow().render(width));
const tui: any = { terminal: { rows: 40 }, requestRender() {} };
const editor = new MinimalEditor(tui, getEditorTheme(), new KeybindingsManager(), fakePi, { branch: "main" });
(editor as any).focused = true;
out.push(...editor.render(width));
out.push(...new Footer({ getExtensionStatuses: () => new Map([["caveman", "caveman·lite"], ["usage", "5h 42%"]]), getGitBranch: () => "main" }).render(width));

const { visibleWidth } = await import("@earendil-works/pi-tui");
const over = out.filter((l) => visibleWidth(l) > width);
console.error(`overflow lines at width ${width}: ${over.length}`);
if (outFile) writeFileSync(outFile, out.join("\n"));
console.log(out.map((l) => l.replace(/\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07|\x1b_[^\x07\x1b]*(\x07|\x1b\\)/g, "")).join("\n"));
void theme;
process.exit(0);
