"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { test } = require("node:test");
const { createHarness, Uri, DIRECTORY, SYMBOLIC_LINK } = require("./local-replica-sync-harness");

const replicaModule = process.env.OVERLEAF_REPLICA_MODULE ??
    path.resolve(__dirname, "../out/scm/localReplicaSCM.js");

class BaseSCM {
    constructor(vfs, baseUri) { Object.assign(this, { vfs, baseUri, _settings: {} }); }
    getSetting(name) { return this._settings[name]; }
}

async function fixture(callback, { syncOnChange = true, beforeStart = () => {} } = {}) {
    const host = createHarness();
    host.vscode.workspace.getConfiguration = () => ({
        get(name, fallback) { return name === "enabled" ? syncOnChange : fallback; },
    });
    Object.assign(host.owner.vfs, {
        context: { globalStorageUri: Uri.file("/qa-overleaf-storage") },
        refreshRemoteSnapshot: async () => true,
        readRemoteFile: async uri => host.vscode.workspace.fs.readFile(uri),
        getUpdates: async () => ({ updates: [{ toV: "unchanged cloud history version" }] }),
        getProjectSCMPersist: () => ({ settings: {} }),
        setProjectSCMPersist: () => {},
        isRemoteEditorDirty: () => false,
    });
    host.seedLocal("/Model.tex", "initial");
    host.seedRemote("/Model.tex", "initial");
    beforeStart(host);
    const { LocalReplicaSCMProvider } = host.load(replicaModule, {
        ".": { BaseSCM },
        "./localReplicaSettings": {
            containsLocalUri: (root, uri) => uri.path.startsWith(root.path + "/"),
            replicaKey: uri => uri.toString(),
            selectLocalReplica: replicas => replicas[0],
            discoverLocalReplicas: async () => [],
        },
    });
    let provider;
    const restart = async () => {
        provider?.dispose();
        provider = new LocalReplicaSCMProvider(host.owner.vfs, host.owner.baseUri);
        await provider.initWatch();
        return provider;
    };
    try {
        await restart();
        const emit = (event, relative) => host.watchers
            .find(watcher => !watcher.disposed && watcher.pattern.base.scheme === "file")
            .emit(event, host.localUri(relative));
        await callback(host, provider, emit, restart);
    }
    finally { provider?.dispose(); }
}

async function eventually(predicate, message) {
    const end = Date.now() + 1600;
    while (!predicate() && Date.now() < end) await delay(15);
    assert.ok(predicate(), message);
}

async function drained(provider) {
    await eventually(() => !provider.syncTimers.size && !provider.syncQueues.size, "watcher work did not drain");
}

function remoteOperations(host, name, kind) {
    return host.remoteWrites().filter(operation =>
        operation.kind === kind && operation.uri.toString() === host.remoteUri(name).toString());
}

test("new file reaches cloud from a create event alone", () => fixture(async (host, provider, emit) => {
    host.seedLocal("/only-created.tex", "a new file without an editor save");
    await emit("create", "/only-created.tex");
    await eventually(() => host.remoteText("/only-created.tex") === "a new file without an editor save",
        "new file was not uploaded");
    await drained(provider);
    assert.ok(provider.knownRemotePaths.has("/only-created.tex"));
    assert.equal(remoteOperations(host, "/only-created.tex", "write").length, 1);
}));

