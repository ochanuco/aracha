import { handleApi } from "./api";
import { handleProjectionBatch, type ProjectionMessage } from "./projection/consumer";

export { DocumentDO } from "./do/document";
export { OperationCoordinatorDO } from "./do/coordinator";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/api/health") {
      return Response.json({ ok: true });
    }
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env);
    }
    return env.ASSETS.fetch(request);
  },

  async queue(batch, env): Promise<void> {
    await handleProjectionBatch(batch as MessageBatch<ProjectionMessage>, env);
  },
} satisfies ExportedHandler<Env>;
