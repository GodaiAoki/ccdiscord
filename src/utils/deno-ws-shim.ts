// Deno WebSocket互換性シム
// @discordjs/ws との互換性問題を回避

export async function applyDenoWebSocketShim(): Promise<void> {
  console.log("[shim] Applying Deno WebSocket compatibility shim");
  
  // オプション1: Node.js互換のWebSocketライブラリを使用
  try {
    // @ts-ignore
    const { WebSocket: NodeWebSocket } = await import("npm:ws");
    if (NodeWebSocket) {
      (globalThis as any).WebSocket = NodeWebSocket as unknown as typeof WebSocket;
      console.log("[shim] Using Node.js ws library for WebSocket");
      return;
    }
  } catch (e) {
    console.log("[shim] npm:ws not available, using fallback");
  }

  // オプション2: エラーイベントの修正（最小限のシム）
  const originalDispatchEvent = WebSocket.prototype.dispatchEvent;
  WebSocket.prototype.dispatchEvent = function(event: Event) {
    // errorイベントに最小限のerrorプロパティを追加
    if (event?.type === "error" && !(event as any).error) {
      Object.defineProperty(event, "error", {
        value: Object.assign(new Error("WebSocket error"), {
          code: "WS_ERR_GENERIC",
          message: "WebSocket connection error"
        }),
        configurable: true
      });
    }
    return originalDispatchEvent.call(this, event);
  };
  
  console.log("[shim] Applied error event compatibility patch");
}

// WebSocket送信のガード関数
export function safeSend(ws: WebSocket, data: string | Uint8Array): boolean {
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(data);
      return true;
    } catch (error) {
      console.error("[safeSend] Failed to send:", error);
      return false;
    }
  } else {
    console.warn(`[safeSend] WebSocket not ready: readyState=${ws.readyState}`);
    return false;
  }
}