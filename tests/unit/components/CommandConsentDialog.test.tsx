import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { CommandConsentDialog } from "@/components/execution/CommandConsentDialog";
import { useCommandConsentStore } from "@/store/commandConsentStore";

const ask = (command: string) =>
  useCommandConsentStore.getState().request({ runId: "run-1", agentName: "Test Runner", command, workspacePath: "D:/ws" });

beforeEach(() => useCommandConsentStore.setState({ queue: [] }));

describe("CommandConsentDialog", () => {
  it("renders nothing while no command is waiting", () => {
    const { container } = render(<CommandConsentDialog />);
    expect(container.innerHTML).toBe("");
  });

  it("shows the waiting command, who asks and where it runs, and runs it on Allow", async () => {
    render(<CommandConsentDialog />);
    let answer!: Promise<string>;
    act(() => { answer = ask("npm test -- --run"); });

    expect(screen.getByRole("alertdialog").textContent).toContain("Test Runner");
    expect(screen.getByText("npm test -- --run")).toBeTruthy();
    expect(screen.getByRole("alertdialog").textContent).toContain("D:/ws");

    act(() => { fireEvent.click(screen.getByRole("button", { name: "Allow" })); });

    await expect(answer).resolves.toBe("allow");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("denies with the Deny button or Escape, one command at a time", async () => {
    render(<CommandConsentDialog />);
    let first!: Promise<string>;
    let second!: Promise<string>;
    act(() => { first = ask("npm test"); second = ask("cargo test"); });
    expect(screen.getByRole("alertdialog").textContent).toContain("1 more waiting");

    act(() => { fireEvent.click(screen.getByRole("button", { name: "Deny" })); });
    await expect(first).resolves.toBe("deny");
    expect(screen.getByText("cargo test")).toBeTruthy();

    act(() => { fireEvent.keyDown(window, { key: "Escape" }); });
    await expect(second).resolves.toBe("deny");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
