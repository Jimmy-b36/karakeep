// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import FeedsEmptyState from "./FeedsEmptyState";

vi.mock("@/lib/i18n/client", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("FeedsEmptyState", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the no-subscriptions banner with a manage-feeds link", () => {
    render(<FeedsEmptyState hasSubscriptions={false} />);
    expect(screen.getByText("banners.no_subscriptions.title")).toBeTruthy();
    expect(
      screen.getByText("banners.no_subscriptions.description"),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "feeds.manage_feeds" }),
    ).toBeTruthy();
  });

  it("renders the no-articles banner without a manage-feeds link", () => {
    render(<FeedsEmptyState hasSubscriptions={true} />);
    expect(screen.getByText("banners.no_feed_articles.title")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
