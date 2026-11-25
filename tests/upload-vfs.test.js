'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const loadSource = require('./helpers/load-source.cjs');

const identity = { csrfToken: 'synthetic-csrf', cookies: 'synthetic-cookie' };
const uri = { path: '/project/extended_abstract/isttt27.bst' };
const fileError = code => Object.assign(new Error(code), { code });
const vscode = {
  Disposable: class Disposable {},
  FileType: { File: 1, Directory: 2 },
  FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
  FileSystemError: {
    FileExists: () => fileError('FileExists'),
    FileNotFound: () => fileError('FileNotFound'),
  },
  window: { showErrorMessage: () => {} },
};
const { VirtualFileSystem } = loadSource('src/core/remoteFileSystemProvider.ts', {
  vscode,
  'diff-match-patch': class DiffMatchPatch {},
  '../api/base': {},
  '../api/socketio': {},
  '../consts': { ROOT_NAME: 'overleaf-workshop', OUTPUT_FOLDER_NAME: '.output' },
  '../utils/globalStateManager': { GlobalStateManager: { authenticate: async () => identity } },
  '../collaboration/clientManager': {},
  '../utils/eventBus': {},
  '../scm/scmCollectionProvider': {},
  '../api/extendedBase': {},
});

function fakeVfs(response, resolution = {}) {
  const events = [];
  const insertions = [];
  const calls = [];
  const parentFolder = { _id: 'parent-folder' };
  const vfs = Object.create(VirtualFileSystem.prototype);
  Object.assign(vfs, {
    context: {},
    serverName: 'overleaf-upload.test',
    projectId: 'project-id',
    _resolveUri: async () => ({ parentFolder, fileName: 'isttt27.bst', ...resolution }),
    insertEntity: (...args) => insertions.push(args),
    notify: changes => events.push(...changes),
    api: Object.fromEntries(['uploadFile', 'addDoc', 'addFolder'].map(method => [method, async (...args) => {
      calls.push({ method, args });
      return typeof response === 'function' ? response() : response;
    }])),
  });
  return { vfs, events, insertions, calls };
}

for (const [label, response] of [
  ['HTTP failure', { type: 'error', statusCode: 403, message: 'private server response session=secret-token' }],
  ['missing response entity', { type: 'success' }],
  ['missing entity id', { type: 'success', entity: { name: 'isttt27.bst', _type: 'file' } }],
  ['missing entity type', { type: 'success', entity: { name: 'isttt27.bst', _id: 'new-file' } }],
  ['wrong entity type', { type: 'success', entity: { name: 'isttt27.bst', _id: 'new-file', _type: 'folder' } }],
]) {
  test(`VFS ${label} rejects the write and never emits a created event`, async () => {
    const { vfs, events, insertions } = fakeVfs(response);
    await assert.rejects(vfs.createFile(uri, Buffer.from('style'), true), error => {
      assert.equal(error.code, 'RemoteUploadFailed');
      assert.ok(error.message.includes('isttt27.bst'));
      assert.ok(!error.message.includes('secret-token'), 'raw server responses must not leak into user-facing errors');
      if (response.statusCode) assert.equal(error.statusCode, response.statusCode);
      return true;
    });
    assert.deepEqual(events, [], 'a rejected upload is not a remote create');
    assert.deepEqual(insertions, [], 'a rejected upload must not enter the VFS entity cache');
  });
}

test('an empty document create failure also propagates to the caller', async () => {
  const { vfs, calls, events } = fakeVfs({ type: 'error', statusCode: 503 });
  await assert.rejects(vfs.createFile(uri, new Uint8Array(), true), { code: 'RemoteUploadFailed' });
  assert.equal(calls[0].method, 'addDoc');
  assert.deepEqual(events, []);
});

test('a valid new file is cached and announced only after API success', async () => {
  const entity = { _id: 'new-file', _type: 'file', name: 'isttt27.bst' };
  const { vfs, calls, events, insertions } = fakeVfs({ type: 'success', entity });
  const bytes = Uint8Array.from([65, 0, 255]);
  await vfs.createFile(uri, bytes, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'uploadFile');
  assert.deepEqual(calls[0].args, [identity, 'project-id', 'parent-folder', 'isttt27.bst', bytes]);
  assert.equal(insertions.length, 1);
  assert.equal(insertions[0][1], 'file');
  assert.deepEqual(insertions[0][2], entity);
  assert.deepEqual(events, [{ type: vscode.FileChangeType.Created, uri }]);
});

