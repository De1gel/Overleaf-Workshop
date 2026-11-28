"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { createHarness, deferred } = require("./local-replica-sync-harness");

const runtime = process.env.OVERLEAF_REPLICA_MODULE
    ? path.join(path.dirname(process.env.OVERLEAF_REPLICA_MODULE), "../core/remoteFileSystemProvider.js")
    : path.join(__dirname, "../../hotfixes/reviewed-runtime/out/core/remoteFileSystemProvider.js");

const doc = (id, name, content = "before") => ({
    _id: id, name, version: 0, remoteCache: content, localCache: content,
});
const folder = (id, name, docs = [], folders = []) => ({ _id: id, name, docs, folders, fileRefs: [] });
const project = (docs, folders = []) => ({ _id: "project", rootFolder: [folder("root", "", docs, folders)] });
const initialTree = () => project(
    [doc("main", "main.tex")],
    [folder("chapter", "章节", [doc("abstract", "Extended abstract.tex")])],
);
const filePaths = () => [
    { path: "/main.tex", type: "doc" },
    { path: "/章节/Extended abstract.tex", type: "doc" },
];

function setup() {
    const host = createHarness();
    const { VirtualFileSystem } = host.load(runtime, {
        "diff-match-patch": {},
        "../consts": { ROOT_NAME: "Overleaf" },
        "../utils/globalStateManager": { GlobalStateManager: { authenticate: async () => ({}) } },
        "../collaboration/clientManager": {},
        "../utils/eventBus": {},
        "../scm/scmCollectionProvider": {},
    });
    const snapshots = new Map();
    const vfs = Object.assign(Object.create(VirtualFileSystem.prototype), {
        root: initialTree(),
        projectId: "project",
        origin: host.owner.vfs.origin,
        remoteDocReads: new Map(),
        notifications: [],
        joins: 0,
        resets: 0,
        api: { projectEntitiesJson: async () => ({ type: "success", entities: filePaths() }) },
        isRemoteEditorDirty: () => false,
        notify(events) { this.notifications.push(...events); },
    });
    vfs.socket = {
        scheme: "v2",
        init() { vfs.resets++; },
        async joinProject() { vfs.joins++; return initialTree(); },
        async joinDoc(id) { return snapshots.get(id) ?? { docLines: ["before"], version: 0 }; },
        updateEventHandlers(handlers) { this.handlers = handlers; },
    };
    return { vfs, snapshots };
}

test("multiple v2 document edits reuse one connection and notify only changed files", async () => {
    const { vfs, snapshots } = setup();
    const root = vfs.root;
    for (let version = 1; version <= 4; version++) {
        snapshots.set("abstract", { docLines: ["删改", String(version)], version });
        await vfs.refreshRemoteSnapshot();
        assert.equal(vfs.resets, 0);
        assert.equal(root.rootFolder[0].folders[0].docs[0].remoteCache, `删改\n${version}`);
    }
    await vfs.refreshRemoteSnapshot();
    assert.equal(vfs.root, root);
    assert.equal(vfs.resets, 0);
    assert.equal(vfs.joins, 0);
    assert.equal(vfs.notifications.length, 4);
    assert.ok(vfs.notifications.every(change => change.uri.path.endsWith("/章节/Extended abstract.tex")));
});

test("concurrent refresh requests share the check and live edits are kept", async () => {
    const { vfs } = setup();
    vfs.remoteWatch();
    const gate = deferred();
    const entered = deferred();
    let checks = 0;
    vfs.api.projectEntitiesJson = async () => {
        checks++;
        entered.resolve();
        await gate.promise;
        return { type: "success", entities: filePaths() };
    };
    const first = vfs.refreshRemoteSnapshot();
    await entered.promise;
    const second = vfs.refreshRemoteSnapshot();
    vfs.socket.handlers.onFileChanged({ doc: "main", v: 0, op: [{ p: 6, i: " latest" }] });
    gate.resolve();
    await Promise.all([first, second]);
    assert.equal(checks, 1);
    assert.equal(vfs.resets, 0);
    assert.equal(vfs.root.rootFolder[0].docs[0].remoteCache, "before latest");
});

