//! A kernel module in Rust. Build it with `scripts/build-wasm-rust.mjs` (it needs the nightly toolchain in
//! `rust-toolchain.toml` and wasm-tools), which packs the component with `module.json` into `wasm_hello_rust.ko.wasm`.

wit_bindgen::generate!({
    path: "../../wit",
    world: "module",
    generate_all,
});

use std::sync::Mutex;

use ecmaos::module::kernel;
use exports::ecmaos::module::hooks::{Argument, Guest as Hooks};
use exports::ecmaos::module::lifecycle::Guest as Lifecycle;

struct Module;

static GREETING: Mutex<String> = Mutex::new(String::new());

impl Lifecycle for Module {
    fn init(params: Vec<(String, String)>) -> Result<(), String> {
        let greeting = params.into_iter().find(|(name, _)| name == "greeting").map(|(_, value)| value).unwrap_or_else(|| "hello".to_string());
        kernel::log("info", &format!("loaded from Rust; greeting is {greeting}"));
        *GREETING.lock().unwrap() = greeting;
        // each returns 0, or an error number
        let failed = [kernel::proc("wasm_hello_rust", false), kernel::syscall("wasm_hello_rust_add")].into_iter().find(|code| *code != 0);
        match failed {
            Some(code) => Err(format!("could not add everything (error {code})")),
            None => Ok(()),
        }
    }

    fn exit() {
        kernel::log("info", "unloading");
    }
}

impl Hooks for Module {
    fn proc_show(_path: String) -> String {
        format!("{} from Rust\n", GREETING.lock().unwrap())
    }
    fn proc_store(_path: String, _value: String) -> Result<(), String> { Err("read only".to_string()) }
    fn sys_show(_path: String, _attribute: String) -> String { String::new() }
    fn sys_store(_path: String, _attribute: String, _value: String) -> Result<(), String> { Err("read only".to_string()) }
    fn debugfs_read(_path: String) -> String { String::new() }
    fn debugfs_write(_path: String, _value: String) -> Result<(), String> { Err("read only".to_string()) }

    fn syscall_call(_name: String, _pid: u32, _uid: u32, _gid: u32, arguments: Vec<Argument>) -> i32 {
        arguments.iter().map(|argument| match argument { Argument::Number(n) => *n as i32, Argument::Text(_) => 0 }).sum()
    }
    fn syscall_allowed(_syscall: String, _pid: u32, _uid: u32, _exe: Option<String>) -> bool { true }
    fn binfmt_matches(_name: String, _filename: String, _magic: Vec<u8>) -> bool { false }
}

export!(Module);
