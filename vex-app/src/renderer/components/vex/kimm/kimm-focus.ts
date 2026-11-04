/**
 * WHERE FOCUS GOES WHEN HER SECTION COVERS IT (docs/design/H3-DESKTOP.md
 * section 3.4; plan row S4-11): "Focus inside a part that becomes covered or
 * folded moves to the Vex key in the header." A press on a key keeps focus on
 * that key, and both keys stay where they are through the motion, so only
 * focus that her section is about to hide moves:
 *
 *   - Show Vex: focus on something in Vex's column that her open box will
 *     cover (the console's rest under her) goes to the Vex key;
 *   - Hide Vex: focus inside her section's body (anything but her corner
 *     key), which folds away, goes to the Vex key.
 *
 * THE VEX KEY is the header's cell over her column (`data-vex-area="vex-key"`,
 * plan row S3-02). Until it lands the header's token chip is its forerunner
 * (`data-vex-area="vex-token-chip"`), so focus goes there instead: the same
 * control, the one that brings her back. DOM reads only, at the press.
 */

/** The Vex key, or its forerunner the token chip, or nothing. */
export function vexKeyElement(doc: Document = document): HTMLElement | null {
  return (
    doc.querySelector<HTMLElement>("[data-vex-area='vex-key']") ??
    doc.querySelector<HTMLElement>("[data-vex-area='vex-token-chip']")
  );
}

/** Whether two boxes share any height: her box covers what it overlaps. */
function overlaps(a: DOMRect, b: DOMRect): boolean {
  return a.bottom > b.top && a.top < b.bottom && a.right > b.left && a.left < b.right;
}

/**
 * Move focus to the Vex key when her press is about to hide what holds it.
 * `section` is her box, `key` her corner key (which keeps its focus), `open`
 * the leg the press starts. Returns whether focus moved.
 */
export function handFocusToVexKey(section: HTMLElement, key: HTMLElement | null, open: boolean): boolean {
  const doc = section.ownerDocument;
  const active = doc.activeElement;
  if (!(active instanceof HTMLElement) || active === doc.body) return false;
  if (key !== null && key.contains(active)) return false;
  const hidden = open
    ? // Opening: something in her column, outside her, that her box covers.
      (() => {
        const column = section.closest("[data-vex-area='vex-sidebar']");
        if (column === null || !column.contains(active) || section.contains(active)) return false;
        return overlaps(active.getBoundingClientRect(), section.getBoundingClientRect());
      })()
    : // Closing: anything in her section but the corner key folds away.
      section.contains(active);
  if (!hidden) return false;
  const target = vexKeyElement(doc);
  if (target === null) return false;
  target.focus({ preventScroll: true });
  return doc.activeElement === target;
}
