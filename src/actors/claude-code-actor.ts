import type {
  Actor,
  ActorMessage,
  ActorResponse,
  ImportedAttachment,
  MessageBus,
} from "../types.ts";
import { ClaudeCodeAdapter } from "../adapter/claude-code-adapter.ts";
import type { Config } from "../config.ts";

type StoredRequest = {
  request: ActorMessage;
  originalMessageId: string;
};

type ClaudeErrorKind =
  | "USAGE_LIMIT"
  | "IMAGE_TOO_LARGE"
  | "NETWORK"
  | "CLI_NOT_FOUND"
  | "UNKNOWN";

const ATTACHMENT_PREVIEW_CHAR_LIMIT = 4000;

// Actor that communicates with ClaudeCode API
export class ClaudeCodeActor implements Actor {
  name: string;
  private adapter: ClaudeCodeAdapter;
  private bus?: MessageBus;
  private queue: ActorMessage[] = [];
  private running = false;
  private lastRequestByChannel = new Map<string, StoredRequest>();
  private cooldownTimerByChannel = new Map<string, ReturnType<typeof setTimeout>>();
  private autoRetryEnabled =
    (Deno.env.get("CCDISCORD_AUTORETRY_ON_COOLDOWN") ?? "false").toLowerCase() ===
      "true";

  constructor(config: Config, name = "claude-code") {
    this.name = name;
    this.adapter = new ClaudeCodeAdapter(config);
  }

  // MessageBus を後付け注入（後方互換維持のため）
  setMessageBus(bus: MessageBus): void {
    this.bus = bus;
  }

  async start(): Promise<void> {
    console.log(`[${this.name}] Actor started`);
    await this.adapter.start();
  }

  async stop(): Promise<void> {
    await this.adapter.stop();
    console.log(`[${this.name}] Actor stopped`);
  }

  protected createResponse(
    to: string,
    type: string,
    payload: unknown,
    originalMessageId?: string,
  ): ActorResponse {
    return {
      id: originalMessageId ? `${originalMessageId}-response` : crypto.randomUUID(),
      from: this.name,
      to,
      type,
      payload,
      timestamp: new Date(),
    };
  }

  async handleMessage(message: ActorMessage): Promise<ActorResponse | null> {
    this.queue.push(message);
    await this.drainQueue();
    return null;
  }

