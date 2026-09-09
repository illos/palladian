// This non-sensitive preference is the only P0 persistent browser state.
try {
  const choice = localStorage.getItem("palladian.theme");
  document.documentElement.dataset.theme =
    choice === "light" || choice === "dark" ? choice : "system";
} catch {
  document.documentElement.dataset.theme = "system";
}
