// 堅牢な接続管理ユーティリティ

export interface RetryOptions {
  maxRetries?: number;
  initialDelay?: number;
  maxDelay?: number;
  factor?: number;
  jitter?: boolean;
}

// 指数バックオフを実装したリトライ機能
export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = Infinity,
    initialDelay = 1000,
    maxDelay = 60000,
    factor = 2,
    jitter = true
  } = options;

  let delay = initialDelay;
  let attempt = 0;

  while (attempt < maxRetries) {
    try {
      console.log(`[retry:${label}] Attempt ${attempt + 1}`);
      return await fn();
    } catch (error) {
      attempt++;
      console.error(`[retry:${label}] Failed (attempt ${attempt}):`, error);
      
      if (attempt >= maxRetries) {
        throw error;
      }

      // ジッターを追加してthundering herd問題を回避
      const jitterValue = jitter ? Math.random() * 250 : 0;
      const waitTime = Math.min(delay + jitterValue, maxDelay);
      
      console.log(`[retry:${label}] Waiting ${Math.round(waitTime)}ms before retry`);
      await sleep(waitTime);
      
      delay = Math.min(delay * factor, maxDelay);
    }
  }

  throw new Error(`Max retries (${maxRetries}) exceeded for ${label}`);
}

// スリープ関数
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 接続状態の管理
export class ConnectionStateManager {
  private lastActivityTime: Date = new Date();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private isReconnecting = false;

  updateActivity(): void {
    this.lastActivityTime = new Date();
  }

  getIdleTime(): number {
    return Date.now() - this.lastActivityTime.getTime();
  }

  isIdle(timeoutMs: number): boolean {
    return this.getIdleTime() > timeoutMs;
  }

  startReconnect(): boolean {
    if (this.isReconnecting) {
      console.warn("[connection] Already reconnecting");
      return false;
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error("[connection] Max reconnect attempts reached");
      return false;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;
    console.log(`[connection] Starting reconnect attempt ${this.reconnectAttempts}`);
    return true;
  }

  endReconnect(success: boolean): void {
    this.isReconnecting = false;
    
    if (success) {
      console.log("[connection] Reconnect successful");
      this.reconnectAttempts = 0;
      this.updateActivity();
    } else {
      console.error("[connection] Reconnect failed");
    }
  }

  reset(): void {
    this.reconnectAttempts = 0;
    this.isReconnecting = false;
    this.updateActivity();
  }
}

// セッション永続化（continueオプション用）
export interface SessionData {
  id: string;
  lastMessageId?: string;
  lastActivity: Date;
  pendingJobs: PendingJob[];
}

export interface PendingJob {
  id: string;
  type: string;
  payload: any;
  status: 'queued' | 'sent' | 'acked';
  lastTryAt?: Date;
  retryCount: number;
}

export class SessionPersistence {
  private sessionFile: string;

  constructor(sessionId: string) {
    this.sessionFile = `./logs/session_${sessionId}.json`;
  }

  async save(data: SessionData): Promise<void> {
    try {
      await Deno.writeTextFile(this.sessionFile, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error("[session] Failed to save session:", error);
    }
  }

  async load(): Promise<SessionData | null> {
    try {
      const content = await Deno.readTextFile(this.sessionFile);
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  async addPendingJob(job: PendingJob): Promise<void> {
    const session = await this.load() || {
      id: crypto.randomUUID(),
      lastActivity: new Date(),
      pendingJobs: []
    };

    session.pendingJobs.push(job);
    await this.save(session);
  }

  async markJobAcked(jobId: string): Promise<void> {
    const session = await this.load();
    if (!session) return;

    const job = session.pendingJobs.find(j => j.id === jobId);
    if (job) {
      job.status = 'acked';
      await this.save(session);
    }
  }

  async getPendingJobs(): Promise<PendingJob[]> {
    const session = await this.load();
    if (!session) return [];

    return session.pendingJobs.filter(j => j.status !== 'acked');
  }

  async clearPendingJobs(): Promise<void> {
    const session = await this.load();
    if (!session) return;

    session.pendingJobs = [];
    await this.save(session);
  }
}