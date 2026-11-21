/**
 * Bridge legacy directory presets into the live DSH preset registry.
 *
 * DSH 0.2.x no longer scans $DSH_HOME/.agent-presets by itself. This panel
 * still treats those directories as editable sources, so this module registers
 * each one as a real Agent preset: the declaration contains one cordis:include
 * row pointing at the directory's agent.cordis.yml. The Loader's include plugin
 * parses the same !!js entry list the legacy directory always used, and keeps
 * watching it for edits.
 *
 * @module dsh-utils/utils-agents/legacy
 */
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoverPresets } from './presets.js';
import { errorMessage, normalizeOptions, serviceOf, } from './util.js';
/**
 * Create the bridge. Registration is lazy: the first list request performs it,
 * so the route can report a useful status even when agentPresets is absent.
 */
export function createLegacyBridge(ctx, config) {
    const records = new Map();
    const statuses = new Map();
    let inflight = null;
    let disposed = false;
    const ensure = async function () {
        if (disposed)
            return;
        if (inflight !== null)
            return await inflight;
        inflight = run().finally(function () { inflight = null; });
        return await inflight;
    };
    const run = async function () {
        const options = normalizeOptions(config);
        const presets = await discoverPresets(ctx, options);
        const byId = new Map();
        for (const preset of presets)
            if (!byId.has(preset.id))
                byId.set(preset.id, preset);
        for (const [id, record] of [...records]) {
            if (byId.has(id))
                continue;
            records.delete(id);
            if (record.unregister !== undefined) {
                try {
                    await record.unregister();
                }
                catch (error) {
                    ctx.logger.warn('utils-agents: cannot unregister legacy preset ' + id + ': ' + errorMessage(error));
                }
            }
        }
        const registry = serviceOf(ctx, 'agentPresets');
        if (registry === undefined || typeof registry.register !== 'function') {
            statuses.clear();
            for (const id of byId.keys())
                statuses.set(id, { registered: false, broken: '宿主没有提供 agentPresets 服务' });
            return;
        }
        let listed = [];
        try {
            listed = await registry.list();
        }
        catch (error) {
            ctx.logger.warn('utils-agents: cannot list agent presets: ' + errorMessage(error));
        }
        const known = new Set(listed.map((row) => row.id));
        let order = 1000;
        for (const preset of byId.values()) {
            order += 1;
            if (known.has(preset.id) || records.has(preset.id))
                continue;
            const composition = join(preset.path, 'agent.cordis.yml');
            try {
                await access(composition);
            }
            catch {
                records.set(preset.id, { id: preset.id, path: preset.path, unregister: undefined, error: '缺少 agent.cordis.yml' });
                continue;
            }
            try {
                const unregister = await registry.register({
                    id: preset.id,
                    name: preset.name,
                    description: preset.description,
                    order,
                    plugins: [{
                            id: 'legacy-agent-composition',
                            name: 'cordis:include',
                            config: { path: pathToFileURL(composition).href },
                        }],
                });
                records.set(preset.id, { id: preset.id, path: preset.path, unregister, error: undefined });
                ctx.logger.info('utils-agents: registered legacy agent preset ' + preset.id);
            }
            catch (error) {
                const message = errorMessage(error);
                records.set(preset.id, { id: preset.id, path: preset.path, unregister: undefined, error: message });
                ctx.logger.warn('utils-agents: cannot register legacy preset ' + preset.id + ': ' + message);
            }
        }
        try {
            listed = await registry.list();
        }
        catch {
            // Keep the previous listing when the registry is temporarily unavailable.
        }
        const broken = new Map(listed.map((row) => [row.id, row.broken]));
        statuses.clear();
        for (const preset of byId.values()) {
            const record = records.get(preset.id);
            const inRegistry = broken.has(preset.id);
            statuses.set(preset.id, {
                registered: inRegistry,
                broken: inRegistry ? broken.get(preset.id) : record?.error,
            });
        }
    };
    return {
        ensure,
        status: function () { return new Map(statuses); },
        dispose: async function () {
            disposed = true;
            for (const record of records.values()) {
                if (record.unregister === undefined)
                    continue;
                try {
                    await record.unregister();
                }
                catch (error) {
                    ctx.logger.warn('utils-agents: cannot dispose legacy preset ' + record.id + ': ' + errorMessage(error));
                }
            }
            records.clear();
            statuses.clear();
        },
    };
}
//# sourceMappingURL=legacy.js.map