for (const folderAlreadyRemote of [false, true]) {
    test("populated directory event uploads descendants when cloud parent " +
        (folderAlreadyRemote ? "already exists" : "is absent"), () =>
        fixture(async (host, provider, emit) => {
            const binary = Buffer.from([0, 255, 128, 42]);
            host.seedLocal("/reports", undefined, DIRECTORY);
            host.seedLocal("/reports/report.tex", "ready report");
            host.seedLocal("/reports/中文 chapter", undefined, DIRECTORY);
            host.seedLocal("/reports/中文 chapter/results.tex", "nested result");
            host.seedLocal("/reports/empty", undefined, DIRECTORY);
            host.seedLocal("/reports/figure.png", binary);
            host.seedLocal("/reports/ignored.aux", "compiler output");
            host.seedLocal("/reports/.hidden", "internal content");
            host.seedLocal("/reports/link", undefined, DIRECTORY | SYMBOLIC_LINK);
            host.seedLocal("/reports/link/private.tex", "must never leave symlink target");
            await emit("create", "/reports");
            await eventually(() => host.remoteText("/reports/中文 chapter/results.tex") === "nested result",
                "directory creation did not upload existing children");
            await drained(provider);
            assert.equal(host.remoteText("/reports/report.tex"), "ready report");
            assert.deepEqual(await host.vscode.workspace.fs.readFile(host.remoteUri("/reports/figure.png")), binary);
            assert.equal((await host.vscode.workspace.fs.stat(host.remoteUri("/reports/empty"))).type, DIRECTORY);
            for (const name of ["ignored.aux", ".hidden", "link", "link/private.tex"]) {
                assert.equal(host.files.has(host.remoteUri("/reports/" + name).toString()), false, name);
            }
        }, { beforeStart(host) {
            if (folderAlreadyRemote) host.seedRemote("/reports", undefined, DIRECTORY);
        } }));
}

test("duplicate child and directory creation events converge without duplicate writes", () =>
    fixture(async (host, provider, emit) => {
        host.seedLocal("/reports", undefined, DIRECTORY);
        host.seedLocal("/reports/nested", undefined, DIRECTORY);
        host.seedLocal("/reports/nested/leaf.tex", "new leaf");
        await Promise.all([
            emit("create", "/reports/nested/leaf.tex"),
            emit("create", "/reports"),
            emit("change", "/reports/nested/leaf.tex"),
            emit("create", "/reports/nested"),
        ]);
        await eventually(() => host.remoteText("/reports/nested/leaf.tex") === "new leaf", "leaf never landed");
        await drained(provider);
        assert.equal(remoteOperations(host, "/reports/nested/leaf.tex", "write").length, 1);
        assert.equal(remoteOperations(host, "/reports", "mkdir").length, 1);
        assert.equal(remoteOperations(host, "/reports/nested", "mkdir").length, 1);
    }));

test("restart catches additions made while the replica was disabled", () =>
    fixture(async (host, provider) => {
        provider.dispose();
        host.seedLocal("/offline", undefined, DIRECTORY);
        host.seedLocal("/offline/retained.tex", "addition made while watcher was closed");
        await provider.initWatch();
        await eventually(() => host.remoteText("/offline/retained.tex") === "addition made while watcher was closed",
            "restart did not reconcile local additions");
        await drained(provider);
    }));

test("an unchanged remote revision does not prevent missed local-addition reconciliation", () =>
    fixture(async (host, provider) => {
        await provider.checkRemoteUpdates();
        host.seedLocal("/missed.tex", "no watcher event was received");
        provider.remotePollTimer.tick();
        await eventually(() => host.remoteText("/missed.tex") === "no watcher event was received",
            "local addition did not reconcile at the same cloud revision");
        await drained(provider);
    }));

test("tracking state prevents resurrecting a cloud-deleted file upon reconnect", () =>
    fixture(async (host, provider) => {
        assert.ok(provider.knownRemotePaths.has("/Model.tex"));
        provider.dispose();
        host.files.delete(host.remoteUri("/Model.tex").toString());
        host.seedLocal("/Model.tex", "local edit after cloud deleted this file");
        await provider.initWatch();
        await drained(provider);
        assert.ok(provider.remoteUpdates.hasPending("/Model.tex"));
        assert.equal(host.diskText("/Model.tex"), "local edit after cloud deleted this file");
        assert.equal(host.remoteText("/Model.tex"), undefined);
        host.assertNoRemoteWrites();
    }));

