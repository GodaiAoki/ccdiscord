import { Client } from "discord.js";

export class DiscordDiagnostics {
  private loopCheckInterval?: number;
  private enabled = true;
  private pingInterval?: number;

  constructor(private client: Client) {
    this.setupDiagnostics();
  }

  private setupDiagnostics(): void {
    // Client レベルのイベント（discord.js v14 推奨方式）
    this.client.on("debug", (info: string) => {
      if (this.enabled) {
        console.debug(`[gw-debug] ${info}`);
      }
    });

    // シャード切断イベント
    this.client.on("shardDisconnect" as any, (event: any, shardId: number) => {
      console.warn(
        `[shard ${shardId}] disconnect code=${event?.code} reason=${event?.reason ?? ""} wasClean=${event?.wasClean}`
      );
    });

    // シャード再接続イベント
    this.client.on("shardResume" as any, (shardId: number, replayedEvents: number) => {
      console.log(`[shard ${shardId}] resumed (${replayedEvents} events replayed)`);
    });

    // シャード準備完了
    this.client.on("shardReady" as any, (shardId: number) => {
      console.log(`[shard ${shardId}] ready`);
    });

    // エラーハンドリング（Client レベル）
    this.client.on("shardError" as any, (error: Error, shardId: number) => {
      console.error(`[shard ${shardId}] error:`, error.message);
      // TypeError対策: errorオブジェクトの詳細確認
      if (error.message?.includes("Cannot use 'in' operator")) {
        console.error("[DENO COMPAT] WebSocket error handling issue detected");
      }
    });

    // Ping監視（定期的にチェック）
    this.pingInterval = setInterval(() => {
      if (this.client.ws.ping > 0) {
        console.log(`[hb] ping=${this.client.ws.ping}ms`);
      }
    }, 10000) as unknown as number;

    // イベントループ遅延の監視
    this.startLoopMonitoring();
  }

  private startLoopMonitoring(): void {
    let lastCheck = Date.now();
    let consecutiveLags = 0;

    this.loopCheckInterval = setInterval(() => {
      const now = Date.now();
      const expectedDelta = 1000;
      const actualDelta = now - lastCheck;
      const lag = actualDelta - expectedDelta;

      // サスペンド復帰時の誤検知を防ぐ
      if (lag > 5000) {
        // 5秒以上の遅延は、おそらくプロセスのサスペンド
        console.warn(`[loop] Process was suspended for ~${Math.round(lag/1000)}s`);
        lastCheck = now;
        consecutiveLags = 0;
        return;
      }

      if (lag > 250) {
        consecutiveLags++;
        console.warn(`[loop] Event loop lag detected: ${lag}ms (consecutive: ${consecutiveLags})`);

        // 連続して遅延が発生している場合のみ警告
        if (consecutiveLags > 3) {
          console.error(`[loop] Persistent event loop blocking detected!`);
        }
      } else {
        consecutiveLags = 0;
      }

      lastCheck = now;
    }, 1000) as unknown as number;
  }

  public stop(): void {
    this.enabled = false;
    if (this.loopCheckInterval) {
      clearInterval(this.loopCheckInterval);
    }
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }
  }

  // WebSocket状態の確認
  public getConnectionStatus(): string {
    const status = this.client.ws.status;
    const ping = this.client.ws.ping;
    return `Status: ${status}, Ping: ${ping}ms`;
  }
}