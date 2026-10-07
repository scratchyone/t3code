import {
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ProviderModUiRender } from "@t3tools/contracts";
import { ModUiSiteContext } from "./context";
import { ModUiTree, type ModUiAction } from "./ModUiTree";

/** Mounted transcript sites retain T3's drawing at native engine nodes. */
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
  const act: ModUiAction = useCallback(
    async (operation, payload) => ui?.controller?.act(operation, payload),
    [ui?.controller],
  );
  const engine =
    typeof children === "function"
      ? children(drawing?.rewritten ? drawing.props : props)
      : children;
  if (!ui?.supported || !drawing?.hooked) return <>{engine}</>;
  return (
    <ModUiTree
      node={drawing.tree}
      component={component}
      instanceId={instanceId}
      modules={drawing.client_modules ?? {}}
      engine={engine}
      act={act}
    />
  );
}
