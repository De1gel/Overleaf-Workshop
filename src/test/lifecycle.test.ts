/* eslint-disable @typescript-eslint/naming-convention -- External API fixture names are fixed. */
import * as assert from 'assert';
import type * as vscode from 'vscode';
import { SocketIOAPI, OnlineUserSchema } from '../api/socketio';
import { ClientManager } from '../collaboration/clientManager';
import { ChatViewProvider } from '../collaboration/chatViewProvider';
import { EventBus } from '../utils/eventBus';
import { asUri, Disposable, reset, seed, setFolders, settle, state, Uri } from './vscodeMock';

suite('Released project resources', () => {
    setup(reset);

    test('permanent socket disposal removes EventBus handlers while ordinary disconnect can reconnect', () => {
        let disconnects = 0;
        let removed = 0;
        let inits = 0;
        let accepted = 0;
        const transport = {
            on() {}, emit() {},
            disconnect() { disconnects++; },
            removeAllListeners() { removed++; },
        };
        const socket = new SocketIOAPI('https://overleaf.test', {_initSocketV0() { inits++; return transport; }} as any, {} as any, 'project-id');
        socket.updateEventHandlers({onConnectionAccepted: () => { accepted++; }});
        socket.disconnect();
        EventBus.fire('socketioConnectedEvent', {publicId: 'first'});
        assert.strictEqual(accepted, 1, 'ordinary disconnect retains reconnection handlers');
        socket.dispose();
        EventBus.fire('socketioConnectedEvent', {publicId: 'after-dispose'});
        socket.init();
        assert.strictEqual(accepted, 1, 'a released project must not reactivate');
        assert.strictEqual(inits, 1);
        assert.strictEqual(disconnects, 2);
        assert.strictEqual(removed, 1);
        socket.dispose();
        assert.strictEqual(disconnects, 2, 'permanent disposal is idempotent');
    });

    test('client disposal cancels status/inactivity timers and ignores late connected-user responses', async () => {
        const originalSetTimeout = global.setTimeout;
        const originalClearTimeout = global.clearTimeout;
        const timers = new Map<number, () => void>();
        let nextId = 1;
        let triggers: vscode.Disposable[] = [];
        global.setTimeout = ((callback: (...args: any[]) => void, _delay?: number, ...args: any[]) => {
            const id = nextId++;
            timers.set(id, () => callback(...args));
            return id as unknown as NodeJS.Timeout;
        }) as typeof setTimeout;
        global.clearTimeout = ((id: NodeJS.Timeout) => { timers.delete(Number(id)); }) as typeof clearTimeout;
        try {
            const root = Uri.parse('overleaf-workshop://overleaf.test/Project?user=test&project=project-id');
            setFolders(root);
            let respond: (users: OnlineUserSchema[]) => void = () => {};
            const users = new Promise<OnlineUserSchema[]>(resolve => { respond = resolve; });
            const handlers: any[] = [];
            const manager = new ClientManager({
                _resolveById: () => ({path: '/main.tex', fileEntity: {_id: 'doc-id'}}),
                pathToUri: (path: string) => asUri(Uri.joinPath(root, path)),
            } as any, {extensionUri: asUri(Uri.file('/extension'))} as vscode.ExtensionContext, 'self', {
                updateEventHandlers(value: unknown) { handlers.push(value); },
                getConnectedUsers: () => users,
            } as any);
            triggers = manager.triggers;
            manager.setStatusActive('other');
            assert.strictEqual(timers.size, 2);
            triggers.forEach(item => item.dispose());
            assert.strictEqual(timers.size, 0);
            respond([{
                client_id: 'other', user_id: 'other-user', first_name: 'Collaborator', email: 'test@example.test',
                cursorData: {doc_id: 'doc-id', row: 0, column: 0}, last_updated_at: '1', connected: true, client_age: 0,
            }]);
            await Promise.resolve();
            await Promise.resolve();
            assert.strictEqual(state.decorations.length, 0);
            assert.strictEqual(state.statusBars[0].shows, 1);
            assert.strictEqual(state.statusBars[0].disposed, true);
            assert.strictEqual(state.selectionChanged.listeners.size, 0);
            assert.strictEqual(state.visibleEditorsChanged.listeners.size, 0);
            assert.strictEqual(timers.size, 0);
            assert.deepStrictEqual(state.errors, []);
        } finally {
            triggers.forEach(item => item.dispose());
            global.setTimeout = originalSetTimeout;
            global.clearTimeout = originalClearTimeout;
        }
    });
});

