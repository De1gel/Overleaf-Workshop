import * as assert from 'assert';
import type * as vscode from 'vscode';
import { LocalReplicaSCMProvider } from '../scm/localReplicaSCM';
import { discoverLocalReplicas, selectLocalReplica } from '../scm/localReplicaSettings';
import { LocalReplicaActivation } from '../scm/localReplicaActivation';
import { SCMCollectionProvider } from '../scm/scmCollectionProvider';
import { CompileManager } from '../compile/compileManager';
import {
    asUri, content, externalDelete, externalWrite, fire, markSymbolicLink, mockVscode, reset, seed,
    setFolders, settle, state, Uri,
} from './vscodeMock';

const parent = Uri.file('/research/MaaS-Bundle');
const base = Uri.joinPath(parent, 'Paper', 'MaaS bundle design');
const origin = Uri.parse('overleaf-workshop://overleaf.test/Project?user=test&project=project-id');
const settings = {uri: origin.toString(), serverName: 'overleaf.test', projectName: 'Project', enableCompileNPreview: false};

function addReplica(directory: Uri, value: unknown = settings) {
    seed(Uri.joinPath(directory, '.overleaf/settings.json'), JSON.stringify(value));
}
function configuredPaths(paths: unknown) { state.config.set('overleaf-workshop.localReplica.paths', paths); }

suite('Explicit local replica discovery', () => {
    setup(reset);

    test('preserves a directly opened replica and its settings format', async () => {
        setFolders(base);
        addReplica(base);
        const found = await discoverLocalReplicas();
        assert.strictEqual(found.length, 1);
        assert.strictEqual(found[0].baseUri.toString(), base.toString());
        assert.deepStrictEqual(found[0].settings, settings);
        assert.deepStrictEqual(await LocalReplicaSCMProvider.readSettings(), settings);
        assert.strictEqual((await LocalReplicaSCMProvider.pathToUri('/main.tex'))?.toString(), Uri.joinPath(base, 'main.tex').toString());
    });

    test('resolves an explicit nested path against its workspace folder', async () => {
        setFolders(parent);
        addReplica(base);
        configuredPaths(['Paper/MaaS bundle design']);
        const found = await discoverLocalReplicas();
        assert.deepStrictEqual(found.map(item => item.baseUri.toString()), [base.toString()]);
        assert.deepStrictEqual(await LocalReplicaSCMProvider.readSettings(asUri(Uri.joinPath(base, 'main.tex'))), settings);
        assert.strictEqual(await LocalReplicaSCMProvider.uriToPath(asUri(Uri.joinPath(parent, 'Code/model.py'))), undefined);
        assert.strictEqual(await LocalReplicaSCMProvider.uriToPath(asUri(Uri.file(base.path + '-other/main.tex'))), undefined);
        assert.strictEqual(await LocalReplicaSCMProvider.pathToUri('../build/output.tex'), undefined);
    });

    test('uses folder-scoped relative settings in a multi-root workspace', async () => {
        const code = Uri.file('/research/Code');
        setFolders(code, parent);
        addReplica(base);
        state.folderConfig.set(code.toString(), new Map([['overleaf-workshop.localReplica.paths', ['missing']]]));
        state.folderConfig.set(parent.toString(), new Map([['overleaf-workshop.localReplica.paths', ['Paper/MaaS bundle design']]]));
        const found = await discoverLocalReplicas();
        assert.deepStrictEqual(found.map(item => item.baseUri.toString()), [base.toString()]);
    });

    test('also recognizes a directly opened replica among multiple roots', async () => {
        setFolders(parent, base);
        addReplica(base);
        assert.deepStrictEqual((await discoverLocalReplicas()).map(item => item.baseUri.toString()), [base.toString()]);
    });

    test('does not recursively activate an unconfigured nested replica', async () => {
        setFolders(parent);
        addReplica(base);
        assert.deepStrictEqual(await discoverLocalReplicas(), []);
    });

    test('rejects missing, malformed, nonlocal, and invalid settings without failing discovery', async () => {
        setFolders(parent);
        addReplica(base);
        const malformed = Uri.joinPath(parent, 'malformed');
        seed(Uri.joinPath(malformed, '.overleaf/settings.json'), '{bad json');
        addReplica(Uri.joinPath(parent, 'wrong-scheme'), {uri: 'https://overleaf.test/project'});
        addReplica(Uri.joinPath(parent, 'no-uri'), {projectName: 'Project'});
        configuredPaths([null, 7, '', 'missing', 'malformed', 'wrong-scheme', 'no-uri', 'https://example.test/replica', 'Paper/MaaS bundle design']);
        const found = await discoverLocalReplicas();
        assert.deepStrictEqual(found.map(item => item.baseUri.toString()), [base.toString()]);
        configuredPaths('Paper/MaaS bundle design');
        assert.deepStrictEqual(await discoverLocalReplicas(), []);
    });

    test('deduplicates absolute, relative, and directly opened paths', async () => {
        setFolders(parent, base);
        addReplica(base);
        configuredPaths(['Paper/MaaS bundle design', base.path, base.path + '/', 'Paper/MaaS bundle design/.']);
        const found = await discoverLocalReplicas();
        assert.strictEqual(found.length, 1);
        assert.strictEqual(found[0].baseUri.toString(), base.toString());
    });

    test('selects one deterministic active replica when multiple projects are configured', async () => {
        const other = Uri.joinPath(parent, 'Other paper');
        setFolders(parent);
        addReplica(base);
        addReplica(other, {...settings, uri: origin.with({query: 'user=test&project=second'}).toString()});
        configuredPaths(['Paper/MaaS bundle design', 'Other paper']);
        const found = await discoverLocalReplicas();
        assert.strictEqual(found.length, 2);
        assert.strictEqual(selectLocalReplica(found)?.baseUri.toString(), base.toString());
    });

    test('allows compilation without an editor while rejecting files outside the selected replica', async () => {
        setFolders(parent);
        addReplica(base, {...settings, enableCompileNPreview: true});
        configuredPaths(['Paper/MaaS bundle design']);
        assert.strictEqual((await CompileManager.check())?.toString(), origin.toString());
        const outside = Uri.joinPath(parent, 'Code/main.py');
        assert.strictEqual(await CompileManager.check(asUri(outside)), undefined);
        state.activeEditor = {document: {uri: outside}};
        assert.strictEqual(await CompileManager.check(), undefined);
        state.activeEditor = {document: {uri: Uri.joinPath(base, 'main.tex')}};
        assert.strictEqual((await CompileManager.check())?.toString(), origin.toString());
    });
});

