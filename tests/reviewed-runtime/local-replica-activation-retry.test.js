'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const activationFile = path.join(__dirname, '../../hotfixes/reviewed-runtime/out/scm/localReplicaActivation.js');
const source = fs.readFileSync(activationFile, 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

function setup(initialize = async () => {}) {
    const timers = new Map();
    const delays = [];
    const attempts = [];
    const released = [];
    const errors = [];
    const contexts = new Map();
    let timerId = 0;
    let selection = 'first';
    const exports = {};
    const vnode = {
        workspace: {
            workspaceFolders: [],
            onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
            onDidChangeConfiguration: () => ({ dispose() {} }),
        },
        Uri: { parse: uri => uri },
        commands: { executeCommand: async (_command, name, value) => { contexts.set(name, value); } },
        window: { showErrorMessage: async message => { errors.push(message); } },
        l10n: { t: message => message },
    };
    vm.runInNewContext(source, {
        exports,
        require: id => {
            switch (id) {
                case 'vscode': return vnode;
                case '../consts': return { ROOT_NAME: 'overleaf-workshop' };
                case './localReplicaSettings': return {
                    discoverLocalReplicas: async () => selection ? [{
                        baseUri: '/replica/' + selection,
                        settings: { uri: 'remote:' + selection, enableCompileNPreview: true },
                    }] : [],
                    selectLocalReplica: replicas => replicas[0],
                    replicaKey: uri => uri,
                };
                default: throw new Error('Unknown import ' + id);
            }
        },
        setTimeout: (callback, delay) => {
            delays.push(delay);
            timers.set(++timerId, callback);
            return timerId;
        },
        clearTimeout: id => timers.delete(id),
    }, { filename: activationFile });
    const provider = {
        prefetch: async uri => {
            const vfs = { uri, async initLocalReplica() { await initialize(uri, attempts.length); } };
            attempts.push(uri);
            return vfs;
        },
        releaseLocalReplica: vfs => released.push(vfs.uri),
    };
    return {
        activation: new exports.LocalReplicaActivation(provider),
        attempts, contexts, delays, errors, released, timers,
        select: value => { selection = value; },
        async fireRetry() {
            assert.equal(timers.size, 1);
            const [id, callback] = timers.entries().next().value;
            timers.delete(id);
            callback();
            await flush();
        },
    };
}

test('temporary scan and handshake errors retry one activation and release failed sessions', async () => {
    const h = setup(async (_uri, count) => {
        if (count === 1) throw new Error('A remote file could not be checked');
        if (count === 2) throw 'timeout';
    });
    const started = h.activation.start();
    await flush();
    assert.deepEqual(h.delays, [1000]);
    assert.deepEqual(h.released, ['remote:first']);
    assert.deepEqual(h.errors, []);
    const sameSelection = h.activation.start();
    await flush();
    assert.deepEqual(h.attempts, ['remote:first']);
    await h.fireRetry();
    assert.deepEqual(h.delays, [1000, 3000]);
    await h.fireRetry();
    await Promise.all([started, sameSelection]);
    assert.deepEqual(h.attempts, ['remote:first', 'remote:first', 'remote:first']);
    assert.deepEqual(h.released, ['remote:first', 'remote:first']);
    assert.deepEqual(h.errors, []);
    assert.equal(h.contexts.get('overleaf-workshop.activate'), true);
    assert.equal(h.contexts.get('overleaf-workshop.activateCompile'), true);
    assert.equal(h.timers.size, 0);
});

test('repeated transient failures back off and report once after the retry budget', async () => {
    const h = setup(async () => { throw Object.assign(new Error('temporary failure'), { statusCode: 503 }); });
    const started = h.activation.start();
    await flush();
    for (let attempt = 0; attempt < 3; attempt++) {
        assert.equal(h.errors.length, 0);
        await h.fireRetry();
    }
    await started;
    assert.deepEqual(h.delays, [1000, 3000, 8000]);
    assert.equal(h.attempts.length, 4);
    assert.equal(h.released.length, 4);
    assert.equal(h.errors.length, 1);
    assert.equal(h.timers.size, 0);
});

test('authentication failure stops without retrying or displaying response details', async () => {
    const h = setup(async () => { throw Object.assign(new Error('private response body'), { statusCode: 401 }); });
    await h.activation.start();
    assert.equal(h.attempts.length, 1);
    assert.equal(h.timers.size, 0);
    assert.equal(h.errors.length, 1);
    assert.doesNotMatch(h.errors[0], /private response body/);
});

test('changing the selected project cancels the old retry and activates the new project', async () => {
    const h = setup(async uri => {
        if (uri === 'remote:first') throw Object.assign(new Error('transport'), { code: 'ECONNRESET' });
    });
    const started = h.activation.start();
    await flush();
    assert.equal(h.timers.size, 1);
    h.select('second');
    await h.activation.start();
    await started;
    assert.deepEqual(h.attempts, ['remote:first', 'remote:second']);
    assert.deepEqual(h.released, ['remote:first']);
    assert.deepEqual(h.errors, []);
    assert.equal(h.timers.size, 0);
    assert.equal(h.contexts.get('overleaf-workshop.activate'), true);
});

test('dispose during retry settles startup and clears the timer', async () => {
    const h = setup(async () => { throw 'client not handshaken'; });
    const started = h.activation.start();
    await flush();
    assert.equal(h.timers.size, 1);
    h.activation.dispose();
    await started;
    assert.deepEqual(h.attempts, ['remote:first']);
    assert.deepEqual(h.released, ['remote:first']);
    assert.deepEqual(h.errors, []);
    assert.equal(h.timers.size, 0);
});
