// Type definitions for messages exchanged between Actors
export interface ActorMessage {
  id: string;
  from: string;
  to: string;
  type: string;
  payload: unknown;
  timestamp: Date;
}

// Response from Actor
export interface ActorResponse {
  id: string;
  from: string;
  to: string;
  type: string;
  payload: unknown;
  timestamp: Date;
}

// Basic Actor interface
export interface Actor {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  handleMessage(message: ActorMessage): Promise<ActorResponse | null>;
}

// Message bus interface
export interface MessageBus {
  register(actor: Actor): void;
  unregister(actorName: string): void;
  send(message: ActorMessage): Promise<ActorResponse | null>;
  broadcast(message: ActorMessage): Promise<ActorResponse[]>;
  // Listener API (non-breaking extension for adapters like Discord)
  addListener(listener: (message: ActorMessage) => void): void;
  removeListener(listener: (message: ActorMessage) => void): void;
  // Emit arbitrary events onto the bus (delivered to listeners only)
  emit(message: ActorMessage): Promise<void>;
}

// Basic Adapter interface
export interface Adapter {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

// Discord-related type definitions
export interface DiscordMessage {
  id: string;
  channelId: string;
  authorId: string;
  content: string;
  timestamp: Date;
}

export interface ImportedAttachment {
  filename: string;
  path: string;
  size: number;
  contentType?: string;
  isText?: boolean;
  isImage?: boolean;
  contentPreview?: string;
  previewPath?: string;
}

// ClaudeCode-related type definitions
export interface ClaudeMessage {
  type: "user" | "assistant" | "system" | "result";
  content?: string | Array<{ type: string; text?: string }>;
  session_id?: string;
  subtype?: string;
}

// Streaming event types (non-breaking additive extension)
export type StreamEventType =
  | "stream-started"
  | "stream-partial"
  | "stream-completed"
  | "stream-error";

export interface StreamStartedMessage extends ActorMessage {
  type: "stream-started";
  payload: {
    originalMessageId: string;
    channelId: string;
    meta?: { sessionId?: string };
  };
}

export interface StreamPartialMessage extends ActorMessage {
  type: "stream-partial";
  payload: {
    originalMessageId: string;
    channelId: string;
    textDelta?: string;
    toolChunk?: string;
    raw?: unknown;
  };
}

export interface StreamCompletedMessage extends ActorMessage {
  type: "stream-completed";
  payload: {
    originalMessageId: string;
    channelId: string;
    fullText: string;
    sessionId?: string;
  };
}

export interface StreamErrorMessage extends ActorMessage {
  type: "stream-error";
  payload: {
    originalMessageId: string;
    channelId: string;
    message: string;
    fatal?: boolean;
  };
}

export type StreamEventMessage =
  | StreamStartedMessage
  | StreamPartialMessage
  | StreamCompletedMessage
  | StreamErrorMessage;

export function isStreamEvent(msg: ActorMessage): msg is StreamEventMessage {
  return (
    msg.type === "stream-started" ||
    msg.type === "stream-partial" ||
    msg.type === "stream-completed" ||
    msg.type === "stream-error"
  );
}
