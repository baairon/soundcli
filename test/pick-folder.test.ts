import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFile } from "node:child_process";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const execFileMock = vi.mocked(execFile);

describe("pickFolder", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("uses STA PowerShell on Windows so the dialog does not hang", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32" });

    execFileMock.mockImplementation(
      (_cmd, args, _opts, cb) => {
        (cb as Function)(null, "C:\\Music\r\n");
        return undefined as never;
      },
    );

    const { pickFolder } = await import("../src/util/pick-folder");
    await expect(pickFolder("C:\\Music")).resolves.toBe("C:\\Music");
    expect(execFileMock).toHaveBeenCalledWith(
      "powershell",
      expect.arrayContaining(["-STA", "-NoProfile", "-Command"]),
      expect.any(Object),
      expect.any(Function),
    );

    if (platform) Object.defineProperty(process, "platform", platform);
  });
});
