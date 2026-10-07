import { useContext, useEffect, useRef, type ReactNode, type ComponentRef } from "react";
import { ScrollView } from "react-native";
import { record } from "@t3tools/client-runtime/mod-ui";
import { ModUiSiteContext } from "./context";

export function ModUiRegion({
  component,
  instanceId,
  children,
  maxHeight,
}: {
  component: "AbovePrompt" | "Pane";
  instanceId: string;
  children: ReactNode;
  maxHeight: number;
}) {
  const controller = useContext(ModUiSiteContext)?.controller;
  const view = useRef<ComponentRef<typeof ScrollView>>(null);
  const layout = useRef({ offset: 0, bodyRows: 0, contentRows: 0 });
  const applying = useRef(false);
  const pending = useRef(Promise.resolve());
  useEffect(
    () =>
      controller?.registerRegion(component, instanceId, (event) => {
        if (event.subtype !== "ui_scroll") return;
        applying.current = true;
        const offset =
          event.payload.follow_end === true
            ? Math.max(0, layout.current.contentRows - layout.current.bodyRows)
            : Number(event.payload.offset ?? 0);
        layout.current.offset = offset;
        view.current?.scrollTo({ y: offset * 16, animated: false });
      }),
    [controller, component, instanceId],
  );
  const report = () => controller?.setRegionLayout(component, instanceId, layout.current);
  return (
    <ScrollView
      ref={view}
      style={{ maxHeight }}
      nestedScrollEnabled
      scrollEventThrottle={32}
      onLayout={(event) => {
        layout.current.bodyRows = Math.ceil(event.nativeEvent.layout.height / 16);
        report();
      }}
      onContentSizeChange={(_, height) => {
        layout.current.contentRows = Math.ceil(height / 16);
        report();
      }}
      onScroll={(event) => {
        const previous = layout.current.offset;
        layout.current.offset = Math.floor(event.nativeEvent.contentOffset.y / 16);
        const by = layout.current.offset - previous;
        report();
        if (applying.current) {
          applying.current = false;
          return;
        }
        if (!by || !controller) return;
        const current = { ...layout.current };
        pending.current = pending.current
          .then(async () => {
            const response = record(
              await controller.send("ui_scroll", {
                component,
                instance_id: instanceId,
                offset: previous,
                by,
                body_rows: current.bodyRows,
                content_rows: current.contentRows,
              }),
            );
            if (typeof response.offset === "number" && response.offset !== layout.current.offset) {
              applying.current = true;
              layout.current.offset = response.offset;
              view.current?.scrollTo({ y: response.offset * 16, animated: false });
            }
          })
          .catch(() => {});
      }}
    >
      {children}
    </ScrollView>
  );
}
