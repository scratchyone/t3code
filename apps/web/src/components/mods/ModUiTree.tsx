import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { ProviderModUiNode, ProviderModUiRequest } from "@t3tools/contracts";
import { record, text } from "@t3tools/client-runtime/mod-ui";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "../ui/select";
import ChatMarkdown from "../ChatMarkdown";
import { ModUiClient } from "./ModUiClient";

export type ModUiAction = (
  operation: ProviderModUiRequest["operation"],
  payload: Record<string, unknown>,
) => Promise<unknown>;
export interface ModUiTreeProps {
  node: ProviderModUiNode | string | number;
  act: ModUiAction;
  component: string;
  instanceId: string;
  modules: Readonly<Record<string, string>>;
  engine?: ReactNode;
  trimOuterSpacing?: boolean;
  local?: (node: ProviderModUiNode, event: Record<string, unknown>) => Promise<void>;
}
// Sizes and offsets keep the 8x16px cell the region reports to Claude, so a mod's columns
// line up with the width it laid out for. Spacing uses half a cell: native text and
// controls already carry the leading and padding that a terminal glyph grid lacks.
const length = (value: unknown, cell: number) =>
  typeof value === "number" ? value * cell : typeof value === "string" ? value : undefined;
const sizeX = (value: unknown) => length(value, 8);
const sizeY = (value: unknown) => length(value, 16);
const spaceX = (value: unknown) => length(value, 4);
const spaceY = (value: unknown) => length(value, 8);
/** Resolves an edge the way Yoga does: the edge, then its axis, then the shorthand. */
const edge = (p: Readonly<Record<string, unknown>>, name: string, side: string, axis: "X" | "Y") =>
  p[`${name}${side}`] ?? p[`${name}${axis}`] ?? p[name];
const color = (value: unknown) =>
  typeof value === "string"
    ? ({
        accent: "var(--primary)",
        suggestion: "var(--primary)",
        muted: "var(--muted-foreground)",
        subtle: "var(--muted-foreground)",
        error: "var(--destructive)",
        success: "var(--success)",
        warning: "var(--warning-foreground)",
      }[value] ?? value)
    : undefined;
function styleOf(p: Readonly<Record<string, unknown>>): CSSProperties {
  return {
    color: color(p.color),
    backgroundColor: color(p.backgroundColor),
    opacity: p.dimColor === true ? 0.65 : undefined,
    fontWeight: p.bold === true ? 600 : undefined,
    fontStyle: p.italic === true ? "italic" : undefined,
    textDecoration: [p.underline && "underline", p.strikethrough && "line-through"]
      .filter(Boolean)
      .join(" "),
    width: sizeX(p.width),
    height: sizeY(p.height),
    minWidth: sizeX(p.minWidth),
    maxWidth: sizeX(p.maxWidth),
    minHeight: sizeY(p.minHeight),
    position: p.position === "absolute" ? "absolute" : "relative",
    top: sizeY(p.top),
    bottom: sizeY(p.bottom),
    left: sizeX(p.left),
    right: sizeX(p.right),
    alignSelf: text(p.alignSelf) || undefined,
    overflow: p.overflow === "hidden" ? "hidden" : undefined,
    flexGrow: typeof p.flexGrow === "number" ? p.flexGrow : undefined,
    flexShrink: typeof p.flexShrink === "number" ? p.flexShrink : undefined,
    // Longhands only: React writes `margin: ""` for an unset shorthand, which would wipe
    // every margin edge set alongside it.
    rowGap: spaceY(p.rowGap ?? p.gap),
    columnGap: spaceX(p.columnGap ?? p.gap),
    paddingTop: spaceY(edge(p, "padding", "Top", "Y")),
    paddingBottom: spaceY(edge(p, "padding", "Bottom", "Y")),
    paddingLeft: spaceX(edge(p, "padding", "Left", "X")),
    paddingRight: spaceX(edge(p, "padding", "Right", "X")),
    marginTop: spaceY(edge(p, "margin", "Top", "Y")),
    marginBottom: spaceY(edge(p, "margin", "Bottom", "Y")),
    marginLeft: spaceX(edge(p, "margin", "Left", "X")),
    marginRight: spaceX(edge(p, "margin", "Right", "X")),
    border: p.borderStyle ? `1px solid ${color(p.borderColor) ?? "var(--border)"}` : undefined,
    borderRadius: p.borderStyle === "round" ? 8 : undefined,
  };
}
// Native action rows need space above and between wrapped lines, unless the mod sets it.
function isButtonItem(node: ProviderModUiNode | string | number): boolean {
  return (
    typeof node === "object" &&
    (node.type === "Button" ||
      (node.type === "Box" && node.children?.length === 1 && isButtonItem(node.children[0]!)))
  );
}
function isActionRow(node: ProviderModUiNode): boolean {
  return (
    node.type === "Box" &&
    (!node.props?.flexDirection || node.props.flexDirection === "row") &&
    (node.children?.length ?? 0) > 1 &&
    node.children!.every(isButtonItem)
  );
}

