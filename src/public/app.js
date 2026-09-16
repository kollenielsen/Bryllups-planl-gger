const $ = (sel) => document.querySelector(sel);
const state = { weddingId: null, dashboard: null, config: null, threadVendor: null };

const CATEGORY_LABEL = { venue: "Lokaler", photographer: "Fotografer" };

const STATUS_LABEL = {
  discovered: ["Fundet", "mute"],
  no_contact: ["Ingen mail fundet", "warn"],
  approved_for_outreach: ["Mail i kø", "mute"],
  contacted: ["Skrevet til", "mute"],
  replied: ["Har svaret", "ok"],
  awaiting_info: ["Afventer info", "warn"],
  quoted: ["Tilbud modtaget", "ok"],
  rejected: ["Afslag", "bad"],
  booked: ["Booket", "ok"],
  bounced: ["Mail kunne ikke leveres", "bad"],
  opted_out: ["Frabedt sig kontakt", "bad"],
};

const THREAD_LABEL = {
  draft: "Udkast",
  awaiting_vendor: "Venter på leverandør",
  needs_agent_reply: "Agenten svarer",
  needs_human: "Kræver jer",
  quoted: "Tilbud i hus",
  closed: "Lukket",
};

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { "content-type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error ?? (data.errors ?? []).join(" ") ?? `HTTP ${res.status}`);
  return data;
}

function banner(message, kind = "") {
  $("#banner").innerHTML = message ? `<div class="banner ${kind}">${escapeHtml(message)}</div>` : "";
  if (message) setTimeout(() => ($("#banner").innerHTML = ""), 9000);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

async function boot() {
  state.config = await api("/config");
  $("#mode").textContent = state.config.dry_run
    ? "Tør-kørsel: ingen mails forlader maskinen"
    : `Live via ${state.config.email_provider}`;
  $("#mode").className = `pill ${state.config.dry_run ? "warn" : "ok"}`;

  const weddings = await api("/weddings");
  const picker = $("#weddingPicker");
  picker.innerHTML = weddings
    .map((w) => `<option value="${w.id}">${escapeHtml(w.couple_names)} – ${escapeHtml(w.region)}</option>`)
    .join("");
  picker.onchange = () => selectWedding(picker.value);
  $("#newWeddingBtn").onclick = showIntake;

  if (weddings.length > 0) await selectWedding(weddings[0].id);
  else showIntake();
}

function showIntake() {
  $("#intake").hidden = false;
  $("#dashboard").hidden = true;
}

async function selectWedding(id) {
  state.weddingId = id;
  $("#weddingPicker").value = id;
  $("#intake").hidden = true;
  $("#dashboard").hidden = false;
  await refresh();
}

async function refresh() {
  const [dashboard, outbox] = await Promise.all([
    api(`/weddings/${state.weddingId}/dashboard`),
    api(`/weddings/${state.weddingId}/outbox`),
  ]);
  state.dashboard = dashboard;
  renderHeader(dashboard.wedding);
  renderQuestions(dashboard.open_questions);
  renderOutbox(outbox);
  renderReview(dashboard.needs_review);
  renderCategories(dashboard.categories);
}

function renderHeader(w) {
  $("#coupleNames").textContent = w.couple_names;
  const budget =
    w.budget_min || w.budget_max
      ? `${(w.budget_min ?? 0).toLocaleString("da-DK")}–${(w.budget_max ?? 0).toLocaleString("da-DK")} kr.`
      : "budget ikke oplyst";
  $("#weddingMeta").textContent =
    `${w.wedding_date ?? "dato ikke fastlagt"} · ${w.region} · ${w.guest_count_min}–${w.guest_count_max} gæster · ${budget}`;
}

function renderQuestions(questions) {
  const el = $("#questions");
  if (questions.length === 0) {
    el.innerHTML = `<p class="empty">Ingen ubesvarede spørgsmål. Agenten har kunnet svare leverandørerne ud fra det, I har oplyst.</p>`;
    return;
  }
  el.innerHTML = questions
    .map(
      (q) => `
      <div class="field">
        <label>${escapeHtml(q.question)}</label>
        <div class="row">
          <input id="ans_${q.id}" placeholder="Jeres svar" style="flex:1" />
          <button class="small" data-answer="${q.id}">Gem</button>
        </div>
      </div>`,
    )
    .join("");
  el.querySelectorAll("[data-answer]").forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.answer;
      const answer = document.getElementById(`ans_${id}`).value.trim();
      if (!answer) return;
      await api(`/questions/${id}/answer`, { method: "POST", body: { answer } });
      banner("Svaret er gemt. Agenten bruger det i de næste mails.");
      await refresh();
    };
  });
}

