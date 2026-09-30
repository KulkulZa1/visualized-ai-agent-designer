import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockInvokeHandler } from "@/ipc/mockTauri";
import { SettingsPanel } from "@/components/layout/SettingsPanel";
import { useExecutionStore } from "@/store/executionStore";

beforeEach(() => {
  localStorage.clear();
  useExecutionStore.setState({
    llmProvider: "auto", ollamaBaseUrl: "http://localhost:11434", ollamaModel: "qwen2.5-coder:7b",
    apiKey: "", openaiApiKey: "", ollamaApiKey: "",
    customApiUrl: "", customApiKey: "", customApiModel: "",
    ollamaNumCtx: 16384, requestTimeoutSecs: 600,
  });
});

const saveAll = () => screen.getByRole("button", { name: /Save all/ });
const contextWindow = () => screen.getByLabelText(/Ollama context window/) as HTMLInputElement;
const callTimeout = () => screen.getByLabelText(/Model call timeout/) as HTMLInputElement;

describe("SettingsPanel: Ollama's context window", () => {
  it("shows the window the store has, 16384 tokens to start with", () => {
    render(<SettingsPanel onClose={() => {}} />);

    expect(contextWindow().value).toBe("16384");
  });

  it("says that it is sent to Ollama as num_ctx, overrides the server's own default, and that 0 uses the server default", () => {
    render(<SettingsPanel onClose={() => {}} />);

    const label = contextWindow().labels?.[0]?.textContent ?? "";
    expect(label).toContain("sent to Ollama as num_ctx");
    expect(label).toContain("overrides the server's own default");
    expect(label).toContain("OLLAMA_CONTEXT_LENGTH");
    expect(label).toContain("0 uses the server default");
  });

  it("saves a new window with Save all & close", () => {
    const onClose = vi.fn();
    render(<SettingsPanel onClose={onClose} />);

    fireEvent.change(contextWindow(), { target: { value: "32768" } });
    fireEvent.click(saveAll());

    expect(useExecutionStore.getState().ollamaNumCtx).toBe(32768);
    expect(localStorage.getItem("harness_ollama_num_ctx")).toBe("32768");
    expect(onClose).toHaveBeenCalled();
  });

  it("saves 0: no num_ctx is sent, and the server's own default stands", () => {
    render(<SettingsPanel onClose={() => {}} />);

    fireEvent.change(contextWindow(), { target: { value: "0" } });
    fireEvent.click(saveAll());

    expect(useExecutionStore.getState().ollamaNumCtx).toBe(0);
  });

  it("does not save a value that is not a whole number of tokens: it says so, and Save is off", () => {
    const onClose = vi.fn();
    render(<SettingsPanel onClose={onClose} />);

    for (const bad of ["-5", "1.5", ""]) {
      fireEvent.change(contextWindow(), { target: { value: bad } });

      expect(screen.getByText("Enter a whole number of tokens, 0 or more.")).toBeTruthy();
      expect(screen.getByText("Fix the highlighted number to save.")).toBeTruthy();
      expect((saveAll() as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(saveAll());
    }
    expect(onClose).not.toHaveBeenCalled();
    expect(useExecutionStore.getState().ollamaNumCtx).toBe(16384);

    fireEvent.change(contextWindow(), { target: { value: "8192" } });
    expect((saveAll() as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText("Fix the highlighted number to save.")).toBeNull();
  });
});

describe("SettingsPanel: the model call timeout", () => {
  it("shows 600 seconds to start with, and saves a new value", () => {
    const onClose = vi.fn();
    render(<SettingsPanel onClose={onClose} />);
    expect(callTimeout().value).toBe("600");

    fireEvent.change(callTimeout(), { target: { value: "3600" } });
    fireEvent.click(saveAll());

    expect(useExecutionStore.getState().requestTimeoutSecs).toBe(3600);
    expect(localStorage.getItem("harness_request_timeout_secs")).toBe("3600");
    expect(onClose).toHaveBeenCalled();
  });

  it("does not save seconds outside 30 to 86400", () => {
    render(<SettingsPanel onClose={() => {}} />);

    for (const bad of ["29", "86401", "0", ""]) {
      fireEvent.change(callTimeout(), { target: { value: bad } });

      expect(screen.getByText("Enter whole seconds from 30 to 86400.")).toBeTruthy();
      expect((saveAll() as HTMLButtonElement).disabled).toBe(true);
    }
    fireEvent.change(callTimeout(), { target: { value: "30" } });
    expect((saveAll() as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("SettingsPanel: the Custom endpoint's model", () => {
  const customModelField = () => screen.getByPlaceholderText(/the model your server serves/) as HTMLInputElement;

  it("starts with no model name, and names no hosted model as an example of one", () => {
    render(<SettingsPanel onClose={() => {}} />);

    expect(customModelField().value).toBe("");
    expect(customModelField().placeholder).not.toMatch(/gpt/i);
  });

  it("keeps a blank model name blank on Save all & close and on the endpoint's own Save", () => {
    useExecutionStore.setState({ customApiUrl: "http://localhost:8080/v1" });
    render(<SettingsPanel onClose={() => {}} />);

    fireEvent.click(screen.getAllByRole("button", { name: "Save" }).at(-1)!);
    expect(useExecutionStore.getState().customApiModel).toBe("");

    fireEvent.click(saveAll());
    expect(useExecutionStore.getState().customApiModel).toBe("");
  });

  it("saves the model name that was typed, trimmed", () => {
    render(<SettingsPanel onClose={() => {}} />);

    fireEvent.change(customModelField(), { target: { value: "  llama3.1:8b " } });
    fireEvent.click(saveAll());

    expect(useExecutionStore.getState().customApiModel).toBe("llama3.1:8b");
  });

  it("shows what the backend says when Test connection has no model to ask for, and asks for none itself", async () => {
    useExecutionStore.setState({ customApiUrl: "http://localhost:8080/v1" });
    const message = "No model name is set, so there is nothing to test. Enter the model name your server serves, " +
      "or click ↻ Models to list the models it has.";
    const probes: Array<Record<string, unknown>> = [];
    mockInvokeHandler("check_provider_health", (args) => {
      probes.push(args as Record<string, unknown>);
      return { ok: false, provider: "openai-compatible", latency_ms: 0, message, model_available: false, pull_command: null };
    });
    render(<SettingsPanel onClose={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /Test connection/ }));

    expect((await screen.findAllByText(new RegExp(`✕ ${message.slice(0, 40)}`))).length).toBeGreaterThan(0);
    expect(probes).toHaveLength(1);
    expect(probes[0]).toMatchObject({ provider: "openai-compatible", baseUrl: "http://localhost:8080/v1", model: "" });
    // The button the message points to sits beside Test connection, with the label it names.
    const row = screen.getByRole("button", { name: /Test connection/ }).parentElement!;
    expect(within(row).getByRole("button", { name: "↻ Models" })).toBeTruthy();
  });
});
