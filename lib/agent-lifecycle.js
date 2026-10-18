const registries = new WeakMap()
const originalSymbol = Symbol.for('cordis.original')
const originalObject = (value) => value?.[originalSymbol] ?? value

// The controller discards AgentHandle after create/resume. Retain that public
// handle at the registry boundary so idle deletion can use its complete teardown.
export function trackAgentHandles(registry) {
  registry = originalObject(registry)
  if (!registry || typeof registry.create !== 'function' || typeof registry.resume !== 'function') return () => {}
  let state = registries.get(registry)
  if (state) { state.references++; return subscription(registry, state) }
  state = { handles: new Map(), originals: new Map(), wrappers: new Map(), references: 1 }
  for (const method of ['create', 'resume']) {
    const original = registry[method]
    state.originals.set(method, Object.getOwnPropertyDescriptor(registry, method))
    const wrapper = async function (...args) {
      const handle = await Reflect.apply(original, this, args)
      if (typeof handle?.dispose === 'function' && handle.agent?.id) {
        const originalDispose = handle.dispose
        let disposal
        const tracked = {
          agent: handle.agent,
          dispose() {
            return disposal ??= Promise.resolve(Reflect.apply(originalDispose, handle, [])).then(() => {
              if (state.handles.get(handle.agent.id) === tracked) state.handles.delete(handle.agent.id)
            })
          },
        }
        handle.dispose = tracked.dispose
        state.handles.set(handle.agent.id, tracked)
      }
      return handle
    }
    state.wrappers.set(method, wrapper)
    registry[method] = wrapper
  }
  registries.set(registry, state)
  return subscription(registry, state)
}

function subscription(registry, state) {
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    releaseTracking(registry, state)
  }
}

function releaseTracking(registry, state) {
  if (--state.references > 0) return
  for (const [method, descriptor] of state.originals) {
    if (registry[method] !== state.wrappers.get(method)) continue
    if (descriptor) Object.defineProperty(registry, method, descriptor)
    else delete registry[method]
  }
  state.handles.clear()
  registries.delete(registry)
}

export function canReleaseAgent(registry, id) {
  registry = originalObject(registry)
  const handle = registries.get(registry)?.handles.get(id)
  try {
    return Boolean(handle && originalObject(handle.agent) === originalObject(registry.get(id)) && handle.agent.status === 'idle')
  } catch {
    // A failing registry cannot establish safe lifecycle ownership.
    return false
  }
}

export async function releaseIdleAgent(registry, id) {
  registry = originalObject(registry)
  if (!canReleaseAgent(registry, id)) return false
  const state = registries.get(registry)
  const handle = state.handles.get(id)
  // No await between the status check and invoking the lifecycle disposer.
  await handle.dispose()
  if (state.handles.get(id) === handle) state.handles.delete(id)
  if (registry.get(id)) throw new Error('宿主尚未释放会话，请刷新后重试')
  return true
}
