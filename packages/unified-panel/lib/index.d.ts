import type { Context } from '@deepseek-ai/cordis';
export declare const name = "dsh-utils-unified-panel";
/** One peer machine as configured in peers.json. */
export interface PanelPeer {
    name?: string;
    transport?: 'ssh' | 'local';
    target?: string;
    dshHome?: string;
    bridge?: {
        port?: number;
        token?: string;
    };
    web?: {
        url?: string;
    };
}
/** Row configuration; peers win over the peers file when both are present. */
export interface PanelConfig {
    peers?: PanelPeer[];
    peersFile?: string;
}
export declare function apply(ctx: Context, config?: PanelConfig): void;
