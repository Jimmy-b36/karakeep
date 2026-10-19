// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { READER_DEFAULTS } from "@karakeep/shared/types/readers";

import ReaderSettingsPopover from "../dashboard/preview/ReaderSettingsPopover";
import { TooltipProvider } from "../ui/tooltip";
import ReaderSettings from "./ReaderSettings";

const mocks = vi.hoisted(() => ({
  updateSession: vi.fn(),
  updateServerSetting: vi.fn(),
  clearLocalOverride: vi.fn(),
  saveToDevice: vi.fn(),
  saveToServer: vi.fn(),
  settings: {
    fontSize: 18,
    lineHeight: 1.6,
    fontFamily: "serif",
    speechHighlightColor: "#facc15",
  },
  localOverrides: {} as { speechHighlightColor?: string },
}));

vi.mock("@/lib/i18n/client", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/lib/clientConfig", () => ({
  useClientConfig: () => ({ demoMode: false }),
}));
vi.mock("@/lib/readerSettings", () => ({
  useReaderSettings: () => ({
    ...mocks,
    settings: mocks.settings,
    serverSettings: {},
    sessionOverrides: {},
    hasSessionChanges: true,
    hasLocalOverrides: !!mocks.localOverrides.speechHighlightColor,
    isSaving: false,
  }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
  vi.clearAllMocks();
  mocks.settings.speechHighlightColor = READER_DEFAULTS.speechHighlightColor;
  mocks.localOverrides = {};
});

const label = "settings.info.reader_settings.speech_highlight_color";

describe("read-aloud highlight color settings", () => {
  it("previews a chosen color and exposes device/global save actions", () => {
    render(
      <TooltipProvider>
        <ReaderSettingsPopover open />
      </TooltipProvider>,
    );
    const picker = screen.getByLabelText<HTMLInputElement>(label);
    expect(picker.value).toBe("#facc15");
    fireEvent.change(picker, { target: { value: "#60a5fa" } });
    expect(mocks.updateSession).toHaveBeenCalledWith({
      speechHighlightColor: "#60a5fa",
    });
    fireEvent.click(
      screen.getByText("settings.info.reader_settings.save_to_device"),
    );
    expect(mocks.saveToDevice).toHaveBeenCalled();
    fireEvent.click(
      screen.getByText("settings.info.reader_settings.save_to_all_devices"),
    );
    expect(mocks.saveToServer).toHaveBeenCalled();
  });

  it("allows clearing a device-specific color override", () => {
    mocks.localOverrides = { speechHighlightColor: "#60a5fa" };
    render(
      <TooltipProvider>
        <ReaderSettingsPopover open />
      </TooltipProvider>,
    );
    fireEvent.click(
      screen.getByLabelText(
        "settings.info.reader_settings.clear_override_hint",
      ),
    );
    expect(mocks.clearLocalOverride).toHaveBeenCalledWith(
      "speechHighlightColor",
    );
  });

  it("saves the color from the main reader settings menu", () => {
    render(<ReaderSettings />);
    fireEvent.click(screen.getByText("settings.info.reader_settings.title"));
    fireEvent.change(screen.getByLabelText(label), {
      target: { value: "#60a5fa" },
    });
    expect(mocks.updateServerSetting).toHaveBeenCalledWith({
      speechHighlightColor: "#60a5fa",
    });
  });
});
