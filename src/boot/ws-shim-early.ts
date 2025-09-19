// Apply Node 'ws' to globalThis.WebSocket before discord.js/ws is loaded.
// This avoids Deno's ErrorEvent differences crashing @discordjs/ws on 'error'.
import { WebSocket as NodeWebSocket } from "npm:ws";

(function applyShim() {
  try {
    const before = (globalThis as any).WebSocket;
    if (before !== NodeWebSocket) {
      (globalThis as any).WebSocket = NodeWebSocket as unknown as typeof WebSocket;
      console.log("[shim] global WebSocket -> npm:ws applied");
    } else {
      console.log("[shim] npm:ws already active");
    }

    // Safety guard: some runtimes dispatch 'error' without .error property.
    // Older @discordjs/ws expects event.error to exist → add a benign value.
    const proto: any = (globalThis as any).WebSocket?.prototype;
    const originalDispatch = proto?.dispatchEvent?.bind(proto);
    if (originalDispatch) {
      proto.dispatchEvent = function (ev: Event) {
        if (ev?.type === "error" && !(ev as any).error) {
          Object.defineProperty(ev, "error", {
            value: Object.assign(new Error("WebSocket error"), { code: "WS_ERR_GENERIC" }),
            configurable: true,
          });
        }
        return originalDispatch(ev);
      };
      console.log("[shim] error-event guard installed");
    }
  } catch (e) {
    console.warn("[shim] failed to apply ws shim:", e);
  }
})();