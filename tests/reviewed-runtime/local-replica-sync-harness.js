"use strict";

// In-memory VS Code host for the staged Local Replica code. No installed
// extension, network endpoint, or real project file is modified by these tests.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

const FILE = 1;
const DIRECTORY = 2;
const SYMBOLIC_LINK = 64;

class Uri {
    constructor(scheme, authority, pathname, query = "", fragment = "") {
        Object.assign(this, { scheme, authority, path: pathname, query, fragment });
    }
    static file(value) {
        const pathname = path.resolve(value).split(path.sep).join("/");
        return new Uri("file", "", pathname.startsWith("/") ? pathname : "/" + pathname);
    }
    static from(value) { return new Uri(value.scheme, value.authority ?? "", value.path ?? "", value.query ?? "", value.fragment ?? ""); }
    static parse(value) {
        const parsed = new URL(value);
        return new Uri(parsed.protocol.slice(0, -1), parsed.host,
            decodeURIComponent(parsed.pathname), parsed.search.slice(1), parsed.hash.slice(1));
    }
    static joinPath(base, ...parts) {
        return base.with({ path: path.posix.join(base.path, ...parts) });
    }
    with(changes) {
        return new Uri(changes.scheme ?? this.scheme, changes.authority ?? this.authority,
            changes.path ?? this.path, changes.query ?? this.query, changes.fragment ?? this.fragment);
    }
    get fsPath() { return this.path; }
    toString() {
        return `${this.scheme}://${this.authority}${encodeURI(this.path)}${this.query ? `?${this.query}` : ""}${this.fragment ? `#${this.fragment}` : ""}`;
    }
    toJSON() { return this.toString(); }
}

