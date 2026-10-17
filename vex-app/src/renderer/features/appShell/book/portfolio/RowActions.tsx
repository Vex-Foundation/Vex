/**
 * A row's actions on the Portfolio page, behind one muted dots key
 * (docs/design/R3-MINIMAL.md section 9.1: "Row actions sit in a menu"). The
 * menu is the kit's flat panel (field background, 1px ink border, 32 high
 * items), portalled so a table inside the page's scroller never clips it.
 * A row with nothing to do renders no key at all, never a disabled one.
 */

import { useState, type JSX } from "react";
import { Menu, type MenuItem } from "../../../../components/ui/menu.js";
import { LineMore } from "../../../../components/icons/line/index.js";

export interface RowAction {
  readonly id: string;
  readonly label: string;
  readonly run: () => void;
}

export function RowActions({
  label,
  actions,
}: {
  /** The key's accessible name, naming the row ("Actions for ETH"). */
  readonly label: string;
  readonly actions: readonly RowAction[];
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (actions.length === 0) return null;
  const items: readonly MenuItem[] = actions.map((action) => ({
    id: action.id,
    label: action.label,
  }));
  return (
    <Menu
      open={open}
      onClose={() => setOpen(false)}
      items={items}
      portal
      align="end"
      dense
      onSelect={(id) => {
        setOpen(false);
        actions.find((action) => action.id === id)?.run();
      }}
      anchor={
        <button
          type="button"
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          className="vex-pf-key"
        >
          <LineMore size={16} />
        </button>
      }
    />
  );
}
