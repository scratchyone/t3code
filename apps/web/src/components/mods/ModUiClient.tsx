import clientFrameSource from "./client-frame.js?raw";
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import type { ProviderModUiNode } from "@t3tools/contracts";
import { record, text } from "@t3tools/client-runtime/mod-ui";
import { type ModUiAction } from "./ModUiTree";

/** Runs Claude's supplied surface runtime in its own origin; only UI messages leave it. */
const FRAME_DOCUMENT = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; connect-src 'none'"><script>${clientFrameSource}<\/script>`;

export function ModUiClient({
  node,
  hash,
  act,
  component,
  instanceId,
  render,
}: {
  node: ProviderModUiNode;
  hash: string;
  act: ModUiAction;
  component: string;
  instanceId: string;
  render: (
    tree: ProviderModUiNode,
    local: (element: ProviderModUiNode, event: Record<string, unknown>) => Promise<void>,
  ) => ReactNode;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const region = useRef<HTMLDivElement>(null);
  const [tree, setTree] = useState<ProviderModUiNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = useRef(node);
  current.current = node;
  const plugin = node.client?.plugin ?? "";
  const p = node.props ?? {};
  const target = {
    plugin,
    component,
    instance_id: instanceId,
    client: text(p.key),
    module: text(p.module),
  };
  const post = (kind: string, payload: unknown) =>
    frame.current?.contentWindow?.postMessage({ kind, payload }, "*");
  useEffect(() => {
    let disposed = false;
    const receive = (event: MessageEvent<unknown>) => {
      if (event.source !== frame.current?.contentWindow) return;
      const message = record(event.data);
      if (message.kind === "ready") {
        void act("ui_client_module", { plugin })
          .then((bundle) => {
            if (!disposed)
              post("init", {
                bundle,
                module: text(current.current.props?.module),
                props: current.current.props?.props,
                columns: Math.max(1, Math.floor((region.current?.clientWidth ?? 640) / 8)),
                rows: 24,
              });
          })
          .catch((error) => setError(String(error)));
      } else if (message.kind === "tree") {
        setTree(message.payload as ProviderModUiNode);
        setError(null);
      } else if (message.kind === "error") setError(text(message.payload));
      else if (message.kind === "post") {
        void act("ui_message", { ...target, data: message.payload })
          .then((reply) => {
            const response = record(reply);
            if (!disposed && Object.hasOwn(response, "props")) post("props", response.props);
          })
          .catch(() => {});
      }
    };
    window.addEventListener("message", receive);
    return () => {
      disposed = true;
      window.removeEventListener("message", receive);
    };
  }, [act, plugin, hash, component, instanceId, p.key, p.module]);
  useEffect(() => post("props", p.props), [p.props]);
  useEffect(() => {
    if (!region.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry)
        post("resize", {
          columns: Math.max(1, Math.floor(entry.contentRect.width / 8)),
          rows: Math.max(1, Math.ceil(entry.contentRect.height / 16)),
        });
    });
    observer.observe(region.current);
    return () => observer.disconnect();
  }, []);
  const pointer = (event: PointerEvent<HTMLDivElement>, type: string) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / 8;
    const y = (event.clientY - bounds.top) / 16;
    if (type === "down" && event.target === event.currentTarget)
      event.currentTarget.setPointerCapture(event.pointerId);
    post("pointer", {
      type,
      x: Math.floor(x),
      y: Math.floor(y),
      fine: { x, y },
      ...(type === "down" || type === "up" || event.buttons
        ? { button: event.button === 2 ? "right" : event.button === 1 ? "middle" : "left" }
        : {}),
      ...(event.ctrlKey ? { ctrl: true } : {}),
      ...(event.altKey ? { alt: true } : {}),
      ...(event.shiftKey ? { shift: true } : {}),
    });
  };
  return (
    <div
      ref={region}
      tabIndex={0}
      onKeyDown={(event) =>
        post("key", {
          key:
            (
              {
                ArrowUp: "up",
                ArrowDown: "down",
                ArrowLeft: "left",
                ArrowRight: "right",
                Enter: "return",
                Backspace: "backspace",
                Delete: "delete",
                PageUp: "pageup",
                PageDown: "pagedown",
                Tab: "tab",
                Home: "home",
                End: "end",
                " ": "space",
              } as Record<string, string>
            )[event.key] ?? event.key,
          ...(event.ctrlKey ? { ctrl: true } : {}),
          ...(event.metaKey ? { meta: true } : {}),
          ...(event.altKey ? { alt: true } : {}),
          ...(event.shiftKey ? { shift: true } : {}),
        })
      }
      onPointerMove={(event) => pointer(event, "move")}
      onPointerDown={(event) => pointer(event, "down")}
      onPointerUp={(event) => pointer(event, "up")}
      onPointerEnter={(event) => pointer(event, "enter")}
      onPointerLeave={(event) => pointer(event, "leave")}
    >
      <iframe
        key={hash}
        ref={frame}
        title={`Mod ${plugin}`}
        sandbox="allow-scripts"
        srcDoc={FRAME_DOCUMENT}
        aria-hidden="true"
        tabIndex={-1}
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          opacity: 0,
          pointerEvents: "none",
          border: 0,
        }}
      />
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {tree
        ? render(tree, async (element, event) => {
            const reply = record(
              await act("ui_client_press", { ...target, element: text(element.props?.key), event }),
            );
            if (typeof reply.reached === "object" && reply.reached !== null)
              post("held", {
                key: text(element.props?.key),
                handle: record(element).held,
                event: reply.reached,
              });
          })
        : null}
    </div>
  );
}
