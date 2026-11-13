import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { test } from "node:test";

// The native renderer is unavailable in Node; keep its callbacks and content observable.
function element() {
  const node = { items: [] };
  const proxy = new Proxy(node, {
    get(target, name) {
      if (name in target) return target[name];
      return (...args) => {
        if (name === "id") target.key = args[0];
        if (name === "child") target.items.push(args[0]);
        if (name === "children") target.items.push(...args[0]);
        if (name === "when" && args[0]) args[1](proxy);
        if (name === "on_click") target.click = args[0];
        return proxy;
      };
    },
  });
  return proxy;
}

function find(node, id) {
  if (!node || typeof node !== "object") return undefined;
  if (node.key === id) return node;
  for (const child of node.items) {
    const found = find(child, id);
    if (found) return found;
  }
}

async function sidebar() {
  const now = 100_000;
  const storage = new Map();
  const commands = [];
  const jobs = [{ id: "bg1", command: "bun test", startedAt: 1000 }, { id: "bg2", command: "make all", startedAt: 2000 }];
  const agent = { address: "t1", pane: "p1", space: "s1", space_name: "Project", tab: "tab1", tab_name: "Build", status: "blocked", title: "Build", seq: 1, focused: true };
  const state = {
    width: 268,
    agents: [agent],
    terminals: [{ address: "t1", state: "live", report: { app: "pi", state: "blocked" }, labels: {} }],
  };
  const setJobs = (list) => {
    state.terminals[0].labels["herdr.background-jobs"] = JSON.stringify({ version: 1, session: "session-1", updatedAt: now, jobs: list });
  };
  setJobs(jobs);
  const shared = new Map();
  const context = vm.createContext({
    Date: class extends Date { static now() { return now; } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
  });
  const modules = new Map();
  const host = {
    agents: () => state.agents, terminals: () => state.terminals,
    panes: () => [{ pane: "p1", terminal: "t1", tab: "tab1", focused: true, title: "Build" }],
    spaces: () => [{ id: "s1", tabs: [{ id: "tab1", name: "Build" }] }],
    focused: () => ({ agent: "t1" }), theme: () => ({}),
    run: (name, args) => commands.push({ name, args: structuredClone(args) }),
    shared: key => shared.get(key), setShared: (key, value) => shared.set(key, value),
    setAgentOrder: () => {}, openOverlay: () => {}, closeOverlay: () => {}, props: () => ({}),
    layout: () => ({ children: [{ id: "sidebar", size: { px: state.width } }] }), window: () => ({}),
  };
  const external = {
    "gpui-kit": { div: element, svg: element, image: element },
    "gpui-base": { v_flex: element, h_flex: element, ScrollHandle: { new: () => ({ scroll_to_item: () => {} }) } },
    herdr: host,
  };
  async function load(name, parent) {
    const key = name in external ? name : new URL(name, parent).href;
    if (modules.has(key)) return modules.get(key);
    const mod = name in external
      ? new vm.SyntheticModule(Object.keys(external[name]), function () {
        for (const [key, value] of Object.entries(external[name])) this.setExport(key, value);
      }, { context })
      : new vm.SourceTextModule(await readFile(fileURLToPath(key), "utf8"), { context, identifier: key });
    modules.set(key, mod);
    await mod.link((specifier, referrer) => load(specifier, referrer.identifier));
    return mod;
  }
  const module = await load("../mods/herdr-van/agents.js", import.meta.url);
  await module.evaluate();
  const cx = { timer: { every: () => {} }, notify: () => {}, stop_propagation: () => {} };
  const create = () => {
    const view = new module.namespace.default();
    view.init({}, cx);
    return view;
  };
  return { view: create(), create, state, commands, jobs, setJobs, cx };
}

test("you can fold jobs beneath their session and keep that choice after a sidebar reload", async () => {
  const w = await sidebar();
  let tree = w.view.render(w.cx);
  assert.ok(find(tree, "job-t1-bg1"));
  assert.ok(find(tree, "job-t1-bg2"));
  find(tree, "fold-t1").click({}, w.cx);
  tree = w.view.render(w.cx);
  assert.equal(find(tree, "job-t1-bg1"), undefined);
  const reloaded = w.create();
  tree = reloaded.render(w.cx);
  assert.equal(find(tree, "job-t1-bg2"), undefined);
  find(tree, "fold-t1").click({}, w.cx);
  assert.ok(find(reloaded.render(w.cx), "job-t1-bg2"));
  assert.equal(w.state.agents[0].status, "blocked");
});

test("finishing jobs disappear without removing the owning session", async () => {
  const w = await sidebar();
  w.setJobs([w.jobs[1]]);
  let tree = w.view.render(w.cx);
  assert.equal(find(tree, "job-t1-bg1"), undefined);
  assert.ok(find(tree, "job-t1-bg2"));
  w.setJobs([]);
  tree = w.view.render(w.cx);
  assert.equal(find(tree, "job-t1-bg2"), undefined);
  assert.equal(find(tree, "fold-t1"), undefined);
  assert.ok(find(tree, "ag-t1"));
});

test("clicking a job focuses its owning session rather than the current selection", async () => {
  const w = await sidebar();
  find(w.view.render(w.cx), "job-t1-bg1").click({}, w.cx);
  assert.deepEqual(w.commands, [{ name: "pane.focus", args: { pane: "p1" } }]);
});

test("a job owned by a child without a pane opens that child's terminal preview", async () => {
  const w = await sidebar();
  w.state.terminals.push({
    address: "child", parent: "t1", state: "live", status: "working", report: { app: "pi", state: "working" },
    labels: { "herdr.background-jobs": JSON.stringify({
      version: 1, session: "child-session", updatedAt: 100_000,
      jobs: [{ id: "bg1", command: "child build", startedAt: 1000 }],
    }) },
  });
  const tree = w.view.render(w.cx);
  assert.ok(find(tree, "job-t1-bg1"));
  find(tree, "job-child-bg1").click({}, w.cx);
  assert.deepEqual(w.commands, [{ name: "terminal.peek", args: { terminal: "child" } }]);
});

test("the collapsed sidebar rail does not expose expanded job rows", async () => {
  const w = await sidebar();
  w.state.width = 44;
  const tree = w.view.render(w.cx);
  assert.equal(find(tree, "job-t1-bg1"), undefined);
  assert.ok(find(tree, "ag-t1"));
});
