"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SCMCollectionProvider = void 0;
const vscode = require("vscode");
const _1 = require(".");
const localReplicaSCM_1 = require("./localReplicaSCM");
const historyViewProvider_1 = require("./historyViewProvider");
const globalStateManager_1 = require("../utils/globalStateManager");
const eventBus_1 = require("../utils/eventBus");
const consts_1 = require("../consts");
const localReplicaSettings_1 = require("./localReplicaSettings");
const supportedSCMs = [
    localReplicaSCM_1.LocalReplicaSCMProvider,
    // LocalGitBridgeSCMProvider,
];
class CoreSCMProvider extends _1.BaseSCM {
    constructor(vfs) {
        super(vfs, vfs.origin);
        this.vfs = vfs;
    }
    validateBaseUri() { return Promise.resolve(true); }
    async syncFromSCM() { }
    async apply(commitItem) { }
    ;
    get triggers() { return Promise.resolve([]); }
    get settingItems() { return []; }
    writeFile(path, content) {
        const uri = this.vfs.pathToUri(path);
        return vscode.workspace.fs.writeFile(uri, content);
    }
    readFile(path) {
        const uri = this.vfs.pathToUri(path);
        return vscode.workspace.fs.readFile(uri);
    }
    list() {
        return [];
    }
}
class SCMCollectionProvider extends vscode.Disposable {
    constructor(vfs, context, localReplicaBaseUri) {
        // define the dispose behavior
        super(() => {
            this.disposed = true;
            this.localReplicas.forEach(scm => scm.dispose());
            this.scms.forEach(scm => scm.triggers.forEach(t => t.dispose()));
        });
        this.vfs = vfs;
        this.context = context;
        this.localReplicaBaseUri = localReplicaBaseUri;
        this.scms = [];
        this.disposed = false;
        this.pending = new Map();
        this.localReplicas = new Set();
        this.core = new CoreSCMProvider(vfs);
        this.historyDataProvider = new historyViewProvider_1.HistoryViewProvider(vfs);
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
        this.statusBarItem.command = `${consts_1.ROOT_NAME}.projectSCM.configSCM`;
        this.statusListener = eventBus_1.EventBus.on('scmStatusChangeEvent', () => { this.updateStatus(); });
        this.ready = this.initSCMs();
        // Initial activation awaits ready; reconnections already report creation errors.
        void this.ready.catch(() => { });
    }
    updateStatus() {
        if (!this.statusBarItem || this.disposed) {
            return;
        }
        let numPush = 0, numPull = 0, numPending = 0;
        const hasLocalReplica = this.scms.some(item => item.enabled && item.scm instanceof localReplicaSCM_1.LocalReplicaSCMProvider);
        let tooltip = new vscode.MarkdownString(`**${vscode.l10n.t('Project Source Control')}**\n\n`);
        tooltip.supportHtml = true;
        tooltip.supportThemeIcons = true;
        // update status bar item tooltip
        if (this.scms.length === 0) {
            tooltip.appendMarkdown(`*${vscode.l10n.t('Click to configure.')}*\n\n`);
        }
        else {
            for (const { scm, enabled } of this.scms) {
                const icon = scm.iconPath.id;
                const label = scm.constructor.label;
                const uri = scm.baseUri.toString();
                const slideUri = uri.length <= 30 ? uri : uri.replace(/^(.{15}).*(.{15})$/, '$1...$2');
                tooltip.appendMarkdown(`----\n\n$(${icon}) **${label}**: [${slideUri}](${uri})\n\n`);
                //
                if (!enabled) {
                    tooltip.appendMarkdown(`&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;*${vscode.l10n.t('Disabled')}.*\n\n`);
                }
                else if (scm.status.status === 'idle') {
                    tooltip.appendMarkdown(`&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;*${vscode.l10n.t('Synced')}.*\n\n`);
                }
                else {
                    if (scm.status.status === 'need-attention') {
                        numPending++;
                    }
                    // show status message
                    tooltip.appendMarkdown(`&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;***${scm.status.message}***\n\n`);
                    // update counters
                    switch (scm.status.status) {
                        case 'push':
                            numPush++;
                            break;
                        case 'pull':
                            numPull++;
                            break;
                    }
                }
            }
        }
        if (hasLocalReplica) {
            tooltip.appendMarkdown('\n\nClick to choose a Local Replica sync direction.');
        }
        this.statusBarItem.tooltip = tooltip;
        // update status bar item text
        if (numPending !== 0) {
            this.statusBarItem.text = `$(cloud-download) $(warning)`;
        }
        else if (numPush !== 0) {
            this.statusBarItem.text = `$(cloud-upload)`;
        }
        else if (numPull !== 0) {
            this.statusBarItem.text = `$(cloud-download)`;
        }
        else {
            this.statusBarItem.text = `$(cloud)`;
        }
        this.statusBarItem.command = hasLocalReplica ? `${consts_1.ROOT_NAME}.localReplica.pullRemote` : `${consts_1.ROOT_NAME}.projectSCM.configSCM`;
        this.statusBarItem.show();
    }
    async initSCMs() {
        const scmPersists = globalStateManager_1.GlobalStateManager.getServerProjectSCMPersists(this.context, this.vfs.serverName, this.vfs.projectId);
        if (this.localReplicaBaseUri) {
            // Local activation must never restore other historical replica directories.
            const baseUri = this.localReplicaBaseUri;
            const matches = Object.values(scmPersists).filter(item => item.label === localReplicaSCM_1.LocalReplicaSCMProvider.label
                && (0, localReplicaSettings_1.replicaKey)(this.persistedUri(item.baseUri)) === (0, localReplicaSettings_1.replicaKey)(baseUri));
            // Prefer edits saved under the canonical key over older absolute-path records.
            const persist = matches.find(item => item === scmPersists[baseUri.toString()]) ?? matches[0];
            this.vfs.setProjectSCMPersist(baseUri.toString(), {
                enabled: persist?.enabled ?? true,
                label: localReplicaSCM_1.LocalReplicaSCMProvider.label,
                baseUri: baseUri.toString(),
                settings: persist?.settings ?? {},
            });
            const scm = await this.createSCM(localReplicaSCM_1.LocalReplicaSCMProvider, baseUri, false, persist?.enabled ?? true);
            if (!scm && !this.disposed) {
                throw new Error('Local Replica initialization failed');
            }
            return;
        }
        await Promise.all(Object.values(scmPersists).map(async (scmPersist) => {
            const scmProto = supportedSCMs.find(scm => scm.label === scmPersist.label);
            if (scmProto !== undefined) {
                const enabled = scmPersist.enabled ?? true;
                const baseUri = this.persistedUri(scmPersist.baseUri);
                if (!this.vfs.getProjectSCMPersist(baseUri.toString())) {
                    this.vfs.setProjectSCMPersist(baseUri.toString(), { ...scmPersist, baseUri: baseUri.toString() });
                }
                await this.createSCM(scmProto, baseUri, false, enabled);
            }
        }));
    }
    persistedUri(value) {
        return value.startsWith('/') || /^[a-z]:[\\/]/i.test(value) ? vscode.Uri.file(value) : vscode.Uri.parse(value);
    }
    async createSCM(scmProto, baseUri, newSCM = false, enabled = true) {
        if (this.disposed) {
            return undefined;
        }
        if (this.localReplicaBaseUri && (0, localReplicaSettings_1.replicaKey)(baseUri) !== (0, localReplicaSettings_1.replicaKey)(this.localReplicaBaseUri)) {
            return undefined;
        }
        const key = `${scmProto.label}:${(0, localReplicaSettings_1.replicaKey)(baseUri)}`;
        const existing = this.scms.find(item => item.scm instanceof scmProto && (0, localReplicaSettings_1.replicaKey)(item.scm.baseUri) === (0, localReplicaSettings_1.replicaKey)(baseUri));
        if (existing) {
            return existing.scm;
        }
        const pending = this.pending.get(key);
        if (pending) {
            return pending;
        }
        const creating = this.initializeSCM(scmProto, baseUri, newSCM, enabled);
        this.pending.set(key, creating);
        try {
            return await creating;
        }
        finally {
            this.pending.delete(key);
        }
    }
    async initializeSCM(scmProto, baseUri, newSCM, enabled) {
        const scm = new scmProto(this.vfs, baseUri);
        this.localReplicas.add(scm);
        // insert into global state
        if (newSCM) {
            this.vfs.setProjectSCMPersist(scm.scmKey, {
                enabled: enabled,
                label: scmProto.label,
                baseUri: scm.baseUri.toString(),
                settings: {},
            });
        }
        // insert into collection
        try {
            const triggers = enabled ? await scm.triggers : [];
            if (this.disposed) {
                triggers.forEach(trigger => trigger.dispose());
                return undefined;
            }
            this.scms.push({ scm, enabled, triggers });
            this.updateStatus();
            return scm;
        }
        catch (error) {
            scm.dispose();
            this.localReplicas.delete(scm);
            // permanently remove failed scm
            // this.vfs.setProjectSCMPersist(scm.scmKey, undefined);
            vscode.window.showErrorMessage(vscode.l10n.t('"{scm}" creation failed.', { scm: scmProto.label }));
            return undefined;
        }
    }
    removeSCM(item) {
        const index = this.scms.indexOf(item);
        if (index !== -1) {
            // remove from collection
            item.triggers.forEach(trigger => trigger.dispose());
            this.scms.splice(index, 1);
            if (item.scm instanceof localReplicaSCM_1.LocalReplicaSCMProvider) {
                this.localReplicas.delete(item.scm);
            }
            // remove from global state
            this.vfs.setProjectSCMPersist(item.scm.scmKey, undefined);
            this.updateStatus();
        }
    }
    createNewSCM(scmProto) {
        return new Promise(resolve => {
            const inputBox = scmProto.baseUriInputBox;
            inputBox.ignoreFocusOut = true;
            inputBox.title = vscode.l10n.t('Create Source Control: {scm}', { scm: scmProto.label });
            inputBox.buttons = [{ iconPath: new vscode.ThemeIcon('check') }];
            inputBox.show();
            //
            inputBox.onDidTriggerButton(() => {
                inputBox.hide();
                resolve(inputBox.value);
            });
            inputBox.onDidAccept(() => {
                if (inputBox.activeItems.length === 0) {
                    inputBox.hide();
                    resolve(inputBox.value);
                }
            });
        })
            .then((uri) => scmProto.validateBaseUri(uri || '', this.vfs.projectName))
            .then(async (baseUri) => {
            if (baseUri) {
                const scm = await this.createSCM(scmProto, baseUri, true);
                if (scm) {
                    vscode.window.showInformationMessage(vscode.l10n.t('"{scm}" created: {uri}.', { scm: scmProto.label, uri: decodeURI(scm.baseUri.toString()) }));
                }
                else {
                    vscode.window.showErrorMessage(vscode.l10n.t('"{scm}" creation failed.', { scm: scmProto.label }));
                }
            }
        });
    }
    configSCM(scmItem) {
        const baseUri = scmItem.scm.baseUri.toString();
        const settingItems = scmItem.scm.settingItems;
        const status = scmItem.enabled ? scmItem.scm.status.status : 'disabled';
        const quickPickItems = [
            { label: scmItem.enabled ? 'Disable' : 'Enable', description: `Status: ${status}` },
            { label: 'Remove', description: `${baseUri}` },
            { label: '', kind: vscode.QuickPickItemKind.Separator },
            ...settingItems,
        ];
        return vscode.window.showQuickPick(quickPickItems, {
            ignoreFocusOut: true,
            title: vscode.l10n.t('Project Source Control Management'),
        }).then(async (select) => {
            if (select === undefined) {
                return;
            }
            switch (select.label) {
                case 'Enable':
                case 'Disable':
                    const persist = this.vfs.getProjectSCMPersist(scmItem.scm.scmKey);
                    persist.enabled = !(persist.enabled ?? true);
                    this.vfs.setProjectSCMPersist(scmItem.scm.scmKey, persist);
                    //
                    const scmIndex = this.scms.indexOf(scmItem);
                    this.scms[scmIndex].enabled = persist.enabled;
                    if (persist.enabled) {
                        scmItem.triggers = await scmItem.scm.triggers;
                    }
                    else {
                        scmItem.triggers.forEach(trigger => trigger.dispose());
                        scmItem.triggers = [];
                    }
                    this.updateStatus();
                    vscode.window.showWarningMessage(`"${scmItem.scm.constructor.label}" ${persist.enabled ? 'enabled' : 'disabled'}: ${baseUri}.`);
                    break;
                case 'Remove':
                    vscode.window.showWarningMessage(`${vscode.l10n.t('Remove')} ${baseUri}?`, 'Yes', 'No')
                        .then((select) => {
                        if (select === 'Yes') {
                            this.removeSCM(scmItem);
                        }
                    });
                    break;
                default:
                    const settingItem = settingItems.find(item => item.label === select.label);
                    settingItem?.callback();
                    break;
            }
        });
    }
    showSCMConfiguration() {
        // group 1: show existing scms
        const scmItems = this.scms.map((item) => {
            const { scm } = item;
            return {
                label: scm.constructor.label,
                iconPath: scm.iconPath,
                description: scm.baseUri.toString(),
                item,
            };
        });
        if (scmItems.length !== 0) {
            scmItems.push({ kind: vscode.QuickPickItemKind.Separator, label: '' });
        }
        // group 2: create new scm
        const createItems = supportedSCMs.map((scmProto) => {
            return {
                label: vscode.l10n.t('Create Source Control: {scm}', { scm: scmProto.label }),
                scmProto,
            };
        });
        // show quick pick
        vscode.window.showQuickPick([...scmItems, ...createItems], {
            ignoreFocusOut: true,
            title: vscode.l10n.t('Project Source Control Management'),
        }).then((select) => {
            if (select) {
                const _select = select;
                // configure existing scm
                if (_select.item) {
                    this.configSCM(_select.item);
                }
                // create new scm
                if (_select.scmProto) {
                    this.createNewSCM(_select.scmProto);
                }
            }
        });
    }
    async showLocalReplicaSync() {
        await this.ready;
        const replicas = this.scms.filter(item => item.enabled && item.scm instanceof localReplicaSCM_1.LocalReplicaSCMProvider);
        if (!replicas.length) {
            return vscode.window.showInformationMessage('Enable a Local Replica before syncing with Overleaf.');
        }
        const replica = replicas.length === 1 ? replicas[0] : (await vscode.window.showQuickPick(
            replicas.map(item => ({ label: item.scm.baseUri.fsPath, item })),
            { title: 'Overleaf: Choose a Local Replica' }))?.item;
        if (!replica || this.disposed) { return; }
        const choice = await vscode.window.showQuickPick([
            { label: '$(cloud-download) Overleaf → Local', description: 'Pull remote files into this Local Replica', direction: 'pull' },
            { label: '$(cloud-upload) Local → Overleaf', description: 'Push local files, including new files, to Overleaf', direction: 'push' },
        ], { title: 'Overleaf: Choose a Sync Direction' });
        if (!choice || this.disposed || !replica.enabled) { return; }
        try {
            return await replica.scm.manualSync(choice.direction);
        }
        catch {
            await vscode.window.showWarningMessage('Could not complete the manual Overleaf sync. Check the connection and retry.');
        }
    }
    get triggers() {
        return [
            // Register: HistoryViewProvider
            ...this.historyDataProvider.triggers,
            // register status bar item
            this.statusBarItem,
            this.statusListener,
            // register commands
            vscode.commands.registerCommand(`${consts_1.ROOT_NAME}.localReplica.pullRemote`, () => this.showLocalReplicaSync()),
            vscode.commands.registerCommand(`${consts_1.ROOT_NAME}.projectSCM.configSCM`, () => {
                return this.showSCMConfiguration();
            }),
            vscode.commands.registerCommand(`${consts_1.ROOT_NAME}.projectSCM.newSCM`, (scmProto) => {
                return this.createNewSCM(scmProto);
            }),
            this,
        ];
    }
}
exports.SCMCollectionProvider = SCMCollectionProvider;
