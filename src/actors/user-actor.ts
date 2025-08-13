import type { Actor, ActorMessage, ActorResponse } from "../types.ts";

// Actor that processes user input
export class UserActor implements Actor {
  name: string;

  constructor(name = "user") {
    this.name = name;
  }

  async start(): Promise<void> {
    console.log(`[${this.name}] Actor started`);
  }

  async stop(): Promise<void> {
    console.log(`[${this.name}] Actor stopped`);
  }

  protected createResponse(
    to: string,
    type: string,
    payload: unknown,
    originalMessageId?: string
  ): ActorResponse {
    return {
      id: originalMessageId
        ? `${originalMessageId}-response`
        : crypto.randomUUID(),
      from: this.name,
      to,
      type,
      payload,
      timestamp: new Date(),
    };
  }

  async handleMessage(message: ActorMessage): Promise<ActorResponse | null> {
    console.log(`[${this.name}] Processing user input:`, message);

    const content = message.payload as { text?: string; command?: string };
    const text = content.text || "";
    const command = content.command;

    // Process commands
    if (command) {
      return this.handleCommand(message, command);
    }

    // Process text messages
    if (text) {
      return this.handleTextMessage(message, text);
    }

    // Unknown message
    return this.createResponse(
      message.from,
      "error",
      { error: "No text or command provided" },
      message.id
    );
  }

  private handleCommand(message: ActorMessage, command: string): ActorResponse {
    switch (command) {
      case "reset":
      case "clear":
        return this.createResponse(
          "system",
          "reset-session",
          { message: "Session reset requested" },
          message.id
        );

      case "stop":
        return this.createResponse(
          "system",
          "stop-tasks",
          { message: "Stop all tasks" },
          message.id
        );

      case "exit":
        return this.createResponse(
          "system",
          "shutdown",
          { message: "Shutdown requested" },
          message.id
        );

      case "help":
        return this.createResponse(
          message.from,
          "help-response",
          {
            commands: [
              "!reset / !clear - Reset conversation",
              "!stop - Stop running tasks",
              "!exit - Exit bot",
              "!help - Show this help",
              "!<command> - Execute shell command",
            ],
          },
          message.id
        );

      default:
        // Treat as shell command
        if (command.startsWith("!")) {
          return this.createResponse(
            "system",
            "execute-command",
            { command: command.substring(1) },
            message.id
          );
        }

        return this.createResponse(
          message.from,
          "unknown-command",
          { error: `Unknown command: ${command}` },
          message.id
        );
    }
  }

  private handleTextMessage(
    message: ActorMessage,
    text: string
  ): ActorResponse {
    // Check for special commands
    if (text.startsWith("!")) {
      const command = text.substring(1).split(" ")[0];
      return this.handleCommand(message, command);
    }

    // Route regular messages to appropriate Actor
    const targetActor = this.determineTargetActor(text);

    return this.createResponse(
      targetActor,
      "user-message",
      {
        text,
        originalFrom: message.from,
        originalMessageId: message.id,
        channelId: (message.payload as { channelId?: string }).channelId,
      },
      message.id
    );
  }

  private determineTargetActor(text: string): string {
    // Select appropriate Actor based on message content
    if (text.toLowerCase().includes("debug")) {
      return "debug";
    }

    // Only route to auto-responder if it's enabled
    const autoResponderEnabled = 
      Deno.env.get("ENABLE_AUTO_RESPONDER") === "true" ||
      Deno.env.get("NEVER_SLEEP") === "true";
    
    if (
      autoResponderEnabled &&
      (text.toLowerCase().includes("task") ||
       text.toLowerCase().includes("todo"))
    ) {
      return "auto-responder";
    }

    // Default to assistant (ClaudeCode or Debug)
    return "assistant";
  }
}
