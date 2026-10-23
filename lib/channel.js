import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { AuthExpiredError, IlinkClient, WxApiError, } from './ilink.js';
import { StateStore, newPairingCode, pairingCodeMatches } from './pairing.js';
import { QuotaLedger, quotaWarningText } from './quota.js';
import { TASK_HEADING, cleanForWeChat, extractPlainAssistantText, extractPreToolText, looksLikeTaskUnderstanding, splitChunks, withChunkPrefix, } from './text.js';
const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const SEEN_LIMIT = 5_000;
const SEEN_TRIM = 2_000;
const DEFAULT_SETTLE_MS = 5_000;
export class WeChatChannel {
    ctx;
    config;
    log;
    store;
    client;
    sessions;
    workspaces;
    injectedConfirm;
    attachedSessions = new Set();
    quota = new QuotaLedger();
    seen = new Set();
    seenOrder = [];
    lifecycle = new AbortController();
    sleep;
    now;
    settleTimeoutMs;
    announce;
    timers = new Set();
    state;
    pairingCode = '';
    pairFailures = 0;
    busy = false;
    stopReason = '';
    turn = null;
    activeSessionId = null;
    activeFollow = null;
    loopTask = null;
    turnTask = null;
    authExpired = false;
    constructor(ctx, config, dependencies = {}) {
        this.ctx = ctx;
        this.config = config;
        this.log = ctx.logger('wechat-channel');
        this.store = dependencies.store ?? new StateStore(config.dataDir);
        this.state = this.store.loadState();
        this.sessions = dependencies.sessionController ?? ctx.sessionController;
        this.workspaces = dependencies.workspaceRegistry;
        this.injectedConfirm = dependencies.taskConfirm;
        this.client = dependencies.client ?? new IlinkClient(this.store.loadToken(), {
            pollTimeoutMs: config.pollTimeoutMs,
            persistToken: (token) => this.store.saveToken(token),
        });
        this.sleep = dependencies.sleep ?? sleep;
        this.now = dependencies.now ?? (() => new Date());
        this.settleTimeoutMs = dependencies.settleTimeoutMs ?? DEFAULT_SETTLE_MS;
        this.announce = dependencies.announce ?? ((line) => process.stdout.write(`${line}\n`));
    }
    start() {
        if (!this.state.ownerId) {
            this.pairingCode = newPairingCode();
            this.announce(`PAIRING_CODE=${this.pairingCode}`);
            this.log.info('未配对：配对码已写入本机启动日志（PAIRING_CODE=…）');
        }
        const polling = this.client.hasToken();
        if (!polling) {
            this.log.warn('尚未登录微信，请先运行扫码登录');
        }
        else {
            this.loopTask = this.pollLoop().catch((error) => {
                if (!this.lifecycle.signal.aborted)
                    this.log.error(`轮询已停止: ${errorName(error)}`);
            });
        }
        if (this.state.sessionId) {
            void this.attachToWorkspace(this.state.sessionId).catch((error) => {
                this.log.warn(`关联工作区失败: ${errorName(error)}`);
            });
        }
        const detachArchive = this.watchWorkspaceArchival();
        this.announce(`[wechat-channel] started paired=${this.state.ownerId ? 'yes' : 'no'} polling=${polling ? 'yes' : 'no'}`);
        return async () => {
            detachArchive();
            this.announce('[wechat-channel] stopped');
            this.lifecycle.abort();
            await this.cancelActiveTurn('服务退出');
            this.clearTimers();
            await this.finishFollow();
            await Promise.allSettled([this.loopTask, this.turnTask].filter(isPromise));
            await this.client.close();
        };
    }
    async dispatch(message) {
        if (this.authExpired)
            return;
        if (!message.messageId || this.seen.has(message.messageId) || message.messageType !== 1)
            return;
        this.remember(message.messageId);
        if (!message.fromUserId)
            return;
        const text = message.text.trim();
        if (!this.state.ownerId) {
            if (text)
                await this.handleUnpaired(message, text);
            return;
        }
        if (message.fromUserId !== this.state.ownerId) {
            this.log.info('忽略非 owner 消息');
            return;
        }
        if (!text) {
            await this.send(message, '目前只支持文字消息。');
            return;
        }
        if (text.startsWith('/')) {
            await this.handleCommand(message, text);
            return;
        }
        this.beginTurn(message, text);
    }
    isBusy() {
        return this.busy;
    }
    currentState() {
        return { ...this.state };
    }
    pairingCodeForTest() {
        return this.pairingCode;
    }
    async pollLoop() {
        let backoff = BACKOFF_START_MS;
        while (!this.lifecycle.signal.aborted && !this.authExpired) {
            try {
                const page = await this.client.getUpdates(this.lifecycle.signal);
                backoff = BACKOFF_START_MS;
                for (const message of page.messages) {
                    if (this.lifecycle.signal.aborted || this.authExpired)
                        return;
                    try {
                        await this.dispatch(message);
                    }
                    catch (error) {
                        if (error instanceof AuthExpiredError)
                            throw error;
                        this.log.warn(`消息处理失败: ${errorName(error)}`);
                    }
                }
            }
            catch (error) {
                if (error instanceof AuthExpiredError) {
                    this.expireAuthentication();
                    return;
                }
                if (this.lifecycle.signal.aborted || this.authExpired)
                    return;
                this.log.warn(error instanceof WxApiError ? `iLink 错误: ${error.errcode ?? 'unknown'}` : `轮询异常: ${errorName(error)}`);
                await this.sleep(backoff, this.lifecycle.signal);
                backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
            }
        }
    }
    remember(messageId) {
        this.seen.add(messageId);
        this.seenOrder.push(messageId);
        if (this.seenOrder.length > SEEN_LIMIT) {
            for (const old of this.seenOrder.splice(0, SEEN_TRIM))
                this.seen.delete(old);
        }
    }
    async handleUnpaired(message, text) {
        if (!this.pairingCode)
            return;
        if (!text.toLowerCase().startsWith('/pair')) {
            this.log.info('忽略未配对用户的消息');
            return;
        }
        const provided = text.split(/\s+/, 2)[1] ?? '';
        if (!pairingCodeMatches(provided, this.pairingCode)) {
            this.pairFailures += 1;
            this.log.warn(`配对码错误（第 ${this.pairFailures} 次）`);
            if (this.pairFailures <= 5)
                await this.send(message, '配对码不正确。');
            return;
        }
        this.state = {
            ownerId: message.fromUserId,
            sessionId: null,
            pairedAt: localTimestamp(this.now()),
            lastActiveAt: '',
        };
        this.store.saveState(this.state);
        this.pairingCode = '';
        this.announce('PAIRING_OK=yes');
        this.log.info('配对成功');
        await this.send(message, '配对成功。直接把任务发给我即可。\n注意：本机器人拥有本机完整操作权限，仅限你本人使用。\n发送 /help 查看命令。');
    }
    async handleCommand(message, text) {
        const command = text.split(/\s+/, 1)[0]?.toLowerCase() ?? '';
        switch (command) {
            case '/help':
            case '/?':
                await this.send(message, [
                    '可用命令：',
                    '/new 开启新会话',
                    '/stop 停止当前任务或取消待确认任务',
                    '/status 查看状态',
                    '/help 查看帮助',
                    '',
                    '涉及改文件、执行命令的任务会先给出【任务理解】，回复「继续」后才会执行；回复「取消」放弃。',
                    '',
                    '直接发消息 = 交给本机 DeepSeek Harness 执行。',
                ].join('\n'));
                return;
            case '/new':
            case '/reset':
                if (this.busy) {
                    await this.send(message, '任务执行中，先发送 /stop 停止后再开启新会话。');
                    return;
                }
                this.cancelPendingConfirmation();
                this.state = { ...this.state, sessionId: null };
                this.store.saveState(this.state);
                this.quota.reset(message.contextToken);
                await this.send(message, '已开启新会话。');
                return;
            case '/stop':
            case '/abort':
                if (!this.busy) {
                    await this.send(message, this.cancelPendingConfirmation() ? '已取消等待确认的任务。' : '当前没有正在执行的任务。');
                    return;
                }
                this.stopReason = '用户停止';
                await this.send(message, '正在停止……');
                await this.cancelActiveTurn('用户停止');
                return;
            case '/status': {
                const status = this.busy ? '执行中' : this.pendingConfirmation() ? '待确认' : '空闲';
                await this.send(message, [
                    `状态：${status}`,
                    `会话：${this.state.sessionId ?? '未开始'}`,
                    `模型：${await this.sessionPreset()}`,
                    `工作目录：${this.config.cwd}`,
                    `任务超时：${timeoutMinutes(this.config.taskTimeoutMs)} 分钟`,
                    `确认插件：${this.taskConfirm() ? '已连接' : '未连接'}`,
                    `工作区：${this.workspaceRegistry() ? '已连接' : '未连接'}`,
                ].join('\n'));
                return;
            }
            case '/pair':
                await this.send(message, '已经配对过了。');
                return;
            default:
                await this.send(message, '未知命令。发送 /help 查看可用命令。');
        }
    }
    beginTurn(message, text) {
        if (this.busy) {
            void this.send(message, '上一条任务仍在执行，请稍候；发送 /stop 可中止。').catch((error) => {
                this.log.warn(`忙碌提示发送失败: ${errorName(error)}`);
            });
            return;
        }
        this.busy = true;
        this.turnTask = this.runTurn(message, text)
            .catch((error) => this.log.error(`任务根流程异常: ${errorName(error)}`))
            .finally(() => {
            this.turnTask = null;
        });
    }
    async runTurn(message, text) {
        this.stopReason = '';
        const turn = new AbortController();
        this.turn = turn;
        const timeout = this.addTimeout(() => {
            void this.cancelActiveTurn(`超时（${timeoutMinutes(this.config.taskTimeoutMs)} 分钟）`)
                .catch((error) => this.log.warn(`超时取消失败: ${errorName(error)}`));
        }, this.config.taskTimeoutMs);
        let typingTicket = '';
        let typingTimer = null;
        let sessionReady = false;
        try {
            typingTicket = await this.tryTypingTicket(message);
            if (typingTicket) {
                await this.tryTyping(message, typingTicket, false);
                typingTimer = this.addInterval(() => {
                    void this.tryTyping(message, typingTicket, false).catch((error) => {
                        if (!(error instanceof AuthExpiredError))
                            this.log.info(`输入状态刷新失败: ${errorName(error)}`);
                    });
                }, this.config.typingRefreshMs);
            }
            if (turn.signal.aborted)
                return;
            const session = await this.ensureSession(turn.signal);
            sessionReady = true;
            const resetNotice = session.archivedReset
                ? (session.pendingLost
                    ? '（上一个会话已在电脑端被归档，待确认的任务已取消，已开启新会话）'
                    : '（上一个会话已在电脑端被归档，已开启新会话）')
                : session.idleReset
                    ? this.idleResetNotice()
                    : '';
            this.touchActivity();
            this.activeSessionId = session.sessionId;
            if (resetNotice)
                await this.send(message, resetNotice);
            if (session.resumeFailed) {
                await this.send(message, '（上一次会话无法恢复，已开启新会话）');
            }
            const result = await this.runPrompt(session.sessionId, text, turn.signal);
            if (turn.signal.aborted) {
                if (!this.lifecycle.signal.aborted)
                    await this.send(message, this.stopMessage());
                return;
            }
            const pending = result.awaitingConfirm || this.pendingConfirmation();
            const reply = result.text || (pending ? '已了解任务，回复「继续」开始执行，回复「取消」放弃。' : '（本轮没有文字输出）');
            const note = result.maxTokens ? '\n\n（本轮回答达到长度上限，可能不完整）' : '';
            const delivery = await this.send(message, `${reply}${note}`);
            if (delivery !== 'ok')
                this.log.warn(`回复投递状态: ${delivery}`);
            this.state = { ...this.state, sessionId: session.sessionId };
            this.store.saveState(this.state);
        }
        catch (error) {
            if (error instanceof TurnBlockedError) {
                this.rotateBlockedSession();
                await this.send(message, '任务被阻止（会话可能已在电脑端被归档），已开启新会话，请重新发送任务。');
            }
            else if (turn.signal.aborted) {
                if (!this.lifecycle.signal.aborted)
                    await this.send(message, this.stopMessage());
            }
            else if (error instanceof AuthExpiredError) {
                this.log.warn('发送消息时发现微信登录已失效');
            }
            else {
                this.log.error(`任务执行失败: ${errorName(error)}`);
                await this.send(message, `执行出错：${shortError(error)}`);
            }
        }
        finally {
            if (sessionReady)
                this.touchActivity();
            this.clearTimer(timeout);
            if (typingTimer)
                this.clearTimer(typingTimer);
            try {
                if (typingTicket && !this.authExpired)
                    await this.tryTyping(message, typingTicket, true);
            }
            catch (error) {
                if (!(error instanceof AuthExpiredError))
                    this.log.info(`输入状态取消失败: ${errorName(error)}`);
            }
            finally {
                await this.finishFollow();
                this.busy = false;
                this.turn = null;
                this.activeSessionId = null;
            }
        }
    }
    async runPrompt(sessionId, text, signal) {
        const stream = this.sessions.follow({ address: { kind: 'session', sessionId } }, signal);
        const iterator = stream[Symbol.asyncIterator]();
        this.activeFollow = iterator;
        const finalTexts = [];
        const marker = this.taskConfirm()?.marker ?? TASK_HEADING;
        let fallbackTaskText = '';
        let awaitingConfirm = false;
        let maxTokens = false;
        try {
            // follow() is lazy: pull its opening snapshot before prompt admission.
            const opening = await this.nextFrame(iterator, signal);
            if (opening.done || opening.value.type !== 'snapshot')
                throw new Error('follow 未返回 snapshot');
            const request = {
                requestId: randomUUID(),
                sessionId,
                mode: 'queue',
                content: [{ type: 'text', text }],
            };
            await this.sessions.prompt(request, signal);
            while (true) {
                const next = await this.nextFrame(iterator, signal);
                if (next.done)
                    break;
                const frame = next.value;
                if (frame.type !== 'event')
                    continue;
                if (frame.event.type === 'turn/end') {
                    const failure = turnFailure(frame.event.data);
                    if (failure.kind === 'blocked')
                        throw new TurnBlockedError();
                    if (failure.kind === 'max-tokens')
                        maxTokens = true;
                    if (failure.message)
                        throw new Error(failure.message);
                    if (!KNOWN_TURN_END.has(failure.kind)) {
                        this.log.warn(`未知的 turn 结束原因: ${failure.kind}`);
                    }
                    break;
                }
                if (frame.event.type !== 'assistant/message')
                    continue;
                const content = eventMessageContent(frame.event.data);
                const [preToolText, hasToolCall] = extractPreToolText(content);
                if (hasToolCall) {
                    if (!fallbackTaskText && preToolText && looksLikeTaskUnderstanding(preToolText, marker)) {
                        fallbackTaskText = preToolText;
                        awaitingConfirm = true;
                    }
                    continue;
                }
                const plainText = extractPlainAssistantText(content);
                if (!plainText)
                    continue;
                finalTexts.push(plainText);
                if (looksLikeTaskUnderstanding(plainText, marker))
                    awaitingConfirm = true;
            }
            const answer = finalTexts.join('\n').trim();
            const merged = fallbackTaskText && !answer.includes(fallbackTaskText)
                ? [fallbackTaskText, answer].filter(Boolean).join('\n\n')
                : answer;
            return { text: merged || fallbackTaskText, awaitingConfirm, maxTokens };
        }
        finally {
            await this.finishFollow(this.activeFollow === iterator ? iterator : null);
        }
    }
    nextFrame(iterator, signal) {
        return abortAware(iterator.next(), signal, this.settleTimeoutMs);
    }
    rotateBlockedSession() {
        const sessionId = this.activeSessionId ?? this.state.sessionId;
        if (sessionId) {
            try {
                this.taskConfirm()?.cancel(sessionId);
            }
            catch {
                // Confirmation state lives in the host; a failing cancel must not block rotation.
            }
            this.attachedSessions.delete(sessionId);
        }
        this.state = { ...this.state, sessionId: null };
        try {
            this.store.saveState(this.state);
        }
        catch (error) {
            this.log.warn(`保存状态失败: ${errorName(error)}`);
        }
        this.announce('[wechat-channel] turn blocked, session rotated');
    }
    isArchivedSession(sessionId) {
        const registry = this.workspaceRegistry();
        const archived = registry?.archivedSessionIds;
        return Array.isArray(archived) && archived.includes(sessionId);
    }
    async ensureSession(signal) {
        const stored = this.state.sessionId;
        // An archived session still inspects fine but rejects every step, so the
        // host ends the turn as `blocked`; rotate instead of failing the task.
        const archived = stored !== null && this.isArchivedSession(stored);
        const pending = this.pendingConfirmation();
        if (stored && (archived || (this.idleResetDue() && !pending))) {
            const created = await this.createSession(stored);
            return {
                sessionId: created,
                resumeFailed: false,
                idleReset: !archived,
                archivedReset: archived,
                pendingLost: archived && pending,
            };
        }
        if (stored) {
            try {
                await this.sessions.inspect(stored, signal);
            }
            catch {
                if (signal.aborted)
                    throw signal.reason ?? new Error('aborted');
                const created = await this.createSession(stored);
                return { sessionId: created, resumeFailed: true, idleReset: false, archivedReset: false, pendingLost: false };
            }
            await this.attachToWorkspace(stored);
            return { sessionId: stored, resumeFailed: false, idleReset: false, archivedReset: false, pendingLost: false };
        }
        const created = await this.createSession(null);
        return { sessionId: created, resumeFailed: false, idleReset: false, archivedReset: false, pendingLost: false };
    }
    async createSession(previous) {
        if (previous) {
            if (this.pendingConfirmation()) {
                try {
                    this.taskConfirm()?.cancel(previous);
                }
                catch {
                    // Best effort: the archived session's confirmation is orphaned either way.
                }
            }
            this.attachedSessions.delete(previous);
        }
        const created = await this.sessions.create({ cwd: this.config.cwd });
        this.state = { ...this.state, sessionId: created.sessionId };
        this.store.saveState(this.state);
        await this.attachToWorkspace(created.sessionId);
        return created.sessionId;
    }
    idleResetDue() {
        const minutes = this.config.sessionIdleResetMinutes;
        if (!Number.isFinite(minutes) || minutes <= 0)
            return false;
        if (!this.state.sessionId || !this.state.lastActiveAt)
            return false;
        const last = Date.parse(this.state.lastActiveAt);
        if (!Number.isFinite(last))
            return false;
        return this.now().getTime() - last >= minutes * 60_000;
    }
    idleResetNotice() {
        const last = Date.parse(this.state.lastActiveAt);
        const gap = Number.isFinite(last)
            ? this.now().getTime() - last
            : this.config.sessionIdleResetMinutes * 60_000;
        return `（闲置超过 ${formatIdleGap(gap)}，已开启新会话）`;
    }
    touchActivity() {
        this.state = { ...this.state, lastActiveAt: this.now().toISOString() };
        try {
            this.store.saveState(this.state);
        }
        catch (error) {
            this.log.warn(`保存活动时间失败: ${errorName(error)}`);
        }
    }
    async sessionPreset() {
        const sessionId = this.state.sessionId;
        if (!sessionId)
            return '未开始';
        try {
            const inspection = await this.sessions.inspect(sessionId);
            return inspection.meta.agentPreset ?? '由 profile 决定';
        }
        catch {
            return '由 profile 决定';
        }
    }
    workspaceRegistry() {
        if (this.workspaces)
            return this.workspaces;
        try {
            return this.ctx.get('workspaceRegistry');
        }
        catch {
            return undefined;
        }
    }
    taskConfirm() {
        if (this.injectedConfirm)
            return this.injectedConfirm;
        try {
            return this.ctx.get('taskConfirm');
        }
        catch {
            return undefined;
        }
    }
    pendingConfirmation() {
        const sessionId = this.state.sessionId;
        if (!sessionId)
            return false;
        try {
            return this.taskConfirm()?.phase(sessionId) === 'pending';
        }
        catch {
            return false;
        }
    }
    cancelPendingConfirmation() {
        const sessionId = this.state.sessionId;
        if (!sessionId)
            return false;
        try {
            return this.taskConfirm()?.cancel(sessionId) === true;
        }
        catch {
            return false;
        }
    }
    watchWorkspaceArchival() {
        try {
            const on = this.ctx.on;
            if (typeof on !== 'function')
                return () => undefined;
            return on.call(this.ctx, 'workspace/session-stop', (request) => {
                if (!this.busy || !this.activeSessionId)
                    return;
                if (request?.sessionId !== this.activeSessionId)
                    return;
                this.log.warn('微信会话已在电脑端归档，正在取消当前任务');
                this.announce('[wechat-channel] session archived, cancelling turn');
                void this.cancelActiveTurn('会话已在电脑端归档').catch((error) => {
                    this.log.warn(`归档取消失败: ${errorName(error)}`);
                });
            });
        }
        catch {
            return () => undefined;
        }
    }
    async attachToWorkspace(sessionId) {
        if (this.attachedSessions.has(sessionId))
            return;
        const registry = this.workspaceRegistry();
        if (!registry)
            return;
        try {
            const workspace = await registry.resolveByPath(this.config.cwd)
                ?? await registry.create(this.config.cwd, basename(this.config.cwd) || this.config.cwd);
            await workspace.attachSession(sessionId);
            this.attachedSessions.add(sessionId);
        }
        catch (error) {
            this.log.warn(`关联工作区失败: ${errorName(error)}`);
        }
    }
    async cancelActiveTurn(reason) {
        if (!this.busy)
            return;
        this.stopReason = reason;
        if (this.activeSessionId) {
            try {
                this.sessions.cancel({ sessionId: this.activeSessionId });
            }
            catch (error) {
                this.log.warn(`取消会话失败: ${errorName(error)}`);
            }
        }
        this.turn?.abort();
        await this.finishFollow();
    }
    stopMessage() {
        return this.stopReason.startsWith('超时') ? `任务${this.stopReason}，已停止。` : '已停止。';
    }
    expireAuthentication() {
        if (this.authExpired)
            return;
        this.authExpired = true;
        this.log.warn('微信登录已失效，需要重新扫码');
        this.stopReason = '微信登录失效';
        this.lifecycle.abort();
        if (this.activeSessionId) {
            try {
                this.sessions.cancel({ sessionId: this.activeSessionId });
            }
            catch (error) {
                this.log.warn(`取消会话失败: ${errorName(error)}`);
            }
        }
        this.turn?.abort();
        void this.finishFollow();
    }
    async send(message, text) {
        if (this.authExpired)
            return 'failed';
        const chunks = splitChunks(cleanForWeChat(text), Math.max(64, this.config.chunkBytes - 24));
        if (chunks.length === 0)
            return 'failed';
        const available = this.quota.remaining(message.contextToken);
        const plannedContent = Math.min(chunks.length, available);
        const shouldWarn = this.quota.shouldWarnAfter(message.contextToken, plannedContent);
        const contentLimit = shouldWarn ? Math.max(0, available - 1) : available;
        const content = chunks.slice(0, contentLimit);
        const warning = shouldWarn ? quotaWarningText(available - content.length - 1) : '';
        if (content.length === 0 && !warning) {
            this.log.warn('本 context_token 的发送额度已用尽，停止发送');
            return 'failed';
        }
        let sent = 0;
        for (const [index, chunk] of content.entries()) {
            if (this.authExpired)
                return sent > 0 ? 'truncated' : 'failed';
            if (!this.quota.charge(message.contextToken)) {
                this.log.warn('本 context_token 的发送额度已用尽，停止发送');
                return sent > 0 ? 'truncated' : 'failed';
            }
            const body = withChunkPrefix(chunk, index + 1, content.length);
            if (!await this.sendWithRetry(message.fromUserId, body, message.contextToken)) {
                return sent > 0 ? 'truncated' : 'failed';
            }
            sent += 1;
            if (index < content.length - 1)
                await this.sleep(200, this.lifecycle.signal);
        }
        if (warning) {
            if (this.authExpired || !this.quota.charge(message.contextToken)) {
                return content.length > 0 ? 'truncated' : 'failed';
            }
            if (!await this.sendWithRetry(message.fromUserId, warning, message.contextToken)) {
                return content.length > 0 ? 'truncated' : 'failed';
            }
            this.quota.markWarned(message.contextToken);
        }
        return chunks.length > content.length ? 'truncated' : 'ok';
    }
    async sendWithRetry(toUserId, body, contextToken) {
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            if (this.authExpired)
                return false;
            try {
                await this.client.sendText(toUserId, body, contextToken, this.lifecycle.signal);
                return true;
            }
            catch (error) {
                if (error instanceof AuthExpiredError) {
                    this.expireAuthentication();
                    throw error;
                }
                this.log.warn(`发送失败（第 ${attempt} 次）: ${errorName(error)}`);
                if (attempt < 3)
                    await this.sleep(1_500, this.lifecycle.signal);
            }
        }
        this.log.error('消息发送最终失败');
        return false;
    }
    async tryTypingTicket(message) {
        if (this.authExpired)
            return '';
        try {
            return await this.client.getTypingTicket(message.fromUserId, message.contextToken, this.lifecycle.signal);
        }
        catch (error) {
            if (error instanceof AuthExpiredError) {
                this.expireAuthentication();
                throw error;
            }
            this.log.info(`输入状态提示失败: ${errorName(error)}`);
            return '';
        }
    }
    async tryTyping(message, ticket, cancel) {
        if (this.authExpired)
            return;
        try {
            await this.client.sendTyping(message.fromUserId, ticket, cancel, this.lifecycle.signal);
        }
        catch (error) {
            if (error instanceof AuthExpiredError) {
                this.expireAuthentication();
                throw error;
            }
        }
    }
    async finishFollow(iterator = this.activeFollow) {
        if (!iterator)
            return;
        if (this.activeFollow === iterator)
            this.activeFollow = null;
        try {
            await settleWithin(Promise.resolve(iterator.return?.()), this.settleTimeoutMs);
        }
        catch {
            // Iterator return can race with abort settlement.
        }
    }
    addTimeout(callback, ms) {
        const timer = setTimeout(() => {
            this.timers.delete(timer);
            callback();
        }, ms);
        timer.unref?.();
        this.timers.add(timer);
        return timer;
    }
    addInterval(callback, ms) {
        const timer = setInterval(callback, ms);
        timer.unref?.();
        this.timers.add(timer);
        return timer;
    }
    clearTimer(timer) {
        clearTimeout(timer);
        clearInterval(timer);
        this.timers.delete(timer);
    }
    clearTimers() {
        for (const timer of this.timers) {
            clearTimeout(timer);
            clearInterval(timer);
        }
        this.timers.clear();
    }
}
function eventMessageContent(data) {
    if (!data || typeof data !== 'object')
        return undefined;
    const record = data;
    const message = record.message;
    const owner = message && typeof message === 'object' ? message : record;
    return owner.content;
}
class TurnBlockedError extends Error {
    constructor() {
        super('turn blocked');
        this.name = 'TurnBlockedError';
    }
}
const KNOWN_TURN_END = new Set(['completed', 'aborted', 'blocked', 'error', 'max-tokens', 'interrupted', 'forked']);
function turnFailure(data) {
    if (!data || typeof data !== 'object')
        return { kind: 'completed', message: '' };
    const reason = data.reason;
    if (!reason || typeof reason !== 'object')
        return { kind: 'completed', message: '' };
    const detail = reason;
    const kind = typeof detail.kind === 'string' ? detail.kind : 'completed';
    if (kind === 'error') {
        const error = detail.error;
        const code = error && typeof error === 'object' ? error.code : undefined;
        return {
            kind,
            message: typeof code === 'string' && /^[A-Z0-9_-]{1,64}$/.test(code)
                ? `模型调用失败（${code}）`
                : '模型调用失败',
        };
    }
    if (kind === 'blocked') {
        return { kind, message: '任务被阻止（会话可能已在电脑端归档），发送 /new 开启新会话后重试。' };
    }
    if (kind === 'aborted')
        return { kind, message: '任务已中止' };
    return { kind, message: '' };
}
function timeoutMinutes(ms) {
    return Math.max(1, Math.round(ms / 60_000));
}
function formatIdleGap(ms) {
    const minutes = Math.max(1, Math.floor(ms / 60_000));
    if (minutes >= 1_440)
        return `${Math.floor(minutes / 1_440)} 天`;
    if (minutes >= 60)
        return `${Math.floor(minutes / 60)} 小时`;
    return `${minutes} 分钟`;
}
function localTimestamp(date) {
    const values = [
        date.getFullYear(),
        date.getMonth() + 1,
        date.getDate(),
        date.getHours(),
        date.getMinutes(),
        date.getSeconds(),
    ];
    const [year, ...rest] = values;
    const padded = rest.map((value) => String(value).padStart(2, '0'));
    return `${String(year)}-${padded[0]}-${padded[1]} ${padded[2]}:${padded[3]}:${padded[4]}`;
}
function errorName(error) {
    return error instanceof Error ? error.name : typeof error;
}
function shortError(error) {
    if (!(error instanceof Error))
        return String(error).split('\n')[0]?.slice(0, 300) || '未知错误';
    return (error.message.trim().split('\n')[0] || error.name).slice(0, 300);
}
function isPromise(value) {
    return value !== null;
}
/** Reject promptly on abort, but give the host a bounded grace period to settle on its own. */
function abortAware(promise, signal, graceMs) {
    if (signal.aborted) {
        promise.catch(() => undefined);
        return Promise.reject(signal.reason ?? new Error('aborted'));
    }
    return new Promise((resolve, reject) => {
        let settled = false;
        let grace = null;
        const finish = (settle) => {
            if (settled)
                return;
            settled = true;
            if (grace)
                clearTimeout(grace);
            signal.removeEventListener('abort', onAbort);
            settle();
        };
        const onAbort = () => {
            grace = setTimeout(() => finish(() => reject(new Error('取消后宿主未结束本轮'))), graceMs);
            grace.unref?.();
        };
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
    });
}
/** Never wait on host teardown forever, and never surface its failure to callers. */
function settleWithin(promise, ms) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(undefined), ms);
        timer.unref?.();
        promise.then((value) => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(undefined); });
    });
}
function sleep(ms, signal) {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve();
            return;
        }
        const timer = setTimeout(done, ms);
        timer.unref?.();
        signal?.addEventListener('abort', done, { once: true });
        function done() {
            clearTimeout(timer);
            signal?.removeEventListener('abort', done);
            resolve();
        }
    });
}
//# sourceMappingURL=channel.js.map