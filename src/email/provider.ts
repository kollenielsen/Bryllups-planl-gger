import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { newMessageId } from "./threading.js";

export interface OutgoingEmail {
  to: string;
  replyTo: string;
  subject: string;
  text: string;
  inReplyTo: string | null;
  references: string | null;
}

export interface SendResult {
  messageId: string;
  transport: string;
}

export interface EmailProvider {
  readonly name: string;
  send(msg: OutgoingEmail): Promise<SendResult>;
}

/**
 * Skriver mailen til disk i stedet for at sende. Default i udvikling, og
 * dét der gør det ufarligt at køre hele pipelinen igennem uden at en rigtig
 * leverandør modtager noget.
 */
export class ConsoleEmailProvider implements EmailProvider {
  readonly name = "console";

  async send(msg: OutgoingEmail): Promise<SendResult> {
    const messageId = newMessageId();
    const dir = path.resolve(config.email.outboxDir);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${sanitize(msg.to)}.eml`);
    fs.writeFileSync(file, renderEml(msg, messageId), "utf8");
    console.log(`[email:console] -> ${msg.to} | ${msg.subject} | ${file}`);
    return { messageId, transport: "console" };
  }
}

export class SmtpEmailProvider implements EmailProvider {
  readonly name = "smtp";
  private transporter: import("nodemailer").Transporter | null = null;

  private async getTransporter() {
    if (this.transporter) return this.transporter;
    const nodemailer = await import("nodemailer");
    this.transporter = nodemailer.createTransport({
      host: config.email.smtp.host,
      port: config.email.smtp.port,
      secure: config.email.smtp.secure,
      auth: config.email.smtp.user
        ? { user: config.email.smtp.user, pass: config.email.smtp.pass }
        : undefined,
    });
    return this.transporter;
  }

  async send(msg: OutgoingEmail): Promise<SendResult> {
    const transporter = await this.getTransporter();
    const messageId = newMessageId();
    const info = await transporter.sendMail({
      from: `"${config.email.fromName}" <${config.email.fromAddress}>`,
      to: msg.to,
      replyTo: msg.replyTo,
      subject: msg.subject,
      text: msg.text,
      messageId,
      inReplyTo: msg.inReplyTo ?? undefined,
      references: msg.references ?? undefined,
      headers: {
        // Signalerer til modtagersystemer at autosvar ikke skal genereres.
        "Auto-Submitted": "no",
        "X-Bryllupsplanlaegger": "outreach-agent",
      },
    });
    return { messageId: info.messageId ?? messageId, transport: "smtp" };
  }
}

let provider: EmailProvider | null = null;

export function getEmailProvider(): EmailProvider {
  if (provider) return provider;
  provider = config.email.provider === "smtp" ? new SmtpEmailProvider() : new ConsoleEmailProvider();
  return provider;
}

export function setEmailProvider(p: EmailProvider | null): void {
  provider = p;
}

/** Testdouble der bare husker hvad der blev sendt. */
export class RecordingEmailProvider implements EmailProvider {
  readonly name = "recording";
  readonly sent: OutgoingEmail[] = [];

  async send(msg: OutgoingEmail): Promise<SendResult> {
    this.sent.push(msg);
    return { messageId: newMessageId(), transport: "recording" };
  }
}

function renderEml(msg: OutgoingEmail, messageId: string): string {
  const headers = [
    `From: "${config.email.fromName}" <${config.email.fromAddress}>`,
    `To: ${msg.to}`,
    `Reply-To: ${msg.replyTo}`,
    `Subject: ${msg.subject}`,
    `Message-ID: ${messageId}`,
    msg.inReplyTo ? `In-Reply-To: ${msg.inReplyTo}` : null,
    msg.references ? `References: ${msg.references}` : null,
    `Date: ${new Date().toUTCString()}`,
    "Content-Type: text/plain; charset=utf-8",
  ].filter((h): h is string => h !== null);
  return `${headers.join("\n")}\n\n${msg.text}\n`;
}

function sanitize(s: string): string {
  return s.replace(/[^a-z0-9@._-]/gi, "_");
}
