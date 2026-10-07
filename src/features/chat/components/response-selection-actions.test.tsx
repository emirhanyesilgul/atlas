// @vitest-environment happy-dom
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ResponseSelectionActions } from "./response-selection-actions";
import { selectionCommentBody } from "@/features/artifacts/lib/selection-comment";
import { COMMENT_BODY_MAX } from "@/features/artifacts/lib/comments-api";
import { CommentBody } from "@/features/artifacts/components/comment-thread";

const state = vi.hoisted(() => ({ shared: true, post: vi.fn(async () => {}) }));
const directory = { byId: new Map(), currentUserId: null };
vi.mock("../stores/chat-comments-store", () => ({
  useAnchorHit: () => (state.shared ? { anchorKind: "message", rowId: "cloud-response" } : null),
  useCommentBucket: () => [],
  useCommentActions: () => ({ post: state.post, resolve: async () => {}, remove: async () => {} }),
  useCommentDirectory: () => directory,
}));

function Harness({ enabled = true }: { enabled?: boolean }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  return (
    <div>
      <div ref={viewportRef} data-testid="viewport">
        <p data-testid="user">User prompt</p>
        <div data-agent-response="wire-response">
          <p data-testid="prose">Scope it to the usage page.</p>
          <pre data-testid="code">{"const onFocus = () => {\n  refreshUsage();\n};"}</pre>
        </div>
        <p data-testid="streaming">Still arriving</p>
      </div>
      <ResponseSelectionActions viewportRef={viewportRef} tabId="chat-a" enabled={enabled} />
      <button>Outside</button>
    </div>
  );
}

function select(testId: string) {
  const node = screen.getByTestId(testId).firstChild!;
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}

beforeEach(() => {
  state.shared = true;
  state.post.mockReset();
  state.post.mockResolvedValue(undefined);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 600, 400),
  );
  vi.spyOn(Range.prototype, "getClientRects").mockReturnValue([
    new DOMRect(30, 60, 200, 20),
  ] as unknown as DOMRectList);
});
afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
});

async function passageComment() {
  render(<Harness />);
  select("prose");
  const toolbar = await screen.findByRole("group", { name: "Selected response actions" });
  fireEvent.click(within(toolbar).getByRole("button", { name: "Comment" }));
  return screen.findByPlaceholderText("Comment on this passage…");
}

