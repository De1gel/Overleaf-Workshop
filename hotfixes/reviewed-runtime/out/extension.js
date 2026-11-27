"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deactivate = exports.activate = void 0;
const vscode = require("vscode");
const consts_1 = require("./consts");
const remoteFileSystemProvider_1 = require("./core/remoteFileSystemProvider");
const projectManagerProvider_1 = require("./core/projectManagerProvider");
const pdfViewEditorProvider_1 = require("./core/pdfViewEditorProvider");
const compileManager_1 = require("./compile/compileManager");
const intellisense_1 = require("./intellisense");
const localReplicaActivation_1 = require("./scm/localReplicaActivation");
function activate(context) {
    const extension = context.extension?.packageJSON;
    if (extension?.overleafWorkshopBuild?.commit) {
        const log = vscode.window.createOutputChannel('Overleaf Workshop', { log: true });
        context.subscriptions.push(log);
        log.info('Activated Overleaf Workshop ' + extension.version +
            ' at ' + extension.overleafWorkshopBuild.commit);
    }
    // Register: [core] RemoteFileSystemProvider
    const remoteFileSystemProvider = new remoteFileSystemProvider_1.RemoteFileSystemProvider(context);
    context.subscriptions.push(...remoteFileSystemProvider.triggers);
    // Register: [core] ProjectManagerProvider on Activitybar
    const projectManagerProvider = new projectManagerProvider_1.ProjectManagerProvider(context);
    context.subscriptions.push(...projectManagerProvider.triggers);
    // Register: [core] PdfViewEditorProvider
    const pdfViewEditorProvider = new pdfViewEditorProvider_1.PdfViewEditorProvider(context);
    context.subscriptions.push(...pdfViewEditorProvider.triggers);
    // Register: [compile] CompileManager on Statusbar
    const compileManager = new compileManager_1.CompileManager(remoteFileSystemProvider);
    context.subscriptions.push(...compileManager.triggers);
    // Register: [intellisense] LangIntellisenseProvider
    const langIntellisenseProvider = new intellisense_1.LangIntellisenseProvider(context, remoteFileSystemProvider);
    context.subscriptions.push(...langIntellisenseProvider.triggers);
    const localReplica = new localReplicaActivation_1.LocalReplicaActivation(remoteFileSystemProvider);
    context.subscriptions.push(localReplica);
    void localReplica.start();
}
exports.activate = activate;
function deactivate() {
    vscode.commands.executeCommand('setContext', `${consts_1.ROOT_NAME}.activate`, false);
    vscode.commands.executeCommand('setContext', `${consts_1.ROOT_NAME}.activateCompile`, false);
}
exports.deactivate = deactivate;
