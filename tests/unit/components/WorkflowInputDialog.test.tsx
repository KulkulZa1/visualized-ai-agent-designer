import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowInputDialog } from "@/components/execution/WorkflowInputDialog";
import { useExecutionStore } from "@/store/executionStore";

beforeEach(() => {
  useExecutionStore.setState({ llmProvider: "auto" });
});

const start = () => screen.getByRole("button", { name: /Start Workflow/ });

describe("WorkflowInputDialog: the per-run provider override", () => {
  it("offers the Custom endpoint next to the other providers", () => {
    render(<WorkflowInputDialog onStart={() => {}} onCancel={() => {}} />);

    const offered = ["OpenAI", "Anthropic", "Ollama", "Ollama Cloud", "Custom"];
    for (const label of offered) expect(screen.getByRole("button", { name: label }), label).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use Settings (auto)" })).toBeTruthy();
  });

  it("starts the run on the Custom endpoint when it is chosen", () => {
    const onStart = vi.fn();
    render(<WorkflowInputDialog onStart={onStart} onCancel={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    fireEvent.click(start());

    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ providerOverride: "openai-compatible" }));
  });

  it("uses the provider from Settings when nothing is chosen", () => {
    const onStart = vi.fn();
    render(<WorkflowInputDialog onStart={onStart} onCancel={() => {}} />);

    fireEvent.click(start());

    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ providerOverride: null }));
  });

  it("lets the choice go back to Settings after Custom", () => {
    const onStart = vi.fn();
    render(<WorkflowInputDialog onStart={onStart} onCancel={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    fireEvent.click(screen.getByRole("button", { name: "Use Settings (auto)" }));
    fireEvent.click(start());

    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ providerOverride: null }));
  });
});