suite('Released chat webview resources', () => {
    const extension = Uri.file('/extension');
    const html = Uri.joinPath(extension, 'views/chat-view/dist/index.html');
    let chat: ChatViewProvider;
    let triggers: vscode.Disposable[];
    let handlers: any;
    let messages: unknown[];
    let listeners: Set<(message: any) => void>;
    let webview: any;
    let vfs: {getMessages(): Promise<unknown[]>};

    setup(() => {
        reset();
        seed(html, '<html></html>');
        messages = [];
        listeners = new Set();
        webview = {
            html: '',
            asWebviewUri: (uri: Uri) => uri,
            postMessage: (message: unknown) => { messages.push(message); },
            onDidReceiveMessage: (callback: (message: any) => void) => {
                listeners.add(callback);
                return new Disposable(() => listeners.delete(callback));
            },
        };
        vfs = {async getMessages() { return []; }};
        chat = new ChatViewProvider(vfs as any, 'self', asUri(extension), {
            updateEventHandlers(value: unknown) { handlers = value; },
        } as any);
        triggers = chat.triggers;
    });
    teardown(() => { triggers.forEach(item => item.dispose()); });

    test('clears pending insert retries and ignores callbacks queued before disposal', () => {
        const originalSetTimeout = global.setTimeout;
        const originalClearTimeout = global.clearTimeout;
        const timers = new Map<number, () => void>();
        let nextId = 1;
        global.setTimeout = ((callback: () => void) => {
            const id = nextId++;
            timers.set(id, callback);
            return id as unknown as NodeJS.Timeout;
        }) as typeof setTimeout;
        global.clearTimeout = ((id: NodeJS.Timeout) => { timers.delete(Number(id)); }) as typeof clearTimeout;
        try {
            chat.insertText('first');
            chat.insertText('second');
            const queued = [...timers.values()];
            assert.strictEqual(timers.size, 2);
            const commandsBeforeDispose = state.commandCalls.length;
            triggers.forEach(item => item.dispose());
            assert.strictEqual(timers.size, 0);
            queued.forEach(callback => callback());
            chat.insertText('after disposal');
            assert.strictEqual(timers.size, 0);
            assert.strictEqual(state.commandCalls.length, commandsBeforeDispose);
            assert.strictEqual(messages.length, 0);
        } finally {
            global.setTimeout = originalSetTimeout;
            global.clearTimeout = originalClearTimeout;
        }
    });

    test('does not register a message listener when HTML finishes loading after disposal', async () => {
        let release: () => void = () => {};
        const gate = new Promise<void>(resolve => { release = resolve; });
        state.beforeRead = async () => { await gate; };
        const pending = chat.resolveWebviewView({webview, visible: true} as any, {} as any, {} as any);
        await settle(5);
        triggers.forEach(item => item.dispose());
        release();
        await pending;
        handlers.onReceivedMessage({});
        assert.strictEqual(listeners.size, 0);
        assert.strictEqual(webview.html, '');
        assert.strictEqual(messages.length, 0);
        assert.strictEqual(chat.hasUnread, 0);
    });

    test('removes message listeners and suppresses an in-flight message response after disposal', async () => {
        await chat.resolveWebviewView({webview, visible: true} as any, {} as any, {} as any);
        assert.strictEqual(listeners.size, 1);
        let respond: (value: unknown[]) => void = () => {};
        vfs.getMessages = () => new Promise(resolve => { respond = resolve; });
        [...listeners][0]({type: 'get-messages'});
        triggers.forEach(item => item.dispose());
        respond([]);
        await Promise.resolve();
        handlers.onReceivedMessage({});
        assert.strictEqual(listeners.size, 0);
        assert.strictEqual(messages.length, 0);
    });
});
