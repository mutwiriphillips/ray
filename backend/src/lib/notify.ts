import nodemailer from "nodemailer";
import type { Consultation, Division } from "../types.js";

const DIVISION_LABEL: Record<Division, string> = {
  digitizebiz: "DigitizeBiz",
  citizenease: "CitizenEase",
};

const ADMIN_EMAIL = process.env.ADMIN_NOTIFY_EMAIL || "mutwiriphillips@gmail.com";
const ADMIN_WHATSAPP = process.env.ADMIN_WHATSAPP_NUMBER; // digits only, country code, no + — e.g. 254791994833

// "3 services requested: X, Y, Z" / "" if the cart/checkout flow wasn't used for this submission.
function servicesSummary(c: Consultation): string {
  if (!c.services.length) return "";
  return `Services requested (${c.services.length}): ${c.services.join(", ")}`;
}

// Short form for the WhatsApp division/summary placeholder — keeps the same
// template parameter count as before, just enriches the text in that slot.
function divisionWithCount(c: Consultation): string {
  const division = DIVISION_LABEL[c.division];
  return c.services.length ? `${division} (${c.services.length} services)` : division;
}

// ---------------------------------------------------------------------------
// Email (Gmail SMTP via Nodemailer)
// ---------------------------------------------------------------------------

let transporter: ReturnType<typeof nodemailer.createTransport> | null | undefined;

function getTransporter() {
  if (transporter !== undefined) return transporter;
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    console.warn("GMAIL_USER/GMAIL_APP_PASSWORD not set — email notifications are disabled.");
    transporter = null;
    return transporter;
  }
  transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass },
  });
  return transporter;
}

async function sendEmail(to: string, subject: string, text: string, html: string) {
  const t = getTransporter();
  if (!t) return;
  await t.sendMail({ from: `"Skywalkers Ltd" <${process.env.GMAIL_USER}>`, to, subject, text, html });
}

export async function sendAdminEmail(c: Consultation) {
  const division = DIVISION_LABEL[c.division];
  const subject = `New ${division} consultation — ${c.name}`;
  const text = [
    `New consultation request via ${division}`,
    ``,
    `Name: ${c.name}`,
    `Contact: ${c.contact}`,
    ...(c.services.length ? [servicesSummary(c)] : []),
    `Message: ${c.message || "(none)"}`,
    `Received: ${new Date(c.createdAt).toLocaleString()}`,
    ``,
    `View in the admin dashboard to update its status.`,
  ].join("\n");
  const html = `
    <div style="font-family: sans-serif; max-width: 480px;">
      <h2 style="color:#16233A;">New ${division} consultation</h2>
      <p><strong>Name:</strong> ${escapeHtml(c.name)}</p>
      <p><strong>Contact:</strong> ${escapeHtml(c.contact)}</p>
      ${c.services.length ? `<p><strong>Services requested:</strong></p><ul>${c.services.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>` : ""}
      <p><strong>Message:</strong> ${escapeHtml(c.message || "(none)")}</p>
      <p style="color:#6B6153; font-size: 13px;">Received ${new Date(c.createdAt).toLocaleString()}</p>
    </div>`;
  await sendEmail(ADMIN_EMAIL, subject, text, html);
}

export async function sendClientEmail(c: Consultation) {
  if (!c.contact.includes("@")) return; // contact is a phone number, not an email — nothing to send here
  const division = DIVISION_LABEL[c.division];
  const subject = `We've received your request — Skywalkers Ltd`;
  const text = [
    `Hi ${c.name},`,
    ``,
    `Thanks for reaching out to ${division} at Skywalkers Ltd. We've received your request and`,
    `will get back to you shortly.`,
    ...(c.services.length ? [``, servicesSummary(c)] : []),
    ``,
    `— Skywalkers Ltd`,
  ].join("\n");
  const html = `
    <div style="font-family: sans-serif; max-width: 480px;">
      <p>Hi ${escapeHtml(c.name)},</p>
      <p>Thanks for reaching out to <strong>${division}</strong> at Skywalkers Ltd. We've received
      your request and will get back to you shortly.</p>
      ${c.services.length ? `<p><strong>You requested:</strong></p><ul>${c.services.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>` : ""}
      <p>— Skywalkers Ltd</p>
    </div>`;
  await sendEmail(c.contact, subject, text, html);
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));
}

// ---------------------------------------------------------------------------
// WhatsApp (Meta WhatsApp Cloud API)
//
// Business-initiated messages (which both of these are — the client hasn't
// messaged first) MUST use a pre-approved message template; freeform text
// only works within 24h of the recipient messaging you first. See the
// "WhatsApp setup" section of backend/README.md for how to create and submit
// these two templates in Meta Business Manager before this will work.
// ---------------------------------------------------------------------------

async function sendWhatsAppTemplate(to: string, templateName: string, params: string[]) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    console.warn("WHATSAPP_ACCESS_TOKEN/WHATSAPP_PHONE_NUMBER_ID not set — WhatsApp notifications are disabled.");
    return;
  }

  const res = await fetch(`https://graph.facebook.com/v19.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: templateName,
        language: { code: "en" },
        components: [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }],
      },
    }),
  });

  if (!res.ok) {
    console.error(`WhatsApp send failed (${res.status}):`, await res.text());
  }
}

// Kenyan numbers only, matching this business's market: normalizes a local
// "07XX..." or "01XX..." number to "2547XX.../2541XX...". Numbers already in
// international format (leading 254 or +254) pass through unchanged.
function normalizeKenyanNumber(raw: string): string | null {
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.startsWith("254") && digits.length === 12) return digits;
  if (digits.startsWith("0") && digits.length === 10) return "254" + digits.slice(1);
  return null;
}

export async function sendAdminWhatsApp(c: Consultation) {
  if (!ADMIN_WHATSAPP) return;
  await sendWhatsAppTemplate(ADMIN_WHATSAPP, "skywalkers_admin_alert", [c.name, divisionWithCount(c), c.contact]);
}

export async function sendClientWhatsApp(c: Consultation) {
  if (c.contact.includes("@")) return; // contact is an email, not a phone number
  const to = normalizeKenyanNumber(c.contact);
  if (!to) return; // couldn't confidently parse a Kenyan number — skip rather than send to the wrong recipient
  await sendWhatsAppTemplate(to, "skywalkers_client_confirmation", [c.name, divisionWithCount(c)]);
}

// ---------------------------------------------------------------------------

export async function notifyNewConsultation(c: Consultation): Promise<void> {
  const results = await Promise.allSettled([
    sendAdminEmail(c),
    sendClientEmail(c),
    sendAdminWhatsApp(c),
    sendClientWhatsApp(c),
  ]);
  const labels = ["admin email", "client email", "admin WhatsApp", "client WhatsApp"];
  results.forEach((r, i) => {
    if (r.status === "rejected") console.error(`Notification failed (${labels[i]}):`, r.reason);
  });
}
