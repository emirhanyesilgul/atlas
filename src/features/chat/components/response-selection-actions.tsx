import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Quote, MessageSquare } from "lucide-react";
import { Button } from "@/ui/button";
import { Hint } from "@/ui/tooltip";
import { CommentButton } from "@/features/artifacts/components/comment-thread";
import { quoteLines } from "@/features/artifacts/lib/selection-comment";
import {
  useAnchorHit,
  useCommentActions,
  useCommentBucket,
  useCommentDirectory,
} from "../stores/chat-comments-store";
import {
  actionPosition,
  responseAt,
  selectedResponse,
  type ChatInsertDetail,
} from "../lib/response-selection";

interface Target {
  response: HTMLElement;
  messageId: string;
  text: string | null;
  anchor: { x: number; top: number; bottom: number };
}

/** One delegated controller per visible transcript, rather than document
 * listeners or pointer-driven React renders on every response row. */
export function ResponseSelectionActions({
  viewportRef,
  tabId,
  enabled,
}: {
  viewportRef: React.RefObject<HTMLDivElement | null>;
  tabId: string;
  enabled: boolean;
}) {
  const [target, setTarget] = useState<Target | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(false);
  const targetRef = useRef(target);
  targetRef.current = target;

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!enabled || !viewport) {
      setTarget(null);
      return;
    }
    let frame = 0;
    let selecting = false;
    // Clicking non-selectable chrome (sidebar, gutters) leaves the selection
    // intact, so the next pointerup would read it and bring the toolbar back.
    // A dismissed selection stays dismissed until the selection changes.
    let dismissed = false;
    const dismiss = () => {
      openRef.current = false;
      dismissed = true;
      setTarget(null);
    };
    const readSelection = () => {
      if (
        dismissed ||
        selecting ||
        openRef.current ||
        toolbarRef.current?.contains(document.activeElement)
      )
        return;
      const selected = selectedResponse(window.getSelection(), viewport);
      if (!selected) {
        setTarget(null);
        return;
      }
      const bounds = viewport.getBoundingClientRect();
      const rects = Array.from(selected.range.getClientRects());
      const visibleRects = rects.filter((r) => r.bottom > bounds.top && r.top < bounds.bottom);
      const rect = visibleRects[visibleRects.length - 1];
      if (!rect) {
        setTarget(null);
        return;
      }
      setTarget({
        response: selected.response,
        messageId: selected.response.dataset.agentResponse!,
        text: selected.text,
        anchor: { x: rect.left, top: rect.top, bottom: rect.bottom },
      });
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(readSelection);
    };
    const selectionChange = () => {
      dismissed = false;
      schedule();
    };
    const move = (event: PointerEvent) => {
      if (
        event.pointerType === "touch" ||
        event.buttons ||
        openRef.current ||
        (targetRef.current?.text !== null && targetRef.current?.text !== undefined)
      )
        return;
      if (toolbarRef.current?.contains(event.target as Node)) return;
      const response = responseAt(event.target as Node, viewport);
      if (!response) {
        setTarget(null);
        return;
      }
      // A stationary button is easier to hit than one chasing every pointer
      // pixel. Move it only after the reader moves to another line/response.
      const prev = targetRef.current;
      if (prev?.response === response && Math.abs(event.clientY - prev.anchor.top) < 32) return;
      setTarget({
        response,
        messageId: response.dataset.agentResponse!,
        text: null,
        anchor: { x: event.clientX + 12, top: event.clientY, bottom: event.clientY + 4 },
      });
    };
    const leave = (event: PointerEvent) => {
      if (toolbarRef.current?.contains(event.relatedTarget as Node)) return;
      if (
        !targetRef.current?.text &&
        !openRef.current &&
        !toolbarRef.current?.contains(document.activeElement)
      )
        setTarget(null);
    };
    const focus = (event: FocusEvent) => {
      if (!openRef.current && !toolbarRef.current?.contains(event.target as Node)) dismiss();
    };
    const pointerDown = (event: PointerEvent) => {
      selecting = viewport.contains(event.target as Node);
      if (!openRef.current && !toolbarRef.current?.contains(event.target as Node)) dismiss();
    };
    const pointerUp = () => {
      selecting = false;
      schedule();
    };
    const pointerCancel = () => {
      selecting = false;
      dismiss();
    };
    const key = (event: KeyboardEvent) => {
      if (openRef.current) return; // The comment popover owns its focus and Escape.
      if (event.key === "Escape" && targetRef.current) {
        event.preventDefault();
        dismiss();
      } else if (
        event.key === "Tab" &&
        !event.shiftKey &&
        targetRef.current?.text &&
        !toolbarRef.current?.contains(document.activeElement)
      ) {
        event.preventDefault();
        toolbarRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
      }
    };
    const observer = new MutationObserver(() => {
      if (
        targetRef.current &&
        (!viewport.contains(targetRef.current.response) ||
          targetRef.current.response.dataset.agentResponse !== targetRef.current.messageId)
      )
        dismiss();
    });
    observer.observe(viewport, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-agent-response"],
    });
    // Split-pane and sidebar resizes need not resize the window itself.
    // Ignore ResizeObserver's initial delivery so a new selection survives.
    let width = viewport.clientWidth,
      height = viewport.clientHeight;
    const resizeObserver = new ResizeObserver(() => {
      if (viewport.clientWidth !== width || viewport.clientHeight !== height) {
        width = viewport.clientWidth;
        height = viewport.clientHeight;
        dismiss();
      }
    });
    resizeObserver.observe(viewport);
    document.addEventListener("selectionchange", selectionChange);
    document.addEventListener("pointerup", pointerUp);
    document.addEventListener("pointercancel", pointerCancel);
    document.addEventListener("pointerdown", pointerDown);
    document.addEventListener("focusin", focus);
    document.addEventListener("keydown", key);
    viewport.addEventListener("pointermove", move);
    viewport.addEventListener("pointerleave", leave);
    viewport.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      resizeObserver.disconnect();
      document.removeEventListener("selectionchange", selectionChange);
      document.removeEventListener("pointerup", pointerUp);
      document.removeEventListener("pointercancel", pointerCancel);
      document.removeEventListener("pointerdown", pointerDown);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("keydown", key);
      viewport.removeEventListener("pointermove", move);
      viewport.removeEventListener("pointerleave", leave);
      viewport.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
      openRef.current = false;
    };
  }, [enabled, viewportRef]);

  if (!enabled || !target) return null;
  return (
    <SelectionToolbar
      key={`${tabId}:${target.messageId}:${target.text ?? ""}`}
      target={target}
      tabId={tabId}
      viewportRef={viewportRef}
      toolbarRef={toolbarRef}
      onOpenChange={(open) => {
        openRef.current = open;
        if (!open) setTarget(null);
      }}
      onDismiss={() => setTarget(null)}
      onPointerLeave={(event) => {
        if (
          !openRef.current &&
          targetRef.current?.text === null &&
          !viewportRef.current?.contains(event.relatedTarget as Node)
        )
          setTarget(null);
      }}
    />
  );
}

