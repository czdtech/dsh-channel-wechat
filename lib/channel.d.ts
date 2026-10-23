import type { Context } from '@deepseek-ai/cordis';
import type { SessionController, SessionCreateValue } from '@deepseek-ai/dsh-api-session-controller';
import type { Config } from './index.js';
import { type IlinkProtocolClient, type InboundMessage } from './ilink.js';
import { StateStore, type ChannelState } from './pairing.js';
type SessionService = Pick<SessionController, 'create' | 'prompt' | 'follow' | 'cancel' | 'inspect'>;
type SessionId = SessionCreateValue['sessionId'];
interface WorkspaceHandle {
    attachSession(sessionId: SessionId): Promise<void>;
}
export interface WorkspaceService {
    resolveByPath(path: string): Promise<WorkspaceHandle | undefined>;
    create(path: string, title?: string): Promise<WorkspaceHandle>;
    readonly archivedSessionIds?: readonly SessionId[];
}
export interface TaskConfirmService {
    readonly marker: string;
    phase(sessionId: string): 'gate' | 'pending' | 'confirmed' | undefined;
    cancel(sessionId: string): boolean;
}
export interface ChannelDependencies {
    readonly client?: IlinkProtocolClient;
    readonly store?: StateStore;
    readonly sessionController?: SessionService;
    readonly workspaceRegistry?: WorkspaceService;
    readonly taskConfirm?: TaskConfirmService;
    readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    readonly now?: () => Date;
    readonly settleTimeoutMs?: number;
    readonly announce?: (line: string) => void;
}
export declare class WeChatChannel {
    private readonly ctx;
    private readonly config;
    private readonly log;
    private readonly store;
    private readonly client;
    private readonly sessions;
    private readonly workspaces;
    private readonly injectedConfirm;
    private readonly attachedSessions;
    private readonly quota;
    private readonly seen;
    private readonly seenOrder;
    private readonly lifecycle;
    private readonly sleep;
    private readonly now;
    private readonly settleTimeoutMs;
    private readonly announce;
    private readonly timers;
    private state;
    private pairingCode;
    private pairFailures;
    private busy;
    private stopReason;
    private turn;
    private activeSessionId;
    private activeFollow;
    private loopTask;
    private turnTask;
    private authExpired;
    constructor(ctx: Context, config: Config, dependencies?: ChannelDependencies);
    start(): () => Promise<void>;
    dispatch(message: InboundMessage): Promise<void>;
    isBusy(): boolean;
    currentState(): ChannelState;
    pairingCodeForTest(): string;
    private pollLoop;
    private remember;
    private handleUnpaired;
    private handleCommand;
    private beginTurn;
    private runTurn;
    private runPrompt;
    private nextFrame;
    private rotateBlockedSession;
    private isArchivedSession;
    private ensureSession;
    private createSession;
    private idleResetDue;
    private idleResetNotice;
    private touchActivity;
    private sessionPreset;
    private workspaceRegistry;
    private taskConfirm;
    private pendingConfirmation;
    private cancelPendingConfirmation;
    private watchWorkspaceArchival;
    private attachToWorkspace;
    private cancelActiveTurn;
    private stopMessage;
    private expireAuthentication;
    private send;
    private sendWithRetry;
    private tryTypingTicket;
    private tryTyping;
    private finishFollow;
    private addTimeout;
    private addInterval;
    private clearTimer;
    private clearTimers;
}
export {};