function renderOutbox(items) {
  const pending = items.filter((i) => i.status === "needs_approval" || i.status === "queued");
  const el = $("#outbox");
  if (pending.length === 0) {
    el.innerHTML = `<p class="empty">Ingen mails i kø.</p>`;
    return;
  }
  el.innerHTML = `
    <table>
      <tr><th>Til</th><th>Emne</th><th>Status</th><th>Sendes</th><th></th></tr>
      ${pending
        .map(
          (i) => `<tr>
            <td>${escapeHtml(i.to_email)}</td>
            <td class="subject">${escapeHtml(i.subject)}<div class="muted preview">${escapeHtml(i.body_text.slice(0, 110))}…</div></td>
            <td><span class="pill ${i.status === "needs_approval" ? "warn" : "mute"}">${i.status === "needs_approval" ? "Afventer godkendelse" : "I kø"}</span></td>
            <td class="mono">${new Date(i.scheduled_at).toLocaleString("da-DK")}</td>
            <td>${
              i.status === "needs_approval"
                ? `<button class="small" data-approve="${i.id}">Godkend</button>`
                : ""
            } <button class="quiet small" data-cancel="${i.id}">Annullér</button></td>
          </tr>`,
        )
        .join("")}
    </table>
    <div class="row" style="margin-top:10px">
      <button class="small" id="approveAll">Godkend alle</button>
      <span class="muted">Mails udsendes spredt over tid, ikke på én gang.</span>
    </div>`;

  el.querySelectorAll("[data-approve]").forEach((b) => {
    b.onclick = async () => {
      await api(`/outbox/${b.dataset.approve}/approve`, { method: "POST" });
      await refresh();
    };
  });
  el.querySelectorAll("[data-cancel]").forEach((b) => {
    b.onclick = async () => {
      await api(`/outbox/${b.dataset.cancel}/cancel`, { method: "POST" });
      await refresh();
    };
  });
  const all = $("#approveAll");
  if (all) {
    all.onclick = async () => {
      const { approved } = await api(`/weddings/${state.weddingId}/outbox/approve-all`, { method: "POST" });
      banner(`${approved} mails godkendt.`);
      await refresh();
    };
  }
}

function renderReview(cards) {
  const el = $("#review");
  if (cards.length === 0) {
    el.innerHTML = `<p class="empty">Intet i kø. Alle udtræk kunne bekræftes direkte i leverandørens tekst.</p>`;
    return;
  }
  el.innerHTML = cards
    .map(
      (c) => `
      <div class="vendor flagged">
        <div class="row">
          <h3>${escapeHtml(c.vendor.name)}</h3>
          <span class="pill bad">Tjek selv</span>
          <div class="spacer"></div>
          <span class="muted">sikkerhed ${(c.quote.confidence_score * 100).toFixed(0)} %</span>
        </div>
        <div class="price unverified">Agenten læste: ${escapeHtml(c.price_label)}</div>
        <ul class="reasons">${c.quote.review_reasons.map((r) => `<li>${escapeHtml(r.split(": ").slice(1).join(": ") || r)}</li>`).join("")}</ul>
        <div class="row">
          <button class="ghost small" data-thread="${c.thread?.id ?? ""}" data-vendor="${escapeHtml(c.vendor.name)}">Læs mailen</button>
          <button class="small" data-reviewed="${c.quote.id}">Set — tallene passer</button>
        </div>
      </div>`,
    )
    .join("");
  wireThreadButtons(el);
  el.querySelectorAll("[data-reviewed]").forEach((b) => {
    b.onclick = async () => {
      await api(`/quotes/${b.dataset.reviewed}/review`, { method: "POST", body: {} });
      await refresh();
    };
  });
}

function renderCategories(categories) {
  const el = $("#categories");
  const sections = Object.entries(categories).map(([cat, cards]) => `
    <div class="card" style="margin-bottom:16px">
      <h2>${CATEGORY_LABEL[cat] ?? cat} (${cards.length})</h2>
      <div class="grid two">
        ${cards.map(renderVendorCard).join("") || `<p class="empty">Ingen leverandører endnu. Tryk "Find leverandører".</p>`}
      </div>
    </div>`);
  el.innerHTML = sections.join("") || `<div class="card"><p class="empty">Ingen leverandører endnu.</p></div>`;
  wireThreadButtons(el);
  el.querySelectorAll("[data-book]").forEach((b) => {
    b.onclick = () => openBooking(b.dataset.book, b.dataset.vendor);
  });
  el.querySelectorAll("[data-reject]").forEach((b) => {
    b.onclick = async () => {
      await api(`/vendors/${b.dataset.reject}/reject`, { method: "POST", body: { reason: "fravalgt af parret" } });
      await refresh();
    };
  });
}

