/* eslint-disable @typescript-eslint/naming-convention -- VS Code API names are fixed. */
import * as path from 'path';
import type * as vscode from 'vscode';

export class Disposable {
    private disposed = false;
    constructor(private readonly callback = () => {}) {}
    dispose() {
        if (!this.disposed) {
            this.disposed = true;
            this.callback();
        }
    }
    static from(...items: Array<{dispose(): unknown}>) {
        return new Disposable(() => items.forEach(item => item.dispose()));
    }
}

export class Uri {
    constructor(
        readonly scheme: string,
        readonly authority: string,
        readonly path: string,
        readonly query = '',
        readonly fragment = '',
    ) {}
    static file(value: string): Uri { return new Uri('file', '', path.resolve(value)); }
    static parse(value: string): Uri {
        const match = /^([\w+.-]+):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(value);
        if (!match) { throw new Error('Invalid URI'); }
        return new Uri(match[1], match[2] || '', decodeURIComponent(match[3]), match[4], match[5]);
    }
    static joinPath(base: Uri, ...parts: string[]): Uri {
        return base.with({path: path.posix.join(base.path, ...parts)});
    }
    static from(parts: {scheme: string; authority?: string; path?: string; query?: string; fragment?: string}): Uri {
        return new Uri(parts.scheme, parts.authority || '', parts.path || '', parts.query, parts.fragment);
    }
    get fsPath() { return this.path; }
    with(parts: Partial<Uri>): Uri {
        return new Uri(parts.scheme ?? this.scheme, parts.authority ?? this.authority, parts.path ?? this.path,
            parts.query ?? this.query, parts.fragment ?? this.fragment);
    }
    toString() {
        return `${this.scheme}://${this.authority}${encodeURI(this.path)}${this.query ? `?${this.query}` : ''}${this.fragment ? `#${this.fragment}` : ''}`;
    }
    toJSON() { return {scheme: this.scheme, authority: this.authority, path: this.path, query: this.query}; }
}

class Emitter<T> {
    readonly listeners = new Set<(value: T) => unknown>();
    readonly event = (callback: (value: T) => unknown) => {
        this.listeners.add(callback);
        return new Disposable(() => this.listeners.delete(callback));
    };
    fire(value: T) {
        for (const listener of this.listeners) {
            try {
                const result = listener(value);
                if (result instanceof Promise) { result.catch(error => state.errors.push(error)); }
            } catch (error) { state.errors.push(error); }
        }
    }
    dispose() { this.listeners.clear(); }
}

export class RelativePattern {
    readonly baseUri: Uri;
    constructor(base: string | Uri | {uri: Uri}, readonly pattern: string) {
        this.baseUri = typeof base === 'string' ? Uri.file(base) : 'uri' in base ? base.uri : base;
    }
    get base() { return this.baseUri.fsPath; }
}

export class Watcher extends Disposable {
    readonly change = new Emitter<Uri>();
    readonly create = new Emitter<Uri>();
    readonly delete = new Emitter<Uri>();
    readonly onDidChange = this.change.event;
    readonly onDidCreate = this.create.event;
    readonly onDidDelete = this.delete.event;
    active = true;
    constructor(readonly pattern: RelativePattern) {
        super(() => {
            this.active = false;
            this.change.dispose();
            this.create.dispose();
            this.delete.dispose();
        });
    }
    accepts(uri: Uri) { return contains(this.pattern.baseUri, uri); }
}

function contains(base: Uri, uri: Uri) {
    return base.scheme === uri.scheme && base.authority === uri.authority
        && (uri.path === base.path || uri.path.startsWith(base.path.replace(/\/$/, '') + '/'));
}
function fileKey(uri: Uri) { return `${uri.scheme}://${uri.authority}${uri.path}`; }
function missing(uri: Uri) {
    const error = new Error(`File not found: ${uri.path}`) as Error & {code: string};
    error.code = 'FileNotFound';
    return error;
}

type Entry = {type: number; data: Uint8Array};
type Operation = {type: 'write' | 'delete' | 'mkdir'; uri: Uri; data?: Uint8Array};
export const state = {
    entries: new Map<string, Entry>(),
    watchers: [] as Watcher[],
    operations: [] as Operation[],
    errors: [] as unknown[],
    warnings: [] as string[],
    config: new Map<string, unknown>(),
    folderConfig: new Map<string, Map<string, unknown>>(),
    folders: [] as Array<{uri: Uri; name: string; index: number}>,
    saved: new Emitter<{uri: Uri}>(),
    configurationChanged: new Emitter<{affectsConfiguration(section: string): boolean}>(),
    foldersChanged: new Emitter<unknown>(),
    commands: new Map<string, (...args: any[]) => unknown>(),
    commandCalls: [] as Array<{name: string; args: any[]}>,
    statusBars: [] as Array<{disposed: boolean; shows: number}>,
    decorations: [] as Array<{disposed: boolean}>,
    selectionChanged: new Emitter<any>(),
    visibleEditorsChanged: new Emitter<any>(),
    activeEditor: undefined as undefined | {document: {uri: Uri}},
    persists: {} as Record<string, any>,
    beforeWrite: undefined as undefined | ((uri: Uri, data: Uint8Array) => Promise<void>),
    beforeRead: undefined as undefined | ((uri: Uri) => Promise<void>),
};

