// A std program built with rustc for wasm32-wasip1: arguments, environment, stdout and stderr, a file created and
// read back, a directory listing, a clock, and an exit code from the arguments: `rust-wasip1 [stdin|-] [EXIT_CODE] [BASE_DIR]` (BASE_DIR defaults to /tmp). See README.md for the build.
use std::io::{Read, Write};
use std::{env, fs, process, time::SystemTime};

fn main() {
    let args: Vec<String> = env::args().collect();
    println!("args={}", args[1..].join(","));
    println!("home={}", env::var("HOME").unwrap_or_default());
    eprintln!("rust-wasip1: stderr");

    let base = args.get(3).map(String::as_str).unwrap_or("/tmp");
    let path = format!("{base}/rust-wasip1.txt");
    fs::write(&path, "made by rust\n").expect("write");
    let text = fs::read_to_string(&path).expect("read");
    println!("file={}", text.trim());
    println!("size={}", fs::metadata(&path).expect("stat").len());

    fs::create_dir_all(format!("{base}/rust-wasip1-dir/sub")).expect("mkdir");
    fs::write(format!("{base}/rust-wasip1-dir/b.txt"), "b").expect("write");
    fs::write(format!("{base}/rust-wasip1-dir/a.txt"), "a").expect("write");
    let mut names: Vec<String> = fs::read_dir(format!("{base}/rust-wasip1-dir"))
        .expect("readdir")
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    println!("dir={}", names.join(","));

    let now = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).expect("clock");
    println!("clock={}", now.as_secs() > 1_700_000_000);

    if args.get(1).map(String::as_str) == Some("stdin") {
        let mut input = String::new();
        std::io::stdin().read_to_string(&mut input).expect("stdin");
        print!("stdin={}", input);
        std::io::stdout().flush().unwrap();
    }

    let code: i32 = args.get(2).and_then(|value| value.parse().ok()).unwrap_or(0);
    process::exit(code);
}
