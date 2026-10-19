/* eslint-disable @typescript-eslint/naming-convention -- Overleaf API fixture names are fixed. */
import * as assert from 'assert';
import type * as vscode from 'vscode';
import type { FileEntity, FolderEntity } from '../core/remoteFileSystemProvider';
import { LocalReplicaSCMProvider } from '../scm/localReplicaSCM';
import {
    asUri, content, externalWrite, fire, mockVscode, reset, seed, setFolders, settle, state, Uri,
} from './vscodeMock';

// The suffix includes .js to load the real provider rather than the lightweight
// parseUri replacement used by the other in-memory integration fixtures.
const {VirtualFileSystem} = require('../core/remoteFileSystemProvider.js') as typeof import('../core/remoteFileSystemProvider');

const base = Uri.file('/research/replica');
const origin = Uri.parse('overleaf-workshop://overleaf.test/Project?user=test&project=project-id');
type ApiReply = {type: 'success' | 'error'; entity?: FileEntity; message?: string};
type CreationCall = {method: 'addDoc' | 'uploadFile'; projectId: string; parentId: string; name: string; data?: Uint8Array};

function creationHarness() {
    const parent: FolderEntity = {_id: 'folder-id', name: 'root', docs: [], fileRefs: [], folders: []};
    const notifications: vscode.FileChangeEvent[] = [];
    const calls: CreationCall[] = [];
    let reply: ApiReply = {type: 'error', message: 'invalid_upload_request'};
    const vfs = Object.assign(Object.create(VirtualFileSystem.prototype), {
        context: {}, serverName: 'overleaf.test', projectId: 'project-id',
        _resolveUri: async (uri: vscode.Uri) => ({parentFolder: parent, fileName: uri.path.split('/').pop()}),
        notify: (events: vscode.FileChangeEvent[]) => notifications.push(...events),
        api: {
            async addDoc(_identity: unknown, projectId: string, parentId: string, name: string) {
                calls.push({method: 'addDoc', projectId, parentId, name});
                return reply;
            },
            async uploadFile(_identity: unknown, projectId: string, parentId: string, name: string, data: Uint8Array) {
                calls.push({method: 'uploadFile', projectId, parentId, name, data: data.slice()});
                return reply;
            },
        },
    }) as InstanceType<typeof VirtualFileSystem>;
    return {vfs, parent, notifications, calls, respond(value: ApiReply) { reply = value; }};
}

suite('Remote file creation failure propagation', () => {
    setup(reset);
    teardown(() => { assert.deepStrictEqual(state.errors, []); });

    for (const empty of [false, true]) {
        const label = empty ? 'empty document' : 'nonempty file';
        const filename = empty ? '11.tex' : 'Model.tex';
        const data = empty ? new Uint8Array() : Buffer.from('\\section{Model}\n');
        const uri = Uri.joinPath(origin, filename);

        test(`${label} API rejection rejects the filesystem operation without creating an entity`, async () => {
            const harness = creationHarness();
            await assert.rejects(harness.vfs.createFile(asUri(uri), data), {code: 'Unavailable'});
            assert.strictEqual(harness.calls.length, 1);
            assert.strictEqual(harness.calls[0].method, empty ? 'addDoc' : 'uploadFile');
            assert.deepStrictEqual(harness.parent.docs, []);
            assert.deepStrictEqual(harness.parent.fileRefs, []);
            assert.deepStrictEqual(harness.notifications, []);
            assert.deepStrictEqual(state.warnings, empty ? [] : ['invalid_upload_request']);
        });

        test(`${label} response without an entity rejects rather than reporting success`, async () => {
            const harness = creationHarness();
            harness.respond({type: 'success'});
            await assert.rejects(harness.vfs.createFile(asUri(uri), data), {code: 'Unavailable'});
            assert.deepStrictEqual(harness.parent.docs, []);
            assert.deepStrictEqual(harness.parent.fileRefs, []);
            assert.deepStrictEqual(harness.notifications, []);
        });

        test(`${label} successful creation inserts and announces the returned entity`, async () => {
            const harness = creationHarness();
            const entity: FileEntity = {_id: 'created-id', name: filename, _type: 'doc'};
            harness.respond({type: 'success', entity});
            await harness.vfs.createFile(asUri(uri), data);
            assert.deepStrictEqual(harness.parent.docs, [entity]);
            assert.deepStrictEqual(harness.parent.fileRefs, []);
            assert.deepStrictEqual(harness.notifications, [{type: mockVscode.FileChangeType.Created, uri}]);
            assert.deepStrictEqual(harness.calls, [{
                method: empty ? 'addDoc' : 'uploadFile', projectId: 'project-id', parentId: 'folder-id',
                name: filename, ...(empty ? {} : {data}),
            }]);
        });
    }
});

