import { handle } from './http';
import type { GatewayEnv } from './protection';

export default {
  fetch(request, env) { return handle(request, env); },
} satisfies ExportedHandler<GatewayEnv>;
