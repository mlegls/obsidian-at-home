import { useCallback, useEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import {
  Markdown,
  ThreadChat,
  useBbNavigate,
  useComposer,
  useRpc,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server.js";

/**
 * The note viewer replaces BB's file preview, and with it the host's
 * text-selection menu. This restores that menu over a note: "Add to chat"
 * quotes the selection into the thread composer, and "Reply in side chat"
 * forks the thread through the built-in side-chat plugin and opens the fork
 * in this plugin's side panel tab, as BB's selection menu does for messages.
 */

export const NOTE_SIDE_CHAT_ACTION_ID = "note-side-chat";
const SIDE_CHAT_PLUGIN_ID = "side-chat";

interface NoteSelection {
  text: string;
  rect: { top: number; bottom: number; left: number; width: number };
}

export interface NoteSideChatParams {
  threadId: string;
  sourceThreadId: string;
  anchorText: string;
}

export function parseNoteSideChatParams(value: unknown): NoteSideChatParams | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.threadId !== "string" || record.threadId.length === 0) return null;
  if (typeof record.sourceThreadId !== "string" || record.sourceThreadId.length === 0) return null;
  return {
    threadId: record.threadId,
    sourceThreadId: record.sourceThreadId,
    anchorText: typeof record.anchorText === "string" ? record.anchorText : "",
  };
}

/** The anchor the side chat seeds its agent with and shows as "Replying to". */
export function noteSideChatAnchor(path: string, text: string): string {
  const quoted = text
    .trim()
    .split("\n")
    .map((line) => (line.length > 0 ? "> " + line : ">"))
    .join("\n");
  return "From `" + path + "`:\n\n" + quoted;
}

/** Forks the thread through the built-in side-chat plugin's RPC. */
async function createSideChat(sourceThreadId: string, anchorText: string): Promise<string> {
  const response = await fetch(
    "/api/v1/plugins/" + SIDE_CHAT_PLUGIN_ID + "/rpc/createSideChat",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceThreadId, anchorText }),
    },
  );
  const body = (await response.json().catch(() => null)) as
    | { ok?: boolean; result?: { threadId?: unknown }; error?: { message?: unknown } }
    | null;
  if (!response.ok || body?.ok !== true) {
    const message = typeof body?.error?.message === "string" ? body.error.message : null;
    throw new Error(message ?? "createSideChat failed (HTTP " + response.status + ")");
  }
  const threadId = body.result?.threadId;
  if (typeof threadId !== "string") {
    throw new Error("The side-chat plugin returned an unexpected response.");
  }
  return threadId;
}

function readSelection(root: HTMLElement | null): NoteSelection | null {
  if (!root) return null;
  const selection = root.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const text = selection.toString().trim();
  if (text.length === 0) return null;
  const box =
    typeof range.getBoundingClientRect === "function"
      ? range.getBoundingClientRect()
      : root.getBoundingClientRect();
  return {
    text,
    rect: { top: box.top, bottom: box.bottom, left: box.left, width: box.width },
  };
}

/** Whether the user has a non-empty text selection inside root. */
export function hasSelectionInside(root: HTMLElement | null): boolean {
  return readSelection(root) !== null;
}

/**
 * Tracks a text selection inside root, reporting it once the pointer is up so
 * the menu does not chase a drag.
 */
function useNoteSelection(rootRef: RefObject<HTMLElement | null>) {
  const [selection, setSelection] = useState<NoteSelection | null>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const doc = root.ownerDocument;
    let pointerDown = false;
    let frame: number | null = null;
    const update = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = null;
        if (!pointerDown) setSelection(readSelection(rootRef.current));
      });
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-note-selection-menu]")) return;
      pointerDown = true;
      setSelection(null);
    };
    const onPointerUp = () => {
      pointerDown = false;
      update();
    };
    const onScroll = () => setSelection(null);
    doc.addEventListener("selectionchange", update);
    doc.addEventListener("pointerdown", onPointerDown, true);
    doc.addEventListener("pointerup", onPointerUp, true);
    doc.addEventListener("keyup", update, true);
    root.addEventListener("scroll", onScroll, true);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      doc.removeEventListener("selectionchange", update);
      doc.removeEventListener("pointerdown", onPointerDown, true);
      doc.removeEventListener("pointerup", onPointerUp, true);
      doc.removeEventListener("keyup", update, true);
      root.removeEventListener("scroll", onScroll, true);
    };
  }, [rootRef]);
  const clear = useCallback(() => setSelection(null), []);
  return { selection, clear };
}

