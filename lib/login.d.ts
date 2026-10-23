import { type IlinkProtocolClient } from './ilink.js';
import { type TokenState } from './pairing.js';
export interface LoginDependencies {
    readonly createClient?: (token: TokenState, persistToken: (token: TokenState) => void) => IlinkProtocolClient;
    readonly pollIntervalMs?: number;
    readonly output?: (chunk: string) => void;
}
export declare function login(dataDir?: string, signal?: AbortSignal, dependencies?: LoginDependencies): Promise<void>;
