// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import type { ClonedRepo, GithubRepo } from "@/features/github/types";

/**
 * Flow-level reference test: drives the panel the way a person does — type,
 * press Enter, click — and asserts both what reaches the IPC boundary and what
 * the panel renders back.
 *
 * Everything below the component is faked (`invoke`, the project store, the
 * log) so the test needs no Tauri process and runs on any OS. That is the
 * deliberate trade: this catches component logic and wiring, not rendering
 * fidelity. Whether the commands exist at all is covered once for the whole
 * app by `tests/ipc-contract.test.ts`.
 *
 * `invoke` is faked per COMMAND rather than per call: the panel lists the
 * cloned repos on mount, so a positional `mockResolvedValueOnce` queue would
 * hand the search's answer to the listing.
 */

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  logEvent: vi.fn(),
  openUrl: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  currentProject: null as { path: string } | null,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));
vi.mock("@/features/log/lib/log", () => ({ logEvent: mocks.logEvent }));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/features/app/stores/app-store", () => ({
  useAppStore: { use: { currentProject: () => mocks.currentProject } },
}));

const { GithubPanel } = await import("./github-panel");

type Answer = unknown | (() => unknown);
/** Route each command to its own answer (a value, a thunk, or a rejection). */
function answer(table: Record<string, Answer>) {
  mocks.invoke.mockImplementation((cmd: string) => {
    if (!(cmd in table)) return Promise.resolve(undefined);
    const a = table[cmd];
    try {
      const v = typeof a === "function" ? (a as () => unknown)() : a;
      return v instanceof Error ? Promise.reject(v.message) : Promise.resolve(v);
    } catch (e) {
      return Promise.reject(e);
    }
  });
}

function repo(overrides: Partial<GithubRepo> = {}): GithubRepo {
  return {
    name: "atlas",
    full_name: "ahammadnafiz/atlas",
    description: "An agentic desktop workspace",
    html_url: "https://github.com/ahammadnafiz/atlas",
    clone_url: "https://github.com/ahammadnafiz/atlas.git",
    language: "Rust",
    stars: 1234,
    forks: 56,
    updated_at: "2026-06-15T12:00:00Z",
    ...overrides,
  };
}

function cloned(overrides: Partial<ClonedRepo> = {}): ClonedRepo {
  return {
    name: "zed-industries-zed",
    display_name: "zed-industries/zed",
    path: "/Users/dev/myproject/.atlas/repos/zed-industries-zed",
    has_readme: true,
    branch: "main",
    meta: {
      description: "A high-performance code editor",
      language: "Rust",
      stars: 60_000,
      forks: 4_000,
      html_url: "https://github.com/zed-industries/zed",
      updated_at: "2026-09-01T00:00:00Z",
    },
    ...overrides,
  };
}

const calls = (cmd: string) => mocks.invoke.mock.calls.filter((c) => c[0] === cmd);

/** `n` the way the panel's `toLocaleString` writes it on this machine, as a
 *  pattern: "1,234" in one locale is "1.234" in another. */
const grouped = (n: number) =>
  new RegExp(n.toLocaleString().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

/** Type into the search box and submit, as a user would. */
async function search(term: string) {
  const user = userEvent.setup();
  await user.type(screen.getByPlaceholderText(/search github repositories/i), `${term}{Enter}`);
  return user;
}

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.logEvent.mockReset();
  mocks.openUrl.mockReset();
  mocks.toast.success.mockReset();
  mocks.toast.error.mockReset();
  mocks.currentProject = null;
  answer({});
});

afterEach(() => {
  cleanup();
});

describe("searching", () => {
  it("shows an empty state before anything is typed", () => {
    render(<GithubPanel />);
    expect(screen.getByText("Search for repositories")).toBeInTheDocument();
    expect(calls("search_github")).toHaveLength(0);
  });

  it("sends the trimmed query to search_github on Enter", async () => {
    answer({ search_github: [] });
    render(<GithubPanel />);
    await search("  tauri  ");
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("search_github", { query: "tauri" }),
    );
  });

  it.each([
    ["an empty query", ""],
    ["a whitespace-only query", "   "],
  ])("does not call the backend for %s", async (_label, term) => {
    render(<GithubPanel />);
    await search(term);
    expect(calls("search_github")).toHaveLength(0);
  });

  it("renders each result with its star and fork counts", async () => {
    answer({ search_github: [repo()] });
    render(<GithubPanel />);
    await search("atlas");
    expect(await screen.findByText("ahammadnafiz/atlas")).toBeInTheDocument();
    // Thousands separator comes from `toLocaleString`, so it is the machine's.
    expect(screen.getByText(grouped(1234))).toBeInTheDocument();
    expect(screen.getByText(/56/)).toBeInTheDocument();
  });

  it("distinguishes 'no matches' from the initial empty state", async () => {
    answer({ search_github: [] });
    render(<GithubPanel />);
    await search("nothing-matches-this");
    expect(await screen.findByText("No repositories found")).toBeInTheDocument();
    expect(screen.queryByText("Search for repositories")).not.toBeInTheDocument();
  });
});

