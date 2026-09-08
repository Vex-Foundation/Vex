import type { Terminal } from "@xterm/xterm";
import { primaryModifierName, type StudioPlatform } from "../keybindings-labels.js";

const LINK_HINT_DELAY_MS = 500;

export function isTerminalLinkActivation(event: MouseEvent, platform: StudioPlatform): boolean {
  return event.button === 0 && (platform === "darwin" ? event.metaKey : event.ctrlKey);
}

/** Owns one delayed hover for both xterm link providers. It never renders markup from a link. */
export class TerminalLinkHint {
  readonly #wrapper: HTMLElement;
  readonly #subscriptions: { dispose: () => void }[];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #element: HTMLElement | undefined;
  #disposed = false;

  constructor(terminal: Pick<Terminal, "onScroll" | "onRender">, wrapper: HTMLElement) {
    this.#wrapper = wrapper;
    this.#subscriptions = [
      terminal.onScroll(() => this.clear()),
      terminal.onRender(() => this.clear()),
    ];
    wrapper.addEventListener("mouseleave", this.clear);
    wrapper.addEventListener("wheel", this.clear, { passive: true });
  }

  show(text: string, platform: StudioPlatform): void {
    this.clear();
    if (this.#disposed) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (this.#disposed || !this.#wrapper.isConnected) return;
      const element = this.#wrapper.ownerDocument.createElement("div");
      element.className = "vex-terminal-link-hint";
      element.setAttribute("role", "tooltip");
      const modifier = primaryModifierName(platform);
      element.textContent = `Follow link (${modifier} + click)\n${text}`;
      this.#wrapper.appendChild(element);
      this.#element = element;
    }, LINK_HINT_DELAY_MS);
  }

  clear = (): void => {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#element?.remove();
    this.#element = undefined;
  };

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.clear();
    for (const subscription of this.#subscriptions) subscription.dispose();
    this.#wrapper.removeEventListener("mouseleave", this.clear);
    this.#wrapper.removeEventListener("wheel", this.clear);
  }
}