class Disposable {
    constructor(callback = () => {}) { this.callback = callback; }
    dispose() { const callback = this.callback; this.callback = () => {}; callback(); }
    static from(...values) { return new Disposable(() => values.forEach(value => value?.dispose())); }
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function createHarness() {
    const files = new Map();
    const operations = [];
    const messages = [];
    const messageChoices = [];
    const commands = [];
    const documents = [];
    const providers = new Map();
    const registeredCommands = new Map();
    const watchers = [];
    const listeners = { save: [], change: [] };
    const gates = [];
    const localRoot = Uri.file("/test-replica");
    const remoteRoot = Uri.parse("overleaf-workshop://example.test/project?project=test-project");
    const bytes = value => value === undefined ? undefined : Buffer.from(value);
    const key = uri => uri.toString();
    const notFound = uri => Object.assign(new Error(`Missing test file: ${uri.path}`), { code: "FileNotFound" });
    const seed = (uri, value, type = FILE) => files.set(key(uri), { type, content: bytes(value) });
    seed(localRoot, undefined, DIRECTORY);
    seed(remoteRoot, undefined, DIRECTORY);

    async function before(operation, uri) {
        const gateIndex = gates.findIndex(gate => gate.operation === operation && (!gate.uri || key(uri) === key(gate.uri)));
        if (gateIndex >= 0) {
            const [gate] = gates.splice(gateIndex, 1);
            gate.entered.resolve();
            await gate.release.promise;
        }
    }
    const memoryFs = {
        async stat(uri) {
            await before("stat", uri);
            const entry = files.get(key(uri));
            if (!entry) throw notFound(uri);
            return { type: entry.type, size: entry.content?.length ?? 0, ctime: 0, mtime: 0 };
        },
        async readFile(uri) {
            await before("read", uri);
            const entry = files.get(key(uri));
            if (!entry) throw notFound(uri);
            if (entry.type === DIRECTORY) throw Object.assign(new Error("Is a directory"), { code: "FileIsADirectory" });
            return Buffer.from(entry.content);
        },
        async writeFile(uri, content) {
            await before("write", uri);
            operations.push({ kind: "write", uri, content: bytes(content) });
            seed(uri, content);
        },
        async createDirectory(uri) {
            await before("mkdir", uri);
            operations.push({ kind: "mkdir", uri });
            seed(uri, undefined, DIRECTORY);
        },
        async delete(uri, options = {}) {
            await before("delete", uri);
            const prefix = uri.path.replace(/\/$/, "") + "/";
            const descendant = value => {
                const candidate = Uri.parse(value);
                return candidate.scheme === uri.scheme && candidate.authority === uri.authority && candidate.query === uri.query && candidate.path.startsWith(prefix);
            };
            if (!files.has(key(uri)) && ![...files.keys()].some(descendant)) throw notFound(uri);
            operations.push({ kind: "delete", uri, options });
            files.delete(key(uri));
            if (options.recursive) for (const value of files.keys()) if (descendant(value)) files.delete(value);
        },
        async readDirectory(uri) {
            await before("list", uri);
            const prefix = uri.path.replace(/\/$/, "") + "/";
            const children = new Map();
            for (const [value, entry] of files) {
                const candidate = Uri.parse(value);
                if (candidate.scheme !== uri.scheme || candidate.authority !== uri.authority || candidate.query !== uri.query || !candidate.path.startsWith(prefix)) continue;
                const relative = candidate.path.slice(prefix.length);
                if (!relative) continue;
                const [name, ...rest] = relative.split("/");
                children.set(name, rest.length ? DIRECTORY : entry.type);
            }
            return [...children.entries()];
        },
        async rename(from, to, options = {}) {
            const content = await memoryFs.readFile(from);
            if (!options.overwrite && files.has(key(to))) throw Object.assign(new Error("File exists"), { code: "FileExists" });
            await memoryFs.writeFile(to, content);
            await memoryFs.delete(from);
        },
        async copy(from, to) { await memoryFs.writeFile(to, await memoryFs.readFile(from)); },
        isWritableFileSystem() { return true; },
    };

    class Position { constructor(line, character) { Object.assign(this, { line, character }); } }
    class Range {
        constructor(a, b, c, d) {
            if (typeof a === "number") { this.start = new Position(a, b); this.end = new Position(c, d); }
            else { this.start = a; this.end = b; }
        }
    }
    class WorkspaceEdit {
        constructor() { this.edits = []; }
        replace(uri, range, text) { this.edits.push({ uri, range, text }); }
        insert(uri, position, text) { this.replace(uri, new Range(position, position), text); }
        set(uri, edits) { edits.forEach(edit => this.replace(uri, edit.range, edit.newText)); }
        deleteFile(uri, options) { this.edits.push({ uri, delete: true, options }); }
        createFile(uri, options) { this.edits.push({ uri, create: true, options }); }
    }

    function openDocument(uri, content, dirty = false) {
        const existing = documents.find(doc => key(doc.uri) === key(uri));
        if (existing) return existing;
        const doc = {
            uri, isDirty: dirty, isClosed: false, isUntitled: false, version: 1,
            languageId: "latex", eol: 1, text: String(content), saved: 0,
            getText() { return this.text; },
            get lineCount() { return this.text.split("\n").length; },
            lineAt(line) { const text = this.text.split("\n")[line] ?? ""; return { text, range: new Range(line, 0, line, text.length) }; },
            positionAt(offset) { const prefix = this.text.slice(0, Math.max(0, Math.min(offset, this.text.length))).split("\n"); return new Position(prefix.length - 1, prefix.at(-1).length); },
            offsetAt(position) { return this.text.split("\n").slice(0, position.line).reduce((total, line) => total + line.length + 1, 0) + position.character; },
            async save() { await memoryFs.writeFile(this.uri, Buffer.from(this.text)); this.isDirty = false; this.saved++; listeners.save.forEach(listener => listener(this)); return true; },
        };
        documents.push(doc);
        return doc;
    }

    function addListener(collection, listener) {
        collection.push(listener);
        return new Disposable(() => { const index = collection.indexOf(listener); if (index >= 0) collection.splice(index, 1); });
    }
    async function showMessage(type, message, ...items) {
        messages.push({ type, message, items });
        const choice = messageChoices.shift();
        return typeof choice === "function" ? await choice({ type, message, items }) : choice;
    }
    const vscode = {
        Uri, Disposable, Position, Range, WorkspaceEdit,
        FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
        ThemeIcon: class ThemeIcon { constructor(id) { this.id = id; } },
        RelativePattern: class RelativePattern { constructor(base, pattern) { Object.assign(this, { base, pattern }); } },
        EventEmitter: class EventEmitter {
            constructor() { this.listeners = []; this.event = listener => addListener(this.listeners, listener); }
            fire(value) { this.listeners.forEach(listener => listener(value)); }
            dispose() { this.listeners.length = 0; }
        },
        FileType: { File: FILE, Directory: DIRECTORY, SymbolicLink: SYMBOLIC_LINK },
        FileSystemError: { FileNotFound: notFound },
        ProgressLocation: { Notification: 15 },
        l10n: { t: (value, ...values) => String(value).replace(/\{(\d+)\}/g, (_, index) => String(values[index])) },
        workspace: {
            fs: memoryFs, textDocuments: documents,
            onDidSaveTextDocument: listener => addListener(listeners.save, listener),
            onDidChangeTextDocument: listener => addListener(listeners.change, listener),
            getConfiguration: () => ({ get: (name, fallback) => fallback, update: async () => {} }),
            registerTextDocumentContentProvider: (scheme, provider) => { providers.set(scheme, provider); return new Disposable(() => providers.delete(scheme)); },
            createFileSystemWatcher(pattern) {
                const collection = { change: [], create: [], delete: [] };
                const watcher = { pattern, disposed: false,
                    onDidChange: listener => addListener(collection.change, listener),
                    onDidCreate: listener => addListener(collection.create, listener),
                    onDidDelete: listener => addListener(collection.delete, listener),
                    async emit(type, uri) { await Promise.all(collection[type].map(listener => listener(uri))); },
                    dispose() { this.disposed = true; for (const values of Object.values(collection)) values.length = 0; },
                };
                watchers.push(watcher);
                return watcher;
            },
            async openTextDocument(uri) {
                if (!(uri instanceof Uri)) return openDocument(Uri.parse(`untitled:///test-${documents.length}`), uri.content ?? "");
                return documents.find(doc => key(doc.uri) === key(uri)) ?? openDocument(uri, Buffer.from(await memoryFs.readFile(uri)).toString());
            },
            async applyEdit(edit) {
                for (const value of edit.edits) {
                    if (value.delete) { await memoryFs.delete(value.uri, value.options); continue; }
                    if (value.create) { await memoryFs.writeFile(value.uri, Buffer.alloc(0)); continue; }
                    const doc = await vscode.workspace.openTextDocument(value.uri);
                    const start = doc.offsetAt(value.range.start);
                    const end = doc.offsetAt(value.range.end);
                    doc.text = doc.text.slice(0, start) + value.text + doc.text.slice(end);
                    doc.isDirty = true;
                    doc.version++;
                    listeners.change.forEach(listener => listener({ document: doc }));
                }
                return true;
            },
        },
        window: {
            showWarningMessage: (...args) => showMessage("warning", ...args),
            showInformationMessage: (...args) => showMessage("information", ...args),
            showErrorMessage: (...args) => showMessage("error", ...args),
            showQuickPick: async items => messageChoices.shift() ?? items[0],
            showTextDocument: async doc => ({ document: doc }),
            withProgress: async (options, callback) => callback({ report() {} }, { isCancellationRequested: false }),
        },
        commands: {
            registerCommand(name, callback) { registeredCommands.set(name, callback); return new Disposable(() => registeredCommands.delete(name)); },
            async executeCommand(name, ...args) {
                commands.push({ name, args });
                return await registeredCommands.get(name)?.(...args);
            },
        },
    };

    const remoteWrites = () => operations.filter(operation => operation.uri.scheme === remoteRoot.scheme);
    const localUri = relative => Uri.joinPath(localRoot, relative);
    const remoteUri = relative => Uri.joinPath(remoteRoot, relative);
    const owner = {
        baseUri: localRoot, baseCache: {}, bypassCache: new Map(),
        watchSession: { disposed: false },
        vfs: { origin: remoteRoot, projectName: "Test project", serverName: "Test server", pathToUri: remoteUri },
        setBypassCache(relative, content) { this.bypassCache.set(relative, bytes(content)); },
        async writeFile(relative, content) { await memoryFs.writeFile(localUri(relative), content); },
        async readFile(relative) { try { return await memoryFs.readFile(localUri(relative)); } catch (error) { if (error.code === "FileNotFound") return undefined; throw error; } },
        async hasLocalSymbolicLink(relative) {
            const parts = relative.split("/").filter(Boolean);
            return parts.some((_, index) => (files.get(key(localUri(parts.slice(0, index + 1).join("/"))))?.type ?? 0) & SYMBOLIC_LINK);
        },
        matchIgnorePatterns(relative) { return relative.split("/").some(part => [".overleaf", ".git", ".vscode"].includes(part)); },
        async queueSync(...args) { operations.push({ kind: "queueSync", args, uri: remoteRoot }); },
    };

    function load(filename, overrides = {}) {
        const absolute = path.resolve(filename);
        const requireActual = createRequire(absolute);
        const module = { exports: {} };
        const localRequire = name => {
            if (name === "vscode") return vscode;
            if (Object.hasOwn(overrides, name)) return overrides[name];
            if (name.startsWith(".")) {
                const candidate = requireActual.resolve(name);
                return load(candidate, overrides);
            }
            return requireActual(name);
        };
        const wrapped = vm.runInThisContext(`(function(require,module,exports,__filename,__dirname,setTimeout,clearTimeout,setInterval,clearInterval){\n${fs.readFileSync(absolute, "utf8")}\n})`, { filename: absolute });
        wrapped(localRequire, module, module.exports, absolute, path.dirname(absolute),
            (callback, timeout, ...args) => { const timer = setTimeout(callback, timeout, ...args); timer.unref(); return timer; },
            clearTimeout,
            (callback, timeout, ...args) => ({
                stopped: false, unref() {},
                tick() { if (!this.stopped) return callback(...args); },
            }),
            timer => { if (timer) timer.stopped = true; });
        return module.exports;
    }

    return {
        vscode, owner, files, operations, messages, messageChoices, commands, documents,
        providers, watchers, load, localUri, remoteUri, remoteWrites,
        seedLocal(relative, value, type = FILE) { seed(localUri(relative), value, type); },
        seedRemote(relative, value, type = FILE) { seed(remoteUri(relative), value, type); },
        diskText(relative) { return files.get(key(localUri(relative)))?.content?.toString(); },
        remoteText(relative) { return files.get(key(remoteUri(relative)))?.content?.toString(); },
        openDirty(relative, text) { return openDocument(localUri(relative), text, true); },
        block(operation, uri) { const entered = deferred(); const release = deferred(); gates.push({ operation, uri, entered, release }); return { entered: entered.promise, release: release.resolve }; },
        assertNoRemoteWrites() { assert.deepEqual(remoteWrites(), [], "remote resolution must not upload, delete, or create remote files"); },
    };
}

module.exports = { createHarness, deferred, Uri, FILE, DIRECTORY, SYMBOLIC_LINK };
