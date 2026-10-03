/**
 * Shared runtime state. Renderers are plain functions invoked by pi, so the
 * current skin/config/TUI handle live here rather than being threaded through.
 */
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { type Config, DEFAULT_CONFIG } from "./config.ts";
import { Skin } from "./skin.ts";

type Listener = () => void;

class Store {
	config: Config = structuredClone(DEFAULT_CONFIG);
	skin: Skin | undefined;
	tui: TUI | undefined;
	ctx: ExtensionContext | undefined;
	piTheme: Theme | undefined;
	/** Bumped whenever skin/config changes so caches keyed on it go stale. */
	epoch = 0;
	private listeners = new Set<Listener>();

	onChange(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	changed(): void {
		this.epoch++;
		for (const listener of this.listeners) listener();
		this.requestRender();
	}

	requestRender(): void {
		this.tui?.requestRender();
	}

	get s(): Skin {
		if (!this.skin) throw new Error("pi-facet: skin not initialised");
		return this.skin;
	}
}

export const store = new Store();

/** Per-tool-call timing, filled from tool_execution_* events. */
export const toolTimes = new Map<string, { start: number; end?: number }>();

/**
 * Shared animation clock. One interval drives every spinner/rail/timer; it only
 * runs while something has registered interest.
 */
class Ticker {
	frame = 0;
	private timer: ReturnType<typeof setInterval> | undefined;
	private holds = new Set<string>();

	hold(key: string): void {
		this.holds.add(key);
		this.ensure();
	}

	release(key: string): void {
		this.holds.delete(key);
		if (this.holds.size === 0) this.stop();
	}

	/** Drop holds whose owners may never re-render (e.g. scrolled-away rows). */
	releasePrefix(prefix: string): void {
		for (const key of [...this.holds]) if (key.startsWith(prefix)) this.holds.delete(key);
		if (this.holds.size === 0) this.stop();
	}

	has(key: string): boolean {
		return this.holds.has(key);
	}

	private ensure(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			this.frame++;
			store.requestRender();
		}, Math.max(40, store.config.animation.intervalMs));
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	clear(): void {
		this.holds.clear();
		this.stop();
	}

	spinner(frames: string[], divisor = 1): string {
		if (frames.length === 0) return "";
		return frames[Math.floor(this.frame / divisor) % frames.length]!;
	}
}

export const ticker = new Ticker();
