import { createApi } from "@convex-dev/better-auth";
import schema from "./schema";
import { schemaOptions } from "./options";

export const {
  create,
  findOne,
  findMany,
  updateOne,
  updateMany,
  deleteOne,
  deleteMany,
} = createApi(schema, () => schemaOptions);
