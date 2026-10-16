import { describe, expect, it } from "vitest";

import { zReeditAllowPrivateHttp } from "./config";

describe("zReeditAllowPrivateHttp", () => {
  it("accepts Reedit '1'/'0' and Karakeep 'true'/'false'", () => {
    expect(zReeditAllowPrivateHttp.parse("1")).toBe(true);
    expect(zReeditAllowPrivateHttp.parse("true")).toBe(true);
    expect(zReeditAllowPrivateHttp.parse("0")).toBe(false);
    expect(zReeditAllowPrivateHttp.parse("false")).toBe(false);
  });

  it("rejects other values", () => {
    expect(() => zReeditAllowPrivateHttp.parse("yes")).toThrow();
    expect(() => zReeditAllowPrivateHttp.parse("")).toThrow();
  });
});
