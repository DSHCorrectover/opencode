import { Plugin, PluginContextProvider, usePlugin } from "@opencode/plugin/tui"
import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure"
import { ensurePluginRuntime, pluginRuntimeModules } from "../../../cli/src/plugin-runtime"

ensureRuntimePluginSupport({
  additional: {
    ...pluginRuntimeModules(),
    "@opencode/plugin/tui": { Plugin, PluginContextProvider, usePlugin },
  },
})
ensurePluginRuntime()
