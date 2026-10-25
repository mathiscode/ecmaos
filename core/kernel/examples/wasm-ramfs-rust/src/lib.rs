//! A filesystem in Rust: `mount -t wasmram none /mnt` gives a directory kept in this module's memory. Build it with
//! `scripts/build-wasm-rust.mjs`; it shows the `filesystem` export of the `filesystem-module` world.

wit_bindgen::generate!({
    path: "../../wit",
    world: "filesystem-module",
    generate_all,
});

use std::collections::BTreeMap;
use std::sync::Mutex;

use ecmaos::module::kernel;
use exports::ecmaos::module::filesystem::{Guest as Filesystem, Inode};
use exports::ecmaos::module::hooks::{Argument, Guest as Hooks};
use exports::ecmaos::module::lifecycle::Guest as Lifecycle;

const ENOENT: i32 = 2;
const EEXIST: i32 = 17;
const ENOTDIR: i32 = 20;
const EISDIR: i32 = 21;
const ENOTEMPTY: i32 = 39;
const DIRECTORY: u32 = 0o040000;
const REGULAR: u32 = 0o100000;

struct Node {
    mode: u32,
    uid: u32,
    gid: u32,
    mtime: f64,
    data: Vec<u8>,
}

/// Every path from the root, "/" included. A mount starts empty.
static TREE: Mutex<BTreeMap<String, Node>> = Mutex::new(BTreeMap::new());

fn now() -> f64 {
    let time = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0);
    time
}

fn parent(path: &str) -> &str {
    match path.rfind('/') {
        Some(0) | None => "/",
        Some(at) => &path[..at],
    }
}

fn inode(node: &Node) -> Inode {
    Inode { mode: node.mode, size: node.data.len() as u64, uid: node.uid, gid: node.gid, atime_ms: node.mtime, mtime_ms: node.mtime, ctime_ms: node.mtime, birthtime_ms: node.mtime }
}

struct Module;

impl Lifecycle for Module {
    fn init(_params: Vec<(String, String)>) -> Result<(), String> {
        match kernel::filesystem("wasmram", "none") {
            0 => Ok(()),
            code => Err(format!("could not add the filesystem type (error {code})")),
        }
    }
    fn exit() {}
}

impl Filesystem for Module {
    fn mount(_source: String, _options: Vec<(String, String)>) -> Result<(), i32> {
        let mut tree = TREE.lock().unwrap();
        tree.entry("/".to_string()).or_insert(Node { mode: DIRECTORY | 0o755, uid: 0, gid: 0, mtime: now(), data: Vec::new() });
        Ok(())
    }

    fn stat(path: String) -> Result<Inode, i32> {
        TREE.lock().unwrap().get(&path).map(inode).ok_or(ENOENT)
    }

    fn readdir(path: String) -> Result<Vec<String>, i32> {
        let tree = TREE.lock().unwrap();
        match tree.get(&path) {
            None => Err(ENOENT),
            Some(node) if node.mode & DIRECTORY == 0 => Err(ENOTDIR),
            Some(_) => Ok(tree.keys().filter(|key| key.as_str() != "/" && parent(key) == path).map(|key| key[key.rfind('/').unwrap() + 1..].to_string()).collect()),
        }
    }

    fn read(path: String, offset: u64, length: u64) -> Result<Vec<u8>, i32> {
        let tree = TREE.lock().unwrap();
        let node = tree.get(&path).ok_or(ENOENT)?;
        if node.mode & DIRECTORY != 0 { return Err(EISDIR); }
        let start = (offset as usize).min(node.data.len());
        let end = start.saturating_add(length as usize).min(node.data.len());
        Ok(node.data[start..end].to_vec())
    }

    fn write(path: String, offset: u64, data: Vec<u8>) -> Result<(), i32> {
        let mut tree = TREE.lock().unwrap();
        let node = tree.get_mut(&path).ok_or(ENOENT)?;
        if node.mode & DIRECTORY != 0 { return Err(EISDIR); }
        let end = offset as usize + data.len();
        if node.data.len() < end { node.data.resize(end, 0); }
        node.data[offset as usize..end].copy_from_slice(&data);
        node.mtime = now();
        Ok(())
    }

