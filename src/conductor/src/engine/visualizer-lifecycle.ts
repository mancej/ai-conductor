import { join } from 'node:path';
import type { HarnessConfig } from '../types/config.js';
import type { VisualizerFactory, VisualizerFactoryContext, VisualizerPlugin, VisualizerStartContext } from '../types/plugin.js';
import type { ConductorEventEmitter } from '../ui/events.js';
import type { PluginRegistry } from './plugin-registry.js';

/**
 * Start visualizers with run context and isolate their event handlers. Return
 * successful starts for teardown, as required by the configured factory contract.
 */
export function buildVisualizers(
  visualizers: VisualizerPlugin[],
  emitter: ConductorEventEmitter,
  context: VisualizerStartContext = {},
): VisualizerPlugin[] {
  const started: VisualizerPlugin[] = [];
  for (const vis of visualizers) {
    let warned = false;
    let registering = true;
    const warn = (failure: 'start()' | 'handler', err: unknown): void => {
      if (warned) return;
      warned = true;
      console.warn(
        `[visualizer] visualizer '${vis.name}' ${failure} failure: ${err instanceof Error ? err.message : String(err)}`,
      );
    };
    try {
      emitter.withIsolatedHandlerRegistrations(
        () => vis.start(emitter, context),
        (err) => warn(registering ? 'start()' : 'handler', err),
      );
      started.push(vis);
    } catch (err: unknown) {
      warn('start()', err);
      void emitter.emit({ type: 'renderer_error', rendererName: vis.name, error: err instanceof Error ? err.message : String(err) });
    } finally {
      registering = false;
    }
  }
  return started;
}

/**
 * Build the configured non-OTel visualizers for one run. OTel owns its
 * configuration gate and lifecycle through `buildInteractiveVisualizers`.
 */
export function selectVisualizers(
  registry: PluginRegistry,
  config: HarnessConfig,
  context: VisualizerFactoryContext,
): VisualizerPlugin[] {
  const selected: VisualizerPlugin[] = [];
  const warnedNames = new Set<string>();

  for (const name of config.visualizers ?? []) {
    if (name === 'otel') {
      if (!warnedNames.has(name)) {
        warnedNames.add(name);
        console.warn('visualizer "otel" is configured through the "otel:" block; remove it from "visualizers".');
      }
      continue;
    }

    const factory = registry.tryGet<VisualizerFactory | VisualizerPlugin>('visualizer', name);
    if (!factory) {
      if (!warnedNames.has(name)) {
        warnedNames.add(name);
        console.warn(
          `visualizer "${name}" is not registered; registered visualizers: ${registry.list('visualizer').join(', ') || '(none)'}.`,
        );
      }
      continue;
    }

    const visualizer = typeof factory === 'function'
      ? invokeVisualizerFactory(name, factory, context)
      : factory;
    if (visualizer) {
      selected.push(visualizer);
    }
  }

  return selected;
}

/** Invoke a visualizer factory with its real context and refuse malformed products. */
function invokeVisualizerFactory(
  pluginName: string,
  factory: VisualizerFactory,
  context: VisualizerFactoryContext,
): VisualizerPlugin | null {
  let visualizer: unknown;
  try {
    visualizer = factory(context);
  } catch (error) {
    console.warn(`Plugin ${pluginName} factory failed: ${String(error)}`);
    return null;
  }

  if (visualizer === null) return null;
  const candidate = visualizer as Partial<VisualizerPlugin> | undefined;
  if (typeof candidate?.name !== 'string') {
    console.warn(`Plugin ${pluginName} missing required member: name`);
    return null;
  }
  if (typeof candidate.start !== 'function') {
    console.warn(`Plugin ${pluginName} missing required method: start`);
    return null;
  }
  if (typeof candidate.stop !== 'function') {
    console.warn(`Plugin ${pluginName} missing required method: stop`);
    return null;
  }

  return visualizer as VisualizerPlugin;
}

export function startRegisteredVisualizers(
  registry: PluginRegistry,
  emitter: ConductorEventEmitter,
  builtIns: VisualizerPlugin[] = [],
  context?: VisualizerFactoryContext,
): VisualizerPlugin[] {
  const legacy = context === undefined;
  const resolved = context ?? {
    config: { visualizers: registry.list('visualizer').filter((name) => name !== 'otel') },
    pipelineDir: join(process.cwd(), '.pipeline'),
    startContext: {},
    emitter,
  };
  const visualizers = [...builtIns, ...selectVisualizers(registry, resolved.config, resolved)];
  const started = buildVisualizers(visualizers, emitter, resolved.startContext);
  // Legacy callers own cleanup even after a partial startup. Context-aware
  // factories follow the upstream contract and stop only successful starts.
  return legacy ? visualizers : started;
}

export async function withRegisteredVisualizers<T>(
  registry: PluginRegistry,
  emitter: ConductorEventEmitter,
  run: () => Promise<T>,
  builtIns: VisualizerPlugin[] = [],
  context?: VisualizerFactoryContext,
): Promise<T> {
  const visualizers = startRegisteredVisualizers(registry, emitter, builtIns, context);
  try {
    return await run();
  } finally {
    await stopVisualizers(visualizers);
  }
}

/**
 * Stop every visualizer plugin, swallowing individual errors so one failing
 * exporter cannot prevent the others from flushing.
 */
export async function stopVisualizers(visualizers: VisualizerPlugin[]): Promise<void> {
  await Promise.all(
    visualizers.map(async (vis) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(() => vis.stop()),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error('timed out after 2000ms')), 2_000);
          }),
        ]);
      } catch (err: unknown) {
        try {
          console.warn(
            `[visualizer] visualizer '${vis.name}' stop() error: ${err instanceof Error ? err.message : String(err)}`,
          );
        } catch {
          /* reporting failures must not block shutdown */
        }
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    }),
  );
}
