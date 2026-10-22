import { describe, expect, test } from "vitest";
import {
  changed,
  diffText,
  type DiffPart,
  type TextDiff,
} from "../../src/text-diff";

/** The text before (equal and removed parts) and after (equal and added). */
function sides(diff: TextDiff) {
  const side = (keep: DiffPart["op"]) =>
    diff.parts
      .filter((part) => part.op === "equal" || part.op === keep)
      .map((part) => part.text)
      .join("");
  return { before: side("delete"), after: side("insert") };
}

function expectWellFormed(diff: TextDiff, before: string, after: string) {
  expect(sides(diff)).toEqual({ before, after });
  for (let i = 1; i < diff.parts.length; i++)
    expect(diff.parts[i]!.op).not.toBe(diff.parts[i - 1]!.op);
  for (const part of diff.parts) expect(part.text).not.toBe("");
}

/** A small deterministic generator, so failures reproduce. */
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

describe("diffText", () => {
  test("identical texts are one equal part, and empty texts none", () => {
    expect(diffText("Same words", "Same words")).toEqual({
      parts: [{ op: "equal", text: "Same words" }],
      detail: "word",
    });
    expect(diffText("", "")).toEqual({ parts: [], detail: "word" });
    expect(changed(diffText("a b", "a b"))).toBe(false);
  });

  test("compares whole words, as Deltos did", () => {
    const diff = diffText("the quick brown fox", "the slow brown fox");
    expect(diff.detail).toBe("word");
    expect(diff.parts).toEqual([
      { op: "equal", text: "the " },
      { op: "delete", text: "quick" },
      { op: "insert", text: "slow" },
      { op: "equal", text: " brown fox" },
    ]);
    expect(changed(diff)).toBe(true);
  });

  test("additions, removals and line breaks", () => {
    expect(diffText("Title\nOne", "Title\nOne two").parts).toEqual([
      { op: "equal", text: "Title\nOne" },
      { op: "insert", text: " two" },
    ]);
    expect(diffText("Title\nOne two three", "Title\nOne three").parts).toEqual([
      { op: "equal", text: "Title\nOne " },
      { op: "delete", text: "two " },
      { op: "equal", text: "three" },
    ]);
    expect(diffText("", "New note").parts).toEqual([
      { op: "insert", text: "New note" },
    ]);
    expect(diffText("Gone", "").parts).toEqual([
      { op: "delete", text: "Gone" },
    ]);
    expectWellFormed(
      diffText("a\nb\nc", "a\n\nb c\n"),
      "a\nb\nc",
      "a\n\nb c\n",
    );
  });

  test("scattered edits keep the words in common", () => {
    const before = "one two three four five six seven";
    const after = "one 2 three four five 6 seven eight";
    const diff = diffText(before, after);
    expectWellFormed(diff, before, after);
    const kept = diff.parts
      .filter((part) => part.op === "equal")
      .map((part) => part.text)
      .join("");
    expect(kept).toBe("one  three four five  seven");
  });

  test("random edits always reproduce both texts", () => {
    const next = random(7);
    const vocabulary = ["a", "b", "c", "dd", " ", "\n", "  ", "é", "🙂"];
    const text = (length: number) =>
      Array.from(
        { length },
        () => vocabulary[Math.floor(next() * vocabulary.length)]!,
      ).join("");
    for (let round = 0; round < 300; round++) {
      const before = text(Math.floor(next() * 40));
      const after = text(Math.floor(next() * 40));
      expectWellFormed(diffText(before, after), before, after);
      // The coarser comparisons hold to the same contract.
      expectWellFormed(diffText(before, after, 40), before, after);
      expectWellFormed(diffText(before, after, 1), before, after);
    }
  });

  test("a large changed region falls back to lines, then to one block", () => {
    const before = "Shopping\nmilk eggs\nbread\nbutter jam\nend";
    const after = "Shopping\nmilk cheese\nbread\nbutter honey\nend";
    // Word by word the changed region spans 2 lines; force the fallback.
    const lines = diffText(before, after, 20);
    expect(lines.detail).toBe("line");
    expect(lines.parts).toEqual([
      { op: "equal", text: "Shopping\n" },
      { op: "delete", text: "milk eggs\n" },
      { op: "insert", text: "milk cheese\n" },
      { op: "equal", text: "bread\n" },
      { op: "delete", text: "butter jam\n" },
      { op: "insert", text: "butter honey\n" },
      { op: "equal", text: "end" },
    ]);
    const block = diffText(before, after, 1);
    expect(block.detail).toBe("block");
    expect(block.parts).toEqual([
      { op: "equal", text: "Shopping\n" },
      { op: "delete", text: "milk eggs\nbread\nbutter jam\n" },
      { op: "insert", text: "milk cheese\nbread\nbutter honey\n" },
      { op: "equal", text: "end" },
    ]);
  });

  test("a small edit in a long note stays word by word and fast", () => {
    const paragraphs = Array.from(
      { length: 20_000 },
      (_, i) => `Paragraph ${i} has a few words in it.`,
    );
    const before = paragraphs.join("\n");
    paragraphs[10_000] = "Paragraph 10000 has a few changed words in it.";
    const after = paragraphs.join("\n");
    const started = performance.now();
    const diff = diffText(before, after);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(diff.detail).toBe("word");
    expect(diff.parts.filter((part) => part.op !== "equal")).toEqual([
      { op: "insert", text: "changed " },
    ]);
  });

  test("two long, entirely different notes do not hang", () => {
    const next = random(11);
    const note = (prefix: string) =>
      Array.from(
        { length: 6_000 },
        (_, i) =>
          `${prefix}${i} ${Math.floor(next() * 1e6)}${i % 8 === 0 ? "\n" : ""}`,
      ).join(" ");
    const before = note("x");
    const after = note("y");
    const started = performance.now();
    const diff = diffText(before, after);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(diff.detail).not.toBe("word");
    expectWellFormed(diff, before, after);
  });
});
