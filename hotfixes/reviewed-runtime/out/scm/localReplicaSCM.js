"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LocalReplicaSCMProvider = void 0;
const vscode = require("vscode");
const crypto_1 = require("crypto");
const minimatch_1 = require("minimatch");
const _1 = require(".");
const localReplicaSettings_1 = require("./localReplicaSettings");
const remoteUpdateManager_1 = require("./remoteUpdateManager");
const IGNORE_SETTING_KEY = 'ignore-patterns';
function contentHash(content) {
    return (0, crypto_1.createHash)('sha256').update(content).digest('hex');
}
function sameContent(left, right) {
    return left === right || (left !== undefined && right !== undefined
        && left.length === right.length && left.every((byte, index) => byte === right[index]));
}
function isFileNotFound(error) {
    const code = error?.code;
    return code === 'FileNotFound' || code === 'ENOENT';
}
/**
 * A SCM which tracks exact the changes from the vfs.
 * It keeps no history versions.
 */
class LocalReplicaSCMProvider extends _1.BaseSCM {
    constructor(vfs, baseUri) {
        super(vfs, baseUri);
        this.vfs = vfs;
        this.baseUri = baseUri;
        this.iconPath = new vscode.ThemeIcon('folder-library');
        this.bypassCache = new Map();
        this.baseCache = {};
        this.syncTimers = new Map();
        this.syncQueues = new Map();
        this.pushSyncQueue = Promise.resolve();
        this.remoteDirectoryTasks = new Map();
        this.activeSyncs = 0;
        this.knownRemotePaths = new Set();
        this.syncedHashes = new Map();
        this.manifestWrite = Promise.resolve();
        this.manifestVersion = 0;
        this.persistedManifestVersion = 0;
        this.ignorePatterns = [
            '**/.*',
            '**/.*/**',
            '**/*.aux',
            '**/__latexindent*',
            '**/*.bbl',
            '**/*.bcf',
            '**/*.blg',
            '**/*.fdb_latexmk',
            '**/*.fls',
            '**/*.git',
            '**/*.lof',
            '**/*.log',
            '**/*.lot',
            '**/*.out',
            '**/*.run.xml',
            '**/*.synctex(busy)',
            '**/*.synctex.gz',
            '**/*.toc',
            '**/*.xdv',
            '**/main.pdf',
            '**/output.pdf',
        ];
    }
    static sanitizeProjectFolderName(projectName) {
        let sanitized = projectName;
        if (process.platform === 'win32') {
            sanitized = projectName
                .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
                .replace(/[. ]+$/g, '');
            if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(sanitized)) {
                sanitized = `${sanitized}_`;
            }
        }
        else {
            sanitized = projectName.replace(/[\/\x00]/g, '_');
        }
        if (sanitized === '' || sanitized === '.' || sanitized === '..') {
            sanitized = 'untitled-project';
        }
        return sanitized;
    }
    static async validateBaseUri(uri, projectName) {
        try {
            let baseUri = vscode.Uri.file(uri);
            const folderName = projectName === undefined ? undefined : LocalReplicaSCMProvider.sanitizeProjectFolderName(projectName);
            // check if the path exists
            try {
                const stat = await vscode.workspace.fs.stat(baseUri);
                if (stat.type !== vscode.FileType.Directory) {
                    throw new Error('Not a folder');
                }
                // check if the project name is included in the path
                if (folderName !== undefined && !baseUri.path.endsWith(`/${folderName}`)) {
                    baseUri = vscode.Uri.joinPath(baseUri, folderName);
                }
            }
            catch {
                // keep the baseUri as is
            }
            // try to create the folder with `mkdirp` semantics
            await vscode.workspace.fs.createDirectory(baseUri);
            await vscode.workspace.fs.stat(baseUri);
            return baseUri;
        }
        catch (error) {
            vscode.window.showErrorMessage(vscode.l10n.t('Invalid Path. Please make sure the absolute path to a folder with read/write permissions is used.'));
            return Promise.reject(error);
        }
    }
    static async pathToUri(path) {
        const replica = (0, localReplicaSettings_1.selectLocalReplica)(await (0, localReplicaSettings_1.discoverLocalReplicas)());
        if (!replica || path.split(/[\\/]/).includes('..')) {
            return undefined;
        }
        const uri = vscode.Uri.joinPath(replica.baseUri, path);
        return (0, localReplicaSettings_1.containsLocalUri)(replica.baseUri, uri) ? uri : undefined;
    }
    static async uriToPath(uri) {
        const replica = (0, localReplicaSettings_1.selectLocalReplica)(await (0, localReplicaSettings_1.discoverLocalReplicas)());
        if (!replica || !(0, localReplicaSettings_1.containsLocalUri)(replica.baseUri, uri)) {
            return undefined;
        }
        return uri.path.slice(replica.baseUri.path.replace(/\/+$/, '').length);
    }
    static async readSettings(resource) {
        const replica = (0, localReplicaSettings_1.selectLocalReplica)(await (0, localReplicaSettings_1.discoverLocalReplicas)());
        if (!replica || (resource && (0, localReplicaSettings_1.replicaKey)(resource) !== (0, localReplicaSettings_1.replicaKey)(replica.baseUri) && !(0, localReplicaSettings_1.containsLocalUri)(replica.baseUri, resource))) {
            return undefined;
        }
        return replica.settings;
    }
    matchIgnorePatterns(path) {
        // Replica metadata must stay local even when custom patterns replace defaults.
        if (path.split('/').some(part => ['.overleaf', '.git', '.vscode'].includes(part))) {
            return true;
        }
        const ignorePatterns = this.getSetting(IGNORE_SETTING_KEY) || this.ignorePatterns;
        for (const pattern of ignorePatterns) {
            if ((0, minimatch_1.minimatch)(path, pattern, { dot: true })) {
                return true;
            }
        }
        return false;
    }
    setBypassCache(relPath, content) {
        this.bypassCache.set(relPath, content === undefined ? undefined : (0, crypto_1.createHash)('sha256').update(content).digest('hex'));
    }
    shouldPropagate(relPath, content) {
        const fingerprint = content === undefined ? undefined : (0, crypto_1.createHash)('sha256').update(content).digest('hex');
        return !this.bypassCache.has(relPath) || this.bypassCache.get(relPath) !== fingerprint;
    }
    relativeSyncPath(uri, root) {
        if (uri.scheme !== root.scheme || uri.authority !== root.authority) {
            return undefined;
        }
        const prefix = root.path.replace(/\/+$/, '') + '/';
        if (!uri.path.startsWith(prefix) || uri.path === prefix) {
            return undefined;
        }
        const parts = uri.path.slice(prefix.length).split('/');
        if (parts.some(part => part === '.' || part === '..')) {
            return undefined;
        }
        return '/' + parts.join('/').replace(/\/+$/, '');
    }
    async hasLocalSymbolicLink(relPath) {
        let uri = this.baseUri;
        for (const part of relPath.split('/').filter(Boolean)) {
            uri = vscode.Uri.joinPath(uri, part);
            try {
                if ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.SymbolicLink) {
                    return true;
                }
            }
            catch (error) {
                if (isFileNotFound(error)) {
                    return false;
                }
                throw error;
            }
        }
        return false;
    }
    queueSync(action, type, relPath, fromUri, toUri, options = {}) {
        const session = this.watchSession;
        if (!session || session.disposed) {
            return Promise.resolve();
        }
        if (action === 'push' && this.manualSyncEvents) {
            this.manualSyncEvents.set(relPath, { type, fromUri, toUri, options });
            return Promise.resolve();
        }
        const previous = this.syncQueues.get(relPath) ?? Promise.resolve();
        // Missing files refresh the project snapshot before creation. Do not reset
        // that transport while another local push is still using it.
        const previousPush = action === 'push' ? this.pushSyncQueue : Promise.resolve();
        const next = Promise.all([previous.catch(() => {}), previousPush.catch(() => {})]).then(async () => {
            const busyDeadline = Date.now() + 15000;
            while (!session.disposed) {
                try {
                    if (action === 'push' && !options.snapshotChecked && !this.remoteUpdates.hasPending(relPath)) {
                        await this.preparePush(relPath, fromUri, toUri, session);
                    }
                    await this.applySync(action, type, relPath, fromUri, toUri, session, options);
                    return true;
                } catch (error) {
                    // Only retry the provider's own busy-snapshot condition. HTTP
                    // upload failures have their own bounded transport retry policy.
                    if (error?.message !== 'Remote changes are waiting to be uploaded; retry the snapshot later'
                        || Date.now() >= busyDeadline) {
                        throw error;
                    }
                    // Let active writes finish naturally. Poll cancellation while
                    // waiting; do not reset the transport or bypass pending review.
                    const retryAt = Math.min(Date.now() + 250, busyDeadline);
                    while (!session.disposed && Date.now() < retryAt) {
                        await new Promise(resolve => setTimeout(resolve, Math.min(50, retryAt - Date.now())));
                    }
                }
            }
            return false;
        }).catch(error => {
            const code = typeof error?.code === 'string' && /^[A-Za-z0-9_-]{1,48}$/.test(error.code)
                ? error.code : error?.message === 'Remote changes are waiting to be uploaded; retry the snapshot later'
                    ? 'RemoteSyncBusy' : 'RemoteOperationFailed';
            // Never include remote error payloads, which can contain authentication data.
            const status = Number.isInteger(error?.statusCode) && error.statusCode >= 100 && error.statusCode <= 599
                ? `, HTTP ${error.statusCode}` : '';
            console.error(`Local Replica ${action} failed: ${relPath} (${code}${status})`);
            this.status = { status: 'need-attention', message: `${type}: ${relPath}` };
            return false;
        });
        this.syncQueues.set(relPath, next);
        if (action === 'push') { this.pushSyncQueue = next; }
        void next.then(() => {
            if (this.syncQueues.get(relPath) === next) {
                this.syncQueues.delete(relPath);
            }
        });
        return next;
    }
    scheduleLocalSync(uri, type) {
        const relPath = this.relativeSyncPath(uri, this.baseUri);
        const session = this.watchSession;
        if (!session || session.disposed || relPath === undefined || this.matchIgnorePatterns(relPath)) {
            return;
        }
        const pending = this.syncTimers.get(relPath);
        if (pending) {
            clearTimeout(pending.timer);
        }
        const event = pending?.event === 'create' && type === 'update' ? 'create' : type;
        const timer = setTimeout(() => {
            this.syncTimers.delete(relPath);
            if (session.disposed) { return; }
            if (event === 'create') {
                void this.syncLocalCreation(uri, relPath, session).catch(() => {
                    if (session.disposed) { return; }
                    this.status = { status: 'need-attention', message: `Could not check new local path: ${relPath}` };
                    console.error(`Local Replica could not check new local path: ${relPath}`);
                });
            } else {
                void this.syncToVFS(uri, event);
            }
        }, 100);
        this.syncTimers.set(relPath, { timer, event });
    }
    async syncLocalCreation(uri, relPath, session) {
        if (session.disposed || await this.hasLocalSymbolicLink(relPath)) { return; }
        let stat;
        try {
            stat = await vscode.workspace.fs.stat(uri);
        } catch (error) {
            if (isFileNotFound(error)) { return; }
            throw error;
        }
        if (session.disposed) { return; }
        if (stat.type === vscode.FileType.Directory) {
            // A move can emit one directory event for a populated subtree.
            // Enumerate outside the serial push queue to avoid waiting on itself.
            const checked = await this.syncToVFS(uri, 'update', { onlyAdd: true });
            if (!checked || session.disposed) { return; }
            await this.reconcileLocalAdditions(session, relPath, true);
        } else if (stat.type === vscode.FileType.File) {
            await this.syncToVFS(uri, 'update', {
                onlyAdd: !this.knownRemotePaths.has(relPath),
                skipMissing: true,
            });
        }
    }
    async reconcileLocalAdditions(session, root = '/', includeEmptyDirectories = false) {
        if (session.disposed || this.manualSyncEvents) { return; }
        const paths = await this.localFilesForUpload(session, root, includeEmptyDirectories);
        if (session.disposed || this.manualSyncEvents) { return; }
        const uploads = [];
        for (const relPath of paths) {
            if (this.knownRemotePaths.has(relPath) || this.syncQueues.has(relPath) ||
                this.remoteUpdates.hasPending(relPath)) {
                continue;
            }
            const uri = vscode.Uri.joinPath(this.baseUri, relPath);
            uploads.push(this.syncToVFS(uri, 'update', { onlyAdd: true, snapshotChecked: true }));
        }
        await Promise.all(uploads);
    }
    matchesSyncedContent(relPath, content) {
        if (content === undefined) { return false; }
        const hash = this.syncedHashes.get(relPath);
        return hash === undefined ? sameContent(content, this.baseCache[relPath]) : hash === contentHash(content);
    }
    canRecoverLocalEdit(relPath, remote) {
        return !!this.watchSession?.syncOnFileChange && !this.manualSyncEvents &&
            this.matchesSyncedContent(relPath, remote) &&
            !this.vfs.isRemoteEditorDirty?.(this.vfs.pathToUri(relPath));
    }
    async reconcileLocalEdits(session) {
        for (const [relPath, hash] of this.syncedHashes) {
            if (session.disposed || this.manualSyncEvents) { return; }
            if (this.syncQueues.has(relPath) || this.syncTimers.has(relPath) ||
                this.matchIgnorePatterns(relPath) || await this.hasLocalSymbolicLink(relPath)) {
                continue;
            }
            const uri = vscode.Uri.joinPath(this.baseUri, relPath);
            let stat;
            try { stat = await vscode.workspace.fs.stat(uri); }
            catch (error) {
                if (isFileNotFound(error)) { continue; }
                throw error;
            }
            if (stat.type !== vscode.FileType.File) { continue; }
            const local = await this.remoteUpdates.localState(relPath);
            if (session.disposed || this.manualSyncEvents) { return; }
            if (local.dirty !== undefined || local.disk === undefined || contentHash(local.disk) === hash) {
                continue;
            }
            // A cancelled manual review may have staged a local-only edit.
            // Recheck the cloud before reconsidering that entry.
            if (this.remoteUpdates.hasPending(relPath)) {
                const pending = this.remoteUpdates.pending.get(relPath);
                if (!pending || !this.canRecoverLocalEdit(relPath, pending.content)) { continue; }
                const remote = await this.freshRemoteContent(this.vfs.pathToUri(relPath));
                if (session.disposed || this.manualSyncEvents) { return; }
                if (this.remoteUpdates.pending.get(relPath) !== pending) { continue; }
                await this.remoteUpdates.queue(relPath, remote);
                if (this.remoteUpdates.hasPending(relPath)) { continue; }
            }
            await this.syncToVFS(uri, 'update', { skipMissing: true, snapshotChecked: true });
        }
    }
    async loadSyncManifest() {
        const uri = vscode.Uri.joinPath(this.baseUri, '.overleaf/remote-sync-state.json');
        if (await this.hasLocalSymbolicLink('/.overleaf/remote-sync-state.json')) {
            throw new Error('Local Replica metadata cannot use symbolic links');
        }
        try {
            const state = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
            const project = contentHash(this.vfs.origin.toString());
            if (state.project !== undefined && state.project !== project) { return; }
            if (Array.isArray(state.paths)) {
                this.knownRemotePaths = new Set(state.paths.filter(path => typeof path === 'string' && path.startsWith('/')
                    && !path.split('/').some(part => part === '.' || part === '..') && !this.matchIgnorePatterns(path)));
            }
            if (state.project === project && state.hashes && typeof state.hashes === 'object') {
                this.syncedHashes = new Map(Object.entries(state.hashes).filter(([path, hash]) =>
                    this.knownRemotePaths.has(path) && typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash)));
            }
        }
        catch (error) {
            if (!isFileNotFound(error)) {
                throw error;
            }
        }
    }
    async recordSyncedState(relPath, content) {
        const previousHash = this.syncedHashes.get(relPath);
        const hash = content === undefined ? undefined : contentHash(content);
        const changed = content === undefined ? this.knownRemotePaths.delete(relPath) : !this.knownRemotePaths.has(relPath);
        if (content === undefined) {
            this.syncedHashes.delete(relPath);
        } else {
            this.knownRemotePaths.add(relPath);
            this.syncedHashes.set(relPath, hash);
        }
        if (changed || hash !== previousHash) {
            this.manifestVersion++;
        }
        if (this.persistedManifestVersion === this.manifestVersion) { return; }
        const session = this.watchSession;
        this.manifestWrite = this.manifestWrite.catch(() => {}).then(async () => {
            if (!session || session.disposed || this.persistedManifestVersion === this.manifestVersion) {
                return;
            }
            if (await this.hasLocalSymbolicLink('/.overleaf/remote-sync-state.json')) {
                throw new Error('Local Replica metadata cannot use symbolic links');
            }
            if (!session.disposed) {
                const uri = vscode.Uri.joinPath(this.baseUri, '.overleaf/remote-sync-state.json');
                const version = this.manifestVersion;
                const paths = [...this.knownRemotePaths].sort();
                const hashes = Object.fromEntries(paths.map(path => [path, this.syncedHashes.get(path)]));
                const state = { project: contentHash(this.vfs.origin.toString()), paths, hashes };
                const temporary = vscode.Uri.joinPath(this.baseUri,
                    `/.overleaf/remote-sync-state-${(0, crypto_1.randomBytes)(6).toString('hex')}.tmp`);
                let installed = false;
                try {
                    await vscode.workspace.fs.writeFile(temporary, new TextEncoder().encode(JSON.stringify(state, null, 2)));
                    if (session.disposed) { return; }
                    await vscode.workspace.fs.rename(temporary, uri, { overwrite: true });
                    installed = true;
                    this.persistedManifestVersion = version;
                } finally {
                    if (!installed) {
                        await vscode.workspace.fs.delete(temporary).catch(() => {});
                    }
                }
            }
        });
        return this.manifestWrite;
    }
    async overwrite(root = '/', session = this.watchSession) {
        // Initial activation and recovery only collect differences; no automatic
        // merge, local overwrite, or write-back to Overleaf is permitted here.
        return vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Checking Overleaf Updates',
            cancellable: true,
        }, async (progress, token) => {
            const prefix = root.endsWith('/') ? root : root + '/';
            const files = [];
            const queue = [prefix];
            while (queue.length) {
                if (!session || session.disposed || token.isCancellationRequested) {
                    return false;
                }
                const directory = queue.shift();
                const items = await vscode.workspace.fs.readDirectory(this.vfs.pathToUri(directory));
                for (const [name, type] of items) {
                    const relPath = directory + name;
                    if (this.matchIgnorePatterns(relPath)) {
                        continue;
                    }
                    if (type === vscode.FileType.Directory) {
                        queue.push(relPath + '/');
                    }
                    else {
                        files.push(relPath);
                    }
                }
            }
            const seen = new Set(files);
            for (const relPath of files) {
                if (session.disposed || token.isCancellationRequested) {
                    return false;
                }
                progress.report({ increment: files.length ? 100 / files.length : 0, message: relPath });
                if (await this.syncFromVFS(this.vfs.pathToUri(relPath), 'update') === false) {
                    throw new Error('A remote file could not be checked');
                }
            }
            if (session.disposed || token.isCancellationRequested) {
                return false;
            }
            for (const relPath of [...this.knownRemotePaths]) {
                if (relPath.startsWith(prefix) && !seen.has(relPath) && !this.matchIgnorePatterns(relPath)) {
                    if (await this.syncFromVFS(this.vfs.pathToUri(relPath), 'delete') === false) {
                        throw new Error('A remote deletion could not be checked');
                    }
                }
            }
            return true;
        });
    }
    async checkRemoteUpdates(force = false) {
        if (!this.watchSession || this.watchSession.disposed) {
            return;
        }
        if (this.remoteCheckPromise) {
            await this.remoteCheckPromise;
            if (force) {
                return this.checkRemoteUpdates(true);
            }
            return;
        }
        const session = this.watchSession;
        this.remoteCheckPromise = (async () => {
            await Promise.all([...this.syncQueues.values()]);
            let revision;
            try {
                const updates = await this.vfs.getUpdates();
                revision = updates?.updates?.[0]?.toV;
            }
            catch {
                // A restricted history API must not disable manual/event-based pulls.
            }
            if (!force && !this.remoteCheckFailed && revision !== undefined && revision === this.lastCheckedRemoteVersion) {
                return;
            }
            await this.vfs.refreshRemoteSnapshot();
            if (session.disposed) {
                return;
            }
            if (!await this.overwrite('/', session)) {
                throw new Error('Remote check was cancelled');
            }
            this.lastCheckedRemoteVersion = revision;
            this.remoteCheckFailed = false;
            this.remoteUpdates.updateStatus();
        })().finally(() => { this.remoteCheckPromise = undefined; });
        return this.remoteCheckPromise;
    }
    async localFilesForUpload(session, root = '/', includeEmptyDirectories = false) {
        const files = [];
        const folders = [root.endsWith('/') ? root : root + '/'];
        while (folders.length && !session.disposed) {
            const folder = folders.pop();
            const uri = vscode.Uri.joinPath(this.baseUri, folder);
            if (await this.hasLocalSymbolicLink(folder)) { continue; }
            let entries;
            try {
                entries = await vscode.workspace.fs.readDirectory(uri);
            } catch (error) {
                // A directory can be moved or deleted after it was discovered.
                if (isFileNotFound(error)) { continue; }
                throw error;
            }
            if (includeEmptyDirectories && folder !== '/' && entries.length === 0) {
                files.push(folder.slice(0, -1));
            }
            for (const [name, type] of entries) {
                const path = folder + name;
                if (this.matchIgnorePatterns(path)) { continue; }
                if (type === vscode.FileType.Directory) { folders.push(path + '/'); }
                else if (type === vscode.FileType.File) { files.push(path); }
            }
        }
        return files;
    }
    async manualSync(direction) {
        const session = this.watchSession;
        if (!session || session.disposed || this.manualSyncEvents) { return false; }
        const manager = this.remoteUpdates;
        const events = new Map();
        this.manualSyncEvents = events;
        try {
            await manager.pushPromise;
            try { await this.checkRemoteUpdates(true); }
            catch (error) {
                if (manager.isActive()) { this.remoteCheckFailed = true; }
                throw error;
            }
            if (!manager.isActive()) { return false; }
            const entries = [];
            const push = direction === 'push';
            for (const entry of manager.pending.values()) {
                const local = await manager.localState(entry.relPath);
                if (!push || local.disk !== undefined || local.dirty !== undefined || this.knownRemotePaths.has(entry.relPath)) {
                    entries.push({ ...entry, manualLocal: local });
                }
            }
            if (push) {
                const localOnly = await this.localFilesForUpload(session);
                for (const relPath of localOnly) {
                    if (!manager.isActive()) { return false; }
                    if (manager.pending.has(relPath) || this.knownRemotePaths.has(relPath) || await this.hasLocalSymbolicLink(relPath)) {
                        continue;
                    }
                    const remote = await this.freshRemoteContent(this.vfs.pathToUri(relPath));
                    const local = await manager.localState(relPath);
                    if (remote === undefined && local.disk !== undefined) {
                        entries.push({ relPath, content: undefined, manualLocal: local, needsQueue: true });
                    }
                }
            }
            if (!manager.isActive()) { return false; }
            if (!entries.length) {
                void vscode.window.showInformationMessage(push ? 'No local changes to push to Overleaf.' : 'No Overleaf changes to pull into this Local Replica.');
                return true;
            }
            const action = push ? 'Push to Overleaf' : 'Pull to Local';
            const files = entries.map(entry => {
                const source = push ? entry.manualLocal.dirty ?? entry.manualLocal.disk : entry.content;
                const target = push ? entry.content : entry.manualLocal.disk;
                const change = source === undefined ? 'Delete' : target === undefined ? 'Add'
                    : push && this.matchesSyncedContent(entry.relPath, target) ? 'Update' : 'Replace';
                return `${change} ${entry.relPath}`;
            });
            const preview = files.sort((left, right) => Number(right.startsWith('Delete ')) - Number(left.startsWith('Delete ')));
            if (await vscode.window.showWarningMessage(`${action}: ${entries.length} file(s)`, {
                modal: true,
                detail: `${preview.join('\n')}\n\nReplaced and deleted files are backed up before syncing.`,
            }, action) !== action || !manager.isActive()) { return false; }
            const accepted = [];
            for (const entry of entries) {
                if (!manager.isActive()) { return false; }
                if (entry.needsQueue) {
                    if (manager.pending.has(entry.relPath)) {
                        void vscode.window.showWarningMessage(`Overleaf changed ${entry.relPath} during review. Review it again before syncing.`);
                        continue;
                    }
                    await manager.queue(entry.relPath, undefined);
                    const candidate = manager.pending.get(entry.relPath);
                    if (candidate && candidate.content === undefined) {
                        accepted.push({ ...candidate, manualLocal: entry.manualLocal });
                    }
                }
                else { accepted.push(entry); }
            }
            return push ? await manager.push(accepted) : await manager.pull(accepted);
        }
        finally {
            this.manualSyncEvents = undefined;
            if (!session.disposed && this.watchSession === session) {
                for (const [relPath, { type, fromUri, toUri, options }] of events) {
                    void this.queueSync('push', type, relPath, fromUri, toUri, options);
                }
                manager.updateStatus();
            }
        }
    }
    runAcceptedPull(relPath, apply) {
        const previous = this.syncQueues.get(relPath) ?? Promise.resolve();
        const next = previous.catch(() => {}).then(apply);
        this.syncQueues.set(relPath, next);
        void next.finally(() => {
            if (this.syncQueues.get(relPath) === next) {
                this.syncQueues.delete(relPath);
            }
        }).catch(() => {});
        return next;
    }
    async queueRemoteDeletion(relPath, session) {
        const localUri = vscode.Uri.joinPath(this.baseUri, relPath);
        let stat;
        try {
            stat = await vscode.workspace.fs.stat(localUri);
        }
        catch (error) {
            if (!isFileNotFound(error)) {
                throw error;
            }
        }
        if (session.disposed) {
            return;
        }
        if (stat?.type === vscode.FileType.Directory) {
            // Never recursively remove a folder: it may contain ignored files,
            // local-only additions, or recovery metadata.
            for (const path of [...this.knownRemotePaths]) {
                if (path.startsWith(relPath + '/') && !this.matchIgnorePatterns(path)) {
                    await this.remoteUpdates.queue(path, undefined);
                }
            }
        }
        else {
            await this.remoteUpdates.queue(relPath, undefined);
        }
    }
    async freshRemoteContent(uri) {
        try {
            return await this.vfs.readRemoteFile(uri, true);
        }
        catch (error) {
            if (isFileNotFound(error)) {
                return undefined;
            }
            throw error;
        }
    }
    async preparePush(relPath, localUri, remoteUri, session) {
        if (session.disposed || this.matchIgnorePatterns(relPath) || await this.hasLocalSymbolicLink(relPath)) {
            return;
        }
        let local, remote;
        try {
            local = await vscode.workspace.fs.stat(localUri);
        }
        catch (error) {
            if (!isFileNotFound(error)) {
                throw error;
            }
        }
        // A bypassed pull/save echo does not need another transport reset.
        if (local?.type === vscode.FileType.File) {
            const content = await this.readFile(relPath);
            if (!this.shouldPropagate(relPath, content)) {
                return;
            }
        }
        else if (!local && !this.shouldPropagate(relPath, undefined)) {
            return;
        }
        try {
            remote = await vscode.workspace.fs.stat(remoteUri);
        }
        catch (error) {
            if (!isFileNotFound(error)) {
                throw error;
            }
        }
        let refresh = remote === undefined || (!local && remote?.type === vscode.FileType.Directory);
        if (remote?.type === vscode.FileType.File) {
            try {
                await this.vfs.readRemoteFile(remoteUri, true);
            }
            catch (error) {
                if (!isFileNotFound(error)) {
                    throw error;
                }
                refresh = true;
            }
        }
        if (refresh && !session.disposed) {
            await this.vfs.refreshRemoteSnapshot();
        }
    }
    async ensureRemoteDirectory(relPath, session) {
        let currentPath = '';
        for (const part of relPath.split('/').filter(Boolean)) {
            currentPath += '/' + part;
            const path = currentPath;
            if (session.disposed || this.remoteUpdates.hasPending(path)) { return false; }
            let task = this.remoteDirectoryTasks.get(path);
            if (!task) {
                task = (async () => {
                    const uri = this.vfs.pathToUri(path);
                    try {
                        const stat = await vscode.workspace.fs.stat(uri);
                        if (stat.type !== vscode.FileType.Directory) {
                            throw vscode.FileSystemError.FileNotADirectory(uri);
                        }
                        return true;
                    } catch (error) {
                        if (!isFileNotFound(error)) { throw error; }
                    }
                    if (session.disposed || this.remoteUpdates.hasPending(path)) { return false; }
                    await vscode.workspace.fs.createDirectory(uri);
                    if (session.disposed || this.remoteUpdates.hasPending(path)) { return false; }
                    if ((await vscode.workspace.fs.stat(uri)).type !== vscode.FileType.Directory) {
                        throw vscode.FileSystemError.FileNotADirectory(uri);
                    }
                    return true;
                })();
                this.remoteDirectoryTasks.set(path, task);
            }
            try {
                if (!await task) { return false; }
            } finally {
                if (this.remoteDirectoryTasks.get(path) === task) { this.remoteDirectoryTasks.delete(path); }
            }
        }
        return !session.disposed;
    }
    async mayPush(relPath, content, session, onlyAdd = false) {
        if (session.disposed) {
            return false;
        }
        if (this.remoteUpdates.hasPending(relPath)) {
            void this.remoteUpdates.prompt(true).catch(() => {});
            return false;
        }
        const remote = await this.freshRemoteContent(this.vfs.pathToUri(relPath));
        if (session.disposed) {
            return false;
        }
        if (sameContent(remote, content)) {
            this.baseCache[relPath] = content;
            this.setBypassCache(relPath, content);
            await this.recordSyncedState(relPath, content);
            return false;
        }
        const unchanged = remote === undefined ? !this.knownRemotePaths.has(relPath)
            : this.matchesSyncedContent(relPath, remote);
        if ((onlyAdd && remote !== undefined) || !unchanged) {
            await this.remoteUpdates.queue(relPath, remote);
            return false;
        }
        this.baseCache[relPath] = remote;
        return !this.remoteUpdates.hasPending(relPath);
    }
    async mayDeleteRemoteDirectory(relPath, session) {
        let allowed = true;
        const directories = [relPath];
        while (directories.length && !session.disposed) {
            const directory = directories.shift();
            const children = await vscode.workspace.fs.readDirectory(this.vfs.pathToUri(directory));
            for (const [name, type] of children) {
                const path = directory + '/' + name;
                if (this.matchIgnorePatterns(path)) {
                    allowed = false;
                }
                else if (type === vscode.FileType.Directory) {
                    directories.push(path);
                }
                else {
                    const remote = await this.freshRemoteContent(this.vfs.pathToUri(path));
                    if (!sameContent(remote, this.baseCache[path])) {
                        await this.remoteUpdates.queue(path, remote);
                        allowed = false;
                    }
                }
            }
        }
        return allowed && !session.disposed && !this.remoteUpdates.hasPending(relPath);
    }
    bypassSync(action, type, relPath, content) {
        // bypass ignore files
        if (this.matchIgnorePatterns(relPath)) {
            return true;
        }
        // synchronization propagation check
        if (!this.shouldPropagate(relPath, content)) {
            return true;
        }
        // otherwise, log the synchronization
        console.log(`${new Date().toLocaleString()} [${action}] ${type} "${relPath}"`);
        return false;
    }
    async applySync(action, type, relPath, fromUri, toUri, session, options = {}) {
        if (this.matchIgnorePatterns(relPath) || await this.hasLocalSymbolicLink(relPath) || session?.disposed) {
            return;
        }
        this.activeSyncs++;
        this.status = { status: action, message: `${type}: ${relPath}` };
        try {
            let stat;
            try {
                stat = await vscode.workspace.fs.stat(fromUri);
            }
            catch (error) {
                if (!isFileNotFound(error)) {
                    throw error;
                }
            }
            if (session.disposed) {
                return;
            }
            if (action === 'pull') {
                if (!stat) {
                    await this.queueRemoteDeletion(relPath, session);
                }
                else if (stat.type === vscode.FileType.Directory) {
                    await this.overwrite(relPath + '/', session);
                }
                else {
                    const remote = await this.freshRemoteContent(fromUri);
                    if (!session.disposed) {
                        await this.remoteUpdates.queue(relPath, remote);
                    }
                }
                return;
            }
            if (this.remoteUpdates.hasPending(relPath)) {
                void this.remoteUpdates.prompt(true).catch(() => {});
                return;
            }
            if (!stat) {
                if (options.onlyAdd || options.skipMissing) { return; }
                if (this.bypassSync(action, 'delete', relPath)) {
                    return;
                }
                let target;
                try {
                    target = await vscode.workspace.fs.stat(toUri);
                }
                catch (error) {
                    if (!isFileNotFound(error)) {
                        throw error;
                    }
                }
                if (target?.type === vscode.FileType.Directory) {
                    if (!await this.mayDeleteRemoteDirectory(relPath, session)) {
                        return;
                    }
                }
                else if (!await this.mayPush(relPath, undefined, session)) {
                    return;
                }
                if (session.disposed || this.remoteUpdates.hasPending(relPath)) {
                    return;
                }
                if (target) {
                    await vscode.workspace.fs.delete(toUri, { recursive: true });
                }
                for (const path of [...this.knownRemotePaths]) {
                    if (path === relPath || path.startsWith(relPath + '/')) {
                        delete this.baseCache[path];
                        await this.recordSyncedState(path, undefined);
                        this.setBypassCache(path);
                    }
                }
                delete this.baseCache[relPath];
                this.setBypassCache(relPath);
            }
            else if (stat.type === vscode.FileType.Directory) {
                try {
                    const targetStat = await vscode.workspace.fs.stat(toUri);
                    if (targetStat.type === vscode.FileType.Directory) {
                        return;
                    }
                }
                catch (error) {
                    if (!isFileNotFound(error)) {
                        throw error;
                    }
                }
                if (!session.disposed && !this.remoteUpdates.hasPending(relPath)) {
                    await this.ensureRemoteDirectory(relPath, session);
                }
            }
            else if (stat.type === vscode.FileType.File) {
                const content = await vscode.workspace.fs.readFile(fromUri);
                if (session.disposed || (options.onlyAdd && this.knownRemotePaths.has(relPath))
                    || this.bypassSync(action, 'update', relPath, content)
                    || !await this.mayPush(relPath, content, session, options.onlyAdd)) {
                    return;
                }
                // A save that changed again while checking the cloud is retried by
                // its own watcher event instead of uploading an older buffer.
                if (session.disposed || !sameContent(await this.readFile(relPath), content)
                    || this.remoteUpdates.hasPending(relPath)) {
                    return;
                }
                if (!await this.ensureRemoteDirectory(relPath.slice(0, relPath.lastIndexOf('/')), session)) {
                    return;
                }
                if (session.disposed || this.remoteUpdates.hasPending(relPath) ||
                    this.vfs.isRemoteEditorDirty?.(toUri)) {
                    return;
                }
                if (this.vfs.writeReviewedFile) {
                    const expected = options.onlyAdd ? undefined : this.baseCache[relPath];
                    await this.vfs.writeReviewedFile(toUri, content, expected,
                        () => !session.disposed && !this.remoteUpdates.hasPending(relPath) &&
                            !this.vfs.isRemoteEditorDirty?.(toUri) &&
                            sameContent(this.baseCache[relPath], expected) &&
                            (!options.onlyAdd || !this.knownRemotePaths.has(relPath)));
                } else {
                    await vscode.workspace.fs.writeFile(toUri, content);
                }
                if (session.disposed) { return; }
                const actual = await this.freshRemoteContent(toUri);
                if (!sameContent(actual, content)) {
                    if (actual !== undefined) { await this.remoteUpdates.queue(relPath, actual); }
                    throw new Error('Local Replica upload could not be verified');
                }
                if (session.disposed) {
                    return;
                }
                this.baseCache[relPath] = content;
                this.setBypassCache(relPath, content);
                await this.recordSyncedState(relPath, content);
            }
        }
        finally {
            this.activeSyncs--;
            if (!session.disposed) {
                this.remoteUpdates.updateStatus();
            }
        }
    }
    async syncFromVFS(vfsUri, type) {
        const relPath = this.relativeSyncPath(vfsUri, this.vfs.origin);
        if (relPath === undefined || vfsUri.query !== this.vfs.origin.query || this.matchIgnorePatterns(relPath)) {
            return;
        }
        const localUri = vscode.Uri.joinPath(this.baseUri, relPath);
        return this.queueSync('pull', type, relPath, vfsUri, localUri);
    }
    async syncToVFS(localUri, type, options) {
        const relPath = this.relativeSyncPath(localUri, this.baseUri);
        if (relPath === undefined || this.matchIgnorePatterns(relPath)) {
            return;
        }
        const vfsUri = this.vfs.pathToUri(relPath);
        return this.queueSync('push', type, relPath, localUri, vfsUri, options);
    }
    /**
     * Push a saved document to the VFS.
     * Only fires for explicit user saves in the editor, not for external
     * file modifications (git, compilation tools, etc.).
     * This is the general fix for issues #299 and #323.
     */
    onDocumentSaved(doc) {
        this.scheduleLocalSync(doc.uri, 'update');
    }
    async initWatch() {
        const session = { disposed: false, disposables: [] };
        this.watchSession = session;
        this.remoteUpdates = new remoteUpdateManager_1.RemoteUpdateManager(this);
        const lifecycle = new vscode.Disposable(() => {
            if (session.disposed) {
                return;
            }
            session.disposed = true;
            this.remoteUpdates.dispose();
            clearInterval(this.remotePollTimer);
            session.disposables.forEach(disposable => disposable.dispose());
            if (this.watchSession === session) {
                this.syncTimers.forEach(({ timer }) => clearTimeout(timer));
                this.syncTimers.clear();
                this.bypassCache.clear();
                this.watchSession = undefined;
                this.watchLifecycle = undefined;
                this.triggerPromise = undefined;
                this.vfsWatcher = undefined;
                this.localWatcher = undefined;
            }
        });
        this.watchLifecycle = lifecycle;
        try {
            // Keep the existing settings format when creating a new replica.
            const settingUri = vscode.Uri.joinPath(this.baseUri, '.overleaf/settings.json');
            if (await this.hasLocalSymbolicLink('/.overleaf/settings.json')) {
                throw new Error('Local Replica metadata cannot use symbolic links');
            }
            if (session.disposed) {
                return [];
            }
            try {
                await vscode.workspace.fs.stat(settingUri);
            }
            catch (error) {
                if (!isFileNotFound(error)) {
                    throw error;
                }
                if (session.disposed) {
                    return [];
                }
                await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.baseUri, '.overleaf'));
                if (session.disposed) {
                    return [];
                }
                await vscode.workspace.fs.writeFile(settingUri, Buffer.from(JSON.stringify({
                    'uri': this.vfs.origin.toString(),
                    'serverName': this.vfs.serverName,
                    'enableCompileNPreview': false,
                    'projectName': this.vfs.projectName,
                }, null, 4)));
            }
            if (session.disposed) {
                return [];
            }
            this.vfsWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.vfs.origin, '**/*'));
            session.disposables.push(this.vfsWatcher);
            this.localWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.baseUri, '**/*'));
            session.disposables.push(this.localWatcher);
            const syncOnFileChange = vscode.workspace
                .getConfiguration('overleaf-workshop.localReplica.syncOnFileChange', this.baseUri)
                .get('enabled', false);
            await this.loadSyncManifest();
            if (session.disposed) { return []; }
            session.syncOnFileChange = syncOnFileChange;
            session.disposables.push(this.vfsWatcher.onDidChange(uri => this.syncFromVFS(uri, 'update')), this.vfsWatcher.onDidCreate(uri => this.syncFromVFS(uri, 'update')), this.vfsWatcher.onDidDelete(uri => this.syncFromVFS(uri, 'delete')), vscode.workspace.onDidSaveTextDocument(doc => this.onDocumentSaved(doc)), this.localWatcher.onDidCreate(uri => this.scheduleLocalSync(uri, 'create')), this.localWatcher.onDidDelete(uri => this.scheduleLocalSync(uri, 'delete')));
            if (syncOnFileChange) {
                session.disposables.push(this.localWatcher.onDidChange(uri => this.scheduleLocalSync(uri, 'update')));
            }
            const remoteChecked = await this.overwrite('/', session);
            if (session.disposed) {
                return [];
            }
            const recoverLocalChanges = async () => {
                if (!syncOnFileChange || session.localRecovery) { return; }
                session.localRecovery = (async () => {
                    await this.reconcileLocalEdits(session);
                    await this.reconcileLocalAdditions(session);
                })();
                try { await session.localRecovery; }
                finally { session.localRecovery = undefined; }
            };
            if (remoteChecked) {
                void recoverLocalChanges().catch(() => {
                    if (!session.disposed) {
                        this.status = { status: 'need-attention', message: 'Could not check local changes; retrying automatically' };
                        console.error('Local Replica check of local changes failed; will retry');
                    }
                });
            }
            // Websocket events are immediate; the revision check repairs missed
            // events after sleep, reconnects, or a version gap.
            this.remotePollTimer = setInterval(() => {
                if (this.manualSyncEvents) { return; }
                void this.checkRemoteUpdates().then(recoverLocalChanges).catch(() => {
                    if (!session.disposed) {
                        this.remoteCheckFailed = true;
                        this.status = { status: 'need-attention', message: 'Could not check Overleaf updates; retrying automatically' };
                        console.error('Local Replica remote update check failed; will retry');
                    }
                });
            }, 60000);
            this.remotePollTimer.unref?.();
            return [lifecycle];
        }
        catch (error) {
            lifecycle.dispose();
            throw error;
        }
    }
    writeFile(relPath, content) {
        const uri = vscode.Uri.joinPath(this.baseUri, relPath);
        return vscode.workspace.fs.writeFile(uri, content);
    }
    async readFile(relPath) {
        const uri = vscode.Uri.joinPath(this.baseUri, relPath);
        try {
            return await vscode.workspace.fs.readFile(uri);
        }
        catch (error) {
            if (isFileNotFound(error)) {
                return undefined;
            }
            throw error;
        }
    }
    get triggers() {
        this.triggerPromise ?? (this.triggerPromise = this.initWatch());
        return this.triggerPromise;
    }
    dispose() {
        this.watchLifecycle?.dispose();
    }
    static get baseUriInputBox() {
        const sep = require('path').sep;
        const inputBox = vscode.window.createQuickPick();
        inputBox.placeholder = vscode.l10n.t('e.g., /home/user/empty/local/folder');
        inputBox.value = require('os').homedir() + sep;
        // enable auto-complete
        inputBox.onDidChangeValue(async (value) => {
            try {
                // remove the last part of the path
                inputBox.busy = true;
                const path = value.split(sep).slice(0, -1).join(sep);
                const items = await vscode.workspace.fs.readDirectory(vscode.Uri.file(path));
                const subDirs = items.filter(([name, type]) => type === vscode.FileType.Directory)
                    .filter(([name, type]) => `${path}${sep}${name}`.startsWith(value));
                inputBox.busy = false;
                // update the sub-directories
                if (subDirs.length !== 0) {
                    const candidates = subDirs.map(([name, type]) => ({ label: name, alwaysShow: true, picked: false }));
                    if (path !== '') {
                        candidates.unshift({ label: '..', alwaysShow: true, picked: false });
                    }
                    inputBox.items = candidates;
                }
            }
            finally {
                inputBox.activeItems = [];
            }
        });
        inputBox.onDidAccept(() => {
            if (inputBox.activeItems.length !== 0) {
                const selected = inputBox.selectedItems[0];
                const path = inputBox.value.split(sep).slice(0, -1).join(sep);
                inputBox.value = selected.label === '..' ? path : `${path}${sep}${selected.label}${sep}`;
            }
        });
        return inputBox;
    }
    get settingItems() {
        return [
            // configure ignore patterns
            {
                label: vscode.l10n.t('Configure sync ignore patterns ...'),
                callback: async () => {
                    const ignorePatterns = (this.getSetting(IGNORE_SETTING_KEY) || this.ignorePatterns).sort();
                    const quickPick = vscode.window.createQuickPick();
                    quickPick.ignoreFocusOut = true;
                    quickPick.title = vscode.l10n.t('Press Enter to add a new pattern, or click the trash icon to remove a pattern.');
                    quickPick.items = ignorePatterns.map(pattern => ({
                        label: pattern,
                        buttons: [{ iconPath: new vscode.ThemeIcon('trash') }],
                    }));
                    // remove pattern when click the trash icon
                    quickPick.onDidTriggerItemButton(async ({ item }) => {
                        const index = ignorePatterns.indexOf(item.label);
                        ignorePatterns.splice(index, 1);
                        await this.setSetting(IGNORE_SETTING_KEY, ignorePatterns);
                        quickPick.items = ignorePatterns.map(pattern => ({
                            label: pattern,
                            buttons: [{ iconPath: new vscode.ThemeIcon('trash') }],
                        }));
                    });
                    // add new pattern when not exist
                    quickPick.onDidAccept(async () => {
                        if (quickPick.selectedItems.length === 0) {
                            const pattern = quickPick.value;
                            if (pattern !== '') {
                                ignorePatterns.push(pattern);
                                await this.setSetting(IGNORE_SETTING_KEY, ignorePatterns);
                                quickPick.items = ignorePatterns.map(pattern => ({
                                    label: pattern,
                                    buttons: [{ iconPath: new vscode.ThemeIcon('trash') }],
                                }));
                                quickPick.value = '';
                            }
                        }
                    });
                    // show the quick pick
                    quickPick.show();
                },
            },
        ];
    }
    list() { return []; }
    async apply(commitItem) { return Promise.resolve(); }
    syncFromSCM(commits) { return Promise.resolve(); }
}
exports.LocalReplicaSCMProvider = LocalReplicaSCMProvider;
LocalReplicaSCMProvider.label = vscode.l10n.t('Local Replica');
