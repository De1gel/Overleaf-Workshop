"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RemoteUpdateManager = void 0;
const vscode = require("vscode");
const crypto = require("crypto");
let nextPreviewId = 0;
function equal(left, right) {
    return left === right || (left !== undefined && right !== undefined
        && left.length === right.length && left.every((byte, index) => byte === right[index]));
}
function fingerprint(content) {
    return content === undefined ? "deleted" : crypto.createHash("sha256").update(content).digest("hex");
}
function sameLocalState(left, right) {
    return equal(left.disk, right.disk) && left.doc?.version === right.version && equal(left.dirty, right.dirty);
}
/** Remote changes stay pending until the user explicitly accepts a pull. */
class RemoteUpdateManager {
    constructor(owner) {
        this.owner = owner;
        this.pending = new Map();
        this.queueRevisions = new Map();
        this.deferred = false;
        this.disposed = false;
        this.previews = new Map();
        this.previewScheme = `overleaf-workshop-remote-preview-${++nextPreviewId}`;
        this.previewProvider = vscode.workspace.registerTextDocumentContentProvider(this.previewScheme, {
            provideTextDocumentContent: uri => this.previews.get(uri.toString()) ?? "",
        });
    }
    isActive() {
        return !this.disposed && !!this.owner.watchSession && !this.owner.watchSession.disposed;
    }
    hasPending(relPath) {
        return [...this.pending.keys()].some(path => path === relPath
            || path.startsWith(relPath + "/") || relPath.startsWith(path + "/"));
    }
    document(uri) {
        return vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString() && !doc.isClosed);
    }
    async localState(relPath) {
        const uri = vscode.Uri.joinPath(this.owner.baseUri, relPath);
        const disk = await this.owner.readFile(relPath);
        const doc = this.document(uri);
        return { uri, disk, doc, version: doc?.version,
            dirty: doc?.isDirty ? new TextEncoder().encode(doc.getText()) : undefined };
    }
    updateStatus() {
        if (this.pending.size) {
            this.owner.status = { status: "need-attention", message: `Overleaf: ${this.pending.size} remote update(s) awaiting your choice` };
        }
        else if (this.owner.remoteCheckFailed) {
            this.owner.status = { status: "need-attention", message: "Could not check Overleaf updates. Use Sync Local Replica to retry." };
        }
        else if (!this.owner.activeSyncs) {
            this.owner.status = { status: "idle", message: "" };
        }
    }
    async queue(relPath, content, options = {}) {
        const revision = (this.queueRevisions.get(relPath) ?? 0) + 1;
        this.queueRevisions.set(relPath, revision);
        if (!this.isActive() || !relPath.startsWith("/") || relPath.split("/").some(part => part === "." || part === "..")
            || this.owner.matchIgnorePatterns(relPath) || await this.owner.hasLocalSymbolicLink(relPath)) {
            return;
        }
        // Directory deletions are expanded to individual non-ignored files by the owner.
        if (options.directory) {
            return;
        }
        const local = await this.localState(relPath);
        if (!this.isActive() || this.queueRevisions.get(relPath) !== revision) {
            return;
        }
        if (local.dirty === undefined && equal(local.disk, content)) {
            this.pending.delete(relPath);
            this.owner.baseCache[relPath] = content;
            this.owner.setBypassCache(relPath, content);
            await this.owner.recordSyncedState?.(relPath, content);
            if (!this.pending.size) {
                this.deferred = false;
            }
            this.updateStatus();
            return;
        }
        if (local.disk !== undefined && local.dirty === undefined &&
            this.owner.canRecoverLocalEdit?.(relPath, content)) {
            this.pending.delete(relPath);
            if (!this.pending.size) {
                this.deferred = false;
            }
            this.updateStatus();
            return;
        }
        const previous = this.pending.get(relPath);
        const hash = fingerprint(content);
        this.pending.set(relPath, { relPath, content: content === undefined ? undefined : new Uint8Array(content), hash });
        this.updateStatus();
        if (!this.owner.manualSyncEvents && !this.deferred && (!previous || previous.hash !== hash)) {
            clearTimeout(this.promptTimer);
            this.promptTimer = setTimeout(() => {
                this.promptTimer = undefined;
                void this.prompt().catch(() => {
                    this.updateStatus();
                    void vscode.window.showErrorMessage("Overleaf remote updates could not be applied. Use Sync Local Replica to retry.");
                });
            }, 1200);
        }
    }
    async prompt(force = false) {
        if (this.owner.manualSyncEvents || !this.isActive() || !this.pending.size || (this.deferred && !force)) {
            return;
        }
        if (force) {
            this.deferred = false;
        }
        if (this.promptPromise) {
            return this.promptPromise;
        }
        this.promptPromise = (async () => {
            const pull = "Pull Remote (Overwrite Local)";
            const push = "Push Local (Overwrite Remote)";
            const diff = "View Diff";
            const keep = "Keep Local for Now";
            while (this.isActive() && this.pending.size) {
                // The choice authorizes only the versions listed in this prompt.
                const entries = [...this.pending.values()];
                const names = entries.slice(0, 4).map(entry => entry.relPath).join(", ");
                console.log(`Local Replica: ${this.pending.size} remote update(s) awaiting review`);
                const choice = await vscode.window.showWarningMessage(
                    `Overleaf has remote changes: ${names}${entries.length > 4 ? ", …" : ""}. Pull applies the remote version. Push applies the local version. Replaced contents are backed up first.`,
                    pull, push, diff, keep);
                if (this.owner.manualSyncEvents || !this.isActive()) {
                    return;
                }
                if (choice === pull) {
                    await this.pull(entries);
                    return;
                }
                if (choice === push) {
                    await this.push(entries);
                    return;
                }
                if (choice === diff) {
                    await this.preview();
                    continue;
                }
                // Closing the notification also leaves both versions untouched.
                this.deferred = true;
                return;
            }
        })().finally(() => {
            this.promptPromise = undefined;
            this.updateStatus();
        });
        return this.promptPromise;
    }
    storageUri() {
        return this.owner.vfs.context?.globalStorageUri ?? vscode.Uri.joinPath(this.owner.baseUri, ".overleaf");
    }
    async preview() {
        if (!this.isActive() || !this.pending.size) {
            return;
        }
        let entry = [...this.pending.values()][0];
        if (this.pending.size > 1) {
            const choice = await vscode.window.showQuickPick([...this.pending.keys()], { title: "Overleaf: choose a file to compare" });
            if (!choice || !this.isActive()) {
                return;
            }
            entry = this.pending.get(choice);
        }
        if (!entry) {
            return;
        }
        const remoteUri = vscode.Uri.from({ scheme: this.previewScheme, path: entry.relPath, query: entry.hash });
        let text = "";
        if (entry.content !== undefined) {
            try {
                text = new TextDecoder("utf-8", { fatal: true }).decode(entry.content);
                if (text.includes("\u0000")) {
                    text = `[Binary cloud file: ${entry.content.length} bytes]`;
                }
            }
            catch {
                text = `[Binary cloud file: ${entry.content.length} bytes]`;
            }
        }
        this.previews.set(remoteUri.toString(), text);
        const localUri = vscode.Uri.joinPath(this.owner.baseUri, entry.relPath);
        const local = await this.localState(entry.relPath);
        let left = localUri;
        if (local.disk === undefined && !local.doc) {
            left = vscode.Uri.from({ scheme: this.previewScheme, path: entry.relPath, query: "local-missing" });
            this.previews.set(left.toString(), "");
        }
        if (this.isActive()) {
            await vscode.commands.executeCommand("vscode.diff", left, remoteUri,
                `${entry.relPath.slice(1)} — Local ↔ Overleaf${entry.content === undefined ? " (deleted remotely)" : ""}`);
        }
    }
    async backup(entries) {
        const key = crypto.createHash("sha256").update(this.owner.baseUri.toString()).digest("hex").slice(0, 12);
        const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}`;
        const root = vscode.Uri.joinPath(this.storageUri(), "local-replica-backups", key, stamp);
        await vscode.workspace.fs.createDirectory(root);
        const states = new Map();
        const manifest = [];
        for (const entry of entries) {
            if (!this.isActive() || await this.owner.hasLocalSymbolicLink(entry.relPath)) {
                throw new Error("Local Replica session changed while backing up");
            }
            const state = await this.localState(entry.relPath);
            states.set(entry.relPath, state);
            const relative = entry.relPath.slice(1);
            if (state.disk !== undefined) {
                const destination = vscode.Uri.joinPath(root, "disk", relative);
                await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(destination, ".."));
                await vscode.workspace.fs.writeFile(destination, state.disk);
            }
            if (state.dirty !== undefined) {
                const destination = vscode.Uri.joinPath(root, "unsaved", relative);
                await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(destination, ".."));
                await vscode.workspace.fs.writeFile(destination, state.dirty);
            }
            manifest.push({ path: relative, hadDiskFile: state.disk !== undefined, hadUnsavedChanges: state.dirty !== undefined,
                remote: entry.content === undefined ? "deleted" : entry.hash });
        }
        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, "manifest.json"),
            new TextEncoder().encode(JSON.stringify(manifest, null, 2)));
        return { root, states };
    }
    async remoteContent(uri) {
        try {
            return await this.owner.vfs.readRemoteFile(uri, true);
        }
        catch (error) {
            if (error?.code === "FileNotFound" || error?.code === "ENOENT") {
                return undefined;
            }
            throw error;
        }
    }
    async prepareRemoteParent(relPath) {
        let uri = this.owner.vfs.pathToUri("/");
        for (const part of relPath.split("/").filter(Boolean).slice(0, -1)) {
            uri = vscode.Uri.joinPath(uri, part);
            let stat;
            try {
                stat = await vscode.workspace.fs.stat(uri);
            }
            catch (error) {
                if (error?.code !== "FileNotFound" && error?.code !== "ENOENT") {
                    throw error;
                }
            }
            if (!this.isActive()) {
                throw new Error("Local Replica session changed");
            }
            if (!stat) {
                await vscode.workspace.fs.createDirectory(uri);
                stat = await vscode.workspace.fs.stat(uri);
            }
            if (stat.type !== vscode.FileType.Directory) {
                throw new Error("A remote parent is not a directory");
            }
        }
    }
    async push(entries = [...this.pending.values()]) {
        if (!this.isActive() || !entries.length) {
            return;
        }
        if (this.pushPromise) {
            return this.pushPromise;
        }
        this.pushPromise = this.pushEntries(entries).finally(() => {
            this.pushPromise = undefined;
            this.updateStatus();
        });
        return this.pushPromise;
    }
    async pushEntries(entries) {
        // Automatic saves remain blocked until the explicitly chosen upload is verified.
        this.deferred = true;
        let backup;
        let applied = 0;
        const unresolved = new Set();
        try {
            entries = entries.filter(entry => this.pending.get(entry.relPath)?.hash === entry.hash);
            if (!entries.length || !this.isActive()) {
                return;
            }
            backup = await this.backup(entries);
            for (const entry of entries) {
                if (entry.content !== undefined) {
                    const destination = vscode.Uri.joinPath(backup.root, "remote", entry.relPath.slice(1));
                    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(destination, ".."));
                    await vscode.workspace.fs.writeFile(destination, entry.content);
                }
            }
            // The backup manifest records the selected remote hash or a deletion marker.
            // Refresh before acquiring a per-file lock: refreshing v2 resets its transport.
            await this.owner.remoteCheckPromise;
            await Promise.all([...(this.owner.syncQueues?.values() ?? [])]);
            await this.owner.vfs.refreshRemoteSnapshot();
            await Promise.all([...(this.owner.syncQueues?.values() ?? [])]);
            for (const entry of entries) {
                if (!this.isActive()) {
                    break;
                }
                const apply = async () => {
                    const currentEntry = () => this.isActive() && this.pending.get(entry.relPath)?.hash === entry.hash;
                    if (!currentEntry() || this.owner.matchIgnorePatterns(entry.relPath)
                        || await this.owner.hasLocalSymbolicLink(entry.relPath)) {
                        unresolved.add(entry.relPath);
                        return;
                    }
                    const before = backup.states.get(entry.relPath);
                    let local = await this.localState(entry.relPath);
                    if (!sameLocalState(local, before) || (entry.manualLocal && !sameLocalState(local, entry.manualLocal))) {
                        throw new Error("Local content changed after the upload was chosen");
                    }
                    if (local.doc?.isDirty) {
                        if (!await local.doc.save() || local.doc.isDirty) {
                            throw new Error("Local editor could not save");
                        }
                        local = await this.localState(entry.relPath);
                    }
                    const content = local.disk;
                    const remoteUri = this.owner.vfs.pathToUri(entry.relPath);
                    if (this.owner.vfs.isRemoteEditorDirty?.(remoteUri)) {
                        throw new Error("The remote editor has unsaved changes");
                    }
                    this.owner.activeSyncs = (this.owner.activeSyncs ?? 0) + 1;
                    try {
                        const fresh = await this.remoteContent(remoteUri);
                        if (!equal(fresh, entry.content)) {
                            await this.queue(entry.relPath, fresh);
                            unresolved.add(entry.relPath);
                            return;
                        }
                        const latest = await this.localState(entry.relPath);
                        if (!currentEntry() || !equal(latest.disk, content)
                            || latest.doc?.version !== local.version || latest.doc?.isDirty
                            || this.owner.vfs.isRemoteEditorDirty?.(remoteUri)
                            || await this.owner.hasLocalSymbolicLink(entry.relPath)) {
                            unresolved.add(entry.relPath);
                            return;
                        }
                        // Parent creation is needed only when restoring a remotely deleted file.
                        if (content !== undefined && entry.content === undefined) {
                            await this.prepareRemoteParent(entry.relPath);
                        }
                        if (!equal(fresh, content)) {
                            if (content === undefined) {
                                // Never recursively delete a remote folder or its new children.
                                const stat = await vscode.workspace.fs.stat(remoteUri);
                                if (stat.type !== vscode.FileType.File || !currentEntry()) {
                                    throw new Error("Remote deletion target is no longer a file");
                                }
                            }
                            // Local reads, path checks and stat() above can yield to cloud events.
                            const ready = await this.remoteContent(remoteUri);
                            if (!equal(ready, entry.content)) {
                                await this.queue(entry.relPath, ready);
                                unresolved.add(entry.relPath);
                                return;
                            }
                            if (!currentEntry()) {
                                unresolved.add(entry.relPath);
                                return;
                            }
                            if (content === undefined) {
                                if (this.owner.vfs.deleteReviewedFile) {
                                    await this.owner.vfs.deleteReviewedFile(remoteUri, entry.content, currentEntry);
                                }
                                else {
                                    await vscode.workspace.fs.delete(remoteUri, { recursive: false });
                                }
                            }
                            else if (this.owner.vfs.writeReviewedFile) {
                                await this.owner.vfs.writeReviewedFile(remoteUri, content, entry.content, currentEntry);
                            }
                            else {
                                await vscode.workspace.fs.writeFile(remoteUri, content);
                            }
                        }
                        // Some VFS APIs report failures without rejecting. Always read back.
                        const actual = await this.remoteContent(remoteUri);
                        if (!equal(actual, content)) {
                            await this.queue(entry.relPath, actual);
                            throw new Error("Remote contents did not match the chosen upload");
                        }
                        if (!this.isActive()) {
                            return;
                        }
                        this.owner.baseCache[entry.relPath] = content;
                        this.owner.setBypassCache(entry.relPath, content);
                        await this.owner.recordSyncedState?.(entry.relPath, content);
                        // An acknowledgement event may have queued the uploaded bytes.
                        const pending = this.pending.get(entry.relPath);
                        if (pending?.hash === entry.hash || pending?.hash === fingerprint(content)) {
                            this.pending.delete(entry.relPath);
                        }
                        applied++;
                    }
                    finally {
                        this.owner.activeSyncs--;
                    }
                };
                try {
                    if (this.owner.runAcceptedPull) {
                        await this.owner.runAcceptedPull(entry.relPath, apply);
                    }
                    else {
                        await apply();
                    }
                }
                catch (error) {
                    // Error payloads can include authentication data. Report paths only.
                    unresolved.add(entry.relPath);
                    if (error?.code === "RemoteChanged" && this.isActive()) {
                        try {
                            await this.queue(entry.relPath, await this.remoteContent(this.owner.vfs.pathToUri(entry.relPath)));
                        }
                        catch { /* Keep the existing pending choice while offline. */ }
                    }
                }
            }
        }
        catch {
            for (const entry of entries) {
                unresolved.add(entry.relPath);
            }
        }
        if (!this.pending.size) {
            this.deferred = false;
        }
        this.updateStatus();
        if (applied && this.isActive()) {
            void vscode.window.showInformationMessage(`Pushed and verified ${applied} local file(s) to Overleaf. Previous remote contents were backed up.`, "Open Backup Folder")
                .then(choice => choice === "Open Backup Folder" && vscode.commands.executeCommand("revealFileInOS", backup.root)).catch(() => {});
        }
        if (unresolved.size && this.isActive()) {
            void vscode.window.showWarningMessage(`Could not complete the chosen Overleaf upload for: ${[...unresolved].join(", ")}. Changes remain pending. Review the current diff and retry; check the connection and save any open remote editor first.`);
        }
    }
    async pull(entries = [...this.pending.values()]) {
        if (!this.isActive() || !entries.length) {
            return;
        }
        // Serialize accepted pulls with the same per-file queue as local saves.
        const backup = await this.backup(entries);
        let applied = 0;
        for (const entry of entries) {
            if (!this.isActive()) {
                break;
            }
            const apply = async () => {
                if (!this.isActive() || this.pending.get(entry.relPath)?.hash !== entry.hash
                    || await this.owner.hasLocalSymbolicLink(entry.relPath)) {
                    return;
                }
                if (typeof this.owner.vfs.readRemoteFile === "function") {
                    let fresh;
                    try {
                        fresh = await this.owner.vfs.readRemoteFile(this.owner.vfs.pathToUri(entry.relPath), true);
                    }
                    catch (error) {
                        if (error?.code !== "FileNotFound" && error?.code !== "ENOENT") {
                            throw error;
                        }
                    }
                    if (!equal(fresh, entry.content)) {
                        await this.queue(entry.relPath, fresh);
                        return;
                    }
                }
                const before = backup.states.get(entry.relPath);
                // Prepare the target before the last consistency check, so an edit
                // made while mkdir is in flight cannot be silently overwritten.
                const localUri = vscode.Uri.joinPath(this.owner.baseUri, entry.relPath);
                if (entry.content !== undefined) {
                    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(localUri, ".."));
                }
                if (await this.owner.hasLocalSymbolicLink(entry.relPath)) {
                    return;
                }
                const current = await this.localState(entry.relPath);
                if (!this.isActive() || this.pending.get(entry.relPath)?.hash !== entry.hash) {
                    return;
                }
                if (!sameLocalState(current, before) || (entry.manualLocal && !sameLocalState(current, entry.manualLocal))) {
                    throw new Error("Local file changed after the pull was accepted; retry after reviewing it");
                }
                if (entry.content === undefined && current.doc?.isDirty) {
                    // Never remove a file while its unsaved editor buffer is still open.
                    void vscode.window.showWarningMessage(`Close or save the unsaved editor for ${entry.relPath} before accepting its remote deletion. Its contents were backed up.`);
                    return;
                }
                let remoteText;
                if (current.doc?.isDirty && entry.content !== undefined) {
                    try { remoteText = new TextDecoder("utf-8", { fatal: true }).decode(entry.content); }
                    catch { /* A binary file cannot be applied as a text edit. */ }
                    if (remoteText === undefined || remoteText.includes("\u0000")) {
                        void vscode.window.showWarningMessage(`Close or save the unsaved editor for ${entry.relPath} before pulling its binary replacement.`);
                        return;
                    }
                }
                this.owner.setBypassCache(entry.relPath, entry.content);
                if (entry.content === undefined) {
                    if (current.disk !== undefined) {
                        await vscode.workspace.fs.delete(current.uri, { recursive: false, useTrash: true });
                    }
                }
                else if (current.doc?.isDirty) {
                    const edit = new vscode.WorkspaceEdit();
                    edit.replace(current.uri, new vscode.Range(current.doc.positionAt(0), current.doc.positionAt(current.doc.getText().length)),
                        remoteText);
                    if (!await vscode.workspace.applyEdit(edit) || !this.isActive() || !await current.doc.save()) {
                        throw new Error("The editor could not save the accepted remote version");
                    }
                    if (!equal(await this.owner.readFile(entry.relPath), entry.content)) {
                        throw new Error("The editor changed the pulled content while saving; remote update remains pending");
                    }
                }
                else {
                    await this.owner.writeFile(entry.relPath, entry.content);
                }
                if (!this.isActive()) {
                    return;
                }
                this.owner.baseCache[entry.relPath] = entry.content;
                await this.owner.recordSyncedState?.(entry.relPath, entry.content);
                if (this.pending.get(entry.relPath)?.hash === entry.hash) {
                    this.pending.delete(entry.relPath);
                }
                applied++;
            };
            if (this.owner.runAcceptedPull) {
                await this.owner.runAcceptedPull(entry.relPath, apply);
            }
            else {
                await apply();
            }
        }
        if (!this.pending.size) {
            this.deferred = false;
        }
        this.updateStatus();
        if (applied && this.isActive()) {
            console.log(`Local Replica: pulled ${applied} remote file(s) after user confirmation`);
            void vscode.window.showInformationMessage(`Pulled ${applied} Overleaf file(s). Previous local contents were backed up.`, "Open Backup Folder")
                .then(choice => choice === "Open Backup Folder" && vscode.commands.executeCommand("revealFileInOS", backup.root)).catch(() => {});
        }
    }
    dispose() {
        this.disposed = true;
        clearTimeout(this.promptTimer);
        this.previewProvider.dispose();
        this.previews.clear();
        this.queueRevisions.clear();
    }
}
exports.RemoteUpdateManager = RemoteUpdateManager;
