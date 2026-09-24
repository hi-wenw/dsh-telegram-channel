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
    /** Global rendering mode: follows config; flipped to 'html' permanently when the
     *  Rich Message API itself is unavailable (a server-wide fact, not per-chat). */
    private renderingMode;
    /** Per-chat rendering override (persisted): rich messages need a recent Telegram
     *  client — old ones (e.g. 10.x) cannot render them and show “unsupported”. */
    private readonly renderPrefs;
    private readonly bindings;
    private readonly pickers;
    /** chatId → model awaiting reasoning-effort pick (kept outside picker so list refreshes won't drop it). */
    private readonly pendingModels;
    private polling;
    private offset;
    private pollPromise;
    private pollAbort;
    private disposeSessionListener;
    private disposeQuestionHook;
    /** sessionIds mid-turn (busy feedback, /stop state) */
    private readonly busySessions;
    /** chatId → typing heartbeat interval handle */
    private readonly heartbeats;
    /** chatId → serialized notice chain (prevents 429 storms) */
    private readonly noticeQueue;
    private readonly pendingAsks;
    private readonly pendingApprovalsTG;
    private disposeApprovalHook;
    /** sessionId → thinking indicator state (one notice per reasoning phase) */
    private readonly thinkingSessions;
    /** callId → tool name (tool/result failure notices) */
    private readonly callNames;
    /** sessionId → latest todo snapshot (/mission) */
    private readonly lastTodos;
    /** sessionId → in-flight manual compaction (dedup /compact) */
    private readonly compacting;
    /** sessionId → compaction abort controller (cancelled on bridge stop) */
    private readonly compactAborts;
    /** Album accumulation: chatId:media_group_id → parts buffered into one prompt. */
    private readonly mediaGroups;
    constructor(ctx: Context, options: TelegramBridgeOptions);
    /** Effective rendering mode for a chat: per-chat override, else the global mode. */
    private modeFor;
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
    /** 按 sessionId 解析工作区：apiProxy 目录优先，冷/热会话均可用；退化为 agent cwd。 */
    private workspaceOf;
    /** 从 sessionProjections 快照读 Web 底部同款统计（sessionStats/tokenUsage/contextPressure）。 */
    private readRuntimeValues;
    /** 按名称解析宿主服务（Cordis 需 ctx.get；mock/plain ctx 走自有属性兜底）。 */
    private serviceOf;
    private requestCompact;
    /** 等待压缩落定并汇报结果（不阻塞轮询循环）。 */
    private runCompaction;
    private followupBound;
    /**
     * Extract wire prompt parts from a media message.
     * Returns undefined when the message carries no media at all; returns [] for
     * an unsupported media type (the user was already notified); otherwise the
     * caption text part (when present) followed by the image part.
     */
    private collectMediaParts;
    /** Download one TG file and encode it as a canonical-base64 wire image part. */
    private downloadImagePart;
    /**
     * Album photos arrive as separate updates sharing a media_group_id — debounce
     * them into ONE prompt so an album does not spawn N sequential turns.
     */
    private accumulateMediaGroup;
    /**
     * Dispatch an image-bearing message to the bound session through the host
     * prompt RPC — the exact channel the Web composer uses. The host checks
     * whether the current model accepts image input, admits the bytes into the
     * durable attachment store, then queues the message on the agent (mode
     * 'queue' — same semantics as the text path's agent.followup).
     */
    private sendImageFollowup;
    private pollLoop;
    private interruptibleDelay;
    private interruptibleSleep;
    private onSessionEvent;
    private handleRichCommand;
    private deliver;
    private deliverHtml;
    /** Retry an outbound call with capped linear backoff (500ms, 1s, 2s… max 4s). */
    private withRetry;
    /**
     * Send a notice; a leading `> ` keeps the quote look via a plain-text `> `
     * prefix. NB: NOT `<blockquote>` HTML — older Telegram clients cannot render
     * the blockquote entity at all and show the whole message as “not supported”.
     * Falls back to plain text when the send fails — a notice is never lost.
     */
    private deliverNotice;
    /** Serialized per-chat notice chain — bursts can't race into Telegram 429s. */
    private enqueueNotice;
    private startTypingHeartbeat;
    private stopTypingHeartbeat;
    private stopAllHeartbeats;
    /**
     * Mirror the host's agent-scoped waterfall request to Telegram. The next
     * handler remains the Web answer path; NO_PROVIDER means no Web answerer is
     * available, so keep waiting for Telegram instead of failing the request.
     */
    private onUserQuestionRequest;
    private registerTgAsk;
    private settleGuiSide;
    private discardTgAsk;
    private formatAskPending;
    private handleTgAnswer;
    private onApprovalRequest;
    private handleTgApproval;
    private stopBound;
    private sendMission;
    /** /new: create a session in the bound session's workspace and attach to it. */
    private newSessionHere;
    private bindingsPath;
    private saveBindings;
    private loadBindings;
    private redact;
}