test("an incomplete snapshot cannot authorize creating a local-only file remotely", () =>
    fixture(async (host, provider) => {
        await provider.checkRemoteUpdates();
        host.seedLocal("/wait.tex", "private until remote comparison succeeds");
        host.owner.vfs.refreshRemoteSnapshot = async () => { throw new Error("transport disconnected"); };
        await assert.rejects(provider.checkRemoteUpdates(true), /transport disconnected/);
        await drained(provider);
        host.assertNoRemoteWrites();
        assert.equal(provider.knownRemotePaths.has("/wait.tex"), false);
    }));

test("a failed watcher upload remains untracked and is retried after a successful reconnect", () =>
    fixture(async (host, provider, emit) => {
        const redirect = host.vscode.workspace.fs.writeFile;
        let failed = 0;
        host.vscode.workspace.fs.writeFile = async (uri, content) => {
            if (uri.toString() === host.remoteUri("/retry.tex").toString() && failed++ === 0) {
                throw Object.assign(new Error("temporary transport failure"), { code: "ECONNRESET" });
            }
            return redirect(uri, content);
        };
        host.seedLocal("/retry.tex", "retry me");
        await emit("create", "/retry.tex");
        await eventually(() => failed >= 1, "first upload was never attempted");
        await drained(provider);
        if (host.remoteText("/retry.tex") !== "retry me") {
            assert.equal(provider.knownRemotePaths.has("/retry.tex"), false);
            await provider.checkRemoteUpdates(true);
        }
        await eventually(() => host.remoteText("/retry.tex") === "retry me", "lost addition was not retried");
        await drained(provider);
        assert.ok(provider.knownRemotePaths.has("/retry.tex"));
    }));

test("an apparent successful upload is untracked if readback cannot find the bytes", () =>
    fixture(async (host, provider, emit) => {
        const redirect = host.vscode.workspace.fs.writeFile;
        let attempted = false;
        host.vscode.workspace.fs.writeFile = async (uri, content) => {
            if (uri.toString() === host.remoteUri("/not-stored.tex").toString()) { attempted = true; return; }
            return redirect(uri, content);
        };
        host.seedLocal("/not-stored.tex", "server must actually store these bytes");
        await emit("create", "/not-stored.tex");
        await eventually(() => attempted, "upload was never attempted");
        await drained(provider);
        assert.equal(provider.knownRemotePaths.has("/not-stored.tex"), false);
        assert.equal(host.remoteText("/not-stored.tex"), undefined);
    }));

test("local edit and then delete synchronize when the accepted cloud base is unchanged", () =>
    fixture(async (host, provider, emit) => {
        host.seedLocal("/Model.tex", "new local text");
        await emit("change", "/Model.tex");
        await eventually(() => host.remoteText("/Model.tex") === "new local text", "change did not land");
        await drained(provider);
        await host.vscode.workspace.fs.delete(host.localUri("/Model.tex"));
        await emit("delete", "/Model.tex");
        await eventually(() => host.remoteText("/Model.tex") === undefined, "delete did not land");
        await drained(provider);
        assert.equal(provider.knownRemotePaths.has("/Model.tex"), false);
    }));

test("a remote edit to a tracked path is staged and guarded from a local watcher update", () =>
    fixture(async (host, provider, emit) => {
        host.seedRemote("/Model.tex", "independent cloud edit");
        host.seedLocal("/Model.tex", "independent local edit");
        await emit("change", "/Model.tex");
        await eventually(() => provider.remoteUpdates.hasPending("/Model.tex"), "conflict was not staged");
        await drained(provider);
        host.assertNoRemoteWrites();
        assert.equal(host.diskText("/Model.tex"), "independent local edit");
        assert.equal(host.remoteText("/Model.tex"), "independent cloud edit");
        await provider.remoteUpdates.pull();
        assert.equal(host.diskText("/Model.tex"), "independent cloud edit");
        host.assertNoRemoteWrites();
    }));

