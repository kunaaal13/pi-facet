/**
 * Working row (above the input) and activity tracking, shared with the title.
 *
 *   ⠋ Responding… 3.2s                                   17s ⇣9.45k esc:stop
 *   ✻ Worked for 1m12s · 6 tools · ⇣21.3k                       (when idle)
 */
import type { Component } from "@earendil-works/pi-tui";
import { store, ticker } from "../state.ts";
import { clip, fmtDuration, fmtElapsed, fmtTokens, middleTruncate, spread } from "../util.ts";

export type Phase = "idle" | "working" | "thinking" | "responding" | "tool" | "compacting" | "waiting";

class Activity {
	phase: Phase = "idle";
	label = "";
	argText = "";
	turnStart = 0;
	phaseStart = 0;
	/** Output tokens: settled messages + live estimate for the streaming one. */
	tokensSettled = 0;
	tokensLive = 0;
	tools = 0;
	last?: { ms: number; tools: number; tokens: number };

	get working(): boolean {
		return this.phase !== "idle";
	}

	start(): void {
		this.phase = "working";
		this.label = "";
		this.turnStart = Date.now();
		this.phaseStart = this.turnStart;
		this.tokensSettled = 0;
		this.tokensLive = 0;
		this.tools = 0;
		ticker.hold("working");
	}

	set(phase: Phase, label = "", argText = ""): void {
		if (this.phase === "idle" && phase !== "idle") this.start();
		if (phase !== this.phase || label !== this.label || argText !== this.argText) {
			this.phase = phase;
			this.label = label;
			this.argText = argText;
			this.phaseStart = Date.now();
		}
		store.requestRender();
	}

	finish(): void {
		if (this.phase === "idle") return;
		this.last = { ms: Date.now() - this.turnStart, tools: this.tools, tokens: this.tokens };
		this.phase = "idle";
		ticker.release("working");
		store.requestRender();
	}

	get tokens(): number {
		return this.tokensSettled + this.tokensLive;
	}

	/** "Responding" / "Running npm test" … for row + title. */
	describe(): { verb: string; arg: string } {
		switch (this.phase) {
			case "thinking":
				return { verb: "Thinking", arg: "" };
			case "responding":
				return { verb: "Responding", arg: "" };
			case "tool":
				return { verb: this.label, arg: this.argText };
			case "compacting":
				return { verb: "Compacting", arg: "" };
			case "waiting":
				return { verb: "Waiting for you", arg: "" };
			default:
				return { verb: "Working", arg: "" };
		}
	}
}

export const activity = new Activity();

export class WorkingRow implements Component {
	render(width: number): string[] {
		if (!store.skin || !store.config.chrome.workingRow) return [];
		const s = store.s;
		if (!activity.working) {
			const last = activity.last;
			if (!last) return [];
			const parts = [`Worked for ${fmtDuration(last.ms)}`];
			if (last.tools) parts.push(`${last.tools} ${last.tools === 1 ? "tool" : "tools"}`);
			if (last.tokens) parts.push(`${s.glyphs.tokens}${fmtTokens(last.tokens)}`);
			return [clip(` ${s.fg("dim", `✻ ${parts.join(` ${s.glyphs.sep} `)}`)}`, width), ""];
		}
		const { verb, arg } = activity.describe();
		const now = Date.now();
		let glyph: string;
		if (activity.phase === "waiting") {
			const t = Math.sin((ticker.frame * store.config.animation.intervalMs) / 1200);
			glyph = `${s.blendAnsi("dim", "accent", 0.3 + 0.7 * t * t)}${s.glyphs.bullet}\x1b[39m`;
		} else {
			glyph = s.fg(activity.phase === "tool" ? "success" : "accent", ticker.spinner(s.glyphs.spinner));
		}
		const argText = arg ? ` ${s.fg("command", middleTruncate(arg, Math.max(10, Math.floor(width / 2) - verb.length)))}` : "";
		const phaseTime = now - activity.phaseStart > 1500 && width > 60 ? s.fg("muted", ` ${fmtDuration(now - activity.phaseStart)}`) : "";
		const label = arg ? s.fg("textSecondary", verb) : s.fg("textSecondary", `${verb}…`);
		const left = ` ${glyph} ${label}${argText}${phaseTime}`;
		const right = s.fg(
			"muted",
			`${fmtElapsed(now - activity.turnStart)}${activity.tokens ? ` ${s.glyphs.tokens}${fmtTokens(activity.tokens)}` : ""}  `,
		) + s.fg("dim", "esc:stop ");
		return [spread(left, right, width), ""];
	}

	invalidate(): void {}
}
