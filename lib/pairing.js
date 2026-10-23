import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export const EMPTY_CHANNEL_STATE = { ownerId: '', sessionId: null, pairedAt: '', lastActiveAt: '' };
export const EMPTY_TOKEN_STATE = { botToken: '', botId: '', cursor: '', loginTime: '' };
export class StateStore {
    dir;
    statePath;
    tokenPath;
    owned = false;
    constructor(dir) {
        this.dir = dir;
        this.statePath = join(dir, 'state.json');
        this.tokenPath = join(dir, 'token.json');
        const existed = existsSync(this.dir);
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        // Only tighten a directory this store owns. A misconfigured dataDir such as
        // `~` must never have its permissions rewritten.
        this.owned = !existed || existsSync(this.statePath) || existsSync(this.tokenPath);
        if (this.owned)
            chmodSync(this.dir, 0o700);
    }
    loadState() {
        const data = readJson(this.statePath);
        if (!data)
            return { ...EMPTY_CHANNEL_STATE };
        return {
            ownerId: stringValue(data.owner_id),
            sessionId: stringValue(data.session_id) || null,
            pairedAt: stringValue(data.paired_at),
            lastActiveAt: stringValue(data.last_active_at),
        };
    }
    saveState(state) {
        this.write(this.statePath, {
            owner_id: state.ownerId,
            session_id: state.sessionId ?? '',
            paired_at: state.pairedAt,
            last_active_at: state.lastActiveAt,
        });
    }
    loadToken() {
        const data = readJson(this.tokenPath);
        if (!data)
            return { ...EMPTY_TOKEN_STATE };
        return {
            botToken: stringValue(data.bot_token),
            botId: stringValue(data.ilink_bot_id),
            cursor: stringValue(data.updates_buf),
            loginTime: stringValue(data.login_time),
        };
    }
    saveToken(token) {
        this.write(this.tokenPath, {
            bot_token: token.botToken,
            ilink_bot_id: token.botId,
            updates_buf: token.cursor,
            login_time: token.loginTime,
        });
    }
    write(path, value) {
        this.ensureDir();
        const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        chmodSync(tmp, 0o600);
        renameSync(tmp, path);
    }
    ensureDir() {
        if (!existsSync(this.dir)) {
            mkdirSync(this.dir, { recursive: true, mode: 0o700 });
            this.owned = true;
        }
        if (this.owned)
            chmodSync(this.dir, 0o700);
    }
}
export function newPairingCode() {
    return randomBytes(3).toString('hex').toUpperCase();
}
export function pairingCodeMatches(provided, expected) {
    // Hash normalized values first so comparison time never depends on input length.
    const left = createHash('sha256').update(normalizePairingCode(provided)).digest();
    const right = createHash('sha256').update(normalizePairingCode(expected)).digest();
    return timingSafeEqual(left, right);
}
function normalizePairingCode(value) {
    return value.trim().toUpperCase();
}
function readJson(path) {
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : null;
    }
    catch {
        return null;
    }
}
function stringValue(value) {
    return typeof value === 'string' ? value : '';
}
//# sourceMappingURL=pairing.js.map