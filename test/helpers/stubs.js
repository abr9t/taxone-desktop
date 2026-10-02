/**
 * Module._load stubs shared by the suites that load uploader.js / auth.js
 * outside Electron. Not a test itself: run-all.js only picks up *.test.js in
 * test/, not in this folder.
 *
 * Everything the stubs expose is live — flip `electron.app.isPackaged`, edit
 * `store` or `keychain` between scenarios and the module under test sees it on
 * its next read.
 */
const Module = require('module');

function installStubs({ isPackaged = true, keytar = false, axios = null, electron: electronOverride = null, modules = {} } = {}) {
    const store = new Map();
    class MockStore {
        get(key, def) { return store.has(key) ? store.get(key) : def; }
        set(key, val) { store.set(key, val); }
        delete(key) { store.delete(key); }
    }

    // A stand-in OS keychain, for suites that need keytar present.
    const keychain = new Map();
    const keytarStub = {
        getPassword: async (svc, acct) => (keychain.has(`${svc}/${acct}`) ? keychain.get(`${svc}/${acct}`) : null),
        setPassword: async (svc, acct, val) => { keychain.set(`${svc}/${acct}`, val); },
        deletePassword: async (svc, acct) => keychain.delete(`${svc}/${acct}`),
    };

    const logs = [];
    const electron = electronOverride || {
        app: {
            isPackaged,
            getPath: () => 'C:/Users/test/AppData/Roaming/TaxOne Desktop',
        },
    };

    const origLoad = Module._load;
    Module._load = function (request, ...rest) {
        if (Object.prototype.hasOwnProperty.call(modules, request)) return modules[request];
        if (request === 'electron-store') return MockStore;
        if (request === 'keytar') {
            if (keytar) return keytarStub;
            throw new Error('keytar stubbed off for test');
        }
        if (request === 'electron') return electron;
        if (request === './debug-log') {
            return {
                debugLog: (...a) => logs.push(a.join(' ')),
                debugError: (...a) => logs.push(a.join(' ')),
            };
        }
        if (request === 'axios' && axios) return axios;
        return origLoad.call(this, request, ...rest);
    };

    return { store, keychain, logs, electron, restore: () => { Module._load = origLoad; } };
}

/**
 * An axios stand-in that records instead of sending. Any call reaching it
 * means a request would have left the machine.
 */
function recordingAxios() {
    const calls = [];
    // Set control.failWith to an Error (with .code) to make every request
    // reject with it after being recorded — a certificate or connection failure.
    // Set control.gate to a promise to hold every request open until it
    // settles — an upload in flight.
    const control = { failWith: null, gate: null };
    const respond = async () => {
        if (control.gate) await control.gate;
        if (control.failWith) throw control.failWith;
        return { status: 200, data: {} };
    };
    const instance = (cfg) => ({
        interceptors: { response: { use: () => {} } },
        get: async (url) => { calls.push({ method: 'get', baseURL: cfg.baseURL, url }); return respond(); },
        post: async (url) => { calls.push({ method: 'post', baseURL: cfg.baseURL, url }); return respond(); },
    });
    return {
        control,
        calls,
        module: {
            create: (cfg) => { calls.push({ method: 'create', baseURL: cfg.baseURL }); return instance(cfg); },
            get: async (url) => { calls.push({ method: 'get', url }); return { status: 200, data: {} }; },
        },
    };
}

module.exports = { installStubs, recordingAxios };
