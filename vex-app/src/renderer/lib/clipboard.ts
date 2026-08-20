/**
 * Renderer clipboard write shared by copy controls. Reports whether the host
 * accepted the write; success feedback stays with each control.
 */

/**
 * Write text to the clipboard. The shell's permission handlers are deny-all
 * (main/permissions.ts), so `navigator.clipboard.writeText` may reject; the
 * fallback is an off-screen readonly textarea + the selection copy command,
 * which needs no permissions API. Returns true only on a real success.
 */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return copyViaSelection(text);
  }
}

function copyViaSelection(text: string): boolean {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
