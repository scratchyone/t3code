import { ModUiContext, ModUiSiteContext } from "./context";
import { ModUiRegion } from "./ModUiRegion";
import { useMemo, useContext, useCallback, useEffect, type ReactNode } from "react";
import { Linking, Pressable, View, useWindowDimensions, type ViewStyle } from "react-native";
import * as Clipboard from "expo-clipboard";
import { SvgXml } from "react-native-svg";
import { Markdown } from "react-native-nitro-markdown";
import type {
  EnvironmentId,
  ProviderModUiNode,
  ProviderModUiRequest,
  ThreadId,
} from "@t3tools/contracts";
import { text } from "@t3tools/client-runtime/mod-ui";
import { createModUiComposer } from "@t3tools/client-runtime/mod-ui/composer";
import { useModUi } from "../../state/use-mod-ui";
import { AppText as Text } from "../../components/AppText";
import { ControlPill } from "../../components/ControlPill";
import { RequestActionButton } from "./RequestActionButton";

const semanticColors: Record<string, { text: string; background: string; border: string }> = {
  accent: { text: "text-primary-text", background: "bg-primary", border: "border-primary" },
  suggestion: { text: "text-primary-text", background: "bg-primary", border: "border-primary" },
  subtle: { text: "text-foreground-muted", background: "bg-card-alt", border: "border-border" },
  muted: { text: "text-foreground-muted", background: "bg-card-alt", border: "border-border" },
  error: {
    text: "text-danger-foreground",
    background: "bg-danger",
    border: "border-danger-border",
  },
  warning: {
    text: "text-warning-foreground",
    background: "bg-warning",
    border: "border-warning-border",
  },
  success: { text: "text-green-500", background: "bg-green-500", border: "border-green-500" },
};
const literalColor = (value: unknown) =>
  typeof value === "string" && !semanticColors[value] ? value : undefined;

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

