"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SocketIOAPI = void 0;
const socketioAlt_1 = require("./socketioAlt");
function decodePackedUtf8(text) {
    return Buffer.from(text, 'latin1').toString('utf-8');
}
class SocketIOAPI {
    constructor(url, api, identity, projectId) {
        this.url = url;
        this.api = api;
        this.identity = identity;
        this.projectId = projectId;
        this.disposed = false;
        this.pendingDocumentWrites = 0;
        this.scheme = 'v1';
        this._handlers = [];
        this.init();
    }
    init() {
        if (this.disposed) {
            return;
        }
        this.retireSocket();
        // connect
        switch (this.scheme) {
            case 'Alt':
                this.socket = new socketioAlt_1.SocketIOAlt(this.url, this.api, this.identity, this.projectId, this.record);
                break;
            case 'v1':
                this.record = undefined;
                this.socket = this.api._initSocketV0(this.identity);
                break;
            case 'v2':
                this.record = undefined;
                const query = `?projectId=${this.projectId}&t=${Date.now()}`;
                this.socket = this.api._initSocketV0(this.identity, query);
                break;
        }
        const socket = this.socket;
        this.emit = (event, ...args) => new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject('timeout'), 5000);
            try {
                socket.emit(event, ...args, (err, ...data) => {
                    clearTimeout(timer);
                    if (this.socket !== socket) {
                        reject(new Error('Socket connection replaced'));
                        return;
                    }
                    if (err) {
                        reject(err);
                    }
                    else {
                        resolve(data);
                    }
                });
            }
            catch (error) {
                clearTimeout(timer);
                reject(error);
            }
        });
        // resume handlers
        this.initInternalHandlers();
        // Re-register existing event handlers on the new socket
        this.resumeEventHandlers(this._handlers);
        // Track which scheme this socket was created with
        this._socketInitScheme = this.scheme;
        if (this.scheme !== 'Alt') {
            const transport = socket.socket; // The bundled client returns a Socket.IO 0.9 namespace.
            const handshake = transport.handshake;
            let handshakeAttempt = 0;
            transport.handshake = callback => {
                const attempt = ++handshakeAttempt;
                handshake.call(transport, (...args) => {
                    if (this.socket === socket && transport.connecting && attempt === handshakeAttempt) {
                        callback(...args);
                    }
                });
            };
            transport.connect();
        }
    }
    /** Returns true if the socket needs re-initialization (scheme changed, or socket was never init'd) */
    get needsReinit() {
        return !this.disposed && (this._socketInitScheme !== this.scheme || !this.socket);
    }
    stopReconnect(socket) {
        const transport = socket.socket;
        if (transport) {
            transport.options.reconnect = false;
            transport.reconnecting = false;
            clearTimeout(transport.reconnectionTimer);
        }
    }
    retireSocket() {
        const socket = this.socket;
        if (!socket) {
            return;
        }
        this.socket = undefined;
        this.stopReconnect(socket);
        socket.removeAllListeners();
        const transport = socket.socket;
        try {
            socket.disconnect();
        }
        catch {
            // Close the transport even if sending the disconnect packet fails.
            transport?.onDisconnect('booted');
        }
        finally {
            clearTimeout(transport?.connectTimeoutTimer);
            clearTimeout(transport?.heartbeatTimeoutTimer);
            transport?.removeAllListeners();
        }
    }
    initInternalHandlers() {
        this.socket.on('connect', () => {
            console.log('SocketIOAPI: connected');
        });
        this.socket.on('connect_failed', () => {
            console.log('SocketIOAPI: connect_failed');
        });
        this.socket.on('forceDisconnect', (message, delay = 10) => {
            console.log('SocketIOAPI: forceDisconnect', message);
        });
        this.socket.on('connectionRejected', (err) => {
            console.log('SocketIOAPI: connectionRejected.', err?.message || err);
            // If v2 also gets rejected, fall back to v1 rather than staying stuck
            if (this.scheme === 'v2') {
                console.log('SocketIOAPI: v2 rejected, falling back to v1');
                this.scheme = 'v1';
            }
            // Disable auto-reconnect on this socket: the server explicitly rejected
            // our connection parameters. Reconnecting would just get rejected again,
            // creating unnecessary TCP connection churn (and RST packets).
            this.stopReconnect(this.socket);
        });
        this.socket.on('error', (err) => {
            // Log error instead of throwing to avoid crashing the extension
            console.error('SocketIOAPI: socket error', err?.message || err);
        });
        if (this.scheme === 'v2') {
            this.record = new Promise(resolve => {
                this.socket.on('joinProjectResponse', (res) => {
                    const project = res.project;
                    this.record = Promise.resolve(project);
                    resolve(project);
                });
            });
        }
    }
    disconnect() {
        this.socket.disconnect();
    }
    /** Permanently release a project connection. */
    dispose() {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this._handlers = [];
        this.record = undefined;
        this.emit = () => Promise.reject(new Error('Socket connection disposed'));
        this.retireSocket();
    }
    get handlers() {
        return this._handlers;
    }
    get isUsingAlternativeConnectionScheme() {
        return this.scheme === 'Alt';
    }
    toggleAlternativeConnectionScheme(url, updatedRecord) {
        this.scheme = this.scheme === 'Alt' ? 'v1' : 'Alt';
        if (updatedRecord) {
            this.url = url;
            this.record = Promise.resolve(updatedRecord);
        }
    }
    resumeEventHandlers(handlers) {
        this._handlers = [];
        handlers.forEach((handler) => {
            this.updateEventHandlers(handler);
        });
    }
    updateEventHandlers(handlers) {
        if (this.disposed) {
            return;
        }
        this._handlers.push(handlers);
        Object.values(handlers).forEach((handler) => {
            switch (handler) {
                case handlers.onFileCreated:
                    this.socket.on('reciveNewDoc', (parentFolderId, doc) => {
                        handler(parentFolderId, 'doc', doc);
                    });
                    this.socket.on('reciveNewFile', (parentFolderId, file) => {
                        handler(parentFolderId, 'file', file);
                    });
                    this.socket.on('reciveNewFolder', (parentFolderId, folder) => {
                        handler(parentFolderId, 'folder', folder);
                    });
                    break;
                case handlers.onFileRenamed:
                    this.socket.on('reciveEntityRename', (entityId, newName) => {
                        handler(entityId, newName);
                    });
                    break;
                case handlers.onFileRemoved:
                    this.socket.on('removeEntity', (entityId) => {
                        handler(entityId);
                    });
                    break;
                case handlers.onFileMoved:
                    this.socket.on('reciveEntityMove', (entityId, folderId) => {
                        handler(entityId, folderId);
                    });
                    break;
                case handlers.onFileChanged:
                    this.socket.on('otUpdateApplied', (update) => {
                        handler(update);
                    });
                    break;
                case handlers.onDisconnected:
                    this.socket.on('disconnect', () => {
                        handler();
                    });
                    break;
                case handlers.onConnectionAccepted:
                    this.socket.on('connectionAccepted', (_, publicId) => {
                        handler(publicId);
                    });
                    if (this.scheme === 'v2') {
                        this.socket.on('joinProjectResponse', res => handler(res.publicId));
                    }
                    break;
                case handlers.onClientUpdated:
                    this.socket.on('clientTracking.clientUpdated', (user) => {
                        handler(user);
                    });
                    break;
                case handlers.onClientDisconnected:
                    this.socket.on('clientTracking.clientDisconnected', (id) => {
                        handler(id);
                    });
                    break;
                case handlers.onReceivedMessage:
                    this.socket.on('new-chat-message', (message) => {
                        handler(message);
                    });
                    break;
                case handlers.onSpellCheckLanguageUpdated:
                    this.socket.on('spellCheckLanguageUpdated', (language) => {
                        handler(language);
                    });
                    break;
                case handlers.onCompilerUpdated:
                    this.socket.on('compilerUpdated', (compiler) => {
                        handler(compiler);
                    });
                    break;
                case handlers.onRootDocUpdated:
                    this.socket.on('rootDocUpdated', (rootDocId) => {
                        handler(rootDocId);
                    });
                    break;
                default:
                    break;
            }
        });
    }
    get unSyncFileChanges() {
        if (this.socket instanceof socketioAlt_1.SocketIOAlt) {
            return this.socket.unSyncedChanges;
        }
        return 0;
    }
    async syncFileChanges() {
        if (this.socket instanceof socketioAlt_1.SocketIOAlt) {
            return await this.socket.uploadToVFS();
        }
    }
    /**
     * Reference: services/web/frontend/js/ide/connection/ConnectionManager.js#L427
     * @param {string} projectId - The project id.
     * @returns {Promise}
     */
    async joinProject(project_id) {
        const socket = this.socket;
        if (!socket) {
            throw new Error('Socket connection disposed');
        }
        if (this.scheme === 'v2') {
            let timer;
            const timeout = new Promise((_, reject) => {
                timer = setTimeout(() => reject('timeout'), 5000);
            });
            try {
                return await Promise.race([this.record, timeout]);
            }
            finally {
                clearTimeout(timer);
            }
        }
        if (this.scheme === 'Alt') {
            const [project] = await this.emit('joinProject', { project_id });
            return project;
        }
        let onRejected;
        const rejected = new Promise((_, reject) => {
            onRejected = err => {
                this.scheme = 'v2';
                reject(err?.message || 'Project connection rejected');
            };
            socket.on('connectionRejected', onRejected);
        });
        try {
            const [project] = await Promise.race([this.emit('joinProject', { project_id }), rejected]);
            if (this.socket === socket) {
                this.record = Promise.resolve(project);
            }
            return project;
        }
        finally {
            socket.removeListener('connectionRejected', onRejected);
        }
    }
    /**
     * Reference: services/web/frontend/js/ide/editor/Document.js#L500
     * @param {string} docId - The document id.
     * @returns {Promise}
     */
    async joinDoc(docId) {
        return this.emit('joinDoc', docId, { encodeRanges: true })
            .then((returns) => {
            const [docLinesAscii, version, updates, ranges] = returns;
            const docLines = docLinesAscii.map((line) => decodePackedUtf8(line));
            return { docLines, version, updates, ranges };
        });
    }
    /**
     * Reference: services/web/frontend/js/ide/editor/Document.js#L591
     * @param {string} docId - The document id.
     * @returns {Promise}
     */
    async leaveDoc(docId) {
        return this.emit('leaveDoc', docId)
            .then(() => {
            return;
        });
    }
    /**
     * Reference: services/web/frontend/js/ide/editor/ShareJsDocs.js#L78
     * @param {string} docId - The document id.
     * @param {any} update - The changes.
     * @returns {Promise}
     */
    async applyOtUpdate(docId, update) {
        this.pendingDocumentWrites++;
        try {
            await this.emit('applyOtUpdate', docId, update);
        }
        finally {
            this.pendingDocumentWrites--;
        }
    }
    /**
     * Reference: services/web/frontend/js/ide/online-users/OnlineUserManager.js#L42
     * @returns {Promise}
     */
    async getConnectedUsers() {
        return this.emit('clientTracking.getConnectedUsers')
            .then((returns) => {
            const [connectedUsers] = returns;
            return connectedUsers;
        });
    }
    /**
     * Reference: services/web/frontend/js/ide/online-users/OnlineUserManager.js#L150
     * @param {string} docId - The document id.
     * @returns {Promise}
     */
    async updatePosition(doc_id, row, column) {
        return this.emit('clientTracking.updatePosition', { row, column, doc_id })
            .then(() => {
            return;
        });
    }
}
exports.SocketIOAPI = SocketIOAPI;
