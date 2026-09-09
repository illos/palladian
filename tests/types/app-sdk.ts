import type { ComponentProps } from "react";
import type {
  AppDefinition,
  AppHostProps,
  AppUIModule,
} from "../../packages/app-sdk/src/index";
import type { AppInstance } from "../../packages/contracts/src/index";
import {
  Root as NotesRoot,
  Preview as NotesPreview,
} from "../../apps/web/src/apps/notes/entry";
import {
  Root as RecipesRoot,
  Preview as RecipesPreview,
} from "../../apps/web/src/apps/recipes/entry";

// Checked by the production strict compiler. No error suppressions or casts.
export const notesLoader: AppDefinition<"notes">["loadUI"] = async () => ({
  Root: NotesRoot,
  Preview: NotesPreview,
});
export const recipesLoader: AppDefinition<"recipes">["loadUI"] = async () => ({
  Root: RecipesRoot,
  Preview: RecipesPreview,
});

type AssertTrue<T extends true> = T;
type AssertFalse<T extends false> = T;
type Assignable<From, To> = [From] extends [To] ? true : false;

export type NotesPropsMatch = AssertTrue<
  Assignable<AppHostProps<"notes">, ComponentProps<typeof NotesRoot>>
>;
export type RecipesPropsMatch = AssertTrue<
  Assignable<AppHostProps<"recipes">, ComponentProps<typeof RecipesRoot>>
>;
export type NotesRejectRecipesInstance = AssertFalse<
  Assignable<
    AppInstance<"recipes">,
    ComponentProps<typeof NotesRoot>["instance"]
  >
>;
export type RecipesRejectNotesInstance = AssertFalse<
  Assignable<
    AppInstance<"notes">,
    ComponentProps<typeof RecipesRoot>["instance"]
  >
>;
export type NotesRejectRecipesRoot = AssertFalse<
  Assignable<typeof RecipesRoot, AppUIModule<"notes">["Root"]>
>;
export type RecipesRejectNotesRoot = AssertFalse<
  Assignable<typeof NotesRoot, AppUIModule<"recipes">["Root"]>
>;
export type NotesRejectRecipesLoader = AssertFalse<
  Assignable<typeof recipesLoader, AppDefinition<"notes">["loadUI"]>
>;
export type RecipesRejectNotesLoader = AssertFalse<
  Assignable<typeof notesLoader, AppDefinition<"recipes">["loadUI"]>
>;
