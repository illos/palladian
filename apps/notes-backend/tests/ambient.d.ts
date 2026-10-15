// Better Auth's declarations mention Bun-only names; tests run under Vite types
// instead of Bun's, which conflict with vite/client. These shims cover only those names.
declare module "bun:sqlite" {
  export class Database {}
}
declare type Timer = ReturnType<typeof setTimeout>;
