/** Lightweight startup helpers; rich editor code stays in a separate chunk. */
export function textDocument(lines: string[]) {
  return JSON.stringify({
    type: "doc",
    content: lines.map((line) => ({
      type: "paragraph",
      ...(line ? { content: [{ type: "text", text: line }] } : {}),
    })),
  });
}
export function emptyDocument() {
  return textDocument([""]);
}
export function validateCachedDocument(document: string) {
  const value: unknown = JSON.parse(document);
  if (
    typeof value !== "object" ||
    value === null ||
    !("type" in value) ||
    value.type !== "doc" ||
    !("content" in value) ||
    !Array.isArray(value.content)
  )
    throw new Error("Invalid cached document.");
}
export function isPlainDocument(document: string): boolean {
  try {
    const value: unknown = JSON.parse(document);
    if (
      typeof value !== "object" ||
      value === null ||
      !("content" in value) ||
      !Array.isArray(value.content)
    )
      return false;
    return value.content.every((paragraph: unknown) => {
      if (
        typeof paragraph !== "object" ||
        paragraph === null ||
        !("type" in paragraph) ||
        paragraph.type !== "paragraph" ||
        "attrs" in paragraph ||
        "marks" in paragraph
      )
        return false;
      if (!("content" in paragraph)) return true;
      if (!Array.isArray(paragraph.content)) return false;
      return paragraph.content.every(
        (child: unknown) =>
          typeof child === "object" &&
          child !== null &&
          "type" in child &&
          child.type === "text" &&
          "text" in child &&
          typeof child.text === "string" &&
          !("marks" in child),
      );
    });
  } catch {
    return false;
  }
}
