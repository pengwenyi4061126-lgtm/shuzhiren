// Preload (`node --import`) for the SIGTERM process tests on Windows, where sending SIGTERM to a child process
// terminates it without running any handler. The test writes the signal name to the child's stdin and this
// module emits it on `process`, so the service's own signal handlers run exactly as for a delivered signal.
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const name of chunk.split(/\s+/)) if (name === "SIGTERM" || name === "SIGINT") process.emit(name, name);
});