function fakeVfs() {
    const persists = new Map<string, any>();
    return {
        origin: asUri(origin),
        serverName: 'overleaf.test', projectId: 'project-id', projectName: 'Project',
        pathToUri: (...parts: string[]) => asUri(Uri.joinPath(origin, ...parts)),
        getProjectSCMPersist: (key: string) => persists.get(key) || {settings: {}},
        setProjectSCMPersist: (key: string, value: any) => {
            if (value === undefined) { persists.delete(key); }
            else { persists.set(key, {...persists.get(key), ...value}); }
        },
    };
}

suite('Local replica activation lifecycle', () => {
    let activation: LocalReplicaActivation;
    let prefetched: Uri[];
    let initialized: Uri[];
    let released: unknown[];
    let vfs: {initLocalReplica(baseUri: Uri): Promise<void>};
    let provider: {prefetch(uri: Uri): Promise<typeof vfs>; releaseLocalReplica(value: unknown): void};

    setup(() => {
        reset();
        setFolders(parent);
        addReplica(base);
        configuredPaths(['Paper/MaaS bundle design']);
        prefetched = [];
        initialized = [];
        released = [];
        vfs = {async initLocalReplica(baseUri) { initialized.push(baseUri); }};
        provider = {
            async prefetch(uri) { prefetched.push(uri); return vfs; },
            releaseLocalReplica(value) { released.push(value); },
        };
        activation = new LocalReplicaActivation(provider as any);
    });
    teardown(() => {
        activation.dispose();
        assert.deepStrictEqual(state.errors, []);
    });

    test('activates the stored remote URI with the nested replica directory as its base', async () => {
        await activation.start();
        assert.deepStrictEqual(prefetched.map(uri => uri.toString()), [origin.toString()]);
        assert.deepStrictEqual(initialized.map(uri => uri.toString()), [base.toString()]);
        assert(state.commandCalls.some(call => call.name === 'setContext' && call.args[0] === 'overleaf-workshop.activate' && call.args[1] === true));
    });

    test('serializes duplicate activation and workspace reload requests', async () => {
        await Promise.all([activation.start(), activation.start()]);
        state.foldersChanged.fire({added: [], removed: []});
        state.configurationChanged.fire({affectsConfiguration: () => true});
        await activation.start();
        assert.strictEqual(prefetched.length, 1);
        assert.strictEqual(initialized.length, 1);
        assert.strictEqual(released.length, 0);
    });

    test('releases the active replica when its configured path is removed', async () => {
        await activation.start();
        configuredPaths([]);
        state.configurationChanged.fire({affectsConfiguration: () => true});
        await activation.start();
        assert.deepStrictEqual(released, [vfs]);
        assert.strictEqual(state.commandCalls.filter(call => call.args[0] === 'overleaf-workshop.activate').at(-1)?.args[1], false);
    });

    test('switches the active replica after a folder or path change', async () => {
        await activation.start();
        const other = Uri.joinPath(parent, 'Other paper');
        addReplica(other, {...settings, uri: origin.with({query: 'user=test&project=other'}).toString()});
        configuredPaths(['Other paper']);
        state.foldersChanged.fire({added: [], removed: []});
        await activation.start();
        assert.strictEqual(released.length, 1);
        assert.deepStrictEqual(initialized.map(uri => uri.toString()), [base.toString(), other.toString()]);
    });

    test('leaves the existing remote workspace activation workflow in control', async () => {
        setFolders(parent, origin);
        await activation.start();
        assert.strictEqual(prefetched.length, 0);
        assert.strictEqual(initialized.length, 0);
    });

    test('disposes listeners and releases a remote project returned after shutdown', async () => {
        let release: (value: typeof vfs) => void = () => {};
        provider.prefetch = async uri => {
            prefetched.push(uri);
            return new Promise(resolve => { release = resolve; });
        };
        const pending = activation.start();
        await settle(5);
        assert.strictEqual(prefetched.length, 1);
        activation.dispose();
        assert.strictEqual(state.configurationChanged.listeners.size, 0);
        assert.strictEqual(state.foldersChanged.listeners.size, 0);
        release(vfs);
        await pending;
        assert.deepStrictEqual(released, [vfs]);
        assert.strictEqual(initialized.length, 0);
        await activation.start();
        assert.strictEqual(prefetched.length, 1);
    });

    test('releases an initializing replica immediately when its configuration is removed', async () => {
        let release: () => void = () => {};
        const gate = new Promise<void>(resolve => { release = resolve; });
        vfs.initLocalReplica = async baseUri => { initialized.push(baseUri); await gate; };
        const pending = activation.start();
        await settle(5);
        assert.strictEqual(initialized.length, 1);
        configuredPaths([]);
        state.configurationChanged.fire({affectsConfiguration: () => true});
        await settle(5);
        try {
            assert.deepStrictEqual(released, [vfs]);
        } finally {
            release();
            await pending;
            await activation.start();
        }
        assert(!state.commandCalls.some(call => call.args[0] === 'overleaf-workshop.activate' && call.args[1] === true));
    });

    test('does not release a newer same-project selection when an older prefetch resolves', async () => {
        let release: (value: typeof vfs) => void = () => {};
        provider.prefetch = async uri => {
            prefetched.push(uri);
            if (prefetched.length === 1) { return new Promise(resolve => { release = resolve; }); }
            return vfs;
        };
        const previous = activation.start();
        await settle(5);
        const other = Uri.joinPath(parent, 'Another local copy');
        addReplica(other);
        configuredPaths(['Another local copy']);
        await activation.start();
        release(vfs);
        await previous;
        assert.strictEqual(released.length, 0);
        assert.deepStrictEqual(initialized.map(uri => uri.toString()), [other.toString()]);
    });
});

