// The MCP SDK's published declarations name Node's `Buffer` type (for its stdio
// reader, which this Worker never uses). Workers types declare `Buffer` only as
// a value and conflict with @types/node, so give the name a structural type.
type Buffer = Uint8Array;
