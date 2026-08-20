/**
 * IPC channel name constants — single source of truth shared between main +
 * preload + renderer. Facade: request channels live in channels/requests.ts,
 * push-event channels in channels/events.ts.
 */
export { CH } from "./channels/requests.js";
export { EV } from "./channels/events.js";

export type ChannelName = string;
