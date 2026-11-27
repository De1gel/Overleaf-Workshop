'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const loadSource = require('./helpers/load-source.cjs');

const implementations = [
  ['source', 'src/scm/localReplicaSCM.ts'],
  ...(process.env.OVERLEAF_REPLICA_STAGE ? [['installed hotfix', process.env.OVERLEAF_REPLICA_STAGE]] : []),
];

function fixture(filename, options = {}) {
  const entries = new Map();
  const writes = [];
  const creations = [];
  const recorded = [];
  let uploadFailures = options.uploadFailures || 0;
  let directoryFailures = options.directoryFailures || 0;
  let refreshFailures = options.refreshFailures || 0;
  const refreshBusyUntil = Date.now() + (options.refreshBusyMs || 0);
  let refreshes = 0;
  let provider;
  const uri = (scheme, name) => ({ scheme, path: name, query: '', toString() { return scheme + ':' + name; } });
  const key = value => value.scheme + ':' + value.path;
  const failure = code => Object.assign(new Error('Synthetic test failure'), { code });
  const fs = {
    async stat(value) {
      const entry = entries.get(key(value));
      if (!entry) { throw failure('FileNotFound'); }
      return { type: entry.type };
    },
    async readFile(value) {
      const entry = entries.get(key(value));
      if (!entry || entry.type !== 1) { throw failure('FileNotFound'); }
      return entry.content;
    },
    async createDirectory(value) {
      await new Promise(resolve => setTimeout(resolve, 1));
      const parent = uri(value.scheme, path.posix.dirname(value.path));
      if (!entries.has(key(parent))) { throw failure('FileNotFound'); }
      if (directoryFailures-- > 0) { throw failure('RemoteDirectoryCreateFailed'); }
      entries.set(key(value), { type: 2 });
      creations.push(value.path);
    },
    async writeFile(value, content) {
      const parent = uri(value.scheme, path.posix.dirname(value.path));
      if (!entries.has(key(parent))) { throw failure('FileNotFound'); }
      if (value.scheme === 'overleaf' && uploadFailures-- > 0) { throw failure('RemoteUploadFailed'); }
      entries.set(key(value), { type: 1, content: Uint8Array.from(content) });
      writes.push(value.path);
    },
  };
  class BaseSCM {
    getSetting() { return undefined; }
  }
  const vscode = {
    workspace: { fs },
    FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
    ThemeIcon: class {},
    l10n: { t: text => text },
    Uri: { joinPath: (base, ...parts) => uri(base.scheme, path.posix.join(base.path, ...parts)) },
    FileSystemError: {
      FileNotADirectory: () => failure('FileNotADirectory'),
    },
    window: {},
  };
  const { LocalReplicaSCMProvider } = loadSource(filename, {
    vscode,
    '.': { BaseSCM },
    'diff-match-patch': class {},
    minimatch: { minimatch: () => false },
    '../core/remoteFileSystemProvider': { parseUri: value => ({ pathParts: value.path.slice('/project/'.length).split('/') }) },
    './localReplicaSettings': {},
    './remoteUpdateManager': {},
  });
  const vfs = {
    origin: uri('overleaf', '/project'),
    pathToUri: name => uri('overleaf', '/project' + name),
    readRemoteFile: value => fs.readFile(value),
    async refreshRemoteSnapshot() {
      refreshes++;
      options.onRefresh?.();
      if (provider.activeSyncs > 0 || refreshFailures-- > 0 || Date.now() < refreshBusyUntil) {
        throw new Error('Remote changes are waiting to be uploaded; retry the snapshot later');
      }
    },
  };
  provider = new LocalReplicaSCMProvider(vfs, uri('file', '/local'));
  provider.watchSession = { disposed: false };
  provider.remoteUpdates = {
    hasPending: name => Boolean(options.pending && (name === options.pending || name.startsWith(options.pending + '/'))),
    async prompt() {},
    async queue() {},
    updateStatus() {},
  };
  provider.recordSyncedState = async name => recorded.push(name);
  entries.set('file:/local', { type: 2 });
  entries.set('file:/local/abstract', { type: 2 });
  entries.set('file:/local/abstract/nested', { type: 2 });
  entries.set('overleaf:/project', { type: 2 });
  const addFile = (name, text) => {
    const value = uri('file', '/local' + name);
    entries.set(key(value), { type: 1, content: Buffer.from(text) });
    return value;
  };
  return { provider, addFile, uri, entries, writes, creations, recorded, refreshes: () => refreshes };
}

