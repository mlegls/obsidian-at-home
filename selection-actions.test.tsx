// @vitest-environment jsdom
import { act, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const source = {
  kind: "workspace" as const,
  threadId: "thread-1",
  environmentId: "env-1",
  projectId: "project-1",
};

async function openNote() {
  const app = await loadPluginApp(() => import("./app.js"));
  const slot = renderSlot(
    app.fileOpeners[0]!,
    { path: "notes/Plan.md", source, Original: () => <div>Original preview</div> },
    {
      rpc: {
        open_markdown: () => ({ content: "Ship the selection menu today.", sha256: "sha" }),
        refresh_markdown: (input) => ({ changed: false, sha256: (input as { knownSha256: string }).knownSha256 }),
        resolve_markdown_links: () => ({ links: [] }),
      },
      openThreadPanel: () => true,
    },
  );
  const paragraph = await slot.findByText("Ship the selection menu today.");
  return { app, slot, paragraph };
}

async function selectText(node: Node, start: number, end: number) {
  const text = node.firstChild!;
  const range = document.createRange();
  range.setStart(text, start);
  range.setEnd(text, end);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  await act(async () => {
    fireEvent.pointerUp(node);
    fireEvent.click(node);
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.getSelection()?.removeAllRanges();
});

describe("note selection menu", () => {
  it("quotes a selection into the composer without entering edit mode", async () => {
    const { slot, paragraph } = await openNote();
    try {
      await selectText(paragraph, 9, 23);
      expect(slot.getByText("Live preview")).toBeTruthy();
      fireEvent.click(await slot.findByRole("menuitem", { name: "Add to chat" }));
      expect(slot.composer.quotes).toEqual(["selection menu"]);
      await waitFor(() => expect(slot.queryByRole("menu")).toBeNull());
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("starts a side chat on the note's thread and opens it in the side panel", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, result: { threadId: "side-1" } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { slot, paragraph } = await openNote();
    try {
      await selectText(paragraph, 9, 23);
      fireEvent.click(await slot.findByRole("menuitem", { name: "Reply in side chat" }));
      await waitFor(() =>
        expect(slot.navigateCalls).toContainEqual({
          method: "openThreadPanel",
          options: {
            actionId: "note-side-chat",
            title: "Side chat",
            params: {
              threadId: "side-1",
              sourceThreadId: "thread-1",
              anchorText: "From `notes/Plan.md`:\n\n> selection menu",
            },
          },
        }),
      );
      const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
      const [, init] = calls.find(([url]) => url === "/api/v1/plugins/side-chat/rpc/createSideChat")!;
      expect(JSON.parse(init.body as string)).toEqual({
        sourceThreadId: "thread-1",
        anchorText: "From `notes/Plan.md`:\n\n> selection menu",
      });
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("registers the side chat panel tab", async () => {
    const app = await loadPluginApp(() => import("./app.js"));
    expect(app.threadPanelActions.map((action) => action.id)).toContain("note-side-chat");
  });
});
