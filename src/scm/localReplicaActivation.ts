import * as vscode from 'vscode';
import type { RemoteFileSystemProvider, VirtualFileSystem } from '../core/remoteFileSystemProvider';
import { ROOT_NAME } from '../consts';
import { discoverLocalReplicas, replicaKey, selectLocalReplica } from './localReplicaSettings';

/** Own the single local project's activation and release its watchers on workspace changes. */
export class LocalReplicaActivation implements vscode.Disposable {
    private readonly listeners: vscode.Disposable[];
    private current?: {key: string, vfs: VirtualFileSystem};
    private disposed = false;
    private discoveryRevision = 0;
    private epoch = 0;
    private selectedKey?: string;
    private selectedRemoteUri?: string;
    private initialization: Promise<void> = Promise.resolve();
    private warnedMultiple = false;

    constructor(private readonly provider: RemoteFileSystemProvider) {
        this.listeners = [
            vscode.workspace.onDidChangeWorkspaceFolders(() => { void this.start(); }),
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration('overleaf-workshop.localReplica.paths')) { void this.start(); }
            }),
        ];
    }

    async start(): Promise<void> {
        if (this.disposed) { return; }
        const revision = ++this.discoveryRevision;
        // The existing remote workspace workflow owns its own VFS and SCM collection.
        const remoteWorkspace = vscode.workspace.workspaceFolders?.some(folder => folder.uri.scheme===ROOT_NAME);
        const replicas = remoteWorkspace ? [] : await discoverLocalReplicas();
        if (this.disposed || revision!==this.discoveryRevision) { return; }
        const replica = selectLocalReplica(replicas);
        if (replicas.length>1 && !this.warnedMultiple) {
            this.warnedMultiple = true;
            void vscode.window.showWarningMessage(vscode.l10n.t('Multiple Local Replicas found. Only the first valid workspace root or configured path is active in this window.'));
        }
        const key = replica && `${replicaKey(replica.baseUri)}:${replica.settings.uri}`;
        if (key===this.selectedKey) { return this.initialization; }
        const epoch = ++this.epoch;
        this.release();
        this.selectedKey = key;
        this.selectedRemoteUri = replica?.settings.uri;
        if (!replica) {
            this.initialization = Promise.resolve();
            return;
        }
        // Do not serialize workspace invalidation behind an unbounded network join.
        this.initialization = (async () => {
            const vfs = await this.provider.prefetch(vscode.Uri.parse(replica.settings.uri));
            if (this.disposed || epoch!==this.epoch) {
                // A newer selection of the same remote project may own this prefetched VFS.
                if (this.disposed || this.selectedRemoteUri!==replica.settings.uri) {
                    this.provider.releaseLocalReplica(vfs);
                }
                return;
            }
            this.current = {key: key!, vfs};
            await vfs.initLocalReplica(replica.baseUri);
            if (this.disposed || epoch!==this.epoch) { return; }
            await vscode.commands.executeCommand('setContext', `${ROOT_NAME}.activate`, true);
            if (this.disposed || epoch!==this.epoch) { return; }
            await vscode.commands.executeCommand('setContext', `${ROOT_NAME}.activateCompile`, replica.settings.enableCompileNPreview===true);
        })().catch(() => {
            if (this.disposed || epoch!==this.epoch) { return; }
            // Never print stored settings/URIs: errors may include authentication details.
            void vscode.window.showErrorMessage(vscode.l10n.t('Could not activate Local Replica. Check its settings and server login.'));
            this.selectedKey = undefined;
            this.release();
        });
        return this.initialization;
    }

    private release(): void {
        if (!this.current) { return; }
        this.provider.releaseLocalReplica(this.current.vfs);
        this.current = undefined;
        void vscode.commands.executeCommand('setContext', `${ROOT_NAME}.activate`, false);
        void vscode.commands.executeCommand('setContext', `${ROOT_NAME}.activateCompile`, false);
    }

    dispose(): void {
        if (this.disposed) { return; }
        this.disposed = true;
        this.epoch++;
        this.discoveryRevision++;
        this.listeners.forEach(listener => listener.dispose());
        this.release();
    }
}
