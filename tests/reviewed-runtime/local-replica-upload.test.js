"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const apiModule = process.env.OVERLEAF_API_MODULE ?? path.resolve(
    path.dirname(process.env.OVERLEAF_REPLICA_MODULE ?? path.resolve(__dirname, "../out/scm/localReplicaSCM.js")),
    "../api/base.js");
const dummyIdentity = { csrfToken: "test-token", cookies: "test-session=placeholder" };

function response(status, value) {
    return { status, text: async () => typeof value === "string" ? value : JSON.stringify(value) };
}

function fixture(responses) {
    const module = { exports: {} };
    const requireActual = createRequire(apiModule);
    const requests = [];
    const retryDelays = [];
    const fetch = async (url, options) => {
        requests.push({ url, options });
        assert.ok(responses.length, "unexpected HTTP request");
        const result = responses.shift();
        if (result instanceof Error) throw result;
        return result;
    };
    const evaluate = vm.runInThisContext(
        '(function(require,exports,setTimeout){\n' + fs.readFileSync(apiModule, "utf8") + '\n})',
        { filename: apiModule },
    );
    evaluate(name => name === "undici" ? { fetch } : requireActual(name), module.exports, (resume, timeout) => {
        retryDelays.push(timeout);
        queueMicrotask(resume);
    });
    return {
        api: new module.exports.BaseAPI("https://example.test/"),
        requests,
        retryDelays,
    };
}

function assertMultipart(request, bytes, filename) {
    const { headers, body } = request.options;
    const header = Object.entries(headers).find(([name]) => name.toLowerCase() === "content-type");
    assert.ok(header, "multipart content type missing");
    const match = header[1].match(/^multipart\/form-data;\s*boundary=(.+)$/);
    assert.ok(match, "content type must carry the actual multipart boundary");
    assert.ok(Buffer.isBuffer(body), "fetch must receive multipart bytes");
    assert.ok(body.includes(Buffer.from("--" + match[1] + "\r\n")), "header boundary differs from body");
    assert.ok(body.includes(Buffer.from('name="qqfile"')), "upload part missing");
    assert.ok(body.includes(Buffer.from(filename)), "filename changed");
    assert.ok(body.includes(bytes), "binary file bytes changed");
}

test("new nonempty nested file sends valid multipart with parent ID, filename, and binary data", async () => {
    const { api, requests } = fixture([response(200, { success: true, entity_id: "figure", entity_type: "file" })]);
    const bytes = new Uint8Array([0, 255, 127, 196, 128, 42]);
    const result = await api.uploadFile(dummyIdentity, "project", "reports-parent", "résumé figure.png", bytes);
    assert.deepEqual(result, {
        type: "success",
        entity: { _type: "file", _id: "figure", name: "résumé figure.png" },
    });
    assert.equal(requests[0].url, "https://example.test/project/project/upload?folder_id=reports-parent");
    assertMultipart(requests[0], Buffer.from(bytes), "résumé figure.png");
    assert.match(requests[0].options.body.toString("utf8"), /name="targetFolderId"\r\n\r\nreports-parent/);
});

test("upload retries transient HTTP and transport failures with the same multipart bytes", async () => {
    const transient = Object.assign(new Error("temporary transport failure"), { code: "ECONNRESET" });
    const { api, requests, retryDelays } = fixture([
        response(503, "server retry"), transient,
        response(200, { success: true, entity_id: "doc", entity_type: "doc" }),
    ]);
    const contents = Buffer.from("nonempty TeX");
    const result = await api.uploadFile(dummyIdentity, "project", "chapter", "chapter.tex", contents);
    assert.equal(result.type, "success");
    assert.equal(requests.length, 3);
    assert.deepEqual(retryDelays, [1000, 2000]);
    for (const request of requests) assertMultipart(request, contents, "chapter.tex");
    assert.deepEqual(requests[0].options.body, requests[2].options.body);
});

test("a permanent HTTP failure is not retried", async () => {
    const { api, requests, retryDelays } = fixture([response(400, { success: false, error: "invalid_upload_request" })]);
    const result = await api.uploadFile(dummyIdentity, "project", "chapter", "chapter.tex", Buffer.from("nonempty"));
    assert.equal(result.type, "error");
    assert.equal(requests.length, 1);
    assert.deepEqual(retryDelays, []);
});

test("HTTP 200 without a confirmed entity does not acknowledge synchronization", async () => {
    const { api, requests } = fixture([
        response(200, { success: false, entity_id: "candidate", entity_type: "doc" }),
        response(200, { success: true, entity_id: "", entity_type: "doc" }),
        response(200, "invalid JSON"),
    ]);
    for (let attempt = 0; attempt < 3; attempt++) {
        const result = await api.uploadFile(dummyIdentity, "project", "chapter", "chapter.tex", Buffer.from("nonempty"));
        assert.equal(result.type, "error");
        assert.equal(result.entity, undefined);
    }
    assert.equal(requests.length, 3);
});

test("empty document creation uses a valid JSON parent request", async () => {
    const { api, requests } = fixture([response(200, { _id: "new-doc" })]);
    const result = await api.addDoc(dummyIdentity, "project", "chapter", "11.tex");
    assert.deepEqual(result, { type: "success", entity: { _type: "doc", _id: "new-doc", name: "11.tex" } });
    assert.equal(requests[0].url, "https://example.test/project/project/doc");
    assert.deepEqual(JSON.parse(requests[0].options.body), {
        _csrf: dummyIdentity.csrfToken, parent_folder_id: "chapter", name: "11.tex",
    });
});