suite('Local replica SCM registration', () => {
    let collection: SCMCollectionProvider;
    let collectionTriggers: vscode.Disposable[];

    setup(() => {
        reset();
        setFolders(parent);
        addReplica(base);
        seed(Uri.joinPath(base, 'main.tex'), 'original');
        seed(Uri.joinPath(origin, 'main.tex'), 'original');
        collectionTriggers = [];
    });
    teardown(() => {
        collectionTriggers.forEach(item => item.dispose());
        assert.deepStrictEqual(state.errors, []);
    });

    function create() {
        collection = new SCMCollectionProvider(fakeVfs() as any, {} as vscode.ExtensionContext, asUri(base));
        collectionTriggers = collection.triggers;
        return collection;
    }

    test('registers only the selected replica and does not restore historical sibling paths', async () => {
        state.persists = {
            selected: {label: LocalReplicaSCMProvider.label, enabled: true, baseUri: base.toString(), settings: {}},
            duplicate: {label: LocalReplicaSCMProvider.label, enabled: true, baseUri: base.path, settings: {}},
            historical: {label: LocalReplicaSCMProvider.label, enabled: true, baseUri: parent.path, settings: {}},
        };
        await create().ready;
        const localWatchers = state.watchers.filter(item => item.active && item.pattern.baseUri.scheme === 'file');
        assert.deepStrictEqual(localWatchers.map(item => item.pattern.baseUri.toString()), [base.toString()]);
        assert.strictEqual(state.watchers.filter(item => item.active).length, 2);
        assert.strictEqual(state.saved.listeners.size, 1);
    });

    test('preserves a persisted disabled replica without starting its watchers', async () => {
        state.persists = {disabled: {label: LocalReplicaSCMProvider.label, enabled: false, baseUri: base.path, settings: {}}};
        await create().ready;
        assert.strictEqual(state.watchers.filter(item => item.active).length, 0);
        assert.strictEqual(state.saved.listeners.size, 0);
    });

    test('prefers current canonical settings over an earlier stale legacy path record', async () => {
        state.config.set('overleaf-workshop.localReplica.syncOnFileChange.enabled', true);
        state.persists = {
            [base.path]: {
                label: LocalReplicaSCMProvider.label, enabled: false, baseUri: base.path,
                settings: {['ignore-patterns']: ['**/old-only.tex']},
            },
            [base.toString()]: {
                label: LocalReplicaSCMProvider.label, enabled: true, baseUri: base.toString(),
                settings: {['ignore-patterns']: ['**/current-only.tex']},
            },
        };
        await create().ready;
        assert.strictEqual(state.watchers.filter(item => item.active).length, 2);
        state.operations = [];
        await externalWrite(Uri.joinPath(base, 'current-only.tex'), 'ignored by current settings');
        await externalWrite(Uri.joinPath(base, 'old-only.tex'), 'allowed by current settings');
        await settle();
        await assert.rejects(mockVscode.workspace.fs.stat(Uri.joinPath(origin, 'current-only.tex')), {code: 'FileNotFound'});
        assert.strictEqual(content(Uri.joinPath(origin, 'old-only.tex')), 'allowed by current settings');
        assert.strictEqual(state.operations.filter(operation => operation.uri.scheme === origin.scheme && operation.type === 'write').length, 1);
    });

    test('disposes a watcher session that finishes initializing after collection shutdown', async () => {
        let release: () => void = () => {};
        const gate = new Promise<void>(resolve => { release = resolve; });
        state.beforeWrite = async uri => { if (uri.scheme === 'file' && uri.path.endsWith('/main.tex')) { await gate; } };
        const pending = create().ready;
        await settle(5);
        collectionTriggers.forEach(item => item.dispose());
        release();
        await pending;
        assert.strictEqual(state.watchers.filter(item => item.active).length, 0);
        assert.strictEqual(state.saved.listeners.size, 0);
    });

    test('cancels initialization before it can overwrite local files after collection shutdown', async () => {
        let release: () => void = () => {};
        const gate = new Promise<void>(resolve => { release = resolve; });
        state.beforeRead = async uri => { if (uri.scheme === origin.scheme) { await gate; } };
        const pending = create().ready;
        await settle(5);
        collectionTriggers.forEach(item => item.dispose());
        release();
        await pending;
        assert.strictEqual(state.operations.filter(operation => operation.type === 'write').length, 0);
        assert.strictEqual(state.watchers.filter(item => item.active).length, 0);
    });
});

