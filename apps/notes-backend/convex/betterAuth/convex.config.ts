import { defineComponent } from "convex/server";

// Installed locally so the passkey table can live beside the default auth
// tables. The name must stay "betterAuth": existing accounts live under it.
const component = defineComponent("betterAuth");
export default component;
