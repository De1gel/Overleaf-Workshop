'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { MockAgent, getGlobalDispatcher, setGlobalDispatcher } = require('undici');
const loadSource = require('./helpers/load-source.cjs');
const { BaseAPI } = loadSource('src/api/base.ts');

const origin = 'https://overleaf-upload.test';
const identity = { csrfToken: 'test-csrf', cookies: 'session=test-session' };

function requestHeaders(headers) {
  if (Array.isArray(headers)) {
    const result = {};
    for (let index = 0; index < headers.length; index += 2) {
      result[String(headers[index]).toLowerCase()] = String(headers[index + 1]);
    }
    return result;
  }
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value)]));
}

function multipartParts(options) {
  const headers = requestHeaders(options.headers);
  const boundaryMatch = /multipart\/form-data;\s*boundary=([^;]+)/i.exec(headers['content-type']);
  assert.ok(boundaryMatch, 'upload must declare a multipart boundary');
  assert.ok(Buffer.isBuffer(options.body) || options.body instanceof Uint8Array,
    'upload body must be serialized bytes, not a form-data object or its string representation');
  const body = Buffer.from(options.body);
  const delimiter = Buffer.from(`--${boundaryMatch[1]}`);
  assert.ok(body.subarray(0, delimiter.length).equals(delimiter));
  assert.ok(body.includes(Buffer.from(`${delimiter.toString()}--\r\n`)), 'multipart body must be terminated');
  const parts = {};
  let cursor = 0;
  while (true) {
    const start = body.indexOf(delimiter, cursor);
    if (start < 0 || body.subarray(start + delimiter.length, start + delimiter.length + 2).toString() === '--') break;
    const headerStart = start + delimiter.length + 2;
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), headerStart);
    assert.ok(headerEnd >= 0);
    const next = body.indexOf(Buffer.from(`\r\n--${boundaryMatch[1]}`), headerEnd + 4);
    assert.ok(next >= 0);
    const partHeaders = body.subarray(headerStart, headerEnd).toString('utf8');
    const name = /\bname="([^"]+)"/.exec(partHeaders);
    assert.ok(name);
    parts[name[1]] = {
      filename: /\bfilename="([^"]+)"/.exec(partHeaders)?.[1],
      content: body.subarray(headerEnd + 4, next),
    };
    cursor = next + 2;
  }
  return { parts, headers, body };
}

function mockServer(t) {
  const previous = getGlobalDispatcher();
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  t.after(async () => {
    setGlobalDispatcher(previous);
    await agent.close();
  });
  return agent.get(origin);
}

function fastRetryDelays(t) {
  const realSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) =>
    realSetTimeout(callback, [1000, 2000, 4000].includes(delay) ? 0 : delay, ...args));
}

