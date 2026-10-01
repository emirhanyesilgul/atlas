// @vitest-environment happy-dom
//
// The in-tab switch rule for a chat that is "busy" only because its first
// message is waiting on a bind that never landed. ⌥/ used to open a NEW tab
// for any `running` status, which left the stuck tab stuck; a start with no
// session has nothing streaming to orphan, so it is switched in place and the
// held message carries over to the new agent's bind.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
const openAgentChatInNewTab = vi.fn();
vi.mock("./open-agent-session", () => ({
  openAgentChatInNewTab: (...a: unknown[]) => openAgentChatInNewTab(...a),
}));

import { useChatStore } from "../stores/chat-store";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { DEFAULT_SETTINGS, type AppSettings } from "@/features/settings/lib/app-settings";
import {
  SESSION_HANDOFF_EVENT,
  isStartingOnly,
  switchAgentForTab,
  type SessionHandoffDetail,
} from "./switch-agent";

const TAB = "tab-1";

describe("switchAgentForTab while starting", () => {
  beforeEach(() => {
    localStorage.clear();
    openAgentChatInNewTab.mockClear();
    useChatStore.setState({ sessions: {}, queues: {}, activeSessionId: null });
    useChatStore.getState().actions.createSession(TAB, "claude-code");
  });

  it("a genuinely busy chat (session bound, turn running) still opens a new tab", () => {
    const { actions } = useChatStore.getState();
    actions.setAcpBinding(TAB, "agent-1", "acp-1", "/tmp");
    actions.updateSessionStatus(TAB, "running");
    switchAgentForTab(TAB, "codex");
    expect(openAgentChatInNewTab).toHaveBeenCalledWith("codex");
    expect(useChatStore.getState().sessions[TAB].agentType).toBe("claude-code");
  });

  it("a chat holding a first message on an unfinished bind switches in place and carries it", () => {
    const { actions } = useChatStore.getState();
    actions.addMessage(TAB, "user", "hello there");
    actions.updateSessionStatus(TAB, "running");
    actions.setPendingSend(TAB, {
      content: "hello there",
      mentions: [],
      attachments: [],
    });
    expect(isStartingOnly(useChatStore.getState().sessions[TAB])).toBe(true);

    switchAgentForTab(TAB, "codex");

    expect(openAgentChatInNewTab).not.toHaveBeenCalled();
    const sess = useChatStore.getState().sessions[TAB];
    expect(sess.agentType).toBe("codex");
    expect(sess.acpSessionId).toBeUndefined();
    expect(sess.status).toBe("running");
    expect(sess.pendingSend?.content).toBe("hello there");
    // Re-recorded as the new session's first bubble, once.
    expect(sess.messages.filter((m) => m.role === "user").map((m) => m.content)).toEqual([
      "hello there",
    ]);
    expect(useChatStore.getState().queues[TAB] ?? []).toEqual([]);
  });

  it("isStartingOnly is false once a session id exists", () => {
    expect(
      isStartingOnly({
        status: "running",
        pendingSend: { content: "x" },
        acpSessionId: "s",
      }),
    ).toBe(false);
    expect(isStartingOnly({ status: "idle", pendingSend: { content: "x" } })).toBe(false);
    expect(isStartingOnly(undefined)).toBe(false);
  });
});