test("manual push previews and uploads no-event files with auto change synchronization disabled", () =>
    fixture(async (host, provider) => {
        await drained(provider);
        host.assertNoRemoteWrites();
        host.messageChoices.push(({ message, items }) => {
            assert.match(message, /^Push to Overleaf/);
            assert.match(items[0].detail, /Add \/reports\/manual\.tex/);
            return "Push to Overleaf";
        });
        await provider.manualSync("push");
        assert.equal(host.remoteText("/reports/manual.tex"), "user-approved content");
        assert.ok(provider.knownRemotePaths.has("/reports/manual.tex"));
    }, {
        syncOnChange: false,
        beforeStart(host) {
            host.seedLocal("/reports", undefined, DIRECTORY);
            host.seedLocal("/reports/manual.tex", "user-approved content");
        },
    }));

test("restart uploads an offline edit against its persisted base and leaves offline deletions for review", () =>
    fixture(async (host, provider, _emit, restart) => {
        provider.dispose();
        host.seedLocal("/Model.tex", "saved local edit during downtime");
        host.files.delete(host.localUri("/removed.tex").toString());
        const reopened = await restart();
        await eventually(() => host.remoteText("/Model.tex") === "saved local edit during downtime",
            "restart did not recover the edit to an existing file");
        await drained(reopened);
        assert.equal(reopened.remoteUpdates.hasPending("/Model.tex"), false);
        assert.equal(reopened.remoteUpdates.hasPending("/removed.tex"), true);
        assert.equal(host.remoteText("/removed.tex"), "previous contents");
        assert.equal(remoteOperations(host, "/Model.tex", "write").length, 1);
        assert.equal(remoteOperations(host, "/removed.tex", "delete").length, 0);
    }, {
        beforeStart(host) {
            host.seedLocal("/removed.tex", "previous contents");
            host.seedRemote("/removed.tex", "previous contents");
        },
    }));

test("a missed existing-file event is recovered at an unchanged cloud revision", () =>
    fixture(async (host, provider) => {
        await provider.checkRemoteUpdates();
        host.seedLocal("/Model.tex", "saved by an external tool");
        await provider.checkRemoteUpdates(true);
        assert.equal(provider.remoteUpdates.hasPending("/Model.tex"), false);
        provider.remotePollTimer.tick();
        await eventually(() => host.remoteText("/Model.tex") === "saved by an external tool",
            "the scan did not recover a missed event");
        await drained(provider);
        assert.equal(remoteOperations(host, "/Model.tex", "write").length, 1);
    }));

test("restart keeps both versions when the same tracked file changed on both sides", () =>
    fixture(async (host, provider, _emit, restart) => {
        provider.dispose();
        host.seedRemote("/Model.tex", "independent cloud edit");
        host.seedLocal("/Model.tex", "offline local edit");
        const reopened = await restart();
        assert.ok(reopened.remoteUpdates.hasPending("/Model.tex"));
        await reopened.reconcileLocalEdits(reopened.watchSession);
        host.assertNoRemoteWrites();
        assert.equal(host.remoteText("/Model.tex"), "independent cloud edit");
        assert.equal(host.diskText("/Model.tex"), "offline local edit");
    }));

test("legacy tracking without a verified base leaves divergent files for review", () =>
    fixture(async (host, provider) => {
        await provider.reconcileLocalEdits(provider.watchSession);
        assert.ok(provider.remoteUpdates.hasPending("/Model.tex"));
        host.assertNoRemoteWrites();
        assert.equal(host.diskText("/Model.tex"), "legacy local change");
    }, {
        beforeStart(host) {
            host.seedLocal("/.overleaf/remote-sync-state.json", '{"paths":["/Model.tex"]}');
            host.seedLocal("/Model.tex", "legacy local change");
        },
    }));

test("manual push previews a verified local-only edit as an update", () =>
    fixture(async (host, provider) => {
        host.seedLocal("/Model.tex", "local-only edit");
        host.messageChoices.push(({ message, items }) => {
            assert.match(message, /^Push to Overleaf/);
            assert.match(items[0].detail, /Update \/Model\.tex/);
            return undefined;
        });
        await provider.manualSync("push");
        host.assertNoRemoteWrites();
        assert.equal(host.diskText("/Model.tex"), "local-only edit");
    }, { syncOnChange: false }));