test('a failed upload can be attempted again and only the successful retry creates a remote entity', async () => {
  let attempt = 0;
  const { vfs, calls, events, insertions } = fakeVfs(() => ++attempt === 1
    ? { type: 'error', statusCode: 503 }
    : { type: 'success', entity: { _id: 'retry-file', _type: 'file', name: 'isttt27.bst' } });
  await assert.rejects(vfs.createFile(uri, Buffer.from('style'), true), { code: 'RemoteUploadFailed' });
  assert.equal(events.length, 0);
  await vfs.createFile(uri, Buffer.from('style'), true);
  assert.equal(calls.length, 2);
  assert.equal(insertions.length, 1);
  assert.equal(events.length, 1);
});

test('creating an existing file without overwrite fails before contacting the API', async () => {
  const { vfs, calls } = fakeVfs({}, { fileEntity: { _id: 'existing-file' } });
  await assert.rejects(vfs.createFile(uri, Buffer.from('style'), false), { code: 'FileExists' });
  assert.deepEqual(calls, []);
});

test('remote directory creation failure rejects and never publishes a created event', async () => {
  const { vfs, calls, events, insertions } = fakeVfs({ type: 'error', statusCode: 403, message: 'session=secret-token' });
  await assert.rejects(vfs.mkdir(uri), error => {
    assert.equal(error.code, 'RemoteDirectoryCreateFailed');
    assert.equal(error.statusCode, 403);
    assert.ok(!error.message.includes('secret-token'));
    return true;
  });
  assert.equal(calls[0].method, 'addFolder');
  assert.deepEqual(events, []);
  assert.deepEqual(insertions, []);
});

test('remote directory creation is idempotent when the directory is already present', async () => {
  const { vfs, calls, events } = fakeVfs({}, { fileType: 'folder', fileEntity: { _id: 'existing-folder' } });
  await vfs.mkdir(uri);
  assert.deepEqual(calls, []);
  assert.deepEqual(events, []);
});

// Locally installed builds may also carry reviewed-write protection. Validate it
// explicitly when installing the upload fix over such a build; do not replace
// that protection with a mock just to make upload tests pass.
if (process.env.OVERLEAF_TEST_REVIEW_GUARDS === '1') {
  test('a cancelled reviewed upload is blocked before any API request', async () => {
    const { vfs, calls, events } = fakeVfs({ type: 'success', entity: { _id: 'new-file', _type: 'file' } });
    assert.equal(typeof vfs.assertReviewedRemoteState, 'function');
    vfs.isRemoteEditorDirty = () => false;
    const review = { parentId: 'parent-folder', isCurrent: () => false };
    await assert.rejects(vfs.createFile(uri, Buffer.from('style'), true, review), { code: 'RemoteChanged' });
    assert.deepEqual(calls, []);
    assert.deepEqual(events, []);
  });

  test('a reviewed upload rechecks remote identity after the authentication await', async () => {
    const { vfs, calls, events } = fakeVfs({ type: 'success', entity: { _id: 'new-file', _type: 'file' } });
    assert.equal(typeof vfs.assertReviewedRemoteState, 'function');
    vfs.isRemoteEditorDirty = () => false;
    let resolutions = 0;
    vfs._resolveUri = async () => ++resolutions === 1
      ? { parentFolder: { _id: 'parent-folder' }, fileName: 'isttt27.bst' }
      : { parentFolder: { _id: 'changed-parent' }, fileName: 'isttt27.bst' };
    const review = { parentId: 'parent-folder', isCurrent: () => true };
    await assert.rejects(vfs.createFile(uri, Buffer.from('style'), true, review), { code: 'RemoteChanged' });
    assert.equal(resolutions, 2);
    assert.deepEqual(calls, []);
    assert.deepEqual(events, []);
  });
}
