import type { AppHostProps } from "../../../../../packages/app-sdk/src/index";
export function Root(_props: AppHostProps) {
  return <Preview />;
}
export function Preview() {
  return (
    <section aria-labelledby="recipes-title">
      <p className="eyebrow">App preview · P0</p>
      <h2 id="recipes-title">Something worth making again.</h2>
      <p>
        This is the empty Recipes entry. Your collection, ingredients, and
        cooking steps arrive in a later phase.
      </p>
      <p>No instance has been created and no data is stored.</p>
    </section>
  );
}