type Action = (
  operation: ProviderModUiRequest["operation"],
  payload: Record<string, unknown>,
) => Promise<unknown>;
export function ModTree({
  node,
  act,
  engine,
  trimOuterSpacing = false,
}: {
  node: ProviderModUiNode | string | number;
  act: Action;
  engine?: ReactNode;
  trimOuterSpacing?: boolean;
}) {
  if (typeof node !== "object") return <Text className="text-sm">{node}</Text>;
  const p = node.props ?? {};
  const backgroundClass = semanticColors[text(p.backgroundColor)]?.background ?? "";
  const children = node.children?.map((node, index) => (
    <ModTree key={index} node={node} act={act} engine={engine} />
  ));
  // Sizes keep the 8x16pt cell reported to Claude; spacing uses half a cell because native
  // text and controls already carry the leading and padding a terminal glyph grid lacks.
  const dimension = (value: unknown, scale = 8): ViewStyle["width"] =>
    typeof value === "number"
      ? value * scale
      : typeof value === "string" && /^\d+(\.\d+)?%$/.test(value)
        ? (value as `${number}%`)
        : undefined;
  const spaceX = (value: unknown) => dimension(value, 4);
  const spaceY = (value: unknown) => dimension(value, 8);
  const baseStyle: ViewStyle = {
    flexDirection: ["row", "column", "row-reverse", "column-reverse"].includes(
      text(p.flexDirection),
    )
      ? (p.flexDirection as ViewStyle["flexDirection"])
      : "row",
    flexWrap: p.flexWrap === "wrap" || p.flexWrap === "wrap-reverse" ? p.flexWrap : "nowrap",
    alignItems: p.alignItems as ViewStyle["alignItems"],
    alignSelf: p.alignSelf as ViewStyle["alignSelf"],
    justifyContent: p.justifyContent as ViewStyle["justifyContent"],
    display: p.display === "none" ? "none" : "flex",
    position: p.position === "absolute" ? "absolute" : "relative",
    top: dimension(p.top, 16),
    bottom: dimension(p.bottom, 16),
    left: dimension(p.left),
    right: dimension(p.right),
    width: dimension(p.width),
    height: dimension(p.height, 16),
    minWidth: dimension(p.minWidth),
    minHeight: dimension(p.minHeight, 16),
    rowGap: typeof (p.rowGap ?? p.gap) === "number" ? Number(p.rowGap ?? p.gap) * 8 : undefined,
    columnGap:
      typeof (p.columnGap ?? p.gap) === "number" ? Number(p.columnGap ?? p.gap) * 4 : undefined,
    padding: spaceX(p.padding),
    paddingHorizontal: spaceX(p.paddingX),
    paddingVertical: spaceY(p.paddingY ?? p.padding),
    paddingTop: spaceY(p.paddingTop),
    paddingBottom: spaceY(p.paddingBottom),
    paddingLeft: spaceX(p.paddingLeft),
    paddingRight: spaceX(p.paddingRight),
    margin: spaceX(p.margin),
    marginHorizontal: spaceX(p.marginX),
    marginVertical: spaceY(p.marginY ?? p.margin),
    marginTop: trimOuterSpacing ? 0 : spaceY(p.marginTop),
    marginBottom: spaceY(p.marginBottom),
    marginLeft: spaceX(p.marginLeft),
    marginRight: spaceX(p.marginRight),
    flexGrow: typeof p.flexGrow === "number" ? p.flexGrow : undefined,
    flexShrink: typeof p.flexShrink === "number" ? p.flexShrink : undefined,
    opacity: p.dimColor === true ? 0.65 : undefined,
    borderWidth: p.borderStyle ? 1 : undefined,
    borderColor: literalColor(p.borderColor),
    backgroundColor: literalColor(p.backgroundColor),
    borderRadius: p.borderStyle === "round" ? 8 : undefined,
    overflow: p.overflow === "hidden" ? "hidden" : "visible",
  };
  const style = isActionRow(node)
    ? {
        ...baseStyle,
        marginTop:
          p.marginTop === undefined && p.marginY === undefined && p.margin === undefined
            ? 16
            : baseStyle.marginTop,
        rowGap: baseStyle.rowGap ?? 8,
      }
    : baseStyle;
  const press = () =>
    node.press
      ? act("ui_press", { ...node.press, key: p.key, ...(p.href ? { href: p.href } : {}) })
      : Promise.resolve(null);
  switch (node.type) {
    case "engine":
      return <>{engine}</>;
    case "Box":
      return (
        <View
          className={`${backgroundClass} ${semanticColors[text(p.borderColor)]?.border ?? ""}`}
          style={style}
        >
          {children}
        </View>
      );
    case "Text":
      return (
        <Text
          selectable
          className={`text-sm ${semanticColors[text(p.color)]?.text ?? "text-foreground"} ${backgroundClass}`}
          style={{
            opacity: p.dimColor === true ? 0.65 : 1,
            fontWeight: p.bold ? "600" : "400",
            fontStyle: p.italic ? "italic" : "normal",
            color: literalColor(p.color),
            backgroundColor: literalColor(p.backgroundColor),
            textDecorationLine:
              p.underline && p.strikethrough
                ? "underline line-through"
                : p.underline
                  ? "underline"
                  : p.strikethrough
                    ? "line-through"
                    : "none",
          }}
        >
          {node.children?.map((child, index) =>
            typeof child === "object" ? (
              <ModTree key={index} node={child} act={act} />
            ) : (
              String(child)
            ),
          )}
        </Text>
      );
    case "Button":
      return (
        <View style={style}>
          <RequestActionButton
            label={text(p.label)}
            tone={p.variant === "primary" ? "primary" : "secondary"}
            onPress={() => {
              void press().catch(() => {});
            }}
          />
        </View>
      );
    case "Link":
      return (
        <Pressable
          accessibilityRole="link"
          onPress={() => {
            if (node.press) void press().catch(() => {});
            else if (/^https?:|^file:/.test(text(p.href))) void Linking.openURL(text(p.href));
          }}
        >
          <Text className="text-primary">{children ?? text(p.label)}</Text>
        </Pressable>
      );
    case "Markdown":
      return <Markdown>{text(p.text)}</Markdown>;
    case "Code":
      return <Markdown>{`\`\`\`${text(p.language)}\n${text(p.source)}\n\`\`\``}</Markdown>;
    case "Svg":
      return (
        <SvgXml
          xml={text(p.source)}
          accessibilityLabel={text(p.alt)}
          width={typeof p.width === "number" ? p.width : "100%"}
          height={typeof p.height === "number" ? p.height : 160}
        />
      );
    default:
      return <>{children}</>;
  }
}
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
      copy: async (text) => {
        await Clipboard.setStringAsync(text);
      },
      suggest: () => false,
    }),
  );
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
  const { width } = useWindowDimensions();
  const ui = useContext(ModUiContext);
  const state = ui?.state;
  const controller = ui?.controller;
  useEffect(() => {
    controller?.setViewport(width / 8, working);
  }, [controller, width, working]);
  const act: Action = useCallback(
    async (operation, payload) => controller?.act(operation, payload),
    [controller],
  );
  if (!state?.supported) return null;
  return (
    <View
      className={`gap-2 px-3 ${state.above || state.panes.length ? "mb-3" : ""}`}
      accessibilityLabel="Claude mods"
    >
      {state.error ? (
        <Text accessibilityRole="alert" className="text-danger-foreground">
          {state.error}
        </Text>
      ) : null}
      {state.panes.length ? (
        <View className="gap-2.5 rounded-[20px] border border-border bg-card-alt p-4">
          <View className="flex-row items-center gap-2">
            {state.panes.map((pane) => (
              <ControlPill
                key={pane.id}
                variant={pane.id === state.shownId ? "primary" : "pill"}
                label={pane.title}
                className="h-9"
                onPress={() => {
                  void act("ui_pane_show", { id: pane.id }).catch(() => {});
                }}
              />
            ))}
            <View className="flex-1" />
            <ControlPill
              accessibilityLabel="Close mod pane"
              icon="xmark"
              className="h-9 w-9"
              onPress={() => {
                void act("ui_close", { id: state.shownId }).catch(() => {});
              }}
            />
          </View>
          {state.panes
            .filter((pane) => pane.id === state.shownId && pane.tree)
            .map((pane) => (
              <ModUiRegion key={pane.id} component="Pane" instanceId={pane.id} maxHeight={240}>
                <ModTree node={pane.tree!} act={act} />
              </ModUiRegion>
            ))}
        </View>
      ) : null}
      {state.above ? (
        <View className="rounded-[20px] border border-border bg-card-alt p-4">
          <ModUiRegion component="AbovePrompt" instanceId="above-prompt" maxHeight={180}>
            <ModTree node={state.above} act={act} trimOuterSpacing />
          </ModUiRegion>
        </View>
      ) : null}
      {Object.entries(state.statuses)
        .filter(([, value]) => value)
        .map(([plugin, value]) => (
          <Text key={plugin} className="text-sm text-foreground-muted">
            {value}
          </Text>
        ))}
      {state.notices.map((notice, index) => (
        <View key={`${index}-${notice.text}`} className="flex-row items-center gap-2">
          <Text className="flex-1 text-sm">{notice.text}</Text>
          <ControlPill
            accessibilityLabel="Dismiss"
            icon="xmark"
            className="h-9 w-9"
            onPress={() => controller?.dismissNotice(index)}
          />
        </View>
      ))}
    </View>
  );
}
