import { httpRouter } from "convex/server";
import { authComponent, createAuth } from "./auth";
const http = httpRouter();
authComponent.registerRoutes(http, (ctx) => createAuth(ctx), { cors: true });
export default http;
