import { createModUiEnvironmentAtoms } from "@t3tools/client-runtime/state/modUi";
import { connectionAtomRuntime } from "../connection/runtime";
export const modUiEnvironment = createModUiEnvironmentAtoms(connectionAtomRuntime);
