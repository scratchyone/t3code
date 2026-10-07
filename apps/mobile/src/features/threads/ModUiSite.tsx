import { useContext, useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import type { ProviderModUiRender } from "@t3tools/contracts";
import { ModUiSiteContext } from "./context";
import { ModTree } from "./ClaudeModUiHost";

export function ModUiSite({
  component,
  instanceId,
  props,
  children,
  enabled = true,
  onRewrite,
}: {
  enabled?: boolean;
  onRewrite?: (props: Record<string, unknown>) => void;
  component: string;
  instanceId: string;
  props: Record<string, unknown>;
  children: ReactNode | ((props: Record<string, unknown>) => ReactNode);
}) {
  const ui = useContext(ModUiSiteContext);
  const [drawing, setDrawing] = useState<ProviderModUiRender | null>(null);
  const lastRewrite = useRef<string | null>(null);
  const rewrite = useEffectEvent((drawing: ProviderModUiRender) => {
    const signature = JSON.stringify(drawing.props);
    if (drawing.rewritten && lastRewrite.current !== signature) {
      lastRewrite.current = signature;
      onRewrite?.(drawing.props);
    }
  });
  const key = JSON.stringify(props);
  useEffect(() => {
    lastRewrite.current = null;
    setDrawing(null);
    if (!enabled) return;
    return ui?.controller?.registerSite(
      component,
      instanceId,
      JSON.parse(key) as Record<string, unknown>,
      (drawing) => {
        setDrawing(drawing);
        rewrite(drawing);
      },
    );
  }, [ui?.controller, component, instanceId, key, enabled]);
  const engine =
    typeof children === "function"
      ? children(drawing?.rewritten ? drawing.props : props)
      : children;
  if (!ui?.supported || !drawing?.hooked) return <>{engine}</>;
  return (
    <ModTree
      node={drawing.tree}
      engine={engine}
      act={async (operation, payload) => ui.controller?.act(operation, payload)}
    />
  );
}
