import type {
  DefinitionId,
  ResourceType,
} from "../../packages/contracts/src/index";
type Registration<D extends DefinitionId> = {
  readonly id: D;
  readonly resourceTypes: readonly ResourceType<D>[];
  readonly operations: {
    readonly create: `${D}.instance.create`;
    readonly preferences: `${D}.instance.preferences`;
    readonly setPreferences: `${D}.instance.setPreferences`;
  };
};
/** Build-time trusted registrations; never an arbitrary function/table dispatcher. */
export const appDefinitions = {
  notes: {
    id: "notes",
    resourceTypes: ["note"],
    operations: {
      create: "notes.instance.create",
      preferences: "notes.instance.preferences",
      setPreferences: "notes.instance.setPreferences",
    },
  },
  recipes: {
    id: "recipes",
    resourceTypes: ["recipe"],
    operations: {
      create: "recipes.instance.create",
      preferences: "recipes.instance.preferences",
      setPreferences: "recipes.instance.setPreferences",
    },
  },
} as const satisfies { [D in DefinitionId]: Registration<D> };
