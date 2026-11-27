"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProjectManagerProvider = void 0;
const vscode = require("vscode");
const consts_1 = require("../consts");
const globalStateManager_1 = require("../utils/globalStateManager");
const remoteFileSystemProvider_1 = require("./remoteFileSystemProvider");
const localReplicaSCM_1 = require("../scm/localReplicaSCM");
class DataItem extends vscode.TreeItem {
    constructor(label, collapsibleState) {
        super(label, collapsibleState);
        this.label = label;
    }
}
class ServerItem extends DataItem {
    constructor(api, name, username, collapsibleState) {
        super(name, collapsibleState);
        this.api = api;
        this.name = name;
        this.username = username;
        this.iconPath = new vscode.ThemeIcon('vm');
        this.contextValue = collapsibleState === vscode.TreeItemCollapsibleState.None ? 'server_no_login' : 'server_login';
        this.description = username;
        this.tooltip = api.url;
    }
}
class TagItem extends DataItem {
    constructor(api, serverName, tid, name, projects) {
        super(name, vscode.TreeItemCollapsibleState.Collapsed);
        this.api = api;
        this.serverName = serverName;
        this.tid = tid;
        this.name = name;
        this.projects = projects;
        this.iconPath = new vscode.ThemeIcon('folder');
        this.contextValue = 'tag';
    }
}
class ProjectItem extends DataItem {
    constructor(api, uri, parent, pid, label, status) {
        const _label = status === 'normal' ? label : `[${status}] ${label}`;
        super(_label, vscode.TreeItemCollapsibleState.None);
        this.api = api;
        this.uri = uri;
        this.parent = parent;
        this.pid = pid;
        this.label = label;
        this.status = status;
        this.tooltip = _label;
        this.setStatus(status);
    }
    static clone(project) {
        return new ProjectItem(project.api, project.uri, project.parent, project.pid, project.label, project.status);
    }
    setStatus(status) {
        switch (status) {
            case 'normal':
                this.contextValue = 'project';
                this.iconPath = new vscode.ThemeIcon('notebook');
                break;
            case 'archived':
                this.contextValue = 'archived_project';
                this.iconPath = new vscode.ThemeIcon('archive');
                break;
            case 'trashed':
                this.contextValue = 'trashed_project';
                this.iconPath = new vscode.ThemeIcon('trash');
        }
    }
}
class ProjectManagerProvider {
    constructor(context) {
        this.context = context;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.context = context;
    }
    refresh() {
        this._onDidChangeTreeData.fire();
    }
    getTreeItem(element) {
        return element;
    }
    getChildren(element) {
        if (element) {
            if (element instanceof ServerItem) {
                return globalStateManager_1.GlobalStateManager.fetchServerProjects(this.context, element.api, element.name)
                    .catch(() => {
                    // Direct logout if cookie expired
                    globalStateManager_1.GlobalStateManager.logoutServer(this.context, element.api, element.name)
                        .then(success => {
                        if (success) {
                            this.refresh();
                        }
                    });
                    return Promise.reject();
                })
                    .then(projects => {
                    return globalStateManager_1.GlobalStateManager.authenticate(this.context, element.name)
                        .then(identity => element.api.getAllTags(identity))
                        .then(res => res.type === 'success' ? res.tags : [])
                        .then(tags => {
                        return { projects, tags };
                    });
                })
                    .then(({ projects, tags }) => {
                    const allTags = [];
                    // get project items
                    const normalProjects = [], trashedProjects = [], archivedProjects = [];
                    for (const project of projects) {
                        const uri = `${consts_1.ROOT_NAME}://${element.name}/${encodeURIComponent(project.name)}?user=${project.userId}&project=${project.id}`;
                        const status = project.archived ? 'archived' : project.trashed ? 'trashed' : 'normal';
                        const item = new ProjectItem(element.api, uri, element, project.id, project.name, status);
                        switch (status) {
                            case 'normal':
                                normalProjects.push(item);
                                break;
                            case 'archived':
                                archivedProjects.push(item);
                                break;
                            case 'trashed':
                                trashedProjects.push(item);
                                break;
                        }
                    }
                    const allProjectItems = [...normalProjects, ...archivedProjects, ...trashedProjects];
                    // create tag items
                    const tagProjectItems = tags.map(tag => {
                        const _tag = { name: tag.name, tid: tag._id };
                        allTags.push(_tag);
                        const _projects = tag.project_ids.map(pid => {
                            const item = allProjectItems.find(project => project.pid === pid);
                            if (item) {
                                const _item = ProjectItem.clone(item);
                                item.tag = _tag; // for filter purpose
                                _item.contextValue = 'project_in_tag';
                                _item.tag = _tag;
                                return _item;
                            }
                        }).filter(item => item);
                        return new TagItem(element.api, element.name, tag._id, tag.name, _projects);
                    });
                    // get remaining projects
                    const remainingProjects = allProjectItems.filter(project => !project.tag);
                    // return all items
                    element.tags = allTags;
                    return [...tagProjectItems, ...remainingProjects];
                });
            }
            else if (element instanceof TagItem) {
                return Promise.resolve(element.projects);
            }
            else {
                return Promise.resolve([]);
            }
        }
        else {
            const persists = globalStateManager_1.GlobalStateManager.getServers(this.context);
            const serverItems = Object.values(persists).map(persist => new ServerItem(persist.api, persist.server.name, persist.server.login?.username || '', persist.server.login ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None));
            return Promise.resolve(serverItems);
        }
    }
    addServer() {
        vscode.window.showInputBox({ 'placeHolder': vscode.l10n.t('Overleaf server address, e.g. "https://www.overleaf.com"') })
            .then((url) => {
            if (url) {
                try {
                    // check if url is valid
                    const _url = new URL(url);
                    if (!(_url.protocol === 'http:' || _url.protocol === 'https:')) {
                        throw new Error(vscode.l10n.t('Invalid protocol.'));
                    }
                    if (globalStateManager_1.GlobalStateManager.addServer(this.context, _url.host, _url.href)) {
                        this.refresh();
                    }
                }
                catch (e) {
                    vscode.window.showErrorMessage(vscode.l10n.t('Invalid server address.'));
                }
            }
        });
    }
    removeServer(name) {
        vscode.window.showWarningMessage(vscode.l10n.t('Remove server "{name}" ?', { name }), "Yes", "No")
            .then((answer) => {
            if (answer === "Yes") {
                if (globalStateManager_1.GlobalStateManager.removeServer(this.context, name)) {
                    this.refresh();
                }
            }
        });
    }
    loginServer(server) {
        const loginMethods = {
            // eslint-disable-next-line @typescript-eslint/naming-convention
            'Login with Password': () => {
                vscode.window.showInputBox({ 'placeHolder': vscode.l10n.t('Email') })
                    .then(email => email ? Promise.resolve(email) : Promise.reject())
                    .then(email => vscode.window.showInputBox({ 'placeHolder': vscode.l10n.t('Password'), 'password': true })
                    .then(password => {
                    return password ? Promise.resolve([email, password]) : Promise.reject();
                }))
                    .then(([email, password]) => globalStateManager_1.GlobalStateManager.loginServer(this.context, server.api, server.name, { email, password }))
                    .then(success => {
                    if (success) {
                        this.refresh();
                    }
                    else {
                        vscode.window.showErrorMessage(vscode.l10n.t('Login failed.'));
                    }
                });
            },
            // eslint-disable-next-line @typescript-eslint/naming-convention
            'Login with Cookies': () => {
                vscode.window.showInputBox({
                    'placeHolder': vscode.l10n.t('Cookies, e.g., "sharelatex.sid=..." or "overleaf_session2=..."'),
                    'prompt': vscode.l10n.t('README: [How to Login with Cookies](https://github.com/overleaf-workshop/overleaf-workshop#how-to-login-with-cookies)'),
                })
                    .then(cookies => cookies ? Promise.resolve(cookies) : Promise.reject())
                    .then(cookies => globalStateManager_1.GlobalStateManager.loginServer(this.context, server.api, server.name, { cookies }))
                    .then(success => {
                    if (success) {
                        this.refresh();
                    }
                    else {
                        vscode.window.showErrorMessage(vscode.l10n.t('Login failed.'));
                    }
                });
            },
        };
        //NOTE: temporarily disable password-based login for `www.overleaf.com`
        if (server.name === 'www.overleaf.com') {
            delete loginMethods['Login with Password'];
        }
        vscode.window.showQuickPick(Object.keys(loginMethods), {
            canPickMany: false, placeHolder: vscode.l10n.t('Select the login method below.')
        })
            .then(selection => {
            if (selection === undefined) {
                return Promise.reject();
            }
            return Promise.resolve(loginMethods[selection]);
        })
            .then(method => method());
    }
    logoutServer(server) {
        vscode.window.showWarningMessage(vscode.l10n.t('Logout server "{name}" ?', { name: server.name }), "Yes", "No")
            .then((answer) => {
            if (answer === "Yes") {
                globalStateManager_1.GlobalStateManager.logoutServer(this.context, server.api, server.name)
                    .then(success => {
                    if (success) {
                        this.refresh();
                    }
                });
            }
        });
    }
    refreshServer(server) {
        this.refresh();
    }
    newProject(server) {
        // 'Blank Project', 'Example Project', 'Upload Project'
        vscode.window.showQuickPick([vscode.l10n.t('Blank Project'), vscode.l10n.t('Example Project'), vscode.l10n.t('Upload Project')])
            .then((answer) => {
            switch (answer) {
                case vscode.l10n.t('Blank Project'):
                case vscode.l10n.t('Example Project'):
                    const template = answer === vscode.l10n.t('Example Project') ? 'example' : 'none';
                    vscode.window.showInputBox({ 'placeHolder': vscode.l10n.t('Project name') })
                        .then(name => {
                        if (name) {
                            globalStateManager_1.GlobalStateManager.authenticate(this.context, server.name)
                                .then(identity => server.api.newProject(identity, name, template))
                                .then(res => {
                                if (res.type === 'success') {
                                    this.refresh();
                                }
                                else {
                                    vscode.window.showErrorMessage(res.message);
                                }
                            });
                        }
                    });
                    break;
                case vscode.l10n.t('Upload Project'):
                    vscode.window.showOpenDialog({
                        canSelectFiles: true,
                        canSelectFolders: false,
                        canSelectMany: false,
                        filters: {
                            // eslint-disable-next-line @typescript-eslint/naming-convention
                            'Archive File': ['zip'],
                        },
                        title: vscode.l10n.t('Upload Zipped Project'),
                    }).then((uri) => {
                        if (!uri) {
                            return;
                        }
                        vscode.workspace.fs.readFile(uri[0])
                            .then(fileContent => {
                            const filename = uri[0].path.split('/').pop();
                            if (filename) {
                                globalStateManager_1.GlobalStateManager.authenticate(this.context, server.name)
                                    .then(identity => server.api.uploadProject(identity, filename, fileContent))
                                    .then(res => {
                                    if (res.type === 'success') {
                                        this.refresh();
                                    }
                                    else {
                                        vscode.window.showErrorMessage(res.message);
                                    }
                                });
                            }
                        });
                    });
                    break;
            }
        });
    }
    copyProject(project) {
        vscode.window.showInputBox({
            'placeHolder': vscode.l10n.t('New Project Name'),
            'value': `${project.label} (Copy)`,
            'title': vscode.l10n.t('Copy Project'),
        }).then(name => {
            if (name) {
                globalStateManager_1.GlobalStateManager.authenticate(this.context, project.parent.name)
                    .then(identity => project.api.cloneProject(identity, project.pid, name))
                    .then(res => {
                    if (res.type === 'success') {
                        this.refresh();
                    }
                    else {
                        vscode.window.showErrorMessage(res.message);
                    }
                });
            }
        });
    }
    renameProject(project) {
        vscode.window.showInputBox({
            'placeHolder': vscode.l10n.t('New Project Name'),
            'value': project.label,
        })
            .then(newName => {
            if (newName && newName !== project.label) {
                globalStateManager_1.GlobalStateManager.authenticate(this.context, project.parent.name)
                    .then(identity => project.api.renameProject(identity, project.pid, newName))
                    .then(res => {
                    if (res.type === 'success') {
                        this.refresh();
                    }
                    else {
                        vscode.window.showErrorMessage(res.message);
                    }
                });
            }
        });
    }
    deleteProject(project) {
        vscode.window.showWarningMessage(vscode.l10n.t('Permanently delete project "{label}" ?', { label: project.label }), "Yes", "No")
            .then((answer) => {
            if (answer === "Yes") {
                globalStateManager_1.GlobalStateManager.authenticate(this.context, project.parent.name)
                    .then(identity => project.api.deleteProject(identity, project.pid))
                    .then(res => {
                    if (res.type === 'success') {
                        this.refresh();
                    }
                    else {
                        vscode.window.showErrorMessage(res.message);
                    }
                });
            }
        });
    }
    archiveProject(project) {
        vscode.window.showWarningMessage(vscode.l10n.t('Archive project "{label}" ?', { label: project.label }), "Yes", "No")
            .then((answer) => {
            if (answer === "Yes") {
                globalStateManager_1.GlobalStateManager.authenticate(this.context, project.parent.name)
                    .then(identity => project.api.archiveProject(identity, project.pid))
                    .then(res => {
                    if (res.type === 'success') {
                        this.refresh();
                    }
                    else {
                        vscode.window.showErrorMessage(res.message);
                    }
                });
            }
        });
    }
    unarchiveProject(project) {
        globalStateManager_1.GlobalStateManager.authenticate(this.context, project.parent.name)
            .then(identity => project.api.unarchiveProject(identity, project.pid))
            .then(res => {
            if (res.type === 'success') {
                this.refresh();
            }
            else {
                vscode.window.showErrorMessage(res.message);
            }
        });
    }
    trashProject(project) {
        vscode.window.showWarningMessage(vscode.l10n.t('Move project "{label}" to trash ?', { label: project.label }), "Yes", "No")
            .then((answer) => {
            if (answer === "Yes") {
                globalStateManager_1.GlobalStateManager.authenticate(this.context, project.parent.name)
                    .then(identity => project.api.trashProject(identity, project.pid))
                    .then(res => {
                    if (res.type === 'success') {
                        this.refresh();
                    }
                    else {
                        vscode.window.showErrorMessage(res.message);
                    }
                });
            }
        });
    }
    untrashProject(project) {
        globalStateManager_1.GlobalStateManager.authenticate(this.context, project.parent.name)
            .then(identity => project.api.untrashProject(identity, project.pid))
            .then(res => {
            if (res.type === 'success') {
                this.refresh();
            }
            else {
                vscode.window.showErrorMessage(res.message);
            }
        });
    }
    createTag(server) {
        vscode.window.showInputBox({ 'placeHolder': vscode.l10n.t('Tag name') })
            .then(name => {
            if (name) {
                globalStateManager_1.GlobalStateManager.authenticate(this.context, server.name)
                    .then(identity => server.api.createTag(identity, name))
                    .then(res => {
                    if (res.type === 'success') {
                        this.refresh();
                    }
                    else {
                        vscode.window.showErrorMessage(res.message);
                    }
                });
            }
        });
    }
    renameTag(tag) {
        vscode.window.showInputBox({
            'placeHolder': vscode.l10n.t('New tag name'),
            'value': tag.label,
        })
            .then(newName => {
            if (newName && newName !== tag.label) {
                globalStateManager_1.GlobalStateManager.authenticate(this.context, tag.serverName)
                    .then(identity => tag.api.renameTag(identity, tag.tid, newName))
                    .then(res => {
                    if (res.type === 'success') {
                        this.refresh();
                    }
                    else {
                        vscode.window.showErrorMessage(res.message);
                    }
                });
            }
        });
    }
    deleteTag(tag) {
        vscode.window.showWarningMessage(vscode.l10n.t('Delete tag "{label}" ?', { label: tag.label }), "Yes", "No")
            .then((answer) => {
            if (answer === "Yes") {
                globalStateManager_1.GlobalStateManager.authenticate(this.context, tag.serverName)
                    .then(identity => tag.api.deleteTag(identity, tag.tid))
                    .then(res => {
                    if (res.type === 'success') {
                        this.refresh();
                    }
                    else {
                        vscode.window.showErrorMessage(res.message);
                    }
                });
            }
        });
    }
    addProjectToTag(project) {
        const tagNames = project.parent.tags?.map(tag => tag.name) || [];
        vscode.window.showQuickPick(tagNames, {
            canPickMany: false, placeHolder: vscode.l10n.t('Select the tag below.')
        })
            .then(selection => {
            if (selection === undefined) {
                return Promise.reject();
            }
            return Promise.resolve(selection);
        })
            .then(tagName => {
            const tagId = project.parent.tags?.find(tag => tag.name === tagName)?.tid;
            globalStateManager_1.GlobalStateManager.authenticate(this.context, project.parent.name)
                .then(identity => project.api.addProjectToTag(identity, tagId, project.pid))
                .then(res => {
                if (res.type === 'success') {
                    this.refresh();
                }
                else {
                    vscode.window.showErrorMessage(res.message);
                }
            });
        });
    }
    removeProjectFromTag(project) {
        vscode.window.showWarningMessage(vscode.l10n.t('Remove project "{label}" from tag "{name}" ?', { label: project.label, name: project.tag?.name }), "Yes", "No")
            .then((answer) => {
            if (answer === "Yes") {
                globalStateManager_1.GlobalStateManager.authenticate(this.context, project.parent.name)
                    .then(identity => project.api.removeProjectFromTag(identity, project.tag?.tid, project.pid))
                    .then(res => {
                    if (res.type === 'success') {
                        this.refresh();
                    }
                    else {
                        vscode.window.showErrorMessage(res.message);
                    }
                });
            }
        });
    }
    openProjectInCurrentWindow(project) {
        const uri = vscode.Uri.parse(project.uri);
        vscode.commands.executeCommand('vscode.openFolder', uri, false);
        vscode.commands.executeCommand('workbench.view.explorer');
    }
    openProjectInNewWindow(project) {
        const uri = vscode.Uri.parse(project.uri);
        vscode.commands.executeCommand('vscode.openFolder', uri, true);
        vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        vscode.commands.executeCommand('workbench.view.explorer');
    }
    async openProjectLocalReplica(project) {
        // should close other open vfs firstly
        const vfsFolder = vscode.workspace.workspaceFolders?.find(folder => folder.uri.scheme === consts_1.ROOT_NAME);
        if (vfsFolder) {
            vscode.window.showWarningMessage(vscode.l10n.t('Please close the open remote overleaf folder firstly.'));
            return;
        }
        const uri = vscode.Uri.parse(project.uri);
        const { serverName, projectId } = (0, remoteFileSystemProvider_1.parseUri)(uri);
        // fetch existing local replica scm
        let scmPersists = globalStateManager_1.GlobalStateManager.getServerProjectSCMPersists(this.context, serverName, projectId);
        let replicas = Object.values(scmPersists).filter(scmPersist => scmPersist.label === localReplicaSCM_1.LocalReplicaSCMProvider.label);
        // if not exist, create new one
        if (replicas.length === 0) {
            const vfs = (await (await vscode.commands.executeCommand('remoteFileSystem.prefetch', uri)));
            await vfs.init();
            const answer = await vscode.window.showWarningMessage(vscode.l10n.t('No local replica found, create one for project "{label}" ?', { label: project.label }), "Yes", "No");
            if (answer === "Yes") {
                await (await vscode.commands.executeCommand(`${consts_1.ROOT_NAME}.projectSCM.newSCM`, localReplicaSCM_1.LocalReplicaSCMProvider));
                // fetch local replica scm again
                scmPersists = globalStateManager_1.GlobalStateManager.getServerProjectSCMPersists(this.context, serverName, projectId);
                replicas = Object.values(scmPersists).filter(scmPersist => scmPersist.label === localReplicaSCM_1.LocalReplicaSCMProvider.label);
            }
            else {
                vfs.dispose();
                return;
            }
            vfs.dispose();
        }
        // open local replica
        const replicasPath = replicas.map(scmPersist => vscode.Uri.parse(scmPersist.baseUri).fsPath);
        if (replicasPath.length === 0) {
            return;
        }
        const quickPickItems = replicasPath.map(path => {
            let label = path;
            let buttons = [{
                    id: "removal",
                    iconPath: new vscode.ThemeIcon('trash'),
                    tooltip: vscode.l10n.t('Remove local replica'),
                }];
            return { label, buttons };
        });
        // select local replica via quick pick
        new Promise(resolve => {
            const quickPick = vscode.window.createQuickPick();
            quickPick.placeholder = vscode.l10n.t('Select the local replica below.');
            quickPick.items = quickPickItems;
            quickPick.onDidTriggerItemButton(({ button, item }) => {
                if (button.id === "removal") {
                    vscode.window.showWarningMessage(vscode.l10n.t('Remove local replica "{label}" ?', { label: item.label }), 'Yes', 'No')
                        .then(answer => {
                        if (answer === 'Yes') {
                            // remove local replica from scm persists
                            const scmKey = Object.keys(scmPersists).find(key => vscode.Uri.parse(scmPersists[key].baseUri).fsPath === item.label);
                            globalStateManager_1.GlobalStateManager.updateServerProjectSCMPersist(this.context, serverName, projectId, scmKey);
                            // remove entry from quick pick
                            quickPick.items = quickPick.items.filter(item => item.label !== item.label);
                        }
                    });
                }
            });
            quickPick.onDidAccept(() => {
                const path = quickPick.selectedItems[0]?.label;
                if (path) {
                    quickPick.dispose();
                    resolve(path);
                }
            });
            quickPick.show();
        })
            .then(path => {
            const uri = vscode.Uri.file(path);
            // always open in current window
            vscode.commands.executeCommand('vscode.openFolder', uri, false);
            vscode.commands.executeCommand('workbench.view.explorer');
        });
    }
    get triggers() {
        return [
            // register tree data provider
            vscode.window.registerTreeDataProvider(`${consts_1.ROOT_NAME}.projectManager`, this),
            // register server-related commands
            vscode.commands.registerCommand(`${consts_1.ROOT_NAME}.projectManager.addServer`, () => {
                this.addServer();
            }),
            vscode.commands.registerCommand(`${consts_1.ROOT_NAME}.projectManager.removeServer`, (item) => {
                this.removeServer(item.name);
            }),
            vscode.commands.registerCommand(`${consts_1.ROOT_NAME}.projectManager.loginServer`, (item) => {
                this.loginServer(item);
            }),
            vscode.commands.registerCommand(`${consts_1.ROOT_NAME}.projectManager.logoutServer`, (item) => {
                this.logoutServer(item);
            }),
            vscode.commands.registerCommand(`${consts_1.ROOT_NAME}.projectManager.refreshServer`, (item) => {
                this.refreshServer(item);
            }),
            // register project-related commands
            vscode.commands.registerCommand(`${consts_1.ROOT_NAME}.projectManager.newProject`, (item) => {
                this.newProject(item);
            }),
            vscode.commands.registerCommand(`${consts_1.ROOT_NAME}.projectManager.copyProject`, (item) => {
                this.copyProject(item);
            }),
            vscode.commands.registerCommand(`${consts_1.ROOT_NAME}.projectManager.renameProject`, (item) => {
                this.renameProject(item);
            }),
            vscode.commands.registerCommand(`${consts_1.ROOT_NAME}.projectManager.deleteProject`, (item) => {
                this.deleteProject(item);
            }),
            vscode.commands.registerCommand(`${consts_1.ROOT_NAME}.projectManager.archiveProject`, (item) => {
                this.archiveProject(item);
            }),
            vscode.commands.registerCommand(`${consts_1.ROOT_NAME}.projectManager.unarchiveProject`, (item) => {
                this.unarchiveProject(item);
            }),
            vscode.commands.registerCommand(`${consts_1.ROOT_NAME}.projectManager.trashProject`, (item) => {
                this.trashProject(item);
            }),
            vscode.commands.registerCommand(`${consts_1.ROOT_NAME}.projectManager.untrashProject`, (item) => {
                this.untrashProject(item);
            }),
            // register tag-related commands
            vscode.commands.registerCommand(`${consts_1.ROOT_NAME}.projectManager.createTag`, (item) => {
                this.createTag(item);
            }),
            vscode.commands.registerCommand(`${consts_1.ROOT_NAME}.projectManager.renameTag`, (item) => {
                this.renameTag(item);
            }),
            vscode.commands.registerCommand(`${consts_1.ROOT_NAME}.projectManager.deleteTag`, (item) => {
                this.deleteTag(item);
            }),
            vscode.commands.registerCommand(`${consts_1.ROOT_NAME}.projectManager.addProjectToTag`, (item) => {
                this.addProjectToTag(item);
            }),
            vscode.commands.registerCommand(`${consts_1.ROOT_NAME}.projectManager.removeProjectFromTag`, (item) => {
                this.removeProjectFromTag(item);
            }),
            // register open project commands
            vscode.commands.registerCommand(`${consts_1.ROOT_NAME}.projectManager.openProjectInCurrentWindow`, (item) => {
                this.openProjectInCurrentWindow(item);
            }),
            vscode.commands.registerCommand(`${consts_1.ROOT_NAME}.projectManager.openProjectInNewWindow`, (item) => {
                this.openProjectInNewWindow(item);
            }),
            vscode.commands.registerCommand(`${consts_1.ROOT_NAME}.projectManager.openProjectLocalReplica`, (item) => {
                this.openProjectLocalReplica(item);
            }),
        ];
    }
}
exports.ProjectManagerProvider = ProjectManagerProvider;