const files = [
  ['isttt27.bst', Buffer.from('ENTRY { title author } {} {}\n% Unicode: é 中文\n')],
  ['isttt27.sty', Buffer.from('\\ProvidesPackage{example}\n\\newcommand{\\example}{é}\n')],
  ['references.bib', Buffer.from('@article{test, title={Multimodal travel}}\n')],
  ['example_figure.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0x0d, 0x0a, 0xff, 0x80])],
  ['isttt27_logo.jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x80, 0, 0xff, 0xd9])],
];

for (const [filename, expected] of files) {
  test(`new ${filename} is uploaded as a complete multipart file without changing its bytes`, async t => {
    const pool = mockServer(t);
    let checked = false;
    pool.intercept({ path: '/project/project-id/upload?folder_id=folder-id', method: 'POST' })
      .reply(options => {
        const { parts, headers } = multipartParts(options);
        assert.equal(headers['x-csrf-token'], identity.csrfToken);
        assert.equal(headers.cookie, identity.cookies);
        assert.equal(parts.name.content.toString(), filename);
        assert.equal(parts.targetFolderId.content.toString(), 'folder-id');
        assert.equal(parts.qqfile.filename, filename);
        assert.deepEqual(parts.qqfile.content, expected);
        checked = true;
        return { statusCode: 200, data: JSON.stringify({ success: true, entity_id: 'new-file', entity_type: 'file' }) };
      });
    const result = await new BaseAPI(`${origin}/`).uploadFile(identity, 'project-id', 'folder-id', filename, expected);
    assert.equal(result.type, 'success', result.message);
    assert.equal(checked, true);
    assert.deepEqual(result.entity, { _type: 'file', _id: 'new-file', name: filename });
  });
}

test('Uint8Array views upload only their selected bytes', async t => {
  const pool = mockServer(t);
  const storage = Uint8Array.from([99, 1, 0, 255, 88]);
  const input = storage.subarray(1, 4);
  pool.intercept({ path: '/project/project-id/upload?folder_id=folder-id', method: 'POST' })
    .reply(options => {
      assert.deepEqual(multipartParts(options).parts.qqfile.content, Buffer.from([1, 0, 255]));
      return { statusCode: 200, data: JSON.stringify({ success: true, entity_id: 'view', entity_type: 'file' }) };
    });
  const result = await new BaseAPI(`${origin}/`).uploadFile(identity, 'project-id', 'folder-id', 'data.bin', input);
  assert.equal(result.type, 'success', result.message);
});

for (const [label, response] of [
  ['server rejects upload despite HTTP 200', { success: false, error: 'invalid_upload_request' }],
  ['successful response has no entity id', { success: true, entity_type: 'file' }],
  ['successful response has an empty entity id', { success: true, entity_id: '', entity_type: 'file' }],
  ['successful response has an unknown entity type', { success: true, entity_id: 'new-file', entity_type: 'folder' }],
]) {
  test(`${label} cannot be reported as a successful upload`, async t => {
    const pool = mockServer(t);
    fastRetryDelays(t);
    pool.intercept({ path: '/project/project-id/upload?folder_id=folder-id', method: 'POST' })
      .reply(200, JSON.stringify(response)).persist();
    const result = await new BaseAPI(`${origin}/`).uploadFile(identity, 'project-id', 'folder-id', 'isttt27.bst', Buffer.from('style'));
    assert.equal(result.type, 'error');
    assert.equal(result.entity, undefined);
    assert.ok(result.message, 'a failed upload must explain why it failed');
  });
}

test('retry after HTTP 503 sends the full multipart body again', async t => {
  const pool = mockServer(t);
  fastRetryDelays(t);
  const expected = files[4][1];
  const bodies = [];
  for (const statusCode of [503, 200]) {
    pool.intercept({ path: '/project/project-id/upload?folder_id=folder-id', method: 'POST' })
      .reply(options => {
        const { parts, body } = multipartParts(options);
        assert.deepEqual(parts.qqfile.content, expected);
        bodies.push(body);
        return { statusCode, data: JSON.stringify(statusCode === 200
          ? { success: true, entity_id: 'retry-file', entity_type: 'file' }
          : { error: 'temporarily_unavailable' }) };
      });
  }
  const result = await new BaseAPI(`${origin}/`).uploadFile(identity, 'project-id', 'folder-id', 'logo.jpeg', expected);
  assert.equal(result.type, 'success', result.message);
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0], bodies[1], 'retry must not consume or truncate the original upload stream');
});

test('ZIP project upload also preserves binary data and a multipart boundary', async t => {
  const pool = mockServer(t);
  const expected = Buffer.from([0x50, 0x4b, 3, 4, 0, 0x80, 0xff, 0]);
  pool.intercept({ path: /^\/project\/new\/upload\?/, method: 'POST' })
    .reply(options => {
      const { parts } = multipartParts(options);
      assert.equal(parts.qqfile.filename, 'project.zip');
      assert.deepEqual(parts.qqfile.content, expected);
      return { statusCode: 200, data: JSON.stringify({ project_id: 'imported-project' }) };
    });
  const result = await new BaseAPI(`${origin}/`).uploadProject(identity, 'project.zip', expected);
  assert.equal(result.type, 'success', result.message);
  assert.equal(result.message, 'imported-project');
});

for (const [label, responseBody] of [
  ['non-JSON response', '<html>Upload response unavailable</html>'],
  ['JSON null response', 'null'],
]) {
  test(`HTTP 200 ${label} returns an error without submitting the file again`, async t => {
    const pool = mockServer(t);
    fastRetryDelays(t);
    let attempts = 0;
    pool.intercept({ path: '/project/project-id/upload?folder_id=folder-id', method: 'POST' })
      .reply(options => {
        multipartParts(options);
        attempts += 1;
        return { statusCode: 200, data: responseBody };
      }).persist();
    const result = await new BaseAPI(`${origin}/`).uploadFile(
      identity, 'project-id', 'folder-id', 'isttt27.bst', Buffer.from('style'),
    );
    assert.equal(result.type, 'error');
    assert.equal(result.entity, undefined);
    assert.ok(result.message);
    assert.equal(attempts, 1, 'an unreadable application response must not replay a potentially committed upload');
  });
}
