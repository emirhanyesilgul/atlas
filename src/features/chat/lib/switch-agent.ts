import { toast } from "sonner";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { NATIVE_AGENT, isBusyAgentStatus, type SwitchableAgent } from "@/types/agent";
import { agentMeta, switchableAgentIds } from "@/features/agents/lib/agent-meta";
import type { MentionPastSession } from "./mentions";
import { openAgentChatInNewTab } from "./open-agent-session";
import { projectPathForTab } from "./tab-project";

/** The window event a handoff fires; the composer of `tabId` inserts the
 *  previous conversation as a past-session chip. */
export const SESSION_HANDOFF_EVENT = "atlas:chat-handoff-session";

export interface SessionHandoffDetail {
  tabId: string;
  mention: MentionPastSession;
}

/**
 * Bind a chat tab to a different coding agent — the single implementation
 * behind every entry point (⌥/ cycle, the composer's agent pill, the "+" menu
 * picker), so they can never drift apart.
 *
 * A session is paired to ONE agent for its lifetime, so switching means a fresh
 * session. The cases:
 * - empty chat  → flip the agent in place, nothing to lose.
 * - idle chat   → the user's `agentSwitchBehavior` setting decides:
 *                 "reset" (default) switches in place and starts over;
 *                 "new-tab" leaves it on screen and opens a fresh tab on the
 *                 new agent; "handoff" switches in place and attaches the
 *                 conversation to the composer as a past-session chip, so the
 *                 new agent receives it with the next message. Either way the
 *                 old conversation is persisted per-turn and stays in history.
 * - BUSY chat   → leave it completely alone and open a fresh tab on the new
 *                 agent. Clearing here would orphan the live turn: its deltas
 *                 would find no tab, Stop would vanish, and it would keep
 *                 running invisibly.
 * - STARTING     → the one busy case that IS switched in place: `running` only
 *                 because a first message is held on a bind that has not landed
 *                 (`pendingSend`, no `acpSessionId`). Nothing is streaming and
 *                 no backend turn exists, so there is nothing to orphan — and a
 *                 stuck start is exactly when the user reaches for ⌥/. The held
 *                 message is carried over: re-recorded as the new session's
 *                 first bubble and re-held, so the new bind dispatches it.
 */
export function switchAgentForTab(tabId: string, next: SwitchableAgent): void {
  const chat = useChatStore.getState();
  const sess = chat.sessions[tabId];
  if ((sess?.agentType ?? NATIVE_AGENT) === next) return;

  const startingOnly = isStartingOnly(sess);
  if (!startingOnly && isBusyAgentStatus(sess?.status)) {
    openAgentChatInNewTab(next);
    return;
  }
  let handoff: MentionPastSession | undefined;
  if (!startingOnly && (sess?.messages.length ?? 0) > 0) {
    const behavior = useSettingsStore.getState().settings.agentSwitchBehavior;
    // A handoff needs the transcript Atlas recorded under the bound session;
    // without one there is nothing to attach, so keep the conversation instead.
    if (behavior === "new-tab" || (behavior === "handoff" && !sess?.acpSessionId)) {
      openAgentChatInNewTab(next);
      return;
    }
    if (behavior === "handoff" && sess?.acpSessionId) {
      const title = sess.title && sess.title !== "New Chat" ? sess.title : "Previous session";
      handoff = {
        kind: "past_session",
        id: sess.acpSessionId,
        displayName: title,
        sessionId: sess.acpSessionId,
        sessionTitle: title,
        cwd: sess.workingDirectory || projectPathForTab(tabId) || "",
      };
    }
  }
  const previousAgent = sess?.agentType ?? NATIVE_AGENT;
  const held = startingOnly ? sess?.pendingSend : undefined;
  if ((sess?.messages.length ?? 0) > 0) {
    chat.actions.clearSession(tabId);
  }
  chat.actions.switchChatAgent(tabId, next);
  if (held) {
    // Same shape as the composer's first-while-starting send: bubble first,
    // title from the text, status running, prompt held on the session.
    const { actions } = useChatStore.getState();
    actions.addMessage(tabId, "user", held.content, held.attachments);
    actions.setSessionTitle(
      tabId,
      held.content.slice(0, 40) + (held.content.length > 40 ? "..." : ""),
    );
    actions.updateSessionStatus(tabId, "running");
    actions.setPendingSend(tabId, held);
  }
  if (handoff) {
    const detail: SessionHandoffDetail = { tabId, mention: handoff };
    window.dispatchEvent(new CustomEvent(SESSION_HANDOFF_EVENT, { detail }));
    toast(
      `${agentMeta(previousAgent).label} conversation attached. Your next message hands it to ${agentMeta(next).label}.`,
    );
  }
  window.dispatchEvent(new CustomEvent("atlas:chat-focus", { detail: { tabId } }));
}

/** "Busy" only in the sense that a first message is waiting on a bind that
 *  has not produced a session yet. Exported for the composer's stall
 *  affordance, which offers the switch in exactly this state. */
export function isStartingOnly(
  sess: { status?: string; pendingSend?: unknown; acpSessionId?: string } | undefined,
): boolean {
  return !!sess && sess.status === "running" && !!sess.pendingSend && !sess.acpSessionId;
}

/** The next agent in the ⌥/ rotation for a tab — first-party agents in their
 *  fixed order, then any installed registry externals. */
function nextAgentForTab(tabId: string): SwitchableAgent {
  const rotation = switchableAgentIds();
  const cur = useChatStore.getState().sessions[tabId]?.agentType;
  const idx = rotation.indexOf(cur ?? NATIVE_AGENT);
  return rotation[(Math.max(idx, 0) + 1) % rotation.length];
}

/** Advance a chat tab to the next agent (⌥/ and the composer's agent pill). */
export function cycleChatAgent(tabId: string): void {
  switchAgentForTab(tabId, nextAgentForTab(tabId));
}
