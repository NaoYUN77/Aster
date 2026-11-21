import { handleRequest } from "./handler";
import type { Env } from "./types";

// Worker entrypoint. The runtime treats every non-handler export as an entrypoint, so this module
// exports only the Durable Object class and the default handler.
export { Vault } from "./durable";

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};
