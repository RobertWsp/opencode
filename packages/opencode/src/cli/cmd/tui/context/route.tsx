import { createStore } from "solid-js/store"
import { createSimpleContext } from "./helper"
import type { PromptInfo } from "../component/prompt/history"
import { mkdirSync, writeFileSync, rmSync } from "fs"

const SESSION_DIR = "/tmp/opencode-session"

function writeSessionMarker(sessionID: string | undefined) {
  try {
    mkdirSync(SESSION_DIR, { recursive: true })
    const file = `${SESSION_DIR}/${process.pid}`
    if (sessionID) {
      writeFileSync(file, sessionID)
    } else {
      rmSync(file, { force: true })
    }
  } catch {}
}

// Clean up marker on exit
for (const sig of ["exit", "SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    try {
      rmSync(`${SESSION_DIR}/${process.pid}`, { force: true })
    } catch {}
  })
}

export type HomeRoute = {
  type: "home"
  initialPrompt?: PromptInfo
}

export type SessionRoute = {
  type: "session"
  sessionID: string
  initialPrompt?: PromptInfo
}

export type Route = HomeRoute | SessionRoute

export const { use: useRoute, provider: RouteProvider } = createSimpleContext({
  name: "Route",
  init: () => {
    const initialRoute: Route = process.env["OPENCODE_ROUTE"]
      ? JSON.parse(process.env["OPENCODE_ROUTE"])
      : { type: "home" }
    const [store, setStore] = createStore<Route>(initialRoute)

    // Write marker on init if starting directly into a session (e.g. opencode -s ses_xxx)
    writeSessionMarker(initialRoute.type === "session" ? initialRoute.sessionID : undefined)

    return {
      get data() {
        return store
      },
      navigate(route: Route) {
        console.log("navigate", route)
        writeSessionMarker(route.type === "session" ? route.sessionID : undefined)
        setStore(route)
      },
    }
  },
})

export type RouteContext = ReturnType<typeof useRoute>

export function useRouteData<T extends Route["type"]>(type: T) {
  const route = useRoute()
  return route.data as Extract<Route, { type: typeof type }>
}
