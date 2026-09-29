import { defineApp } from "convex/server";
import betterAuth from "@convex-dev/better-auth/convex.config";
import prosemirrorSync from "@convex-dev/prosemirror-sync/convex.config.js";
const app = defineApp();
app.use(betterAuth);
app.use(prosemirrorSync);
export default app;
