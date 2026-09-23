import { describe, it, expect, beforeEach } from "vitest";
import { useUIStore } from "@/store/uiStore";

beforeEach(() => {
  useUIStore.setState({ openEditorTabs: [], activeEditorPath: null });
});

describe("uiStore — editor buffers", () => {
  it("keeps a tab's unsaved text and marks it dirty", () => {
    useUIStore.getState().openEditorFile("a.md");
    useUIStore.getState().setEditorBuffer("a.md", "edited");

    expect(useUIStore.getState().openEditorTabs[0]).toEqual({ path: "a.md", isDirty: true, unsaved: "edited" });
  });

  it("drops the buffer once the file is saved", () => {
    useUIStore.getState().openEditorFile("a.md");
    useUIStore.getState().setEditorBuffer("a.md", "edited");
    useUIStore.getState().markEditorSaved("a.md", "edited");

    expect(useUIStore.getState().openEditorTabs[0]).toEqual({ path: "a.md", isDirty: false });
  });
});

describe("uiStore — saving", () => {
  it("marks the tab clean when the saved text is still the current text", () => {
    useUIStore.getState().openEditorFile("a.md");
    useUIStore.getState().setEditorBuffer("a.md", "v1");
    useUIStore.getState().markEditorSaved("a.md", "v1");

    expect(useUIStore.getState().openEditorTabs[0]).toEqual({ path: "a.md", isDirty: false });
  });

  it("keeps text typed while the save was in flight as unsaved", () => {
    useUIStore.getState().openEditorFile("a.md");
    useUIStore.getState().setEditorBuffer("a.md", "v1 plus more typing");
    useUIStore.getState().markEditorSaved("a.md", "v1");

    expect(useUIStore.getState().openEditorTabs[0]).toEqual(
      { path: "a.md", isDirty: true, unsaved: "v1 plus more typing" });
  });
});
