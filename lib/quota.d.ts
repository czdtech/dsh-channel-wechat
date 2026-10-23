export declare const QUOTA_PER_TOKEN = 10;
export declare const QUOTA_WARNING_REMAINING = 3;
export declare class QuotaLedger {
    private readonly entries;
    private readonly maxEntries;
    constructor(maxEntries?: number);
    remaining(token: string): number;
    charge(token: string): boolean;
    shouldWarnAfter(token: string, plannedContentSends: number): boolean;
    markWarned(token: string): void;
    reset(token: string): void;
    private touch;
}
export declare function quotaWarningText(remaining: number): string;
