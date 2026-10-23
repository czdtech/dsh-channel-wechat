export interface ChannelState {
    ownerId: string;
    sessionId: string | null;
    pairedAt: string;
    lastActiveAt: string;
}
export interface TokenState {
    botToken: string;
    botId: string;
    cursor: string;
    loginTime: string;
}
export declare const EMPTY_CHANNEL_STATE: ChannelState;
export declare const EMPTY_TOKEN_STATE: TokenState;
export declare class StateStore {
    readonly dir: string;
    readonly statePath: string;
    readonly tokenPath: string;
    private owned;
    constructor(dir: string);
    loadState(): ChannelState;
    saveState(state: ChannelState): void;
    loadToken(): TokenState;
    saveToken(token: TokenState): void;
    private write;
    private ensureDir;
}
export declare function newPairingCode(): string;
export declare function pairingCodeMatches(provided: string, expected: string): boolean;
