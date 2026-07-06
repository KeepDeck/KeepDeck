import { bootstrapPluginRealm } from "@keepdeck/plugin-guest";

// Proves the logic realm boots and the RPC round-trips: log lands host-side
// (web:plugin:<id>), and a settings.read() is a real guest→host→guest call.
bootstrapPluginRealm({
  activate(ctx) {
    ctx.log.info(`logic realm alive (${ctx.manifest.name})`);
    void ctx.settings
      .read()
      .then((v) => ctx.log.info(`rpc settings.read ok: ${JSON.stringify(v)}`))
      .catch((e) => ctx.log.error(`rpc failed: ${String(e)}`));
  },
});
