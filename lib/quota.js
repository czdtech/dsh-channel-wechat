export const QUOTA_PER_TOKEN = 10;
export const QUOTA_WARNING_REMAINING = 3;
export class QuotaLedger {
    entries = new Map();
    maxEntries;
    constructor(maxEntries = 256) {
        this.maxEntries = maxEntries;
    }
    remaining(token) {
        return Math.max(0, QUOTA_PER_TOKEN - (this.entries.get(token)?.used ?? 0));
    }
    charge(token) {
        const state = this.touch(token);
        if (state.used >= QUOTA_PER_TOKEN)
            return false;
        state.used += 1;
        return true;
    }
    shouldWarnAfter(token, plannedContentSends) {
        const state = this.entries.get(token);
        const remaining = this.remaining(token);
        return !(state?.warned ?? false)
            && plannedContentSends > 0
            && remaining > 1
            && remaining - plannedContentSends <= QUOTA_WARNING_REMAINING;
    }
    markWarned(token) {
        this.touch(token).warned = true;
    }
    reset(token) {
        this.entries.delete(token);
    }
    touch(token) {
        const state = this.entries.get(token) ?? { used: 0, warned: false };
        this.entries.delete(token);
        this.entries.set(token, state);
        while (this.entries.size > this.maxEntries) {
            const oldest = this.entries.keys().next();
            if (oldest.done)
                break;
            this.entries.delete(oldest.value);
        }
        return state;
    }
}
export function quotaWarningText(remaining) {
    return `（提示：本会话剩余 ${remaining} 条消息额度，发送 /new 可重置。长回答会被截断。）`;
}
//# sourceMappingURL=quota.js.map