test("a failed manifest write preserves the previous baseline and can be retried", () =>
    fixture(async (host, provider) => {
        const manifestUri = host.localUri("/.overleaf/remote-sync-state.json");
        const before = await host.vscode.workspace.fs.readFile(manifestUri);
        const rename = host.vscode.workspace.fs.rename;
        host.vscode.workspace.fs.rename = async () => { throw new Error("filesystem busy"); };
        await assert.rejects(provider.recordSyncedState("/Model.tex", Buffer.from("verified update")), /filesystem busy/);
        assert.deepEqual(await host.vscode.workspace.fs.readFile(manifestUri), before);
        host.vscode.workspace.fs.rename = rename;
        await provider.recordSyncedState("/Model.tex", Buffer.from("verified update"));
        assert.notDeepEqual(await host.vscode.workspace.fs.readFile(manifestUri), before);
    }));

test("external edits stay local when file-change synchronization is disabled", () =>
    fixture(async (host, provider) => {
        await provider.checkRemoteUpdates();
        host.seedLocal("/Model.tex", "edit with auto sync disabled");
        await provider.checkRemoteUpdates(true);
        assert.ok(provider.remoteUpdates.hasPending("/Model.tex"));
        provider.remotePollTimer.tick();
        await delay(120);
        host.assertNoRemoteWrites();
        assert.equal(host.remoteText("/Model.tex"), "initial");
    }, { syncOnChange: false }));

test("a failed update of an existing file is recovered on the next cloud check", () =>
    fixture(async (host, provider, emit) => {
        await provider.checkRemoteUpdates();
        let failures = 0;
        const writeFile = host.vscode.workspace.fs.writeFile;
        host.vscode.workspace.fs.writeFile = async (uri, bytes) => {
            if (uri.toString() === host.remoteUri("/Model.tex").toString() && !failures++) {
                throw new Error("connection interrupted");
            }
            return writeFile(uri, bytes);
        };
        host.seedLocal("/Model.tex", "retained local edit");
        await emit("change", "/Model.tex");
        await eventually(() => failures > 0, "the initial update was not attempted");
        await drained(provider);
        assert.equal(host.remoteText("/Model.tex"), "initial");
        provider.remotePollTimer.tick();
        await eventually(() => host.remoteText("/Model.tex") === "retained local edit",
            "the failed update was not retried");
        await drained(provider);
        assert.equal(provider.remoteUpdates.hasPending("/Model.tex"), false);
    }));

test("a recovered update passes the verified base to the guarded write", () =>
    fixture(async (host, provider) => {
        let attempted = false;
        host.owner.vfs.writeReviewedFile = async (uri, bytes, base, isCurrent) => {
            assert.equal(uri.toString(), host.remoteUri("/Model.tex").toString());
            assert.equal(base.toString(), "initial");
            assert.equal(bytes.toString(), "local edit");
            assert.equal(isCurrent(), true);
            attempted = true;
            host.seedRemote("/Model.tex", "concurrent remote edit");
            throw Object.assign(new Error("remote changed before write"), { code: "RemoteChanged" });
        };
        host.seedLocal("/Model.tex", "local edit");
        await provider.reconcileLocalEdits(provider.watchSession);
        assert.equal(attempted, true);
        await provider.checkRemoteUpdates(true);
        assert.ok(provider.remoteUpdates.hasPending("/Model.tex"));
        host.assertNoRemoteWrites();
        assert.equal(host.diskText("/Model.tex"), "local edit");
        assert.equal(host.remoteText("/Model.tex"), "concurrent remote edit");
    }));

