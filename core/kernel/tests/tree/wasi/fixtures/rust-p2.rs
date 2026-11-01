// A std program built with rustc for wasm32-wasip2, so it imports wasi:* 0.2 directly (no preview1 adapter): arguments,
// environment, stdin, files and directories, a sleep, a TCP connection and a UDP datagram on loopback, a name lookup, and
// an exit code from the first argument: `rust-p2 [EXIT_CODE] [BASE_DIR]` (BASE_DIR defaults to /tmp). See README.md for the build.
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, ToSocketAddrs, UdpSocket};
use std::{env, fs, process, thread, time::{Duration, Instant, SystemTime}};

fn main() {
    let args: Vec<String> = env::args().collect();
    println!("args={}", args[1..].join(","));
    println!("home={}", env::var("HOME").unwrap_or_default());
    eprintln!("rust-p2: stderr");

    let base = args.get(2).map(String::as_str).unwrap_or("/tmp");
    let path = format!("{base}/rust-p2.txt");
    fs::write(&path, "made by rust p2\n").expect("write");
    println!("file={}", fs::read_to_string(&path).expect("read").trim());
    println!("size={}", fs::metadata(&path).expect("stat").len());
    fs::create_dir_all(format!("{base}/rust-p2-dir/sub")).expect("mkdir");
    fs::write(format!("{base}/rust-p2-dir/b.txt"), "b").expect("write");
    fs::write(format!("{base}/rust-p2-dir/a.txt"), "a").expect("write");
    let mut names: Vec<String> = fs::read_dir(format!("{base}/rust-p2-dir")).expect("readdir")
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    println!("dir={}", names.join(","));
    fs::rename(format!("{base}/rust-p2-dir/a.txt"), format!("{base}/rust-p2-dir/c.txt")).expect("rename");
    println!("renamed={}", fs::metadata(format!("{base}/rust-p2-dir/c.txt")).is_ok());
    println!("missing={}", fs::read_to_string(format!("{base}/nope")).unwrap_err().kind() == std::io::ErrorKind::NotFound);

    let now = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).expect("clock");
    println!("clock={}", now.as_secs() > 1_700_000_000);
    let start = Instant::now();
    thread::sleep(Duration::from_millis(60));
    println!("slept={}", start.elapsed() >= Duration::from_millis(60));

    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let address = listener.local_addr().expect("local_addr");
    let mut client = TcpStream::connect(address).expect("connect");
    let (mut server, _) = listener.accept().expect("accept");
    client.write_all(b"ping").expect("send");
    let mut buffer = [0u8; 4];
    server.read_exact(&mut buffer).expect("recv");
    server.write_all(&buffer).expect("echo");
    let mut back = [0u8; 4];
    client.read_exact(&mut back).expect("recv echo");
    println!("tcp={}", String::from_utf8_lossy(&back));

    let first = UdpSocket::bind("127.0.0.1:0").expect("udp bind");
    let second = UdpSocket::bind("127.0.0.1:0").expect("udp bind");
    first.send_to(b"datagram", second.local_addr().unwrap()).expect("send_to");
    let mut packet = [0u8; 16];
    let (count, _) = second.recv_from(&mut packet).expect("recv_from");
    println!("udp={}", String::from_utf8_lossy(&packet[..count]));

    println!("localhost={}", ("localhost", 80).to_socket_addrs().map(|mut found| found.next().is_some()).unwrap_or(false));

    if args.get(1).map(String::as_str) == Some("stdin") {
        let mut input = String::new();
        std::io::stdin().read_to_string(&mut input).expect("stdin");
        print!("stdin={}", input);
        std::io::stdout().flush().unwrap();
    }
    process::exit(args.get(1).and_then(|value| value.parse().ok()).unwrap_or(0));
}
