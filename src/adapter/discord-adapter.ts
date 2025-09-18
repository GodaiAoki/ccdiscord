import {
  Client,
  GatewayIntentBits,
  Message,
  TextChannel,
  ThreadChannel,
} from "discord.js";
import type { Adapter, MessageBus, ActorMessage } from "../types.ts";
import type { Config } from "../config.ts";
import { t } from "../i18n.ts";
import { AuditLogger } from "../utils/audit-logger.ts";
import { DiscordDiagnostics } from "../utils/discord-diagnostics.ts";
import { 
  withRetry, 
  ConnectionStateManager, 
  SessionPersistence 
} from "../utils/resilient-connection.ts";

// Adapter that manages Discord connection
export class DiscordAdapter implements Adapter {
  name = "discord";
  private client: Client;
  private config: Config;
  private messageBus: MessageBus;
  private currentThread: ThreadChannel | null = null;
  private isRunning = false;
  private auditLogger: AuditLogger;
  private diagnostics?: DiscordDiagnostics;
  private connectionManager: ConnectionStateManager;
  private sessionPersistence?: SessionPersistence;
  // Streaming state: originalMessageId -> buffers and timer
  private streamStates: Map<
    string,
    {
      buffer: string;
      toolBuffer: string;
      timer?: number;
      thinkingMessage?: Message;
      mode: "edit" | "append";
      channelId?: string;
    }
  > = new Map();
  private completedStreamIds: Set<string> = new Set();
  private busListener: ((message: ActorMessage) => void) | null = null;