export function reset() {
    state.watchers.forEach(watcher => watcher.dispose());
    state.entries.clear();
    state.watchers = [];
    state.operations = [];
    state.errors = [];
    state.warnings = [];
    state.config.clear();
    state.folderConfig.clear();
    state.folders = [];
    state.saved.dispose();
    state.configurationChanged.dispose();
    state.foldersChanged.dispose();
    state.commands.clear();
    state.commandCalls = [];
    state.statusBars = [];
    state.decorations = [];
    state.selectionChanged.dispose();
    state.visibleEditorsChanged.dispose();
    state.activeEditor = undefined;
    state.persists = {};
    state.beforeWrite = undefined;
    state.beforeRead = undefined;
}

export function setFolders(...folders: Uri[]) {
    state.folders = folders.map((uri, index) => ({uri, name: path.posix.basename(uri.path), index}));
}
export function seed(uri: Uri, content: string | Uint8Array = '') {
    let parent = uri.with({path: path.posix.dirname(uri.path)});
    while (parent.path !== '/') {
        if (!state.entries.has(fileKey(parent))) { state.entries.set(fileKey(parent), {type: 2, data: new Uint8Array()}); }
        parent = parent.with({path: path.posix.dirname(parent.path)});
    }
    state.entries.set(fileKey(parent), {type: 2, data: new Uint8Array()});
    state.entries.set(fileKey(uri), {type: 1, data: typeof content === 'string' ? Buffer.from(content) : content.slice()});
}
export function markSymbolicLink(uri: Uri, directory = true) {
    state.entries.set(fileKey(uri), {type: 64 | (directory ? 2 : 1), data: new Uint8Array()});
}
export function content(uri: Uri) { return Buffer.from(state.entries.get(fileKey(uri))!.data).toString(); }
export function fire(type: 'change' | 'create' | 'delete', uri: Uri) {
    for (const watcher of state.watchers) {
        if (watcher.active && watcher.accepts(uri)) { watcher[type].fire(uri); }
    }
}
export async function externalWrite(uri: Uri, value: string) {
    const existed = state.entries.has(fileKey(uri));
    seed(uri, value);
    fire(existed ? 'change' : 'create', uri);
}
export async function externalDelete(uri: Uri) {
    state.entries.delete(fileKey(uri));
    fire('delete', uri);
}
export const settle = (ms = 180) => new Promise<void>(resolve => setTimeout(resolve, ms));

const fs = {
    async stat(uri: Uri) {
        const entry = state.entries.get(fileKey(uri));
        if (!entry) { throw missing(uri); }
        return {type: entry.type, size: entry.data.length, mtime: 1, ctime: 1};
    },
    async readFile(uri: Uri) {
        await state.beforeRead?.(uri);
        const entry = state.entries.get(fileKey(uri));
        if (!entry || entry.type !== 1) { throw missing(uri); }
        return entry.data.slice();
    },
    async readDirectory(uri: Uri) {
        const prefix = fileKey(uri).replace(/\/$/, '') + '/';
        return [...state.entries].filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
            .map(([key, entry]) => [key.slice(prefix.length), entry.type]);
    },
    async writeFile(uri: Uri, data: Uint8Array) {
        await state.beforeWrite?.(uri, data);
        const existed = state.entries.has(fileKey(uri));
        seed(uri, data);
        state.operations.push({type: 'write', uri, data: data.slice()});
        fire(existed ? 'change' : 'create', uri);
    },
    async createDirectory(uri: Uri) {
        state.entries.set(fileKey(uri), {type: 2, data: new Uint8Array()});
        state.operations.push({type: 'mkdir', uri});
        fire('create', uri);
    },
    async delete(uri: Uri) {
        if (!state.entries.has(fileKey(uri))) { throw missing(uri); }
        const key = fileKey(uri);
        for (const candidate of state.entries.keys()) {
            if (candidate === key || candidate.startsWith(key + '/')) { state.entries.delete(candidate); }
        }
        state.operations.push({type: 'delete', uri});
        fire('delete', uri);
    },
};

