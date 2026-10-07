import { ModUiContext, ModUiSiteContext } from "./context";
import { ModUiSite } from "./ModUiSite";
import { ModUiRegion } from "./ModUiRegion";
import { useMemo, useContext, useCallback, useEffect, useRef, type ReactNode } from "react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { record } from "@t3tools/client-runtime/mod-ui";
import { createModUiComposer } from "@t3tools/client-runtime/mod-ui/composer";
import { useModUi } from "../../state/use-mod-ui";
import { Button } from "../ui/button";
import { ComposerBanner } from "../chat/ComposerBanner";
import { Collapsible, CollapsiblePanel } from "../ui/collapsible";
import { ModUiTree, type ModUiAction } from "./ModUiTree";

interface HostProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  working: boolean;
  read: () => { text: string; cursor: number } | null;
  fill: (text: string, cursor: number) => void;
}
export function ClaudeModUiProvider(props: HostProps & { enabled: boolean; children: ReactNode }) {
  return props.enabled ? <ActiveProvider {...props} /> : <>{props.children}</>;
}
function ActiveProvider({ children, read, fill, ...target }: HostProps & { children: ReactNode }) {
  const ui = useModUi(
    target.environmentId,
    target.threadId,
    createModUiComposer({
      read,
      fill,
      copy: (text) => navigator.clipboard.writeText(text),
      suggest: () => false,
    }),
  );
  const composer = useRef({ read, fill });
  composer.current = { read, fill };
  useEffect(() => {
    if (!ui.controller || !ui.state.supported) return;
    let revision = 0;
    let frame = 0;
    let closed = false;
    const edit = (event: Event) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest('[data-testid="composer-editor"]')
      )
        return;
      const currentRevision = ++revision;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const box = composer.current.read();
        if (!box) return;
        void ui.controller
          ?.send("ui_prompt_edit", { ...box, by: "person" })
          .then((reply) => {
            const response = record(reply);
            if (
              closed ||
              revision !== currentRevision ||
              response.superseded === true ||
              typeof response.text !== "string"
            )
              return;
            if (response.text !== box.text || response.cursor !== box.cursor)
              composer.current.fill(
                response.text,
                typeof response.cursor === "number" ? response.cursor : response.text.length,
              );
          })
          .catch(() => {});
      });
    };
    document.addEventListener("input", edit);
    document.addEventListener("keyup", edit);
    return () => {
      closed = true;
      cancelAnimationFrame(frame);
      document.removeEventListener("input", edit);
      document.removeEventListener("keyup", edit);
    };
  }, [ui.controller, ui.state.supported]);
  const siteContext = useMemo(
    () => ({ controller: ui.controller, supported: ui.state.supported }),
    [ui.controller, ui.state.supported],
  );
  return (
    <ModUiContext value={ui}>
      <ModUiSiteContext value={siteContext}>{children}</ModUiSiteContext>
    </ModUiContext>
  );
}
export function ClaudeModUiHost({ working }: { working: boolean }) {
  const region = useRef<HTMLDivElement>(null);
  const ui = useContext(ModUiContext);
  const state = ui?.state;
  const controller = ui?.controller;
  const act: ModUiAction = useCallback(
    async (operation, payload) => controller?.act(operation, payload),
    [controller],
  );
  useEffect(() => {
    if (!region.current || !controller) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) controller.setViewport(entry.contentRect.width / 8, working);
    });
    observer.observe(region.current);
    return () => observer.disconnect();
  }, [controller, working]);
  if (!state?.supported) return null;
  return (
    <div ref={region} className="flex flex-col gap-2 text-sm" aria-label="Claude mods">
      {state.error ? (
        <p role="alert" className="text-destructive">
          {state.error}
        </p>
      ) : null}
      <ModUiSurface>
        {state.panes.length > 0 ? (
          <>
            <div className="mb-2 flex items-center gap-1">
              {state.panes.map((pane) => (
                <Button
                  key={pane.id}
                  size="xs"
                  variant={pane.id === state.shownId ? "secondary" : "ghost"}
                  onClick={() => {
                    void act("ui_pane_show", { id: pane.id }).catch(() => {});
                  }}
                >
                  {pane.title}
                </Button>
              ))}
              <div className="flex-1" />
              <ComposerBanner.Dismiss
                aria-label="Close mod pane"
                onClick={() => {
                  void act("ui_close", { id: state.shownId }).catch(() => {});
                }}
              />
            </div>
            {state.panes
              .filter((pane) => pane.id === state.shownId && pane.tree)
              .map((pane) => (
                <ModUiRegion
                  key={pane.id}
                  component="Pane"
                  instanceId={pane.id}
                  className="max-h-80 overflow-auto"
                >
                  <ModUiTree
                    node={pane.tree!}
                    act={act}
                    component="Pane"
                    instanceId={pane.id}
                    modules={pane.modules}
                  />
                </ModUiRegion>
              ))}
          </>
        ) : null}
      </ModUiSurface>
      <ModUiSurface>
        {state.above ? (
          <ModUiRegion
            component="AbovePrompt"
            instanceId="above-prompt"
            className="max-h-80 overflow-auto"
          >
            <ModUiTree
              node={state.above}
              trimOuterSpacing
              act={act}
              component="AbovePrompt"
              instanceId="above-prompt"
              modules={state.modules}
            />
          </ModUiRegion>
        ) : null}
      </ModUiSurface>
      <ModUiSite component="SessionMode" instanceId="session-mode" props={{ modes: [] }}>
        {(props) =>
          Array.isArray(props.modes) && props.modes.length ? (
            <p className="text-muted-foreground">
              {props.modes.filter((mode) => typeof mode === "string").join(" & ")}
            </p>
          ) : null
        }
      </ModUiSite>
      {Object.entries(state.statuses)
        .filter(([, text]) => text)
        .map(([plugin, text]) => (
          <p key={plugin} className="text-muted-foreground" role="status">
            {text}
          </p>
        ))}
      {state.notices.map((notice, index) => (
        <div key={`${index}-${notice.text}`} className="flex items-center gap-2" role="status">
          <span className="flex-1">{notice.text}</span>
          <ComposerBanner.Dismiss
            aria-label="Dismiss"
            onClick={() => controller?.dismissNotice(index)}
          />
        </div>
      ))}
    </div>
  );
}

function ModUiSurface({ children }: { children: ReactNode }) {
  const retained = useRef(children);
  const open = children != null;
  useEffect(() => {
    if (open) retained.current = children;
  }, [children, open]);
  return (
    <Collapsible open={open} className="not-has-[>[data-slot=collapsible-panel]]:hidden">
      <CollapsiblePanel data-mod-ui-surface inert={!open}>
        <div className="pb-3">
          <ComposerBanner.Root placement="floating" density="spacious" className="text-sm">
            {open ? children : retained.current}
          </ComposerBanner.Root>
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}