describe("when the search fails", () => {
  it("surfaces the backend error instead of an empty list", async () => {
    answer({ search_github: new Error("GitHub API rate limit exceeded") });
    render(<GithubPanel />);
    await search("atlas");
    expect(await screen.findByText(/rate limit exceeded/i)).toBeInTheDocument();
    expect(screen.queryByText("No repositories found")).not.toBeInTheDocument();
  });

  it("retries the same query and clears the error on success", async () => {
    let attempts = 0;
    answer({
      search_github: () => {
        attempts += 1;
        if (attempts === 1) throw "network down";
        return [repo()];
      },
    });
    render(<GithubPanel />);
    const user = await search("atlas");

    await user.click(await screen.findByRole("button", { name: /retry/i }));

    expect(await screen.findByText("ahammadnafiz/atlas")).toBeInTheDocument();
    expect(screen.queryByText("network down")).not.toBeInTheDocument();
    expect(calls("search_github")).toHaveLength(2);
  });

  it("drops stale results when a later search errors", async () => {
    let attempts = 0;
    answer({
      search_github: () => {
        attempts += 1;
        if (attempts === 1) return [repo()];
        throw "boom";
      },
    });
    render(<GithubPanel />);
    const user = await search("atlas");
    await screen.findByText("ahammadnafiz/atlas");

    await user.type(screen.getByPlaceholderText(/search github/i), "{Enter}");

    expect(await screen.findByText("boom")).toBeInTheDocument();
    expect(screen.queryByText("ahammadnafiz/atlas")).not.toBeInTheDocument();
  });
});

describe("cloning", () => {
  const CLONE = "Clone to .atlas/repos/";

  it("offers no clone button without an open project", async () => {
    // There is nowhere to clone to, so the affordance must not appear at all.
    mocks.currentProject = null;
    answer({ search_github: [repo()] });
    render(<GithubPanel />);
    await search("atlas");
    await screen.findByText("ahammadnafiz/atlas");
    expect(screen.queryByRole("button", { name: CLONE })).not.toBeInTheDocument();
  });

  it("clones into the open project, flattening the slash in the directory name", async () => {
    mocks.currentProject = { path: "/Users/dev/myproject" };
    answer({ search_github: [repo()], list_cloned_repos: [] });
    render(<GithubPanel />);
    const user = await search("atlas");

    await user.click(await screen.findByRole("button", { name: CLONE }));

    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("clone_github_repo", {
        projectPath: "/Users/dev/myproject",
        cloneUrl: "https://github.com/ahammadnafiz/atlas.git",
        // `owner/repo` would otherwise be read as a nested path on disk.
        repoName: "ahammadnafiz-atlas",
        // What the search knew, so the cloned list can show it without
        // asking GitHub again.
        meta: {
          description: "An agentic desktop workspace",
          language: "Rust",
          stars: 1234,
          forks: 56,
          html_url: "https://github.com/ahammadnafiz/atlas",
          updated_at: "2026-06-15T12:00:00Z",
        },
      }),
    );
  });

  it("marks the repo cloned and refuses a second clone", async () => {
    mocks.currentProject = { path: "/Users/dev/myproject" };
    answer({ search_github: [repo()], list_cloned_repos: [] });
    render(<GithubPanel />);
    const user = await search("atlas");

    await user.click(await screen.findByRole("button", { name: CLONE }));

    const done = await screen.findByRole("button", { name: "Cloned" });
    expect(done).toBeDisabled();
    const afterFirstClone = calls("clone_github_repo").length;
    await user.click(done);
    expect(calls("clone_github_repo")).toHaveLength(afterFirstClone);
  });

  it("reads a search hit as already cloned when it is on disk", async () => {
    mocks.currentProject = { path: "/Users/dev/myproject" };
    answer({
      search_github: [repo()],
      list_cloned_repos: [
        cloned({ name: "ahammadnafiz-atlas", display_name: "ahammadnafiz/atlas" }),
      ],
    });
    render(<GithubPanel />);
    await search("atlas");
    expect(await screen.findByRole("button", { name: "Cloned" })).toBeDisabled();
  });

  it("notifies the rest of the app so the file tree refreshes", async () => {
    mocks.currentProject = { path: "/Users/dev/myproject" };
    answer({ search_github: [repo()], list_cloned_repos: [] });
    const clonedEvent = vi.fn();
    window.addEventListener("atlas:repo-cloned", clonedEvent);
    try {
      render(<GithubPanel />);
      const user = await search("atlas");
      await user.click(await screen.findByRole("button", { name: CLONE }));
      await waitFor(() => expect(clonedEvent).toHaveBeenCalledTimes(1));
      expect(mocks.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({ source: "github", kind: "clone" }),
      );
    } finally {
      window.removeEventListener("atlas:repo-cloned", clonedEvent);
    }
  });

  it("re-enables the button when the clone fails", async () => {
    // A failed clone previously left the row stuck in its spinner state.
    mocks.currentProject = { path: "/Users/dev/myproject" };
    answer({
      search_github: [repo()],
      list_cloned_repos: [],
      clone_github_repo: new Error("permission denied"),
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<GithubPanel />);
    const user = await search("atlas");

    await user.click(await screen.findByRole("button", { name: CLONE }));

    await waitFor(() => expect(screen.getByRole("button", { name: CLONE })).toBeEnabled());
    expect(screen.queryByRole("button", { name: "Cloned" })).not.toBeInTheDocument();
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });
});