export const mockVscode = {
    Uri, Disposable, RelativePattern,
    EventEmitter: Emitter,
    ThemeIcon: class { constructor(readonly id: string) {} },
    Range: class { constructor(..._coordinates: number[]) {} },
    DecorationRangeBehavior: {OpenClosed: 1},
    DiagnosticSeverity: {Error: 0, Warning: 1, Information: 2, Hint: 3},
    MarkdownString: class {
        supportHtml = false;
        supportThemeIcons = false;
        constructor(public value = '') {}
        appendMarkdown(value: string) { this.value += value; return this; }
    },
    FileType: {Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64},
    FileSystemError: {FileNotFound: missing},
    StatusBarAlignment: {Left: 1},
    ProgressLocation: {Notification: 15},
    QuickPickItemKind: {Separator: -1},
    l10n: {t: (value: string) => value},
    window: {
        get activeTextEditor() { return state.activeEditor; },
        showErrorMessage: async (message: string) => { state.warnings.push(message); },
        showWarningMessage: async (message: string) => { state.warnings.push(message); },
        showInformationMessage: async () => undefined,
        createStatusBarItem: () => {
            const record = {disposed: false, shows: 0};
            state.statusBars.push(record);
            return Object.assign(new Disposable(() => { record.disposed = true; }), {show() { record.shows++; }, hide() {}});
        },
        createTextEditorDecorationType: () => {
            const record = {disposed: false};
            state.decorations.push(record);
            return new Disposable(() => { record.disposed = true; });
        },
        visibleTextEditors: [],
        onDidChangeTextEditorSelection: state.selectionChanged.event,
        onDidChangeVisibleTextEditors: state.visibleEditorsChanged.event,
        registerWebviewViewProvider: () => new Disposable(),
        withProgress: (_options: unknown, callback: Function) => callback({report() {}}, {isCancellationRequested: false}),
    },
    workspace: {
        fs,
        get workspaceFolders() { return state.folders; },
        getWorkspaceFolder(uri: Uri) {
            return [...state.folders].sort((a, b) => b.uri.path.length - a.uri.path.length).find(folder => contains(folder.uri, uri));
        },
        getConfiguration(section: string, resource?: Uri) {
            const folder = resource && mockVscode.workspace.getWorkspaceFolder(resource);
            return {get<T>(key: string, fallback?: T): T {
                const fullKey = section + '.' + key;
                const scoped = folder && state.folderConfig.get(folder.uri.toString());
                return (scoped?.has(fullKey) ? scoped.get(fullKey) : state.config.has(fullKey) ? state.config.get(fullKey) : fallback) as T;
            }};
        },
        createFileSystemWatcher(pattern: RelativePattern) {
            const watcher = new Watcher(pattern);
            state.watchers.push(watcher);
            return watcher;
        },
        onDidSaveTextDocument: state.saved.event,
        onDidChangeWorkspaceFolders: state.foldersChanged.event,
        onDidChangeConfiguration: state.configurationChanged.event,
    },
    commands: {
        async executeCommand(name: string, ...args: any[]) {
            state.commandCalls.push({name, args});
            return state.commands.get(name)?.(...args);
        },
        registerCommand(name: string, callback: (...args: any[]) => unknown) {
            state.commands.set(name, callback);
            return new Disposable(() => state.commands.delete(name));
        },
    },
};

export function asUri(uri: Uri) { return uri as unknown as vscode.Uri; }

// Only external VS Code/remote integration modules are replaced. The replica,
// discovery, collection, and activation implementations execute unchanged.
export function installModuleMocks() {
    const moduleLoader = require('module') as { _load: (request: string, parent: any, isMain: boolean) => any };
    const original = moduleLoader._load;
    moduleLoader._load = function(request, parent, isMain) {
        if (request === 'vscode') { return mockVscode; }
        if (request.endsWith('/core/remoteFileSystemProvider')) {
            return {parseUri(uri: Uri) {
                const pathParts = uri.path.split('/').slice(2);
                const query = new URLSearchParams(uri.query);
                return {pathParts, projectName: uri.path.split('/')[1], serverName: uri.authority,
                    userId: query.get('user'), projectId: query.get('project')};
            }};
        }
        if (request.endsWith('/utils/globalStateManager')) {
            return {GlobalStateManager: {getServerProjectSCMPersists: () => state.persists}};
        }
        if (request === './historyViewProvider') {
            return {HistoryViewProvider: class { readonly triggers: Disposable[] = []; }};
        }
        if (request === './chatViewProvider') {
            return {ChatViewProvider: class { readonly triggers: Disposable[] = []; readonly hasUnread = 0; }};
        }
        return original.call(this, request, parent, isMain);
    };
    return () => { moduleLoader._load = original; };
}
