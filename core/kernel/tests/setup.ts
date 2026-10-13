import { afterAll, vi } from 'vitest'
import { Buffer } from 'node:buffer'
import 'fake-indexeddb/auto'
import 'vitest-canvas-mock'

(globalThis as any).Buffer = Buffer

// A booted kernel leaves background work (crond, intervals) logging after a file's last test; once the file is done
// that output can land while vitest closes its RPC channel and fail the run with an `EnvironmentTeardownError`.
// Unhandled errors are not console output, so vitest still reports those.
afterAll(() => {
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
    console[method] = () => {}
  }
})

;(globalThis as any).ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn()
  }))
})

// Mock Notification API
const MockNotification = vi.fn().mockImplementation(() => ({
  close: vi.fn(),
}))
Object.defineProperty(MockNotification, 'permission', { value: 'granted', writable: true })
Object.defineProperty(MockNotification, 'requestPermission', { 
  value: vi.fn(() => Promise.resolve('granted')),
  writable: true 
})
Object.defineProperty(window, 'Notification', {
  writable: true,
  value: MockNotification
})

Object.defineProperty(window, 'navigator', {
  writable: true,
  value: {
    registerProtocolHandler: vi.fn(),
    // USB API
    usb: {
      getDevices: vi.fn(() => Promise.resolve([])),
      requestDevice: vi.fn(() => Promise.resolve(null)),
    },
    // Battery API
    getBattery: vi.fn(() => Promise.resolve(Object.assign(new EventTarget(), {
      charging: true,
      chargingTime: Infinity,
      dischargingTime: Infinity,
      level: 1,
      onchargingchange: null,
      onchargingtimechange: null,
      ondischargingtimechange: null,
      onlevelchange: null,
    }))),
    // Bluetooth API
    bluetooth: {
      getDevices: vi.fn(() => Promise.resolve([])),
      requestDevice: vi.fn(() => Promise.resolve(null)),
    },
    // Serial API
    serial: {
      getPorts: vi.fn(() => Promise.resolve([])),
      requestPort: vi.fn(() => Promise.resolve(null)),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
    // HID API
    hid: {
      getDevices: vi.fn(() => Promise.resolve([])),
      requestDevice: vi.fn(() => Promise.resolve([])),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
    // MIDI API
    requestMIDIAccess: vi.fn(() => Promise.resolve({
      inputs: new Map(),
      outputs: new Map(),
      onstatechange: null,
    })),
    // Geolocation API
    geolocation: {
      getCurrentPosition: vi.fn((success) => success({
        coords: { latitude: 0, longitude: 0, accuracy: 0, altitude: null, altitudeAccuracy: null, heading: null, speed: null },
        timestamp: Date.now(),
      })),
      watchPosition: vi.fn(() => 0),
      clearWatch: vi.fn(),
    },
    // Media Devices API
    mediaDevices: {
      getUserMedia: vi.fn(() => Promise.resolve({
        getTracks: () => [],
        getAudioTracks: () => [],
        getVideoTracks: () => [],
      })),
      enumerateDevices: vi.fn(() => Promise.resolve([])),
    },
    // GPU API (WebGPU)
    gpu: {
      requestAdapter: vi.fn(() => Promise.resolve(null)), // No adapter available in test
      getPreferredCanvasFormat: vi.fn(() => 'bgra8unorm'),
    },
    // Presentation API
    presentation: {
      defaultRequest: null,
      receiver: null,
    },
    // Permissions API
    permissions: {
      query: vi.fn(() => Promise.resolve({ state: 'granted' })),
    },
    // Network Information API
    connection: {
      downlink: 10,
      effectiveType: '4g',
      rtt: 50,
      saveData: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
    // User Agent Data API
    userAgentData: {
      platform: 'Linux',
      brands: [],
      mobile: false,
    },
    // Other commonly accessed properties
    language: 'en-US',
    languages: ['en-US', 'en'],
    platform: 'Linux x86_64',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Test/1.0',
    onLine: true,
    cookieEnabled: true,
    hardwareConcurrency: 4,
    maxTouchPoints: 0,
    getGamepads: vi.fn(() => []),
  }
})

// Mock AudioContext for audio device tests
class MockAudioContext {
  state = 'running'
  sampleRate = 44100
  destination = { maxChannelCount: 2 }
  createGain = vi.fn(() => ({
    gain: { value: 1 },
    connect: vi.fn(),
    disconnect: vi.fn(),
  }))
  createOscillator = vi.fn(() => ({
    frequency: { value: 440 },
    type: 'sine',
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  }))
  createAnalyser = vi.fn(() => ({
    fftSize: 2048,
    frequencyBinCount: 1024,
    getByteFrequencyData: vi.fn(),
    getByteTimeDomainData: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
  }))
  createMediaStreamSource = vi.fn(() => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
  }))
  close = vi.fn(() => Promise.resolve())
  resume = vi.fn(() => Promise.resolve())
  suspend = vi.fn(() => Promise.resolve())
}

globalThis.AudioContext = MockAudioContext as unknown as typeof AudioContext

// Mock WebGLRenderingContext for WebGL device tests
class MockWebGLRenderingContext {
  canvas = document.createElement('canvas')
  drawingBufferWidth = 800
  drawingBufferHeight = 600
  
  getParameter = vi.fn((pname: number) => {
    // Return reasonable defaults for common parameters
    if (pname === 0x1F02) return 'Mock WebGL Vendor' // GL_VENDOR
    if (pname === 0x1F01) return 'Mock WebGL Renderer' // GL_RENDERER
    if (pname === 0x1F00) return 'Mock WebGL Version' // GL_VERSION
    return null
  })
  getExtension = vi.fn(() => null)
  createShader = vi.fn(() => ({}))
  createProgram = vi.fn(() => ({}))
  createBuffer = vi.fn(() => ({}))
  createTexture = vi.fn(() => ({}))
  createFramebuffer = vi.fn(() => ({}))
  createRenderbuffer = vi.fn(() => ({}))
  bindBuffer = vi.fn()
  bindTexture = vi.fn()
  bindFramebuffer = vi.fn()
  bindRenderbuffer = vi.fn()
  bufferData = vi.fn()
  shaderSource = vi.fn()
  compileShader = vi.fn()
  attachShader = vi.fn()
  linkProgram = vi.fn()
  useProgram = vi.fn()
  getShaderParameter = vi.fn(() => true)
  getProgramParameter = vi.fn(() => true)
  getUniformLocation = vi.fn(() => ({}))
  getAttribLocation = vi.fn(() => 0)
  enableVertexAttribArray = vi.fn()
  vertexAttribPointer = vi.fn()
  uniform1i = vi.fn()
  uniform1f = vi.fn()
  uniform2f = vi.fn()
  uniform3f = vi.fn()
  uniform4f = vi.fn()
  uniformMatrix4fv = vi.fn()
  viewport = vi.fn()
  clear = vi.fn()
  clearColor = vi.fn()
  enable = vi.fn()
  disable = vi.fn()
  drawArrays = vi.fn()
  drawElements = vi.fn()
  texImage2D = vi.fn()
  texParameteri = vi.fn()
  activeTexture = vi.fn()
  deleteShader = vi.fn()
  deleteProgram = vi.fn()
  deleteBuffer = vi.fn()
  deleteTexture = vi.fn()
  deleteFramebuffer = vi.fn()
  deleteRenderbuffer = vi.fn()
  getError = vi.fn(() => 0)
}

globalThis.WebGLRenderingContext = MockWebGLRenderingContext as unknown as typeof WebGLRenderingContext

// jsdom's default `TextEncoder` produces `Uint8Array`s that differ from the global `Uint8Array`, which breaks type comparisons (https://github.com/vitest-dev/vitest/issues/4043).
class ESBuildAndJSDOMCompatibleTextEncoder extends TextEncoder {
  constructor() {
    super()
  }

  override encode(input: string) {
    if (typeof input !== 'string') {
      throw new TypeError('`input` must be a string')
    }

    const decodedURI = decodeURIComponent(encodeURIComponent(input))
    const arr = new Uint8Array(decodedURI.length)
    const chars = decodedURI.split('')
    for (let i = 0; i < chars.length; i++) {
      arr[i] = decodedURI[i]!.charCodeAt(0)
    }
    return arr
  }
}

global.TextEncoder = ESBuildAndJSDOMCompatibleTextEncoder

// The site serves prebuilt WebAssembly programs at `/programs/` (see `binPrograms` in `vite-plugin-bin-node.ts`);
// tests answer those requests from the program packages on disk and pass everything else to the existing `fetch`. The
// default catalog is empty, since installing it costs over a second per boot; a test that runs a program boots with
// `programs: PROGRAMS_ALL`.
{
  const nodeFs = (process as unknown as { getBuiltinModule: (id: string) => typeof import('node:fs') }).getBuiltinModule('node:fs')
  const nodePath = (process as unknown as { getBuiltinModule: (id: string) => typeof import('node:path') }).getBuiltinModule('node:path')
  const packages = [['coreutils', '../../utils'], ['coreutils-copyleft', '../../utils-copyleft']].map(([name, dir]) => {
    const programs = nodePath.resolve(import.meta.dirname, dir!, 'programs')
    return { name: name!, programs, manifest: JSON.parse(nodeFs.readFileSync(nodePath.join(programs, 'manifest.json'), 'utf8')) }
  })
  const realFetch = globalThis.fetch.bind(globalThis)
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const pathname = new URL(raw, 'http://localhost/').pathname
    if (!pathname.startsWith('/programs/')) return realFetch(input as RequestInfo, init)
    if (pathname === '/programs/index.json') {
      const all = new URL(raw, 'http://localhost/').searchParams.has('all')
      const catalog = { packages: all ? packages.map(pkg => ({ name: pkg.manifest.package, path: pkg.name, programs: pkg.manifest.programs })) : [] }
      return Promise.resolve(new Response(JSON.stringify(catalog), { headers: { 'content-type': 'application/json' } }))
    }
    const [, , pkgName, file] = pathname.split('/')
    const pkg = packages.find(candidate => candidate.name === pkgName)
    const path = pkg && nodePath.join(pkg.programs, nodePath.basename(file ?? ''))
    if (!path || !nodeFs.existsSync(path)) return Promise.resolve(new Response('Not found', { status: 404 }))
    return Promise.resolve(new Response(nodeFs.readFileSync(path), { headers: { 'content-type': 'application/wasm' } }))
  }) as typeof fetch
}
