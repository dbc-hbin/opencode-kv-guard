import { Plugin } from "@opencode/plugin"
import { parseOptions } from "./options"
import { registerServerState } from "./server-state"
import { registerTools } from "./server-tools"
import { registerTransport } from "./server-transport"

export default Plugin.define({
  id: "opencode-kv-guard",
  async setup(host) {
    const options = parseOptions(host.options)
    const cleanup = new AsyncDisposableStack()
    const state = registerServerState(host, options)
    cleanup.defer(() => state.dispose())
    try {
      cleanup.defer(await registerTransport(host, options, state))
      const stopTools = await registerTools(host, options)
      if (stopTools) cleanup.defer(stopTools)
    } catch (error) {
      await cleanup.disposeAsync()
      throw error
    }
    return () => cleanup.disposeAsync()
  },
})