function renderVendorCard(c) {
  const [label, tone] = STATUS_LABEL[c.vendor.status] ?? [c.vendor.status, "mute"];
  const flagged = c.quote?.needs_human_review && !c.quote.human_reviewed_at;
  const AVAILABILITY = {
    available: '<span class="pill ok">Dato ledig</span>',
    unavailable: '<span class="pill bad">Dato optaget</span>',
    tentative: '<span class="pill warn">Option/forbehold</span>',
    unknown: '<span class="pill mute">Ledighed ukendt</span>',
  };
  // "Dato ledig" må kun stå grønt, når ledigheden faktisk kunne bekræftes i
  // leverandørens egen tekst. Ellers er det agentens læsning, ikke et tilsagn.
  const availabilityPill =
    c.quote?.availability === "available" && !c.quote.availability_confirmed
      ? '<span class="pill warn">Ledig — ikke bekræftet</span>'
      : (AVAILABILITY[c.quote?.availability] ?? "");
  const availability = c.quote ? `<div>${availabilityPill}</div>` : "";

  // Et ubekræftet tal vises aldrig i prislinjen som om leverandøren havde
  // sagt det. Det står som agentens læsning, med opfordring til at læse selv.
  const hasPrice = c.quote && (c.quote.price_min !== null || c.quote.price_max !== null);
  const price =
    hasPrice && !c.price_verified
      ? `<div class="price unverified">Pris ikke bekræftet</div>
         <div class="muted">Agenten læste <strong>${escapeHtml(c.price_label)}</strong> — det står ikke sådan i mailen. Læs den selv.</div>`
      : `<div class="price">${escapeHtml(c.price_label)}</div>`;

  return `
    <div class="vendor ${flagged ? "flagged" : ""}">
      <div class="row">
        <h3>${escapeHtml(c.vendor.name)}</h3>
        <span class="pill ${tone}">${label}</span>
        ${c.thread ? `<span class="pill mute">${THREAD_LABEL[c.thread.state] ?? c.thread.state}</span>` : ""}
      </div>
      ${price}
      ${availability}
      ${c.quote?.conditions_text ? `<div class="muted">${escapeHtml(c.quote.conditions_text)}</div>` : ""}
      ${c.quote?.deposit_text ? `<div class="muted">Depositum: ${escapeHtml(c.quote.deposit_text)}</div>` : ""}
      <div class="muted">
        ${c.vendor.contact_email ? escapeHtml(c.vendor.contact_email) : "ingen mail fundet"}
        ${c.vendor.city ? ` · ${escapeHtml(c.vendor.city)}` : ""}
        ${c.message_count ? ` · ${c.message_count} mails` : ""}
      </div>
      <div class="row">
        ${c.thread ? `<button class="ghost small" data-thread="${c.thread.id}" data-vendor="${escapeHtml(c.vendor.name)}">Åbn tråd</button>` : ""}
        <div class="spacer"></div>
        <button class="quiet small" data-reject="${c.vendor.id}">Fravælg</button>
        <button class="small" data-book="${c.vendor.id}" data-vendor="${escapeHtml(c.vendor.name)}">Book</button>
      </div>
    </div>`;
}

function wireThreadButtons(scope) {
  scope.querySelectorAll("[data-thread]").forEach((b) => {
    if (!b.dataset.thread) return;
    b.onclick = () => openThread(b.dataset.thread, b.dataset.vendor);
  });
}

async function openThread(threadId, vendorName) {
  const data = await api(`/threads/${threadId}`);
  state.threadVendor = { threadId, vendorName };
  $("#threadTitle").textContent = vendorName ?? "Tråd";
  $("#threadMeta").textContent = `${data.thread.subject} · svaradresse ${data.reply_to} · ${THREAD_LABEL[data.thread.state] ?? data.thread.state}`;
  $("#threadMessages").innerHTML = data.messages
    .map(
      (m) =>
        `<div class="msg ${m.direction}">` +
        `<div class="meta">${m.direction === "outbound" ? "Vi skrev" : "Leverandøren skrev"} · ${new Date(m.created_at).toLocaleString("da-DK")}</div>` +
        `${escapeHtml((m.clean_text ?? m.raw_text).trim())}</div>`,
    )
    .join("") || `<p class="empty">Ingen mails sendt endnu.</p>`;
  $("#threadDialog").showModal();
}

$("#closeThread").onclick = () => $("#threadDialog").close();
$("#closeBooking").onclick = () => $("#bookingDialog").close();

$("#sendFollowup").onclick = async () => {
  const instruction = $("#followupText").value.trim();
  if (!instruction || !state.threadVendor) return;
  try {
    const result = await api(`/threads/${state.threadVendor.threadId}/followup`, {
      method: "POST",
      body: { instruction },
    });
    $("#followupText").value = "";
    $("#threadDialog").close();
    banner(result.reason ?? "Opfølgning lagt i kø.");
    await refresh();
  } catch (err) {
    banner(err.message, "bad");
  }
};

