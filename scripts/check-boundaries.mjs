import { parse } from "@babel/parser";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
export function violations(file, source) {
  const errors = [];
  const normalized = file.replaceAll("\\", "/");
  const ast = parse(source, {
    sourceType: "module",
    plugins: ["typescript", "jsx"],
  });
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "TSAnyKeyword") errors.push("Explicit any is forbidden");
    let spec;
    if (
      node.type === "ImportDeclaration" ||
      node.type === "ExportNamedDeclaration" ||
      node.type === "ExportAllDeclaration"
    )
      spec = node.source?.value;
    if (node.type === "ImportExpression") {
      if (node.source.type !== "StringLiteral")
        errors.push("Dynamic import must use a fixed build-time path");
      else spec = node.source.value;
    }
    if (node.type === "CallExpression" && node.callee?.name === "require")
      errors.push("Use static ESM imports");
    if (typeof spec === "string") {
      const target = spec.startsWith(".")
        ? path.posix.normalize(
            path.posix.join(path.posix.dirname(normalized), spec),
          )
        : spec;
      const client =
        normalized.startsWith("apps/web/src/") ||
        normalized.startsWith("packages/");
      if (
        client &&
        /(^|\/)convex(\/|$)|(^|\/)spikes\/|(^|\/)infra\/|^node:|better-auth\/(minimal|plugins)|@convex-dev\/better-auth(\/|$)/.test(
          target,
        )
      )
        errors.push(`Server dependency in client-safe source: ${spec}`);
      if (
        normalized.startsWith("packages/") &&
        !target.startsWith("packages/") &&
        spec !== "react"
      )
        errors.push(`Shared package depends outside its boundary: ${spec}`);
      const app = normalized.match(/^apps\/web\/src\/apps\/([^/]+)\//)?.[1];
      if (
        app &&
        target.startsWith("apps/web/src/") &&
        !target.startsWith(`apps/web/src/apps/${app}/`)
      )
        errors.push(`App imports host or sibling internals: ${spec}`);
      if (
        !app &&
        target.startsWith("apps/web/src/apps/") &&
        node.type !== "ImportExpression"
      )
        errors.push(`App entry must be lazy: ${spec}`);
    }
    for (const [key, value] of Object.entries(node))
      if (key !== "loc" && key !== "comments") {
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === "object") visit(value);
      }
  }
  visit(ast.program);
  if (/@ts-(ignore|nocheck)/.test(source))
    errors.push("Typecheck suppression is forbidden");
  return [...new Set(errors)];
}
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(`${dir}/${e.name}`) : [`${dir}/${e.name}`],
  );
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = [];
  for (const file of [...files("apps/web/src"), ...files("packages")]) {
    if (/\.(ts|tsx)$/.test(file))
      errors.push(
        ...violations(file, readFileSync(file, "utf8")).map(
          (e) => `${file}: ${e}`,
        ),
      );
    if (
      file.startsWith("apps/web/src/apps/") &&
      file.endsWith(".css") &&
      !file.endsWith(".module.css")
    )
      errors.push(`${file}: App styles must use CSS modules`);
  }
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else
    console.log(
      "PASS client/server, shared-package, app isolation, literal lazy imports, and type-safety boundaries",
    );
}
