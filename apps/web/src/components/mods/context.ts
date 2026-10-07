import { createContext } from "react";
import type { useModUi } from "../../state/use-mod-ui";
export const ModUiSiteContext = createContext<{
  controller: ReturnType<typeof useModUi>["controller"];
  supported: boolean;
} | null>(null);
export const ModUiContext = createContext<ReturnType<typeof useModUi> | null>(null);
