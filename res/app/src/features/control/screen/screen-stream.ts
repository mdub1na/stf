import type {Device} from '@/core/devices/types'
import {canViewDevice, isAutomated} from '@/core/devices/enhance'
import {rotator} from './rotator'
import {startHevcScreen, supportsHevcScreen} from './screen-hevc'

export interface ScreenBounds {
  x: number
  y: number
  w: number
  h: number
}

export interface ScreenGeometry {
  rotation: number
  bounds: ScreenBounds
}

export type DisplayError = false | 'secure'
export type ScreenStreamStatus = 'reconnecting' | 'disconnected' | 'offline' | null

export interface ScreenStreamOptions {
  url: string
  root: HTMLElement
  positioner: HTMLElement
  canvas: HTMLCanvasElement
  screen: ScreenGeometry
  getDevice: () => Device
  isShown: () => boolean
  onDisplayError: (error: DisplayError) => void
  onFirstFrame: () => void
  onStatusChange: (status: ScreenStreamStatus) => void
}

export interface ScreenStream {
  checkEnabled: () => void
  resize: () => void
  stop: () => void
}

interface BoundSize {
  w: number
  h: number
}

const streamOptions = {
  autoScaleForRetina: true
  , density: Math.max(1, Math.min(1.5, window.devicePixelRatio || 1))
  , minscale: 0.36
}

function vendorBackingStorePixelRatio(g: CanvasRenderingContext2D): number {
  const vendor = g as unknown as Record<string, number | undefined>
  return vendor.webkitBackingStorePixelRatio ||
    vendor.mozBackingStorePixelRatio ||
    vendor.msBackingStorePixelRatio ||
    vendor.oBackingStorePixelRatio ||
    vendor.backingStorePixelRatio || 1
}

function isSideways(rotation: number): boolean {
  return rotation === 90 || rotation === 270
}

