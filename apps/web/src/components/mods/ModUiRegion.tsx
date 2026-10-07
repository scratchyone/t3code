import { useContext, useEffect, useRef, type ReactNode } from "react";
import { record } from "@t3tools/client-runtime/mod-ui";
import { ModUiSiteContext } from "./context";

/** Reports cell-based layout to Claude while retaining native scrolling and focus. */
export function ModUiRegion({
  component,
  instanceId,
  className,
  children,
}: {
  component: "AbovePrompt" | "Pane";
  instanceId: string;
  className: string;
  children: ReactNode;
}) {
  const controller = useContext(ModUiSiteContext)?.controller;
  const ref = useRef<HTMLDivElement>(null);
  const offset = useRef(0);
  const pending = useRef(Promise.resolve());
  const applying = useRef(false);
  const focus = (element: unknown) => {
    const target = record(element);
    const nodes = ref.current?.querySelectorAll<HTMLElement>("[data-mod-key]");
    for (const node of nodes ?? [])
      if (node.dataset.modKey === target.key && node.dataset.modPlugin === target.plugin) {
        node.focus();
        return;
      }
  };
  useEffect(
    () =>
      controller?.registerRegion(component, instanceId, (event) => {
        const node = ref.current;
        if (!node) return;
        if (event.subtype === "ui_scroll") {
          applying.current = true;
          node.scrollTop =
            event.payload.follow_end === true
              ? node.scrollHeight
              : Number(event.payload.offset ?? 0) * 16;
          offset.current = Math.floor(node.scrollTop / 16);
        } else
          focus(event.payload.element ?? { plugin: event.payload.plugin, key: event.payload.key });
      }),
    [controller, component, instanceId],
  );
  useEffect(() => {
    const node = ref.current;
    if (!node || !controller) return;
    const report = () =>
      controller.setRegionLayout(component, instanceId, {
        offset: Math.floor(node.scrollTop / 16),
        bodyRows: Math.ceil(node.clientHeight / 16),
        contentRows: Math.ceil(node.scrollHeight / 16),
      });
    const observer = new ResizeObserver(report);
    observer.observe(node);
    report();
    return () => observer.disconnect();
  }, [controller, component, instanceId, children]);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      className={className}
      onScroll={() => {
        const node = ref.current;
        if (!node || !controller) return;
        const next = Math.floor(node.scrollTop / 16);
        const by = next - offset.current;
        offset.current = next;
        if (applying.current) {
          applying.current = false;
          return;
        }
        if (!by) return;
        const layout = {
          offset: next,
          bodyRows: Math.ceil(node.clientHeight / 16),
          contentRows: Math.ceil(node.scrollHeight / 16),
        };
        controller.setRegionLayout(component, instanceId, layout);
        pending.current = pending.current
          .then(async () => {
            const response = record(
              await controller.send("ui_scroll", {
                component,
                instance_id: instanceId,
                offset: next - by,
                by,
                body_rows: layout.bodyRows,
                content_rows: layout.contentRows,
              }),
            );
            if (
              typeof response.offset === "number" &&
              ref.current &&
              response.offset !== offset.current
            ) {
              applying.current = true;
              ref.current.scrollTop = response.offset * 16;
              offset.current = response.offset;
            }
          })
          .catch(() => {});
      }}
      onFocus={(event) => {
        const node = event.target.closest<HTMLElement>("[data-mod-key]");
        void controller
          ?.send("ui_focus", {
            component,
            instance_id: instanceId,
            is_held: true,
            element: node ? { plugin: node.dataset.modPlugin, key: node.dataset.modKey } : null,
            by: "person",
          })
          .then((response) => focus(record(response).element))
          .catch(() => {});
        if (component === "Pane")
          void controller?.send("ui_pane_focus", { id: instanceId }).catch(() => {});
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          void controller
            ?.send("ui_focus", { component, instance_id: instanceId, is_held: false })
            .catch(() => {});
      }}
    >
      {children}
    </div>
  );
}
