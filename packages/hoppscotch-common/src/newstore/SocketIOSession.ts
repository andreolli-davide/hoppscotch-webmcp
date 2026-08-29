import { pluck, distinctUntilChanged } from "rxjs/operators"
import DispatchingStore, { defineDispatchers } from "./DispatchingStore"
import { SIOConnection } from "~/helpers/realtime/SIOConnection"
import {
  HoppRealtimeLog,
  HoppRealtimeLogLine,
} from "~/helpers/types/HoppRealtimeLog"

export type SIOClientVersion = "v4" | "v3" | "v2"

type HoppSIORequest = {
  endpoint: string
  path: string
  version: SIOClientVersion
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