describe("the cloned repos", () => {
  beforeEach(() => {
    mocks.currentProject = { path: "/Users/dev/myproject" };
  });

  it("are listed on open, with branch and cached metadata, and hidden while searching", async () => {
    answer({
      list_cloned_repos: [
        cloned(),
        cloned({ name: "openai-codex", display_name: "openai/codex", branch: null, meta: null }),
      ],
      search_github: [],
      fetch_cloned_repo_meta: new Error("rate limited"),
    });
    render(<GithubPanel />);
    expect(await screen.findByText("zed-industries/zed")).toBeInTheDocument();
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.getByText("detached")).toBeInTheDocument();
    expect(screen.getByText("A high-performance code editor")).toBeInTheDocument();
    expect(screen.getByText(grouped(60_000))).toBeInTheDocument();
    expect(screen.queryByText("Search for repositories")).not.toBeInTheDocument();

    await search("anything");
    await waitFor(() => expect(screen.queryByText("zed-industries/zed")).not.toBeInTheDocument());
  });

  it("fills in metadata for clones that predate the cache, once", async () => {
    answer({
      list_cloned_repos: [cloned({ meta: null })],
      fetch_cloned_repo_meta: {
        description: "Filled in later",
        language: "Rust",
        stars: 1,
        forks: 2,
        html_url: "https://github.com/zed-industries/zed",
        updated_at: "",
      },
    });
    render(<GithubPanel />);
    expect(await screen.findByText("Filled in later")).toBeInTheDocument();
    await waitFor(() => expect(calls("fetch_cloned_repo_meta")).toHaveLength(1));
    expect(mocks.invoke).toHaveBeenCalledWith("fetch_cloned_repo_meta", {
      projectPath: "/Users/dev/myproject",
      repoName: "zed-industries-zed",
    });
  });

  it("asks origin for branches only when the picker opens, filters them, and switches shallowly", async () => {
    answer({
      list_cloned_repos: [cloned()],
      list_remote_branches: ["develop", "main", "release/1.0"],
      switch_cloned_repo_branch: "develop",
    });
    render(<GithubPanel />);
    await screen.findByText("zed-industries/zed");
    expect(calls("list_remote_branches")).toHaveLength(0);

    const user = userEvent.setup();
    await user.click(screen.getByTitle("Switch to another remote branch"));
    const filter = await screen.findByPlaceholderText("Filter branches");
    await screen.findByText("develop");
    expect(mocks.invoke).toHaveBeenCalledWith("list_remote_branches", {
      projectPath: "/Users/dev/myproject",
      repoName: "zed-industries-zed",
    });

    await user.type(filter, "dev");
    expect(screen.queryByText("release/1.0")).not.toBeInTheDocument();
    await user.click(screen.getByText("develop"));
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("switch_cloned_repo_branch", {
        projectPath: "/Users/dev/myproject",
        repoName: "zed-industries-zed",
        branch: "develop",
      }),
    );
    // The list is re-read so the row shows the branch git actually landed on.
    await waitFor(() => expect(calls("list_cloned_repos").length).toBeGreaterThan(1));
  });

  it("fetches the checked-out branch and re-reads the list", async () => {
    answer({ list_cloned_repos: [cloned()], update_cloned_repo: "main" });
    render(<GithubPanel />);
    await screen.findByText("zed-industries/zed");
    await userEvent.setup().click(screen.getByRole("button", { name: "Fetch origin/main" }));
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("update_cloned_repo", {
        projectPath: "/Users/dev/myproject",
        repoName: "zed-industries-zed",
      }),
    );
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalled());
  });

  it("cannot fetch a detached clone", async () => {
    answer({ list_cloned_repos: [cloned({ branch: null })] });
    render(<GithubPanel />);
    await screen.findByText("zed-industries/zed");
    expect(screen.getByRole("button", { name: "Pick a branch to fetch" })).toBeDisabled();
  });

  it("deletes only on the second click", async () => {
    answer({ list_cloned_repos: [cloned()] });
    render(<GithubPanel />);
    await screen.findByText("zed-industries/zed");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Delete clone" }));
    expect(calls("delete_cloned_repo")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Click again to delete the clone" }));
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("delete_cloned_repo", {
        projectPath: "/Users/dev/myproject",
        repoName: "zed-industries-zed",
      }),
    );
  });

  it("reports a failed switch instead of pretending", async () => {
    answer({
      list_cloned_repos: [cloned()],
      list_remote_branches: ["develop", "main"],
      switch_cloned_repo_branch: new Error("fatal: couldn't find remote ref develop"),
    });
    render(<GithubPanel />);
    await screen.findByText("zed-industries/zed");
    const user = userEvent.setup();
    await user.click(screen.getByTitle("Switch to another remote branch"));
    await screen.findByPlaceholderText("Filter branches");
    await user.click(await screen.findByText("develop"));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalled());
  });
});
