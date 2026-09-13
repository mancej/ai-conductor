/**
 * T5: Generic visualizer wiring in index.ts.
 *
 * Verifies that when a VisualizerPlugin is returned by `buildVisualizers()`,
 * the lifecycle (start/stop) is exercised correctly by the conductor's run flow.
 *
 * Tests the exported `buildVisualizers` helper and the wiring contract, without
 * running the full CLI main() (which is too heavy for unit tests).
 */
import { describe, it, expect, vi } from 'vitest';
import type { VisualizerPlugin, VisualizerStartContext } from '../../src/types/plugin.js';
import { ConductorEventEmitter } from '../../src/ui/events.js';
import { buildVisualizers } from '../../src/index.js';

class FakeVisualizer implements VisualizerPlugin {
  readonly name = 'fake';
  startCalled = 0;
  stopCalled = 0;
  lastEmitter: ConductorEventEmitter | null = null;
  lastContext: VisualizerStartContext | null = null;

  start(emitter: ConductorEventEmitter, context: VisualizerStartContext): void {
    this.startCalled++;
    this.lastEmitter = emitter;
    this.lastContext = context;
  }

  async stop(): Promise<void> {
    this.stopCalled++;
  }
}

describe('Visualizer wiring helpers', () => {
  it('buildVisualizers returns an empty array when no visualizers configured', () => {
    const emitter = new ConductorEventEmitter();
    const visualizers = buildVisualizers([], emitter);
    expect(visualizers).toHaveLength(0);
  });

  // Covers: task:1
  it('buildVisualizers gives every visualizer the supplied emitter and identity context', () => {
    const emitter = new ConductorEventEmitter();
    const vis1 = new FakeVisualizer();
    const vis2 = new FakeVisualizer();
    (vis2 as { name: string }).name = 'fake2';
    const context: VisualizerStartContext = {
      runId: 'run-123',
      project: 'ai-conductor',
      branch: 'feature/visualizer-seam',
      feature: 'connector-seam-for-event-submissions-is-registered',
      engineVersion: '1.2.3',
      pipelineDir: '/tmp/project/.pipeline',
    };

    buildVisualizers([vis1, vis2], emitter, context);

    expect(vis1.startCalled).toBe(1);
    expect(vis2.startCalled).toBe(1);
    expect(vis1.lastEmitter).toBe(emitter);
    expect(vis1.lastContext).toBe(context);
    expect(vis2.lastContext).toBe(context);
  });

  // Covers: task:7
  it('isolates a throwing start, reports it, and returns only started visualizers', async () => {
    const emitter = new ConductorEventEmitter();
    const first = new FakeVisualizer();
    const third = new FakeVisualizer();
    (first as { name: string }).name = 'first';
    (third as { name: string }).name = 'third';
    const second: VisualizerPlugin & { startCalled: number; stopCalled: number } = {
      name: 'second',
      startCalled: 0,
      stopCalled: 0,
      start: () => {
        second.startCalled++;
        throw new Error('second start failed');
      },
      stop: async () => {
        second.stopCalled++;
      },
    };
    const errors: Array<{ rendererName: string; error: string }> = [];
    emitter.on('renderer_error', (event) => {
      if (event.type === 'renderer_error') {
        errors.push(event);
      }
    });

    const started = buildVisualizers([first, second, third], emitter);

    expect(errors).toEqual([
      { type: 'renderer_error', rendererName: 'second', error: 'second start failed' },
    ]);
    expect(first.startCalled).toBe(1);
    expect(second.startCalled).toBe(1);
    expect(third.startCalled).toBe(1);
    expect(started).toEqual([first, third]);

    const { stopVisualizers } = await import('../../src/index.js');
    await stopVisualizers(started);
    expect(first.stopCalled).toBe(1);
    expect(second.stopCalled).toBe(0);
    expect(third.stopCalled).toBe(1);
  });

  it('returns an empty started list when every visualizer start throws', () => {
    const emitter = new ConductorEventEmitter();
    const onlyThrowing: VisualizerPlugin = {
      name: 'only-throwing',
      start: () => {
        throw new Error('unavailable');
      },
      stop: async () => {},
    };

    expect(buildVisualizers([onlyThrowing], emitter)).toEqual([]);
  });

  it('continues starting visualizers when one start() throws synchronously', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const emitter = new ConductorEventEmitter();
    const throwingVisualizer: VisualizerPlugin = {
      name: 'throwing',
      start: () => {
        throw new Error('visualizer start failed');
      },
      stop: async () => {},
    };
    const nextVisualizer = new FakeVisualizer();

    try {
      buildVisualizers([throwingVisualizer, nextVisualizer], emitter);
      expect(nextVisualizer.startCalled).toBe(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('classifies startup and event-handler failures in visualizer warnings', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const startupEmitter = new ConductorEventEmitter();
    const synchronousEmitter = new ConductorEventEmitter();
    const asynchronousEmitter = new ConductorEventEmitter();
    const startupVisualizer: VisualizerPlugin = {
      name: 'startup-classification',
      start: () => {
        throw new Error('startup kaboom');
      },
      stop: async () => {},
    };
    const synchronousVisualizer: VisualizerPlugin = {
      name: 'synchronous-handler-classification',
      start: (emitter) => {
        emitter.on('step_started', () => {
          throw new Error('synchronous kaboom');
        });
      },
      stop: async () => {},
    };
    const asynchronousVisualizer: VisualizerPlugin = {
      name: 'rejected-handler-classification',
      start: (emitter) => {
        emitter.on('step_started', async () => {
          throw new Error('asynchronous kaboom');
        });
      },
      stop: async () => {},
    };

    try {
      buildVisualizers([startupVisualizer], startupEmitter);
      buildVisualizers([synchronousVisualizer], synchronousEmitter);
      buildVisualizers([asynchronousVisualizer], asynchronousEmitter);
      await synchronousEmitter.emit({
        type: 'step_started',
        step: 'explore',
        index: 0,
      });
      await asynchronousEmitter.emit({
        type: 'step_started',
        step: 'explore',
        index: 0,
      });
      await Promise.resolve();

      const classify = (name: string) => {
        const warnings = warnSpy.mock.calls
          .map(([message]) => String(message))
          .filter((message) => message.includes(name));
        return {
          count: warnings.length,
          startFailure: warnings.some((message) => /start\(\).*fail/i.test(message)),
          handlerFailure: warnings.some((message) => /handler.*fail/i.test(message)),
        };
      };

      expect({
        startup: classify(startupVisualizer.name),
        synchronous: classify(synchronousVisualizer.name),
        asynchronous: classify(asynchronousVisualizer.name),
      }).toEqual({
        startup: { count: 1, startFailure: true, handlerFailure: false },
        synchronous: { count: 1, startFailure: false, handlerFailure: true },
        asynchronous: { count: 1, startFailure: false, handlerFailure: true },
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('detaches a visualizer listener after its synchronous event-handler failure', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const emitter = new ConductorEventEmitter();
    const throwingHandler = vi.fn(() => {
      throw new Error('visualizer handler failed');
    });
    const healthyHandler = vi.fn();
    const visualizer: VisualizerPlugin = {
      name: 'throwing-listener',
      start: (visualizerEmitter) => {
        visualizerEmitter.on('step_started', throwingHandler);
      },
      stop: async () => {},
    };

    try {
      emitter.on('step_started', healthyHandler);
      buildVisualizers([visualizer], emitter);
      await emitter.emit({ type: 'step_started', step: 'explore', index: 0 });
      await emitter.emit({ type: 'step_started', step: 'explore', index: 0 });

      expect([
        throwingHandler.mock.calls.length,
        healthyHandler.mock.calls.length,
      ]).toEqual([1, 2]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('detaches a visualizer listener after its asynchronous event-handler failure', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const emitter = new ConductorEventEmitter();
    const rejectingHandler = vi.fn(async () => {
      throw new Error('async visualizer handler failed');
    });
    const healthyHandler = vi.fn();
    const visualizer: VisualizerPlugin = {
      name: 'rejecting-listener',
      start: (visualizerEmitter) => {
        visualizerEmitter.on('step_started', rejectingHandler);
      },
      stop: async () => {},
    };

    try {
      emitter.on('step_started', healthyHandler);
      buildVisualizers([visualizer], emitter);
      await emitter.emit({ type: 'step_started', step: 'explore', index: 0 });
      await Promise.resolve();
      await emitter.emit({ type: 'step_started', step: 'explore', index: 0 });
      await Promise.resolve();

      expect([
        rejectingHandler.mock.calls.length,
        healthyHandler.mock.calls.length,
        warnSpy.mock.calls.length,
      ]).toEqual([1, 2, 1]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not stall event delivery when a visualizer listener never settles', async () => {
    vi.useFakeTimers();
    const emitter = new ConductorEventEmitter();
    const visualizer: VisualizerPlugin = {
      name: 'never-settling-listener',
      start: (visualizerEmitter) => {
        visualizerEmitter.on(
          'step_started',
          () => new Promise<void>(() => {}),
        );
      },
      stop: async () => {},
    };

    try {
      buildVisualizers([visualizer], emitter);
      const outcome = Promise.race([
        emitter
          .emit({ type: 'step_started', step: 'explore', index: 0 })
          .then(() => 'delivered' as const),
        new Promise<'timed-out'>((resolve) => {
          setTimeout(() => resolve('timed-out'), 25);
        }),
      ]);

      await vi.advanceTimersByTimeAsync(25);

      expect(await outcome).toBe('delivered');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stopVisualizers calls stop() on each visualizer', async () => {
    const { stopVisualizers } = await import('../../src/index.js');
    const vis = new FakeVisualizer();
    await stopVisualizers([vis]);
    expect(vis.stopCalled).toBe(1);
  });

  it('stopVisualizers continues to sibling stops when a visualizer rejects', async () => {
    const { stopVisualizers } = await import('../../src/index.js');
    const badVis: VisualizerPlugin = {
      name: 'bad',
      start: () => {},
      stop: () => Promise.reject(new Error('export failed')),
    };
    const sibling = new FakeVisualizer();
    await expect(stopVisualizers([badVis, sibling])).resolves.toBeUndefined();
    expect(sibling.stopCalled).toBe(1);
  });

  it('bounds a never-settling visualizer stop without blocking other plugins', async () => {
    const { stopVisualizers } = await import('../../src/index.js');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    const healthyStop = vi.fn(async () => {});
    const hangingVisualizer: VisualizerPlugin = {
      name: 'never-stopping',
      start: () => {},
      stop: () => new Promise<void>(() => {}),
    };
    const healthyVisualizer: VisualizerPlugin = {
      name: 'healthy-stop',
      start: () => {},
      stop: healthyStop,
    };

    try {
      const outcome = Promise.race([
        stopVisualizers([hangingVisualizer, healthyVisualizer]).then(
          () => 'resolved' as const,
        ),
        new Promise<'timed-out'>((resolve) => {
          setTimeout(() => resolve('timed-out'), 10_000);
        }),
      ]);

      await vi.advanceTimersByTimeAsync(10_000);

      expect([
        await outcome,
        healthyStop.mock.calls.length,
        warnSpy.mock.calls.length,
      ]).toEqual(['resolved', 1, 1]);
    } finally {
      vi.useRealTimers();
      warnSpy.mockRestore();
    }
  });
});

describe('merged visualizer lifecycle context', () => {
  it.each(['inline', 'daemon', 'compose'] as const)(
    'starts configured %s connectors once with context and isolates their handlers',
    async (mode) => {
      const { PluginRegistry } = await import('../../src/engine/plugin-registry.js');
      const { runInlineVisualizerLifecycle, runEngineerVisualizerLifecycle } = await import('../../src/index.js');
      const { runDaemonVisualizerLifecycle } = await import('../../src/daemon-cli.js');
      const registry = new PluginRegistry();
      const emitter = new ConductorEventEmitter();
      const received = vi.fn();
      const stop = vi.fn(async () => {});
      const start = vi.fn((events: ConductorEventEmitter, context: VisualizerStartContext) => {
        expect(context).toEqual({ runId: 'merge-run', project: '/project' });
        events.on('step_started', received);
        events.on('step_started', () => { throw new Error('connector handler failed'); });
      });
      const factory = vi.fn(() => ({ name: 'selected', start, stop }));
      const unselected = vi.fn(() => null);
      registry.register('visualizer', 'selected', factory);
      registry.register('visualizer', 'unselected', unselected);
      registry.markInitialized();
      const context = {
        config: { visualizers: ['selected'] },
        pipelineDir: '/project/.pipeline',
        startContext: { runId: 'merge-run', project: '/project' },
        emitter,
      };
      const run = async () => {
        await emitter.emitOrThrow({ type: 'step_started', step: 'explore', index: 0 });
        return 'completed';
      };
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const result = mode === 'inline'
          ? await runInlineVisualizerLifecycle(registry, emitter, run, [], context)
          : mode === 'daemon'
            ? await runDaemonVisualizerLifecycle(registry, emitter, run, context)
            : await runEngineerVisualizerLifecycle(registry, emitter, run, context);
        expect(result).toBe('completed');
        expect(factory).toHaveBeenCalledExactlyOnceWith(context);
        expect(unselected).not.toHaveBeenCalled();
        expect(start).toHaveBeenCalledExactlyOnceWith(emitter, context.startContext);
        expect(received).toHaveBeenCalledOnce();
        expect(stop).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledOnce();
      } finally {
        warn.mockRestore();
      }
    },
  );
});
