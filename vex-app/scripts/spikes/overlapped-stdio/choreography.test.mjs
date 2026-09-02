/**
 * Table test for the spike harness choreography (stage B4.2a).
 *
 * Runs with plain `node --test` from vex-app:
 *
 *   node --test scripts/spikes/overlapped-stdio/choreography.test.mjs
 *
 * It is deliberately NOT part of the vitest suites: the module under test is
 * part of the spike, and this file is DELETED with the spike at stage B4.3
 * (see README.md). The scripted-event shape follows VS Code's
 * `platform/terminal/test/node/ptyHostService.test.ts`, which drives a
 * lifecycle with fabricated events and asserts on observable counts rather
 * than on timing.
 *
 * The first case is the regression from the 2026-09-01 Windows run: the child
 * emits `phase_begin` before `phase_expects`, and the harness must still pump.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTION_DRAIN_UNREAD_PLANE,
  ACTION_END_THROUGHPUT_PHASE,
  ACTION_RECORD_THROUGHPUT_ERROR,
  ACTION_RECORD_THROUGHPUT_REQUEST,
  ACTION_START_THROUGHPUT_WRITE,
  MISSING_THROUGHPUT_BEGIN,
  MISSING_THROUGHPUT_SIZE,
  createChoreography,
} from "./choreography.mjs";

const BEGIN = { event: "phase_begin", phase: "throughput" };
const EXPECTS = {
  event: "phase_expects",
  phase: "throughput",
  bytes_each_direction: 4194304,
  chunk_bytes: 32768,
};
const END_OK = { event: "phase_end", phase: "throughput", ok: true };
const BACKPRESSURE_END = { event: "phase_end", phase: "write_backpressure", ok: true };

/** Drives a whole event script and returns every action, in order. */
function drive(events) {
  const choreography = createChoreography();
  const actions = [];
  for (const event of events) actions.push(...choreography.onEvent(event));
  return actions;
}

const starts = (actions) => actions.filter((a) => a.type === ACTION_START_THROUGHPUT_WRITE);
const errors = (actions) => actions.filter((a) => a.type === ACTION_RECORD_THROUGHPUT_ERROR);