const HoverScope = createContext(false);

export function ModUiTree(props: ModUiTreeProps) {
  const { node } = props;
  if (typeof node !== "object") return <>{node}</>;
  return <ModUiElement {...props} node={node} />;
}
function ModUiElement({
  node,
  act,
  component,
  instanceId,
  modules,
  engine,
  trimOuterSpacing = false,
  local,
}: ModUiTreeProps & { node: ProviderModUiNode }) {
  const inheritedHover = useContext(HoverScope);
  const [hovered, setHovered] = useState(false);
  const original = node.props ?? {};
  const ownsScope = node.type === "Box" && typeof original.key === "string";
  const activeHover = ownsScope ? hovered : inheritedHover;
  const p = activeHover ? { ...original, ...record(original.hover) } : original;
  const [value, setValue] = useState(text(p.value));
  const [busy, setBusy] = useState(false);
  const pending = useRef(Promise.resolve());
  useEffect(() => setValue(text(p.value)), [p.value]);
  const invoke = (event: Record<string, unknown>) => {
    const task = pending.current.then(async () => {
      setBusy(true);
      try {
        if (local) await local(node, event);
        else if (node.press) {
          const type = event.type;
          await act(type === "input" ? "ui_input" : type === "select" ? "ui_select" : "ui_press", {
            ...node.press,
            ...event,
            key: p.key,
            component,
            instance_id: instanceId,
          });
        }
      } finally {
        setBusy(false);
      }
    });
    pending.current = task.catch(() => {});
    return task;
  };
  const children = node.children?.map((child, index) => (
    <ModUiTree
      key={typeof child === "object" ? text(child.props?.key) || index : index}
      node={child}
      act={act}
      component={component}
      instanceId={instanceId}
      modules={modules}
      engine={engine}
      {...(local ? { local } : {})}
    />
  ));
  const style = styleOf(p);
  if (isActionRow(node)) {
    style.marginTop ??= 16;
    style.rowGap ??= 8;
  }
  // The native surface owns its outer inset; terminal roots often add a blank line.
  if (trimOuterSpacing) style.marginTop = 0;
  const identity = { "data-mod-key": text(p.key), "data-mod-plugin": node.press?.plugin ?? "" };
  switch (node.type) {
    case "engine":
      return <>{engine}</>;
    case "Box":
      return (
        <div
          onPointerEnter={() => ownsScope && setHovered(true)}
          onPointerLeave={() => ownsScope && setHovered(false)}
          style={{
            ...style,
            display: p.display === "none" ? "none" : "flex",
            flexDirection: ["row", "column", "row-reverse", "column-reverse"].includes(
              text(p.flexDirection),
            )
              ? (p.flexDirection as CSSProperties["flexDirection"])
              : "row",
            alignItems: text(p.alignItems) || undefined,
            justifyContent: text(p.justifyContent) || undefined,
            flexWrap:
              p.flexWrap === "wrap" || p.flexWrap === "wrap-reverse" ? p.flexWrap : "nowrap",
          }}
        >
          <HoverScope value={activeHover}>{children}</HoverScope>
        </div>
      );
    case "Text":
      return (
        <span style={{ ...style, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {children}
        </span>
      );
    case "Button":
      return (
        <div className="flex" style={style}>
          <Button
            {...identity}
            size="sm"
            variant={p.variant === "primary" ? "default" : p.plain ? "ghost" : "outline"}
            disabled={busy}
            onClick={() => {
              void invoke({ type: "press" }).catch(() => {});
            }}
          >
            {text(p.label)}
          </Button>
        </div>
      );
    case "Input":
      return (
        <label className="flex min-w-0 flex-col gap-1" style={style}>
          {text(p.label)}
          <Input
            {...identity}
            value={value}
            placeholder={text(p.placeholder)}
            autoFocus={p.autoFocus === true}
            onChange={(event) => {
              const value = event.target.value;
              setValue(value);
              void invoke({ type: "input", kind: "change", value }).catch(() => {});
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void invoke({ type: "input", kind: "submit", value }).catch(() => {});
              }
            }}
          />
        </label>
      );
    case "Select":
      return (
        <label className="flex flex-col gap-1" style={style}>
          {text(p.label)}
          <Select
            items={(Array.isArray(p.options) ? p.options : []).map((option) => {
              const o = record(option);
              return { value: text(o.value), label: text(o.label) || text(o.value) };
            })}
            value={value}
            onValueChange={(next) => {
              const value = next ?? "";
              setValue(value);
              void invoke({ type: "select", value }).catch(() => {});
            }}
          >
            <SelectTrigger {...identity} size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Array.isArray(p.options) ? p.options : []).map((option) => {
                const o = record(option);
                return (
                  <SelectItem key={text(o.value)} value={text(o.value)}>
                    {text(o.label) || text(o.value)}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </label>
      );
    case "Link":
      return (
        <a
          style={style}
          href={/^https?:|^file:/.test(text(p.href)) ? text(p.href) : undefined}
          target="_blank"
          rel="noreferrer"
          onClick={
            node.press || local
              ? (event) => {
                  event.preventDefault();
                  void invoke({ type: "press", href: p.href }).catch(() => {});
                }
              : undefined
          }
        >
          {children ?? text(p.label)}
        </a>
      );
    case "Markdown":
      return (
        <div
          style={style}
          onClick={
            node.press
              ? (event) => {
                  const anchor = event.target instanceof Element ? event.target.closest("a") : null;
                  if (anchor) {
                    event.preventDefault();
                    void invoke({ type: "press", href: anchor.getAttribute("href") }).catch(
                      () => {},
                    );
                  }
                }
              : undefined
          }
        >
          <ChatMarkdown text={text(p.text)} cwd="" />
        </div>
      );
    case "Code":
      return (
        <div style={style}>
          <ChatMarkdown text={`\`\`\`${text(p.language)}\n${text(p.source)}\n\`\`\``} cwd="" />
        </div>
      );
    case "Svg":
      return p.isInteractive === true ? (
        <iframe
          title={text(p.alt)}
          sandbox=""
          srcDoc={`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">${text(p.source)}`}
          style={{
            width: typeof p.width === "number" ? p.width : "100%",
            height: typeof p.height === "number" ? p.height : 160,
            border: 0,
          }}
        />
      ) : (
        <img
          alt={text(p.alt)}
          src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(text(p.source))}`}
          width={typeof p.width === "number" ? p.width : undefined}
          height={typeof p.height === "number" ? p.height : undefined}
          style={{ maxWidth: "100%" }}
        />
      );
    case "Client":
      return (
        <ModUiClient
          node={node}
          hash={modules[node.client?.plugin ?? ""] ?? ""}
          act={act}
          component={component}
          instanceId={instanceId}
          render={(tree, local) => (
            <ModUiTree
              node={tree}
              act={act}
              component={component}
              instanceId={instanceId}
              modules={{}}
              local={local}
            />
          )}
        />
      );
    default:
      return <>{children}</>;
  }
}
