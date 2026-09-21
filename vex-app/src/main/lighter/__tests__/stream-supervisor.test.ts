import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  reconnectDelayMs,
  SocketWatcherReconnectState,
  type SocketWatcherBackoffConfig,
} from "../stream-supervisor.js";

const CONFIG: SocketWatcherBackoffConfig = {
  maxReconnectAttempts: 3,
  reconnectCeilingMs: 30_000,
  reconnectExponentCap: 5,
  giveUpRetryMs: 90_000,
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("reconnectDelayMs", () => {
  it("doubles per attempt up to the exponent cap, then holds", () => {
    const noJitter = { reconnectCeilingMs: 30_000, reconnectExponentCap: 5 };
    expect(reconnectDelayMs(0, 0, noJitter)).toBe(800); // 1000 * 0.8
    expect(reconnectDelayMs(1, 0, noJitter)).toBe(1_600); // 2000 * 0.8
    expect(reconnectDelayMs(2, 0, noJitter)).toBe(3_200); // 4000 * 0.8
    expect(reconnectDelayMs(5, 0, noJitter)).toBe(24_000); // 32000 exponent, but ceilinged to 30000 * 0.8
    expect(reconnectDelayMs(9, 0, noJitter)).toBe(24_000); // still ceilinged the same way
  });

  it("caps the base delay at reconnectCeilingMs before jitter", () => {
    expect(reconnectDelayMs(10, 0, { reconnectCeilingMs: 5_000, reconnectExponentCap: 20 })).toBe(4_000);
    expect(reconnectDelayMs(10, 1, { reconnectCeilingMs: 5_000, reconnectExponentCap: 20 })).toBe(6_000);
  });

  it("widens the base delay by +/-20% jitter and clamps random to [0, 1]", () => {
    const config = { reconnectCeilingMs: 30_000, reconnectExponentCap: 5 };
    expect(reconnectDelayMs(0, 1, config)).toBe(1_200); // 1000 * 1.2
    expect(reconnectDelayMs(0, 0.5, config)).toBe(1_000); // 1000 * 1.0
    expect(reconnectDelayMs(0, -5, config)).toBe(800); // clamped to 0 -> * 0.8
    expect(reconnectDelayMs(0, 5, config)).toBe(1_200); // clamped to 1 -> * 1.2
  });
});

describe("SocketWatcherReconnectState.scheduleConnect", () => {
  it("schedules connect() after the computed backoff delay and increments the attempt counter", () => {
    const state = new SocketWatcherReconnectState(CONFIG);
    const connect = vi.fn();
    state.scheduleConnect({
      blocked: false,
      random: () => 0,
      connect,
      giveUp: { onGiveUp: vi.fn() },
    });
    expect(state.reconnectAttempt).toBe(1);
    expect(connect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(799);
    expect(connect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("uses an explicit delayMs instead of the backoff formula when given (e.g. immediate rearm)", () => {
    const state = new SocketWatcherReconnectState(CONFIG);
    const connect = vi.fn();
    state.scheduleConnect({
      blocked: false,
      delayMs: 0,
      random: () => 0,
      connect,
      giveUp: { onGiveUp: vi.fn() },
    });
    vi.advanceTimersByTime(0);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("does not schedule when blocked, already given up, or a reconnect timer is already armed", () => {
    const state = new SocketWatcherReconnectState(CONFIG);
    const connect = vi.fn();
    state.scheduleConnect({ blocked: true, random: () => 0, connect, giveUp: { onGiveUp: vi.fn() } });
    expect(state.reconnectAttempt).toBe(0);

    state.givenUp = true;
    state.scheduleConnect({ blocked: false, random: () => 0, connect, giveUp: { onGiveUp: vi.fn() } });
    expect(state.reconnectAttempt).toBe(0);
    state.givenUp = false;

    state.scheduleConnect({ blocked: false, random: () => 0, connect, giveUp: { onGiveUp: vi.fn() } });
    expect(state.reconnectAttempt).toBe(1);
    // A second call while the timer from the first call is still armed is a no-op.
    state.scheduleConnect({ blocked: false, random: () => 0, connect, giveUp: { onGiveUp: vi.fn() } });
    expect(state.reconnectAttempt).toBe(1);
  });

  it("gives up once the attempt count reaches maxReconnectAttempts, reporting the attempt count and last failure reason", () => {
    const state = new SocketWatcherReconnectState(CONFIG);
    const onGiveUp = vi.fn();
    const connect = vi.fn();
    for (let i = 0; i < CONFIG.maxReconnectAttempts; i += 1) {
      state.scheduleConnect({ blocked: false, random: () => 0, connect, giveUp: { onGiveUp } });
      vi.runOnlyPendingTimers();
    }
    expect(connect).toHaveBeenCalledTimes(CONFIG.maxReconnectAttempts);
    expect(state.givenUp).toBe(false);

    state.lastFailureReason = "socket_closed";
    state.scheduleConnect({ blocked: false, random: () => 0, connect, giveUp: { onGiveUp } });
    expect(state.givenUp).toBe(true);
    expect(onGiveUp).toHaveBeenCalledExactlyOnceWith(CONFIG.maxReconnectAttempts, "socket_closed");
    // No further connect scheduled once given up.
    expect(connect).toHaveBeenCalledTimes(CONFIG.maxReconnectAttempts);
  });

  it("auto-rearms after giveUpRetryMs when onRearm is provided and rearmBlocked is not true", () => {
    const state = new SocketWatcherReconnectState(CONFIG);
    const onRearm = vi.fn();
    for (let i = 0; i < CONFIG.maxReconnectAttempts; i += 1) {
      state.scheduleConnect({ blocked: false, random: () => 0, connect: vi.fn(), giveUp: { onGiveUp: vi.fn() } });
      vi.runOnlyPendingTimers();
    }
    state.scheduleConnect({
      blocked: false,
      random: () => 0,
      connect: vi.fn(),
      giveUp: { onGiveUp: vi.fn(), onRearm, rearmBlocked: () => false },
    });
    expect(state.givenUp).toBe(true);
    vi.advanceTimersByTime((CONFIG.giveUpRetryMs ?? 0) - 1);
    expect(onRearm).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onRearm).toHaveBeenCalledTimes(1);
    expect(state.givenUp).toBe(false);
    expect(state.reconnectAttempt).toBe(0);
  });

  it("stays given up forever when rearmBlocked() is true at the moment the rest elapses", () => {
    const state = new SocketWatcherReconnectState(CONFIG);
    const onRearm = vi.fn();
    for (let i = 0; i < CONFIG.maxReconnectAttempts; i += 1) {
      state.scheduleConnect({ blocked: false, random: () => 0, connect: vi.fn(), giveUp: { onGiveUp: vi.fn() } });
      vi.runOnlyPendingTimers();
    }
    state.scheduleConnect({
      blocked: false,
      random: () => 0,
      connect: vi.fn(),
      giveUp: { onGiveUp: vi.fn(), onRearm, rearmBlocked: () => true },
    });
    vi.advanceTimersByTime(CONFIG.giveUpRetryMs ?? 0);
    expect(onRearm).not.toHaveBeenCalled();
    expect(state.givenUp).toBe(true);
  });

  it("never auto-rearms when giveUpRetryMs is omitted from the config (e.g. public market stream)", () => {
    const state = new SocketWatcherReconnectState({ ...CONFIG, giveUpRetryMs: undefined });
    const onRearm = vi.fn();
    for (let i = 0; i < CONFIG.maxReconnectAttempts; i += 1) {
      state.scheduleConnect({ blocked: false, random: () => 0, connect: vi.fn(), giveUp: { onGiveUp: vi.fn() } });
      vi.runOnlyPendingTimers();
    }
    state.scheduleConnect({
      blocked: false,
      random: () => 0,
      connect: vi.fn(),
      giveUp: { onGiveUp: vi.fn(), onRearm },
    });
    vi.advanceTimersByTime(10 * 60_000);
    expect(onRearm).not.toHaveBeenCalled();
    expect(state.givenUp).toBe(true);
  });
});

describe("SocketWatcherReconnectState.forceRearm", () => {
  it("clears givenUp, resets the attempt counter, and cancels any pending reconnect timer", () => {
    const state = new SocketWatcherReconnectState(CONFIG);
    const connect = vi.fn();
    for (let i = 0; i < CONFIG.maxReconnectAttempts; i += 1) {
      state.scheduleConnect({ blocked: false, random: () => 0, connect, giveUp: { onGiveUp: vi.fn() } });
      vi.runOnlyPendingTimers();
    }
    state.scheduleConnect({ blocked: false, random: () => 0, connect, giveUp: { onGiveUp: vi.fn() } });
    expect(state.givenUp).toBe(true);

    state.forceRearm();
    expect(state.givenUp).toBe(false);
    expect(state.reconnectAttempt).toBe(0);
    expect(state.reconnectTimer).toBeNull();

    // A pending (not yet given-up) reconnect timer is also cancelled.
    state.scheduleConnect({ blocked: false, random: () => 0, connect, giveUp: { onGiveUp: vi.fn() } });
    expect(state.reconnectTimer).not.toBeNull();
    state.forceRearm();
    expect(state.reconnectTimer).toBeNull();
    vi.runAllTimers();
    expect(connect).toHaveBeenCalledTimes(CONFIG.maxReconnectAttempts);
  });
});

describe("SocketWatcherReconnectState handshake timeout", () => {
  it("arms onTimeout after timeoutMs and can be cleared before it fires", () => {
    const state = new SocketWatcherReconnectState(CONFIG);
    const onTimeout = vi.fn();
    state.armHandshakeTimeout(15_000, onTimeout);
    expect(state.handshakeTimer).not.toBeNull();
    vi.advanceTimersByTime(14_999);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(state.handshakeTimer).toBeNull();
  });

  it("re-arming replaces the earlier timer instead of stacking it", () => {
    const state = new SocketWatcherReconnectState(CONFIG);
    const stale = vi.fn();
    const fresh = vi.fn();
    state.armHandshakeTimeout(15_000, stale);
    vi.advanceTimersByTime(10_000);
    state.armHandshakeTimeout(15_000, fresh);
    vi.advanceTimersByTime(15_000);
    expect(stale).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it("does not fire once cleared", () => {
    const state = new SocketWatcherReconnectState(CONFIG);
    const onTimeout = vi.fn();
    state.armHandshakeTimeout(15_000, onTimeout);
    state.clearHandshakeTimeout();
    expect(state.handshakeTimer).toBeNull();
    vi.advanceTimersByTime(15_000);
    expect(onTimeout).not.toHaveBeenCalled();
  });
});

describe("SocketWatcherReconnectState.scheduleKeepalive", () => {
  it("pings on the interval and reschedules itself while tick() returns true", () => {
    const state = new SocketWatcherReconnectState(CONFIG);
    const tick = vi.fn(() => true);
    state.scheduleKeepalive(60_000, () => false, tick);
    vi.advanceTimersByTime(60_000);
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it("stops rescheduling once tick() returns false", () => {
    const state = new SocketWatcherReconnectState(CONFIG);
    const tick = vi.fn(() => false);
    state.scheduleKeepalive(60_000, () => false, tick);
    vi.advanceTimersByTime(60_000);
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(120_000);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(state.keepaliveTimer).toBeNull();
  });

  it("does not arm a timer while blocked() is true, and does not double-arm if already scheduled", () => {
    const state = new SocketWatcherReconnectState(CONFIG);
    const tick = vi.fn(() => true);
    state.scheduleKeepalive(60_000, () => true, tick);
    expect(state.keepaliveTimer).toBeNull();

    state.scheduleKeepalive(60_000, () => false, tick);
    const firstTimer = state.keepaliveTimer;
    state.scheduleKeepalive(60_000, () => false, tick);
    expect(state.keepaliveTimer).toBe(firstTimer);
  });
});

describe("timers cleared on close", () => {
  it("clearSocketTimers clears both the handshake and keepalive timers, leaving the reconnect timer untouched", () => {
    const state = new SocketWatcherReconnectState(CONFIG);
    state.armHandshakeTimeout(15_000, vi.fn());
    state.scheduleKeepalive(60_000, () => false, () => true);
    state.scheduleConnect({ blocked: false, random: () => 0, connect: vi.fn(), giveUp: { onGiveUp: vi.fn() } });
    expect(state.handshakeTimer).not.toBeNull();
    expect(state.keepaliveTimer).not.toBeNull();
    expect(state.reconnectTimer).not.toBeNull();

    state.clearSocketTimers();
    expect(state.handshakeTimer).toBeNull();
    expect(state.keepaliveTimer).toBeNull();
    expect(state.reconnectTimer).not.toBeNull();

    state.clearReconnectTimer();
    expect(state.reconnectTimer).toBeNull();
  });

  it("clearTimer helper clears an armed timer and always returns null", () => {
    const state = new SocketWatcherReconnectState(CONFIG);
    const onTimeout = vi.fn();
    state.armHandshakeTimeout(15_000, onTimeout);
    state.clearHandshakeTimeout();
    vi.advanceTimersByTime(15_000);
    expect(onTimeout).not.toHaveBeenCalled();
  });
});