  private async drainQueue(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const nextMessage = this.queue.shift()!;
        await this.processMessage(nextMessage);
      }
    } finally {
      this.running = false;
    }
  }

  private async processMessage(message: ActorMessage): Promise<void> {
    if (message.type === "discord-command") {
      const payload = message.payload as {
        text?: string;
        channelId?: string;
      };
      const command = payload?.text?.trim().toLowerCase();
      if (command === "!retry") {
        await this.retryLast(payload?.channelId ?? "", {
          originalMessageId: message.id,
        });
      } else if (payload?.channelId) {
        await this.emitStreamNotice(payload.channelId, message.id, {
          message: "サポートされていないコマンドです。",
          fatal: false,
        });
      }
      return;
    }

    console.log(`[${this.name}] Processing message with Claude Code`);

    const content = message.payload as {
      text?: string;
      originalMessageId?: string;
      channelId?: string;
      attachments?: ImportedAttachment[];
    };
    const text = content.text ?? "";
    const attachments = content.attachments ?? [];
    const originalMessageId = content.originalMessageId ?? message.id;
    const channelId = content.channelId;

    if (channelId) {
      // 直近リクエストを保持（!retry 用）
      this.lastRequestByChannel.set(channelId, {
        request: {
          ...message,
          payload: { ...content, originalMessageId },
        },
        originalMessageId,
      });
    }

    if (!text && attachments.length === 0) {
      // Send error response via bus if available
      if (this.bus) {
        await this.bus.send(this.createResponse(
          message.from,
          "error",
          { error: "No text provided for Claude" },
          message.id,
        ));
      }
      return;
    }

    const mergedText = this.buildMessageContent(text, attachments);

    // ストリーミング有効判定（bus 未注入や無効時は従来どおり最終のみ）
    const streamingEnabled = (this as any).adapter &&
      ((this as any).adapter["config"]?.streamingEnabled ?? true);
    const canStream = streamingEnabled && !!this.bus;

    if (!canStream) {
      try {
        const response = await this.adapter.query(mergedText);
        if (this.bus) {
          await this.bus.send(this.createResponse(
            message.from,
            "claude-response",
            { text: response, sessionId: this.adapter.getCurrentSessionId() },
            message.id,
          ));
        }
      } catch (error) {
        console.error(`[${this.name}] Error querying Claude:`, error);
        const parsed = this.parseClaudeError(error);
        if (parsed && this.bus) {
          await this.bus.send(
            this.createResponse(
              message.from,
              "error",
              { error: parsed.friendlyMessage, kind: parsed.kind },
              message.id,
            ),
          );
          if (channelId) {
            await this.emitStreamNotice(channelId, originalMessageId, {
              message: parsed.friendlyMessage,
              fatal: true,
            });
            if (parsed.kind === "USAGE_LIMIT") {
              this.scheduleCooldownNotice(channelId, originalMessageId, parsed.retryAfterMs);
            }
          }
        } else if (this.bus) {
          const fallback = error instanceof Error ? error.message : "Unknown error";
          await this.bus.send(
            this.createResponse(
              message.from,
              "error",
              { error: fallback },
              message.id,
            ),
          );
        }
      }
      return;
    }

    // ストリーミング経路
    try {
      // stream-started
      await this.bus!.emit({
        id: crypto.randomUUID(),
        from: this.name,
        to: "discord",
        type: "stream-started",
        payload: {
          originalMessageId,
          channelId: channelId ?? "",
          meta: { sessionId: this.adapter.getCurrentSessionId() },
        },
        timestamp: new Date(),
      });

      const cfg: any = (this as any).adapter["config"] ?? {};
      const toolPrefix: string = cfg.streamingToolChunkPrefix ?? "📋 ツール実行結果:";
      const maxChunk: number = cfg.streamingMaxChunkLength ?? 1800;

      const truncate = (s: string, n: number) => s.length > n ? s.slice(0, n) + "..." : s;

      const response = await this.adapter.query(mergedText, async (cm) => {
        try {
          // assistant のテキストチャンク
          if (cm?.type === "assistant") {
            const content = (cm as any).message?.content;
            let delta = "";
            if (typeof content === "string") {
              delta = content;
            } else if (Array.isArray(content)) {
              for (const b of content) {
                if (b?.type === "text" && typeof b.text === "string") {
                  delta += b.text;
                }
              }
            }
            if (delta) {
              await this.bus!.emit({
                id: crypto.randomUUID(),
                from: this.name,
                to: "discord",
                type: "stream-partial",
                payload: {
                  originalMessageId,
                  channelId: channelId ?? "",
                  textDelta: delta,
                  raw: cm,
                },
                timestamp: new Date(),
              });
            }
          }

          // ツール結果チャンク（Claude 側は user/tool_result 経由）
          if (cm?.type === "user") {
            const content = (cm as any).message?.content;
            if (Array.isArray(content)) {
              for (const item of content) {
                if (item?.type === "tool_result") {
                  const raw = typeof item.content === "string"
                    ? item.content
                    : JSON.stringify(item.content);
                  const chunk = `${toolPrefix}\n\`\`\`\n${
                    truncate(
                      raw ?? "",
                      maxChunk,
                    )
                  }\n\`\`\`\n`;
                  await this.bus!.emit({
                    id: crypto.randomUUID(),
                    from: this.name,
                    to: "discord",
                    type: "stream-partial",
                    payload: {
                      originalMessageId,
                      channelId: channelId ?? "",
                      toolChunk: chunk,
                      raw: cm,
                    },
                    timestamp: new Date(),
                  });
                }
              }
            }
          }
        } catch (e) {
          console.error(`[${this.name}] onProgress emit error`, e);
        }
      });

      // 完了
      await this.bus!.emit({
        id: crypto.randomUUID(),
        from: this.name,
        to: "discord",
        type: "stream-completed",
        payload: {
          originalMessageId,
          channelId: channelId ?? "",
          fullText: response,
          sessionId: this.adapter.getCurrentSessionId(),
        },
        timestamp: new Date(),
      });

      // 既存の最終応答も維持
      if (this.bus) {
        await this.bus.send(this.createResponse(
          message.from,
          "claude-response",
          { text: response, sessionId: this.adapter.getCurrentSessionId() },
          message.id,
        ));
      }
      return;
    } catch (error) {
      console.error(`[${this.name}] Error querying Claude:`, error);
      const parsed = this.parseClaudeError(error);
      const friendly = parsed?.friendlyMessage ??
        (error instanceof Error ? error.message : "Unknown error");
      if (channelId) {
        await this.emitStreamNotice(channelId, originalMessageId, {
          message: friendly,
          fatal: true,
        });
      }
      if (this.bus) {
        await this.bus.send(
          this.createResponse(
            message.from,
            "error",
            { error: friendly, kind: parsed?.kind ?? "UNKNOWN" },
            message.id,
          ),
        );
      }
      if (parsed?.kind === "USAGE_LIMIT" && channelId) {
        this.scheduleCooldownNotice(channelId, originalMessageId, parsed.retryAfterMs);
      }
      return;
    }
  }

  private buildMessageContent(text: string, attachments: ImportedAttachment[]): string {
    if (attachments.length === 0) return text;

    const lines: string[] = ["[Attachments imported]"];
    for (const attachment of attachments) {
      const sizeLabel = `${attachment.size} bytes`;
      const descriptor = attachment.contentType
        ? `${sizeLabel}, ${attachment.contentType}`
        : sizeLabel;
      lines.push(`- ${attachment.filename} (${descriptor}) -> ${attachment.path}`);
      if (attachment.isText && attachment.contentPreview) {
        lines.push(`--- preview: ${attachment.filename} ---`);
        const snippet = attachment.contentPreview.slice(0, ATTACHMENT_PREVIEW_CHAR_LIMIT);
        lines.push(snippet);
        lines.push(`--- end preview ---`);
      }
    }
    lines.push("");
    lines.push("必要なら `Read(<path>)` でファイル全体を参照してください。");

    const preamble = lines.join("\n");
    return text ? `${preamble}\n\n${text}` : preamble;
  }

  private parseClaudeError(error: unknown):
    | {
      friendlyMessage: string;
      kind: ClaudeErrorKind;
      retryAfterMs?: number;
    }
    | null {
    const raw = error instanceof Error ? error.message : String(error ?? "");
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.tag === "CLAUDE_ERROR") {
        const kind = (parsed.kind ?? "UNKNOWN") as ClaudeErrorKind;
        let friendly: string = parsed.hint ?? "Claude Code がエラー終了しました。";
        if (kind === "USAGE_LIMIT") {
          if (typeof parsed.retryAfterMs === "number") {
            const minutes = Math.max(1, Math.ceil(parsed.retryAfterMs / 60000));
            friendly += `\n推定残り時間: 約${minutes}分。`;
          }
          friendly += `\n制限解除後に「!retry」で再実行できます。`;
        } else if (kind === "IMAGE_TOO_LARGE") {
          friendly += `\n画像を 5MB 未満に抑えるよう圧縮してから再実行してください。`;
        } else if (kind === "NETWORK") {
          friendly += `\n時間を置いて「!retry」で再試行してください。`;
        } else if (kind === "CLI_NOT_FOUND") {
          friendly += `\nCLI のインストールやパス設定を確認したうえで再実行してください。`;
        } else {
          friendly += `\n必要に応じて「!retry」で再実行できます。`;
        }
        return {
          friendlyMessage: friendly,
          kind,
          retryAfterMs: typeof parsed.retryAfterMs === "number" ? parsed.retryAfterMs : undefined,
        };
      }
    } catch {
      // JSON でない場合は既存処理へフォールバック
    }
    return null;
  }

  private async emitStreamNotice(
    channelId: string | undefined,
    originalMessageId: string,
    payload: { message: string; fatal?: boolean },
  ): Promise<void> {
    if (!channelId || !this.bus) return;
    try {
      await this.bus.emit({
        id: crypto.randomUUID(),
        from: this.name,
        to: "discord",
        type: "stream-error",
        payload: {
          originalMessageId,
          channelId,
          message: payload.message,
          fatal: payload.fatal ?? true,
        },
        timestamp: new Date(),
      });
    } catch {
      // ignore emit failures
    }
  }

  private scheduleCooldownNotice(
    channelId: string,
    originalMessageId: string,
    retryAfterMs?: number,
  ): void {
    const delay = Math.min(
      Math.max(retryAfterMs ?? 30 * 60_000, 60_000),
      6 * 60 * 60_000,
    );
    const previous = this.cooldownTimerByChannel.get(channelId);
    if (previous) clearTimeout(previous);

    const timer = setTimeout(() => {
      this.cooldownTimerByChannel.delete(channelId);
      (async () => {
        await this.emitStreamNotice(channelId, originalMessageId, {
          message:
            "⌛ クールダウンが明けた可能性があります。必要なら「!retry」で再実行してください。",
          fatal: false,
        });
        if (this.autoRetryEnabled) {
          await this.retryLast(channelId, { originalMessageId });
        }
      })().catch((err) => console.error(`[${this.name}] cooldown notice failed`, err));
    }, delay);

    this.cooldownTimerByChannel.set(channelId, timer);
  }

  private async retryLast(
    channelId: string,
    options: { originalMessageId?: string },
  ): Promise<void> {
    if (!channelId) return;
    const stored = this.lastRequestByChannel.get(channelId);
    if (!stored) {
      await this.emitStreamNotice(channelId, options.originalMessageId ?? crypto.randomUUID(), {
        message: "再実行できる直近のリクエストが見つかりませんでした。",
        fatal: false,
      });
      return;
    }

    const clonedPayload: Record<string, unknown> = {
      ...(stored.request.payload as Record<string, unknown>),
      channelId,
    };
    const nextOriginalId = options.originalMessageId ?? stored.originalMessageId;
    clonedPayload.originalMessageId = nextOriginalId;

    const clonedMessage: ActorMessage = {
      ...stored.request,
      id: crypto.randomUUID(),
      payload: clonedPayload,
      timestamp: new Date(),
    };

    // 先頭に挿入して現在のタスクの直後に処理
    this.queue.unshift(clonedMessage);

    const activeTimer = this.cooldownTimerByChannel.get(channelId);
    if (activeTimer) {
      clearTimeout(activeTimer);
      this.cooldownTimerByChannel.delete(channelId);
    }

    if (options.originalMessageId) {
      await this.emitStreamNotice(channelId, options.originalMessageId, {
        message: "前回のリクエストを再実行します…",
        fatal: false,
      });
    }

    await this.drainQueue();
  }

  // Reset session
  resetSession(): void {
    this.adapter.resetSession();
  }

  getCurrentSessionId(): string | undefined {
    return this.adapter.getCurrentSessionId();
  }
}
