// The Worker's upload path (apps/notes-edge/src/files.ts), for tests that
// run it against the real backend functions in convex-test. Plain JS so the
// Worker's sources are not type-checked under the backend's settings.
export { storeObject } from "../../notes-edge/src/files.ts";
