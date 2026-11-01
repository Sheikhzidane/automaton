/**
 * Token counting must stay fast on pathological input.
 *
 * js-tiktoken's cl100k BPE is quadratic in the length of a run of one
 * repeated character (16,000 'x' took 24 s before the fix), so a long
 * blob in a tool result or input froze the agent loop.
 */

import { describe, it, expect } from "vitest";
import { getEncoding } from "js-tiktoken";
import { createTokenCounter, countTokensBounded } from "../memory/context-manager.js";
import { estimateTokens } from "../agent/context.js";

const enc = getEncoding("cl100k_base");

function timed<T>(fn: () => T): { value: T; ms: number } {
  const t0 = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t0 };
}

describe("token counting bounds", () => {
  it("counts a long run of one character quickly and conservatively", () => {
    const counter = createTokenCounter();
    const { value, ms } = timed(() => counter.countTokens("x".repeat(16_000)));
    expect(ms).toBeLessThan(2_000);
    expect(value).toBeGreaterThanOrEqual(16_000 / 8);
  });

  it("does not stall on half a megabyte of repeated characters or spaces", () => {
    const { value: x, ms: msX } = timed(() => estimateTokens("x".repeat(500_000)));
    const { value: sp, ms: msSp } = timed(() => estimateTokens(" ".repeat(500_000)));
    expect(msX).toBeLessThan(1_000);
    expect(msSp).toBeLessThan(1_000);
    expect(x).toBeGreaterThanOrEqual(500_000 / 4);
    expect(sp).toBeGreaterThanOrEqual(500_000 / 4);
  });

  it("gives the exact count for ordinary text", () => {
    const prose = "The fridge in the cellar read 4.2C at 09:10; Sam signed the opening checks. ".repeat(40);
    expect(countTokensBounded(enc, prose)).toBe(enc.encode(prose).length);
  });

  it("gives the exact count when a moderate run sits inside text", () => {
    const text = `before the blob ${"x".repeat(1_024)} after the blob ${"=".repeat(200)} end`;
    expect(countTokensBounded(enc, text)).toBe(enc.encode(text).length);
  });

  it("does not cache very long texts under their full text", () => {
    const counter = createTokenCounter();
    counter.countTokens("y".repeat(40_000));
    expect([...counter.cache.keys()].some((k) => k.length > 32_000)).toBe(false);
  });
});