$("#simulateBtn").onclick = async () => {
  const text = $("#simulateText").value.trim();
  if (!text || !state.threadVendor) return;
  try {
    const result = await api("/dev/simulate-reply", {
      method: "POST",
      body: { thread_id: state.threadVendor.threadId, text },
    });
    $("#simulateText").value = "";
    $("#threadDialog").close();
    banner(`Behandlet: ${result.outcome}${result.detail ? ` – ${result.detail}` : ""}`);
    await refresh();
  } catch (err) {
    banner(err.message, "bad");
  }
};

async function openBooking(vendorId, vendorName) {
  const s = await api(`/vendors/${vendorId}/booking-summary`);
  $("#bookingTitle").textContent = `Book ${vendorName}`;
  $("#bookingBody").innerHTML = `
    <div class="banner">${escapeHtml(s.disclaimer)}</div>
    <p><strong>${escapeHtml(s.vendor.name)}</strong><br />
      ${escapeHtml(s.vendor.email ?? "ingen mail")}${s.vendor.phone ? ` · ${escapeHtml(s.vendor.phone)}` : ""}<br />
      ${escapeHtml(s.price_label)}</p>
    ${
      s.open_points.length
        ? `<h4>Uafklaret inden I siger ja</h4><ul class="reasons">${s.open_points.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul>`
        : `<p class="muted">Ingen åbne punkter registreret.</p>`
    }
    <label>Udkast til bekræftelsesmail — kopiér, ret og send selv</label>
    <input value="${escapeHtml(s.draft_email_subject)}" readonly />
    <textarea readonly style="min-height:220px;margin-top:8px">${escapeHtml(s.draft_email_body)}</textarea>
    <div class="row" style="margin-top:10px">
      <button class="small" id="copyDraft">Kopiér udkast</button>
      <button class="ghost small" id="markBooked" data-vendor-id="${vendorId}">Markér som booket</button>
    </div>`;
  $("#bookingDialog").showModal();
  $("#copyDraft").onclick = async () => {
    await navigator.clipboard.writeText(s.draft_email_body);
    banner("Udkastet er kopieret.");
  };
  $("#markBooked").onclick = async () => {
    await api(`/vendors/${vendorId}/book`, { method: "POST" });
    $("#bookingDialog").close();
    banner("Markeret som booket. Agenten har ikke sendt noget.");
    await refresh();
  };
}

$("#intakeForm").onsubmit = async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const body = Object.fromEntries(form.entries());
  body.date_flexible = form.get("date_flexible") === "on";
  for (const key of ["budget_min", "budget_max"]) if (!body[key]) body[key] = null;
  if (!body.wedding_date) body.wedding_date = null;
  try {
    const wedding = await api("/weddings", { method: "POST", body });
    const picker = $("#weddingPicker");
    picker.insertAdjacentHTML(
      "afterbegin",
      `<option value="${wedding.id}">${escapeHtml(wedding.couple_names)} – ${escapeHtml(wedding.region)}</option>`,
    );
    await selectWedding(wedding.id);
    banner("Bryllup oprettet. Finder leverandører…");
    await api(`/weddings/${wedding.id}/discover`, { method: "POST", body: {} });
    await refresh();
  } catch (err) {
    banner(err.message, "bad");
  }
};

document.addEventListener("click", async (e) => {
  const act = e.target.dataset?.act;
  if (!act) return;
  e.target.disabled = true;
  try {
    if (act === "discover") {
      const r = await api(`/weddings/${state.weddingId}/discover`, { method: "POST", body: {} });
      banner(`Fundet: ${Object.entries(r.discovered).map(([k, v]) => `${CATEGORY_LABEL[k] ?? k} ${v}`).join(", ")}`);
    } else if (act.startsWith("outreach-")) {
      const category = act.replace("outreach-", "");
      const r = await api(`/weddings/${state.weddingId}/outreach`, { method: "POST", body: { category } });
      banner(
        `${r.queued} mails skrevet og lagt i kø.` +
          (r.skipped.length ? ` Sprunget over: ${r.skipped.map((s) => `${s.vendor} (${s.reason})`).join("; ")}` : ""),
      );
    } else if (act === "run-queue") {
      const r = await api("/outbox/run", { method: "POST" });
      banner(`${r.sent} mails afsendt.`);
    }
    await refresh();
  } catch (err) {
    banner(err.message, "bad");
  } finally {
    e.target.disabled = false;
  }
});

boot().catch((err) => banner(err.message, "bad"));
