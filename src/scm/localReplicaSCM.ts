import * as vscode from 'vscode';
import * as DiffMatchPatch from 'diff-match-patch';
import { createHash } from 'crypto';
import { minimatch } from 'minimatch';
import { BaseSCM, CommitItem, SettingItem } from ".";
import { VirtualFileSystem } from '../core/remoteFileSystemProvider';

const IGNORE_SETTING_KEY = 'ignore-patterns';

type WatchSession = {disposed: boolean, disposables: vscode.Disposable[]};

function sameContent(left?: Uint8Array, right?: Uint8Array): boolean {
    return left===right || (left!==undefined && right!==undefined
        && left.length===right.length && left.every((byte, index) => byte===right[index]));
}

function isFileNotFound(error: unknown): boolean {
    const code = (error as {code?: string})?.code;
    return code==='FileNotFound' || code==='ENOENT';
}

/**
 * A SCM which tracks exact the changes from the vfs.
 * It keeps no history versions.
 */
export class LocalReplicaSCMProvider extends BaseSCM {
    public static readonly label = vscode.l10n.t('Local Replica');

    public readonly iconPath: vscode.ThemeIcon = new vscode.ThemeIcon('folder-library');

    private bypassCache: Map<string, string|undefined> = new Map();
    private baseCache: {[key:string]: Uint8Array} = {};
    private vfsWatcher?: vscode.FileSystemWatcher;
    private localWatcher?: vscode.FileSystemWatcher;
    private watchSession?: WatchSession;
    private watchLifecycle?: vscode.Disposable;
    private triggerPromise?: Promise<vscode.Disposable[]>;
    private syncTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private syncQueues = new Map<string, Promise<void>>();
    private activeSyncs = 0;
    private ignorePatterns: string[] = [
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

    constructor(
        protected readonly vfs: VirtualFileSystem,
        public readonly baseUri: vscode.Uri,
    ) {
        super(vfs, baseUri);
    }

    private static sanitizeProjectFolderName(projectName: string): string {
        let sanitized = projectName;
        if (process.platform==='win32') {
            sanitized = projectName
                .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
                .replace(/[. ]+$/g, '');
            if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(sanitized)) {
                sanitized = `${sanitized}_`;
            }
        } else {
            sanitized = projectName.replace(/[\/\x00]/g, '_');
        }
        if (sanitized==='' || sanitized==='.' || sanitized==='..') {
            sanitized = 'untitled-project';
        }
        return sanitized;
    }

    public static async validateBaseUri(uri: string, projectName?: string): Promise<vscode.Uri> {
        try {
            let baseUri = vscode.Uri.file(uri);
            const folderName = projectName===undefined ? undefined : LocalReplicaSCMProvider.sanitizeProjectFolderName(projectName);
            // check if the path exists
            try {
                const stat = await vscode.workspace.fs.stat(baseUri);
                if (stat.type!==vscode.FileType.Directory) {
                    throw new Error('Not a folder');
                }
                // check if the project name is included in the path
                if (folderName!==undefined && !baseUri.path.endsWith(`/${folderName}`)) {
                    baseUri = vscode.Uri.joinPath(baseUri, folderName);
                }
            } catch {
                // keep the baseUri as is
            }
            // try to create the folder with `mkdirp` semantics
            await vscode.workspace.fs.createDirectory(baseUri);
            await vscode.workspace.fs.stat(baseUri);
            return baseUri;
        } catch (error) {
            vscode.window.showErrorMessage( vscode.l10n.t('Invalid Path. Please make sure the absolute path to a folder with read/write permissions is used.') );
            return Promise.reject(error);
        }
    }

    public static async pathToUri(path: string): Promise<vscode.Uri | undefined> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri;
        if (workspaceRoot===undefined || workspaceRoot?.scheme!=='file') { return undefined; }

