import * as Schema from "effect/Schema";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ProviderModUiSurface = Schema.Literals(["desktop", "mobile", "vscode"]);
export type ProviderModUiSurface = typeof ProviderModUiSurface.Type;

/** Native UI controls only; provider commands and tool execution are separate APIs. */
export const ProviderModUiOperation = Schema.Literals([
  "capabilities",
  "ui_attach",
  "ui_detach",
  "ui_render",
  "ui_press",
  "ui_input",
  "ui_select",
  "ui_panes",
  "ui_pane_show",
  "ui_pane_focus",
  "ui_close",
  "ui_scroll",
  "ui_focus",
  "ui_prompt_edit",
  "ui_client_module",
  "ui_client_press",
  "ui_message",
  "host_reply",
]);
export const ProviderModUiRequest = Schema.Struct({
  threadId: ThreadId,
  clientId: TrimmedNonEmptyString,
  operation: ProviderModUiOperation,
  payload: Schema.Record(Schema.String, Schema.Unknown),
});
export type ProviderModUiRequest = typeof ProviderModUiRequest.Type;
export const ProviderModUiSubscribe = Schema.Struct({
  threadId: ThreadId,
  clientId: TrimmedNonEmptyString,
});
export type ProviderModUiSubscribe = typeof ProviderModUiSubscribe.Type;
export const ProviderModUiEvent = Schema.Struct({
  subtype: Schema.String,
  client_id: Schema.optionalKey(Schema.String),
  payload: Schema.Record(Schema.String, Schema.Unknown),
});
export type ProviderModUiEvent = typeof ProviderModUiEvent.Type;
export class ProviderModUiError extends Schema.TaggedError<ProviderModUiError>()(
  "ProviderModUiError",
  { threadId: ThreadId, detail: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {
  override get message() {
    return this.detail;
  }
}

export interface ProviderModUiNode {
  readonly type: string;
  readonly props?: Readonly<Record<string, unknown>>;
  readonly children?: ReadonlyArray<ProviderModUiNode | string | number>;
  readonly press?: { readonly plugin: string; readonly handle: number };
  readonly client?: { readonly plugin: string };
  readonly ref?: number;
}
export const ProviderModUiNode: Schema.Codec<ProviderModUiNode> = Schema.Struct({
  type: Schema.String,
  props: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  children: Schema.optionalKey(
    Schema.Array(
      Schema.Union([
        Schema.String,
        Schema.Number,
        Schema.suspend((): Schema.Codec<ProviderModUiNode> => ProviderModUiNode),
      ]),
    ),
  ),
  press: Schema.optionalKey(Schema.Struct({ plugin: Schema.String, handle: Schema.Number })),
  client: Schema.optionalKey(Schema.Struct({ plugin: Schema.String })),
  ref: Schema.optionalKey(Schema.Number),
});
export const ProviderModUiRender = Schema.Struct({
  tree: ProviderModUiNode,
  props: Schema.Record(Schema.String, Schema.Unknown),
  rewritten: Schema.Boolean,
  hooked: Schema.Boolean,
  client_modules: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
export type ProviderModUiRender = typeof ProviderModUiRender.Type;
