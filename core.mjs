export const VERSION = '0.1.1';
export const PREFIX = 'tt-flight-recorder:v1:';
export const LIMITS = Object.freeze({ sessions: 6, events: 240, chars: 24000 });
const RECORD_PREFIX = `${PREFIX}session:`;
const numberKeys = new Set(['gapMs', 'elapsedMs', 'iframes', 'chatIframes', 'parkedIframes', 'messages', 'canvases', 'videos', 'viewportWidth', 'viewportHeight', 'heapUsedMB', 'heapLimitMB', 'longTasks', 'longTaskTotalMs', 'maxLongTaskMs', 'line', 'column', 'suppressedErrors']);
const enumKeys = {
    navigation: ['navigate', 'reload', 'back_forward', 'unknown'],
    visibility: ['visible', 'hidden', 'prerender', 'unknown'],
    source: ['surface', 'tavern-helper', 'baibai', 'tauri', 'core', 'third-party', 'blob', 'data', 'external', 'inline', 'unknown'],
    error: ['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'EvalError', 'URIError', 'AggregateError', 'SecurityError', 'QuotaExceededError', 'AbortError', 'NetworkError', 'InvalidStateError', 'NotSupportedError', 'TimeoutError', 'UnhandledRejection', 'ResourceError', 'OtherError'],
    marker: ['issue', 'baseline', 'before-switch', 'after-reload'],
    headerMode: ['always', 'scroll', 'tap', 'hidden', 'unknown'],
    messageStyle: ['minimal', 'avatar', 'banner', 'unknown'],
    runtimeProfile: ['auto', 'off', 'compat', 'mobile-safe', 'unknown'],
};
const booleanKeys = new Set(['persisted', 'online', 'previousUnclosed', 'claudeEnabled', 'headerHidden', 'virtualized']);
export const EVENT_NAMES = Object.freeze(['CHAT_CHANGED', 'CHAT_LOADED', 'MESSAGE_SWIPED', 'MESSAGE_UPDATED', 'USER_MESSAGE_RENDERED', 'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_DELETED', 'MORE_MESSAGES_LOADED']);
const kinds = new Set(['start', 'sample', 'visibility', 'pagehide', 'pageshow', 'freeze', 'resume', 'online', 'offline', 'error', 'rejection', 'resource-error', 'marker', 'pause', 'export']);
const validId = value => typeof value === 'string' && /^[a-z0-9-]{8,72}$/i.test(value);
export const versionText = value => typeof value === 'string' && /^[0-9][0-9A-Za-z.+_-]{0,31}$/.test(value.trim()) ? value.trim() : '';
const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e13;

// Only explicit diagnostic fields can cross the persistence/export boundary.
// Never serialize arbitrary errors, settings, event arguments or DOM text.
export function safeData(input = {}) {
    const result = {};
    if (!input || typeof input !== 'object') return result;
    for (const [key, value] of Object.entries(input)) {
        if (numberKeys.has(key) && numeric(value)) result[key] = Math.round(value * 10) / 10;
        else if (booleanKeys.has(key) && typeof value === 'boolean') result[key] = value;
        else if (Object.hasOwn(enumKeys, key) && enumKeys[key].includes(value)) result[key] = value;
        else if (key === 'fingerprint' && typeof value === 'string' && /^[a-f0-9]{8}$/.test(value)) result[key] = value;
        else if (key === 'events' && value && typeof value === 'object') {
            result.events = {};
            for (const name of EVENT_NAMES) if (numeric(value[name])) result.events[name] = value[name];
        }
    }
    return result;
}

export function safeEnvironment(input = {}) {
    const result = {};
    if (!input || typeof input !== 'object') return result;
    for (const key of ['osVersion', 'uaOSVersion', 'webKitVersion', 'chromiumVersion', 'nativeVersion', 'recorderVersion']) {
        const value = versionText(input[key]);
        if (value) result[key] = value;
    }
    for (const key of ['cores', 'deviceMemoryGB', 'screenWidth', 'screenHeight', 'pixelRatio']) {
        if (numeric(input[key])) result[key] = Math.round(input[key] * 10) / 10;
    }
    for (const key of ['isTauri', 'heapMetricAvailable', 'longTaskMetricAvailable']) {
        if (typeof input[key] === 'boolean') result[key] = input[key];
    }
    if (['ios', 'windows', 'android', 'macos', 'linux', 'ohos', 'unknown'].includes(input.platform)) result.platform = input.platform;
    if (typeof input.timezoneOffsetMinutes === 'number' && Math.abs(input.timezoneOffsetMinutes) <= 840) result.timezoneOffsetMinutes = input.timezoneOffsetMinutes;
    return result;
}

export function cleanSession(value) {
    if (!value || value.schema !== 1 || !validId(value.id) || !validId(value.stream) || !numeric(value.startedAt) || !numeric(value.lastSeenAt)) return null;
    return {
        schema: 1, recorderVersion: VERSION, id: value.id, stream: value.stream,
        startedAt: value.startedAt, lastSeenAt: value.lastSeenAt, closed: value.closed === true,
        environment: safeEnvironment(value.environment),
        events: (Array.isArray(value.events) ? value.events : []).slice(-LIMITS.events)
            .filter(event => event && numeric(event.at) && kinds.has(event.kind))
            .map(event => ({ at: event.at, kind: event.kind, data: safeData(event.data) })),
    };
}

export class Recorder {
    constructor({ storage, now = Date.now, makeId, stream, environment = {} }) {
        this.storage = storage; this.now = now; this.makeId = makeId; this.stream = stream;
        this.environment = safeEnvironment(environment); this.session = null; this.active = false;
        this.storageError = null; this.lastSavedAt = null; this.retryAt = 0;
    }
    read() {
        const sessions = [];
        try {
            for (let i = 0; i < this.storage.length; i++) {
                const key = this.storage.key(i);
                if (!key?.startsWith(RECORD_PREFIX)) continue;
                const text = this.storage.getItem(key);
                if (!text || text.length > LIMITS.chars) continue;
                try {
                    const session = cleanSession(JSON.parse(text));
                    if (session && key === RECORD_PREFIX + session.id) sessions.push(session);
                } catch { /* A damaged diagnostic entry never stops the host. */ }
            }
        } catch { this.storageError = 'unavailable'; }
        return sessions.sort((a, b) => a.startedAt - b.startedAt);
    }
    begin(navigation = 'unknown') {
        if (this.active) return;
        const previous = this.read().filter(session => session.stream === this.stream).at(-1);
        const now = this.now();
        this.session = { schema: 1, recorderVersion: VERSION, id: this.makeId(), stream: this.stream, startedAt: now, lastSeenAt: now, closed: false, environment: this.environment, events: [] };
        this.active = true;
        this.record('start', { navigation, previousUnclosed: !!previous && !previous.closed, ...(previous ? { gapMs: Math.max(0, now - previous.lastSeenAt) } : {}) });
        this.flush(true);
    }
    record(kind, data = {}) {
        if (!this.active || !this.session || !kinds.has(kind)) return;
        this.session.lastSeenAt = this.now();
        this.session.events.push({ at: this.now(), kind, data: safeData(data) });
        if (this.session.events.length > LIMITS.events) this.session.events.splice(0, this.session.events.length - LIMITS.events);
    }
    checkpoint(kind, data = {}) {
        if (!this.active) return;
        if (kind === 'pagehide') this.session.closed = true;
        if (kind === 'pageshow' || kind === 'resume') this.session.closed = false;
        this.record(kind, data); this.flush(true);
    }
    flush(force = false) {
        if (!this.active || !this.session || (!force && this.now() < this.retryAt)) return false;
        try {
            const old = this.read().filter(session => session.id !== this.session.id);
            while (old.length >= LIMITS.sessions) this.storage.removeItem(RECORD_PREFIX + old.shift().id);
            // Cap characters as well as event count, so storms cannot grow storage.
            let text = JSON.stringify(this.session);
            while (text.length > LIMITS.chars && this.session.events.length > 1) {
                this.session.events.splice(0, Math.max(1, Math.ceil(this.session.events.length / 10)));
                text = JSON.stringify(this.session);
            }
            if (text.length > LIMITS.chars) throw new Error('record-too-large');
            this.storage.setItem(RECORD_PREFIX + this.session.id, text);
            this.storageError = null; this.lastSavedAt = this.now(); this.retryAt = 0;
            return true;
        } catch (error) {
            this.storageError = error?.name === 'QuotaExceededError' ? 'quota' : 'unavailable';
            this.retryAt = this.now() + 30000;
            return false;
        }
    }
    pause() {
        if (!this.active) return;
        this.session.closed = true; this.record('pause'); this.flush(true); this.active = false;
    }
    clear() {
        try {
            const keys = [];
            for (let i = 0; i < this.storage.length; i++) if (this.storage.key(i)?.startsWith(RECORD_PREFIX)) keys.push(this.storage.key(i));
            keys.forEach(key => this.storage.removeItem(key));
        } catch { this.storageError = 'unavailable'; }
        if (this.session) {
            this.session.events = [];
            this.session.startedAt = this.now();
            this.session.lastSeenAt = this.now();
            if (this.active) { this.record('marker', { marker: 'baseline' }); this.flush(true); }
        }
    }
    export() {
        const persisted = this.read();
        const sessions = persisted.filter(session => session.id !== this.session?.id);
        if (this.session) sessions.push(cleanSession(this.session));
        return {
            format: 'tavern-flight-recorder', schema: 1, recorderVersion: VERSION, exportedAt: this.now(),
            storage: { persistent: !this.storageError && (!!this.lastSavedAt || persisted.length > 0), currentSessionSaved: !!this.lastSavedAt, lastSavedAt: this.lastSavedAt, error: this.storageError },
            limitations: ['No native WebContent termination reason or Jetsam data is available to this extension.', 'An unclosed session is a clue, not proof of a crash or out-of-memory termination.', 'No chat text, request data, credentials, full URLs, raw error messages or iframe contents are recorded.'],
            sessions: sessions.sort((a, b) => a.startedAt - b.startedAt).slice(-LIMITS.sessions),
        };
    }
}