export function NoteSelectionMenu({
  rootRef,
  path,
  threadId,
}: {
  rootRef: RefObject<HTMLElement | null>;
  path: string;
  /** The thread a side chat forks from; null hides "Reply in side chat". */
  threadId: string | null;
}) {
  const composer = useComposer();
  const navigate = useBbNavigate();
  const { selection, clear } = useNoteSelection(rootRef);
  const [starting, setStarting] = useState(false);

  const dismiss = useCallback(() => {
    rootRef.current?.ownerDocument.getSelection()?.removeAllRanges();
    clear();
  }, [clear, rootRef]);

  const addToChat = useCallback(() => {
    if (!selection) return;
    composer.addQuote(selection.text);
    dismiss();
  }, [composer, dismiss, selection]);

  const replyInSideChat = useCallback(async () => {
    if (!selection || !threadId || starting) return;
    const anchorText = noteSideChatAnchor(path, selection.text);
    setStarting(true);
    try {
      const sideChatThreadId = await createSideChat(threadId, anchorText);
      const params: NoteSideChatParams = {
        threadId: sideChatThreadId,
        sourceThreadId: threadId,
        anchorText,
      };
      const opened = navigate.openThreadPanel({
        actionId: NOTE_SIDE_CHAT_ACTION_ID,
        title: "Side chat",
        params: { ...params },
      });
      if (!opened) navigate.toThread(sideChatThreadId);
      dismiss();
    } catch (error) {
      toast.error(
        "Failed to start side chat: " + (error instanceof Error ? error.message : String(error)),
      );
    } finally {
      setStarting(false);
    }
  }, [dismiss, navigate, path, selection, starting, threadId]);

  if (!selection) return null;
  const doc = rootRef.current?.ownerDocument ?? document;
  const below = selection.rect.top < 48;
  const style = {
    top: below ? selection.rect.bottom + 6 : selection.rect.top - 6,
    left: selection.rect.left + selection.rect.width / 2,
    transform: below ? "translateX(-50%)" : "translate(-50%, -100%)",
  };
  return createPortal(
    <div
      className="note-selection-menu"
      data-note-selection-menu=""
      role="menu"
      style={style}
      // Keep the selection while a button is pressed.
      onMouseDown={(event) => event.preventDefault()}
    >
      <button type="button" role="menuitem" onClick={addToChat}>
        Add to chat
      </button>
      {threadId ? (
        <button
          type="button"
          role="menuitem"
          disabled={starting}
          onClick={() => void replyInSideChat()}
        >
          {starting ? "Starting side chat…" : "Reply in side chat"}
        </button>
      ) : null}
    </div>,
    doc.body,
  );
}

function ReplyingTo({ anchorText }: { anchorText: string }) {
  const text = anchorText.trim();
  if (text.length === 0) return null;
  return (
    <div className="note-side-chat-anchor">
      <span className="note-side-chat-anchor-label">Replying to</span>
      <div className="note-side-chat-anchor-body">
        <Markdown content={text} />
      </div>
    </div>
  );
}

/** The side panel tab for a side chat started from a note selection. */
export function NoteSideChatPanel({ params }: PluginThreadPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const parsed = parseNoteSideChatParams(params);
  const sourceThreadId = parsed?.sourceThreadId ?? null;
  const sideChatThreadId = parsed?.threadId ?? null;
  const sendToMain = useCallback(
    async (text: string) => {
      if (!sourceThreadId || !sideChatThreadId) return;
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      try {
        await rpc.call("send_side_chat_to_main", {
          sourceThreadId,
          sideChatThreadId,
          text: trimmed,
        });
        toast.success("Sent to main thread");
      } catch (error) {
        toast.error(
          "Failed to send to main thread: " + (error instanceof Error ? error.message : String(error)),
        );
      }
    },
    [rpc, sideChatThreadId, sourceThreadId],
  );
  if (!parsed) {
    return (
      <div className="p-3 text-sm text-muted-foreground" role="alert">
        Select text in a note and choose "Reply in side chat" to start one here.
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ThreadChat
        threadId={parsed.threadId}
        variant="compact"
        layout="contained"
        permissionPolicy="editable"
        className="min-h-0 flex-1"
        leadingContent={<ReplyingTo anchorText={parsed.anchorText} />}
        messageActions={[
          {
            id: "send-to-main",
            title: "Send to main thread",
            icon: "ArrowTurnBackward",
            roles: ["assistant"],
            run: (message) => sendToMain(message.text),
          },
        ]}
      />
    </div>
  );
}