suite('Local replica upload recovery', () => {
    let provider: LocalReplicaSCMProvider;
    let disposables: vscode.Disposable[];
    const local = Uri.joinPath(base, 'Model.tex');
    const remote = Uri.joinPath(origin, 'Model.tex');
    const writes = () => state.operations.filter(operation => operation.type === 'write' && operation.uri.scheme === origin.scheme);

    setup(async () => {
        reset();
        disposables = [];
        setFolders(base);
        seed(Uri.joinPath(base, '.overleaf/settings.json'), JSON.stringify({uri: origin.toString()}));
        seed(Uri.joinPath(base, 'main.tex'), 'original');
        seed(Uri.joinPath(origin, 'main.tex'), 'original');
        state.config.set('overleaf-workshop.localReplica.syncOnFileChange.enabled', true);
        provider = new LocalReplicaSCMProvider({
            origin: asUri(origin), serverName: 'overleaf.test', projectName: 'Project', projectId: 'project-id',
            pathToUri: (...parts: string[]) => asUri(Uri.joinPath(origin, ...parts)),
            getProjectSCMPersist: () => ({settings: {}}),
        } as any, asUri(base));
        disposables = await provider.triggers;
        state.operations = [];
    });
    teardown(async () => {
        disposables.forEach(disposable => disposable.dispose());
        await settle(5);
        assert.deepStrictEqual(state.errors, [], 'watcher failures must be handled');
    });

    test('retries unchanged content after the real creation path rejects an upload', async () => {
        const harness = creationHarness();
        state.beforeWrite = async (uri, data) => {
            if (uri.scheme === origin.scheme) { await harness.vfs.createFile(asUri(uri), data); }
        };
        await externalWrite(local, '\\section{Retry this upload}\n');
        await settle();
        assert.strictEqual(provider.status.status, 'need-attention');
        await assert.rejects(mockVscode.workspace.fs.stat(remote), {code: 'FileNotFound'});
        assert.strictEqual(writes().length, 0);
        assert.strictEqual(harness.calls.length, 1);

        harness.respond({type: 'success', entity: {_id: 'uploaded-id', name: 'Model.tex', _type: 'doc'}});
        fire('change', local);
        await settle();
        assert.strictEqual(content(remote), content(local));
        assert.strictEqual(provider.status.status, 'idle');
        assert.strictEqual(harness.calls.length, 2, 'the unchanged file must reach the upload API again');
        assert.strictEqual(writes().length, 1);

        fire('change', local);
        await settle();
        assert.strictEqual(harness.calls.length, 2, 'confirmed uploads must still suppress duplicate events');
    });

    test('retries verification after a successful write whose remote readback failed', async () => {
        let failReadback = true;
        let remoteReads = 0;
        state.beforeRead = async uri => {
            if (uri.toString() === remote.toString()) {
                remoteReads++;
                if (failReadback && writes().length > 0) { throw new Error('simulated readback failure'); }
            }
        };
        await externalWrite(local, '\\section{Verify after upload}\n');
        await settle();
        assert.strictEqual(provider.status.status, 'need-attention');
        assert.strictEqual(content(remote), content(local), 'the write completed before the readback failed');
        assert.strictEqual(writes().length, 1);
        const failedReadAttempts = remoteReads;

        failReadback = false;
        fire('change', local);
        await settle();
        assert.ok(remoteReads >= failedReadAttempts + 2, 'unchanged bytes must retry the target read and remote readback');
        assert.strictEqual(provider.status.status, 'idle');
        assert.strictEqual(writes().length, 1, 'an already matching remote file does not require another write');

        const verifiedReadAttempts = remoteReads;
        fire('change', local);
        await settle();
        assert.strictEqual(remoteReads, verifiedReadAttempts, 'confirmed content suppresses duplicate events');
    });
});
