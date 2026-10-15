#!/usr/bin/env bash
# Build the notes app for production and deploy the palladian Worker.
# Run from a pushed commit on main with Cloudflare credentials in the
# environment (presidium-env -- apps/notes-edge/scripts/deploy.sh).
set -euo pipefail
cd "$(dirname "$0")/../../.."
export VITE_NOTES_AUTH_SITE_URL=https://adamant-hound-861.convex.site
export VITE_NOTES_CONVEX_URL=https://adamant-hound-861.convex.cloud
pnpm --filter @palladian/notes build
cd apps/notes-edge
npx wrangler deploy
