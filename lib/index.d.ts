import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
declare module '@deepseek-ai/cordis' {
    interface Events {
        'loader/volatile-update'(paths: readonly (readonly string[])[]): void;
    }
}
export declare const name = "dsh-channel-wechat";
export declare const inject: string[];
export interface Config {
    readonly autoStart: boolean;
    readonly dataDir: string;
    readonly cwd: string;
    readonly chunkBytes: number;
    readonly taskTimeoutMs: number;
    readonly pollTimeoutMs: number;
    readonly typingRefreshMs: number;
    readonly sessionIdleResetMinutes: number;
}
/**
 * Volatile fields surface in the Settings UI. The bridge object reads the live
 * config reference, so the fields below take effect without a remount; fields
 * that were bound at construction are listed in RESTART_FIELDS instead.
 */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    autoStart: z<boolean, boolean, "volatile-defined">;
    dataDir: z<string, string, "volatile-defined">;
    cwd: z<string, string, "volatile-defined">;
    chunkBytes: z<number, number, "volatile-defined">;
    taskTimeoutMs: z<number, number, "volatile-defined">;
    pollTimeoutMs: z<number, number, "volatile-defined">;
    typingRefreshMs: z<number, number, "volatile-defined">;
    sessionIdleResetMinutes: z<number, number, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    autoStart: z<boolean, boolean, "volatile-defined">;
    dataDir: z<string, string, "volatile-defined">;
    cwd: z<string, string, "volatile-defined">;
    chunkBytes: z<number, number, "volatile-defined">;
    taskTimeoutMs: z<number, number, "volatile-defined">;
    pollTimeoutMs: z<number, number, "volatile-defined">;
    typingRefreshMs: z<number, number, "volatile-defined">;
    sessionIdleResetMinutes: z<number, number, "volatile-defined">;
}>>, "plain">;
export interface ChannelHandle {
    start(): () => Promise<void>;
}
type SupervisorLog = Pick<ReturnType<Context['logger']>, 'info' | 'error'>;
export interface SupervisorOptions {
    readonly create: () => ChannelHandle;
    readonly log: SupervisorLog;
    readonly enabled?: () => boolean;
    readonly announce?: (line: string) => void;
}
/**
 * Owns one channel instance and the mount/unmount/restart queue. Restarts are
 * serialized so a new poller can never start before the previous one closed.
 */
export declare class ChannelSupervisor {
    private stop;
    private queue;
    private disposed;
    private readonly create;
    private readonly log;
    private readonly enabled;
    private readonly announce;
    constructor(options: SupervisorOptions);
    isMounted(): boolean;
    mount(): void;
    unmount(): Promise<void>;
    restart(): Promise<void>;
    dispose(): Promise<void>;
}
export declare function apply(ctx: Context, config: Config): void;
export {};
