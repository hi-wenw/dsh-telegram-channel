import type { Context } from '@deepseek-ai/cordis';
import { type TelegramClientLike, type TelegramUpdate } from './client.js';
export interface TelegramBridgeOptions {
    token: string;
    allowedUserIds: number[];
    allowAllUsers: boolean;
    client?: TelegramClientLike;
    sleep?: (ms: number) => Promise<void>;
    maxMessageLength?: number;
    pollingTimeoutSec?: number;
    rendering?: 'rich' | 'html';
}
export declare class TelegramBridge {
    private readonly ctx;
    private readonly token;
    private readonly allowedUserIds;
    private readonly allowAllUsers;
    private readonly client;
    private readonly sleep;
    private readonly maxMessageLength;
    private renderingMode;
    private readonly bindings;
    private readonly pickers;
    /** chatId → model awaiting reasoning-effort pick (kept outside picker so list refreshes won't drop it). */
    private readonly pendingModels;
    private polling;
    private offset;
    private pollPromise;
    private pollAbort;
    private disposeSessionListener;
    constructor(ctx: Context, options: TelegramBridgeOptions);
    start(): void;
    stop(): Promise<void>;
    processUpdate(update: TelegramUpdate): Promise<void>;
    private handleCallback;
    private resolveCatalog;
    private sendWorkspacePicker;
    private sendSessionPicker;
    private bindSession;
    private sendLastTurn;
    private sendModelPicker;
    private sendEffortPicker;
    private applyModel;
    private liveAgents;
    private findLiveAgent;
    /** Resume cold sessions when needed; never dispose the returned handle. */
    private ensureLiveAgent;
    private sendStatus;
    private followupBound;
    private pollLoop;
    private interruptibleDelay;
    private interruptibleSleep;
    private onSessionEvent;
    private deliver;
    private deliverHtml;
    private redact;
}
