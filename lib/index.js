import { resolve } from 'node:path';
import { expandHomePath } from '@deepseek-ai/dsh-home-paths';
import z from '@deepseek-ai/schemastery';
import { WeChatChannel } from './channel.js';
export const name = 'dsh-channel-wechat';
export const inject = ['sessionController'];
/**
 * Volatile fields surface in the Settings UI. The bridge object reads the live
 * config reference, so the fields below take effect without a remount; fields
 * that were bound at construction are listed in RESTART_FIELDS instead.
 */
export const Config = z.object({
    autoStart: z.boolean().default(false).volatile(),
    dataDir: z.string().default('~/.dsh-wechat').volatile(),
    cwd: z.string().default('~').volatile(),
    chunkBytes: z.number().step(1).min(200).max(8_000).default(1800).volatile(),
    taskTimeoutMs: z.number().step(1).min(10_000).max(86_400_000).default(1_800_000).volatile(),
    pollTimeoutMs: z.number().step(1).min(5_000).max(120_000).default(30_000).volatile(),
    typingRefreshMs: z.number().step(1).min(1_000).max(60_000).default(5_000).volatile(),
    sessionIdleResetMinutes: z.number().step(1).min(0).max(43_200).default(720).volatile(),
});
const LIVE_FIELDS = new Set(['cwd', 'chunkBytes', 'taskTimeoutMs', 'typingRefreshMs', 'sessionIdleResetMinutes']);
const RESTART_FIELDS = new Set(['autoStart', 'dataDir', 'pollTimeoutMs']);
function hasTopLevelField(paths, fields) {
    return paths.some((path) => path.length === 1 && path[0] !== undefined && fields.has(path[0]));
}
function errorName(error) {
    return error instanceof Error ? error.name : typeof error;
}
/**
 * Schemastery delivers a `.volatile()` field as a ref whose `get()` returns the
 * current value; the Loader swaps that target in place on a settings write.
 */
function live(value) {
    if (value !== null && typeof value === 'object') {
        const get = value.get;
        if (typeof get === 'function')
            return get.call(value);
    }
    return value;
}
/**
 * Owns one channel instance and the mount/unmount/restart queue. Restarts are
 * serialized so a new poller can never start before the previous one closed.
 */
export class ChannelSupervisor {
    stop = null;
    queue = Promise.resolve();
    disposed = false;
    create;
    log;
    enabled;
    announce;
    constructor(options) {
        this.create = options.create;
        this.log = options.log;
        this.enabled = options.enabled ?? (() => true);
        this.announce = options.announce ?? (() => undefined);
    }
    isMounted() {
        return this.stop !== null;
    }
    mount() {
        if (this.disposed || this.stop)
            return;
        if (!this.enabled()) {
            this.log.info('channel present but autoStart=false; enable it explicitly');
            return;
        }
        try {
            this.stop = this.create().start();
            this.log.info('微信通道已启动');
        }
        catch (error) {
            this.stop = null;
            this.log.error(`微信通道启动失败: ${errorName(error)}`);
            this.announce(`[wechat-channel] start failed: ${errorName(error)}`);
        }
    }
    async unmount() {
        const current = this.stop;
        this.stop = null;
        if (!current)
            return;
        try {
            await current();
        }
        catch (error) {
            this.log.error(`微信通道停止失败: ${errorName(error)}`);
            this.announce(`[wechat-channel] stop failed: ${errorName(error)}`);
        }
    }
    restart() {
        this.queue = this.queue
            .then(async () => {
            await this.unmount();
            if (!this.disposed)
                this.mount();
        })
            .catch((error) => this.log.error(`微信通道重启失败: ${errorName(error)}`));
        return this.queue;
    }
    async dispose() {
        this.disposed = true;
        await this.queue;
        await this.unmount();
    }
}
export function apply(ctx, config) {
    const log = ctx.logger('wechat-channel');
    // Getters keep the running bridge on the live config reference; only values
    // captured by the constructor (store directory, poll timeout) need a remount.
    const resolved = {
        get autoStart() { return live(config.autoStart); },
        get dataDir() { return resolve(expandHomePath(live(config.dataDir))); },
        get cwd() { return resolve(expandHomePath(live(config.cwd))); },
        get chunkBytes() { return live(config.chunkBytes); },
        get taskTimeoutMs() { return live(config.taskTimeoutMs); },
        get pollTimeoutMs() { return live(config.pollTimeoutMs); },
        get typingRefreshMs() { return live(config.typingRefreshMs); },
        get sessionIdleResetMinutes() { return live(config.sessionIdleResetMinutes); },
    };
    const supervisor = new ChannelSupervisor({
        create: () => new WeChatChannel(ctx, resolved),
        log,
        enabled: () => live(config.autoStart),
        announce: (line) => process.stdout.write(`${line}\n`),
    });
    const onVolatileUpdate = (paths) => {
        if (hasTopLevelField(paths, LIVE_FIELDS))
            log.info('微信通道配置已即时生效');
        if (hasTopLevelField(paths, RESTART_FIELDS)) {
            log.info('微信通道配置需要重启通道');
            process.stdout.write('[wechat-channel] restart requested\n');
            void supervisor.restart();
        }
    };
    supervisor.mount();
    ctx.on('loader/volatile-update', onVolatileUpdate);
    ctx.effect(() => async () => {
        await supervisor.dispose();
    }, 'wechat-channel');
}
//# sourceMappingURL=index.js.map