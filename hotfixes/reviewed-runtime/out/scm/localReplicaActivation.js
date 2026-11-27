"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LocalReplicaActivation = void 0;
const vscode = require("vscode");
const consts_1 = require("../consts");
const localReplicaSettings_1 = require("./localReplicaSettings");
const RETRY_DELAYS_MS = [1000, 3000, 8000];
const TRANSIENT_ERROR_CODES = new Set([
    'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN', 'EHOSTUNREACH',
    'ENETDOWN', 'ENETUNREACH', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET',
]);

function isTransientActivationError(error) {
    const status = error?.statusCode ?? error?.status;
    if (typeof status === 'number') {
        return status === 408 || status === 429 || status >= 500 && status <= 599;
    }
    if (TRANSIENT_ERROR_CODES.has(error?.code ?? error?.cause?.code)) {
        return true;
    }
    const message = typeof error === 'string' ? error : error?.message;
    return typeof message === 'string' && /^(?:timeout|client not handshaken|socket connection replaced|a remote (?:file|deletion) could not be checked)$/i.test(message);
}

/** Own the single local project's activation and release its watchers on workspace changes. */
class LocalReplicaActivation {
    constructor(provider) {
        this.provider = provider;
        this.disposed = false;
        this.discoveryRevision = 0;
        this.epoch = 0;
        this.initialization = Promise.resolve();
        this.warnedMultiple = false;
        this.listeners = [
            vscode.workspace.onDidChangeWorkspaceFolders(() => { void this.start(); }),
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration('overleaf-workshop.localReplica.paths')) {
                    void this.start();
                }
            }),
        ];
    }
    async start() {
        if (this.disposed) {
            return;
        }
        const revision = ++this.discoveryRevision;
        // The existing remote workspace workflow owns its own VFS and SCM collection.
        const remoteWorkspace = vscode.workspace.workspaceFolders?.some(folder => folder.uri.scheme === consts_1.ROOT_NAME);
        const replicas = remoteWorkspace ? [] : await (0, localReplicaSettings_1.discoverLocalReplicas)();
        if (this.disposed || revision !== this.discoveryRevision) {
            return;
        }
        const replica = (0, localReplicaSettings_1.selectLocalReplica)(replicas);
        if (replicas.length > 1 && !this.warnedMultiple) {
            this.warnedMultiple = true;
            void vscode.window.showWarningMessage(vscode.l10n.t('Multiple Local Replicas found. Only the first valid workspace root or configured path is active in this window.'));
        }
        const key = replica && `${(0, localReplicaSettings_1.replicaKey)(replica.baseUri)}:${replica.settings.uri}`;
        if (key === this.selectedKey) {
            return this.initialization;
        }
        const epoch = ++this.epoch;
        this.cancelRetry();
        this.release();
        this.selectedKey = key;
        this.selectedRemoteUri = replica?.settings.uri;
        if (!replica) {
            this.initialization = Promise.resolve();
            return;
        }
        // Do not serialize workspace invalidation behind a network operation.
        this.initialization = this.activate(replica, epoch);
        return this.initialization;
    }
    async activate(replica, epoch) {
        const isCurrent = () => !this.disposed && epoch === this.epoch;
        for (let attempt = 0; isCurrent(); attempt++) {
            try {
                const vfs = await this.provider.prefetch(vscode.Uri.parse(replica.settings.uri));
                if (!isCurrent()) {
                    // A newer selection of the same remote project may own this prefetched VFS.
                    if (this.disposed || this.selectedRemoteUri !== replica.settings.uri) {
                        this.provider.releaseLocalReplica(vfs);
                    }
                    return;
                }
                this.current = { vfs };
                await vfs.initLocalReplica(replica.baseUri);
                if (!isCurrent()) {
                    return;
                }
                await vscode.commands.executeCommand('setContext', `${consts_1.ROOT_NAME}.activate`, true);
                if (isCurrent()) {
                    await vscode.commands.executeCommand('setContext', `${consts_1.ROOT_NAME}.activateCompile`, replica.settings.enableCompileNPreview === true);
                }
                return;
            }
            catch (error) {
                if (!isCurrent()) {
                    return;
                }
                this.release();
                const delay = RETRY_DELAYS_MS[attempt];
                if (delay === undefined || !isTransientActivationError(error)) {
                    // Report one failure and keep remote response details out of the notification.
                    this.selectedKey = undefined;
                    void vscode.window.showErrorMessage(vscode.l10n.t('Could not activate Local Replica. Check its settings and server login.'));
                    return;
                }
                if (!await this.waitForRetry(delay)) {
                    return;
                }
            }
        }
    }
    waitForRetry(delay) {
        return new Promise(resolve => {
            const timer = setTimeout(() => {
                this.retry = undefined;
                resolve(true);
            }, delay);
            timer.unref?.();
            this.retry = { timer, resolve };
        });
    }
    cancelRetry() {
        if (!this.retry) {
            return;
        }
        clearTimeout(this.retry.timer);
        this.retry.resolve(false);
        this.retry = undefined;
    }
    release() {
        if (!this.current) {
            return;
        }
        this.provider.releaseLocalReplica(this.current.vfs);
        this.current = undefined;
        void vscode.commands.executeCommand('setContext', `${consts_1.ROOT_NAME}.activate`, false);
        void vscode.commands.executeCommand('setContext', `${consts_1.ROOT_NAME}.activateCompile`, false);
    }
    dispose() {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.epoch++;
        this.discoveryRevision++;
        this.cancelRetry();
        this.listeners.forEach(listener => listener.dispose());
        this.release();
    }
}
exports.LocalReplicaActivation = LocalReplicaActivation;
