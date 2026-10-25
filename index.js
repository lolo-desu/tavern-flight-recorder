import { Recorder, VERSION, PREFIX, EVENT_NAMES, versionText } from './core.mjs';

// No fetch/XHR interception, console patching, iframe injection or DOM observers.
// Only the top-level host runs the recorder.
if (window.top === window && !window.__TAVERN_FLIGHT_RECORDER__) {
    window.__TAVERN_FLIGHT_RECORDER__ = true;
    initialize();
}

function initialize() {
    const storage = getStorage('localStorage');
    const configKey = `${PREFIX}config`;
    const config = readConfig();
    const makeId = () => `${Date.now().toString(36)}-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
    let stream = makeId();
    try {
        const tabStorage = getStorage('sessionStorage');
        const previous = tabStorage.getItem(`${PREFIX}stream`);
        if (previous && /^[a-z0-9-]{8,72}$/i.test(previous)) stream = previous;
        else tabStorage.setItem(`${PREFIX}stream`, stream);
    } catch { /* Exports still include prior sessions if tab identity is lost. */ }

    const ua = navigator.userAgent;
    const host = window.__TAURITAVERN_HOST__;
    const ios = /iPad|iPhone|iPod/.test(ua) || (/Mac/.test(ua) && navigator.maxTouchPoints > 1);
    const platform = ['ios', 'windows', 'android', 'macos', 'linux', 'ohos'].includes(host?.platform)
        ? host.platform : ios ? 'ios' : /Android/.test(ua) ? 'android' : /Windows/.test(ua) ? 'windows' : /Mac/.test(ua) ? 'macos' : /Linux/.test(ua) ? 'linux' : 'unknown';
    const longTaskSupported = globalThis.PerformanceObserver?.supportedEntryTypes?.includes('longtask') || false;
    const recorder = new Recorder({
        storage, makeId, stream,
        environment: {
            recorderVersion: VERSION, platform,
            // WebKit freezes the OS token for compatibility. It is not the real
            // iOS release; only an explicitly entered version is authoritative.
            osVersion: config.osVersion,
            uaOSVersion: ios ? ua.match(/OS ([\d_]+)/)?.[1]?.replaceAll('_', '.') : '',
            webKitVersion: ua.match(/AppleWebKit\/([\d.]+)/)?.[1],
            chromiumVersion: ua.match(/(?:Chrome|CriOS)\/([\d.]+)/)?.[1],
            nativeVersion: config.nativeVersion,
            isTauri: !!(host || window.__TAURI_INTERNALS__ || window.__TAURI__),
            cores: navigator.hardwareConcurrency, deviceMemoryGB: navigator.deviceMemory,
            screenWidth: screen.width, screenHeight: screen.height, pixelRatio: devicePixelRatio,
            timezoneOffsetMinutes: new Date().getTimezoneOffset(),
            heapMetricAvailable: !!performance.memory, longTaskMetricAvailable: longTaskSupported,
        },
    });
    const navigation = performance.getEntriesByType('navigation')[0]?.type || 'unknown';
    let counters = {};
    let taskStats = { longTasks: 0, longTaskTotalMs: 0, maxLongTaskMs: 0 };
    let errorBudget = 8;
    let suppressedErrors = 0;
    let lastErrorSave = -Infinity;
    let lastBeat = performance.now();
    let previousVisibility = document.visibilityState;
    let timer = null;
    let eventsAttached = false;
    let eventCheckpoint = null;
    let lastEventCheckpoint = -Infinity;
    let panel = null;

    if (config.enabled) recorder.begin(navigation);

    function readConfig() {
        try {
            const value = JSON.parse(storage.getItem(configKey) || '{}');
            return { enabled: value.enabled !== false, nativeVersion: versionText(value.nativeVersion), osVersion: versionText(value.osVersion) };
        } catch { return { enabled: true, nativeVersion: '', osVersion: '' }; }
    }
    function saveConfig() {
        try { storage.setItem(configKey, JSON.stringify(config)); }
        catch { recorder.storageError = 'unavailable'; }
    }
    function context() {
        try { return window.SillyTavern?.getContext?.(); } catch { return null; }
    }
    function collect() {
        const chat = document.getElementById('chat');
        const settings = context()?.extensionSettings?.claude_surface;
        const heap = performance.memory;
        return {
            visibility: document.visibilityState, online: navigator.onLine,
            iframes: document.querySelectorAll('iframe').length,
            chatIframes: chat?.querySelectorAll('iframe').length || 0,
            // TauriTavern's bounded DOM pool is deliberately counted separately.
            parkedIframes: document.querySelectorAll('#tt-embedded-runtime-iframe-parking-lot iframe').length,
            messages: chat?.querySelectorAll(':scope > .mes').length || 0,
            canvases: document.querySelectorAll('canvas').length,
            videos: document.querySelectorAll('video').length,
            viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
            ...(heap ? { heapUsedMB: heap.usedJSHeapSize / 1048576, heapLimitMB: heap.jsHeapSizeLimit / 1048576 } : {}),
            ...(settings ? { claudeEnabled: settings.enabled === true, messageStyle: settings.messageStyle, headerMode: settings.headerMode } : {}),
            headerHidden: document.body?.classList.contains('cu-header-hidden') || false,
        };
    }
    function sample(extra = {}) {
        recorder.record('sample', { ...collect(), events: counters, ...(longTaskSupported ? taskStats : {}), suppressedErrors, ...extra });
        counters = {}; taskStats = { longTasks: 0, longTaskTotalMs: 0, maxLongTaskMs: 0 };
        errorBudget = 8; suppressedErrors = 0;
    }
    function heartbeat() {
        const now = performance.now();
        if (recorder.active) {
            sample({ elapsedMs: now - lastBeat, ...(previousVisibility === 'visible' && document.visibilityState === 'visible' ? { gapMs: Math.max(0, now - lastBeat - 5000) } : {}) });
            recorder.flush();
        }
        lastBeat = now; previousVisibility = document.visibilityState;
        attachChatEvents(); updateStatus(); schedule();
    }
    function schedule() {
        clearTimeout(timer);
        timer = setTimeout(guard(heartbeat), document.visibilityState === 'hidden' ? 15000 : 5000);
    }
    function attachChatEvents() {
        if (eventsAttached) return;
        const ctx = context();
        if (!ctx?.eventSource || !ctx?.eventTypes) return;
        eventsAttached = true;
        for (const name of EVENT_NAMES) {
            if (ctx.eventTypes[name]) ctx.eventSource.on(ctx.eventTypes[name], () => {
                if (!recorder.active) return;
                counters[name] = Math.min(1000000, (counters[name] || 0) + 1);
                if (!eventCheckpoint && performance.now() - lastEventCheckpoint >= 2000) {
                    lastEventCheckpoint = performance.now();
                    eventCheckpoint = setTimeout(guard(() => {
                        eventCheckpoint = null;
                        if (recorder.active) { sample(); recorder.flush(); }
                    }), 250);
                }
            });
        }
    }
    function captureError(kind, error, message, filename, line = 0, column = 0) {
        if (!recorder.active) return;
        if (errorBudget-- <= 0) { suppressedErrors++; return; }
        const knownErrors = ['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'EvalError', 'URIError', 'AggregateError', 'SecurityError', 'QuotaExceededError', 'AbortError', 'NetworkError', 'InvalidStateError', 'NotSupportedError', 'TimeoutError'];
        const name = typeof error?.name === 'string' ? (knownErrors.includes(error.name) ? error.name : 'OtherError') : kind === 'rejection' ? 'UnhandledRejection' : kind === 'resource-error' ? 'ResourceError' : 'Error';
        // Text is used only in memory for grouping; it is never persisted.
        const text = typeof message === 'string' ? message.slice(0, 256) : typeof error?.message === 'string' ? error.message.slice(0, 256) : typeof error;
        let hash = 2166136261;
        for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
        recorder.record(kind, { error: name, fingerprint: (hash >>> 0).toString(16).padStart(8, '0'), source: sourceClass(filename), line, column });
        // Persist the first error promptly; cap disk writes during error storms.
        if (performance.now() - lastErrorSave >= 1000) { recorder.flush(); lastErrorSave = performance.now(); }
    }
    window.addEventListener('error', guard(event => {
        if (event instanceof ErrorEvent) captureError('error', event.error, event.message, event.filename, event.lineno, event.colno);
        else if (event.target instanceof HTMLScriptElement || event.target instanceof HTMLIFrameElement) captureError('resource-error', null, 'resource-load-failure', event.target.getAttribute('src'));
    }), true);
    window.addEventListener('unhandledrejection', guard(event => captureError('rejection', event.reason, undefined, '')));
    document.addEventListener('visibilitychange', guard(() => {
        if (recorder.active) { sample(); recorder.checkpoint('visibility', { visibility: document.visibilityState }); }
        lastBeat = performance.now(); previousVisibility = document.visibilityState; schedule(); updateStatus();
    }));
    window.addEventListener('pagehide', guard(event => {
        if (recorder.active) { sample(); recorder.checkpoint('pagehide', { persisted: event.persisted }); }
        clearTimeout(timer);
    }));
    window.addEventListener('pageshow', guard(event => {
        recorder.checkpoint('pageshow', { persisted: event.persisted });
        lastBeat = performance.now(); previousVisibility = document.visibilityState; schedule();
    }));
    for (const name of ['freeze', 'resume']) document.addEventListener(name, guard(() => recorder.checkpoint(name)));
    for (const name of ['online', 'offline']) window.addEventListener(name, guard(() => recorder.checkpoint(name, { online: navigator.onLine })));
    if (longTaskSupported) {
        try {
            new PerformanceObserver(list => {
                if (!recorder.active) return;
                for (const entry of list.getEntries().slice(0, 100)) {
                    taskStats.longTasks++; taskStats.longTaskTotalMs += entry.duration;
                    taskStats.maxLongTaskMs = Math.max(taskStats.maxLongTaskMs, entry.duration);
                }
            }).observe({ entryTypes: ['longtask'] });
        } catch { recorder.environment.longTaskMetricAvailable = false; }
    }

    function installPanel() {
        const host = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
        if (!host || document.getElementById('tfr-settings')) return;
        panel = document.createElement('section'); panel.id = 'tfr-settings';
        panel.innerHTML = `<h4>Tavern Flight Recorder · 轻量诊断</h4>
            <label><input type="checkbox" data-tfr="enabled"><span>记录诊断日志</span></label>
            <p class="tfr-status" role="status" data-tfr="status"></p>
            <div class="tfr-actions"><button type="button" class="tfr-button" data-tfr="export">导出日志文件</button><button type="button" class="tfr-button" data-tfr="mark">标记刚发生的问题</button></div>
            <label class="tfr-version">TauriTavern 版本<input class="text_pole" data-tfr="nativeVersion" placeholder="可选，如 2.4.0" maxlength="32" autocomplete="off"></label>
            <label class="tfr-version">iOS 版本<input class="text_pole" data-tfr="osVersion" placeholder="可选，如 26.1" maxlength="32" autocomplete="off"></label>
            <div class="tfr-actions"><button type="button" class="tfr-clear" data-tfr="clear">清除诊断日志</button></div>
            <p class="tfr-note">日志只保存在本机。重载后从这里导出；不含聊天正文、密钥、完整网址或原始错误文本。网页扩展无法读取 iOS 系统崩溃日志。</p>`;
        host.append(panel);
        const enabled = panel.querySelector('[data-tfr="enabled"]'); enabled.checked = config.enabled;
        enabled.addEventListener('change', guard(() => {
            config.enabled = enabled.checked;
            if (config.enabled) { recorder.begin('unknown'); sample(); recorder.flush(true); }
            else recorder.pause();
            saveConfig(); updateStatus();
        }));
        for (const key of ['nativeVersion', 'osVersion']) {
            const input = panel.querySelector(`[data-tfr="${key}"]`); input.value = config[key];
            input.addEventListener('change', guard(() => {
                const value = versionText(input.value);
                if (input.value.trim() && !value) { input.setCustomValidity('请填写版本号，例如 2.4.0 或 26.1'); input.reportValidity(); return; }
                input.setCustomValidity(''); config[key] = value; saveConfig();
                const envKey = key === 'osVersion' ? 'osVersion' : 'nativeVersion';
                if (value) recorder.environment[envKey] = value; else delete recorder.environment[envKey];
                if (recorder.session) recorder.session.environment = { ...recorder.environment };
                recorder.flush(true); updateStatus();
            }));
            input.addEventListener('input', () => input.setCustomValidity(''));
        }
        panel.querySelector('[data-tfr="mark"]').addEventListener('click', guard(() => {
            recorder.record('marker', { marker: 'issue' }); sample(); recorder.flush(true); updateStatus('已标记问题发生时间');
        }));
        panel.querySelector('[data-tfr="export"]').addEventListener('click', guard(() => {
            if (recorder.active) { sample(); recorder.record('export'); recorder.flush(true); }
            const content = JSON.stringify(recorder.export(), null, 2);
            const fileName = `tavern-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
            const url = URL.createObjectURL(new Blob([content], { type: 'application/json;charset=utf-8' }));
            const link = document.createElement('a'); link.href = url; link.download = fileName; link.hidden = true;
            document.body.append(link); link.click(); link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 30000);
            updateStatus('已请求导出，请在系统下载或文件中保存');
        }));
        panel.querySelector('[data-tfr="clear"]').addEventListener('click', guard(() => { recorder.clear(); updateStatus('诊断日志已清除'); }));
        updateStatus();
    }
    function updateStatus(message) {
        if (!panel) return;
        const status = panel.querySelector('[data-tfr="status"]');
        status.dataset.warning = String(!!recorder.storageError);
        const previousUnclosed = recorder.session?.events.find(event => event.kind === 'start')?.data.previousUnclosed;
        status.textContent = recorder.storageError ? '无法持久保存：当前仅保存在内存，请立即导出。' : message || (recorder.active ? `${previousUnclosed ? '上次记录未正常结束 · ' : ''}正在记录 · 最近保存 ${recorder.lastSavedAt ? new Date(recorder.lastSavedAt).toLocaleTimeString() : '等待中'} · v${VERSION}` : '已暂停 · 之前的记录仍可导出');
        panel.querySelector('[data-tfr="mark"]').disabled = !recorder.active;
    }
    function guard(fn) { return (...args) => { try { return fn(...args); } catch { /* Diagnostics must never interrupt the host. */ } }; }

    attachChatEvents();
    if (recorder.active) { sample(); recorder.flush(true); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', guard(installPanel), { once: true });
    else installPanel();
    // Some host variants mount extension settings after extension evaluation.
    let attempts = 0;
    const panelRetry = setInterval(() => { if (++attempts >= 15 || panel) clearInterval(panelRetry); else guard(installPanel)(); }, 1000);
    schedule();
}

function getStorage(name) { try { return window[name]; } catch { return null; } }

function sourceClass(value) {
    if (!value) return 'inline';
    if (value.startsWith('blob:')) return 'blob';
    if (value.startsWith('data:')) return 'data';
    try {
        const url = new URL(value, location.href);
        if (url.origin !== location.origin) return 'external';
        const path = url.pathname;
        if (/\/claude-surface\//i.test(path)) return 'surface';
        if (/\/JS-Slash-Runner\//i.test(path)) return 'tavern-helper';
        if (/\/ST-BaiBai-/i.test(path)) return 'baibai';
        if (/\/extensions\/third-party\//i.test(path)) return 'third-party';
        if (/\/tauri(?:\/|-)/i.test(path)) return 'tauri';
        return 'core';
    } catch { return 'unknown'; }
}

