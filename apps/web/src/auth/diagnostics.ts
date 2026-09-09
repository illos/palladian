type Code =
  | "resolving"
  | "ready"
  | "temporary"
  | "sign_in_needed"
  | "logout"
  | "account_change";
const events: { code: Code; milliseconds: number }[] = [];
export function record(code: Code) {
  events.push({ code, milliseconds: Math.round(performance.now()) });
  if (events.length > 100) events.shift();
}
export function exportDiagnostics() {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify({ version: 1, events })], {
      type: "application/json",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "palladian-diagnostics.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
