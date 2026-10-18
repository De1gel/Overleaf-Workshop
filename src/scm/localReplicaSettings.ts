import * as vscode from 'vscode';
import * as path from 'path';
import { ROOT_NAME } from '../consts';

export interface LocalReplicaSettings {
    uri: string;
    enableCompileNPreview?: boolean;
    [key: string]: unknown;
}

export interface LocalReplica {
    baseUri: vscode.Uri;
    settings: LocalReplicaSettings;
}

export function replicaKey(uri: vscode.Uri): string {
    const key = uri.with({path: uri.path.replace(/\/+$/, '') || '/', query: '', fragment: ''}).toString();
    return process.platform==='win32' ? key.toLowerCase() : key;
}

export function containsLocalUri(baseUri: vscode.Uri, uri: vscode.Uri): boolean {
    if (baseUri.scheme!==uri.scheme || baseUri.authority!==uri.authority) { return false; }
    const basePath = baseUri.path.replace(/\/+$/, '') + '/';
    return uri.path.startsWith(basePath);
}

/** Only inspect workspace roots and explicitly configured directories; never scan recursively. */
export async function discoverLocalReplicas(): Promise<LocalReplica[]> {
    const candidates = new Map<string, vscode.Uri>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        if (folder.uri.scheme!=='file') { continue; }
        candidates.set(replicaKey(folder.uri), folder.uri);
        const configured = vscode.workspace.getConfiguration('overleaf-workshop.localReplica', folder.uri).get<unknown>('paths', []);
        if (!Array.isArray(configured)) { continue; }
        for (const entry of configured) {
            if (typeof entry!=='string' || entry.trim()==='' || entry.includes('\0')) { continue; }
            const absolute = path.resolve(folder.uri.fsPath, entry);
            // A relative path must stay inside its owning workspace folder.
            const relative = path.relative(folder.uri.fsPath, absolute);
            if (!path.isAbsolute(entry) && (relative==='..' || relative.startsWith('..'+path.sep))) { continue; }
            const baseUri = vscode.Uri.file(absolute);
            candidates.set(replicaKey(baseUri), baseUri);
        }
    }

    const replicas: LocalReplica[] = [];
    for (const baseUri of candidates.values()) {
        try {
            const stat = await vscode.workspace.fs.stat(baseUri);
            if (stat.type!==vscode.FileType.Directory) { continue; }
            const content = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(baseUri, '.overleaf/settings.json'));
            const settings = JSON.parse(new TextDecoder().decode(content));
            if (!settings || typeof settings.uri!=='string') { continue; }
            const remoteUri = vscode.Uri.parse(settings.uri, true);
            const query = new URLSearchParams(remoteUri.query);
            if (remoteUri.scheme!==ROOT_NAME || !remoteUri.authority || remoteUri.path==='/' || !remoteUri.path
                || !query.get('user') || !query.get('project')) { continue; }
            replicas.push({baseUri, settings});
        } catch {
            // Missing directories, unreadable settings and invalid JSON are not replicas.
        }
    }
    return replicas;
}

/** The existing global commands and webviews support one active replica per window. */
export function selectLocalReplica(replicas: LocalReplica[]): LocalReplica | undefined {
    return replicas[0];
}
