// Minimal PostgreSQL wire-protocol server for DB-free service tests.
//
// Services run with the real `pg` package against it, so pg-pool's handling of a connection that fails while
// idle is exercised exactly as against PostgreSQL. It accepts any startup without authentication, answers
// `select 1` with one row and every other statement with an empty result (simple and extended protocol), and
// `terminateAll()` ends every connection the way pg_terminate_backend does: a FATAL 57P01 ErrorResponse
// followed by closing the socket.
import net from "node:net";

const SSL_REQUEST = 80877103;

export async function startFakePostgres() {
  const sockets = new Set();
  let connections = 0;
  const server = net.createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let buffer = Buffer.alloc(0);
    let started = false;
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (!started) {
          if (buffer.length < 8 || buffer.length < buffer.readInt32BE(0)) return;
          const length = buffer.readInt32BE(0);
          const code = buffer.readInt32BE(4);
          buffer = buffer.subarray(length);
          if (code === SSL_REQUEST) { socket.write("N"); continue; }
          started = true;
          socket.write(Buffer.concat([message("R", int32(0)), message("K", Buffer.concat([int32(process.pid), int32(connections)])), readyForQuery()]));
          continue;
        }
        if (buffer.length < 5 || buffer.length < 1 + buffer.readInt32BE(1)) return;
        const type = String.fromCharCode(buffer[0]);
        const length = buffer.readInt32BE(1);
        const body = buffer.subarray(5, 1 + length);
        buffer = buffer.subarray(1 + length);
        respond(socket, type, body);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `postgresql://service:fake-password@127.0.0.1:${port}/shuzhiren`,
    get openConnections() { return sockets.size; },
    get totalConnections() { return connections; },
    terminateAll() {
      const terminated = sockets.size;
      for (const socket of sockets) {
        socket.write(errorResponse("FATAL", "57P01", "terminating connection due to administrator command"));
        socket.end();
      }
      return terminated;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

function respond(socket, type, body) {
  if (type === "Q") {
    const sql = body.toString("utf8", 0, Math.max(0, body.length - 1)).trim();
    if (/^select 1;?$/i.test(sql)) socket.write(Buffer.concat([rowDescription("?column?"), dataRow("1"), commandComplete("SELECT 1"), readyForQuery()]));
    else socket.write(Buffer.concat([commandComplete(commandTag(sql)), readyForQuery()]));
  } else if (type === "P") socket.write(message("1"));
  else if (type === "B") socket.write(message("2"));
  else if (type === "D") socket.write(message("n"));
  else if (type === "E") socket.write(commandComplete("SELECT 0"));
  else if (type === "C") socket.write(message("3"));
  else if (type === "S") socket.write(readyForQuery());
  else if (type === "X") socket.end();
}

function commandTag(sql) {
  const verb = sql.split(/\s+/, 1)[0].toUpperCase();
  return ["BEGIN", "COMMIT", "ROLLBACK"].includes(verb) ? verb : "SELECT 0";
}

function message(type, body = Buffer.alloc(0)) {
  return Buffer.concat([Buffer.from(type, "ascii"), int32(body.length + 4), body]);
}

function int32(value) { const buffer = Buffer.alloc(4); buffer.writeInt32BE(value); return buffer; }
function int16(value) { const buffer = Buffer.alloc(2); buffer.writeInt16BE(value); return buffer; }
function cstring(value) { return Buffer.from(`${value}\0`, "utf8"); }
function readyForQuery() { return message("Z", Buffer.from("I", "ascii")); }
function commandComplete(tag) { return message("C", cstring(tag)); }
function rowDescription(name) { return message("T", Buffer.concat([int16(1), cstring(name), int32(0), int16(0), int32(23), int16(4), int32(-1), int16(0)])); }
function dataRow(value) { const bytes = Buffer.from(value, "utf8"); return message("D", Buffer.concat([int16(1), int32(bytes.length), bytes])); }
function errorResponse(severity, code, text) {
  return message("E", Buffer.concat([cstring(`S${severity}`), cstring(`V${severity}`), cstring(`C${code}`), cstring(`M${text}`), Buffer.from([0])]));
}