suite('Local replica file synchronization', () => {
    let provider: LocalReplicaSCMProvider;
    let disposables: vscode.Disposable[];
    let vfs: ReturnType<typeof fakeVfs>;
    const local = Uri.joinPath(base, 'main.tex');
    const remote = Uri.joinPath(origin, 'main.tex');
    const pushes = () => state.operations.filter(operation => operation.uri.scheme === origin.scheme);
    const writes = () => pushes().filter(operation => operation.type === 'write');

    async function start(fileChanges = true) {
        state.config.set('overleaf-workshop.localReplica.syncOnFileChange.enabled', fileChanges);
        provider = new LocalReplicaSCMProvider(vfs as any, asUri(base));
        disposables = await provider.triggers;
        state.operations = [];
    }

    setup(() => {
        reset();
        setFolders(parent);
        addReplica(base);
        seed(local, 'original');
        seed(remote, 'original');
        vfs = fakeVfs();
        disposables = [];
    });
    teardown(async () => {
        disposables.forEach(item => item.dispose());
        await settle(5);
        assert.deepStrictEqual(state.errors, [], 'watcher callbacks must not reject');
    });

    test('keeps explicit VS Code saves working with file changes disabled by default', async () => {
        await start(false);
        await externalWrite(local, 'editor save');
        await settle();
        assert.strictEqual(writes().length, 0);
        state.saved.fire({uri: local});
        await settle();
        assert.strictEqual(content(remote), 'editor save');
        assert.strictEqual(writes().length, 1);
    });

    test('uploads external modifications and coalesces duplicate editor/watch events', async () => {
        await start();
        await externalWrite(local, 'external change');
        fire('change', local);
        state.saved.fire({uri: local});
        await settle();
        assert.strictEqual(content(remote), 'external change');
        assert.strictEqual(writes().length, 1);
        fire('change', local);
        state.saved.fire({uri: local});
        await settle();
        assert.strictEqual(writes().length, 1, 'unchanged bytes must not upload twice');
    });

    test('synchronizes creation and deletion with file changes disabled', async () => {
        await start(false);
        const created = Uri.joinPath(base, 'figures/new.svg');
        const target = Uri.joinPath(origin, 'figures/new.svg');
        await externalWrite(created, 'new figure');
        await settle();
        assert.strictEqual(content(target), 'new figure');
        await externalDelete(created);
        await settle();
        await assert.rejects(mockVscode.workspace.fs.stat(target), {code: 'FileNotFound'});
        assert.deepStrictEqual(pushes().map(operation => operation.type), ['write', 'delete']);
    });

    test('recreates unchanged child content after its parent directory was deleted', async () => {
        await start();
        const folder = Uri.joinPath(base, 'figures');
        const created = Uri.joinPath(folder, 'new.svg');
        const target = Uri.joinPath(origin, 'figures/new.svg');
        await externalWrite(created, 'same figure');
        await settle();
        await mockVscode.workspace.fs.delete(folder);
        await settle();
        await assert.rejects(mockVscode.workspace.fs.stat(target), {code: 'FileNotFound'});
        await externalWrite(created, 'same figure');
        fire('create', folder);
        await settle();
        assert.strictEqual(content(target), 'same figure');
        assert.strictEqual(writes().length, 2);
    });

    test('uploads only the latest bytes after rapid successive changes', async () => {
        await start();
        for (const value of ['first', 'second', 'third']) { await externalWrite(local, value); }
        await settle();
        assert.strictEqual(content(remote), 'third');
        assert.strictEqual(writes().length, 1);
    });

    test('coalesces atomic replacement delete/create into one update', async () => {
        await start();
        await externalDelete(local);
        await externalWrite(local, 'atomic replacement');
        await settle();
        assert.strictEqual(content(remote), 'atomic replacement');
        assert.deepStrictEqual(pushes().map(operation => operation.type), ['write']);
    });

    test('handles a transient temporary file followed by an atomic rename', async () => {
        await start();
        const temporary = Uri.joinPath(base, 'main.tex.tmp');
        await externalWrite(temporary, 'atomic save');
        await externalDelete(local);
        await externalWrite(local, 'atomic save');
        await externalDelete(temporary);
        await settle();
        assert.strictEqual(content(remote), 'atomic save');
        assert.deepStrictEqual(pushes().map(operation => [operation.type, operation.uri.path]), [['write', remote.path]]);
    });

    test('compares binary bytes without treating invalid UTF-8 sequences as equal', async () => {
        await start();
        for (const byte of [0x80, 0x81]) {
            seed(local, new Uint8Array([byte]));
            fire('change', local);
            await settle();
            assert.deepStrictEqual(await mockVscode.workspace.fs.readFile(remote), new Uint8Array([byte]));
        }
        assert.strictEqual(writes().length, 2);
    });

    test('retries unchanged bytes after a failed upload instead of caching failure', async () => {
        await start();
        state.beforeWrite = async uri => { if (uri.scheme === origin.scheme) { throw new Error('simulated offline write'); } };
        await externalWrite(local, 'retry this change');
        await settle();
        assert.strictEqual(provider.status.status, 'need-attention');
        assert.strictEqual(content(remote), 'original');
        state.beforeWrite = undefined;
        fire('change', local);
        await settle();
        assert.strictEqual(content(remote), 'retry this change');
        assert.strictEqual(writes().length, 1);
    });

    test('serializes an upload in flight with a later local change', async () => {
        await start();
        let release: () => void = () => {};
        const gate = new Promise<void>(resolve => { release = resolve; });
        let blocked = false;
        state.beforeWrite = async uri => {
            if (uri.scheme === origin.scheme && !blocked) { blocked = true; await gate; }
        };
        await externalWrite(local, 'first upload');
        await settle();
        assert.strictEqual(blocked, true);
        await externalWrite(local, 'last upload');
        await settle();
        release();
        await settle();
        assert.strictEqual(content(remote), 'last upload');
        assert.deepStrictEqual(writes().map(operation => Buffer.from(operation.data!).toString()), ['first upload', 'last upload']);
    });

    test('pulls remote changes without uploading local watcher echoes', async () => {
        await start();
        await externalWrite(remote, 'remote update');
        await settle(350);
        assert.strictEqual(content(local), 'remote update');
        assert.strictEqual(pushes().length, 0);
        assert.strictEqual(state.operations.filter(operation => operation.type === 'write').length, 1);
        await externalDelete(remote);
        await settle(350);
        await assert.rejects(mockVscode.workspace.fs.stat(local), {code: 'FileNotFound'});
        assert.strictEqual(pushes().length, 0);
    });

    test('enforces URI scheme, authority, and path boundaries for saves and watcher events', async () => {
        await start();
        const outside = [Uri.joinPath(parent, 'Code/model.py'), Uri.joinPath(parent, 'Paper/build/main.tex'),
            Uri.file(base.path + '-other/main.tex'), local.with({scheme: 'untitled'}), local.with({authority: 'another-host'})];
        const watcher = state.watchers.find(item => item.pattern.baseUri.scheme === 'file')!;
        for (const uri of outside) {
            seed(uri, 'outside');
            state.saved.fire({uri});
            watcher.change.fire(uri);
            watcher.create.fire(uri);
            watcher.delete.fire(uri);
        }
        await settle();
        assert.strictEqual(pushes().length, 0);
    });

    test('ignores remote events for another project, origin, or sibling path', async () => {
        await start();
        const watcher = state.watchers.find(item => item.pattern.baseUri.scheme === origin.scheme)!;
        for (const uri of [remote.with({query: 'user=test&project=other'}), remote.with({authority: 'other.test'}),
            remote.with({scheme: 'file'}), remote.with({path: '/Project-other/main.tex'})]) {
            watcher.change.fire(uri);
            watcher.delete.fire(uri);
        }
        await settle();
        assert.strictEqual(content(local), 'original');
        assert.strictEqual(state.operations.length, 0);
    });

    test('does not follow local directory symlinks for uploads or remote writes', async () => {
        const linked = Uri.joinPath(base, 'linked/main.tex');
        const remoteLinked = Uri.joinPath(origin, 'linked/main.tex');
        seed(linked, 'outside linked content');
        seed(remoteLinked, 'remote linked content');
        markSymbolicLink(Uri.joinPath(base, 'linked'));
        await start();
        assert.strictEqual(content(linked), 'outside linked content', 'initialization must also respect the boundary');
        await externalWrite(linked, 'outside changed');
        state.saved.fire({uri: linked});
        await externalWrite(remoteLinked, 'remote changed');
        await settle();
        assert.strictEqual(content(linked), 'outside changed');
        assert.strictEqual(state.operations.length, 0);
    });

    test('preserves built-in ignores and excludes replica metadata', async () => {
        await start();
        for (const name of ['main.aux', 'main.log', '.git/config', '.vscode/settings.json', '.overleaf/settings.json']) {
            await externalWrite(Uri.joinPath(base, name), 'ignored');
        }
        await settle();
        assert.strictEqual(pushes().length, 0);
    });

    test('respects custom build ignores while always protecting .overleaf settings', async () => {
        vfs.setProjectSCMPersist(base.toString(), {settings: {['ignore-patterns']: ['**/build/**']}});
        await start();
        await externalWrite(Uri.joinPath(base, 'build/result.tex'), 'ignored build output');
        await externalWrite(Uri.joinPath(base, '.overleaf/settings.json'), 'protected metadata');
        await externalWrite(Uri.joinPath(base, '.git/config'), 'protected git metadata');
        await externalWrite(Uri.joinPath(base, '.vscode/settings.json'), 'protected editor metadata');
        await settle();
        assert.strictEqual(pushes().length, 0);
    });

    test('returns one watcher session and cancels pending work on disposal', async () => {
        await start();
        await provider.triggers;
        assert.strictEqual(state.watchers.filter(item => item.active).length, 2);
        assert.strictEqual(state.saved.listeners.size, 1);
        await externalWrite(local, 'queued before shutdown');
        disposables.forEach(item => item.dispose());
        state.saved.fire({uri: local});
        await settle();
        assert.strictEqual(state.watchers.filter(item => item.active).length, 0);
        assert.strictEqual(state.saved.listeners.size, 0);
        assert.strictEqual(pushes().length, 0);
    });

    test('can dispose before initialization finishes reading remote files', async () => {
        let release: () => void = () => {};
        const gate = new Promise<void>(resolve => { release = resolve; });
        state.beforeRead = async uri => { if (uri.scheme === origin.scheme) { await gate; } };
        provider = new LocalReplicaSCMProvider(vfs as any, asUri(base));
        const pending = provider.triggers;
        await settle(5);
        provider.dispose();
        assert.strictEqual(state.watchers.filter(item => item.active).length, 0);
        release();
        disposables = await pending;
        assert.strictEqual(state.operations.length, 0);
        assert.strictEqual(state.saved.listeners.size, 0);
    });

    test('can reenable a disposed replica without retaining old listeners', async () => {
        await start();
        disposables.forEach(item => item.dispose());
        disposables = await provider.triggers;
        state.operations = [];
        assert.strictEqual(state.watchers.filter(item => item.active).length, 2);
        assert.strictEqual(state.saved.listeners.size, 1);
        await externalWrite(local, 'after reload');
        await settle();
        assert.strictEqual(content(remote), 'after reload');
        assert.strictEqual(writes().length, 1);
    });
});
