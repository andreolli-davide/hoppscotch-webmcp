import { HoppModule } from "."
import { getService } from "~/modules/dioc"
import { WebMCPService } from "~/services/webmcp/service"

let service: WebMCPService | null = null

export default <HoppModule>{
  onRouterInit(_app, router) {
    service = getService(WebMCPService)
    void service.start(router)
  },
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => service?.stop())
}
