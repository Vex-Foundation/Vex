/**
 * The run gate of a canvas loop: it runs only while its element is on screen and the window is
 * shown (MOTION-POLICY.md, "The K2 portrait"). A hidden window or an element scrolled or folded
 * out of view stops the loop at once; it resumes when both hold again. Where
 * `IntersectionObserver` does not exist the element counts as on screen.
 */
export class RunGate {
  readonly #target: Element;
  readonly #onChange: (run: boolean) => void;
  #observer: IntersectionObserver | null = null;
  #onscreen = true;
  #run = false;

  /** `onChange` hears every switch, and once at once when the gate starts open. */
  constructor(target: Element, onChange: (run: boolean) => void) {
    this.#target = target;
    this.#onChange = onChange;
    document.addEventListener("visibilitychange", this.#update);
    if (typeof IntersectionObserver !== "undefined") {
      this.#observer = new IntersectionObserver((entries) => {
        this.#onscreen = entries.some((e) => e.isIntersecting);
        this.#update();
      });
      this.#observer.observe(this.#target);
    }
    this.#update();
  }

  get running(): boolean {
    return this.#run;
  }

  destroy(): void {
    document.removeEventListener("visibilitychange", this.#update);
    this.#observer?.disconnect();
    this.#observer = null;
    if (this.#run) {
      this.#run = false;
      this.#onChange(false);
    }
  }

  readonly #update = (): void => {
    const run = this.#onscreen && !document.hidden;
    if (run === this.#run) return;
    this.#run = run;
    this.#onChange(run);
  };
}
