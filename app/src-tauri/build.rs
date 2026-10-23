fn main() {
    // иконка вшивается в exe ресурсом — без этого смена icons/ не пересобирала его (в exe оставалась старая)
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
