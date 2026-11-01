// Email delivery (Stage 3, T-3.9 — closes Stage 2 deviation 1).
//
// Modes (TUBEFORGE_EMAIL_MODE):
//   console (default) — the link is logged AND returned in the API response.
//                       Single-owner installs and sandboxes work with zero
//                       configuration; NEVER ship this mode in production.
//   smtp               — a REAL message goes out; the response then omits the
//                       link (it lives in the inbox, not the API payload).
//
// The SMTP client is deliberately zero-dependency: net + tls only. It speaks
// the small subset of ESMTP the big three (SES, Postmark, Gmail relay, and
// any plain Postfix) need — EHLO, STARTTLS (opportunistic), AUTH LOGIN,
// MAIL/RCPT/DATA — with a hard 15s step timeout so a wedged relay can never
// hang a request. Implicit TLS on port 465, STARTTLS on 25/587.
//
// Verification/reset links are the ONLY mail this app sends today; template
// sprawl is not worth a dependency. sendMail() stays the single seam so an
// MSP SDK or a queue-backed sender can drop in later.

import net from "net";
import tls from "tls";
import { log } from "./log";

const mailLog = log.child({ mod: "email" });

export type EmailMode = "console" | "smtp";

export function emailMode(): EmailMode {
  return process.env.TUBEFORGE_EMAIL_MODE === "smtp" ? "smtp" : "console";
}

export interface SendMailInput {
  to: string;
  subject: string;
  /** Plain-text body. Keep the action link on its own line. */
  text: string;
}

export type SendMailResult =
  | { delivered: "console" }
  | { delivered: "smtp"; messageId: string | null };

/** Should the API response include the link? (console: yes, smtp: no) */
export function linkInResponse(): boolean {
  return emailMode() === "console";
}

export async function sendMail(input: SendMailInput): Promise<SendMailResult> {
  const mode = emailMode();
  if (mode === "console") {
    // Extract the action link for a loud, greppable dev line.
    const link = input.text.split("\n").find((l) => /^https?:\/\//.test(l.trim()));
    // eslint-disable-next-line no-console -- console mode IS the delivery channel
    console.log(
      `[email:console] to=${input.to} subject="${input.subject}"${link ? ` link=${link.trim()}` : ""}`
    );
    return { delivered: "console" };
  }

  const host = process.env.TUBEFORGE_SMTP_HOST ?? "";
  const port = Number(process.env.TUBEFORGE_SMTP_PORT ?? 587);
  const user = process.env.TUBEFORGE_SMTP_USER ?? "";
  const pass = process.env.TUBEFORGE_SMTP_PASS ?? "";
  const from = process.env.TUBEFORGE_SMTP_FROM ?? user;
  if (!host || !from) {
    throw new Error("smtp mode selected but TUBEFORGE_SMTP_HOST / TUBEFORGE_SMTP_FROM are unset");
  }

  const messageId = await smtpSession({ host, port, user, pass, from, input });
  mailLog.info("mail delivered", { to: redactLocal(input.to), subject: input.subject });
  return { delivered: "smtp", messageId };
}

/** Local part only — full addresses in logs are a GDPR foot-gun. */
function redactLocal(addr: string): string {
  const [local, domain] = addr.split("@");
  if (!domain) return "***";
  return `${local.slice(0, 2)}***@${domain}`;
}

// ---------------------------------------------------------------------------
// Minimal ESMTP client

interface SmtpOpts {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  input: SendMailInput;
}

const STEP_TIMEOUT_MS = 15_000;

/** Read one SMTP reply (handles `250-` continuation lines). */
function readReply(reader: LineReader, socket: net.Socket): Promise<{ code: number; lines: string[] }> {
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    const onLine = (line: string) => {
      lines.push(line.slice(4));
      const code = Number(line.slice(0, 3));
      if (line[3] !== "-") {
        socket.removeListener("error", onErr);
        resolve({ code, lines });
      }
    };
    const onErr = (err: Error) => {
      socket.removeListener("line", onLine as never);
      reject(err);
    };
    socket.once("error", onErr);
    reader.read(onLine);
  });
}

/** Line-buffered socket reader — SMTP is line-oriented. */
class LineReader {
  private buffer = "";
  private waiter: ((line: string) => void) | null = null;

  constructor(private socket: net.Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      this.pump();
    });
  }

  private pump() {
    for (;;) {
      if (!this.waiter) return;
      const idx = this.buffer.indexOf("\r\n");
      if (idx === -1) return;
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const w = this.waiter;
      this.waiter = null;
      w(line);
    }
  }

  read(cb: (line: string) => void) {
    this.waiter = cb;
    this.pump();
  }
}

