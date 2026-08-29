import { pluck, distinctUntilChanged } from "rxjs/operators"
import DispatchingStore, { defineDispatchers } from "./DispatchingStore"
import { SIOConnection } from "~/helpers/realtime/SIOConnection"
import {
  HoppRealtimeLog,
  HoppRealtimeLogLine,
} from "~/helpers/types/HoppRealtimeLog"

export type SIOClientVersion = "v4" | "v3" | "v2"

export type HoppSIOAuth = {
  authType: "None" | "Bearer"
  bearerToken: string
  authActive: boolean
}

export const defaultSIOAuth: HoppSIOAuth = {
  authType: "None",
  bearerToken: "",
  authActive: true,
}

export type HoppSIORequest = {
  endpoint: string
  path: string
  version: SIOClientVersion
  auth: HoppSIOAuth
}

type HoppSIOSession = {
  request: HoppSIORequest
  log: HoppRealtimeLog
  socket: SIOConnection
}

const defaultSIORequest: HoppSIORequest = {
  endpoint: "wss://echo-socketio.hoppscotch.io",
  path: "/socket.io",
  version: "v4",
  auth: defaultSIOAuth,
}

const defaultSIOSession: HoppSIOSession = {
  request: defaultSIORequest,
  socket: new SIOConnection(),
  log: [],
}

const dispatchers = defineDispatchers({
  setRequest(
    _: HoppSIOSession,
    { newRequest }: { newRequest: HoppSIORequest }
  ) {
    return {
      request: newRequest,
    }
  },
  setEndpoint(curr: HoppSIOSession, { newEndpoint }: { newEndpoint: string }) {
    return {
      request: {
        ...curr.request,
        endpoint: newEndpoint,
      },
    }
  },
  setPath(curr: HoppSIOSession, { newPath }: { newPath: string }) {
    return {
      request: {
        ...curr.request,
        path: newPath,
      },
    }
  },
  setVersion(
    curr: HoppSIOSession,
    { newVersion }: { newVersion: SIOClientVersion }
  ) {
    return {
      request: {
        ...curr.request,
        version: newVersion,
      },
    }
  },
  setAuth(curr: HoppSIOSession, { newAuth }: { newAuth: HoppSIOAuth }) {
    return {
      request: {
        ...curr.request,
        auth: newAuth,
      },
    }
  },
  setAuthType(
    curr: HoppSIOSession,
    { newAuthType }: { newAuthType: "None" | "Bearer" }
  ) {
    return {
      request: {
        ...curr.request,
        auth: {
          ...curr.request.auth,
          authType: newAuthType,
        },
      },
    }
  },
  setBearerToken(
    curr: HoppSIOSession,
    { newBearerToken }: { newBearerToken: string }
  ) {
    return {
      request: {
        ...curr.request,
        auth: {
          ...curr.request.auth,
          bearerToken: newBearerToken,
        },
      },
    }
  },
  setAuthActive(
    curr: HoppSIOSession,
    { newAuthActive }: { newAuthActive: boolean }
  ) {
    return {
      request: {
        ...curr.request,
        auth: {
          ...curr.request.auth,
          authActive: newAuthActive,
        },
      },
    }
  },
  setSocket(_: HoppSIOSession, { socket }: { socket: SIOConnection }) {
    return {
      socket,
    }
  },
  setLog(_: HoppSIOSession, { log }: { log: HoppRealtimeLog }) {
    return {
      log,
    }
  },
  addLogLine(curr: HoppSIOSession, { line }: { line: HoppRealtimeLogLine }) {
    return {
      log: [...curr.log, line],
    }
  },
})

const SIOSessionStore = new DispatchingStore(defaultSIOSession, dispatchers)

export function setSIORequest(newRequest?: HoppSIORequest) {
  SIOSessionStore.dispatch({
    dispatcher: "setRequest",
    payload: {
      newRequest: newRequest ?? defaultSIORequest,
    },
  })
}

export function setSIOEndpoint(newEndpoint: string) {
  SIOSessionStore.dispatch({
    dispatcher: "setEndpoint",
    payload: {
      newEndpoint,
    },
  })
}

export function setSIOVersion(newVersion: SIOClientVersion) {
  SIOSessionStore.dispatch({
    dispatcher: "setVersion",
    payload: {
      newVersion,
    },
  })
}

export function setSIOPath(newPath: string) {
  SIOSessionStore.dispatch({
    dispatcher: "setPath",
    payload: {
      newPath,
    },
  })
}

export function setSIOAuth(newAuth: HoppSIOAuth) {
  SIOSessionStore.dispatch({
    dispatcher: "setAuth",
    payload: {
      newAuth,
    },
  })
}

export function setSIOAuthType(newAuthType: "None" | "Bearer") {
  SIOSessionStore.dispatch({
    dispatcher: "setAuthType",
    payload: {
      newAuthType,
    },
  })
}

export function setSIOBearerToken(newBearerToken: string) {
  SIOSessionStore.dispatch({
    dispatcher: "setBearerToken",
    payload: {
      newBearerToken,
    },
  })
}

export function setSIOAuthActive(newAuthActive: boolean) {
  SIOSessionStore.dispatch({
    dispatcher: "setAuthActive",
    payload: {
      newAuthActive,
    },
  })
}

export function setSIOSocket(socket: SIOConnection) {
  SIOSessionStore.dispatch({
    dispatcher: "setSocket",
    payload: {
      socket,
    },
  })
}

export function setSIOLog(log: HoppRealtimeLog) {
  SIOSessionStore.dispatch({
    dispatcher: "setLog",
    payload: {
      log,
    },
  })
}

export function addSIOLogLine(line: HoppRealtimeLogLine) {
  SIOSessionStore.dispatch({
    dispatcher: "addLogLine",
    payload: {
      line,
    },
  })
}

export const SIORequest$ = SIOSessionStore.subject$.pipe(
  pluck("request"),
  distinctUntilChanged()
)

export const SIOEndpoint$ = SIOSessionStore.subject$.pipe(
  pluck("request", "endpoint"),
  distinctUntilChanged()
)

export const SIOVersion$ = SIOSessionStore.subject$.pipe(
  pluck("request", "version"),
  distinctUntilChanged()
)

export const SIOPath$ = SIOSessionStore.subject$.pipe(
  pluck("request", "path"),
  distinctUntilChanged()
)

export const SIOAuth$ = SIOSessionStore.subject$.pipe(
  pluck("request", "auth"),
  distinctUntilChanged()
)

export const SIOAuthType$ = SIOSessionStore.subject$.pipe(
  pluck("request", "auth", "authType"),
  distinctUntilChanged()
)

export const SIOBearerToken$ = SIOSessionStore.subject$.pipe(
  pluck("request", "auth", "bearerToken"),
  distinctUntilChanged()
)

export const SIOAuthActive$ = SIOSessionStore.subject$.pipe(
  pluck("request", "auth", "authActive"),
  distinctUntilChanged()
)

export const SIOConnectionState$ = SIOSessionStore.subject$.pipe(
  pluck("connectionState"),
  distinctUntilChanged()
)

export const SIOSocket$ = SIOSessionStore.subject$.pipe(
  pluck("socket"),
  distinctUntilChanged()
)

export const SIOLog$ = SIOSessionStore.subject$.pipe(
  pluck("log"),
  distinctUntilChanged()
)
