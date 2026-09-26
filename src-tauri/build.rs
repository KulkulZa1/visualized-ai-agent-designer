fn main() {
    // Only the desktop app (feature "app") is a Tauri build; harness-core is not.
    #[cfg(feature = "app")]
    tauri_build::build();
}
