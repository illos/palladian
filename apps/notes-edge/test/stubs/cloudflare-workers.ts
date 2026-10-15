// Node stand-in for the workerd-only `cloudflare:workers` module. The OAuth
// provider imports WorkerEntrypoint only to recognise class-based handlers;
// this Worker uses object handlers.
export class WorkerEntrypoint {}
