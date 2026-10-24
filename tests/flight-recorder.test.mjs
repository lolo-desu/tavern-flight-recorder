import test from 'node:test';
import assert from 'node:assert/strict';
import { Recorder, PREFIX, LIMITS, safeData, safeEnvironment } from '../core.mjs';

class Storage {
    data = new Map(); fail = false; writes = 0;
    get length() { return this.data.size; }
    key(index) { return [...this.data.keys()][index] ?? null; }
    getItem(key) { return this.data.get(key) ?? null; }
    removeItem(key) { this.data.delete(key); }
    setItem(key, value) {
        this.writes++;
        if (this.fail) { const e = new Error(); e.name = 'QuotaExceededError'; throw e; }
        this.data.set(key, value);
    }
}
function setup(storage = new Storage()) {
    let clock = 1000000000000, id = 0;
    return { storage, advance: ms => { clock += ms; }, create: (stream = 'test-stream-0001') => new Recorder({ storage, now: () => clock, makeId: () => `test-session-${String(++id).padStart(5, '0')}`, stream, environment: { platform: 'ios', nativeVersion: '2.4.0', apiKey: 'DO-NOT-SAVE', chat: 'PRIVATE-CHAT' } }) };
}

test('abrupt termination preserves checkpoint and links only the same tab on restart', () => {
    const fixture = setup();
    const first = fixture.create(); first.begin('navigate');
    first.record('sample', { iframes: 12, chatIframes: 8 }); first.flush();
    // No cleanup handler runs: simulate a killed web process.
    fixture.advance(8000);
    const next = fixture.create(); next.begin('reload');
    const sessions = next.export().sessions;
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].closed, false);
    assert.equal(sessions[0].events.at(-1).data.iframes, 12);
    assert.equal(sessions[1].events[0].data.previousUnclosed, true);
    assert.equal(sessions[1].events[0].data.gapMs, 8000);
    const otherTab = fixture.create('different-tab-0001'); otherTab.begin('navigate');
    assert.equal(otherTab.session.events[0].data.previousUnclosed, false);
});

test('normal pagehide and bfcache restoration are distinguished from an unclosed page', () => {
    const fixture = setup(); const first = fixture.create(); first.begin();
    first.checkpoint('pagehide', { persisted: true });
    assert.equal(first.read()[0].closed, true);
    first.checkpoint('pageshow', { persisted: true });
    assert.equal(first.read()[0].closed, false);
    first.checkpoint('pagehide', { persisted: false });
    fixture.advance(1000);
    const next = fixture.create(); next.begin('reload');
    assert.equal(next.session.events[0].data.previousUnclosed, false);
});

test('session retention, event count and serialized size stay bounded under a storm', () => {
    const fixture = setup();
    fixture.storage.setItem('settings-user-data', 'KEEP');
    for (let i = 0; i < 10; i++) {
        fixture.advance(1000);
        const recorder = fixture.create(); recorder.begin();
        for (let j = 0; j < 1500; j++) recorder.record('sample', { iframes: j, events: { MESSAGE_SWIPED: 50 }, gapMs: 900, viewportWidth: 430, viewportHeight: 932, longTasks: 20, maxLongTaskMs: 2100, longTaskTotalMs: 5000 });
        assert.ok(recorder.session.events.length <= LIMITS.events);
        assert.equal(recorder.flush(), true);
    }
    const keys = [...fixture.storage.data.keys()].filter(key => key.startsWith(`${PREFIX}session:`));
    assert.equal(keys.length, LIMITS.sessions);
    for (const key of keys) assert.ok(fixture.storage.getItem(key).length <= LIMITS.chars);
    assert.equal(fixture.storage.getItem('settings-user-data'), 'KEEP');
});

test('only allowlisted fields reach storage and export, including hostile prior entries', () => {
    assert.deepEqual(safeData(null), {});
    assert.deepEqual(safeData({ constructor: 'secret', toString: 'secret', iframes: NaN, gapMs: Infinity, line: -1 }), {});
    assert.deepEqual(safeEnvironment(null), {});
    const fixture = setup(); const first = fixture.create(); first.begin();
    first.record('error', { error: 'TypeError', fingerprint: '1234abcd', message: 'PRIVATE-CHAT', stack: 'https://secret.example/key=DO-NOT-SAVE', apiKey: 'DO-NOT-SAVE', source: 'surface', events: { MESSAGE_SWIPED: 2, chat: 'PRIVATE-CHAT' } });
    first.flush();
    const stored = JSON.parse(fixture.storage.getItem(`${PREFIX}session:${first.session.id}`));
    stored.environment.chat = 'PRIVATE-CHAT'; stored.events.push({ at: 1000, kind: 'sample', data: { chat: 'PRIVATE-CHAT', iframes: 99 } });
    fixture.storage.setItem(`${PREFIX}session:${stored.id}`, JSON.stringify(stored));
    fixture.advance(1000);
    const next = fixture.create(); next.begin('reload');
    const text = JSON.stringify(next.export());
    assert.ok(!text.includes('PRIVATE-CHAT')); assert.ok(!text.includes('DO-NOT-SAVE')); assert.ok(!text.includes('secret.example'));
    assert.ok(text.includes('1234abcd')); assert.ok(text.includes('TypeError'));
});

test('quota errors cannot escape or delete host data; cooldown limits write attempts', () => {
    const fixture = setup(); fixture.storage.setItem('settings-user-data', 'KEEP');
    fixture.storage.fail = true;
    const recorder = fixture.create(); assert.doesNotThrow(() => recorder.begin());
    assert.equal(recorder.storageError, 'quota');
    const writes = fixture.storage.writes;
    for (let i = 0; i < 5; i++) recorder.flush();
    assert.equal(fixture.storage.writes, writes);
    recorder.record('sample', { iframes: 7 });
    assert.equal(recorder.export().sessions.at(-1).events.at(-1).data.iframes, 7);
    assert.equal(recorder.export().storage.persistent, false);
    fixture.storage.fail = false; fixture.advance(30001);
    assert.equal(recorder.flush(), true); assert.equal(recorder.storageError, null);
    assert.equal(fixture.storage.getItem('settings-user-data'), 'KEEP');
});

test('pause, disabled startup, corrupt storage and explicit clear remain contained', () => {
    const fixture = setup(); fixture.storage.setItem('settings-user-data', 'KEEP');
    fixture.storage.setItem(`${PREFIX}session:corrupt-data-0001`, '{bad json');
    const recorder = fixture.create(); assert.equal(recorder.active, false);
    assert.doesNotThrow(() => recorder.export());
    recorder.begin(); recorder.pause();
    const size = recorder.session.events.length;
    recorder.record('sample', { iframes: 900 }); recorder.flush();
    assert.equal(recorder.session.events.length, size);
    assert.equal(recorder.session.closed, true);
    recorder.clear();
    assert.equal(fixture.storage.getItem('settings-user-data'), 'KEEP');
    assert.equal([...fixture.storage.data.keys()].filter(key => key.startsWith(`${PREFIX}session:`)).length, 0);
    const unavailable = new Recorder({ storage: null, makeId: () => 'offline-session-0001', stream: 'offline-stream-0001' });
    assert.doesNotThrow(() => unavailable.begin());
    assert.equal(unavailable.export().storage.persistent, false);
    assert.equal(unavailable.export().sessions.length, 1);
});
