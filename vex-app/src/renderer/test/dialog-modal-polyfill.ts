/**
 * The `<dialog>` modal methods jsdom does not implement, WITH the focusing
 * steps the platform actually runs.
 *
 * ## Why this file exists
 *
 * jsdom ships `HTMLDialogElement` without `showModal` / `close` / `show`, so
 * every renderer suite that mounts a dialog used to install its own stub. All
 * of them set the `open` attribute and stopped there, which made
 * `document.activeElement` a lie: a dialog the browser opened on its first
 * focusable descendant looked, in jsdom, exactly like one opened on whatever
 * React's `autoFocus` prop had focused during the commit. Two Studio consent
 * dialogs shipped with focus on a delete-arming field and on a button that
 * ends running terminals, under green assertions on `document.activeElement`.
 *
 * So this polyfill runs the focusing steps: the `autofocus` element if the
 * dialog names one, else the first focusable descendant, else the dialog
 * itself - the same order the HTML spec's "dialog focusing steps" define. An
 * assertion on `document.activeElement` in a renderer test now means what it
 * says.
 *
 * INSTALLED ONCE, from `test/setup.ts`, for every renderer suite: one owner,
 * so no suite can quietly reintroduce a stub that focuses nothing.
 *
 * NOT a general-purpose polyfill: no top layer, no inertness, no UA Escape
 * handling (a test that needs the Escape intent dispatches the `cancel` event
 * directly, which is what the UA does).
 */

/**
 * Elements the sequential focus order can reach. `[tabindex]` is filtered by
 * value below, because `tabindex="-1"` is programmatically focusable but is
 * NOT a candidate for the "first focusable descendant" fallback.
 */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  'input:not([type="hidden"])',
  "select",
  "textarea",
  "button",
  "iframe",
  '[contenteditable=""]',
  '[contenteditable="true"]',
  "[tabindex]",
].join(",");

function isFocusableCandidate(element: HTMLElement): boolean {
  if (element.hasAttribute("disabled")) return false;
  if (element.getAttribute("aria-disabled") === "true") return false;
  if (element.hidden) return false;
  if (element.closest("[hidden]") !== null) return false;
  const tabindex = element.getAttribute("tabindex");
  if (tabindex !== null && Number(tabindex) < 0) return false;
  return true;
}

/**
 * The HTML "dialog focusing steps", to the depth a jsdom test can observe.
 */
function runDialogFocusingSteps(dialog: HTMLDialogElement): void {
  const named = dialog.querySelector<HTMLElement>("[autofocus]");
  if (named !== null && isFocusableCandidate(named)) {
    named.focus();
    return;
  }
  const candidates = dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
  for (const candidate of candidates) {
    if (isFocusableCandidate(candidate)) {
      candidate.focus();
      return;
    }
  }
  // No focusable content: the dialog itself takes focus. A `<dialog>` without
  // a tabindex ignores `.focus()`, which is truthful - a browser focuses the
  // dialog through the same steps only because it makes it focusable first.
  dialog.focus();
}

interface DialogModalMethods {
  showModal?: () => void;
  close?: (returnValue?: string) => void;
  show?: () => void;
}

/**
 * Idempotent: installs only the methods the runtime is missing, so a jsdom
 * release that grows a real implementation wins over this one.
 */
export function installDialogModalPolyfill(): void {
  if (typeof HTMLDialogElement === "undefined") return;
  const proto = HTMLDialogElement.prototype as unknown as DialogModalMethods;
  if (typeof proto.showModal !== "function") {
    proto.showModal = function showModalPolyfill(this: HTMLDialogElement): void {
      this.setAttribute("open", "");
      runDialogFocusingSteps(this);
    };
  }
  if (typeof proto.close !== "function") {
    proto.close = function closePolyfill(this: HTMLDialogElement): void {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    };
  }
  if (typeof proto.show !== "function") {
    proto.show = function showPolyfill(this: HTMLDialogElement): void {
      this.setAttribute("open", "");
      runDialogFocusingSteps(this);
    };
  }
}