export function startScreenStream(options: ScreenStreamOptions): ScreenStream {
  const {root, positioner, canvas, screen, getDevice} = options
  const g = canvas.getContext('2d') as CanvasRenderingContext2D
  const devicePixelRatio = window.devicePixelRatio || 1
  const frontBackRatio = devicePixelRatio / vendorBackingStorePixelRatio(g)

  let ws: WebSocket | null = null
  let stopped = false
  let retry: ReturnType<typeof setTimeout> | null = null
  let retryAttempt = 0
  let hevcRequested = false
  let hevcDisabled = new URLSearchParams(window.location.search).get('iosScreen') === 'mjpeg'
  let hevc: ReturnType<typeof startHevcScreen> | null = null

  let adjustedBoundSize: BoundSize | null = null
  let cachedEnabled = false
  let canvasAspect = 1
  let parentAspect = 1
  let displayError: DisplayError = false
  let framesDrawn = 0
  let framesReceived = 0
  let newestDrawnFrame = 0
  let frameGeneration = 0
  let transportLost = false
  let streamStatus: ScreenStreamStatus = null

  function isOpen(): boolean {
    return ws !== null && ws.readyState === WebSocket.OPEN
  }

  function sendSize() {
    if (ws && isOpen() && adjustedBoundSize) {
      ws.send(`size ${adjustedBoundSize.w}x${adjustedBoundSize.h}`)
    }
  }

  function setDisplayError(error: DisplayError) {
    displayError = error
    options.onDisplayError(error)
    updateStatus()
  }

  function updateStatus() {
    const device = getDevice()
    let next: ScreenStreamStatus = null
    if (!stopped && options.isShown() && !document.hidden && !displayError &&
      (device.using || isAutomated(device))) {
      if (!device.present || device.status !== 3 || !device.ready) {
        transportLost = true
        next = 'offline'
      }
      else if (transportLost) {
        next = device.platform === 'iOS' ? 'reconnecting' : 'disconnected'
      }
    }
    if (next !== streamStatus) {
      streamStatus = next
      options.onStatusChange(next)
    }
  }

  function clearFrame() {
    frameGeneration += 1
    g.clearRect(0, 0, canvas.width, canvas.height)
    root.classList.remove('has-frame')
  }

  function adjustBoundedSize(w: number, h: number): BoundSize {
    const display = getDevice().display
    const displayWidth = display ? display.width : 0
    const displayHeight = display ? display.height : 0
    let sw = w * streamOptions.density
    let sh = h * streamOptions.density
    let f = displayWidth * streamOptions.minscale

    if (sw < f) {
      sw *= f / sw
      sh *= f / sh
    }

    f = displayHeight * streamOptions.minscale
    if (sh < f) {
      sw *= f / sw
      sh *= f / sh
    }

    const fitsDisplay = displayWidth && displayHeight ?
      Math.min(1, Math.max(displayWidth / sw, displayHeight / sh)) :
      1

    return {w: Math.ceil(sw * fitsDisplay), h: Math.ceil(sh * fitsDisplay)}
  }

  function updateBounds(): boolean {
    const w = screen.bounds.w = root.offsetWidth
    const h = screen.bounds.h = root.offsetHeight

    if (!w || !h) {
      return false
    }

    const next = isSideways(screen.rotation) ? adjustBoundedSize(h, w) : adjustBoundedSize(w, h)

    if (!adjustedBoundSize || next.w !== adjustedBoundSize.w || next.h !== adjustedBoundSize.h) {
      adjustedBoundSize = next
      sendSize()
    }
    return true
  }

  function shouldUpdateScreen(): boolean {
    return options.isShown() &&
      canViewDevice(getDevice()) &&
      !document.hidden &&
      isOpen()
  }

  function isManualIPhone(): boolean {
    const device = getDevice()
    return device.platform === 'iOS' && device.using === true && !isAutomated(device)
  }

  function closeHevc() {
    hevcRequested = false
    hevc?.close()
    hevc = null
  }

  function onScreenInterestGained() {
    if (ws && isOpen()) {
      sendSize()
      if (!hevcDisabled && isManualIPhone() && supportsHevcScreen()) {
        hevcRequested = true
        ws.binaryType = 'arraybuffer'
        ws.send('hevc')
      }
      ws.send('on')
    }
  }

  function onScreenInterestLost() {
    closeHevc()
    if (ws && isOpen()) {
      ws.send('off')
    }
  }

  function checkEnabled() {
    const newEnabled = shouldUpdateScreen()
    updateStatus()
    scheduleRetry()

    if (newEnabled && hevcRequested && !isManualIPhone()) {
      closeHevc()
      ws?.send('mjpeg')
    }

    if (newEnabled === cachedEnabled) {
      updateBounds()
    }
    else if (newEnabled) {
      if (!updateBounds()) {
        return
      }
      onScreenInterestGained()
    }
    else {
      clearFrame()
      onScreenInterestLost()
    }

    cachedEnabled = newEnabled
  }

  function maybeFlipLetterbox() {
    root.classList.toggle('letterboxed', parentAspect < canvasAspect)
  }

  const cachedScreen: ScreenGeometry = {rotation: 0, bounds: {x: 0, y: 0, w: 0, h: 0}}
  let cachedImageWidth = 0
  let cachedImageHeight = 0
  let cachedImageScale = 0
  let cssRotation = 0
  let alwaysUpright = false

  function applyQuirks(banner: {quirks: {alwaysUpright: boolean}}) {
    alwaysUpright = banner.quirks.alwaysUpright
    root.classList.toggle('quirk-always-upright', alwaysUpright)
  }

  function hasImageAreaChanged(width: number, height: number, scale: number): boolean {
    return cachedScreen.bounds.w !== screen.bounds.w ||
      cachedScreen.bounds.h !== screen.bounds.h ||
      cachedImageWidth !== width ||
      cachedImageHeight !== height ||
      cachedImageScale !== scale ||
      cachedScreen.rotation !== screen.rotation
  }

  function updateImageArea(width: number, height: number, scale: number) {
    if (!hasImageAreaChanged(width, height, scale)) {
      return
    }

    cachedImageWidth = width
    cachedImageHeight = height
    cachedImageScale = scale

    if (streamOptions.autoScaleForRetina) {
      canvas.width = cachedImageWidth * scale
      canvas.height = cachedImageHeight * scale
      g.scale(scale, scale)
    }
    else {
      canvas.width = cachedImageWidth
      canvas.height = cachedImageHeight
    }

    cssRotation += rotator(cachedScreen.rotation, screen.rotation)
    canvas.style.transform = `rotate(${cssRotation}deg)`

    cachedScreen.bounds.h = screen.bounds.h
    cachedScreen.bounds.w = screen.bounds.w
    cachedScreen.rotation = screen.rotation

    if (isSideways(screen.rotation) && !alwaysUpright) {
      canvasAspect = height / width
      root.classList.add('rotated')
    }
    else {
      canvasAspect = width / height
      root.classList.remove('rotated')
    }

    if (alwaysUpright) {
      positioner.style.transform = `rotate(${-cssRotation}deg)`
    }

    maybeFlipLetterbox()
  }

  function drawImage(image: CanvasImageSource, width: number, height: number, scale = frontBackRatio) {
    updateImageArea(width, height, scale)
    g.drawImage(image, 0, 0, width, height)
    transportLost = false
    if (displayError) {
      setDisplayError(false)
    }
    updateStatus()
    root.classList.add('has-frame')
    if (framesDrawn++ === 0) {
      options.onFirstFrame()
    }
  }

  function drawFrame(data: Blob, socket: WebSocket) {
    framesReceived += 1
    const frame = framesReceived
    const generation = frameGeneration

    createImageBitmap(data)
      .then((bitmap) => {
        if (ws !== socket || generation !== frameGeneration || !shouldUpdateScreen() ||
          frame < newestDrawnFrame) {
          bitmap.close()
          return
        }
        newestDrawnFrame = frame
        try {
          drawImage(bitmap, bitmap.width, bitmap.height)
        }
        finally {
          bitmap.close()
        }
      })
      .catch(() => undefined)
  }

  function fallBackToMjpeg(socket: WebSocket) {
    hevcDisabled = true
    closeHevc()
    transportLost = true
    updateStatus()
    socket.send('mjpeg')
  }

  function openHevc(header: string, socket: WebSocket) {
    if (!hevcRequested || !isManualIPhone() || !shouldUpdateScreen()) {
      return
    }
    hevc?.close()
    frameGeneration += 1
    let ready = false
    const session = startHevcScreen(header, {
      onFrame: (frame) => {
        if (hevc !== session || ws !== socket || !shouldUpdateScreen()) {
          return
        }
        const display = getDevice().display
        const width = display?.width || frame.displayWidth
        const height = display?.height || frame.displayHeight
        if ((width > height) !== (frame.displayWidth > frame.displayHeight)) {
          fallBackToMjpeg(socket)
          return
        }
        // Keep the canvas aligned with touch coordinates as the encoder changes resolution.
        drawImage(frame, width, height, 1)
        if (!ready) {
          ready = true
          socket.send('hevc ready')
        }
      }
      , onKeyframe: () => {
        if (hevc === session && ws === socket && shouldUpdateScreen()) {
          socket.send('hevc keyframe')
        }
      }
      , onFallback: () => {
        if (hevc === session && ws === socket && shouldUpdateScreen()) {
          fallBackToMjpeg(socket)
        }
      }
    })
    hevc = session
  }

  function connect() {
    const socket = new WebSocket(options.url)
    socket.binaryType = 'blob'
    ws = socket
    socket.onmessage = (message: MessageEvent) => {
      if (ws !== socket || stopped) {
        return
      }
      const display = getDevice().display
      screen.rotation = display ? display.rotation : 0

      if (message.data instanceof ArrayBuffer) {
        if (shouldUpdateScreen()) {
          if (hevc) {
            hevc.receive(message.data)
          }
          else {
            const bytes = new Uint8Array(message.data)
            if (bytes[0] === 0xff && bytes[1] === 0xd8) {
              drawFrame(new Blob([message.data]), socket)
            }
          }
        }
      }
      else if (message.data instanceof Blob) {
        if (shouldUpdateScreen() && !hevc) {
          drawFrame(message.data, socket)
        }
      }
      else if (typeof message.data === 'string' && message.data.startsWith('hevc ')) {
        openHevc(message.data.slice('hevc '.length), socket)
      }
      else if (message.data === 'mjpeg') {
        hevcDisabled ||= hevcRequested
        closeHevc()
      }
      else if (/^start /.test(message.data)) {
        applyQuirks(JSON.parse(message.data.slice('start '.length)))
      }
      else if (message.data === 'secure_on') {
        if (hevcRequested) {
          fallBackToMjpeg(socket)
        }
        clearFrame()
        setDisplayError('secure')
      }
    }

    socket.onopen = () => {
      if (ws !== socket || stopped) {
        return
      }
      retryAttempt = 0
      cachedEnabled = false
      checkEnabled()
    }
    socket.onclose = () => {
      if (ws !== socket || stopped) {
        return
      }
      ws = null
      closeHevc()
      cachedEnabled = false
      transportLost = true
      clearFrame()
      updateStatus()
      scheduleRetry()
    }
    socket.onerror = () => {
      if (ws === socket && !stopped) {
        closeHevc()
        transportLost = true
        clearFrame()
        updateStatus()
      }
    }
  }

  function scheduleRetry() {
    const device = getDevice()
    // A recovered iPhone may register before Kubernetes has restored its screen route.
    if (!stopped && !ws && !retry && device.platform === 'iOS' && canViewDevice(device)) {
      retry = setTimeout(() => {
        retry = null
        if (!stopped && canViewDevice(getDevice())) {
          connect()
        }
      }, Math.min(5000, 500 * 2 ** Math.min(4, retryAttempt++)))
    }
  }

  function resize() {
    parentAspect = root.offsetWidth / root.offsetHeight
    maybeFlipLetterbox()
  }

  function stop() {
    stopped = true
    closeHevc()
    clearFrame()
    updateStatus()
    if (retry) {
      clearTimeout(retry)
      retry = null
    }
    if (!ws) {
      return
    }
    const socket = ws
    ws = null
    socket.onerror = socket.onclose = socket.onmessage = socket.onopen = null
    socket.close()
  }

  connect()
  resize()

  return {checkEnabled, resize, stop}
}