const cases = [
  {
    name: "phase_begin BEFORE phase_expects still starts the pump (the Windows regression)",
    events: [BEGIN, EXPECTS, END_OK],
    expect: (actions) => {
      assert.deepEqual(starts(actions), [
        { type: ACTION_START_THROUGHPUT_WRITE, totalBytes: 4194304 },
      ]);
      assert.deepEqual(errors(actions), []);
    },
  },
  {
    name: "phase_expects BEFORE phase_begin starts the pump exactly once",
    events: [EXPECTS, BEGIN, END_OK],
    expect: (actions) => {
      assert.deepEqual(starts(actions), [
        { type: ACTION_START_THROUGHPUT_WRITE, totalBytes: 4194304 },
      ]);
      assert.deepEqual(errors(actions), []);
    },
  },
  {
    name: "the announced size is recorded whichever order it arrives in",
    events: [BEGIN, EXPECTS],
    expect: (actions) => {
      assert.deepEqual(
        actions.filter((a) => a.type === ACTION_RECORD_THROUGHPUT_REQUEST),
        [{ type: ACTION_RECORD_THROUGHPUT_REQUEST, totalBytes: 4194304 }],
      );
    },
  },
  {
    name: "duplicate phase_begin and phase_expects cannot double-start or restart the pump",
    events: [EXPECTS, BEGIN, BEGIN, EXPECTS, BEGIN, END_OK],
    expect: (actions) => {
      assert.equal(starts(actions).length, 1);
      assert.deepEqual(errors(actions), []);
    },
  },
  {
    name: "a second announcement with a different size does not change the started pump",
    events: [
      EXPECTS,
      BEGIN,
      { ...EXPECTS, bytes_each_direction: 999 },
      END_OK,
    ],
    expect: (actions) => {
      assert.deepEqual(starts(actions), [
        { type: ACTION_START_THROUGHPUT_WRITE, totalBytes: 4194304 },
      ]);
      const recorded = actions.filter((a) => a.type === ACTION_RECORD_THROUGHPUT_REQUEST);
      assert.deepEqual(recorded.map((a) => a.totalBytes), [4194304, 4194304]);
    },
  },
  {
    name: "a phase that ends with no announcement reports the missing size",
    events: [BEGIN, END_OK],
    expect: (actions) => {
      assert.deepEqual(starts(actions), []);
      assert.deepEqual(errors(actions), [
        { type: ACTION_RECORD_THROUGHPUT_ERROR, message: MISSING_THROUGHPUT_SIZE },
      ]);
      assert.equal(
        actions.filter((a) => a.type === ACTION_END_THROUGHPUT_PHASE).length,
        1,
      );
    },
  },
  {
    name: "a phase announced but never begun reports that instead of the missing size",
    events: [EXPECTS, END_OK],
    expect: (actions) => {
      assert.deepEqual(starts(actions), []);
      assert.deepEqual(errors(actions), [
        { type: ACTION_RECORD_THROUGHPUT_ERROR, message: MISSING_THROUGHPUT_BEGIN },
      ]);
    },
  },
  {
    name: "a non-positive or non-numeric announcement is not an announcement",
    events: [BEGIN, { ...EXPECTS, bytes_each_direction: 0 }, { ...EXPECTS, bytes_each_direction: "4194304" }, END_OK],
    expect: (actions) => {
      assert.deepEqual(starts(actions), []);
      assert.deepEqual(errors(actions), [
        { type: ACTION_RECORD_THROUGHPUT_ERROR, message: MISSING_THROUGHPUT_SIZE },
      ]);
    },
  },
  {
    name: "an announcement arriving AFTER the phase ended cannot start a late pump",
    events: [BEGIN, END_OK, EXPECTS, BEGIN],
    expect: (actions) => {
      assert.deepEqual(starts(actions), []);
      assert.deepEqual(errors(actions), [
        { type: ACTION_RECORD_THROUGHPUT_ERROR, message: MISSING_THROUGHPUT_SIZE },
      ]);
    },
  },
  {
    name: "a duplicate phase_end reports the failure once, not twice",
    events: [BEGIN, END_OK, END_OK],
    expect: (actions) => {
      assert.equal(errors(actions).length, 1);
      assert.equal(
        actions.filter((a) => a.type === ACTION_END_THROUGHPUT_PHASE).length,
        1,
      );
    },
  },
  {
    name: "the unread plane is drained once, on the backpressure phase end only",
    events: [BACKPRESSURE_END, BACKPRESSURE_END, { event: "phase_begin", phase: "write_backpressure" }],
    expect: (actions) => {
      assert.deepEqual(actions, [{ type: ACTION_DRAIN_UNREAD_PLANE }]);
    },
  },
  {
    name: "events from other phases, and malformed events, yield no actions",
    events: [
      { event: "discovery_done", planes_opened: 4 },
      { event: "phase_begin", phase: "read_deadline" },
      { event: "phase_end", phase: "close_cancels_blocked_read", ok: true },
      { event: "phase_skipped", phase: "throughput", reason: "plane 3 was not inherited" },
      { event: "phase_expects", phase: "drain_handshake", wait_ms: 15000 },
      null,
      "not an object",
      {},
    ],
    expect: (actions) => {
      assert.deepEqual(actions, []);
    },
  },
  {
    name: "the full happy script in the order the instrument emits it",
    events: [
      { event: "discovery_done", planes_opened: 4 },
      { event: "phase_begin", phase: "concurrent_duplex" },
      { event: "phase_end", phase: "concurrent_duplex", ok: true },
      EXPECTS,
      BEGIN,
      END_OK,
      { event: "phase_begin", phase: "close_cancels_blocked_read" },
      { event: "phase_end", phase: "close_cancels_blocked_read", ok: true },
      { event: "phase_begin", phase: "write_backpressure" },
      BACKPRESSURE_END,
      { event: "phase_expects", phase: "drain_handshake", wait_ms: 15000 },
      { event: "phase_begin", phase: "drain_handshake" },
      { event: "phase_end", phase: "drain_handshake", ok: true },
    ],
    expect: (actions) => {
      assert.deepEqual(actions, [
        { type: ACTION_RECORD_THROUGHPUT_REQUEST, totalBytes: 4194304 },
        { type: ACTION_START_THROUGHPUT_WRITE, totalBytes: 4194304 },
        { type: ACTION_END_THROUGHPUT_PHASE },
        { type: ACTION_DRAIN_UNREAD_PLANE },
      ]);
    },
  },
];

for (const testCase of cases) {
  test(testCase.name, () => {
    testCase.expect(drive(testCase.events));
  });
}
