"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RemoteFileSystemProvider = exports.VirtualFileSystem = exports.parseUri = exports.File = void 0;
/* eslint-disable @typescript-eslint/naming-convention */
const vscode = require("vscode");
const DiffMatchPatch = require("diff-match-patch");
const consts_1 = require("../consts");
const globalStateManager_1 = require("../utils/globalStateManager");
const clientManager_1 = require("../collaboration/clientManager");
const eventBus_1 = require("../utils/eventBus");
const scmCollectionProvider_1 = require("../scm/scmCollectionProvider");
const __OUTPUTS_ID = `${consts_1.ROOT_NAME}-outputs`;
const FolderKeys = {
    'folder': 'folders',
    'doc': 'docs',
    'file': 'fileRefs',
    'outputs': 'outputs',
};
class File {
    constructor(name, type, ctime, permissions) {
        this.type = type;
        this.name = name;
        this.ctime = ctime || Date.now();
        this.mtime = Date.now();
        this.size = 0;
        this.permissions = permissions;
    }
}
exports.File = File;
function parseUri(uri) {
    const query = uri.query.split('&').reduce((acc, v) => {
        const [key, value] = v.split('=');
        return { ...acc, [key]: value };
    }, {});
    const [userId, projectId] = [query.user, query.project];
    const _pathParts = uri.path.split('/');
    const serverName = uri.authority;
    const projectName = decodeURIComponent(_pathParts[1]);
    const pathParts = _pathParts.splice(2);
    const identifier = `${userId}/${projectId}/${projectName}`;
    return { userId, projectId, serverName, projectName, identifier, pathParts };
}
exports.parseUri = parseUri;
class VirtualFileSystem extends vscode.Disposable {
    constructor(context, uri, notify) {
        // define the dispose behavior
        super(() => {
            if (this.remoteSyncDisposed) {
                return;
            }
            this.remoteSyncDisposed = true;
            clearTimeout(this.retryTimer);
            this.socket.dispose();
            // dispose all triggers of clientManager
            this.clientManagerItem?.triggers.forEach((trigger) => trigger.dispose());
            this.clientManagerItem = undefined;
            // dispose all triggers of scmCollection
            this.scmCollectionItem?.triggers.forEach((trigger) => trigger.dispose());
            this.scmCollectionItem = undefined;
        });
        this.isDirty = true;
        this.retryConnection = 0;
        /** Whether a "Reconnecting..." notification is currently shown */
        this.reconnectingNotification = false;
        /** Timestamp of last disconnect for debounce */
        this.lastDisconnectTime = 0;
        /** Whether event handlers have been registered on the current socket */
        this.handlersRegistered = false;
        this.localReplicaStopped = false;
        this.remoteSyncDisposed = false;
        this.remoteSnapshotActive = false;
        this.remoteSnapshotRequested = false;
        this.remoteDocReads = new Map();
        const { userId, projectId, serverName, projectName } = parseUri(uri);
        this.serverName = serverName;
        this.projectName = projectName;
        this.origin = uri.with({ path: '/' + projectName });
        this.userId = userId;
        this.projectId = projectId;
        this.context = context;
        this.notify = notify;
        const res = globalStateManager_1.GlobalStateManager.initSocketIOAPI(this.context, this.serverName, projectId);
        if (res) {
            this.api = res.api;
            this.socket = res.socket;
        }
        else {
            throw new Error(vscode.l10n.t('Cannot init SocketIOAPI for {serverName}', { serverName }));
        }
    }
    get _userId() {
        return this.userId;
    }
    async initLocalReplica(baseUri) {
        this.localReplicaBaseUri = baseUri;
        // A project may already have been prefetched by a command before local activation.
        if (this.root && this.scmCollectionItem) {
            this.scmCollectionItem.triggers.forEach(trigger => trigger.dispose());
            const collection = new scmCollectionProvider_1.SCMCollectionProvider(this, this.context, baseUri);
            this.scmCollectionItem = { collection, triggers: collection.triggers };
        }
        await this.init();
        await this.scmCollectionItem?.collection.ready;
    }
    stopLocalReplica() {
        this.localReplicaStopped = true;
        this.dispose();
    }
    async init() {
        if (this.remoteSyncDisposed) {
            throw new Error('Remote project is no longer active');
        }
        if (this.root) {
            return Promise.resolve(this.root);
        }
        if (!this.initializing) {
            this.initializing = this.initializingPromise;
        }
        return this.initializing;
    }
    assertRemoteFileUri(uri) {
        const prefix = this.origin.path.replace(/\/+$/, '') + '/';
        if (uri.scheme !== this.origin.scheme || uri.authority !== this.origin.authority ||
            uri.query !== this.origin.query || !uri.path.startsWith(prefix) ||
            uri.path.slice(prefix.length).split('/').some(part => !part || part === '.' || part === '..')) {
            throw new Error('Remote file path is outside the active project');
        }
    }
    isRemoteEditorDirty(uri) {
        return vscode.workspace.textDocuments.some(doc => doc.uri.toString() === uri.toString() && doc.isDirty);
    }
    snapshotEntries(project) {
        if (!project || !Array.isArray(project.rootFolder) || project.rootFolder.length !== 1 ||
            (project._id !== undefined && String(project._id) !== this.projectId)) {
            throw new Error('Invalid remote project snapshot');
        }
        const entries = new Map();
        const ids = new Set();
        const visit = (folder, prefix) => {
            if (!folder || typeof folder._id !== 'string' || !folder._id || ids.has(folder._id) ||
                !Array.isArray(folder.folders) || !Array.isArray(folder.docs) || !Array.isArray(folder.fileRefs)) {
                throw new Error('Incomplete remote project tree');
            }
            ids.add(folder._id);
            for (const [type, key] of [['folder', 'folders'], ['doc', 'docs'], ['file', 'fileRefs']]) {
                for (const entity of folder[key]) {
                    // Build outputs are managed independently by updateOutputs().
                    if (entity?._id === __OUTPUTS_ID) {
                        continue;
                    }
                    if (!entity || typeof entity._id !== 'string' || !entity._id ||
                        typeof entity.name !== 'string' || !entity.name ||
                        entity.name === '.' || entity.name === '..' || /[\/\\\x00-\x1f]/.test(entity.name)) {
                        throw new Error('Invalid remote entity path');
                    }
                    const path = prefix + entity.name;
                    if (entries.has(path) || (type !== 'folder' && ids.has(entity._id))) {
                        throw new Error('Duplicate remote entity');
                    }
                    entries.set(path, { path, type, entity, remoteCache: entity.remoteCache });
                    if (type === 'folder') {
                        visit(entity, path + '/');
                    }
                    else {
                        ids.add(entity._id);
                    }
                }
            }
        };
        visit(project.rootFolder[0], '/');
        return entries;
    }
    async fetchRemoteDoc(doc) {
        const existing = this.remoteDocReads.get(doc._id);
        if (existing) {
            return existing;
        }
        const reading = (async () => {
            const res = await this.socket.joinDoc(doc._id);
            if (!res || !Array.isArray(res.docLines) || !res.docLines.every(line => typeof line === 'string') ||
                !Number.isSafeInteger(res.version) || res.version < 0) {
                throw new Error('Invalid remote document snapshot');
            }
            return { content: res.docLines.join('\n'), version: res.version };
        })();
        this.remoteDocReads.set(doc._id, reading);
        try {
            return await reading;
        }
        finally {
            if (this.remoteDocReads.get(doc._id) === reading) {
                this.remoteDocReads.delete(doc._id);
            }
        }
    }
    async refreshRemoteSnapshot() {
        if (this.localReplicaStopped || this.remoteSyncDisposed) {
            throw new Error('Remote project is no longer active');
        }
        this.remoteSnapshotRequested = true;
        if (!this.remoteSnapshotPromise) {
            this.remoteSnapshotActive = true;
            this.remoteSnapshotPromise = (async () => {
                do {
                    this.remoteSnapshotRequested = false;
                    await this.refreshRemoteSnapshotOnce();
                } while (this.remoteSnapshotRequested && !this.localReplicaStopped && !this.remoteSyncDisposed);
                return this.root;
            })().finally(() => {
                this.remoteSnapshotActive = false;
                this.remoteSnapshotPromise = undefined;
            });
        }
        return this.remoteSnapshotPromise;
    }
    async refreshRemoteSnapshotOnce() {
        await this.init();
        const previousRoot = this.root;
        let previousEntries;
        try {
            previousEntries = this.snapshotEntries(previousRoot);
        }
        catch {
            // A missed structural event may have damaged only the cached tree.
            // Recover from the authoritative snapshot without inferring deletions
            // from an untrusted old cache.
            previousEntries = new Map();
        }
        const previousById = new Map([...previousEntries.values()].map(entry => [entry.entity._id, entry]));
        if (this.socket.isUsingAlternativeConnectionScheme) {
            // Alt.joinProject returns its old record, not an authoritative new tree.
            throw new Error('A fresh project snapshot is unavailable in Invisible Mode');
        }
        if (this.socket.scheme === 'v2') {
            const activeLocalSync = this.scmCollectionItem?.collection.scms?.some(item => item.scm?.activeSyncs > 0);
            if (this.socket.unSyncFileChanges > 0 || activeLocalSync) {
                throw new Error('Remote changes are waiting to be uploaded; retry the snapshot later');
            }
            // v2.joinProject otherwise returns the first connection's cached record.
            // Recreate only the transport; retain this VFS, SCM, and pending reviews.
            this.socket.init();
        }
        const joined = await this.socket.joinProject(this.projectId);
        this.snapshotEntries(joined);
        const previousRootId = previousRoot?.rootFolder?.[0]?._id;
        if (previousRootId && joined.rootFolder[0]._id !== previousRootId) {
            throw new Error('The remote project root changed unexpectedly');
        }
        const cloneFolder = folder => ({
            ...folder,
            docs: folder.docs.map(doc => ({ ...doc })),
            fileRefs: folder.fileRefs.map(file => ({ ...file })),
            folders: folder.folders.filter(item => item._id !== __OUTPUTS_ID).map(cloneFolder),
        });
        const nextRoot = { ...joined, rootFolder: [cloneFolder(joined.rootFolder[0])] };
        if (nextRoot.settings === undefined) {
            nextRoot.settings = previousRoot?.settings;
        }
        const nextEntries = this.snapshotEntries(nextRoot);
        for (const entry of nextEntries.values()) {
            if (entry.type !== 'doc') {
                continue;
            }
            const old = previousById.get(entry.entity._id);
            const uri = this.pathToUri(entry.path);
            const res = await this.fetchRemoteDoc(entry.entity);
            if (this.localReplicaStopped || this.remoteSyncDisposed) {
                throw new Error('Remote project is no longer active');
            }
            entry.entity.version = res.version;
            entry.entity.remoteCache = res.content;
            const preserveLocalCache = this.isRemoteEditorDirty(uri) ||
                (old && this.isRemoteEditorDirty(this.pathToUri(old.path)));
            entry.entity.localCache = preserveLocalCache ? old?.entity.localCache : res.content;
            if (old?.entity.lastVersion !== undefined) {
                entry.entity.lastVersion = old.entity.lastVersion;
            }
        }
        if (this.localReplicaStopped || this.remoteSyncDisposed) {
            throw new Error('Remote project is no longer active');
        }
        // An editor may become dirty while other documents are being fetched.
        for (const entry of nextEntries.values()) {
            const old = previousById.get(entry.entity._id);
            if (entry.type === 'doc' && old &&
                (this.isRemoteEditorDirty(this.pathToUri(entry.path)) || this.isRemoteEditorDirty(this.pathToUri(old.path)))) {
                entry.entity.localCache = old.entity.localCache;
            }
        }
        const previousFolders = previousRoot?.rootFolder?.[0]?.folders;
        const outputs = Array.isArray(previousFolders) ? previousFolders.find(folder => folder._id === __OUTPUTS_ID) : undefined;
        if (outputs) {
            nextRoot.rootFolder[0].folders.push(outputs);
        }
        const events = [];
        for (const [path, old] of previousEntries) {
            if (!nextEntries.has(path)) {
                events.push({ type: vscode.FileChangeType.Deleted, uri: this.pathToUri(path) });
            }
        }
        for (const [path, next] of nextEntries) {
            const old = previousEntries.get(path);
            if (!old) {
                events.push({ type: vscode.FileChangeType.Created, uri: this.pathToUri(path) });
            }
            else if (next.type !== old.type) {
                events.push({ type: vscode.FileChangeType.Deleted, uri: this.pathToUri(path) },
                    { type: vscode.FileChangeType.Created, uri: this.pathToUri(path) });
            }
            else if (next.type !== 'folder' && (next.type !== 'doc' || old.remoteCache === undefined ||
                old.entity._id !== next.entity._id || old.remoteCache !== next.entity.remoteCache)) {
                events.push({ type: vscode.FileChangeType.Changed, uri: this.pathToUri(path) });
            }
        }
        this.root = nextRoot;
        this.isDirty = true;
        if (events.length) {
            this.notify(events);
        }
    }
    async recoverRemoteDoc(docId) {
        try {
            const entry = this.root && this._resolveById(docId);
            if (!entry || entry.fileType !== 'doc') {
                await this.refreshRemoteSnapshot();
                return;
            }
            const uri = this.pathToUri(entry.path);
            await this.readRemoteFile(uri, true);
            if (!this.localReplicaStopped && !this.remoteSyncDisposed) {
                this.notify([{ type: vscode.FileChangeType.Changed, uri }]);
            }
        }
        catch {
            // Do not log error bodies, which can contain authentication data.
            console.warn('Remote document recovery failed; a later check will retry');
        }
    }
    get initializingPromise() {
        const MAX_RETRIES = 5;
        const BASE_DELAY_MS = 1000; // 1 second base delay
        // if retry connection exhausted, show error
        if (this.retryConnection >= MAX_RETRIES) {
            this.retryConnection = 0;
            this.initializing = undefined;
            this.reconnectingNotification = false;
            vscode.window.showErrorMessage(vscode.l10n.t('Connection lost: {serverName}', { serverName: this.serverName }), vscode.l10n.t('Reload'), vscode.l10n.t('Retry')).then((choice) => {
                if (this.remoteSyncDisposed) {
                    return;
                }
                if (choice === vscode.l10n.t('Reload')) {
                    vscode.commands.executeCommand("workbench.action.reloadWindow");
                }
                else if (choice === vscode.l10n.t('Retry')) {
                    this.retryConnection = 0;
                    this.socket.init(); // Recreate socket after all auto-reconnect attempts exhausted
                    this.initializing = this.initializingPromise;
                    this.init().catch(() => { });
                }
            });
            throw new Error(vscode.l10n.t('Connection lost'));
        }
        // exponential backoff delay: 1s, 2s, 4s, 8s, 16s
        const delayMs = this.retryConnection > 0 ? Math.min(BASE_DELAY_MS * Math.pow(2, this.retryConnection - 1), 16000) : 0;
        // Show reconnecting notification on first retry
        if (this.retryConnection === 1 && !this.reconnectingNotification) {
            this.reconnectingNotification = true;
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: vscode.l10n.t('Reconnecting to {serverName}...', { serverName: this.serverName }),
                cancellable: false,
            }, async () => {
                // Keep the notification visible while reconnecting
                await new Promise((resolve) => {
                    const check = () => {
                        if (this.remoteSyncDisposed || this.root || this.retryConnection >= MAX_RETRIES) {
                            this.reconnectingNotification = false;
                            resolve();
                        }
                        else {
                            setTimeout(check, 500);
                        }
                    };
                    check();
                });
            });
        }
        // Wait for backoff delay before retrying
        const attemptReconnect = async () => {
            if (delayMs > 0) {
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
            if (this.remoteSyncDisposed) {
                throw new Error('Remote project is no longer active');
            }
            // Only recreate the socket when the connection scheme has changed
            // (e.g., v1→v2 after connectionRejected). For transient disconnects,
            // socket.io's built-in auto-reconnect handles re-establishing the TCP
            // connection without creating a new one — avoiding TCP RST packets.
            if (this.socket.needsReinit) {
                this.socket.init();
            }
            // Register event handlers once on the current socket
            if (!this.handlersRegistered) {
                this.remoteWatch();
                this.handlersRegistered = true;
            }
            this.root = undefined;
            return this.socket.joinProject(this.projectId).then(async (project) => {
                if (this.remoteSyncDisposed) {
                    return project;
                }
                // Reset retry counter on success
                this.retryConnection = 0;
                this.reconnectingNotification = false;
                // fetch project settings
                const identity = await globalStateManager_1.GlobalStateManager.authenticate(this.context, this.serverName);
                project.settings = (await this.api.getProjectSettings(identity, this.projectId)).settings;
                if (this.remoteSyncDisposed) {
                    return project;
                }
                this.root = project;
                const activeCondition = (vscode.workspace.workspaceFolders === undefined) || (vscode.workspace.workspaceFolders?.[0].uri.scheme !== consts_1.ROOT_NAME) || (vscode.workspace.workspaceFolders?.[0].uri === this.origin);
                // Register: [collaboration] ClientManager on Statusbar
                if (activeCondition) {
                    if (this.clientManagerItem?.triggers) {
                        this.clientManagerItem.triggers.forEach((trigger) => trigger.dispose());
                        delete this.clientManagerItem;
                    }
                    const clientManager = new clientManager_1.ClientManager(this, this.context, this.publicId || '', this.socket);
                    this.clientManagerItem = {
                        manager: clientManager,
                        triggers: clientManager.triggers,
                    };
                }
                // Register: [scm] SCMCollectionProvider in explorer
                if (activeCondition) {
                    if (this.scmCollectionItem?.triggers) {
                        this.scmCollectionItem.triggers.forEach((trigger) => trigger.dispose());
                        delete this.scmCollectionItem;
                    }
                    const scmCollection = new scmCollectionProvider_1.SCMCollectionProvider(this, this.context, this.localReplicaBaseUri);
                    this.scmCollectionItem = {
                        collection: scmCollection,
                        triggers: scmCollection.triggers,
                    };
                }
                // trigger the first compile
                vscode.commands.executeCommand(`${consts_1.ROOT_NAME}.compileManager.compile`);
                return project;
            }).catch((err) => {
                if (this.remoteSyncDisposed) {
                    throw err;
                }
                this.retryConnection += 1;
                return this.initializingPromise;
            });
        };
        return attemptReconnect();
    }
    get isInvisibleMode() {
        return this.socket.isUsingAlternativeConnectionScheme;
    }
    toggleInvisibleMode() {
        // Clear disconnect debounce to prevent false retry trigger during mode switch
        this.lastDisconnectTime = 0;
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = undefined;
        }
        this.socket.toggleAlternativeConnectionScheme(this.origin.toString(), this.root);
        this.socket.disconnect(); // jump to `onDisconnected` handler
    }
    async _resolveUri(uri) {
        // resolve path
        const [parentFolder, fileName] = await (async () => {
            const { pathParts } = parseUri(uri);
            const root = await this.init();
            let currentFolder = root.rootFolder[0];
            for (let i = 0; i < pathParts.length - 1; i++) {
                const folderName = pathParts[i];
                const folder = currentFolder.folders.find((folder) => folder.name === folderName);
                if (folder) {
                    currentFolder = folder;
                }
                else {
                    throw vscode.FileSystemError.FileNotFound(uri);
                }
            }
            const fileName = pathParts[pathParts.length - 1];
            return [currentFolder, fileName];
        })();
        // resolve file
        const [fileEntity, fileType, fileId] = (() => {
            for (const _type of Object.keys(FolderKeys)) {
                let entity = parentFolder[FolderKeys[_type]]?.find((entity) => entity.name === fileName);
                if (!fileName && _type === 'folder') {
                    entity = parentFolder;
                }
                if (entity) {
                    return [entity, _type, entity._id];
                }
            }
            return [];
        })();
        return { parentFolder, fileName, fileEntity, fileType, fileId };
    }
    _resolveById(entityId, root, path) {
        if (!this.root) {
            throw vscode.FileSystemError.FileNotFound();
        }
        root = root || this.root.rootFolder[0];
        path = path || '/';
        if (root._id === entityId) {
            return { parentFolder: root, fileType: 'folder', fileEntity: root, path };
        }
        else {
            // search files in root
            for (const _type of Object.keys(FolderKeys)) {
                const key = FolderKeys[_type];
                if (key === 'folders') {
                    continue;
                }
                const entity = root[key]?.find((entity) => entity._id === entityId);
                if (entity) {
                    return { parentFolder: root, fileType: _type, fileEntity: entity, path: path + entity.name };
                }
            }
            // recursive search
            for (const folder of root.folders) {
                const res = this._resolveById(entityId, folder, path + folder.name + '/');
                if (res) {
                    return res;
                }
            }
        }
        return undefined;
    }
    walk(filter) {
        const result = [];
        const folders = this.root ? [{ entity: this.root.rootFolder[0], path: '/' }] : [];
        // apply filter to root folder
        filter(folders[0].entity) && result.push(folders[0]);
        // walk through all folders
        for (const folder of folders) {
            for (const [key, value] of Object.entries(FolderKeys)) {
                if (value === 'folders') {
                    folder.entity[value]?.forEach((entity) => {
                        folders.push({ entity, path: folder.path + entity.name + '/' });
                    });
                }
                folder.entity[value]?.forEach((entity) => {
                    entity._type = key;
                    filter(entity) && result.push({ entity, path: folder.path + entity.name });
                });
            }
            ;
        }
        return result;
    }
    insertEntity(parentFolder, fileType, entity) {
        const key = FolderKeys[fileType];
        const index = parentFolder[key]?.findIndex((e) => e._id === entity._id);
        if (index === undefined || index < 0) {
            parentFolder[key]?.push(entity);
        }
    }
    removeEntity(parentFolder, fileType, entity) {
        const key = FolderKeys[fileType];
        const index = parentFolder[key]?.findIndex((e) => e._id === entity._id);
        if (index !== undefined && index >= 0) {
            parentFolder[key]?.splice(index, 1);
            return true;
        }
        else {
            return false;
        }
    }
    removeEntityById(parentFolder, fileType, entityId, recursive) {
        const key = FolderKeys[fileType];
        const index = parentFolder[key]?.findIndex((e) => e._id === entityId);
        if (index !== undefined && index >= 0) {
            parentFolder[key]?.splice(index, 1);
            return true;
        }
        else {
            return false;
        }
    }
    remoteWatch() {
        this.socket.updateEventHandlers({
            onDisconnected: () => {
                if (this.remoteSyncDisposed) {
                    return;
                }
                if (this.remoteSnapshotActive) {
                    // A v2 snapshot deliberately recreates its transport. Its own
                    // disconnect must not rebuild the SCM or enqueue endless resets.
                    return;
                }
                if (this.root === undefined) {
                    return;
                } // bypass the first initialization
                console.log("Disconnected");
                // Debounce: ignore rapid disconnect/reconnect cycles (within 2 seconds)
                const now = Date.now();
                if (now - this.lastDisconnectTime < 2000) {
                    console.log("Disconnected: debounced (too soon since last disconnect)");
                    return;
                }
                this.lastDisconnectTime = now;
                // Clear any pending retry timer
                if (this.retryTimer) {
                    clearTimeout(this.retryTimer);
                }
                // Delay reconnection attempt slightly to allow transient issues to resolve
                this.retryTimer = setTimeout(() => {
                    if (this.localReplicaBaseUri && this.root) {
                        void this.refreshRemoteSnapshot().catch(() => {
                            console.warn('Remote snapshot refresh failed after disconnect');
                        });
                        return;
                    }
                    this.retryConnection += 1;
                    this.initializing = this.initializingPromise;
                }, 1000);
            },
            onConnectionAccepted: (publicId) => {
                this.retryConnection = 0;
                this.reconnectingNotification = false;
                this.lastDisconnectTime = 0;
                if (this.retryTimer) {
                    clearTimeout(this.retryTimer);
                    this.retryTimer = undefined;
                }
                this.publicId = publicId;
                if (this.root && !this.remoteSnapshotActive && !this.remoteSyncDisposed) {
                    void this.refreshRemoteSnapshot().catch(() => {
                        console.warn('Remote snapshot refresh failed after reconnect');
                    });
                }
            },
            onFileCreated: (parentFolderId, type, entity) => {
                if (this.remoteSnapshotActive) {
                    this.remoteSnapshotRequested = true;
                }
                const res = this._resolveById(parentFolderId);
                if (res) {
                    const { fileEntity, path } = res;
                    const entityPath = path + entity.name;
                    this.insertEntity(fileEntity, type, entity);
                    this.notify([
                        { type: vscode.FileChangeType.Created, uri: this.pathToUri(entityPath) }
                    ]);
                }
            },
            onFileRenamed: (entityId, newName) => {
                if (this.remoteSnapshotActive) {
                    this.remoteSnapshotRequested = true;
                }
                const res = this._resolveById(entityId);
                if (res) {
                    const { fileEntity } = res;
                    const oldName = fileEntity.name;
                    fileEntity.name = newName;
                    this.notify([
                        { type: vscode.FileChangeType.Deleted, uri: this.pathToUri(res.path) },
                        { type: vscode.FileChangeType.Created, uri: this.pathToUri(res.path.replace(oldName, newName)) }
                    ]);
                }
            },
            onFileRemoved: (entityId) => {
                if (this.remoteSnapshotActive) {
                    this.remoteSnapshotRequested = true;
                }
                const res = this._resolveById(entityId);
                if (res) {
                    const { parentFolder, fileType, fileEntity } = res;
                    this.removeEntity(parentFolder, fileType, fileEntity);
                    this.notify([
                        { type: vscode.FileChangeType.Deleted, uri: this.pathToUri(res.path) }
                    ]);
                }
            },
            onFileMoved: (entityId, folderId) => {
                if (this.remoteSnapshotActive) {
                    this.remoteSnapshotRequested = true;
                }
                const oldPath = this._resolveById(entityId);
                const newPath = this._resolveById(folderId);
                if (oldPath && newPath) {
                    const newParentFolder = newPath.fileEntity;
                    this.insertEntity(newParentFolder, oldPath.fileType, oldPath.fileEntity);
                    this.removeEntity(oldPath.parentFolder, oldPath.fileType, oldPath.fileEntity);
                    this.notify([
                        { type: vscode.FileChangeType.Deleted, uri: this.pathToUri(oldPath.path) },
                        { type: vscode.FileChangeType.Created, uri: this.pathToUri(newPath.path, oldPath.fileEntity.name) }
                    ]);
                }
            },
            onFileChanged: (update) => {
                if (this.localReplicaStopped || this.remoteSyncDisposed) {
                    return;
                }
                if (this.remoteSnapshotActive) {
                    this.remoteSnapshotRequested = true;
                }
                const res = this.root && this._resolveById(update.doc);
                if (!res || res.fileType !== 'doc') {
                    void this.recoverRemoteDoc(update.doc);
                    return;
                }
                const doc = res.fileEntity;
                if (update.v === doc.version && Array.isArray(update.op) && doc.remoteCache !== undefined) {
                    doc.version += 1;
                    {
                        let content = doc.remoteCache;
                        update.op.forEach((op) => {
                            if (op.i) {
                                content = content.slice(0, op.p) + op.i + content.slice(op.p);
                            }
                            else if (op.d) {
                                const deleteUtf8 = Buffer.from(op.d, 'ascii').toString('utf-8');
                                content = content.slice(0, op.p) + content.slice(op.p + deleteUtf8.length);
                            }
                        });
                        const _uri = this.pathToUri(res.path).toString();
                        const _doc = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === _uri);
                        // if doc dirty, local cache should diverge from remote cache
                        if (!_doc || !_doc.isDirty) {
                            doc.localCache = content;
                        }
                        doc.remoteCache = content;
                        this.isDirty = true;
                        this.notify([
                            { type: vscode.FileChangeType.Changed, uri: this.pathToUri(res.path) }
                        ]);
                    }
                }
                else {
                    void this.recoverRemoteDoc(update.doc);
                }
            },
            onSpellCheckLanguageUpdated: (language) => {
                if (this.root) {
                    this.root.spellCheckLanguage = language;
                    eventBus_1.EventBus.fire('spellCheckLanguageUpdateEvent', { language });
                }
            },
            onCompilerUpdated: (compiler) => {
                if (this.root) {
                    this.root.compiler = compiler;
                    eventBus_1.EventBus.fire('compilerUpdateEvent', { compiler });
                }
            },
            onRootDocUpdated: (rootDocId) => {
                //NOTE: do not sync rootDocId
                // if (this.root) {
                //     this.root.rootDoc_id = rootDocId;
                //     EventBus.fire('rootDocUpdateEvent', {rootDocId});
                // }
            },
        });
    }
    pathToUri(...path) {
        return vscode.Uri.joinPath(this.origin, ...path);
    }
    async resolve(uri) {
        const { fileName, fileEntity, fileType } = await this._resolveUri(uri);
        const readonly = fileEntity?.readonly ? vscode.FilePermission.Readonly : undefined;
        switch (fileType) {
            case undefined:
                throw vscode.FileSystemError.FileNotFound(uri);
            case 'folder':
                return new File(fileName, vscode.FileType.Directory, undefined, readonly);
            case 'file':
                if (fileEntity.linkedFileData !== null) {
                    return new File(fileName, vscode.FileType.File | vscode.FileType.SymbolicLink, Date.parse(fileEntity.created), readonly);
                }
                else {
                    return new File(fileName, vscode.FileType.File, Date.parse(fileEntity.created), readonly);
                }
            default:
                return new File(fileName, vscode.FileType.File, undefined, readonly);
        }
    }
    async list(uri) {
        const { fileEntity } = await this._resolveUri(uri);
        const folder = fileEntity;
        let results = [];
        if (folder) {
            Object.values(FolderKeys).forEach((key) => {
                const _type = key === 'folders' ? vscode.FileType.Directory : vscode.FileType.File;
                folder[key]?.forEach((entity) => {
                    results.push([entity.name, _type]);
                });
            });
        }
        return results;
    }
    async readRemoteFile(uri, fresh = false) {
        this.assertRemoteFileUri(uri);
        const { fileType, fileEntity } = await this._resolveUri(uri);
        if (!fileEntity) {
            throw vscode.FileSystemError.FileNotFound();
        }
        if (fileType === 'doc') {
            const doc = fileEntity;
            if (!fresh && doc.remoteCache !== undefined) {
                const content = doc.remoteCache;
                return new TextEncoder().encode(content);
            }
            else {
                const res = await this.fetchRemoteDoc(doc);
                if (this.localReplicaStopped || this.remoteSyncDisposed) {
                    throw new Error('Remote project is no longer active');
                }
                // An OT event can arrive between the joinDoc response and this
                // continuation. Do not replace a newer observed cache with it.
                if (Number.isSafeInteger(doc.version) && doc.version > res.version && doc.remoteCache !== undefined) {
                    return new TextEncoder().encode(doc.remoteCache);
                }
                doc.version = res.version;
                doc.remoteCache = res.content;
                if (!this.isRemoteEditorDirty(uri)) {
                    doc.localCache = res.content;
                }
                return new TextEncoder().encode(res.content);
            }
        }
        else if (fileType === 'outputs') {
            const { compileGroup, clsiServerId, pdfDownloadDomain } = this;
            return globalStateManager_1.GlobalStateManager.authenticate(this.context, this.serverName)
                .then((identity) => {
                return this.api.getFileFromClsi(identity, fileEntity.url, compileGroup || 'standard', clsiServerId, pdfDownloadDomain)
                    .then((res) => {
                    if (res.type === 'success') {
                        return res.content;
                    }
                    else {
                        return new Uint8Array(0);
                    }
                });
            });
        }
        else {
            const fileId = fileEntity._id;
            const identity = await globalStateManager_1.GlobalStateManager.authenticate(this.context, this.serverName);
            const res = await this.api.getFile(identity, this.projectId, fileId);
            if (res.type === 'success' && res.content) {
                return res.content;
            }
            else {
                throw new Error('Unable to read the remote project file');
            }
        }
    }
    async openFile(uri) {
        const content = await this.readRemoteFile(uri);
        eventBus_1.EventBus.fire('fileWillOpenEvent', { uri });
        return content;
    }
    async createFile(uri, content, overwrite, review) {
        let resolved = await this._resolveUri(uri);
        if (review) {
            this.assertReviewedRemoteState(uri, resolved, review);
        }
        let { parentFolder, fileName, fileEntity } = resolved;
        if (fileEntity && !overwrite) {
            throw vscode.FileSystemError.FileExists(uri);
        }
        let res = undefined;
        let failure;
        const identity = await globalStateManager_1.GlobalStateManager.authenticate(this.context, this.serverName);
        if (review) {
            // Authentication may yield while a create, move, or replacement event arrives.
            resolved = await this._resolveUri(uri);
            this.assertReviewedRemoteState(uri, resolved, review);
            ({ parentFolder, fileName, fileEntity } = resolved);
        }
        if (content.length === 0) {
            const _res = await this.api.addDoc(identity, this.projectId, parentFolder._id, fileName);
            if (_res.type === 'success') {
                res = _res.entity;
            }
            failure = _res;
        }
        else {
            const parentFolderId = parentFolder._id;
            const _res = await this.api.uploadFile(identity, this.projectId, parentFolderId, fileName, content);
            if (_res.type === 'success' && _res.entity !== undefined) {
                res = _res.entity;
            }
            failure = _res;
        }
        if (!res || !res._id || !['doc', 'file'].includes(res._type)) {
            const statusCode = failure?.statusCode;
            throw Object.assign(new Error(`Unable to upload "${fileName}"${statusCode ? ` (HTTP ${statusCode})` : ''}.`), {
                code: 'RemoteUploadFailed', statusCode,
            });
        }
        if (res && res._type) {
            this.insertEntity(parentFolder, res._type, res);
            this.notify([
                { type: vscode.FileChangeType.Created, uri: uri },
            ]);
        }
    }
    async refreshLinkedFile(uri) {
        const { fileType, fileEntity } = await this._resolveUri(uri);
        if (fileType === 'file' && fileEntity) {
            if (fileEntity.linkedFileData === null) {
                return;
            }
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `${vscode.l10n.t('Refreshing')} ${fileEntity.name}`,
                cancellable: true,
            }, async (progress, token) => {
                token.onCancellationRequested(() => { });
                const identity = await globalStateManager_1.GlobalStateManager.authenticate(this.context, this.serverName);
                const res = await this.api.refreshLinkedFile(identity, this.projectId, fileEntity._id);
                if (res.type === 'success' && res.message !== undefined) {
                    // refresh the entity id
                    fileEntity._id = res.message;
                    this.notify([
                        { type: vscode.FileChangeType.Changed, uri: uri },
                    ]);
                    progress.report({ message: vscode.l10n.t('Done') });
                }
                else {
                    if (res.message !== undefined) {
                        throw new Error(res.message);
                    }
                }
            });
        }
    }
    async createLinkedFile(uri) {
        const res = await this._resolveUri(uri);
        const parentFolder = res.fileType === 'folder' ? res.fileEntity : res.parentFolder;
        const supportedProviders = [
            vscode.l10n.t('From Another Project'),
            vscode.l10n.t('From External URL'),
        ];
        const selection = await vscode.window.showQuickPick(supportedProviders, {
            placeHolder: vscode.l10n.t('Import file from...'),
        });
        let provider = undefined, entityId = undefined, fileName = undefined, data = undefined;
        const identity = await globalStateManager_1.GlobalStateManager.authenticate(this.context, this.serverName);
        if (selection === vscode.l10n.t('From Another Project')) {
            provider = 'project_file';
            const allTags = (await this.api.getAllTags(identity)).tags || [];
            const projectId = await vscode.window.showQuickPick((await this.api.userProjectsJson(identity)).projects
                .filter(project => project.id !== this.projectId)
                .map(project => {
                let detail = '';
                for (const tag of allTags) {
                    if (tag.project_ids.includes(project.id)) {
                        detail += `$(tag) ${tag.name} `;
                    }
                }
                return { label: project.name, id: project.id, detail };
            }), {
                title: vscode.l10n.t('Select a Project'),
                ignoreFocusOut: true,
            });
            const filePath = projectId && await vscode.window.showQuickPick((await this.api.projectEntitiesJson(identity, projectId.id)).entities.map(entity => entity.path), {
                title: vscode.l10n.t('Select a File'),
                ignoreFocusOut: true,
            });
            fileName = filePath && await vscode.window.showInputBox({
                title: vscode.l10n.t('File Name In This Project'),
                value: filePath?.split('/').pop(),
                ignoreFocusOut: true,
                validateInput: (value) => {
                    if (value === '' || value === undefined || value.match(/^[^\/?%*:|"<>]+$/g) === null) {
                        return vscode.l10n.t('File name is empty or contains invalid characters');
                    }
                    else if (parentFolder.fileRefs.find((fileRef) => fileRef.name === value) !== undefined) {
                        return vscode.l10n.t('A file or folder with this name already exists');
                    }
                }
            });
            //
            data = { source_entity_path: filePath, source_project_id: projectId.id };
            const res = await this.api.createLinkedFile(identity, this.projectId, parentFolder._id, fileName, provider, data);
            if (res.type === 'success' && res.message !== undefined) {
                entityId = res.message;
            }
        }
        else if (selection === vscode.l10n.t('From External URL')) {
            provider = 'url';
            const url = await vscode.window.showInputBox({
                title: vscode.l10n.t('URL to fetch the file from'),
                placeHolder: 'https://example.com/my-file.png',
                ignoreFocusOut: true,
            });
            fileName = url && await vscode.window.showInputBox({
                title: vscode.l10n.t('File Name In This Project'),
                value: url?.split('/').pop(),
                ignoreFocusOut: true,
                validateInput: (value) => {
                    if (value === '' || value === undefined || value.match(/^[^\/?%*:|"<>]+$/g) === null) {
                        return vscode.l10n.t('File name is empty or contains invalid characters');
                    }
                    else if (parentFolder.fileRefs.find((fileRef) => fileRef.name === value) !== undefined) {
                        return vscode.l10n.t('A file or folder with this name already exists');
                    }
                }
            });
            //
            data = { url: url };
            const res = await this.api.createLinkedFile(identity, this.projectId, parentFolder._id, fileName, provider, data);
            if (res.type === 'success' && res.message !== undefined) {
                entityId = res.message;
            }
        }
        else {
            return;
        }
        // insert entity
        const entity = {
            _id: entityId, name: fileName, _type: 'file', readonly: false,
            linkedFileData: { provider, ...data },
            created: new Date().toISOString(),
        };
        this.insertEntity(parentFolder, 'file', entity);
        const { path } = this._resolveById(entityId);
        this.notify([
            { type: vscode.FileChangeType.Created, uri: uri.with({ path: `/${this.projectName}${path}` }) },
        ]);
    }
    remoteChanged() {
        return Object.assign(new Error('The remote file changed after it was reviewed'), { code: 'RemoteChanged' });
    }
    assertReviewedRemoteState(uri, resolved, review) {
        const { fileType, fileEntity, parentFolder } = resolved;
        if (this.localReplicaStopped || this.remoteSyncDisposed || (review.isCurrent && !review.isCurrent()) || this.isRemoteEditorDirty(uri)
            || fileType !== review.fileType || fileEntity?._id !== review.fileId
            || parentFolder?._id !== review.parentId
            || (fileType !== undefined && fileType !== 'doc' && fileType !== 'file')) {
            throw this.remoteChanged();
        }
        if (fileType === 'doc') {
            const current = typeof fileEntity.remoteCache === 'string'
                ? Buffer.from(fileEntity.remoteCache, 'utf8') : undefined;
            if (review.expected === undefined || current === undefined
                || !current.equals(review.expected) || !Number.isSafeInteger(fileEntity.version)) {
                throw this.remoteChanged();
            }
        }
        else if ((fileEntity === undefined) !== (review.expected === undefined)) {
            throw this.remoteChanged();
        }
    }
    async reviewedRemoteState(uri, expectedRemote, isCurrent) {
        this.assertRemoteFileUri(uri);
        const resolved = await this._resolveUri(uri);
        const review = {
            fileType: resolved.fileType, fileId: resolved.fileEntity?._id,
            parentId: resolved.parentFolder?._id,
            expected: expectedRemote === undefined ? undefined : Buffer.from(expectedRemote),
            isCurrent,
        };
        this.assertReviewedRemoteState(uri, resolved, review);
        if (resolved.fileEntity) {
            // Uploaded file bytes are tied to their entity id. Replacements are
            // checked by identity again after the later authentication await.
            const actual = Buffer.from(await this.readRemoteFile(uri, true));
            if (!actual.equals(review.expected)) {
                throw this.remoteChanged();
            }
            this.assertReviewedRemoteState(uri, await this._resolveUri(uri), review);
        }
        return review;
    }
    async writeReviewedFile(uri, content, expectedRemote, isCurrent) {
        try {
            const review = await this.reviewedRemoteState(uri, expectedRemote, isCurrent);
            return await this.writeFile(uri, content, true, true, review);
        }
        catch (error) {
            if (error?.code === 'FileNotFound' || error?.code === 'ENOENT') {
                throw this.remoteChanged();
            }
            throw error;
        }
    }
    async deleteReviewedFile(uri, expectedRemote, isCurrent) {
        try {
            const review = await this.reviewedRemoteState(uri, expectedRemote, isCurrent);
            return await this.remove(uri, false, review);
        }
        catch (error) {
            if (error?.code === 'FileNotFound' || error?.code === 'ENOENT') {
                throw this.remoteChanged();
            }
            throw error;
        }
    }
    async writeFile(uri, content, create, overwrite, review) {
        const resolved = await this._resolveUri(uri);
        if (review) {
            this.assertReviewedRemoteState(uri, resolved, review);
        }
        const { fileType, fileEntity } = resolved;
        // if non-exists --> create it
        if (!fileType && create) {
            return this.createFile(uri, content, true, review);
        }
        // if exists but not doc --> create new
        if (fileType && fileType !== 'doc' && create) {
            return this.createFile(uri, content, overwrite, review);
        }
        // if exists and is doc --> update
        if (fileType && fileType === 'doc' && fileEntity) {
            const doc = fileEntity;
            const _content = new TextDecoder().decode(content);
            if (doc.version === undefined || doc.localCache === undefined || doc.remoteCache === undefined) {
                return;
            }
            const dmp = new DiffMatchPatch();
            const mergeRes = review ? _content : (() => {
                const patches = dmp.patch_make(doc.localCache, doc.remoteCache);
                return dmp.patch_apply(patches, _content)[0];
            })();
            const update = {
                doc: doc._id,
                lastV: doc.lastVersion,
                v: doc.version,
                // Reference: services/web/frontend/js/vendor/libs/sharejs.js#L1288
                hash: (() => {
                    if (!doc.mtime || Date.now() - doc.mtime > 5000) {
                        doc.mtime = Date.now();
                        return require('crypto').createHash('sha1').update("blob " + mergeRes.length + "\x00" + mergeRes).digest('hex');
                    }
                })(),
                op: (() => {
                    const remoteCacheAscii = Buffer.from(doc.remoteCache, 'utf-8').toString('utf-8');
                    const mergeResAscii = Buffer.from(mergeRes, 'utf-8').toString('utf-8');
                    let currentPos = 0;
                    return dmp.diff_main(remoteCacheAscii, mergeResAscii)
                        .map((part) => {
                        // part[0] === -1: delete, 0: equal, 1: insert; part[1]: compared content
                        const incCount = part[0] === -1 ? 0 : part[1].length;
                        currentPos += incCount;
                        // add op when content not equal
                        if (part[0] !== 0) {
                            return {
                                p: currentPos - incCount,
                                i: part[0] === 1 ? part[1] : undefined,
                                d: part[0] === -1 ? part[1] : undefined,
                            };
                        }
                    })
                        .filter(x => x);
                })(),
            };
            this.isDirty = (update.op && update.op.length) ? true : false;
            await this.socket.applyOtUpdate(doc._id, update);
            doc.localCache = mergeRes;
            doc.remoteCache = mergeRes;
            setTimeout(() => {
                this.notify([
                    { type: vscode.FileChangeType.Changed, uri: uri }
                ]);
            }, 10);
            doc.lastVersion = doc.version;
        }
    }
    async mkdir(uri) {
        const { parentFolder, fileName, fileType } = await this._resolveUri(uri);
        if (fileType === 'folder') { return; }
        if (fileType) { throw vscode.FileSystemError.FileExists(uri); }
        const [folderName, parentFolderId] = [fileName, parentFolder._id];
        const identity = await globalStateManager_1.GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.addFolder(identity, this.projectId, folderName, parentFolderId);
        if (res.type === 'success' && res.entity?._id) {
            this.insertEntity(parentFolder, 'folder', res.entity);
            this.notify([
                { type: vscode.FileChangeType.Created, uri: uri },
            ]);
        }
        else {
            const statusCode = res.statusCode;
            throw Object.assign(new Error(`Unable to create remote folder "${folderName}"${statusCode ? ` (HTTP ${statusCode})` : ''}.`), {
                code: 'RemoteDirectoryCreateFailed', statusCode,
            });
        }
    }
    async remove(uri, recursive, review) {
        let resolved = await this._resolveUri(uri);
        if (review) {
            this.assertReviewedRemoteState(uri, resolved, review);
        }
        let { parentFolder, fileType, fileEntity } = resolved;
        if (fileType && fileEntity) {
            const identity = await globalStateManager_1.GlobalStateManager.authenticate(this.context, this.serverName);
            if (review) {
                resolved = await this._resolveUri(uri);
                this.assertReviewedRemoteState(uri, resolved, review);
                ({ parentFolder, fileType, fileEntity } = resolved);
            }
            const res = await this.api.deleteEntity(identity, this.projectId, fileType, fileEntity._id);
            if (res.type === 'success') {
                this.removeEntityById(parentFolder, fileType, fileEntity._id, recursive);
                this.notify([
                    { type: vscode.FileChangeType.Deleted, uri: uri },
                ]);
            }
            else {
                if (review) {
                    throw new Error('The reviewed remote deletion did not succeed');
                }
                if (res.message !== undefined) {
                    vscode.window.showErrorMessage(res.message);
                }
            }
        }
    }
    async rename(oldUri, newUri, force) {
        const oldPath = await this._resolveUri(oldUri);
        const newPath = await this._resolveUri(newUri);
        if (oldPath.fileType && oldPath.fileEntity && oldPath.fileEntity) {
            // delete existence firstly
            if (newPath.fileType && newPath.fileEntity) {
                if (!force) {
                    return;
                }
                await this.remove(newUri, true);
                this.removeEntity(newPath.parentFolder, newPath.fileType, newPath.fileEntity);
            }
            // rename or move
            let res = undefined;
            const identity = await globalStateManager_1.GlobalStateManager.authenticate(this.context, this.serverName);
            if (oldPath.parentFolder === newPath.parentFolder) {
                const [entityType, entityId, newName] = [oldPath.fileType, oldPath.fileEntity._id, newPath.fileName];
                res = await this.api.renameEntity(identity, this.projectId, entityType, entityId, newName);
            }
            else {
                const [entityType, entityId, newParentFolderId] = [oldPath.fileType, oldPath.fileEntity._id, newPath.parentFolder._id];
                res = await this.api.moveEntity(identity, this.projectId, entityType, entityId, newParentFolderId);
            }
            // update local cache
            if (res?.type === 'success') {
                const newEntity = Object.assign(oldPath.fileEntity);
                newEntity.name = newPath.fileName;
                this.removeEntity(oldPath.parentFolder, oldPath.fileType, oldPath.fileEntity);
                this.insertEntity(newPath.parentFolder, oldPath.fileType, newEntity);
                this.notify([
                    { type: vscode.FileChangeType.Deleted, uri: oldUri },
                    { type: vscode.FileChangeType.Created, uri: newUri },
                ]);
            }
            else {
                if (res?.message !== undefined) {
                    vscode.window.showErrorMessage(res.message);
                }
            }
        }
    }
    async compile(force = false, draft = false, stopOnFirstError = false, rootDocId) {
        if (force || (this.root && this.isDirty)) {
            this.isDirty = false;
            let needCacheClearFirst = false;
            try {
                await this.resolve(this.pathToUri(consts_1.OUTPUT_FOLDER_NAME, "output.log"));
            }
            catch (e) {
                needCacheClearFirst = true;
            }
            const identity = await globalStateManager_1.GlobalStateManager.authenticate(this.context, this.serverName);
            // clear cache if needed
            if (needCacheClearFirst) {
                await this.api.deleteAuxFiles(identity, this.projectId);
            }
            // compile project
            const resolvedRootDocId = rootDocId ?? this.root?.rootDoc_id ?? null;
            let rootResourcePath = null;
            if (resolvedRootDocId) {
                const rootEntry = this._resolveById(resolvedRootDocId);
                if (rootEntry?.path) {
                    rootResourcePath = rootEntry.path.replace(/^\//, '');
                }
                else {
                    console.warn(`Unable to resolve root document id '${resolvedRootDocId}' to a path; compiling without explicit rootResourcePath.`);
                }
            }
            const res = await this.api.compile(identity, this.projectId, rootResourcePath, draft, stopOnFirstError);
            if (res.type === 'success' && res.compile?.status === 'success') {
                // Store CDN download info from the response for subsequent output file requests
                this.compileGroup = res.compile.compileGroup;
                this.clsiServerId = res.compile.clsiServerId;
                this.pdfDownloadDomain = res.compile.pdfDownloadDomain;
                this.updateOutputs(res.compile.outputFiles);
                return true;
            }
            else {
                if (res.message !== undefined) {
                    console.error('Compile failure.', res.message);
                }
                return false;
            }
        }
        return Promise.resolve(undefined);
    }
    async stopCompile() {
        const identity = await globalStateManager_1.GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.stopCompile(identity, this.projectId);
        if (res.type === 'success') {
            return true;
        }
        else {
            if (res.message !== undefined) {
                vscode.window.showErrorMessage(res.message);
            }
            return false;
        }
    }
    async updateOutputs(outputs) {
        if (this.root) {
            // update output buildId
            // '/project/65dbfff719ad65b54b9eaed4/user/65094b5fa537faaba0bec01f/build/19620231e54-5372f67292889500/output/output.aux' --> 19620231e54-5372f67292889500'
            this.outputBuildId = outputs[0].url.match(/\/build\/([^\/]+)/)?.[1];
            const rootFolder = this.root.rootFolder[0];
            if (this.removeEntityById(rootFolder, 'folder', __OUTPUTS_ID)) {
                this.notify([
                    { type: vscode.FileChangeType.Deleted, uri: this.pathToUri(consts_1.OUTPUT_FOLDER_NAME) }
                ]);
            }
            this.insertEntity(rootFolder, 'folder', {
                _id: __OUTPUTS_ID,
                name: consts_1.OUTPUT_FOLDER_NAME,
                readonly: true,
                docs: [], fileRefs: [], folders: [],
                outputs: outputs.map((file) => {
                    file._id = __OUTPUTS_ID;
                    file.name = file.path;
                    file.readonly = true;
                    return file;
                })
            });
            this.notify([
                { type: vscode.FileChangeType.Created, uri: this.pathToUri(consts_1.OUTPUT_FOLDER_NAME) },
                ...(outputs.map((file) => {
                    return { type: vscode.FileChangeType.Changed, uri: this.pathToUri(consts_1.OUTPUT_FOLDER_NAME, file.path) };
                }))
            ]);
        }
    }
    async syncCode(filePath, line, column) {
        const identity = await globalStateManager_1.GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.proxySyncCode(identity, this.projectId, filePath, line, column, this.outputBuildId ?? '');
        if (res.type === 'success') {
            return res.syncCode;
        }
        else {
            if (res.message !== undefined) {
                vscode.window.showErrorMessage(res.message);
            }
            return undefined;
        }
    }
    async syncPdf(page, h, v) {
        const identity = await globalStateManager_1.GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.proxySyncPdf(identity, this.projectId, page, h, v, this.outputBuildId ?? '');
        if (res.type === 'success') {
            return res.syncPdf;
        }
        else {
            if (res.message !== undefined) {
                vscode.window.showErrorMessage(res.message);
            }
            return undefined;
        }
    }
    async spellCheck(uri, words) {
        if (this.root?.spellCheckLanguage === '') {
            return [];
        }
        const { fileType } = await this._resolveUri(uri);
        if (fileType === 'doc' || fileType === 'file') {
            const identity = await globalStateManager_1.GlobalStateManager.authenticate(this.context, this.serverName);
            const res = this.root && await this.api.proxyRequestToSpellingApi(identity, this.root.spellCheckLanguage, this.userId, words);
            if (res?.type === 'success') {
                return res.misspellings;
            }
        }
    }
    async spellLearn(word) {
        const identity = await globalStateManager_1.GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.spellingControllerLearn(identity, this.userId, word);
        if (res.type === 'success') {
            this.root?.settings.learnedWords.push(word);
            return true;
        }
        else {
            return false;
        }
    }
    async spellUnlearn(word) {
        const identity = await globalStateManager_1.GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.spellingControllerUnlearn(identity, word);
        if (res.type === 'success') {
            const index = this.root?.settings.learnedWords.findIndex((w) => w === word);
            if (index !== undefined && index >= 0) {
                this.root?.settings.learnedWords.splice(index, 1);
            }
            return true;
        }
        else {
            return false;
        }
    }
    getSpellCheckLanguage() {
        const language = this.root?.spellCheckLanguage;
        if (language === '') {
            return { name: 'Off', code: '' };
        }
        else {
            return this.root?.settings.languages.find(item => item.code === language);
        }
    }
    getAllSpellCheckLanguages() {
        return this.root?.settings.languages;
    }
    getCompiler() {
        const compiler = this.root?.compiler;
        const compilerItem = this.root?.settings.compilers.find(item => item.code === compiler);
        return compilerItem;
    }
    getAllCompilers() {
        return this.root?.settings.compilers;
    }
    getDictionary() {
        return this.root?.settings.learnedWords;
    }
    getRootDocName() {
        return this._resolveById(this.root?.rootDoc_id)?.path ?? '';
    }
    getValidMainDocs() {
        return this.walk((entity) => {
            return entity._type === 'doc' && entity.name.match(/\.tex$/g) !== null;
        });
    }
    getProjectSCMPersist(scmKey) {
        const scmPersists = globalStateManager_1.GlobalStateManager.getServerProjectSCMPersists(this.context, this.serverName, this.projectId);
        return scmPersists[scmKey];
    }
    setProjectSCMPersist(scmKey, persist) {
        globalStateManager_1.GlobalStateManager.updateServerProjectSCMPersist(this.context, this.serverName, this.projectId, scmKey, persist);
    }
    async updateSettings(setting) {
        const identity = await globalStateManager_1.GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.updateProjectSettings(identity, this.projectId, setting);
        if (res.type === 'success') {
            const keys = Object.keys(setting);
            if (keys.includes('spellCheckLanguage')) {
                this.root.spellCheckLanguage = setting.spellCheckLanguage;
            }
            if (keys.includes('compiler')) {
                this.root.compiler = setting.compiler;
            }
            if (keys.includes('rootDocId')) {
                this.root.rootDoc_id = setting.rootDocId;
            }
        }
        return res.type === 'success' ? true : false;
    }
    async metadata() {
        const identity = await globalStateManager_1.GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.getMetadata(identity, this.projectId);
        if (res.type === 'success') {
            return res.meta?.projectMeta;
        }
        else {
            return undefined;
        }
    }
    async getUpdates(before) {
        const identity = await globalStateManager_1.GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.proxyToHistoryApiAndGetUpdates(identity, this.projectId, before);
        if (res.type === 'success') {
            return res.updates;
        }
        else {
            return undefined;
        }
    }
    async getFileDiff(pathname, from, to) {
        const identity = await globalStateManager_1.GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.proxyToHistoryApiAndGetFileDiff(identity, this.projectId, pathname, from, to);
        if (res.type === 'success') {
            return res.diff;
        }
        else {
            return undefined;
        }
    }
    async getFileTreeDiff(from, to) {
        const identity = await globalStateManager_1.GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.proxyToHistoryApiAndGetFileTreeDiff(identity, this.projectId, from, to);
        if (res.type === 'success') {
            return res.treeDiff;
        }
        else {
            return undefined;
        }
    }
    async getCurrentVersion() {
        const base = this.currentVersion ?? 0;
        let lb = base;
        let rb = base + 2 ** 4;
        // firstly try: a) no update `+1`, b) one update `+2`
        const res = await this.getFileTreeDiff(base + 1, base + 1);
        if (res === undefined) {
            this.currentVersion = base;
            return base;
        }
        const res2 = await this.getFileTreeDiff(base + 2, base + 2);
        if (res2 === undefined) {
            this.currentVersion = base + 1;
            return this.currentVersion;
        }
        // locate the actual upper bound
        do {
            const res = await this.getFileTreeDiff(rb, rb);
            if (res !== undefined) {
                rb = lb + (rb - lb) * 2;
            }
            else {
                break;
            }
        } while (true);
        // binary search the current version
        while (lb < rb) {
            const mid = Math.floor((lb + rb) / 2);
            const res = await this.getFileTreeDiff(mid, mid);
            if (res !== undefined) {
                lb = mid + 1;
            }
            else {
                rb = mid;
            }
        }
        // update current version
        this.currentVersion = rb - 1;
        return this.currentVersion;
    }
    async createLabel(comment, version) {
        const identity = await globalStateManager_1.GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.createLabel(identity, this.projectId, comment, version);
        if (res.type === 'success') {
            return res.labels?.at(0);
        }
        else {
            return undefined;
        }
    }
    async deleteLabel(labelId) {
        const identity = await globalStateManager_1.GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.deleteLabel(identity, this.projectId, labelId);
        if (res.type === 'success') {
            return true;
        }
        else {
            return false;
        }
    }
    async downloadProjectArchive(version) {
        const identity = await globalStateManager_1.GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.downloadZipOfVersion(identity, this.projectId, version);
        return res.content;
    }
    async getMessages() {
        const identity = await globalStateManager_1.GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.getMessages(identity, this.projectId);
        if (res.type === 'success') {
            return res.messages;
        }
        else {
            return undefined;
        }
    }
    async sendMessage(publicId, content) {
        const identity = await globalStateManager_1.GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.sendMessage(identity, this.projectId, publicId, content);
        if (res.type === 'success') {
            return true;
        }
        else {
            return false;
        }
    }
}
exports.VirtualFileSystem = VirtualFileSystem;
class RemoteFileSystemProvider {
    constructor(context) {
        this.context = context;
        this._emitter = new vscode.EventEmitter();
        this.onDidChangeFile = this._emitter.event;
        this.context = context;
        this.vfss = new Map();
    }
    getVFS(uri) {
        const { serverName, userId, projectId } = parseUri(uri);
        const key = JSON.stringify([serverName, userId, projectId]);
        const vfs = this.vfss.get(key);
        if (vfs && !vfs.remoteSyncDisposed) {
            return Promise.resolve(vfs);
        }
        else {
            const vfs = new VirtualFileSystem(this.context, uri, this.notify.bind(this));
            this.vfss.set(key, vfs);
            return Promise.resolve(vfs);
        }
    }
    prefetch(uri) {
        return this.getVFS(uri).then((vfs) => { return vfs; });
    }
    releaseLocalReplica(vfs) {
        for (const [key, value] of this.vfss) {
            if (value === vfs) {
                this.vfss.delete(key);
            }
        }
        vfs.stopLocalReplica();
    }
    notify(events) {
        this._emitter.fire(events);
    }
    stat(uri) {
        return this.getVFS(uri).then(vfs => vfs.resolve(uri));
    }
    watch(uri, options) {
        return new vscode.Disposable(() => { });
    }
    readDirectory(uri) {
        return this.getVFS(uri).then(vfs => vfs.list(uri));
    }
    createDirectory(uri) {
        return this.getVFS(uri).then(vfs => vfs.mkdir(uri));
    }
    readFile(uri) {
        return this.getVFS(uri).then(vfs => vfs.openFile(uri));
    }
    writeFile(uri, content, options) {
        return this.getVFS(uri).then(vfs => vfs.writeFile(uri, content, options.create, options.overwrite));
    }
    delete(uri, options) {
        return this.getVFS(uri).then(vfs => vfs.remove(uri, options.recursive));
    }
    rename(oldUri, newUri, options) {
        if (oldUri.authority !== newUri.authority) {
            vscode.window.showErrorMessage(vscode.l10n.t('Cannot rename across servers'));
            return;
        }
        else {
            return this.getVFS(oldUri).then(vfs => vfs.rename(oldUri, newUri, options.overwrite));
        }
    }
    get triggers() {
        return [
            new vscode.Disposable(() => {
                this.vfss.forEach(vfs => vfs.dispose());
                this.vfss.clear();
                this._emitter.dispose();
            }),
            // register file system provider
            vscode.workspace.registerFileSystemProvider(consts_1.ROOT_NAME, this, { isCaseSensitive: true }),
            // register commands
            vscode.commands.registerCommand(`${consts_1.ROOT_NAME}.remoteFileSystem.refreshLinkedFile`, (uri) => {
                return this.prefetch(uri).then((vfs) => vfs.refreshLinkedFile(uri));
            }),
            vscode.commands.registerCommand(`${consts_1.ROOT_NAME}.remoteFileSystem.createLinkedFile`, (uri) => {
                uri = uri || vscode.workspace.workspaceFolders?.[0].uri;
                if (uri) {
                    return this.prefetch(uri).then((vfs) => vfs.createLinkedFile(uri));
                }
            }),
            vscode.commands.registerCommand('remoteFileSystem.prefetch', (uri) => {
                return this.prefetch(uri);
            }),
        ];
    }
}
exports.RemoteFileSystemProvider = RemoteFileSystemProvider;
