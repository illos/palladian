import type { AppHostProps } from "../../../../../packages/app-sdk/src/index";
export function Root(_props: AppHostProps) {
  return <Preview />;
}
export function Preview() {
  return (
    <section aria-labelledby="notes-title">
      <p className="eyebrow">App preview · P0</p>
      <h2 id="notes-title">Room for your next idea.</h2>
      <p>
        This is the empty Notes entry. Editing, collaboration, and saved notes
        arrive in a later phase.
      </p>
      <p>No instance has been created and no data is stored.</p>
    </section>
  );
}
