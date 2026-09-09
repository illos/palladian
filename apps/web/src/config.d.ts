declare const __PALLADIAN_CONFIG__: Readonly<{
  dataUrl: string;
  authUrl: string;
}>;
// Vite processes these side-effect stylesheet imports; no CSS values are exported.
declare module "*.css" {}