    fn create(path: String, mode: u32, uid: u32, gid: u32, directory: bool) -> Result<(), i32> {
        let mut tree = TREE.lock().unwrap();
        if tree.contains_key(&path) { return Err(EEXIST); }
        match tree.get(parent(&path)) {
            None => return Err(ENOENT),
            Some(node) if node.mode & DIRECTORY == 0 => return Err(ENOTDIR),
            Some(_) => {}
        }
        tree.insert(path, Node { mode: (mode & 0o7777) | if directory { DIRECTORY } else { REGULAR }, uid, gid, mtime: now(), data: Vec::new() });
        Ok(())
    }

    fn unlink(path: String) -> Result<(), i32> {
        let mut tree = TREE.lock().unwrap();
        match tree.get(&path) {
            None => Err(ENOENT),
            Some(node) if node.mode & DIRECTORY != 0 => Err(EISDIR),
            Some(_) => { tree.remove(&path); Ok(()) }
        }
    }

    fn rmdir(path: String) -> Result<(), i32> {
        let mut tree = TREE.lock().unwrap();
        match tree.get(&path) {
            None => return Err(ENOENT),
            Some(node) if node.mode & DIRECTORY == 0 => return Err(ENOTDIR),
            Some(_) => {}
        }
        if tree.keys().any(|key| key.as_str() != "/" && parent(key) == path) { return Err(ENOTEMPTY); }
        tree.remove(&path);
        Ok(())
    }

    fn rename(old_path: String, new_path: String) -> Result<(), i32> {
        let mut tree = TREE.lock().unwrap();
        if !tree.contains_key(&old_path) { return Err(ENOENT); }
        let below = format!("{old_path}/");
        let moved: Vec<String> = tree.keys().filter(|key| **key == old_path || key.starts_with(&below)).cloned().collect();
        for key in moved {
            let node = tree.remove(&key).unwrap();
            tree.insert(format!("{new_path}{}", &key[old_path.len()..]), node);
        }
        Ok(())
    }

    fn touch(path: String, mode: Option<u32>, uid: Option<u32>, gid: Option<u32>, size: Option<u64>, mtime_ms: Option<f64>, _atime_ms: Option<f64>) -> Result<(), i32> {
        let mut tree = TREE.lock().unwrap();
        let node = tree.get_mut(&path).ok_or(ENOENT)?;
        if let Some(mode) = mode { node.mode = (node.mode & !0o7777) | (mode & 0o7777); }
        if let Some(uid) = uid { node.uid = uid; }
        if let Some(gid) = gid { node.gid = gid; }
        if let Some(size) = size { node.data.resize(size as usize, 0); }
        node.mtime = mtime_ms.unwrap_or_else(now);
        Ok(())
    }
}

// a filesystem module adds no /proc file, syscall, policy or program format; the hooks are the world's, answered empty
impl Hooks for Module {
    fn proc_show(_path: String) -> String { String::new() }
    fn proc_store(_path: String, _value: String) -> Result<(), String> { Err("read only".to_string()) }
    fn sys_show(_path: String, _attribute: String) -> String { String::new() }
    fn sys_store(_path: String, _attribute: String, _value: String) -> Result<(), String> { Err("read only".to_string()) }
    fn debugfs_read(_path: String) -> String { String::new() }
    fn debugfs_write(_path: String, _value: String) -> Result<(), String> { Err("read only".to_string()) }
    fn syscall_call(_name: String, _pid: u32, _uid: u32, _gid: u32, _arguments: Vec<Argument>) -> i32 { -38 }
    fn syscall_allowed(_syscall: String, _pid: u32, _uid: u32, _exe: Option<String>) -> bool { true }
    fn binfmt_matches(_name: String, _filename: String, _magic: Vec<u8>) -> bool { false }
}

export!(Module);
