import { Plugin, PluginContextProvider, usePlugin } from "@opencode/plugin/tui"
import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure"
import { ensurePluginRuntime } from "../../../cli/src/plugin-runtime"

ensureRuntimePluginSupport({
  additional: {
    ...ensurePluginRuntime(),
    "@opencode/plugin/tui": { Plugin, PluginContextProvider, usePlugin },
  },
})
