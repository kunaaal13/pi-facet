/**
 * Footer (off by default; chrome.footer): key hints left, other extensions'
 * statuses right. Always installed so pi's own footer stays hidden.
 *
 *   Shift+Tab:thinking │ Esc:stop │ Ctrl+o:expand        caveman·lite  5h 42%
 */
import type { Component } from "@earendil-works/pi-tui";
import { syncWithPiTheme } from "../apply.ts";
import { store } from "../state.ts";
import { activity } from "./working.ts";
import { clip, spread, visibleWidth } from "../util.ts";

export interface FooterData {
	getExtensionStatuses(): ReadonlyMap<string, string>;
	getGitBranch(): string | null;
}

export class Footer implements Component {
	constructor(private readonly data: FooterData) {}

	render(width: number): string[] {
		syncWithPiTheme();
		if (!store.skin || !store.config.chrome.footer) return [];
		const s = store.s;
		const sep = s.fg("dim", "  │  ");
		const hints = store.config.chrome.hints.map(([key, label]) => {
			const shown = key === "Enter" && activity.working ? "queue" : label;
			return `${s.bold(s.fg("textSecondary", key))}${s.fg("muted", `:${shown}`)}`;
		});
		const left = ` ${hints.join(sep)}`;
		let right = "";
		if (store.config.chrome.showStatuses) {
			const statuses = [...this.data.getExtensionStatuses().values()]
				.map((v) => v.replace(/\s+/g, " ").trim())
				.filter(Boolean);
			right = statuses.map((v) => s.fg("muted", v)).join(s.fg("dim", "  "));
		}
		if (!right) return [clip(left, width)];
		// statuses win space over hints only up to half the row
		const maxRight = Math.floor(width / 2);
		if (visibleWidth(right) > maxRight) right = clip(right, maxRight);
		return [spread(left, `${right} `, width)];
	}

	invalidate(): void {}
}
