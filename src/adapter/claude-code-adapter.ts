import { type Options, query as sdkQuery } from "@anthropic-ai/claude-code";
import type { Adapter, ClaudeMessage } from "../types.ts";
import type { Config } from "../config.ts";

type ClaudeErrorKind =
  | "USAGE_LIMIT"
  | "IMAGE_TOO_LARGE"
  | "NETWORK"
  | "CLI_NOT_FOUND"
  | "UNKNOWN";

interface ClaudeErrorPayload {
  tag: "CLAUDE_ERROR";
  hint: string;
  kind: ClaudeErrorKind;
  retryAfterMs?: number;
  meta: Record<string, unknown>;
}

const CLAUDE_ERROR_TAG = "CLAUDE_ERROR" as const;

function env(name: string, fallback = ""): string {
  try {
    return Deno.env.get(name) ?? fallback;
  } catch {
    return fallback;
  }
}

function detectUsageLimitReset(message: string): number | undefined {
  const match = message.match(/resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!match) return undefined;

  const now = new Date();
  let hours = parseInt(match[1], 10);
  const minutes = match[2] ? parseInt(match[2], 10) : 0;
  const ampm = (match[3] ?? "").toLowerCase();

  if (ampm === "pm" && hours < 12) hours += 12;
  if (ampm === "am" && hours === 12) hours = 0;

  const target = new Date(now);
  target.setHours(hours, minutes, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return Math.max(target.getTime() - now.getTime(), 0);
}

function analyseClaudeError(message: string): {
  kind: ClaudeErrorKind;
  hint: string;
  retryAfterMs?: number;
} {
  const lower = message.toLowerCase();
  if (/5[-\s]*hour limit reached/i.test(message) || /status\s*429/i.test(lower)) {
    return {
      kind: "USAGE_LIMIT",
      hint:
        "Anthropic Claude の利用上限ウィンドウに到達しました。リセットまで待ってから再試行してください。",
      retryAfterMs: detectUsageLimitReset(message),
    };
  }

  if (/image exceeds 5 mb maximum/i.test(message)) {
    return {
      kind: "IMAGE_TOO_LARGE",
      hint: "画像が 5MB の上限を超えています。圧縮・縮小してから再実行してください。",
    };
  }

  if (/eai_again|econnreset|enotfound|etimedout|network error/i.test(lower)) {
    return {
      kind: "NETWORK",
      hint: "ネットワークエラーが発生しました。少し待ってから再試行してください。",
    };
  }

  if (/command not found|enoent|spawn/i.test(lower)) {
    return {
      kind: "CLI_NOT_FOUND",
      hint: "Claude CLI が見つかりません。パスやインストール状態を確認してください。",
    };
  }

  return {
    kind: "UNKNOWN",
    hint: "Claude Code がエラー終了しました。ログを確認してください。",
  };
}

// DI interface to abstract Claude Code client
export interface ClaudeClient {
  query(args: {
    prompt: string;
    options: Options;
    abortController?: AbortController;
  }): AsyncIterable<any>;
}

// Factory to create the real Claude Code client
export function createClaudeClient(): ClaudeClient {
  return {
    query: ({ prompt, options, abortController }) =>
      // SDK 最新版は abortController/signal を受け取らないため未指定で呼び出す
      sdkQuery({ prompt, options }),
  };
}

export type ClaudeStreamChunk = {
  type: "text" | "tool" | "system" | "done";
  content: string;
  raw?: unknown;
};

// Adapter that manages communication with ClaudeCode API
export class ClaudeCodeAdapter implements Adapter {
  name = "claude-code";
  private config: Config;
  private currentSessionId?: string;
  private isFirstQuery = true;
  private abortController?: AbortController;
  private client: ClaudeClient;
  private preflightChecked = false;

  constructor(config: Config, client?: ClaudeClient) {
    this.config = config;
    this.client = client ?? createClaudeClient();

    // Set first query flag to false for resume sessions
    if (config.sessionId) {
      this.isFirstQuery = false;
      this.currentSessionId = config.sessionId;
    }

    // Claude Code uses internal authentication, no API key needed
  }

  async start(): Promise<void> {
    console.log(`[${this.name}] Claude Code adapter started`);
    console.log(`[${this.name}] Model: ${this.config.model}`);
    if (this.currentSessionId) {
      console.log(`[${this.name}] Resuming session: ${this.currentSessionId}`);
    }
  }

  async stop(): Promise<void> {
    console.log(`[${this.name}] Stopping Claude Code adapter...`);
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  // Send query to Claude API
  async query(
    prompt: string,
    onProgress?: (message: ClaudeMessage) => Promise<void>,
  ): Promise<string> {
    const options: Options = {
      maxTurns: this.config.maxTurns,
      model: this.config.model,
      permissionMode: (this.config.claudePermissionMode ??
        "bypassPermissions") as Options["permissionMode"],
      ...(this.isFirstQuery ? {} : { continue: true }),
      ...(this.config.sessionId && this.isFirstQuery ? { resume: this.config.sessionId } : {}),
    };

    this.abortController = new AbortController();

    try {
      const response = this.client.query({
        prompt,
        options,
        abortController: this.abortController,
      });

      let fullResponse = "";
      let toolResults = "";

      for await (const message of response) {
        // Call progress callback if available
        if (onProgress) {
          await onProgress(message as ClaudeMessage);
        }

        if (message.type === "assistant") {
          const content = message.message.content;
          if (typeof content === "string") {
            fullResponse += content;
          } else if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text") {
                fullResponse += block.text;
              }
            }
          }
        } else if (message.type === "system" && message.subtype === "init") {
          // Save session ID
          this.currentSessionId = message.session_id;
          console.log(
            `[${this.name}] Session started: ${this.currentSessionId}`,
          );

          if (this.isFirstQuery) {
            this.isFirstQuery = false;
          }
        } else if (message.type === "result") {
          // Update session ID from result message
          this.currentSessionId = message.session_id;
        } else if (message.type === "user") {
          // Process tool execution results
          const content = message.message.content;
          if (Array.isArray(content)) {
            for (const item of content) {
              if (
                item.type === "tool_result" &&
                typeof item.content === "string"
              ) {
                const truncated = item.content.length > 300
                  ? item.content.substring(0, 300) + "..."
                  : item.content;
                toolResults += `\n📋 Tool execution result:\n\`\`\`\n${truncated}\n\`\`\`\n`;
              }
            }
          }
        }
      }

      // Add toolResults to fullResponse if available
      if (toolResults) {
        fullResponse = toolResults + (fullResponse ? "\n" + fullResponse : "");
      }

      return fullResponse || "No response received.";
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Query was aborted");
      }

      const rawMsg = error instanceof Error ? error.message : String(error);
      const analysis = analyseClaudeError(rawMsg);
      const permissionMode = this.config.claudePermissionMode ?? "bypassPermissions";

      let cwd = "unknown";
      try {
        cwd = Deno.cwd();
      } catch { /* ignore */ }

      let firstPath = "unknown";
      try {
        const p = env("PATH", "");
        firstPath = p.split(":")[0] ?? "unknown";
      } catch { /* ignore */ }

      const rateLimited = analysis.kind === "USAGE_LIMIT";
      let cliPresence = "unknown";
      if (this.shouldRunPreflight(rawMsg) && !this.preflightChecked) {
        this.preflightChecked = true;
        try {
          cliPresence = await this.checkClaudeCliPresence();
        } catch {
          cliPresence = "not_found_or_failed";
        }
      }

      const payload: ClaudeErrorPayload = {
        tag: CLAUDE_ERROR_TAG,
        hint: analysis.hint,
        kind: analysis.kind,
        retryAfterMs: analysis.retryAfterMs,
        meta: {
          message: rawMsg,
          permissionMode,
          cwd,
          pathHead: firstPath,
          cli: cliPresence,
          rateLimited,
        },
      };

      console.error(`[${this.name}] Claude query failed`, payload);
      throw new Error(JSON.stringify(payload));
    }
  }

  // New: stream chunks API for MCP clients
  async *queryStream(prompt: string): AsyncIterable<ClaudeStreamChunk> {
    const options: Options = {
      maxTurns: this.config.maxTurns,
      model: this.config.model,
      permissionMode: (this.config.claudePermissionMode ??
        "bypassPermissions") as Options["permissionMode"],
      ...(this.isFirstQuery ? {} : { continue: true }),
      ...(this.config.sessionId && this.isFirstQuery ? { resume: this.config.sessionId } : {}),
    };

    this.abortController = new AbortController();

    try {
      const response = this.client.query({
        prompt,
        options,
        abortController: this.abortController,
      });

      for await (const message of response) {
        // system init → session id 更新
        if (message.type === "system" && message.subtype === "init") {
          this.currentSessionId = message.session_id;
          if (this.isFirstQuery) this.isFirstQuery = false;
          yield {
            type: "system",
            content: `session:${this.currentSessionId}`,
            raw: message,
          };
          continue;
        }

        // result → 最終 session id 更新（出力はしない）
        if (message.type === "result") {
          this.currentSessionId = message.session_id;
          continue;
        }

        // assistant テキストチャンク
        if (message.type === "assistant") {
          const content = message.message.content;
          if (typeof content === "string") {
            if (content) {
              yield { type: "text", content, raw: message };
            }
          } else if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text" && block.text) {
                yield { type: "text", content: block.text, raw: block };
              }
            }
          }
          continue;
        }

        // ツール実行結果（user/tool_result）
        if (message.type === "user") {
          const content = message.message.content;
          if (Array.isArray(content)) {
            for (const item of content) {
              if (
                item.type === "tool_result" &&
                typeof item.content === "string"
              ) {
                const truncated = item.content.length > 300
                  ? item.content.substring(0, 300) + "..."
                  : item.content;
                const toolText = `📋 Tool execution result:\n\`\`\`\n${truncated}\n\`\`\`\n`;
                yield { type: "tool", content: toolText, raw: item };
              }
            }
          }
          continue;
        }
      }

      // 完了通知
      yield { type: "done", content: "" };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Query was aborted");
      }

      const rawMsg = error instanceof Error ? error.message : String(error);
      const analysis = analyseClaudeError(rawMsg);
      const permissionMode = this.config.claudePermissionMode ?? "bypassPermissions";

      let cwd = "unknown";
      try {
        cwd = Deno.cwd();
      } catch { /* ignore */ }

      let firstPath = "unknown";
      try {
        const p = env("PATH", "");
        firstPath = p.split(":")[0] ?? "unknown";
      } catch { /* ignore */ }

      const rateLimited = analysis.kind === "USAGE_LIMIT";
      let cliPresence = "unknown";
      if (this.shouldRunPreflight(rawMsg) && !this.preflightChecked) {
        this.preflightChecked = true;
        try {
          cliPresence = await this.checkClaudeCliPresence();
        } catch {
          cliPresence = "not_found_or_failed";
        }
      }

      const payload: ClaudeErrorPayload = {
        tag: CLAUDE_ERROR_TAG,
        hint: analysis.hint,
        kind: analysis.kind,
        retryAfterMs: analysis.retryAfterMs,
        meta: {
          message: rawMsg,
          permissionMode,
          cwd,
          pathHead: firstPath,
          cli: cliPresence,
          rateLimited,
        },
      };

      console.error(`[${this.name}] Claude queryStream failed`, payload);
      throw new Error(JSON.stringify(payload));
    }
  }

  // Internal utilities
  private shouldRunPreflight(message: string): boolean {
    const m = message.toLowerCase();
    return (
      m.includes("exited with code 1") ||
      m.includes("exited with code") ||
      m.includes("spawn") ||
      m.includes("enoent") ||
      m.includes("not found") ||
      m.includes("eacces")
    );
  }

  private async checkClaudeCliPresence(): Promise<string> {
    try {
      const cmd = new Deno.Command("claude", {
        args: ["--version"],
        stdout: "piped",
        stderr: "piped",
      });
      const { success, stdout } = await cmd.output();
      if (success) {
        const v = new TextDecoder().decode(stdout).trim();
        console.debug(`[${this.name}] claude --version: ${v}`);
        return v || "present";
      }
      return "not_found_or_failed";
    } catch {
      // Permission denied or command not found, etc.
      return "not_found_or_failed";
    }
  }

  // Reset session
  resetSession(): void {
    this.isFirstQuery = true;
    this.currentSessionId = undefined;
    console.log(`[${this.name}] Session reset`);
  }

  // Get current session ID
  getCurrentSessionId(): string | undefined {
    return this.currentSessionId;
  }

  // Abort query
  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      console.log(`[${this.name}] Query aborted`);
    }
  }

  // Adapter state
  isReady(): boolean {
    return true; // Claude Code uses internal authentication
  }

  hasActiveSession(): boolean {
    return !!this.currentSessionId;
  }
}
