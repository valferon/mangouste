import { describe, expect, it } from "vitest";
import { usageFaultOf } from "./usageFault";

describe("usageFaultOf", () => {
  it("keeps the account to sign in when the backend names one", () => {
    expect(usageFaultOf({ message: "work is not signed in.", signIn: "work", retryMs: null })).toEqual({
      message: "work is not signed in.",
      signIn: "work",
      retryMs: null,
    });
  });

  it("offers no sign-in for a fault a sign-in would not fix", () => {
    expect(usageFaultOf({ message: "Rate limited by Anthropic; try again later", signIn: null })).toEqual({
      message: "Rate limited by Anthropic; try again later",
      signIn: null,
      retryMs: null,
    });
  });

  it("takes a bare string as the message", () => {
    // What every other command rejects with, and what this one did before it
    // could say which account.
    expect(usageFaultOf("usage request failed: HTTP 500")).toEqual({
      message: "usage request failed: HTTP 500",
      signIn: null,
      retryMs: null,
    });
  });

  it("reads an Error's message rather than printing the object", () => {
    expect(usageFaultOf(new Error("invoke failed"))).toEqual({
      message: "invoke failed",
      signIn: null,
      retryMs: null,
    });
  });

  it("never offers a sign-in for an account it was not given by name", () => {
    expect(usageFaultOf({ message: "x", signIn: "" }).signIn).toBeNull();
    expect(usageFaultOf({ message: "x", signIn: 3 }).signIn).toBeNull();
    expect(usageFaultOf({ message: "x" }).signIn).toBeNull();
  });

  it("still says something when the rejection has no usable message", () => {
    expect(usageFaultOf({ signIn: "work" })).toEqual({
      message: "usage request failed",
      signIn: "work",
      retryMs: null,
    });
    expect(usageFaultOf(null)).toEqual({ message: "usage request failed", signIn: null, retryMs: null });
    expect(usageFaultOf(undefined).message).toBe("usage request failed");
  });

  it("carries the delay of a fault that clears by itself", () => {
    const fault = usageFaultOf({ message: "Could not renew the sign-in for work.", signIn: null, retryMs: 35000 });
    expect(fault.retryMs).toBe(35000);
    expect(fault.signIn).toBeNull();
  });

  it("books no timer from a delay that is not one", () => {
    // A timer is set straight from this number.
    for (const retryMs of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, "35000", null, undefined]) {
      expect(usageFaultOf({ message: "x", retryMs }).retryMs).toBeNull();
    }
  });
});
