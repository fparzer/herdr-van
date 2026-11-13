import assert from "node:assert/strict";
import { test } from "node:test";
import { agentChildren, backgroundJobs } from "../mods/herdr-van/activity.js";

function terminal(snapshot = {}) {
  return {
    address: "t1", state: "live", report: { app: "pi", state: "working" },
    labels: { "herdr.background-jobs": JSON.stringify({
      version: 1, session: "session-1", updatedAt: 10_000,
      jobs: [{ id: "bg1", command: "bun test", startedAt: 1000 }], ...snapshot,
    }) },
  };
}

test("a live session exposes individual background jobs without changing its native status", () => {
  const session = terminal();
  session.report.state = "blocked";
  assert.deepEqual(backgroundJobs(session, 11_000), [{ id: "bg1", command: "bun test", startedAt: 1000 }]);
  assert.equal(session.report.state, "blocked");
});

test("a missing or expired reporter does not leave running jobs in the sidebar", () => {
  assert.deepEqual(backgroundJobs(terminal(), 40_000), []);
  assert.deepEqual(backgroundJobs({ ...terminal(), state: "finished" }, 11_000), []);
  assert.deepEqual(backgroundJobs({ ...terminal(), report: null }, 11_000), []);
  assert.deepEqual(backgroundJobs({ ...terminal(), report: { app: "codex" } }, 11_000), []);
  assert.deepEqual(backgroundJobs({ ...terminal(), labels: {} }, 11_000), []);
});

test("an invalid snapshot cannot add partial job rows", () => {
  const invalid = [
    { version: 2 }, { session: "" }, { updatedAt: 12_000 }, { updatedAt: null }, { jobs: {} },
    { jobs: [null] }, { jobs: [{ id: 1, command: "build", startedAt: 1000 }] },
    { jobs: [{ id: "bg1", command: null, startedAt: 1000 }] },
    { jobs: [{ id: "bg1", command: "build", startedAt: -1 }] },
    { jobs: [{ id: "bg1", command: "build", startedAt: 20_000 }] },
    { jobs: [{ id: "bg1", command: "build", startedAt: 1000 }, { id: "bg1", command: "test", startedAt: 2000 }] },
  ];
  for (const snapshot of invalid) assert.deepEqual(backgroundJobs(terminal(snapshot), 11_000), []);
  for (const value of ["invalid", "null", "[]", "{}", "42"]) {
    assert.deepEqual(backgroundJobs({ ...terminal(), labels: { "herdr.background-jobs": value } }, 11_000), []);
  }
});

test("background jobs remain under the session that owns them when sub-agents also exist", () => {
  const kids = new Map([["parent", [{ address: "child" }]]]);
  const jobs = new Map([
    ["parent", [{ id: "bg1", command: "build" }, { id: "bg2", command: "test" }]],
    ["child", [{ id: "bg1", command: "child build" }]],
    ["unrelated", [{ id: "bg1", command: "unrelated build" }]],
  ]);
  const rows = agentChildren(kids, jobs, "parent");
  assert.deepEqual(rows.map(row => row.job ? [row.owner, row.job.command] : [row.t.address]), [
    ["parent", "build"], ["parent", "test"], ["child"], ["child", "child build"],
  ]);
  assert.deepEqual(rows.map(row => row.lines), [["├"], ["├"], ["└"], ["", "└"]]);
});

test("sessions without jobs keep the existing sub-agent tree", () => {
  const kids = new Map([["parent", [{ address: "first" }, { address: "second" }]], ["first", [{ address: "nested" }]]]);
  const rows = agentChildren(kids, new Map(), "parent");
  assert.deepEqual(rows.map(row => [row.t.address, row.lines]), [
    ["first", ["├"]], ["nested", ["│", "└"]], ["second", ["└"]],
  ]);
  assert.deepEqual(agentChildren(new Map(), new Map(), "parent"), []);
});