test("refresh preserves an unsaved remote-editor buffer and its edit base", async () => {
    const { vfs, snapshots } = setup();
    vfs.isRemoteEditorDirty = uri => uri.path.endsWith("/main.tex");
    const main = vfs.root.rootFolder[0].docs[0];
    snapshots.set("main", { docLines: ["cloud edit"], version: 1 });
    await vfs.refreshRemoteSnapshot();
    assert.equal(main.remoteCache, "cloud edit");
    assert.equal(main.localCache, "before");
    assert.equal(vfs.resets, 0);
});

test("only a missed tree change needs a v2 reconnect and later edits reuse it", async () => {
    const { vfs } = setup();
    const nextTree = initialTree();
    nextTree.rootFolder[0].docs.push(doc("new", "new.tex"));
    vfs.socket.joinProject = async () => { vfs.joins++; return nextTree; };
    vfs.api.projectEntitiesJson = async () => ({
        type: "success", entities: [...filePaths(), { path: "/new.tex", type: "doc" }],
    });
    await vfs.refreshRemoteSnapshot();
    await vfs.refreshRemoteSnapshot();
    assert.equal(vfs.resets, 1);
    assert.equal(vfs.joins, 1);
    assert.ok(vfs.notifications.some(change => change.uri.path.endsWith("/new.tex")));
});

test("tree recovery waits for a document write acknowledgment before replacing the socket", async () => {
    const { vfs } = setup();
    const host = createHarness();
    const { SocketIOAPI } = host.load(path.join(path.dirname(runtime), "../api/socketio.js"), { "./socketioAlt": {} });
    const writing = deferred();
    const socket = vfs.socket;
    vfs.socket = Object.assign(Object.create(SocketIOAPI.prototype), socket, {
        pendingDocumentWrites: 0,
        emit: () => writing.promise,
    });
    const nextTree = initialTree();
    nextTree.rootFolder[0].docs.push(doc("new", "new.tex"));
    vfs.socket.joinProject = async () => nextTree;
    vfs.api.projectEntitiesJson = async () => ({
        type: "success", entities: [...filePaths(), { path: "/new.tex", type: "doc" }],
    });
    const save = vfs.socket.applyOtUpdate("abstract", {});
    await assert.rejects(vfs.refreshRemoteSnapshot(), /waiting to be uploaded/);
    assert.equal(vfs.resets, 0);
    writing.resolve();
    await save;
    await vfs.refreshRemoteSnapshot();
    assert.equal(vfs.resets, 1);
});

test("a failed or invalid remote listing keeps the existing connection and tree", async () => {
    const { vfs } = setup();
    const root = vfs.root;
    for (const response of [
        { type: "failure" },
        { type: "success", entities: [{ path: "/../outside", type: "doc" }] },
        { type: "success", entities: [filePaths()[0], filePaths()[0]] },
    ]) {
        vfs.api.projectEntitiesJson = async () => response;
        await assert.rejects(vfs.refreshRemoteSnapshot(), /remote project tree/);
    }
    assert.equal(vfs.root, root);
    assert.equal(vfs.resets, 0);
    assert.equal(vfs.notifications.length, 0);
});

test("a nested rename keeps the matching ancestor name intact", () => {
    const { vfs } = setup();
    vfs.root = project([], [folder("repeat", "draft.tex", [doc("draft", "draft.tex")])]);
    vfs.remoteWatch();
    vfs.socket.handlers.onFileRenamed("draft", "final.tex");
    assert.equal(vfs.notifications.length, 2);
    assert.ok(vfs.notifications[0].uri.path.endsWith("/draft.tex/draft.tex"));
    assert.ok(vfs.notifications[1].uri.path.endsWith("/draft.tex/final.tex"));
});

test("a folder move removes the old entry and a repeated event keeps the new entry", () => {
    const { vfs } = setup();
    const chapter = vfs.root.rootFolder[0].folders[0];
    const destination = folder("destination", "new parent");
    vfs.root.rootFolder[0].folders.push(destination);
    vfs.remoteWatch();
    vfs.socket.handlers.onFileMoved(chapter._id, destination._id);
    vfs.socket.handlers.onFileMoved(chapter._id, destination._id);
    assert.deepEqual(vfs.root.rootFolder[0].folders, [destination]);
    assert.deepEqual(destination.folders, [chapter]);
    assert.equal(vfs.notifications.length, 2);
    vfs.socket.handlers.onFileRemoved(chapter._id);
    assert.deepEqual(destination.folders, []);
    assert.ok(vfs.notifications.at(-1).uri.path.endsWith("/new parent/章节"));
});
