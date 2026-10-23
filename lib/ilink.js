import { randomBytes, randomUUID } from 'node:crypto';
import { Agent, fetch } from 'undici';
const BASE = 'https://ilinkai.weixin.qq.com';
const CHANNEL_VERSION = '2.1.10';
const UA = `openclaw-weixin/${CHANNEL_VERSION}`;
const APP_ID = 'bot';
const APP_CLIENT_VERSION = String((2 << 16) | (1 << 8) | 10);
const ITEM_TEXT = 1;
const MSG_BOT = 2;
const STATE_FINISH = 2;
export class WxApiError extends Error {
    errcode;
    constructor(message, errcode = null) {
        super(message);
        this.name = 'WxApiError';
        this.errcode = errcode;
    }
}
export class AuthExpiredError extends WxApiError {
    constructor(message) {
        super(message, -14);
        this.name = 'AuthExpiredError';
    }
}
export class UndiciIlinkHttp {
    dispatchers;
    constructor() {
        this.dispatchers = {
            poll: new Agent({ connections: 1, pipelining: 1 }),
            send: new Agent({ connections: 2, pipelining: 1 }),
            typing: new Agent({ connections: 1, pipelining: 1 }),
        };
    }
    request(url, init, lane) {
        return fetch(url, { ...init, dispatcher: this.dispatchers[lane] });
    }
    async close() {
        await Promise.all(Object.values(this.dispatchers).map(async (dispatcher) => dispatcher.close()));
    }
}
export class IlinkClient {
    token;
    pollTimeoutMs;
    http;
    persistToken;
    constructor(token, options = {}) {
        this.token = { ...token };
        this.pollTimeoutMs = options.pollTimeoutMs ?? 30_000;
        this.http = options.http ?? new UndiciIlinkHttp();
        this.persistToken = options.persistToken ?? (() => undefined);
    }
    hasToken() {
        return this.token.botToken.trim().length > 0;
    }
    async getBotQr(signal) {
        const data = await this.getPublic('ilink/bot/get_bot_qrcode', { bot_type: '3' }, 15_000, signal);
        const qrcodeId = stringValue(data.qrcode);
        const imageContent = stringValue(data.qrcode_img_content);
        if (!qrcodeId || !imageContent)
            throw new WxApiError('get_bot_qrcode 未返回二维码');
        return { qrcodeId, imageContent };
    }
    async getQrStatus(qrcodeId, signal) {
        const data = await this.getPublic('ilink/bot/get_qrcode_status', { qrcode: qrcodeId }, 60_000, signal);
        const status = stringValue(data.status);
        const botToken = stringValue(data.bot_token);
        const botId = stringValue(data.ilink_bot_id);
        return {
            status,
            ...(botToken ? { botToken } : {}),
            ...(botId ? { botId } : {}),
        };
    }
    acceptLogin(status) {
        if (status.status !== 'confirmed' || !status.botToken) {
            throw new WxApiError('扫码成功但接口未返回 bot_token');
        }
        this.token = {
            botToken: status.botToken,
            botId: status.botId ?? '',
            cursor: '',
            loginTime: new Date().toISOString(),
        };
        this.persist();
    }
    async getUpdates(signal) {
        let response;
        try {
            response = await this.post('ilink/bot/getupdates', bodyOf({ get_updates_buf: this.token.cursor }), this.pollTimeoutMs + 5_000, 'poll', signal);
        }
        catch (error) {
            if (error instanceof IlinkTimeoutError)
                return { cursor: this.token.cursor, messages: [] };
            throw error;
        }
        this.raiseForErrcode(response, 'getupdates');
        const nextCursor = stringValue(response.get_updates_buf) || this.token.cursor;
        if (nextCursor !== this.token.cursor) {
            this.token = { ...this.token, cursor: nextCursor };
            this.persist();
        }
        const messages = [];
        const rawMessages = Array.isArray(response.msgs) ? response.msgs : [];
        for (const item of rawMessages) {
            if (!item || typeof item !== 'object')
                continue;
            const message = item;
            messages.push({
                messageId: String(message.message_id ?? ''),
                fromUserId: String(message.from_user_id ?? ''),
                contextToken: String(message.context_token ?? ''),
                text: extractText(message),
                messageType: Number(message.message_type ?? 0),
            });
        }
        return { cursor: nextCursor, messages };
    }
    async sendText(toUserId, text, contextToken, signal) {
        const msg = {
            from_user_id: '',
            to_user_id: toUserId,
            client_id: `pyclient-${randomUUID().replaceAll('-', '').slice(0, 16)}`,
            message_type: MSG_BOT,
            message_state: STATE_FINISH,
            item_list: [{ type: ITEM_TEXT, text_item: { text } }],
        };
        if (contextToken)
            msg.context_token = contextToken;
        const response = await this.post('ilink/bot/sendmessage', bodyOf({ msg }), 20_000, 'send', signal);
        this.raiseForErrcode(response, 'sendmessage');
    }
    async getTypingTicket(toUserId, contextToken, signal) {
        const payload = { ilink_user_id: toUserId };
        if (contextToken)
            payload.context_token = contextToken;
        const response = await this.post('ilink/bot/getconfig', JSON.stringify(payload), 20_000, 'typing', signal);
        this.raiseForErrcode(response, 'getconfig');
        return stringValue(response.typing_ticket);
    }
    async sendTyping(toUserId, ticket, cancel, signal) {
        const response = await this.post('ilink/bot/sendtyping', bodyOf({ ilink_user_id: toUserId, typing_ticket: ticket, status: cancel ? 2 : 1 }), 20_000, 'typing', signal);
        this.raiseForErrcode(response, 'sendtyping');
    }
    close() {
        return this.http.close();
    }
    headers() {
        const headers = {
            'Content-Type': 'application/json',
            AuthorizationType: 'ilink_bot_token',
            'X-WECHAT-UIN': uin(),
            'iLink-App-Id': APP_ID,
            'iLink-App-ClientVersion': APP_CLIENT_VERSION,
            'User-Agent': UA,
        };
        if (this.token.botToken)
            headers.Authorization = `Bearer ${this.token.botToken}`;
        return headers;
    }
    async getPublic(path, params, timeoutMs, signal) {
        const url = new URL(`${BASE}/${path}`);
        for (const [key, value] of Object.entries(params))
            url.searchParams.set(key, value);
        return this.requestJson(url, { headers: { 'User-Agent': UA } }, timeoutMs, 'send', signal, path);
    }
    post(path, body, timeoutMs, lane, signal) {
        return this.requestJson(`${BASE}/${path}`, { method: 'POST', headers: this.headers(), body }, timeoutMs, lane, signal, path);
    }
    async requestJson(url, init, timeoutMs, lane, externalSignal, context) {
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), timeoutMs);
        timer.unref?.();
        const signal = externalSignal ? AbortSignal.any([externalSignal, timeout.signal]) : timeout.signal;
        try {
            const response = await this.http.request(url, { ...init, signal }, lane);
            if (!response.ok)
                throw new WxApiError(`${context} HTTP ${response.status}`);
            const parsed = await response.json();
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                throw new WxApiError(`${context} 返回了非 JSON 对象`);
            }
            return parsed;
        }
        catch (error) {
            if (timeout.signal.aborted && !externalSignal?.aborted)
                throw new IlinkTimeoutError();
            throw error;
        }
        finally {
            clearTimeout(timer);
        }
    }
    raiseForErrcode(response, context) {
        const raw = response.errcode;
        if (raw === undefined || raw === null || raw === 0 || raw === '0')
            return;
        const code = Number(raw);
        const message = `${context}: errcode=${String(raw)} ${String(response.errmsg ?? '')}`.trim();
        if (code === -14) {
            this.token = { botToken: '', botId: '', cursor: '', loginTime: new Date().toISOString() };
            try {
                this.persist();
            }
            catch {
                // Authentication expiry must stop retries even if credential cleanup cannot be written.
            }
            throw new AuthExpiredError(message);
        }
        throw new WxApiError(message, Number.isFinite(code) ? code : null);
    }
    persist() {
        this.persistToken({ ...this.token });
    }
}
export function extractText(message) {
    const items = Array.isArray(message.item_list) ? message.item_list : [];
    const parts = [];
    for (const item of items) {
        if (!item || typeof item !== 'object')
            continue;
        const entry = item;
        if (entry.type !== ITEM_TEXT)
            continue;
        const textItem = entry.text_item;
        if (textItem && typeof textItem === 'object') {
            parts.push(String(textItem.text ?? ''));
        }
    }
    return parts.join('\n');
}
class IlinkTimeoutError extends Error {
}
function uin() {
    return Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64');
}
function bodyOf(params) {
    return JSON.stringify({ ...params, base_info: { channel_version: CHANNEL_VERSION } });
}
function stringValue(value) {
    return typeof value === 'string' ? value : '';
}
//# sourceMappingURL=ilink.js.map