function SelectionToolbar({
  target,
  tabId,
  viewportRef,
  toolbarRef,
  onOpenChange,
  onDismiss,
  onPointerLeave,
}: {
  target: Target;
  tabId: string;
  viewportRef: React.RefObject<HTMLDivElement | null>;
  toolbarRef: React.RefObject<HTMLDivElement | null>;
  onOpenChange: (open: boolean) => void;
  onDismiss: () => void;
  onPointerLeave: React.PointerEventHandler<HTMLDivElement>;
}) {
  const hit = useAnchorHit(tabId, target.messageId);
  const comments = useCommentBucket(tabId, target.messageId);
  const actions = useCommentActions(tabId);
  const directory = useCommentDirectory(tabId);
  const canComment = !!(hit && actions && directory);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    const viewport = viewportRef.current,
      toolbar = toolbarRef.current;
    if (!viewport || !toolbar) return;
    const bounds = viewport.getBoundingClientRect();
    setPosition(
      actionPosition(
        bounds,
        {
          width: viewport.clientWidth,
          height: viewport.clientHeight,
          offsetWidth: viewport.offsetWidth,
          offsetHeight: viewport.offsetHeight,
        },
        target.anchor,
        { width: toolbar.offsetWidth, height: toolbar.offsetHeight },
      ),
    );
  }, [target, viewportRef, toolbarRef, canComment]);
  if (!target.text && !canComment) return null;
  return (
    <div
      ref={toolbarRef}
      role="group"
      aria-label={target.text ? "Selected response actions" : "Response actions"}
      className="absolute z-popover flex max-w-full items-center gap-0.5 rounded-lg border border-border bg-popover p-1 text-foreground shadow-md"
      style={position}
      onPointerLeave={onPointerLeave}
      onMouseDown={(event) => event.preventDefault()}
    >
      {target.text !== null && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            window.dispatchEvent(
              new CustomEvent<ChatInsertDetail>("atlas:chat-insert", {
                detail: { text: quoteLines(target.text!), tabId, append: true },
              }),
            );
            window.getSelection()?.removeAllRanges();
            onDismiss();
          }}
        >
          <Quote size={12} />
          Cite
        </Button>
      )}
      {canComment ? (
        <CommentButton
          bare
          showLabel
          className="px-2 opacity-100 transition-none"
          anchorKind={hit!.anchorKind}
          anchorId={hit!.rowId}
          comments={comments}
          actions={actions!}
          directory={directory!}
          selectedText={target.text ?? undefined}
          onOpenChange={onOpenChange}
          collisionBoundary={viewportRef.current ?? undefined}
        />
      ) : (
        <Hint label="Share this chat to comment on a response">
          <Button variant="ghost" size="sm" aria-label="Comment" disabled>
            <MessageSquare size={12} />
            Comment
          </Button>
        </Hint>
      )}
    </div>
  );
}
