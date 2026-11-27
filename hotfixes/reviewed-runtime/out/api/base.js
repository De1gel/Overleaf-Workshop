"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaseAPI = void 0;
/* eslint-disable @typescript-eslint/naming-convention */
const FormData = require("form-data");
const uuid_1 = require("uuid");
const undici_1 = require("undici");
/** Extract set-cookie headers from an undici/Response object. */
function getSetCookie(res) {
    if (typeof res.headers?.getSetCookie === 'function') {
        return res.headers.getSetCookie();
    }
    const raw = res.headers?.raw?.()?.['set-cookie'];
    if (raw)
        return raw;
    return [];
}
class BaseAPI {
    constructor(url) {
        this.url = url;
    }
    async getCsrfToken() {
        const res = await (0, undici_1.fetch)(this.url + 'login', {
            method: 'GET', redirect: 'manual',
        });
        const body = await res.text();
        const match = body.match(/<input.*name="_csrf".*value="([^"]*)">/);
        if (!match) {
            throw new Error('Failed to get CSRF token.');
        }
        else {
            const csrfToken = match[1];
            const cookies = getSetCookie(res)[0]?.split(';')[0] ?? '';
            return { csrfToken, cookies };
        }
    }
    async getUserId(cookies) {
        const res = await (0, undici_1.fetch)(this.url + 'project', {
            method: 'GET', redirect: 'manual',
            headers: {
                'Connection': 'keep-alive',
                'Cookie': cookies,
            }
        });
        const body = await res.text();
        const userIDMatch = body.match(/<meta\s+name="ol-user_id"\s+content="([^"]*)">/);
        const userEmailMatch = body.match(/<meta\s+name="ol-usersEmail"\s+content="([^"]*)">/);
        const csrfTokenMatch = body.match(/<meta\s+name="ol-csrfToken"\s+content="([^"]*)">/);
        if (userIDMatch !== null && csrfTokenMatch !== null) {
            const userId = userIDMatch[1];
            const csrfToken = csrfTokenMatch[1];
            const userEmail = userEmailMatch ? userEmailMatch[1] : '';
            return { userId, userEmail, csrfToken };
        }
        else {
            return undefined;
        }
    }
    // Reference: "github:overleaf/overleaf/services/web/frontend/js/ide/connection/ConnectionManager.js#L137"
    _initSocketV0(identity, query) {
        const url = new URL(this.url).origin + (query ?? '');
        return require('socket.io-client').connect(url, {
            'auto connect': false, // SocketIOAPI starts it after registering teardown guards.
            // Enable auto-reconnect to avoid creating new TCP connections on transient failures.
            // Creating new connections without proper teardown of old ones causes TCP RST packets
            // when the server sends data on abandoned connections (see issue #309).
            // Note: socket.io-client 0.9.x uses space-separated option names.
            reconnect: true,
            'reconnection delay': 1000,
            'reconnection limit': 16000,
            'max reconnection attempts': 10,
            'force new connection': true,
            extraHeaders: {
                'Origin': new URL(this.url).origin,
                'Cookie': identity.cookies,
            }
        });
    }
    async passportLogin(email, password) {
        const identity = await this.getCsrfToken();
        const res = await (0, undici_1.fetch)(this.url + 'login', {
            method: 'POST', redirect: 'manual',
            headers: {
                'Accept': '*/*',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Content-Type': 'application/json',
                'Cookie': identity.cookies,
                'X-Csrf-Token': identity.csrfToken,
            },
            body: JSON.stringify({ _csrf: identity.csrfToken, email: email, password: password })
        });
        if (res.status === 302) {
            const redirect = (await res.text()).match(/Found. Redirecting to (.*)/)[1];
            if (redirect === '/project') {
                const cookies = getSetCookie(res)[0] ?? '';
                return (await this.cookiesLogin(cookies));
            }
            else {
                return {
                    type: 'error',
                    message: `Redirecting to /${redirect}`
                };
            }
        }
        else if (res.status === 200) {
            return {
                type: 'error',
                message: (await res.json()).message.message
            };
        }
        else if (res.status === 401) {
            return {
                type: 'error',
                message: (await res.json()).message.text
            };
        }
        else {
            return {
                type: 'error',
                message: `${res.status}: ` + await res.text()
            };
        }
    }
    async cookiesLogin(cookies) {
        const res = await this.getUserId(cookies);
        if (res) {
            const { userId, userEmail, csrfToken } = res;
            const identity = await this.updateCookies({ cookies, csrfToken });
            return {
                type: 'success',
                userInfo: { userId, userEmail },
                identity: identity
            };
        }
        else {
            return {
                type: 'error',
                message: 'Failed to get User ID.'
            };
        }
    }
    async updateCookies(identity) {
        const res = await (0, undici_1.fetch)(this.url + 'socket.io/socket.io.js', {
            method: 'GET',
            redirect: 'manual',
            headers: {
                'Connection': 'keep-alive',
                'Cookie': identity.cookies,
            }
        });
        const cookies = getSetCookie(res)[0]?.split(';')[0];
        if (cookies) {
            identity.cookies = `${identity.cookies}; ${cookies}`;
        }
        return identity;
    }
    ;
    setIdentity(identity) {
        this.identity = identity;
        return this;
    }
    /**
     * Check if an HTTP error is transient (worth retrying).
     * Retries on: 5xx server errors, network errors (fetch failures), and 429 rate limiting.
     */
    isTransientError(statusCode, errorMessage) {
        if (statusCode === undefined) {
            // Network-level error (DNS, connection refused, reset, timeout)
            return true;
        }
        // Server errors and rate limiting
        if (statusCode >= 500 || statusCode === 429) {
            return true;
        }
        // Common transient network error messages
        if (errorMessage && (errorMessage.includes('ECONNRESET') ||
            errorMessage.includes('ETIMEDOUT') ||
            errorMessage.includes('ECONNREFUSED') ||
            errorMessage.includes('ENOTFOUND') ||
            errorMessage.includes('socket hang up'))) {
            return true;
        }
        return false;
    }
    async request(type, route, body, callback, extraHeaders) {
        if (this.identity === undefined) {
            return Promise.reject();
        }
        const MAX_HTTP_RETRIES = 2;
        let lastError = {};
        for (let attempt = 0; attempt <= MAX_HTTP_RETRIES; attempt++) {
            try {
                let res = undefined;
                switch (type) {
                    case 'GET':
                        res = await (0, undici_1.fetch)(this.url + route, {
                            method: 'GET', redirect: 'manual',
                            headers: {
                                'Connection': 'keep-alive',
                                'Cookie': this.identity.cookies,
                                ...extraHeaders
                            }
                        });
                        break;
                    case 'POST':
                        const content_type = body instanceof FormData ? body.getHeaders() : { 'Content-Type': 'application/json' };
                        const raw_body = body instanceof FormData ? body.getBuffer() : JSON.stringify({
                            _csrf: this.identity.csrfToken,
                            ...body
                        });
                        res = await (0, undici_1.fetch)(this.url + route, {
                            method: 'POST', redirect: 'manual',
                            headers: {
                                'Connection': 'keep-alive',
                                'Cookie': this.identity.cookies,
                                ...content_type,
                                ...extraHeaders
                            },
                            body: raw_body
                        });
                        break;
                    case 'PUT':
                        break;
                    case 'DELETE':
                        res = await (0, undici_1.fetch)(this.url + route, {
                            method: 'DELETE', redirect: 'manual',
                            headers: {
                                'Connection': 'keep-alive',
                                'Cookie': this.identity.cookies,
                                'X-Csrf-Token': this.identity.csrfToken,
                                ...extraHeaders
                            }
                        });
                        break;
                }
                ;
                if (res && (res.status === 200 || res.status === 204)) {
                    const _res = res.status === 200 ? await res.text() : undefined;
                    const response = callback && callback(_res);
                    return {
                        type: 'success',
                        ...response
                    };
                }
                else if (res && this.isTransientError(res.status) && attempt < MAX_HTTP_RETRIES) {
                    // Transient error: retry with backoff
                    const delayMs = Math.min(1000 * Math.pow(2, attempt), 4000);
                    console.log(`HTTP ${res.status} on ${route}, retrying in ${delayMs}ms (attempt ${attempt + 1}/${MAX_HTTP_RETRIES})`);
                    lastError = { statusCode: res.status, message: await res.text().catch(() => '') };
                    await new Promise(r => setTimeout(r, delayMs));
                    continue;
                }
                else {
                    const resOrFallback = res || { status: 'undefined', text: async () => '' };
                    let errorBody = '';
                    try {
                        errorBody = await resOrFallback.text();
                    }
                    catch {
                        errorBody = '';
                    }
                    return {
                        type: 'error',
                        statusCode: res?.status,
                        message: `${resOrFallback.status}: ${errorBody}`
                    };
                }
            }
            catch (err) {
                const errMsg = err?.message || String(err);
                if (this.isTransientError(undefined, errMsg) && attempt < MAX_HTTP_RETRIES) {
                    const delayMs = Math.min(1000 * Math.pow(2, attempt), 4000);
                    console.log(`HTTP fetch error on ${route}: ${errMsg}, retrying in ${delayMs}ms (attempt ${attempt + 1}/${MAX_HTTP_RETRIES})`);
                    await new Promise(r => setTimeout(r, delayMs));
                    continue;
                }
                return {
                    type: 'error',
                    message: errMsg
                };
            }
        }
        // All retries exhausted
        return {
            type: 'error',
            message: lastError.message || `Request failed after ${MAX_HTTP_RETRIES + 1} attempts`
        };
    }
    async download(route) {
        if (this.identity === undefined) {
            return Promise.reject();
        }
        let content = [];
        while (true) {
            const res = await (0, undici_1.fetch)(this.url + route, {
                method: 'GET', redirect: 'manual',
                headers: {
                    'Connection': 'keep-alive',
                    'Cookie': this.identity.cookies,
                }
            });
            if (res.status === 200) {
                content.push(Buffer.from(await res.arrayBuffer()));
                break;
            }
            else if (res.status === 206) {
                content.push(Buffer.from(await res.arrayBuffer()));
            }
            else {
                break;
            }
        }
        ;
        return Buffer.concat(content);
    }
    async logout(identity) {
        this.setIdentity(identity);
        return this.request('POST', 'logout');
    }
    async userProjectsJson(identity) {
        this.setIdentity(identity);
        return this.request('GET', 'user/projects', undefined, (res) => {
            const projects = JSON.parse(res).projects;
            projects.forEach(project => {
                project.id = project._id;
                delete project._id;
            });
            return { projects };
        });
    }
    async getProjectsJson(identity) {
        this.setIdentity(identity);
        return this.request('POST', 'api/project', {}, (res) => {
            const projects = JSON.parse(res).projects;
            return { projects };
        });
    }
    async projectEntitiesJson(identity, projectId) {
        this.setIdentity(identity);
        return this.request('GET', `project/${projectId}/entities`, undefined, (res) => {
            const entities = JSON.parse(res).entities;
            return { entities };
        });
    }
    async newProject(identity, projectName, template) {
        this.setIdentity(identity);
        return this.request('POST', 'project/new', { projectName, template }, (res) => {
            const message = JSON.parse(res).project_id;
            return { message };
        });
    }
    async cloneProject(identity, projectId, projectName) {
        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/clone`, { projectName }, (res) => {
            const message = JSON.parse(res).project_id;
            return { message };
        });
    }
    async renameProject(identity, projectId, newProjectName) {
        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/rename`, { newProjectName });
    }
    async deleteProject(identity, projectId) {
        this.setIdentity(identity);
        return this.request('DELETE', `project/${projectId}`);
    }
    async archiveProject(identity, projectId) {
        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/archive`, undefined, undefined, { 'X-Csrf-Token': identity.csrfToken });
    }
    async unarchiveProject(identity, projectId) {
        this.setIdentity(identity);
        return this.request('DELETE', `project/${projectId}/archive`);
    }
    async trashProject(identity, projectId) {
        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/trash`, undefined, undefined, { 'X-Csrf-Token': identity.csrfToken });
    }
    async untrashProject(identity, projectId) {
        this.setIdentity(identity);
        return this.request('DELETE', `project/${projectId}/trash`);
    }
    async getFile(identity, projectId, fileId) {
        this.setIdentity(identity);
        const content = await this.download(`project/${projectId}/file/${fileId}`);
        return {
            type: 'success',
            content: new Uint8Array(content)
        };
    }
    async addDoc(identity, projectId, parentFolderId, filename) {
        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/doc`, { parent_folder_id: parentFolderId, name: filename }, (res) => {
            const { _id } = JSON.parse(res);
            const entity = { _type: 'doc', _id, name: filename };
            return { entity };
        }, { 'X-Csrf-Token': identity.csrfToken });
    }
    async uploadFile(identity, projectId, parentFolderId, filename, fileContent) {
        const fileBuffer = Buffer.from(fileContent);
        const formData = new FormData();
        const mimeType = require('mime-types').lookup(filename);
        formData.append('targetFolderId', parentFolderId);
        formData.append('name', filename);
        formData.append('type', mimeType ? mimeType : 'text/plain');
        formData.append('qqfile', fileBuffer, { filename });
        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/upload?folder_id=${parentFolderId}`, formData, (res) => {
            let response;
            try { response = JSON.parse(res); }
            catch { return { type: 'error', message: 'The upload response was not valid JSON.' }; }
            const { success, entity_id, entity_type } = response ?? {};
            if (success !== true || typeof entity_id !== 'string' || !entity_id
                || !['doc', 'file'].includes(entity_type)) {
                return { type: 'error', message: 'The upload response did not confirm a valid remote file.' };
            }
            const entity = { _type: entity_type, _id: entity_id, name: filename };
            return { entity };
        }, { 'X-Csrf-Token': identity.csrfToken });
    }
    async uploadProject(identity, filename, fileContent) {
        const uuid = (0, uuid_1.v4)();
        const fileBuffer = Buffer.from(fileContent);
        const formData = new FormData();
        formData.append('qqfile', fileBuffer, { filename });
        this.setIdentity(identity);
        return this.request('POST', `project/new/upload?_csrf=${identity.csrfToken}&qquuid=${uuid}&qqfilename=${filename}&qqtotalfilesize=${fileContent.length}`, formData, (res) => {
            const message = JSON.parse(res).project_id;
            return { message };
        });
    }
    async addFolder(identity, projectId, folderName, parentFolderId) {
        const body = { name: folderName, parent_folder_id: parentFolderId };
        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/folder`, body, (res) => {
            const entity = JSON.parse(res);
            return { entity };
        }, { 'X-Csrf-Token': identity.csrfToken });
    }
    async deleteEntity(identity, projectId, fileType, fileId) {
        this.setIdentity(identity);
        return this.request('DELETE', `project/${projectId}/${fileType}/${fileId}`);
    }
    async deleteAuxFiles(identity, projectId) {
        this.setIdentity(identity);
        return this.request('DELETE', `project/${projectId}/output`);
    }
    async renameEntity(identity, projectId, entityType, entityId, name) {
        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/${entityType}/${entityId}/rename`, { name }, undefined, { 'X-Csrf-Token': identity.csrfToken });
    }
    async moveEntity(identity, projectId, entityType, entityId, newParentFolderId) {
        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/${entityType}/${entityId}/move`, { folder_id: newParentFolderId }, undefined, { 'X-Csrf-Token': identity.csrfToken });
    }
    async compile(identity, projectId, rootResourcePath, draft = false, stopOnFirstError = false) {
        const body = {
            check: 'silent',
            draft,
            incrementalCompilesEnabled: true,
            rootResourcePath,
            stopOnFirstError
        };
        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/compile?auto_compile=true`, body, (res) => {
            const compile = JSON.parse(res);
            return { compile };
        }, { 'X-Csrf-Token': identity.csrfToken });
    }
    async stopCompile(identity, projectId) {
        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/compile/stop`, undefined, undefined, { 'X-Csrf-Token': identity.csrfToken });
    }
    async indexAll(identity, projectId) {
        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/references/indexAll`, { shouldBroadcast: false }, undefined);
    }
    async getMetadata(identity, projectId) {
        this.setIdentity(identity);
        return this.request('GET', `project/${projectId}/metadata`, undefined, (res) => {
            const meta = JSON.parse(res);
            return { meta };
        });
    }
    async proxyRequestToSpellingApi(identity, language, userId, words) {
        const body = {
            language,
            skipLearnedWords: true,
            token: userId,
            words
        };
        this.setIdentity(identity);
        return this.request('POST', 'spelling/check', body, (res) => {
            const misspellings = JSON.parse(res).misspellings;
            return { misspellings };
        });
    }
    async spellingControllerLearn(identity, userId, word) {
        const body = {
            token: userId,
            word
        };
        this.setIdentity(identity);
        return this.request('POST', 'spelling/learn', body);
    }
    async spellingControllerUnlearn(identity, word) {
        this.setIdentity(identity);
        return this.request('POST', 'spelling/unlearn', { word }, undefined, { 'X-Csrf-Token': identity.csrfToken });
    }
    async getProjectSettings(identity, projectId) {
        this.setIdentity(identity);
        return this.request('GET', `project/${projectId}`, undefined, (res) => {
            const body = res || '';
            // parse "ol-learnedWords"
            const learnedWordsMatch = /<meta\s+name="ol-learnedWords"\s+data-type="json"\s+content="(\[.*?\])">/.exec(body);
            const learnedWords = (learnedWordsMatch !== null) ? JSON.parse(learnedWordsMatch[1].replace(/&quot;/g, '"')) : [];
            // parse "ol-languages"
            const languagesMatch = /<meta\s+name="ol-languages"\s+data-type="json"\s+content="(\[.*?\])">/.exec(body);
            const languages = (languagesMatch !== null) ? JSON.parse(languagesMatch[1].replace(/&quot;/g, '"')) : [];
            languages.length && languages.unshift({ name: 'Off', code: '' });
            // fill in compilers
            const compilers = [
                { code: 'pdflatex', name: 'pdfLaTex' },
                { code: 'latex', name: 'LaTex' },
                { code: 'xelatex', name: 'XeLaTex' },
                { code: 'lualatex', name: 'LuaLaTex' },
            ];
            // return parsed results
            const settings = { learnedWords, languages, compilers };
            return { settings };
        });
    }
    async updateProjectSettings(identity, projectId, setting) {
        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/settings`, setting);
    }
    async getFileFromClsi(identity, url, compileGroup, clsiServerId, pdfDownloadDomain) {
        // If we have a CDN download domain, construct the full URL with required query params.
        // The CDN is cross-origin, so we must NOT send web frontend cookies.
        if (pdfDownloadDomain && clsiServerId) {
            const cdnUrl = `${pdfDownloadDomain.replace(/\/+$/, '')}/${url.replace(/^\/+/g, '')}` +
                `?compileGroup=${encodeURIComponent(compileGroup)}` +
                `&clsiserverid=${encodeURIComponent(clsiServerId)}` +
                `&enable_pdf_caching=true`;
            const content = await this._downloadAbsolute(cdnUrl, false);
            return { type: 'success', content: new Uint8Array(content) };
        }
        // Fallback: download from web frontend (legacy path)
        url = url.replace(/^\/+/g, '');
        this.setIdentity(identity);
        const content = await this.download(url);
        return {
            type: 'success',
            content: new Uint8Array(content)
        };
    }
    /** Download from an absolute URL, optionally including web frontend cookies. */
    async _downloadAbsolute(absoluteUrl, includeCookies) {
        const headers = {
            'Connection': 'keep-alive',
        };
        if (includeCookies && this.identity) {
            headers['Cookie'] = this.identity.cookies;
        }
        let content = [];
        while (true) {
            const res = await (0, undici_1.fetch)(absoluteUrl, {
                method: 'GET', redirect: 'manual',
                headers
            });
            if (res.status === 200) {
                content.push(Buffer.from(await res.arrayBuffer()));
                break;
            }
            else if (res.status === 206) {
                content.push(Buffer.from(await res.arrayBuffer()));
            }
            else {
                break;
            }
        }
        return Buffer.concat(content);
    }
    async proxySyncPdf(identity, projectId, page, h, v, buildId) {
        this.setIdentity(identity);
        const request = `project/${projectId}/sync/pdf?page=${page}&h=${h.toFixed(2)}&v=${v.toFixed(2)}&editorId=${(0, uuid_1.v4)()}&buildId=${buildId}`;
        return this.request('GET', `project/${projectId}/sync/pdf?page=${page}&h=${h.toFixed(2)}&v=${v.toFixed(2)}&editorId=${(0, uuid_1.v4)()}&buildId=${buildId}`, undefined, (res) => {
            const syncPdf = JSON.parse(res).code[0];
            return { syncPdf };
        });
    }
    async proxySyncCode(identity, projectId, file, line, column, buildId) {
        this.setIdentity(identity);
        return this.request('GET', `project/${projectId}/sync/code?file=${file}&line=${line}&column=${column}&editorId=${(0, uuid_1.v4)()}&buildId=${buildId}`, undefined, (res) => {
            const syncCode = JSON.parse(res).pdf;
            return { syncCode };
        });
    }
    async getAllTags(identity) {
        this.setIdentity(identity);
        return this.request('GET', 'tag', undefined, (res) => {
            const tags = JSON.parse(res);
            return { tags };
        });
    }
    async createTag(identity, name) {
        this.setIdentity(identity);
        return this.request('POST', 'tag', { name }, (res) => {
            const tags = JSON.parse(res);
            return { tags };
        });
    }
    async renameTag(identity, tagId, name) {
        this.setIdentity(identity);
        return this.request('POST', `tag/${tagId}/rename`, { name });
    }
    async deleteTag(identity, tagId) {
        this.setIdentity(identity);
        return this.request('DELETE', `tag/${tagId}`);
    }
    async addProjectToTag(identity, tagId, projectId) {
        this.setIdentity(identity);
        return this.request('POST', `tag/${tagId}/project/${projectId}`);
    }
    async removeProjectFromTag(identity, tagId, projectId) {
        this.setIdentity(identity);
        return this.request('DELETE', `tag/${tagId}/project/${projectId}`);
    }
    async proxyToHistoryApiAndGetUpdates(identity, projectId, before) {
        const beforeQuery = before ? `&before=${before}` : '';
        this.setIdentity(identity);
        return this.request('GET', `project/${projectId}/updates?min_count=10${beforeQuery}`, undefined, (res) => {
            const updates = JSON.parse(res);
            return { updates };
        });
    }
    async proxyToHistoryApiAndGetFileDiff(identity, projectId, pathname, from, to) {
        this.setIdentity(identity);
        return this.request('GET', `project/${projectId}/diff?pathname=${pathname}&from=${from}&to=${to}`, undefined, (res) => {
            const diff = JSON.parse(res);
            return { diff };
        });
    }
    async proxyToHistoryApiAndGetFileTreeDiff(identity, projectId, from, to) {
        this.setIdentity(identity);
        return this.request('GET', `project/${projectId}/filetree/diff?from=${from}&to=${to}`, undefined, (res) => {
            const treeDiff = JSON.parse(res);
            return { treeDiff };
        });
    }
    async downloadZipOfVersion(identity, projectId, version) {
        this.setIdentity(identity);
        const content = await this.download(`project/${projectId}/version/${version}/zip`);
        return {
            type: 'success',
            content: new Uint8Array(content)
        };
    }
    async getLabels(identity, projectId) {
        this.setIdentity(identity);
        return this.request('GET', `project/${projectId}/labels`, undefined, (res) => {
            const labels = JSON.parse(res);
            return { labels };
        });
    }
    async createLabel(identity, projectId, comment, version) {
        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/labels`, { comment, version }, (res) => {
            const labels = [JSON.parse(res)];
            return { labels };
        });
    }
    async deleteLabel(identity, projectId, labelId) {
        this.setIdentity(identity);
        return this.request('DELETE', `project/${projectId}/labels/${labelId}`);
    }
    async getMessages(identity, projectId, limit = 50) {
        this.setIdentity(identity);
        return this.request('GET', `project/${projectId}/messages?limit=${limit}`, undefined, (res) => {
            const messages = JSON.parse(res);
            return { messages };
        }, { 'X-Csrf-Token': identity.csrfToken });
    }
    async sendMessage(identity, projectId, client_id, content) {
        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/messages`, { client_id, content }, undefined, { 'X-Csrf-Token': identity.csrfToken });
    }
}
exports.BaseAPI = BaseAPI;
