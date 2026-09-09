import type { RegisteredDefinition } from "../../../packages/app-sdk/src/index";
export const definitions = [
  {
    id: "notes",
    contractVersion: 1,
    name: "Notes",
    description: "A place for thoughts, ideas, and things to remember.",
    icon: "note",
    resourceTypes: ["note"],
    capabilities: ["files", "search", "voice", "deck"],
    loadUI: () => import("./apps/notes/entry"),
  },
  {
    id: "recipes",
    contractVersion: 1,
    name: "Recipes",
    description: "Your own collection of good things to make.",
    icon: "recipe",
    resourceTypes: ["recipe"],
    capabilities: ["files", "search", "schedules"],
    loadUI: () => import("./apps/recipes/entry"),
  },
] as const satisfies readonly RegisteredDefinition[];
