import { Client } from "discord.js";

export class DiscordDiagnostics {
  private lastHeartbeatSent = 0;
  private lastHeartbeatAck = 0;
  private loopCheckInterval?: number;
  private enabled = true;

  constructor(private client: Client) {
    this.setupDiagnostics();
  }

  private setupDiagnostics(): void {
    // WebSocket接続状態の監視
    this.client.ws.on("debug", (info) => {
      if (this.enabled) {
        console.debug(`[gw-debug] ${info}`);
      }
    });

    // シャード切断イベント
    this.client.ws.on("shardDisconnect" as any, (ev: any, shardId: number) => {
      console.warn(
        `[shard ${shardId}] disconnect code=${ev?.code} reason=${ev?.reason ?? ""} wasClean=${ev?.wasClean}`
      );
    });

    // シャード再接続イベント
    this.client.ws.on("shardResume" as any, (shardId: number, replayed: number) => {
      console.log(`[shard ${shardId}] resumed (${replayed} events replayed)`);
    });

    // シャード準備完了
    this.client.ws.on("shardReady" as any, (shardId: number) => {
      console.log(`[shard ${shardId}] ready`);
    });

    // ハートビート送信の監視
    this.client.ws.on("shardPing" as any, (ping: number, shardId: number) => {
      console.log(`[hb] shard ${shardId} ping=${ping}ms`);
    });

    // エラーハンドリング
    this.client.ws.on("shardError" as any, (error: Error, shardId: number) => {
      console.error(`[shard ${shardId}] error:`, error.message);
      // TypeError対策: errorオブジェクトの詳細確認
      if (error.message?.includes("Cannot use 'in' operator")) {
        console.error("[DENO COMPAT] WebSocket error handling issue detected");
      }
    });

    // イベントループ遅延の監視
    this.startLoopMonitoring();
  }

  private startLoopMonitoring(): void {
    let lastCheck = Date.now();
    
    this.loopCheckInterval = setInterval(() => {
      const now = Date.now();
      const expectedDelta = 1000;
      const actualDelta = now - lastCheck;
      const lag = actualDelta - expectedDelta;
      
      if (lag > 250) {
        console.warn(`[loop] Event loop lag detected: ${lag}ms`);
      }
      
      lastCheck = now;
    }, 1000) as unknown as number;
  }

  public stop(): void {
    this.enabled = false;
    if (this.loopCheckInterval) {
      clearInterval(this.loopCheckInterval);
    }
  }

  // WebSocket状態の確認
  public getConnectionStatus(): string {
    const status = this.client.ws.status;
    const ping = this.client.ws.ping;
    return `Status: ${status}, Ping: ${ping}ms`;
  }
}