  constructor(config: Config, messageBus: MessageBus) {
    this.config = config;
    this.messageBus = messageBus;
    this.auditLogger = new AuditLogger();
    this.connectionManager = new ConnectionStateManager();
    
    // セッション永続化（continueオプション用）
    if (config.sessionId) {
      this.sessionPersistence = new SessionPersistence(config.sessionId);
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    this.setupEventHandlers();

    // Subscribe to stream events
    this.busListener = (msg: ActorMessage) => this.handleStreamEvent(msg);
    this.messageBus.addListener(this.busListener);
  }

  async start(): Promise<void> {
    console.log(`[${this.name}] ${t("discord.starting")}`);

    try {
      await this.auditLogger.init();
      
      // 診断機能を有効化
      const enableDiagnostics = Deno.env.get("DISCORD_DIAGNOSTICS") !== "false";
      if (enableDiagnostics) {
        console.log(`[${this.name}] Diagnostics enabled`);
        this.diagnostics = new DiscordDiagnostics(this.client);
      }
      
      await this.client.login(this.config.discordToken);
      this.isRunning = true;
      await this.auditLogger.logSessionStart(this.config.sessionId || "default", Deno.cwd());
    } catch (error) {
      console.error(`[${this.name}] ${t("discord.failedLogin")}`, error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    console.log(`[${this.name}] ${t("discord.stopping")}`);

    if (this.currentThread && this.currentThread.sendable) {
      try {
        await this.currentThread.send(t("discord.goodbye"));
      } catch (error) {
        console.error(`[${this.name}] ${t("discord.failedGoodbye")}`, error);
      }
    }

    await this.auditLogger.logSessionEnd(this.config.sessionId || "default");

    // 診断機能を停止
    if (this.diagnostics) {
      this.diagnostics.stop();
    }

    // Unsubscribe listener and clear timers
    if (this.busListener) {
      this.messageBus.removeListener(this.busListener);
      this.busListener = null;
    }
    for (const st of this.streamStates.values()) {
      if (st.timer) clearTimeout(st.timer);
    }
    this.streamStates.clear();

    this.client.destroy();
    this.isRunning = false;
  }

  private isUserAllowed(userId: string): boolean {
    // If allowedUsers is defined, check against the list
    if (this.config.allowedUsers && this.config.allowedUsers.length > 0) {
      return this.config.allowedUsers.includes(userId);
    }
    // Otherwise, fall back to checking against the single userId
    return userId === this.config.userId;
  }

  private setupEventHandlers(): void {
    this.client.once("ready", () => this.handleReady());
    this.client.on("messageCreate", (message) => this.handleMessage(message));
    this.client.on("error", (error) => this.handleError(error));

    // Gateway raw パケットの処理（invalid_session 対応）
    this.client.on("raw", async (packet: any) => {
      if (packet?.op === 9) {
        // OP 9: Invalid Session
        const resumable = !!packet?.d;
        console.warn(`[gw] invalid_session detected (resumable=${resumable})`);

        if (!resumable) {
          // Resume不可能な場合、ランダム待機後に再接続
          const waitTime = 1000 + Math.floor(Math.random() * 4000); // 1-5秒
          console.log(`[gw] Waiting ${waitTime}ms before reconnecting...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));

          try {
            await this.client.destroy();
            console.log(`[gw] Destroyed old client, attempting to re-login...`);
            await this.client.login(this.config.discordToken);
            console.log(`[gw] Successfully re-authenticated`);
          } catch (error) {
            console.error(`[gw] Failed to re-authenticate:`, error);
          }
        }
      }
    });
  }

  private async handleReady(): Promise<void> {
    console.log(
      `[${this.name}] ${t("discord.ready")} ${this.client.user?.tag}`
    );

    try {
      const channel = await this.client.channels.fetch(this.config.channelId);
      if (channel && channel.isTextBased() && !channel.isThread()) {
        await this.createThread(channel as TextChannel);
      }
    } catch (error) {
      console.error(`[${this.name}] ${t("discord.failedSetup")}`, error);
    }
  }

  private async createThread(channel: TextChannel): Promise<void> {
    const threadName = `Claude Session - ${new Date().toLocaleString("ja-JP")}`;

    try {
      this.currentThread = await channel.threads.create({
        name: threadName,
        autoArchiveDuration: 1440, // 24 hours
        reason: "Claude session thread",
      });

      // Send initial message
      const initialMessage = this.createInitialMessage();
      await withRetry(
        () => this.currentThread!.send(initialMessage),
        "thread.send.initial",
        { maxRetries: 3, initialDelay: 1000 }
      );

      console.log(`[${this.name}] ${t("discord.threadCreated")} ${threadName}`);
    } catch (error) {
      console.error(`[${this.name}] ${t("discord.failedCreateThread")}`, error);
    }
  }

  private createInitialMessage(): string {
    return `## ${t("discord.sessionInfo.title")}

**${t("discord.sessionInfo.startTime")}**: ${new Date().toISOString()}
**${t("discord.sessionInfo.workDir")}**: \`${Deno.cwd()}\`
**${t("discord.sessionInfo.mode")}**: ${
      this.config.debugMode ? "Debug" : "Production"
    }
${
  this.config.neverSleep
    ? `**${t("discord.sessionInfo.neverSleepEnabled")}**`
    : ""
}

---

${t("discord.instructions.header")}
- \`!reset\` or \`!clear\`: ${t("discord.instructions.reset")}
- \`!stop\`: ${t("discord.instructions.stop")}
- \`!exit\`: ${t("discord.instructions.exit")}
- \`!<command>\`: ${t("discord.instructions.shellCommand")}
- ${t("discord.instructions.normalMessage")}`;
  }

  private async handleMessage(message: Message): Promise<void> {
    // Ignore own messages and messages from other bots
    if (message.author.bot) return;

    // Ignore messages outside current thread
    if (!this.currentThread || message.channel.id !== this.currentThread.id)
      return;

    // Check if user is allowed
    if (!this.isUserAllowed(message.author.id)) {
      // Log auth failure
      await this.auditLogger.logAuthFailure(message.author.id, message.channel.id);
      // Send warning message if user is not allowed
      await withRetry(
        () => message.reply(t("discord.userNotAllowed") || "You are not authorized to use this bot."),
        "message.reply.auth",
        { maxRetries: 2, initialDelay: 500 }
      );
      return;
    }

    const content = message.content.trim();
    if (!content) return;

    console.log(
      `[${this.name}] ${t("discord.receivedMessage")} ${
        message.author.username
      }: ${content}`
    );

    // Log user message
    await this.auditLogger.logUserMessage(
      message.author.id,
      message.author.username,
      message.channel.id,
      content
    );

    // Convert Discord message to ActorMessage
    const actorMessage: ActorMessage = {
      id: message.id,
      from: "discord",
      to: "user",
      type: "discord-message",
      payload: {
        text: content,
        authorId: message.author.id,
        channelId: message.channel.id,
      },
      timestamp: new Date(),
    };

    // Send message to UserActor
    const response = await this.messageBus.send(actorMessage);

    if (response) {
      // Process response
      await this.handleActorResponse(message, response);
    }
  }

  private async handleActorResponse(
    originalMessage: Message,
    response: ActorMessage
  ): Promise<void> {
    // Handle system commands
    if (response.to === "system") {
      await this.handleSystemCommand(originalMessage, response);
      return;
    }

    // Forward regular messages to assistant
    if (response.to === "assistant" || response.to === "auto-responder") {
      const assistantResponse = await this.messageBus.send(response);

      if (assistantResponse) {
        // Filter out auto-responder messages if it's disabled
        const autoResponderEnabled = 
          Deno.env.get("ENABLE_AUTO_RESPONDER") === "true" ||
          Deno.env.get("NEVER_SLEEP") === "true";
        
        if (assistantResponse.from === "auto-responder" && !autoResponderEnabled) {
          console.log(`[${this.name}] Filtered auto-responder message (disabled)`);
          return;
        }
        
        // Filter out Claude Code's "Todos" tool output noise
        const payload: any = assistantResponse.payload ?? {};
        const txt = (payload.text ?? "").toString();
        const toolName = payload.toolName || payload.tool || "";
        const looksLikeTodos =
          /Todos have been modified successfully/i.test(txt) ||
          /continue to use the todo list/i.test(txt) ||
          /ensure that you continue to use the todo list/i.test(txt) ||
          /^Todos$/i.test(toolName);
        
        if (looksLikeTodos) {
          console.log(`[${this.name}] Suppressed Todos tool output`);
          return;
        }
        
        const text = (assistantResponse.payload as { text?: string })?.text;
        if (text) {
          // Avoid duplicate final send if streaming path already handled completion
          const streamingEnabled = this.config.streamingEnabled ?? true;
          if (
            streamingEnabled &&
            (this.streamStates.has(originalMessage.id) ||
              this.completedStreamIds.has(originalMessage.id))
          ) {
            return;
          }
          await this.sendLongMessage(originalMessage, text);
        }
      }
    }
  }

  private async handleSystemCommand(
    message: Message,
    response: ActorMessage
  ): Promise<void> {
    const channel = message.channel as TextChannel | ThreadChannel;

    await this.auditLogger.logBotResponse(channel.id, response.type);

    switch (response.type) {
      case "reset-session":
        await withRetry(
          () => channel.send(t("discord.commands.resetComplete")),
          "channel.send.reset",
          { maxRetries: 3, initialDelay: 1000 }
        );
        break;

      case "stop-tasks":
        await withRetry(
          () => channel.send(t("discord.commands.stopComplete")),
          "channel.send.stop",
          { maxRetries: 3, initialDelay: 1000 }
        );
        break;

      case "shutdown":
        await withRetry(
          () => channel.send(t("discord.commands.exitMessage")),
          "channel.send.exit",
          { maxRetries: 2, initialDelay: 500 }
        );
        await this.stop();
        Deno.exit(0);

      case "execute-command":
        // SECURITY WARNING: Shell command execution is disabled for security reasons.
        // If you need this functionality, implement it with extreme caution:
        // - Use a whitelist of allowed commands
        // - Validate and sanitize all inputs
        // - Run commands in a sandboxed environment
        // - Log all command executions for audit purposes
        await withRetry(
          () => channel.send(
            "⚠️ Shell command execution is disabled for security reasons."
          ),
          "channel.send.shell-warning",
          { maxRetries: 2, initialDelay: 500 }
        );
        break;
    }
  }

  private async sendLongMessage(
    message: Message,
    content: string
  ): Promise<void> {
    const channel = message.channel as TextChannel | ThreadChannel;
    const messages: string[] = [];
    let currentMessage = "";

    const lines = content.split("\n");
    for (const line of lines) {
      if (currentMessage.length + line.length + 1 > 1900) {
        messages.push(currentMessage);
        currentMessage = line;
      } else {
        currentMessage += (currentMessage ? "\n" : "") + line;
      }
    }
    if (currentMessage) {
      messages.push(currentMessage);
    }

    for (const msg of messages) {
      try {
        await withRetry(
          () => channel.send(msg),
          "channel.send.long-message",
          { maxRetries: 3, initialDelay: 1000 }
        );
        // Wait a bit to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (error) {
        console.error(
          `[${this.name}] ${t("discord.failedSendMessage")}`,
          error
        );
      }
    }
  }

  private handleError(error: Error): void {
    console.error(`[${this.name}] ${t("discord.clientError")}`, error);
  }

  // Streaming helpers
  private getStreamingConfig() {
    return {
      enabled: this.config.streamingEnabled ?? true,
      mode: (this.config.streamingUpdateMode ?? "edit") as "edit" | "append",
      interval: this.config.streamingIntervalMs ?? 1000,
      showThinking: this.config.streamingShowThinking ?? true,
      showDone: this.config.streamingShowDone ?? true,
      showAbort: this.config.streamingShowAbort ?? true,
    };
  }

  private capContent(s: string, max = 1900): string {
    return s.length > max ? s.slice(0, max - 3) + "..." : s;
  }

  private handleStreamEvent(message: ActorMessage): void {
    if (message.to !== "discord") return;

    const type = message.type;
    if (
      type !== "stream-started" &&
      type !== "stream-partial" &&
      type !== "stream-completed" &&
      type !== "stream-error"
    )
      return;

    const cfg = this.getStreamingConfig();
    if (!cfg.enabled) return;

    const payload = message.payload as any;
    const channelId: string | undefined = payload?.channelId;
    const id: string | undefined = payload?.originalMessageId;

    // Only handle for current thread
    if (
      !this.currentThread ||
      (channelId && this.currentThread.id !== channelId)
    )
      return;
    if (!id) return;

    switch (type) {
      case "stream-started":
        void this.onStreamStarted(id, channelId, payload?.meta);
        break;
      case "stream-partial":
        void this.onStreamPartial(id, channelId, payload);
        break;
      case "stream-completed":
        void this.onStreamCompleted(id, channelId, payload?.fullText ?? "");
        break;
      case "stream-error":
        void this.onStreamError(
          id,
          channelId,
          payload?.message ?? "Unknown error"
        );
        break;
    }
  }

  private async onStreamStarted(
    id: string,
    channelId?: string,
    _meta?: any
  ): Promise<void> {
    const cfg = this.getStreamingConfig();
    const state = {
      buffer: "",
      toolBuffer: "",
      timer: undefined as number | undefined,
      thinkingMessage: undefined as Message | undefined,
      mode: cfg.mode,
      channelId,
    };
    if (cfg.showThinking && this.currentThread?.sendable) {
      try {
        const msg = await withRetry(
          () => this.currentThread!.send("🤔 考え中..."),
          "thread.send.thinking",
          { maxRetries: 2, initialDelay: 500 }
        );
        state.thinkingMessage = msg;
      } catch (e) {
        console.error(`[${this.name}] failed to post thinking message`, e);
      }
    }
    this.streamStates.set(id, state);
  }

  private scheduleFlush(id: string): void {
    const st = this.streamStates.get(id);
    if (!st) return;
    const cfg = this.getStreamingConfig();
    if (st.timer) return;
    st.timer = setTimeout(async () => {
      st.timer = undefined;
      await this.flushNow(id);
    }, cfg.interval) as unknown as number;
  }

  private async flushNow(id: string): Promise<void> {
    const st = this.streamStates.get(id);
    if (!st || !this.currentThread) return;
    const out = `${st.toolBuffer}${st.toolBuffer && st.buffer ? "\n" : ""}${
      st.buffer
    }`.trim();
    if (!out) return;

    try {
      if (st.mode === "edit" && st.thinkingMessage) {
        await withRetry(
          () => st.thinkingMessage!.edit(this.capContent(out)),
          "message.edit.stream",
          { maxRetries: 3, initialDelay: 1000 }
        );
      } else {
        // append mode or no thinking message available
        await withRetry(
          () => this.currentThread!.send(this.capContent(out)),
          "thread.send.stream",
          { maxRetries: 3, initialDelay: 1000 }
        );
      }
    } catch (e) {
      console.error(`[${this.name}] stream flush error`, e);
    } finally {
      st.buffer = "";
      st.toolBuffer = "";
    }
  }

  private async onStreamPartial(
    id: string,
    _channelId: string | undefined,
    payload: any
  ): Promise<void> {
    const st = this.streamStates.get(id);
    if (!st) {
      // Initialize implicit state when partial comes before started
      this.onStreamStarted(id, _channelId);
    }
    const s = this.streamStates.get(id);
    if (!s) return;

    const textDelta = payload?.textDelta as string | undefined;
    const toolChunk = payload?.toolChunk as string | undefined;
    if (toolChunk) {
      s.toolBuffer += (s.toolBuffer ? "\n" : "") + toolChunk;
    }
    if (textDelta) {
      s.buffer += textDelta;
    }

    this.scheduleFlush(id);
  }

  private async sendLongToCurrentThread(content: string): Promise<void> {
    if (!this.currentThread) return;
    const messages: string[] = [];
    let currentMessage = "";

    const lines = content.split("\n");
    for (const line of lines) {
      if (currentMessage.length + line.length + 1 > 1900) {
        messages.push(currentMessage);
        currentMessage = line;
      } else {
        currentMessage += (currentMessage ? "\n" : "") + line;
      }
    }
    if (currentMessage) {
      messages.push(currentMessage);
    }

    for (const msg of messages) {
      try {
        await withRetry(
          () => this.currentThread!.send(msg),
          "thread.send.completed",
          { maxRetries: 3, initialDelay: 1000 }
        );
        // Wait to avoid rate limiting (keep parity with sendLongMessage)
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (error) {
        console.error(
          `[${this.name}] ${t("discord.failedSendMessage")}`,
          error
        );
      }
    }
  }

  private async onStreamCompleted(
    id: string,
    _channelId: string | undefined,
    fullText: string
  ): Promise<void> {
    const st = this.streamStates.get(id);
    if (st?.timer) {
      clearTimeout(st.timer);
      st.timer = undefined;
    }
    // Final flush pending buffers before sending final
    await this.flushNow(id);

    // Remove thinking message
    const cfg = this.getStreamingConfig();
    if (cfg.showThinking && st?.thinkingMessage) {
      try {
        await st.thinkingMessage.delete();
      } catch {
        // ignore
      }
    }

    // Final output using long message split
    try {
      if (st?.thinkingMessage) {
        await this.sendLongMessage(st.thinkingMessage, fullText);
      } else {
        await this.sendLongToCurrentThread(fullText);
      }
      if (cfg.showDone && this.currentThread) {
        await withRetry(
          () => this.currentThread!.send("✅ done"),
          "thread.send.done",
          { maxRetries: 2, initialDelay: 500 }
        );
      }
    } catch (e) {
      console.error(`[${this.name}] failed to send final output`, e);
    } finally {
      this.streamStates.delete(id);
      this.completedStreamIds.add(id);
      // Cleanup completion mark later to avoid memory growth
      setTimeout(() => this.completedStreamIds.delete(id), 60_000);
    }
  }

  private async onStreamError(
    id: string,
    _channelId: string | undefined,
    message: string
  ): Promise<void> {
    const st = this.streamStates.get(id);
    if (st?.timer) {
      clearTimeout(st.timer);
      st.timer = undefined;
    }
    // Remove thinking message
    if (st?.thinkingMessage) {
      try {
        await st.thinkingMessage.delete();
      } catch {
        // ignore
      }
    }
    const cfg = this.getStreamingConfig();
    if (cfg.showAbort && this.currentThread) {
      try {
        await withRetry(
          () => this.currentThread!.send(`⚠️ ストリーミング中断: ${message}`),
          "thread.send.abort",
          { maxRetries: 2, initialDelay: 500 }
        );
      } catch {
        // ignore
      }
    }
    this.streamStates.delete(id);
    this.completedStreamIds.add(id);
    setTimeout(() => this.completedStreamIds.delete(id), 60_000);
  }

  // Utility methods
  getCurrentThread(): ThreadChannel | null {
    return this.currentThread;
  }

  isConnected(): boolean {
    return this.isRunning && this.client.ws.status === 0;
  }
}
