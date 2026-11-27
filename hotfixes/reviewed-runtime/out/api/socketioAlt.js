"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SocketIOAlt = void 0;
/* eslint-disable @typescript-eslint/naming-convention */
const vscode = require("vscode");
const DiffMatchPatch = require("diff-match-patch");
const events_1 = require("events");
const consts_1 = require("../consts");
const keyHistoryRefreshInterval = `${consts_1.ROOT_NAME}.invisibleMode.historyRefreshInterval`;
const keyChatMessageRefreshInterval = `${consts_1.ROOT_NAME}.invisibleMode.chatMessageRefreshInterval`;
const keyInactiveTimeout = `${consts_1.ROOT_NAME}.invisibleMode.inactiveTimeout`;
class SyncTimer {
    constructor(_interval, _callback) {
        this._interval = _interval;
        this._callback = _callback;
        this._callback().then(() => this.trigger());
    }
    trigger() {
        this.timer = setTimeout(async () => {
            await this._callback();
            this.trigger();
        }, this._interval);
    }
    set interval(value) {
        this._interval = value;
    }
    stop() {
        this.timer && clearTimeout(this.timer);
    }
}
class SocketIOAlt {
    constructor(url, api, identity, projectId, record) {
        this.url = url;
        this.api = api;
        this.identity = identity;
        this.projectId = projectId;
        this.record = record;
        this._eventEmitter = new events_1.EventEmitter();
        this.localChangesPath = {};
        this.connectedUsers = [];
        setTimeout(async () => {
            this._eventEmitter.emit('connect');
            this._eventEmitter.emit('connectionAccepted', undefined, '');
            this._eventEmitter.emit('joinProjectResponse', '', await this.record);
        }, 10);
        this.vfsRefreshTask = new SyncTimer(this.historyRefreshInterval, this.refreshVFS.bind(this));
        this.msgRefreshTask = new SyncTimer(this.messageRefreshInterval, this.refreshMessages.bind(this));
        this.watchConfigurationsDisposable = this.watchConfigurations();
    }
    get randomEntityId() {
        return [...Array(24)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
    }
    get vfs() {
        if (this._vfs) {
            return Promise.resolve(this._vfs);
        }
        else {
            return vscode.commands.executeCommand('remoteFileSystem.prefetch', vscode.Uri.parse(this.url))
                .then(async (vfsPromise) => {
                this._vfs = await vfsPromise;
                return this._vfs;
            });
        }
    }
    get historyRefreshInterval() {
        return vscode.workspace.getConfiguration(consts_1.ROOT_NAME).get(keyHistoryRefreshInterval, 3) * 1000; //ms
    }
    get messageRefreshInterval() {
        return vscode.workspace.getConfiguration(consts_1.ROOT_NAME).get(keyChatMessageRefreshInterval, 3) * 1000; //ms
    }
    watchConfigurations() {
        return vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration(`${consts_1.ROOT_NAME}.invisibleMode.historyRefreshInterval`)) {
                this.vfsRefreshTask.interval = this.historyRefreshInterval;
            }
            if (e.affectsConfiguration(`${consts_1.ROOT_NAME}.invisibleMode.chatMessageRefreshInterval`)) {
                this.msgRefreshTask.interval = this.messageRefreshInterval;
            }
        });
    }
    async refreshVFS() {
        const vfs = await this.vfs;
        const latestVersion = await vfs.getCurrentVersion();
        if (this.vfsLocalVersion === undefined) {
            this.vfsLocalVersion = latestVersion;
        }
        if (latestVersion === this.vfsLocalVersion) {
            return;
        }
        const activeUsers = [];
        const diffs = (await vfs.getFileTreeDiff(this.vfsLocalVersion, latestVersion))?.diff;
        for (const diff of diffs || []) {
            if (diff.operation === undefined) {
                continue;
            }
            // resolve entityId
            let entityId, entity;
            try {
                const vfsUri = vfs.pathToUri(diff.pathname);
                const { fileType, fileEntity, fileId } = await vfs._resolveUri(vfsUri);
                [entityId, entity] = [fileId, fileEntity];
            }
            catch (error) {
                console.error(error);
            }
            // handle vfs update
            switch (diff.operation) {
                case 'added':
                    if (entityId !== undefined) {
                        break;
                    }
                    const pathParts = diff.pathname.split('/');
                    const [parentFolder, name] = [
                        pathParts.slice(0, pathParts.length - 1).join('/'),
                        pathParts[pathParts.length - 1]
                    ];
                    const parentFolderId = (await vfs._resolveUri(vfs.pathToUri(parentFolder))).fileId;
                    this._eventEmitter.emit('reciveNewDoc', parentFolderId, {
                        _id: this.randomEntityId,
                        name,
                        type: 'doc',
                        version: latestVersion,
                    });
                    break;
                case 'removed':
                    if (entityId === undefined) {
                        break;
                    }
                    this._eventEmitter.emit('removeEntity', entityId);
                    break;
                case 'renamed':
                    if (entityId === undefined) {
                        break;
                    }
                    const oldPathParts = diff.pathname.split('/');
                    const [oldParentPath, oldName] = [
                        oldPathParts.slice(0, oldPathParts.length - 1).join('/'),
                        oldPathParts[oldPathParts.length - 1]
                    ];
                    const newPathParts = diff.newPathname.split('/');
                    const [newParentPath, newName] = [
                        newPathParts.slice(0, newPathParts.length - 1).join('/'),
                        newPathParts[newPathParts.length - 1]
                    ];
                    // notify rename or move
                    if (oldParentPath !== newParentPath) {
                        const newParentFolderId = (await vfs._resolveUri(vfs.pathToUri(newParentPath))).fileId;
                        this._eventEmitter.emit('reciveEntityMove', entityId, newParentFolderId);
                    }
                    else {
                        this._eventEmitter.emit('reciveEntityRename', entityId, newName);
                    }
                    break;
                case 'edited':
                    if (entityId === undefined) {
                        break;
                    }
                    const pathname = diff.pathname;
                    // save doc if dirty
                    const _uri = vfs.pathToUri(pathname);
                    const _doc = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === _uri.toString());
                    if (_doc && _doc.isDirty) {
                        await _doc.save();
                    }
                    // generate patch and apply locally
                    const vfsLocalVersion = this.vfsLocalVersion;
                    const dmp = new DiffMatchPatch();
                    const localContent = new TextDecoder().decode(await vfs.openFile(_uri));
                    const baseRemoteContent = (await vfs.getFileDiff(pathname, vfsLocalVersion, vfsLocalVersion))?.diff[0].u;
                    const latestRemoteContent = (await vfs.getFileDiff(pathname, latestVersion, latestVersion))?.diff[0].u;
                    if (baseRemoteContent !== undefined && latestRemoteContent !== undefined) {
                        const patch = dmp.patch_make(baseRemoteContent, latestRemoteContent);
                        const [localContentPatched, _] = dmp.patch_apply(patch, localContent);
                        this._eventEmitter.emit('otUpdateApplied', {
                            doc: entityId,
                            v: entity.version,
                            op: [
                                { p: 0, d: localContent },
                                { p: 0, i: localContentPatched },
                            ],
                        });
                    }
                    // fetch active users
                    let row = 0, column = 0;
                    const remoteDiffs = (await vfs.getFileDiff(pathname, vfsLocalVersion, latestVersion))?.diff;
                    for (const diff of remoteDiffs || []) {
                        const end_ts = diff.meta?.end_ts || Date.now();
                        const diffText = (diff?.i || diff?.u || '').split('\n');
                        row += diffText.length;
                        column = diffText.slice(-1)[0].length;
                        for (const user of diff.meta?.users || []) {
                            const index = this.connectedUsers.findIndex(u => u.user_id === user.id);
                            if (index === -1) {
                                const userUpdate = {
                                    id: user.id, user_id: user.id, email: user.email,
                                    name: `${user.first_name} ${user.last_name || ''}`,
                                    doc_id: entityId, row, column,
                                    last_updated_at: end_ts,
                                };
                                this.connectedUsers.push(userUpdate);
                                activeUsers.push(userUpdate);
                            }
                            else {
                                this.connectedUsers[index].last_updated_at = end_ts;
                                activeUsers.push(this.connectedUsers[index]);
                            }
                        }
                    }
                    break;
                default:
                    break;
            }
        }
        // notify user update/disconnected
        activeUsers.forEach(user => {
            this._eventEmitter.emit('clientTracking.clientUpdated', user);
        });
        this.connectedUsers = this.connectedUsers.filter(user => {
            const DisconnectionTimeout = vscode.workspace.getConfiguration(consts_1.ROOT_NAME).get(keyInactiveTimeout, 180) * 1000; //ms
            const isDisconnected = Date.now() - (user.last_updated_at || Date.now()) > DisconnectionTimeout;
            if (isDisconnected) {
                this._eventEmitter.emit('clientTracking.clientDisconnected', user.id);
            }
            return !isDisconnected;
        });
        // update local version
        this.vfsLocalVersion = latestVersion;
    }
    async refreshMessages() {
        if (this.msgCache === undefined) {
            this.msgCache = (await this.api.getMessages(this.identity, this.projectId)).messages?.map(m => m.id);
        }
        else {
            let fetchNum = 2;
            let lastOldMessageId;
            let newMessages;
            // fetch messages until the last old message is found
            do {
                newMessages = (await this.api.getMessages(this.identity, this.projectId, fetchNum)).messages;
                const newMessageIds = newMessages?.map(m => m.id);
                lastOldMessageId = newMessageIds?.find(id => this.msgCache?.includes(id));
                if (lastOldMessageId === undefined) {
                    fetchNum += 2;
                    continue;
                }
                else {
                    this.msgCache = newMessageIds;
                    break;
                }
            } while (true);
            // notify new messages
            const lastOldMessageIndex = newMessages?.findIndex(m => m.id === lastOldMessageId);
            if (lastOldMessageIndex !== undefined && lastOldMessageIndex !== -1) {
                const notifyMessages = newMessages?.slice(0, lastOldMessageIndex);
                notifyMessages?.reverse().forEach(m => this._eventEmitter.emit('new-chat-message', m));
            }
        }
    }
    get unSyncedChanges() {
        return Object.keys(this.localChangesPath).length;
    }
    async uploadToVFS() {
        const vfs = await this.vfs;
        // sync remote changes
        await this.refreshVFS();
        // upload local changes
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: vscode.l10n.t('Uploading Changes'),
            cancellable: true,
        }, async (progress, token) => {
            token.onCancellationRequested(() => { });
            // do the upload
            const totalChanges = Object.keys(this.localChangesPath).length;
            let increment = 0;
            for (const [path, { parentFolderId, filename }] of Object.entries(this.localChangesPath)) {
                try {
                    const fileContent = Buffer.from(await vfs.openFile(vfs.pathToUri(path)));
                    progress.report({ increment, message: `${path}` });
                    const fileEntity = (await this.api.uploadFile(this.identity, this.projectId, parentFolderId, filename, fileContent)).entity;
                    // update local entityId
                    if (fileEntity._type === 'doc') {
                        this._eventEmitter.emit('reciveNewDoc', parentFolderId, fileEntity);
                    }
                    else if (fileEntity._type === 'file') {
                        this._eventEmitter.emit('reciveNewFile', parentFolderId, fileEntity);
                    }
                    delete this.localChangesPath[path];
                }
                catch (error) {
                    vscode.window.showErrorMessage(`${vscode.l10n.t('Failed to upload')}: ${path}`);
                }
                finally {
                    increment += 100 * (1 / totalChanges);
                }
            }
            // update local version
            this.vfsLocalVersion = await vfs.getCurrentVersion();
            return Promise.resolve();
        });
    }
    disconnect() {
        this.watchConfigurationsDisposable.dispose();
        this.vfsRefreshTask.stop();
        this.msgRefreshTask.stop();
        this._eventEmitter.emit('disconnect');
    }
    emit(event, ...parameters) {
        const args = parameters.slice(0, parameters.length - 1);
        const callback = parameters[parameters.length - 1];
        switch (event) {
            case 'joinProject':
                this.record.then((project) => {
                    callback(undefined, project);
                });
                break;
            case 'joinDoc':
                const rDocId = args[0];
                this.vfs.then(async (vfs) => {
                    await vfs.init();
                    const { path } = await vfs._resolveById(rDocId);
                    const version = this.vfsLocalVersion;
                    const content = (await vfs.getFileDiff(path.slice(1), version, version))?.diff[0].u;
                    const docLines = content?.split('\n') || [];
                    const updates = [], ranges = [];
                    callback(undefined, docLines, version, updates, ranges);
                });
                break;
            case 'applyOtUpdate':
                const uDocId = args[0];
                const update = args[1];
                if (update.op?.length) {
                    this.vfs.then(async (vfs) => {
                        await vfs.init();
                        const { parentFolder, path } = await vfs._resolveById(uDocId);
                        const parentFolderId = parentFolder._id;
                        const filename = path.slice(path.lastIndexOf('/') + 1);
                        this.localChangesPath[path.slice(1)] = { parentFolderId, filename };
                        callback(undefined, undefined);
                    });
                }
                else {
                    callback(undefined, undefined);
                }
                break;
            case 'leaveDoc':
                const wDocId = args[0];
                this.vfs.then(async (vfs) => {
                    await this.uploadToVFS();
                    callback(undefined, undefined);
                });
                break;
            case 'clientTracking.getConnectedUsers':
                callback(undefined, []);
                break;
            case 'clientTracking.updatePosition':
            default:
                callback(undefined, undefined);
                break;
        }
    }
    on(event, handler) {
        this._eventEmitter.on(event, handler);
    }
    removeAllListeners() {
        this._eventEmitter.removeAllListeners();
    }
}
exports.SocketIOAlt = SocketIOAlt;
