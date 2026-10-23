export declare const TASK_HEADING = "\u3010\u4EFB\u52A1\u7406\u89E3\u3011";
export declare function looksLikeTaskUnderstanding(text: string, marker?: string): boolean;
export declare function cleanForWeChat(text: string): string;
export declare function splitChunks(text: string, budgetBytes?: number): string[];
export declare function withChunkPrefix(chunk: string, index: number, total: number): string;
export declare function extractPreToolText(content: unknown): [text: string, hasToolCall: boolean];
export declare function extractPlainAssistantText(content: unknown): string;