describe("selected response actions", () => {
  it("offers Cite and Comment and routes a multiline quote only to its source chat", async () => {
    const insert = vi.fn();
    window.addEventListener("atlas:chat-insert", insert);
    try {
      render(<Harness />);
      select("code");
      const toolbar = await screen.findByRole("group", { name: "Selected response actions" });
      expect(within(toolbar).getByRole("button", { name: "Comment" })).toBeTruthy();
      fireEvent.click(within(toolbar).getByRole("button", { name: "Cite" }));
      expect(insert.mock.calls[0][0].detail).toEqual({
        text: "> const onFocus = () => {\n>   refreshUsage();\n> };",
        tabId: "chat-a",
        append: true,
      });
      expect(screen.queryByRole("group", { name: "Selected response actions" })).toBeNull();
      expect(window.getSelection()?.isCollapsed).toBe(true);
    } finally {
      window.removeEventListener("atlas:chat-insert", insert);
    }
  });

  it("waits until the pointer is released so the toolbar cannot intercept a multiline drag", async () => {
    render(<Harness />);
    fireEvent.pointerDown(screen.getByTestId("code"));
    select("code");
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(screen.queryByRole("group", { name: "Selected response actions" })).toBeNull();
    fireEvent.pointerUp(screen.getByTestId("code"));
    await screen.findByRole("group", { name: "Selected response actions" });
  });

  it.each(["user", "streaming"])("does not offer selection actions for %s text", async (testId) => {
    render(<Harness />);
    select(testId);
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(screen.queryByRole("group", { name: "Selected response actions" })).toBeNull();
  });

  it("keeps Cite available when the chat cannot be commented on", async () => {
    state.shared = false;
    render(<Harness />);
    select("prose");
    const toolbar = await screen.findByRole("group", { name: "Selected response actions" });
    expect(
      (within(toolbar).getByRole("button", { name: "Comment" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (within(toolbar).getByRole("button", { name: "Cite" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("supports Tab focus and dismisses on Escape, outside click and panel scroll", async () => {
    render(<Harness />);
    select("prose");
    await screen.findByRole("group", { name: "Selected response actions" });
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement?.textContent).toBe("Cite");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Selected response actions" })).toBeNull();
    fireEvent.click(screen.getByText("Outside"));
    select("prose");
    await screen.findByRole("group", { name: "Selected response actions" });
    fireEvent.pointerDown(screen.getByText("Outside"));
    expect(screen.queryByRole("group", { name: "Selected response actions" })).toBeNull();
    select("prose");
    await screen.findByRole("group", { name: "Selected response actions" });
    fireEvent.scroll(screen.getByTestId("viewport"));
    expect(screen.queryByRole("group", { name: "Selected response actions" })).toBeNull();
  });

  it("keeps a dismissed selection dismissed until the selection changes", async () => {
    const frame = () =>
      act(async () => {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });
    render(<Harness />);
    select("prose");
    await screen.findByRole("group", { name: "Selected response actions" });
    // A press on non-selectable chrome leaves the selection in place.
    for (const target of [screen.getByText("Outside"), screen.getByTestId("viewport")]) {
      fireEvent.pointerDown(target);
      fireEvent.pointerUp(target);
      await frame();
      expect(screen.queryByRole("group", { name: "Selected response actions" })).toBeNull();
      expect(window.getSelection()?.isCollapsed).toBe(false);
    }
    select("prose");
    await screen.findByRole("group", { name: "Selected response actions" });
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.pointerUp(screen.getByText("Outside"));
    await frame();
    expect(screen.queryByRole("group", { name: "Selected response actions" })).toBeNull();
  });

  it("offers whole-message Comment near hovered prose without adding an excerpt", async () => {
    render(<Harness />);
    fireEvent.pointerMove(screen.getByTestId("prose"), { clientX: 100, clientY: 200 });
    const toolbar = await screen.findByRole("group", { name: "Response actions" });
    expect(within(toolbar).queryByRole("button", { name: "Cite" })).toBeNull();
    fireEvent.click(within(toolbar).getByRole("button", { name: "Comment" }));
    const composer = await screen.findByPlaceholderText("Start a discussion");
    fireEvent.change(composer, { target: { value: "Whole response" } });
    fireEvent.click(screen.getByRole("button", { name: "Send comment" }));
    await waitFor(() =>
      expect(state.post).toHaveBeenCalledWith("message", "cloud-response", "Whole response", null),
    );
  });

  it("removes selection actions when the panel is hidden or the response disappears", async () => {
    const view = render(<Harness />);
    select("prose");
    await screen.findByRole("group", { name: "Selected response actions" });
    act(() => screen.getByTestId("prose").parentElement!.remove());
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: "Selected response actions" })).toBeNull(),
    );
    view.rerender(<Harness enabled={false} />);
    expect(screen.queryByRole("group")).toBeNull();
  });
});

describe("passage comments", () => {
  it("posts the selected passage with its response anchor and keeps the draft on failure", async () => {
    state.post.mockRejectedValueOnce(new Error("offline"));
    const composer = await passageComment();
    expect(screen.getByRole("blockquote", { name: "Selected passage" }).textContent).toBe(
      "Scope it to the usage page.",
    );
    fireEvent.change(composer, { target: { value: "Should billing refresh too?" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await screen.findByText("Error: offline");
    expect((composer as HTMLTextAreaElement).value).toBe("Should billing refresh too?");
    fireEvent.click(screen.getByRole("button", { name: "Send comment" }));
    await waitFor(() => expect((composer as HTMLTextAreaElement).value).toBe(""));
    expect(state.post).toHaveBeenLastCalledWith(
      "message",
      "cloud-response",
      selectionCommentBody("Scope it to the usage page.", "Should billing refresh too?"),
      null,
    );
  });

  it("counts the persisted quote toward the server cap, including Enter sends", async () => {
    const composer = await passageComment();
    fireEvent.change(composer, { target: { value: "x".repeat(COMMENT_BODY_MAX) } });
    expect(
      (screen.getByRole("button", { name: "Send comment" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(state.post).not.toHaveBeenCalled();
    expect(screen.getByText(/including the selected passage/)).toBeTruthy();
  });

  it("renders a saved passage literally and renders actual comment mentions separately", () => {
    const text = "<script>literal</script>\n  <@someone> &lt;";
    render(
      <CommentBody
        text={selectionCommentBody(text, "Ask <@someone> about this")}
        directory={directory}
      />,
    );
    expect(screen.getByRole("blockquote", { name: "Selected passage" }).textContent).toBe(text);
    expect(screen.getByText("@someone")).toBeTruthy();
    expect(document.querySelector("script")).toBeNull();
  });
});
