#!/usr/bin/env -S deno run -A --env

import {
  parseCliOptions,
  showHelp,
  validateOptions,
  listSessions,
  selectSession,
} from "./cli.ts";
import { loadConfig } from "./config.ts";
import { t } from "./i18n.ts";
import { SimpleMessageBus } from "./message-bus.ts";
import { UserActor } from "./actors/user-actor.ts";
import { ClaudeCodeActor } from "./actors/claude-code-actor.ts";
import { GeminiCliActor } from "./actors/gemini-cli-actor.ts";
import { DebugActor } from "./actors/debug-actor.ts";
import { AutoResponderActor } from "./actors/auto-responder-actor.ts";
import { DiscordAdapter } from "./adapter/discord-adapter.ts";
import type { ActorMessage } from "./types.ts";
import { applyDenoWebSocketShim } from "./utils/deno-ws-shim.ts";

async function main() {
  // Deno WebSocket互換性対策（Discord.jsより前に実行）
  if (typeof Deno !== "undefined") {
    await applyDenoWebSocketShim();
  }
  // Parse CLI options
  const options = parseCliOptions();

  // Display help
  if (options.help) {
    showHelp();
    Deno.exit(0);
  }

  // Validate options
  validateOptions(options);

  // Display session list
  if (options.listSessions) {
    await listSessions();
    Deno.exit(0);
  }

  // Select session
  if (options.select) {
    const sessionId = await selectSession();
    if (!sessionId) {
      console.log(t("cli.errors.sessionNotSelected"));
      Deno.exit(0);
    }
    options.resume = sessionId;
  }

  // Load configuration
  const config = loadConfig(options.debug);
  if (!config) {
    Deno.exit(1);
  }

  // Apply CLI options to configuration
  config.debugMode = options.debug;
  config.neverSleep = options.neverSleep;
  if (options.resume) {
    config.sessionId = options.resume;
  }

  // Initialize message bus and Actors
  const bus = new SimpleMessageBus();

  // Create each Actor
  const userActor = new UserActor();

  // Select assistant Actor based on configuration
  let assistantActor;
  if (config.debugMode) {
    assistantActor = new DebugActor("assistant");
  } else if (config.useGemini) {
    assistantActor = new GeminiCliActor(config, "assistant");
  } else {
    assistantActor = new ClaudeCodeActor(config, "assistant");
  }

  // Streaming用に MessageBus を注入（後方互換: DebugActor へは未注入）
  if (
    assistantActor instanceof ClaudeCodeActor ||
    assistantActor instanceof GeminiCliActor
  ) {
    assistantActor.setMessageBus(bus);
  }

  // Register Actors
  bus.register(userActor);
  
  // Conditionally register AutoResponder (opt-in)
  const enableAutoResponder = 
    Deno.env.get("ENABLE_AUTO_RESPONDER") === "true" ||
    config.neverSleep;  // Enable with neverSleep for backward compatibility
  
  if (enableAutoResponder) {
    const autoResponderActor = new AutoResponderActor();
    bus.register(autoResponderActor);
    console.log("[auto-responder] enabled");
  } else {
    console.log("[auto-responder] disabled");
  }
  
  bus.register(assistantActor);

  // Start all Actors
  await bus.startAll();

  console.log(`
===========================================
${t("main.startup.title")}
${t("main.startup.mode")}: ${config.debugMode ? "Debug" : "Production"}
${t("main.startup.neverSleep")}: ${config.neverSleep ? "Enabled" : "Disabled"}
${
  config.sessionId
    ? `${t("main.startup.resumeSession")}: ${config.sessionId}`
    : t("main.startup.newSession")
}
===========================================
`);

  // Demo: Simulate a simple conversation
  if (config.debugMode) {
    console.log(`${t("main.debug.running")}\n`);

    // Message from user
    const userMessage: ActorMessage = {
      id: crypto.randomUUID(),
      from: "discord",
      to: "user",
      type: "discord-message",
      payload: { text: "Hello! Please tell me today's tasks." },
      timestamp: new Date(),
    };

    const userResponse = await bus.send(userMessage);
    if (userResponse) {
      console.log(`${t("main.debug.userResponse")}`, userResponse);

      // UserActor forwards to assistant
      const assistantResponse = await bus.send(userResponse);
      if (assistantResponse) {
        console.log(`${t("main.debug.assistantResponse")}`, assistantResponse);
      }
    }

    // Never Sleep mode demo
    if (config.neverSleep) {
      console.log(`\n${t("main.debug.neverSleepDemo")}`);

      const idleCheck: ActorMessage = {
        id: crypto.randomUUID(),
        from: "timer",
        to: "auto-responder",
        type: "idle-check",
        payload: {
          lastActivityTime: new Date(Date.now() - 6 * 60 * 1000),
          timeout: 5 * 60 * 1000,
        },
        timestamp: new Date(),
      };

      const idleResponse = await bus.send(idleCheck);
      if (idleResponse) {
        console.log(`${t("main.debug.autoResponderResponse")}`, idleResponse);
      }
    }
  }

  // Discord connection (when not in debug mode)
  if (!config.debugMode) {
    const discordAdapter = new DiscordAdapter(config, bus);

    try {
      await discordAdapter.start();
      console.log(`\n${t("main.discord.connected")}`);

      // Handle process termination
      Deno.addSignalListener("SIGINT", async () => {
        console.log(`\n${t("main.discord.shutdown")}`);
        await discordAdapter.stop();
        await bus.stopAll();
        Deno.exit(0);
      });

      // Maintain connection
      await new Promise(() => {});
    } catch (error) {
      console.error(`${t("main.discord.connectionError")}`, error);
      await bus.stopAll();
      Deno.exit(1);
    }
  } else {
    // Debug mode completion
    await bus.stopAll();
  }
}

// Error handling
main().catch((error) => {
  console.error(`${t("main.fatalError")}`, error);
  Deno.exit(1);
});
