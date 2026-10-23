import { type RequestInit, type Response } from 'undici';
import type { TokenState } from './pairing.js';
export declare class WxApiError extends Error {
    readonly errcode: number | null;
    constructor(message: string, errcode?: number | null);
}
export declare class AuthExpiredError extends WxApiError {
    constructor(message: string);
}
export interface InboundMessage {
    messageId: string;
    fromUserId: string;
    contextToken: string;
    text: string;
    messageType: number;
}
export interface LoginQr {
    qrcodeId: string;
    imageContent: string;
}
export interface LoginStatus {
    status: 'waiting' | 'confirmed' | 'expired' | string;
    botToken?: string;
    botId?: string;
}
export type IlinkLane = 'poll' | 'send' | 'typing';
export interface IlinkHttp {
    request(url: string | URL, init: RequestInit, lane: IlinkLane): Promise<Response>;
    close(): Promise<void>;
}
export interface IlinkClientOptions {
    pollTimeoutMs?: number;
    http?: IlinkHttp;
    persistToken?: (token: TokenState) => void;
}
export interface IlinkProtocolClient {
    hasToken(): boolean;
    getBotQr(signal?: AbortSignal): Promise<LoginQr>;
    getQrStatus(qrcodeId: string, signal?: AbortSignal): Promise<LoginStatus>;
    acceptLogin(status: LoginStatus): void;
    getUpdates(signal?: AbortSignal): Promise<{
        cursor: string;
        messages: InboundMessage[];
    }>;
    sendText(toUserId: string, text: string, contextToken: string, signal?: AbortSignal): Promise<void>;
    getTypingTicket(toUserId: string, contextToken: string, signal?: AbortSignal): Promise<string>;
    sendTyping(toUserId: string, ticket: string, cancel: boolean, signal?: AbortSignal): Promise<void>;
    close(): Promise<void>;
}
export declare class UndiciIlinkHttp implements IlinkHttp {
    private readonly dispatchers;
    constructor();
    request(url: string | URL, init: RequestInit, lane: IlinkLane): Promise<Response>;
    close(): Promise<void>;
}
export declare class IlinkClient implements IlinkProtocolClient {
    private token;
    private readonly pollTimeoutMs;
    private readonly http;
    private readonly persistToken;
    constructor(token: TokenState, options?: IlinkClientOptions);
    hasToken(): boolean;
    getBotQr(signal?: AbortSignal): Promise<LoginQr>;
    getQrStatus(qrcodeId: string, signal?: AbortSignal): Promise<LoginStatus>;
    acceptLogin(status: LoginStatus): void;
    getUpdates(signal?: AbortSignal): Promise<{
        cursor: string;
        messages: InboundMessage[];
    }>;
    sendText(toUserId: string, text: string, contextToken: string, signal?: AbortSignal): Promise<void>;
    getTypingTicket(toUserId: string, contextToken: string, signal?: AbortSignal): Promise<string>;
    sendTyping(toUserId: string, ticket: string, cancel: boolean, signal?: AbortSignal): Promise<void>;
    close(): Promise<void>;
    private headers;
    private getPublic;
    private post;
    private requestJson;
    private raiseForErrcode;
    private persist;
}
export declare function extractText(message: Record<string, unknown>): string;