function write(socket: net.Socket, cmd: string): void {
  socket.write(cmd + "\r\n");
}

async function expect(reader: LineReader, socket: net.Socket, code: number, what: string): Promise<string[]> {
  const reply = await withTimeout(readReply(reader, socket), STEP_TIMEOUT_MS, `SMTP ${what} timed out`);
  if (Math.floor(reply.code / 100) !== Math.floor(code / 100)) {
    throw new Error(`SMTP ${what} failed: ${reply.code} ${reply.lines.join(" / ").slice(0, 200)}`);
  }
  return reply.lines;
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

async function smtpSession(opts: SmtpOpts): Promise<string | null> {
  const implicitTls = opts.port === 465;
  const socket: net.Socket = implicitTls
    ? tls.connect({ host: opts.host, port: opts.port, servername: opts.host, timeout: STEP_TIMEOUT_MS })
    : net.connect({ host: opts.host, port: opts.port, timeout: STEP_TIMEOUT_MS });

  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
    setTimeout(() => reject(new Error(`SMTP connect to ${opts.host}:${opts.port} timed out`)), STEP_TIMEOUT_MS);
  });

  try {
    const reader = new LineReader(socket);

    // 1) greeting
    await expect(reader, socket, 220, "greeting");

    // 2) EHLO — announce + learn extensions
    write(socket, `EHLO tubeforge.local`);
    const ehlo = await expect(reader, socket, 250, "EHLO");
    const exts = ehlo.join(" ").toUpperCase();

    // 3) STARTTLS when the server offers it (and we are not already on TLS)
    const secure = socket instanceof tls.TLSSocket;
    if (!secure && exts.includes("STARTTLS")) {
      write(socket, "STARTTLS");
      await expect(reader, socket, 220, "STARTTLS");
      const tlsSocket = tls.connect({ socket: socket as net.Socket, servername: opts.host }, () => {});
      // NOTE: the existing reader stays attached — TLS re-encryption is
      // transparent below the line layer; swap the data wiring instead.
      await new Promise<void>((resolve, reject) => {
        tlsSocket.once("secureConnect", resolve);
        tlsSocket.once("error", reject);
      });
      write(tlsSocket, "EHLO tubeforge.local");
      await expect(reader, tlsSocket, 250, "EHLO after STARTTLS");
      socket.removeAllListeners("data");
      // From here on the TLS socket IS the transport.
      return await finishSession(tlsSocket, new LineReader(tlsSocket), opts);
    }

    return await finishSession(socket as net.Socket, reader, opts);
  } finally {
    socket.destroy();
  }
}

/** AUTH + envelope + DATA on an established (possibly TLS) socket. */
async function finishSession(socket: net.Socket, reader: LineReader, opts: SmtpOpts): Promise<string | null> {
  const { user, pass, from, input } = opts;

  if (user && pass) {
    write(socket, "AUTH LOGIN");
    await expect(reader, socket, 334, "AUTH LOGIN");
    write(socket, Buffer.from(user).toString("base64"));
    await expect(reader, socket, 334, "AUTH user");
    write(socket, Buffer.from(pass).toString("base64"));
    await expect(reader, socket, 235, "AUTH pass");
  }

  const messageId = `<${Date.now()}-${Math.random().toString(36).slice(2)}@tubeforge>`;
  const headers = [
    `From: TubeForge <${from}>`,
    `To: ${input.to}`,
    `Subject: ${sanitizeHeader(input.subject)}`,
    `Message-ID: ${messageId}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
  ].join("\r\n");

  const body = input.text.replace(/\r?\n/g, "\r\n").replace(/^\./gm, ".."); // dot-stuffing

  write(socket, `MAIL FROM:<${from}>`);
  await expect(reader, socket, 250, "MAIL FROM");
  write(socket, `RCPT TO:<${input.to}>`);
  await expect(reader, socket, 250, "RCPT TO");
  write(socket, "DATA");
  await expect(reader, socket, 354, "DATA");
  socket.write(headers + "\r\n" + body + "\r\n.\r\n");
  await expect(reader, socket, 250, "message body");
  write(socket, "QUIT");
  socket.end();
  return messageId;
}

/** Header injection guard — CR/LF in a subject must never smuggle headers. */
function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").slice(0, 200);
}
