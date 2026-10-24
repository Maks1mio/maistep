fn main() {
    // иконка вшивается в exe ресурсом — без этого смена icons/ не пересобирала его (в exe оставалась старая)
    println!("cargo:rerun-if-changed=icons");
    println!("cargo:rerun-if-env-changed=MAISTEP_VERSION");
    tauri_build::build()
}