for (const [label, filename] of implementations) {
  test(`${label}: concurrent parent checks share directory creation`, async () => {
    const f = fixture(filename);
    await Promise.all([
      f.provider.ensureRemoteDirectory('/abstract/nested', f.provider.watchSession),
      f.provider.ensureRemoteDirectory('/abstract/nested', f.provider.watchSession),
    ]);
    assert.deepEqual(f.creations, ['/project/abstract', '/project/abstract/nested']);
  });

  test(`${label}: files can arrive before nested directory watcher events`, async () => {
    const f = fixture(filename);
    const first = f.addFile('/abstract/nested/isttt27.bst', 'bibliography style');
    const second = f.addFile('/abstract/nested/isttt27.sty', 'style package');
    await Promise.all([
      f.provider.syncToVFS(first, 'update'),
      f.provider.syncToVFS(f.uri('file', '/local/abstract'), 'update'),
      f.provider.syncToVFS(second, 'update'),
      f.provider.syncToVFS(f.uri('file', '/local/abstract/nested'), 'update'),
    ]);
    assert.deepEqual(f.creations, ['/project/abstract', '/project/abstract/nested']);
    assert.deepEqual(f.writes, ['/project/abstract/nested/isttt27.bst', '/project/abstract/nested/isttt27.sty']);
    assert.equal(Buffer.from(f.entries.get('overleaf:/project/abstract/nested/isttt27.bst').content).toString(), 'bibliography style');
    assert.equal(Buffer.from(f.provider.baseCache['/abstract/nested/isttt27.sty']).toString(), 'style package');
  });

  test(`${label}: a failed upload does not suppress a later save of identical bytes`, async () => {
    const f = fixture(filename, { uploadFailures: 1 });
    const file = f.addFile('/abstract/isttt27.bst', 'same bytes');
    await f.provider.syncToVFS(file, 'update');
    assert.equal(f.provider.baseCache['/abstract/isttt27.bst'], undefined);
    assert.equal(f.provider.bypassCache.has('/abstract/isttt27.bst'), false);
    assert.equal(f.recorded.length, 0);
    await f.provider.syncToVFS(file, 'update');
    assert.equal(Buffer.from(f.provider.baseCache['/abstract/isttt27.bst']).toString(), 'same bytes');
    assert.equal(f.writes.length, 1);
  });

  test(`${label}: failed parent creation cannot mark the child uploaded`, async () => {
    const f = fixture(filename, { directoryFailures: 1 });
    const file = f.addFile('/abstract/nested/references.bib', 'bibliography');
    await f.provider.syncToVFS(file, 'update');
    assert.equal(f.writes.length, 0);
    assert.equal(f.provider.baseCache['/abstract/nested/references.bib'], undefined);
    assert.equal(f.provider.bypassCache.has('/abstract/nested/references.bib'), false);
    await f.provider.syncToVFS(file, 'update');
    assert.equal(f.writes.length, 1);
  });

  if (label === 'installed hotfix') {
    test(`${label}: a busy snapshot is retried without concurrent active uploads`, async () => {
      const f = fixture(filename, { refreshFailures: 1 });
      const first = f.addFile('/abstract/isttt27.bst', 'one');
      const second = f.addFile('/abstract/isttt27.sty', 'two');
      await Promise.all([f.provider.syncToVFS(first, 'update'), f.provider.syncToVFS(second, 'update')]);
      assert.equal(f.writes.length, 2);
      assert.ok(f.refreshes() >= 2);
    });

    test(`${label}: pending remote review still prevents uploads`, async () => {
      const f = fixture(filename, { pending: '/abstract' });
      const file = f.addFile('/abstract/isttt27.bst', 'local changes');
      await f.provider.syncToVFS(file, 'update');
      assert.equal(f.writes.length, 0);
      assert.equal(f.creations.length, 0);
      assert.equal(f.provider.baseCache['/abstract/isttt27.bst'], undefined);
    });

    test(`${label}: snapshot busy beyond the old 300 ms window is allowed to finish`, async () => {
      const f = fixture(filename, { refreshBusyMs: 650 });
      const file = f.addFile('/abstract/isttt27.sty', 'package bytes');
      assert.equal(await f.provider.syncToVFS(file, 'update'), true);
      assert.deepEqual(f.writes, ['/project/abstract/isttt27.sty']);
      assert.equal(Buffer.from(f.provider.baseCache['/abstract/isttt27.sty']).toString(), 'package bytes');
    });

    test(`${label}: cancelling a session stops busy waiting without uploading`, async () => {
      const f = fixture(filename, { refreshBusyMs: 5000 });
      const file = f.addFile('/abstract/isttt27.sty', 'package bytes');
      const started = Date.now();
      const pending = f.provider.syncToVFS(file, 'update');
      const cancellation = setTimeout(() => { f.provider.watchSession.disposed = true; }, 40);
      try {
        assert.equal(await pending, false);
      } finally {
        clearTimeout(cancellation);
      }
      assert.ok(Date.now() - started < 1000, 'cancellation must not wait for the busy deadline');
      assert.equal(f.writes.length, 0);
      assert.equal(f.recorded.length, 0);
    });

    test(`${label}: an exhausted busy deadline leaves the upload pending for a later retry`, async t => {
      let now = 0;
      t.mock.method(Date, 'now', () => now);
      const f = fixture(filename, { refreshBusyMs: 60000, onRefresh: () => { now += 15000; } });
      const file = f.addFile('/abstract/isttt27.sty', 'package bytes');
      assert.equal(await f.provider.syncToVFS(file, 'update'), false);
      assert.equal(f.provider.status.status, 'need-attention');
      assert.equal(f.writes.length, 0);
      assert.equal(f.recorded.length, 0);
      assert.equal(f.provider.baseCache['/abstract/isttt27.sty'], undefined);
      assert.equal(f.provider.bypassCache.has('/abstract/isttt27.sty'), false);
    });
  }
}
