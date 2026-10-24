declare const __NOTES_DEV__: boolean;
declare const __NOTES_AUTH_SITE_URL__: string | null;
declare const __NOTES_CONVEX_URL__: string | null;
declare const __NOTES_VERSION__: { commit: string; date: string | null };

declare module "*.css" {}

/** A file Vite serves as is, by its URL (the pdf.js worker, B4). */
declare module "*?url" {
  const url: string;
  export default url;
}
