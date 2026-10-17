/**
 * Constants for the compose bootstrap surface - the bounded log buffer
 * size. (The NOTARY-era "Step X of N" counter is retired with the
 * Chronos rebrand.)
 */

/**
 * Bounded log retention. The renderer pulls a circular buffer from the
 * `onComposeLog` push stream; main is the source of truth, so we never
 * try to keep a full history here. 50 lines covers a typical first-run
 * (~15 log events including container starts + 2 health probes per
 * service) plus retry attempts.
 */
export const COMPOSE_LOG_BUFFER_MAX = 50;