test("a real populated directory rename needs only the new parent create event", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-replica-directory-move-"));
    try {
        const source = path.join(root, "incoming");
        const replica = path.join(root, "replica");
        await fs.mkdir(path.join(source, "appendix"), { recursive: true });
        await fs.mkdir(replica);
        await fs.writeFile(path.join(source, "main.tex"), "file moved in as part of its directory");
        await fs.writeFile(path.join(source, "appendix", "results.tex"), "nested moved file");

        await fixture(async (host, provider, emit) => {
            const uriBase = host.localUri("/reports").path;
            const isMovedUri = uri => uri.scheme === "file"
                && (uri.path === uriBase || uri.path.startsWith(uriBase + "/"));
            const filePath = uri => path.join(replica, "reports", uri.path.slice(uriBase.length));
            const diskWorkspace = host.vscode.workspace.fs;
            const { stat, readFile, readDirectory } = diskWorkspace;
            const fileType = entry => entry.isSymbolicLink() ? SYMBOLIC_LINK : entry.isDirectory() ? DIRECTORY : 1;

            diskWorkspace.stat = async uri => {
                if (!isMovedUri(uri)) return stat(uri);
                const entry = await fs.lstat(filePath(uri));
                return { type: fileType(entry), mtime: entry.mtimeMs, ctime: entry.ctimeMs, size: entry.size };
            };
            diskWorkspace.readFile = uri => isMovedUri(uri) ? fs.readFile(filePath(uri)) : readFile(uri);
            diskWorkspace.readDirectory = async uri => {
                if (!isMovedUri(uri)) return readDirectory(uri);
                const entries = await fs.readdir(filePath(uri), { withFileTypes: true });
                return entries.map(entry => [entry.name, fileType(entry)]);
            };

            await fs.rename(source, path.join(replica, "reports"));
            await emit("create", "/reports");
            await eventually(() => host.remoteText("/reports/appendix/results.tex") === "nested moved file",
                "directory move did not upload nested results");
            await drained(provider);
            assert.equal(host.remoteText("/reports/main.tex"), "file moved in as part of its directory");
        });
    }
    finally { await fs.rm(root, { recursive: true, force: true }); }
});

for (const { relative, event, expected } of [
    { relative: "/late-creation.tex", event: "create", expected: undefined },
    { relative: "/Model.tex", event: "change", expected: "initial" },
]) {
    test("watcher " + event + " preserves a cloud write arriving immediately before upload", () =>
        fixture(async (host, provider, emit) => {
            let checkedWrite = false;
            host.owner.vfs.writeReviewedFile = async (uri, contents, acceptedCloud, current) => {
                assert.equal(uri.toString(), host.remoteUri(relative).toString());
                assert.equal(acceptedCloud?.toString(), expected);
                assert.equal(contents.toString(), "local attempted content");
                assert.equal(current(), true);
                host.seedRemote(relative, "late independently written cloud content");
                checkedWrite = true;
                throw Object.assign(new Error("remote changed between preflight and update"), { code: "RemoteChanged" });
            };
            host.seedLocal(relative, "local attempted content");
            await emit(event, relative);
            await eventually(() => checkedWrite, "the watcher did not reach the compare-and-write guard");
            await drained(provider);
            assert.equal(host.diskText(relative), "local attempted content");
            assert.equal(host.remoteText(relative), "late independently written cloud content");
            assert.equal(provider.knownRemotePaths.has(relative), expected !== undefined);
            host.assertNoRemoteWrites();
        }));
}

test("an atomic editor replacement of a tracked file is allowed after a create event", () =>
    fixture(async (host, provider, emit) => {
        let accepted = false;
        host.owner.vfs.writeReviewedFile = async (uri, contents, base, current) => {
            assert.equal(uri.toString(), host.remoteUri("/Model.tex").toString());
            assert.equal(base.toString(), "initial");
            assert.equal(current(), true);
            await host.vscode.workspace.fs.writeFile(uri, contents);
            accepted = true;
        };
        host.seedLocal("/Model.tex", "save by rename over tracked file");
        await emit("create", "/Model.tex");
        await eventually(() => accepted, "a create event on a tracked path must preserve its update semantics");
        await drained(provider);
        assert.equal(host.remoteText("/Model.tex"), "save by rename over tracked file");
        assert.ok(provider.knownRemotePaths.has("/Model.tex"));
    }));
