/**
 * Compile-time contract between the Worker's function references
 * (`src/convex-api.ts`) and the generated `api`: the same function kind, the
 * Worker's arguments are accepted by the backend, and the backend's return
 * type fits what the Worker reads. Checked by `pnpm typecheck` with the
 * backend's compiler settings, so a backend change that breaks the Worker
 * fails the typecheck.
 */
import type {
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
  FunctionType,
} from "convex/server";
import type { api } from "../../notes-backend/convex/_generated/api.js";
import type { fns } from "../src/convex-api.ts";

type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Fits<A, B> = [A] extends [B] ? true : false;
/** [same kind, Worker arguments accepted, backend result readable] */
type Parts<
  Generated extends FunctionReference<FunctionType, "public">,
  Local extends FunctionReference<FunctionType, "public">,
> = [
  Mutual<Generated["_type"], Local["_type"]>,
  Fits<FunctionArgs<Local>, FunctionArgs<Generated>>,
  Fits<FunctionReturnType<Generated>, FunctionReturnType<Local>>,
];
type Ok = [true, true, true];
const same = <
  G extends FunctionReference<FunctionType, "public">,
  L extends FunctionReference<FunctionType, "public">,
>(
  parts: Parts<G, L>,
) => parts;
declare const proof: Ok;

export const contract = [
  same<typeof api.connections.redeem, typeof fns.connections.redeem>(proof),
  same<typeof api.library.notebooks, typeof fns.library.notebooks>(proof),
  same<typeof api.library.recent, typeof fns.library.recent>(proof),
  same<typeof api.library.search, typeof fns.library.search>(proof),
  same<typeof api.notes.readMarkdown, typeof fns.notes.readMarkdown>(proof),
  same<
    typeof api.notes.createFromMarkdown,
    typeof fns.notes.createFromMarkdown
  >(proof),
  same<typeof api.notes.edit, typeof fns.notes.edit>(proof),
  same<typeof api.notes.trash, typeof fns.notes.trash>(proof),
  same<typeof api.notes.restore, typeof fns.notes.restore>(proof),
  same<typeof api.notebooks.create, typeof fns.notebooks.create>(proof),
  same<typeof api.history.list, typeof fns.history.list>(proof),
  same<typeof api.history.read, typeof fns.history.read>(proof),
  same<typeof api.history.restore, typeof fns.history.restore>(proof),
];
