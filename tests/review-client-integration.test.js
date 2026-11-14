import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as client from '../src/client/api.js';

const root = new URL('../', import.meta.url);
const jsx = readFileSync(new URL('src/client/index.jsx', root), 'utf8');
const hookStart = jsx.indexOf('function useTaskAutoRefresh(');
const body = jsx.slice(hookStart, jsx.indexOf('\n}', hookStart) + 2);

function mountHook(store) {
  let now = 0, nextId = 1, slot = 0, active = true, effectWork = [];
  const slots = [], effects = [], timers = new Map(), listeners = new Set();
  const doc = { hidden: false, addEventListener: (_, f) => listeners.add(f), removeEventListener: (_, f) => listeners.delete(f) };
  const useRef = (value) => slots[slot++] ??= { current: value };
  const useState = (value) => {
    const at = slot++;
    if (!(at in slots)) slots[at] = value;
    return [slots[at], (next) => { if (Object.is(slots[at], next)) return; slots[at] = next; if (active) render(); }];
  };
  const useEffect = (effect, deps) => {
    const at = slot++;
    const previous = effects[at];
    if (previous && deps.every((v, i) => Object.is(v, previous.deps[i]))) return;
    effectWork.push(() => { previous?.cleanup?.(); effects[at] = { deps, cleanup: effect() }; });
  };
  const hook = new Function('useRef','useState','useEffect','recordRefreshPlan','hasChangingRecords','RECORD_REFRESH_INTERVAL_MS','describeError','globalThis','setTimeout','clearTimeout', `${body}\nreturn useTaskAutoRefresh;`)(
    useRef, useState, useEffect, client.recordRefreshPlan, client.hasChangingRecords,
    client.RECORD_REFRESH_INTERVAL_MS, client.describeError, { document: doc },
    (fn, delay) => { const id = nextId++; timers.set(id, { at: now + delay, fn }); return id; },
    (id) => timers.delete(id));
  function render() {
    slot = 0; hook({ store, snapshot: store.getSnapshot() });
    const work = effectWork; effectWork = []; work.forEach((run) => run());
  }
  const unsubscribe = store.subscribe(render);
  render();
  return {
    timers, listeners,
    async advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
      await new Promise((resolve) => setImmediate(resolve));
    },
    async visibility(hidden) { doc.hidden = hidden; for (const fn of [...listeners]) fn(); await new Promise((resolve) => setImmediate(resolve)); },
    close() { active = false; unsubscribe(); for (const effect of effects) effect?.cleanup?.(); },
  };
}

for (const decision of ['accepted', 'changes-requested']) {
  test(`actual refresh hook and store fetch an external ${decision} then stop`, async () => {
    let backend = { taskId: 'waiting', state: 'awaiting-host-review', hostAcceptance: null };
    let reads = 0, fail = false;
    const store = client.createStore({ api: { async listTasks() { reads++; if (fail) throw new Error('test connection interrupted'); return { tasks: [structuredClone(backend)] }; } } });
    await store.loadTasks();
    const driver = mountHook(store);
    try {
      assert.equal(driver.timers.size, 1);
      await driver.visibility(true); await driver.advance(5000);
      assert.equal(reads, 1, 'a hidden document performs no read');
      await driver.visibility(false);
      assert.equal(reads, 2, 'returning to the page reads immediately');
      fail = true; await driver.advance(5000);
      assert.equal(store.getSnapshot().tasks[0].taskId, 'waiting', 'connection failure preserves displayed content');
      fail = false;
      backend = { ...backend, hostAcceptance: { accepted: decision === 'accepted', state: decision, acceptedAt: Date.now(), note: 'whole note' }, reviewPersistence: { state: 'saved', durable: true, pending: false } };
      await driver.advance(5000);
      assert.equal(store.getSnapshot().tasks[0].hostAcceptance.state, decision);
      assert.equal(driver.timers.size, 0, 'a confirmed record stops the timer');

    } finally { driver.close(); store.dispose(); }
    assert.equal(driver.listeners.size, 0);
  });
}

test('unmount releases the actual refresh hook timer and visibility listener', async () => {
  const store = client.createStore({ api: { async listTasks() { return { tasks: [{ taskId:'t',state:'awaiting-host-review',hostAcceptance:null }] }; } } });
  await store.loadTasks(); const driver = mountHook(store);
  assert.equal(driver.timers.size, 1);
  driver.close(); store.dispose();
  assert.equal(driver.timers.size, 0); assert.equal(driver.listeners.size, 0);
});


for (const scenario of ['missing', 'throw', 'reject', 'success']) {
  test('review-note clipboard: ' + scenario, async () => {
    const component = jsx.slice(jsx.indexOf('function ReviewNoteDetail('), jsx.indexOf('\nfunction TaskDetail('));
    const start = component.indexOf('  const copy = () => {');
    const block = component.slice(start, component.indexOf('\n  return (', start));
    let state = null, copied = null;
    const full = '😀中'.repeat(3999) + '末尾验收';
    const clipboard = scenario === 'missing' ? undefined : { writeText(value) {
      if (scenario === 'throw') throw new Error('sync denied');
      if (scenario === 'reject') return Promise.reject(new Error('async denied'));
      copied = value; return Promise.resolve();
    } };
    const copy = new Function('setCopyState', 'full', 'globalThis', block + '\nreturn copy;')(
      (value) => { state = value; }, full, { navigator: { clipboard } });
    copy(); await new Promise((resolve) => setImmediate(resolve));
    if (scenario === 'success') {
      assert.equal(state, '已复制完整审查意见'); assert.equal(copied, full);
    } else { assert.match(state, /复制失败/u); assert.equal(copied, null); }
  });
}