// What switching does to an idle chat with a conversation is the user's
// `agentSwitchBehavior` setting. "reset", the default, is how switching always
// worked: clear the tab and rebind it. "new-tab" keeps the conversation on
// screen and "handoff" carries it to the new agent. An empty chat always flips
// in place, and a running one always gets a new tab.
describe("switchAgentForTab on an idle chat", () => {
  const behave = (agentSwitchBehavior: AppSettings["agentSwitchBehavior"]) =>
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, agentSwitchBehavior } });

  const converse = () => {
    const { actions } = useChatStore.getState();
    actions.setAcpBinding(TAB, "agent-1", "acp-1", "/repo");
    actions.addMessage(TAB, "user", "what does this repo do?");
    actions.addMessage(TAB, "assistant", "It scrapes hotel prices.");
    actions.setSessionTitle(TAB, "What does this repo do");
  };

  const handoffs: SessionHandoffDetail[] = [];
  const onHandoff = (e: Event) => handoffs.push((e as CustomEvent<SessionHandoffDetail>).detail);

  beforeEach(() => {
    localStorage.clear();
    openAgentChatInNewTab.mockClear();
    handoffs.length = 0;
    window.addEventListener(SESSION_HANDOFF_EVENT, onHandoff);
    useChatStore.setState({ sessions: {}, queues: {}, activeSessionId: null });
    useChatStore.getState().actions.createSession(TAB, "codex");
    behave("reset");
  });
  afterEach(() => window.removeEventListener(SESSION_HANDOFF_EVENT, onHandoff));

  it("keeps the conversation and opens the new agent in a new tab", () => {
    behave("new-tab");
    converse();

    switchAgentForTab(TAB, "claude-code");

    expect(openAgentChatInNewTab).toHaveBeenCalledWith("claude-code");
    const sess = useChatStore.getState().sessions[TAB];
    expect(sess.agentType).toBe("codex");
    expect(sess.acpSessionId).toBe("acp-1");
    expect(sess.messages.map((m) => m.content)).toEqual([
      "what does this repo do?",
      "It scrapes hotel prices.",
    ]);
    expect(handoffs).toEqual([]);
  });

  it("hands off in place: same tab, new agent, the conversation attached as a chip", () => {
    behave("handoff");
    converse();

    switchAgentForTab(TAB, "claude-code");

    expect(openAgentChatInNewTab).not.toHaveBeenCalled();
    const sess = useChatStore.getState().sessions[TAB];
    expect(sess.agentType).toBe("claude-code");
    expect(sess.acpSessionId).toBeUndefined();
    expect(sess.messages).toEqual([]);
    expect(handoffs).toEqual([
      {
        tabId: TAB,
        mention: {
          kind: "past_session",
          id: "acp-1",
          displayName: "What does this repo do",
          sessionId: "acp-1",
          sessionTitle: "What does this repo do",
          cwd: "/repo",
        },
      },
    ]);
  });

  it("falls back to a new tab when a handoff has no recorded session to attach", () => {
    behave("handoff");
    useChatStore.getState().actions.addMessage(TAB, "user", "never bound");

    switchAgentForTab(TAB, "claude-code");

    expect(openAgentChatInNewTab).toHaveBeenCalledWith("claude-code");
    expect(useChatStore.getState().sessions[TAB].agentType).toBe("codex");
    expect(handoffs).toEqual([]);
  });

  it("resets in place by default, attaching nothing", () => {
    expect(DEFAULT_SETTINGS.agentSwitchBehavior).toBe("reset");
    converse();

    switchAgentForTab(TAB, "claude-code");

    expect(openAgentChatInNewTab).not.toHaveBeenCalled();
    const sess = useChatStore.getState().sessions[TAB];
    expect(sess.agentType).toBe("claude-code");
    expect(sess.messages).toEqual([]);
    expect(handoffs).toEqual([]);
  });

  it.each(["new-tab", "handoff", "reset"] as const)("flips an empty chat in place (%s)", (b) => {
    behave(b);

    switchAgentForTab(TAB, "claude-code");

    expect(openAgentChatInNewTab).not.toHaveBeenCalled();
    expect(useChatStore.getState().sessions[TAB].agentType).toBe("claude-code");
    expect(handoffs).toEqual([]);
  });

  it.each(["new-tab", "handoff", "reset"] as const)(
    "still opens a new tab for a running chat (%s)",
    (b) => {
      behave(b);
      converse();
      useChatStore.getState().actions.updateSessionStatus(TAB, "running");

      switchAgentForTab(TAB, "claude-code");

      expect(openAgentChatInNewTab).toHaveBeenCalledWith("claude-code");
      expect(useChatStore.getState().sessions[TAB].agentType).toBe("codex");
      expect(handoffs).toEqual([]);
    },
  );
});
