import type { KernelContext, TelemetryOptions } from '@ecmaos/types'
import { context, trace } from '@opentelemetry/api'

/**
 * Tracing is optional and the web OpenTelemetry stack is browser-only: `@opentelemetry/context-zone` patches
 * globals (zone.js) and breaks `MessagePort` dispatch in Node. It is therefore imported on demand by `init()`,
 * and only in a browser, never at module load.
 */
export class Telemetry {
  private _ctx: KernelContext
  private _provider?: { forceFlush?: () => Promise<void> }
  private _active: boolean = false

  get active() { return this._active }

  constructor(options: TelemetryOptions) {
    this._ctx = options.context
  }

  /** Starts tracing when an endpoint is configured and a DOM is present; otherwise a no-op. */
  async init() {
    const endpoint = import.meta.env.ECMAOS_OPENTELEMETRY_ENDPOINT
    if (!endpoint || !globalThis.document || this._active) return

    try {
      await this._initialize(endpoint)
    } catch (error) {
      this._ctx.log.error(`Failed to initialize OpenTelemetry: ${error}`)
    }
  }

  private async _initialize(endpoint: string) {
    const [
      { BatchSpanProcessor, SimpleSpanProcessor, TracerProvider },
      { ZoneContextManager },
      { DocumentLoadInstrumentation },
      { registerInstrumentations },
      { OTLPTraceExporter }
    ] = await Promise.all([
      import('@opentelemetry/sdk-trace'),
      import('@opentelemetry/context-zone'),
      import('@opentelemetry/instrumentation-document-load'),
      import('@opentelemetry/instrumentation'),
      import('@opentelemetry/exporter-trace-otlp-http')
    ])

    const exporter = new OTLPTraceExporter({
      url: endpoint,
      headers: {}
    })

    const useSimpleProcessor = import.meta.env.ECMAOS_OPENTELEMETRY_SIMPLE_PROCESSOR === 'true'
    const spanProcessor = useSimpleProcessor
      ? new SimpleSpanProcessor({ exporter })
      : new BatchSpanProcessor({
          exporter,
          scheduledDelayMillis: 100,
          maxQueueSize: 2048,
          maxExportBatchSize: 512
        })

    const provider = new TracerProvider({
      spanProcessors: [spanProcessor]
    })

    trace.setGlobalTracerProvider(provider)
    context.setGlobalContextManager(new ZoneContextManager().enable())

    registerInstrumentations({
      instrumentations: [
        new DocumentLoadInstrumentation()
      ]
    })

    this._provider = provider
    this._active = true
    this._ctx.log.info(`OpenTelemetry initialized with endpoint: ${endpoint}`)
  }

  getTracer(name: string, version?: string) {
    if (!this._active || !this._provider) {
      return trace.getTracer('noop')
    }
    return trace.getTracer(name, version)
  }
}
