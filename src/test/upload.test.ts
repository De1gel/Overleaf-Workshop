/* eslint-disable @typescript-eslint/naming-convention -- Overleaf API field names are fixed. */
import * as assert from 'assert';
import { Request, Response, FormData, Headers } from 'undici';
import { BaseAPI, Identity } from '../api/base';

interface CapturedRequest {
    url: URL;
    method: string;
    headers: Headers;
    body: Buffer;
}

// Replace the transport only: the real undici Request encoder produces every
// captured body, and its Response decoder reads those exact bytes back.
suite('HTTP uploads', () => {
    const identity: Identity = {csrfToken: 'test-csrf-token', cookies: 'session=test-session'};
    const baseUrl = 'https://overleaf.test/';
    const transport = require('undici') as {fetch: typeof import('undici').fetch};
    let originalFetch: typeof transport.fetch;
    let requests: CapturedRequest[];
    let api: BaseAPI;
    let reply: (request: CapturedRequest, attempt: number) => Response;

    setup(() => {
        requests = [];
        api = new BaseAPI(baseUrl);
        originalFetch = transport.fetch;
        reply = () => new Response(JSON.stringify({success: true, entity_id: 'uploaded-id', entity_type: 'doc'}));
        transport.fetch = async (url, init) => {
            const request = new Request(url, init);
            const captured = {
                url: new URL(request.url), method: request.method, headers: request.headers,
                body: Buffer.from(await request.arrayBuffer()),
            };
            requests.push(captured);
            return reply(captured, requests.length);
        };
    });

    teardown(() => { transport.fetch = originalFetch; });

    async function multipart(request: CapturedRequest): Promise<FormData> {
        const contentType = request.headers.get('content-type') || '';
        assert.match(contentType, /^multipart\/form-data; boundary=.+/,
            'undici must encode multipart data rather than stringify a legacy form-data object');
        const boundary = /boundary=(.+)/.exec(contentType)![1];
        assert.ok(request.body.includes(Buffer.from(`--${boundary}\r\n`)), 'body uses the advertised boundary');
        assert.ok(request.body.includes(Buffer.from(`--${boundary}--`)), 'body includes the final boundary');
        assert.notStrictEqual(request.body.toString(), '[object FormData]');
        return new Response(request.body, {headers: request.headers}).formData();
    }

    function authenticatedPost(request: CapturedRequest) {
        assert.strictEqual(request.method, 'POST');
        assert.strictEqual(request.headers.get('cookie'), identity.cookies);
        assert.strictEqual(request.headers.get('connection'), 'keep-alive');
    }

    async function uploadedFile(form: FormData, filename: string, mimeType: string, expected: Uint8Array) {
        const file = form.get('qqfile');
        assert.ok(file && typeof file !== 'string', 'qqfile is a file part');
        assert.strictEqual(file.name, filename);
        assert.strictEqual(file.type, mimeType);
        assert.deepStrictEqual(Buffer.from(await file.arrayBuffer()), Buffer.from(expected));
    }

    test('nonempty UTF-8 TeX uploads use multipart with unchanged fields and authentication', async () => {
        const content = Buffer.from('\\section{模型}\nEnergy = \\alpha + β\n', 'utf8');
        const result = await api.uploadFile(identity, 'project-id', 'folder-id', 'Model.tex', content);
        assert.deepStrictEqual(result, {
            type: 'success', entity: {_type: 'doc', _id: 'uploaded-id', name: 'Model.tex'},
        });
        assert.strictEqual(requests.length, 1);
        const request = requests[0];
        authenticatedPost(request);
        assert.strictEqual(request.url.pathname, '/project/project-id/upload');
        assert.strictEqual(request.url.searchParams.get('folder_id'), 'folder-id');
        assert.strictEqual(request.headers.get('x-csrf-token'), identity.csrfToken);
        const form = await multipart(request);
        assert.deepStrictEqual([...form.keys()], ['targetFolderId', 'name', 'type', 'qqfile']);
        assert.strictEqual(form.get('targetFolderId'), 'folder-id');
        assert.strictEqual(form.get('name'), 'Model.tex');
        assert.strictEqual(form.get('type'), 'application/x-tex');
        await uploadedFile(form, 'Model.tex', 'application/x-tex', content);
    });

    test('binary uploads preserve all bytes of a typed-array subrange', async () => {
        const storage = new Uint8Array(260);
        storage.set([17, 18]);
        storage.set(Array.from({length: 256}, (_, i) => i), 2);
        storage.set([19, 20], 258);
        const content = storage.subarray(2, 258);
        await api.uploadFile(identity, 'project-id', 'folder-id', 'diagram.png', content);
        const form = await multipart(requests[0]);
        assert.strictEqual(form.get('type'), 'image/png');
        await uploadedFile(form, 'diagram.png', 'image/png', content);
    });

    test('unknown file extensions retain separate metadata and file-part MIME fallbacks', async () => {
        const content = Buffer.from('custom extension\n');
        await api.uploadFile(identity, 'project-id', 'folder-id', 'notes.unknown-extension', content);
        const form = await multipart(requests[0]);
        assert.strictEqual(form.get('type'), 'text/plain');
        await uploadedFile(form, 'notes.unknown-extension', 'application/octet-stream', content);
    });

    test('empty-document creation retains its JSON endpoint and response', async () => {
        reply = () => new Response(JSON.stringify({_id: 'empty-id'}));
        const result = await api.addDoc(identity, 'project-id', 'folder-id', '11.tex');
        assert.deepStrictEqual(result, {type: 'success', entity: {_type: 'doc', _id: 'empty-id', name: '11.tex'}});
        assert.strictEqual(requests.length, 1);
        const request = requests[0];
        authenticatedPost(request);
        assert.strictEqual(request.url.pathname, '/project/project-id/doc');
        assert.strictEqual(request.headers.get('content-type'), 'application/json');
        assert.strictEqual(request.headers.get('x-csrf-token'), identity.csrfToken);
        assert.deepStrictEqual(JSON.parse(request.body.toString()), {
            _csrf: identity.csrfToken, parent_folder_id: 'folder-id', name: '11.tex',
        });
    });

    test('project archive upload preserves binary bytes and upload query parameters', async () => {
        const content = new Uint8Array([0x50, 0x4b, 3, 4, 0, 0xff, 0x80, 13, 10]);
        reply = () => new Response(JSON.stringify({project_id: 'new-project-id'}));
        const result = await api.uploadProject(identity, 'paper.zip', content);
        assert.deepStrictEqual(result, {type: 'success', message: 'new-project-id'});
        assert.strictEqual(requests.length, 1);
        const request = requests[0];
        authenticatedPost(request);
        assert.strictEqual(request.url.pathname, '/project/new/upload');
        assert.strictEqual(request.url.searchParams.get('_csrf'), identity.csrfToken);
        assert.strictEqual(request.url.searchParams.get('qqfilename'), 'paper.zip');
        assert.strictEqual(request.url.searchParams.get('qqtotalfilesize'), String(content.length));
        assert.match(request.url.searchParams.get('qquuid') || '', /^[0-9a-f-]{36}$/);
        const form = await multipart(request);
        assert.deepStrictEqual([...form.keys()], ['qqfile']);
        await uploadedFile(form, 'paper.zip', 'application/zip', content);
    });

    test('transient HTTP failure replays the complete multipart file after consuming the first body', async () => {
        const content = new Uint8Array([0, 1, 0xff, 0x80, 13, 10]);
        reply = (_request, attempt) => attempt === 1
            ? new Response('temporary server failure', {status: 503})
            : new Response(JSON.stringify({success: true, entity_id: 'uploaded-id', entity_type: 'file'}));
        const result = await api.uploadFile(identity, 'project-id', 'folder-id', 'data.bin', content);
        assert.strictEqual(result.type, 'success');
        assert.strictEqual(requests.length, 2);
        for (const request of requests) {
            authenticatedPost(request);
            assert.strictEqual(request.headers.get('x-csrf-token'), identity.csrfToken);
            const form = await multipart(request);
            assert.strictEqual(form.get('targetFolderId'), 'folder-id');
            assert.strictEqual(form.get('name'), 'data.bin');
            assert.strictEqual(form.get('type'), 'application/octet-stream');
            await uploadedFile(form, 'data.bin', 'application/octet-stream', content);
        }
    });

    test('invalid upload responses remain errors without automatic retries', async () => {
        reply = () => new Response('invalid_upload_request', {status: 400});
        const result = await api.uploadFile(identity, 'project-id', 'folder-id', 'Model.tex', Buffer.from('model'));
        assert.deepStrictEqual(result, {type: 'error', message: '400: invalid_upload_request'});
        assert.strictEqual(requests.length, 1);
        await multipart(requests[0]);
    });
});
