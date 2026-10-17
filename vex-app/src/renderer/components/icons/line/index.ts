/**
 * Public gate for the calm line icons of the R3 design: the navigation, the
 * window chrome, the composer, the Vex sidebar and the pages draw with these.
 * Import from here (`components/icons/line/index.js`); the px sprite next door
 * stays for pixel icons that are part of a picture.
 *
 *   <LineChat />                       one component per icon, size 16
 *   <LineChevronDown size={14} />      sizes 14, 16, 20
 *   <LineIcon name="missions" />       by name, for config-driven lists
 *   LINE_ICONS.settings                the component for a name
 */

export {
  LINE_GRID,
  LINE_SIZES,
  LineSvg,
  type LineIconProps,
  type LineSize,
  type LineSvgProps,
} from "./LineSvg.js";
export { LINE_ICON_NAMES, type LineIconName } from "./line-glyphs.js";
export * from "./line-icons.js";