        const settingUri = vscode.Uri.joinPath(workspaceRoot, '.overleaf/settings.json');
        try {
            await vscode.workspace.fs.stat(settingUri);
            return vscode.Uri.joinPath(workspaceRoot, path);
        } catch (error) {
            return undefined;
        }
    }

    public static async uriToPath(uri: vscode.Uri): Promise<string | undefined> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri;
        if (workspaceRoot===undefined || workspaceRoot?.scheme!=='file') { return undefined; }

        const settingUri = vscode.Uri.joinPath(workspaceRoot, '.overleaf/settings.json');
        try {
            await vscode.workspace.fs.stat(settingUri);
            return uri.path.slice(workspaceRoot.path.length);
        } catch (error) {
            return undefined;
        }
    }

    public static async readSettings(): Promise<any | undefined> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri;
        if (vscode.workspace.workspaceFolders?.length!==1 || workspaceRoot?.scheme!=='file') { return undefined; }

        const settingUri = vscode.Uri.joinPath(workspaceRoot, '.overleaf/settings.json');
        try {
            await vscode.workspace.fs.stat(settingUri);
            const content = await vscode.workspace.fs.readFile(settingUri);
            return JSON.parse( new TextDecoder().decode(content) );
        } catch (error) {
            return undefined;
        }
    }

    private matchIgnorePatterns(path: string): boolean {
        // Replica metadata must stay local even when custom patterns replace defaults.
        if (path.split('/').some(part => ['.overleaf', '.git', '.vscode'].includes(part))) {
            return true;
        }
        const ignorePatterns = this.getSetting<string[]>(IGNORE_SETTING_KEY) || this.ignorePatterns;
        for (const pattern of ignorePatterns) {
            if (minimatch(path, pattern, {dot:true})) {
                return true;
            }
        }
        return false;
    }

    private setBypassCache(relPath: string, content?: Uint8Array) {
        this.bypassCache.set(relPath, content===undefined ? undefined : createHash('sha256').update(content).digest('hex'));
    }

    private shouldPropagate(relPath: string, content?: Uint8Array): boolean {
        const fingerprint = content===undefined ? undefined : createHash('sha256').update(content).digest('hex');
        return !this.bypassCache.has(relPath) || this.bypassCache.get(relPath)!==fingerprint;
    }

    private relativeSyncPath(uri: vscode.Uri, root: vscode.Uri): string|undefined {
        if (uri.scheme!==root.scheme || uri.authority!==root.authority) { return undefined; }
        const prefix = root.path.replace(/\/+$/, '') + '/';
        if (!uri.path.startsWith(prefix) || uri.path===prefix) { return undefined; }
        const parts = uri.path.slice(prefix.length).split('/');
        if (parts.some(part => part==='.' || part==='..')) { return undefined; }
        return '/' + parts.join('/').replace(/\/+$/, '');
    }

    private async hasLocalSymbolicLink(relPath: string): Promise<boolean> {
        let uri = this.baseUri;
        for (const part of relPath.split('/').filter(Boolean)) {
            uri = vscode.Uri.joinPath(uri, part);
            try {
                if ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.SymbolicLink) {
                    return true;
                }
            } catch (error) {
                if (isFileNotFound(error)) { return false; }
                throw error;
            }
        }
        return false;
    }

    private queueSync(action: 'push'|'pull', type: 'update'|'delete', relPath: string, fromUri: vscode.Uri, toUri: vscode.Uri): Promise<void> {
        const session = this.watchSession;
        if (!session || session.disposed) { return Promise.resolve(); }
        const previous = this.syncQueues.get(relPath) ?? Promise.resolve();
        const next = previous.then(async () => {
            if (!session?.disposed) {
                await this.applySync(action, type, relPath, fromUri, toUri, session);
            }
        }).catch(() => {
            // Do not include remote error payloads, which can contain authentication data.
            console.error(`Local Replica ${action} failed: ${relPath}`);
            this.status = {status: 'need-attention', message: `${type}: ${relPath}`};
        });
        this.syncQueues.set(relPath, next);
        void next.then(() => {
            if (this.syncQueues.get(relPath)===next) { this.syncQueues.delete(relPath); }
        });
        return next;
    }

    private scheduleLocalSync(uri: vscode.Uri, type: 'update'|'delete') {
        const relPath = this.relativeSyncPath(uri, this.baseUri);
        const session = this.watchSession;
        if (!session || session.disposed || relPath===undefined || this.matchIgnorePatterns(relPath)) { return; }
        const pending = this.syncTimers.get(relPath);
        if (pending!==undefined) { clearTimeout(pending); }
        this.syncTimers.set(relPath, setTimeout(() => {
            this.syncTimers.delete(relPath);
            if (!session?.disposed) { void this.syncToVFS(uri, type); }
        }, 100));
    }

    private async overwrite(root: string='/', session?: WatchSession): Promise<boolean|undefined> {
        return await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: vscode.l10n.t('Sync Files'),
            cancellable: true,
        }, async (progress, token) => {
            // breadth-first search for the files
            const files: [string,string][] = [];
            const queue: string[] = [root];
            while (queue.length!==0) {
                if (session?.disposed) { return undefined; }
                const nextRoot = queue.shift();
                const vfsUri = this.vfs.pathToUri(nextRoot!);
                const items = await vscode.workspace.fs.readDirectory(vfsUri);
                if (token.isCancellationRequested || session?.disposed) { return undefined; }
                //
                for (const [name, type] of items) {
                    const relPath = nextRoot + name;
                    if (this.matchIgnorePatterns(relPath)) {
                        continue;
                    }
                    if (type === vscode.FileType.Directory) {
                        queue.push(relPath+'/');
                    } else {
                        files.push([name, relPath]);
                    }
                }
            }

            // sync the files
            const total = files.length;
            for (let i=0; i<total; i++) {
                const [name, relPath] = files[i];
                const vfsUri = this.vfs.pathToUri(relPath);
                if (token.isCancellationRequested || session?.disposed) { return false; }
                progress.report({increment: 100/total, message: relPath});
                //
                if (await this.hasLocalSymbolicLink(relPath)) { continue; }
                if (session?.disposed) { return false; }
                const baseContent = this.baseCache[relPath];
                const localContent = await this.readFile(relPath);
                if (session?.disposed) { return false; }
                const remoteContent = await vscode.workspace.fs.readFile(vfsUri);
                if (session?.disposed) { return false; }
                if (baseContent===undefined || localContent===undefined) {
                    this.setBypassCache(relPath, remoteContent);
                    await this.writeFile(relPath, remoteContent);
                } else {
                    const dmp = new DiffMatchPatch();
                    const baseContentStr = new TextDecoder().decode(baseContent);
                    const localContentStr = new TextDecoder().decode(localContent);
                    const remoteContentStr = new TextDecoder().decode(remoteContent);
                    // merge local and remote changes
                    const localPatches = dmp.patch_make( baseContentStr, localContentStr );
                    const remotePatches = dmp.patch_make( baseContentStr, remoteContentStr );
                    const [mergedContentStr, _results] = dmp.patch_apply( remotePatches, localContentStr );
                    // write the merged content to local
                    const mergedContent = new TextEncoder().encode(mergedContentStr);
                    await this.writeFile(relPath, mergedContent);
                    if (session?.disposed) { return false; }
                    // write the merged content to remote
                    if (localPatches.length!==0) {
                        await vscode.workspace.fs.writeFile(vfsUri, mergedContent);
                    }
                    this.setBypassCache(relPath, mergedContent);
                }
            }

            return true;
        });
    }

    private bypassSync(action:'push'|'pull', type:'update'|'delete', relPath: string, content?: Uint8Array): boolean {
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

    private async applySync(action:'push'|'pull', type: 'update'|'delete', relPath:string, fromUri: vscode.Uri, toUri: vscode.Uri, session?: WatchSession) {
        if (this.matchIgnorePatterns(relPath) || await this.hasLocalSymbolicLink(relPath) || session?.disposed) { return; }
        this.activeSyncs++;
        this.status = {status: action, message: `${type}: ${relPath}`};
        let failed = false;
        try {
            // The final on-disk state wins over event ordering (including delete/create
            // bursts produced by atomic saves). A vanished update becomes a deletion.
            let stat: vscode.FileStat|undefined;
            try {
                stat = await vscode.workspace.fs.stat(fromUri);
            } catch (error) {
                if (!isFileNotFound(error)) { throw error; }
            }
            if (session?.disposed) { return; }
            if (stat===undefined) {
                if (this.bypassSync(action, 'delete', relPath)) { return; }
                try {
                    await vscode.workspace.fs.delete(toUri, {recursive:true});
                } catch (error) {
                    if (!isFileNotFound(error)) { throw error; }
                }
                delete this.baseCache[relPath];
                for (const path of Object.keys(this.baseCache)) {
                    if (path.startsWith(relPath + '/')) { delete this.baseCache[path]; }
                }
                for (const path of this.bypassCache.keys()) {
                    if (path.startsWith(relPath + '/')) { this.bypassCache.set(path, undefined); }
                }
                this.setBypassCache(relPath);
            } else if (stat.type===vscode.FileType.Directory) {
                this.bypassCache.delete(relPath);
                try {
                    const targetStat = await vscode.workspace.fs.stat(toUri);
                    if (targetStat.type===vscode.FileType.Directory) { return; }
                } catch (error) {
                    if (!isFileNotFound(error)) { throw error; }
                }
                if (session?.disposed) { return; }
                await vscode.workspace.fs.createDirectory(toUri);
            } else if (stat.type===vscode.FileType.File) {
                const newContent = await vscode.workspace.fs.readFile(fromUri);
                if (session?.disposed || this.bypassSync(action, 'update', relPath, newContent)) { return; }
                let targetContent: Uint8Array|undefined;
                try {
                    targetContent = await vscode.workspace.fs.readFile(toUri);
                } catch (error) {
                    if (!isFileNotFound(error)) { throw error; }
                }
                if (session?.disposed) { return; }
                if (!sameContent(newContent, targetContent)) {
                    await vscode.workspace.fs.writeFile(toUri, newContent);
                }
                if (session?.disposed) { return; }
                this.baseCache[relPath] = newContent;
                this.setBypassCache(relPath, newContent);
                if (action==='push') { await vscode.workspace.fs.readFile(toUri); } // update remote cache
            }
        } catch (error) {
            failed = true;
            throw error;
        } finally {
            this.activeSyncs--;
            if (!failed && this.activeSyncs===0) { this.status = {status: 'idle', message: ''}; }
        }
    }

    private async syncFromVFS(vfsUri: vscode.Uri, type: 'update'|'delete') {
        const relPath = this.relativeSyncPath(vfsUri, this.vfs.origin);
        if (relPath===undefined || vfsUri.query!==this.vfs.origin.query || this.matchIgnorePatterns(relPath)) { return; }
        const localUri = vscode.Uri.joinPath(this.baseUri, relPath);
        await this.queueSync('pull', type, relPath, vfsUri, localUri);
    }

    private async syncToVFS(localUri: vscode.Uri, type: 'update'|'delete') {
        const relPath = this.relativeSyncPath(localUri, this.baseUri);
        if (relPath===undefined || this.matchIgnorePatterns(relPath)) { return; }
        const vfsUri = this.vfs.pathToUri(relPath);
        await this.queueSync('push', type, relPath, localUri, vfsUri);
    }

    /**
     * Push a saved document to the VFS.
     * Only fires for explicit user saves in the editor, not for external
     * file modifications (git, compilation tools, etc.).
     * This is the general fix for issues #299 and #323.
     */
    private onDocumentSaved(doc: vscode.TextDocument) {
        this.scheduleLocalSync(doc.uri, 'update');
    }

    private async initWatch() {
        const session: WatchSession = {disposed: false, disposables: []};
        this.watchSession = session;
        const lifecycle = new vscode.Disposable(() => {
            if (session.disposed) { return; }
            session.disposed = true;
            session.disposables.forEach(disposable => disposable.dispose());
            if (this.watchSession===session) {
                this.syncTimers.forEach(timer => clearTimeout(timer));
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
            if (session.disposed) { return []; }
            try {
                await vscode.workspace.fs.stat(settingUri);
            } catch (error) {
                if (!isFileNotFound(error)) { throw error; }
                if (session.disposed) { return []; }
                await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.baseUri, '.overleaf'));
                if (session.disposed) { return []; }
                await vscode.workspace.fs.writeFile(settingUri, Buffer.from(
                    JSON.stringify({
                        'uri': this.vfs.origin.toString(),
                        'serverName': this.vfs.serverName,
                        'enableCompileNPreview': false,
                        'projectName': this.vfs.projectName,
                    }, null, 4)
                ));
            }
            if (session.disposed) { return []; }
            this.vfsWatcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(this.vfs.origin, '**/*')
            );
            session.disposables.push(this.vfsWatcher);
            this.localWatcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(this.baseUri, '**/*')
            );
            session.disposables.push(this.localWatcher);
            await this.overwrite('/', session);
            if (session.disposed) { return []; }

            const syncOnFileChange = vscode.workspace
                .getConfiguration('overleaf-workshop.localReplica.syncOnFileChange', this.baseUri)
                .get<boolean>('enabled', false);

            session.disposables.push(
                this.vfsWatcher.onDidChange(uri => this.syncFromVFS(uri, 'update')),
                this.vfsWatcher.onDidCreate(uri => this.syncFromVFS(uri, 'update')),
                this.vfsWatcher.onDidDelete(uri => this.syncFromVFS(uri, 'delete')),
                vscode.workspace.onDidSaveTextDocument(doc => this.onDocumentSaved(doc)),
                this.localWatcher.onDidCreate(uri => this.scheduleLocalSync(uri, 'update')),
                this.localWatcher.onDidDelete(uri => this.scheduleLocalSync(uri, 'delete')),
            );
            if (syncOnFileChange) {
                session.disposables.push(this.localWatcher.onDidChange(uri => this.scheduleLocalSync(uri, 'update')));
            }
            return [lifecycle];
        } catch (error) {
            lifecycle.dispose();
            throw error;
        }
    }

    writeFile(relPath: string, content: Uint8Array): Thenable<void> {
        const uri = vscode.Uri.joinPath(this.baseUri, relPath);
        return vscode.workspace.fs.writeFile(uri, content);
    }

    readFile(relPath: string): Thenable<Uint8Array|undefined> {
        const uri = vscode.Uri.joinPath(this.baseUri, relPath);
        return new Promise(async (resolve, reject) => {
            try {
                const content = await vscode.workspace.fs.readFile(uri);
                resolve(content);
            } catch (error) {
                resolve(undefined);
            }
        });
    }

    get triggers(): Promise<vscode.Disposable[]> {
        this.triggerPromise ??= this.initWatch();
        return this.triggerPromise;
    }

    public dispose(): void {
        this.watchLifecycle?.dispose();
    }

    public static get baseUriInputBox(): vscode.QuickPick<vscode.QuickPickItem> {
        const sep = require('path').sep;
        const inputBox = vscode.window.createQuickPick();
        inputBox.placeholder = vscode.l10n.t('e.g., /home/user/empty/local/folder');
        inputBox.value = require('os').homedir()+sep;
        // enable auto-complete
        inputBox.onDidChangeValue(async value => {
            try {
                // remove the last part of the path
                inputBox.busy = true;
                const path = value.split(sep).slice(0, -1).join(sep);
                const items = await vscode.workspace.fs.readDirectory( vscode.Uri.file(path) );
                const subDirs = items.filter( ([name, type]) => type===vscode.FileType.Directory )
                                    .filter( ([name, type]) => `${path}${sep}${name}`.startsWith(value) );
                inputBox.busy = false;
                // update the sub-directories
                if (subDirs.length!==0) {
                    const candidates = subDirs.map(([name, type]) => ({label:name, alwaysShow:true, picked:false}));
                    if (path!=='') {
                        candidates.unshift({label:'..', alwaysShow:true, picked:false});
                    }
                    inputBox.items = candidates;
                }
            }
            finally {
                inputBox.activeItems = [];
            }
        });
        inputBox.onDidAccept(() => {
            if (inputBox.activeItems.length!==0) {
                const selected = inputBox.selectedItems[0];
                const path = inputBox.value.split(sep).slice(0, -1).join(sep);
                inputBox.value = selected.label==='..'? path : `${path}${sep}${selected.label}${sep}`;
            }
        });
        return inputBox;
    }

    get settingItems(): SettingItem[] {
        return [
            // configure ignore patterns
            {
                label: vscode.l10n.t('Configure sync ignore patterns ...'),
                callback: async () => {
                    const ignorePatterns = (this.getSetting<string[]>(IGNORE_SETTING_KEY) || this.ignorePatterns).sort();
                    const quickPick = vscode.window.createQuickPick();
                    quickPick.ignoreFocusOut = true;
                    quickPick.title = vscode.l10n.t('Press Enter to add a new pattern, or click the trash icon to remove a pattern.');
                    quickPick.items = ignorePatterns.map(pattern => ({
                        label: pattern,
                        buttons: [{iconPath: new vscode.ThemeIcon('trash')}],
                    }));
                    // remove pattern when click the trash icon
                    quickPick.onDidTriggerItemButton(async ({item}) => {
                        const index = ignorePatterns.indexOf(item.label);
                        ignorePatterns.splice(index, 1);
                        await this.setSetting(IGNORE_SETTING_KEY, ignorePatterns);
                        quickPick.items = ignorePatterns.map(pattern => ({
                            label: pattern,
                            buttons: [{iconPath: new vscode.ThemeIcon('trash')}],
                        }));
                    });
                    // add new pattern when not exist
                    quickPick.onDidAccept(async () => {
                        if (quickPick.selectedItems.length===0) {
                            const pattern = quickPick.value;
                            if (pattern!=='') {
                                ignorePatterns.push(pattern);
                                await this.setSetting(IGNORE_SETTING_KEY, ignorePatterns);
                                quickPick.items = ignorePatterns.map(pattern => ({
                                    label: pattern,
                                    buttons: [{iconPath: new vscode.ThemeIcon('trash')}],
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

    list(): Iterable<CommitItem> { return []; }
    async apply(commitItem: CommitItem): Promise<void> { return Promise.resolve(); }
    syncFromSCM(commits: Iterable<CommitItem>): Promise<void> { return Promise.resolve(); }
}
