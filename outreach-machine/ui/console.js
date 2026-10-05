const $ = (id) => document.getElementById(id);
const labels = {
  needs_review: "Prüfung offen",
  eligible: "Geprüft",
  suppressed: "Gesperrt",
  draft: "Entwurf",
  paused: "Pausiert",
  awaiting_approval: "Freigabe offen",
  approved: "Inhalt freigegeben",
  reconciliation_required: "Klärung erforderlich",
  cancelled: "Gestoppt",
  sent_confirmed: "Gesendet bestätigt",
  send_accepted: "Von Microsoft angenommen",
};
let data = { contacts: [], campaigns: [], messages: [] },
  selectedMessage = null;
let pendingLogoFile=null, pendingLogoUrl=null;
const logoUrl=hash=>`/v1/sender-signature/logos/${encodeURIComponent(hash)}`;
function note(text, error = false) {
  $("notice").textContent = text;
  $("notice").classList.toggle("error", error);
  $("notice").hidden = false;
}
async function api(url, body) {
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      result.error === "invalid_input"
        ? `Bitte Eingaben prüfen: ${result.fields.join(", ")}`
        : result.error === 'invalid_logo'
          ? 'Bitte eine gültige PNG-Datei auswählen (maximal 500 KB, 4096 Pixel je Seite und 4 Millionen Pixel insgesamt).'
        : result.error === 'operator_login_required'
          ? 'Bitte zuerst unter Autopilot mit dem Betreiberpasswort anmelden.'
        : result.error === 'signature_version_conflict'
          ? 'Die Signatur wurde inzwischen geändert. Bitte aktualisieren und erneut prüfen.'
        : result.error === "batch_content_conflict"
          ? "Diese Lauf-ID wurde bereits mit anderen Daten verwendet."
          : `Aktion fehlgeschlagen (${response.status}). Keine Versandaktivierung.`,
    );
  return result;
}
async function action(fn) {
  try {
    await fn();
  } catch (error) {
    note(error.message, true);
  }
}
function el(tag, text, className) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = String(text);
  if (className) n.className = className;
  return n;
}
function button(text, fn, cls = "quiet") {
  const b = el("button", text, cls);
  b.type = "button";
  b.onclick = () =>
    action(async () => {
      b.disabled = true;
      try {
        await fn();
      } finally {
        b.disabled = false;
      }
    });
  return b;
}
function show(view) {
  document.querySelectorAll(".view").forEach((n) => {
    n.hidden = n.id !== view;
  });
  document
    .querySelectorAll("[data-view]")
    .forEach((n) => n.classList.toggle("active", n.dataset.view === view));
  $("breadcrumb").textContent = document.querySelector(
    `[data-view="${view}"] span`,
  ).textContent;
}
document
  .querySelectorAll("[data-view], [data-go]")
  .forEach((b) => (b.onclick = () => show(b.dataset.view || b.dataset.go)));
document
  .querySelectorAll("[data-close]")
  .forEach((b) => (b.onclick = () => $(b.dataset.close).close()));
function empty(container, title, text) {
  const n = el("div", undefined, "empty");
  n.append(el("h3", title), el("p", text));
  container.append(n);
}
function sourceLink(url, title) {
  const link = el("a", title);
  try {
    const parsed = new URL(url);
    if (["http:", "https:"].includes(parsed.protocol)) {
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
  } catch {}
  return link;
}
function renderContacts() {
  const body = $("contacts-body");
  body.replaceChildren();
  const query = $("contact-search").value.toLowerCase(),
    status = $("contact-filter").value;
  const contacts = data.contacts.filter(
    (c) =>
      `${c.companyName} ${c.email} ${c.roleTitle}`
        .toLowerCase()
        .includes(query) &&
      (status === "all" || c.reviewStatus === status),
  );
  for (const contact of contacts) {
    const row = el("tr"),
      name = el("td"),
      role = el("td"),
      source = el("td"),
      state = el("td"),
      actions = el("td");
    name.append(el("strong", contact.companyName), el("small", contact.email));
    role.append(
      el(
        "small",
        data.categories?.find((c) => c.id === contact.categoryId)?.name ||
          "Allgemein",
      ),
      el("span", contact.roleTitle || "Rolle offen"),
      el(
        "small",
        `${contact.countryCode || "Land offen"} · Fit ${contact.fitTier || "offen"}`,
      ),
    );
    source.append(
      sourceLink(contact.sourceUrl, "Kontaktquelle ↗"),
      el(
        "small",
        new Date(contact.sourceCheckedAt).toLocaleDateString("de-DE"),
      ),
    );
    state.append(
      el(
        "span",
        labels[contact.reviewStatus] || contact.reviewStatus,
        `tag ${contact.reviewStatus === "needs_review" ? "amber" : ""}`,
      ),
    );
    if (contact.authorized) state.append(el("small", "Nachweis hinterlegt"));
    if (contact.isTestData) state.append(el("small", "Testdaten"));
    actions.append(
      button("Personalisieren", () => {
        const form = $("profile-form");
        form.reset();
        $("profile-id").value = contact.id;
        $("profile-email").textContent = contact.email;
        fillCategories($("profile-category"), contact.categoryId);
        for (const key of [
          "firstName",
          "lastName",
          "honorific",
          "executionIntro",
          "introSourceUrl",
        ])
          form.elements[key].value =
            contact[key] || (key === "honorific" ? "neutral" : "");
        form.elements.introVerified.checked = Boolean(contact.introVerifiedAt);
        form.elements.language.value=contact.language || '';
        form.elements.introLanguage.value=contact.introLanguage || 'de';
        form.elements.isTestData.checked = contact.isTestData;
        $("profile-dialog").showModal();
      }),
      button("Mailvorschau", async () => {
        const preview = await api(`/v1/contacts/${contact.id}/preview`, {});
        selectedMessage = null;
        $("preview-recipient").textContent =
          `An: ${preview.recipientAddress} · Vorschau, nicht versendet`;
        $("preview-subject").textContent = preview.subject;
        $("preview-body").textContent = preview.bodyText;
        $("preview-logo").hidden = !preview.logoSha256;
        if(preview.logoSha256) $('preview-logo').src=logoUrl(preview.logoSha256);
        $("preview-fallbacks").textContent =
          fallbackNote(preview.fallbacks) +
          (preview.signatureMissing ? " · Signatur fehlt noch." : "") +
          (preview.isTestData ? " · Synthetische Testdaten." : "");
        $("approve-message").hidden = true;
        $("message-dialog").showModal();
      }),
    );
    if (contact.reviewStatus !== "suppressed") {
      actions.append(
        button("Prüfen", () => {
          $("review-form").reset();
          $("review-id").value = contact.id;
          $("review-contact").textContent =
            `${contact.companyName} · ${contact.email}`;
          $("review-evidence").textContent = contact.executionEvidence;
          $("review-expiry").value = new Date(Date.now() + 30 * 86400000)
            .toISOString()
            .slice(0, 10);
          $("review-dialog").showModal();
        }),
        button("Sperren", async () => {
          if (
            !confirm(`${contact.email} sperren und offene Sequenzen stoppen?`)
          )
            return;
          await api(`/v1/contacts/${contact.id}/suppress`, {
            reason: "Manuelle Sperre in der lokalen Oberfläche",
          });
          await refresh();
          note("Kontakt gesperrt.");
        }),
      );
    }
    row.append(name, role, source, state, actions);
    body.append(row);
  }
  $("contacts-empty").hidden = contacts.length > 0;
}
function renderCampaigns() {
  const list = $("campaign-list");
  list.replaceChildren();
  if (!data.campaigns.length)
    empty(
      list,
      "Deine erste Kampagne beginnt hier.",
      "Lege eine Vorlage und klare Regeln an. Eine Kampagne startet immer ohne Versand.",
    );
  for (const campaign of data.campaigns) {
    const card = el("article", undefined, "panel");
    card.append(
      el("span", "KEIN LIVEVERSAND", "tag amber"),
      el("h3", campaign.name),
      el(
        "small",
        data.categories?.find((c) => c.id === campaign.categoryId)?.name ||
          "Ältere Kampagne: alle Kategorien",
      ),
      el(
        "p",
        `${campaign.targetCountries.join(", ")} · ${campaign.dailyInitialLimit} neue / ${campaign.dailyTotalLimit} gesamt pro Tag`,
      ),
      el(
        "p",
        `Vorbereitung: ${campaign.preparationMode === "automatic" ? "automatisch alle 30 Sekunden" : "manuell"}`,
      ),
    );
    card.append(
      button("Vorschauen vorbereiten", async () => {
        const result = await api(`/v1/campaigns/${campaign.id}/prepare`, {});
        await refresh();
        note(
          `${result.prepared} Nachrichten vorbereitet. Nur geprüfte Kontakte ohne bisherige Sequenz werden berücksichtigt.`,
        );
      }),
      button(
        campaign.preparationMode === "automatic"
          ? "Automatik pausieren"
          : "Vorbereitung automatisieren",
        async () => {
          const enable = campaign.preparationMode !== "automatic";
          if (
            enable &&
            !confirm(
              "Neue, bereits geprüfte Kontakte mit gültiger Versandgrundlage automatisch mit dieser Vorlage vorbereiten und den Inhalt freigeben? Kein Versand wird aktiviert.",
            )
          )
            return;
          await api(`/v1/campaigns/${campaign.id}/automation`, {
            enabled: enable,
            confirmation: "PREPARATION_ONLY_NO_SEND",
          });
          await refresh();
          note("Vorbereitungsregel gespeichert. Versand bleibt aus.");
        },
      ),
    );
    list.append(card);
  }
}
function renderMessages() {
  const body = $("messages-body");
  body.replaceChildren();
  $("messages-empty").hidden = data.messages.length > 0;
  for (const message of data.messages) {
    const row = el("tr"),
      recipient = el("td", message.recipientAddress),
      subject = el("td"),
      state = el("td"),
      actions = el("td");
    subject.append(
      el("strong", message.finalSubject),
      el("small", message.campaignName),
    );
    state.append(el("span", labels[message.status] || message.status, "tag"));
    actions.append(
      button("Ansehen →", () => {
        selectedMessage = message;
        $("preview-recipient").textContent = `An: ${message.recipientAddress}`;
        $("preview-subject").textContent = message.finalSubject;
        $("preview-body").textContent = message.finalBodyText;
        $("preview-logo").hidden = !message.logoSha256;
        if(message.logoSha256) $('preview-logo').src=logoUrl(message.logoSha256);
        $("preview-fallbacks").textContent = fallbackNote(
          message.personalizationFallbacks,
        );
        $("approve-message").hidden = message.status !== "awaiting_approval";
        $("message-dialog").showModal();
      }),
    );
    row.append(recipient, subject, state, actions);
    body.append(row);
  }
}
async function refresh() {
  await refreshAutopilot();
  const [fresh, system] = await Promise.all([
    api("/v1/console"),
    api("/v1/system/status"),
  ]);
  data = fresh;
  $("metric-contacts").textContent = data.totals.contacts;
  $("nav-count").textContent = data.totals.contacts;
  $("metric-reviewed").textContent = data.totals.reviewed;
  $("metric-messages").textContent = data.totals.messages;
  consoleOffset=data.page.limit;
  $('load-more-records').disabled=Math.max(data.contacts.length,data.campaigns.length,data.messages.length,data.imports.length,data.audit.length)<data.page.limit;
  $("pause-state").textContent = system.control?.globallyPaused
    ? "Global pausiert"
    : system.runtime.liveSendEnabled ? 'Versandbedingungen werden laufend geprüft' : "Lokale Versandsperre aktiv";
  const live=system.runtime.liveSendEnabled&&!system.control?.globallyPaused&&autopilotState.settings.mode==='live'&&!autopilotState.settings.paused;
  $('live-active').textContent=live?'Aktiv':'Aus';
  $('overview-send-state').textContent=live?'Live aktiviert':'Versand gesperrt';
  $('overview-safety-title').textContent=live?'Livebetrieb unter Versandkontrollen.':'Sicher vorbereiten. Noch nicht versenden.';
  renderContacts();
  renderCampaigns();
  renderMessages();
  renderCategories();
  $("activity").replaceChildren();
  if (!data.audit.length)
    empty(
      $("activity"),
      "Noch keine Aktivitäten",
      "Importe, Prüfungen und Freigaben erscheinen hier.",
    );
  for (const entry of data.audit.slice(0, 6)) {
    const n = el("div", entry.eventType);
    n.append(
      el(
        "small",
        `${new Date(entry.occurredAt).toLocaleString("de-DE")} · ${entry.actorId}`,
      ),
    );
    $("activity").append(n);
  }
  $("import-history").replaceChildren();
  if (!data.imports.length)
    empty(
      $("import-history"),
      "Noch kein Import",
      "Wiederholungen mit derselben Lauf-ID erzeugen keine neuen Kontakte.",
    );
  for (const batch of data.imports) {
    const n = el("div", batch.externalId);
    n.append(
      el(
        "small",
        `${batch.importedCount} neu · ${batch.duplicateCount} Dubletten · ${batch.blockedCount} gesperrt`,
      ),
    );
    $("import-history").append(n);
  }
}
$("refresh").onclick = () => action(refresh);
$("contact-search").oninput = renderContacts;
$("contact-filter").onchange = renderContacts;
$("pause").onclick = () =>
  action(async () => {
    await api("/v1/system/pause", {
      reason: "Globale Pause über lokale Oberfläche",
      actor: "local-admin",
    });
    await refresh();
    note("Alle Kampagnen global pausiert.");
  });
$("sample-import").onclick = () => {
  $("import-json").value = JSON.stringify(
    {
      externalId: `synthetic-example-${new Date().toISOString().slice(0, 10)}`,
      source: "manual",
      contacts: [
        {
          companyName: "Beispiel Wertpapierfirma – Testdaten",
          domain: "demo-broker.example",
          countryCode: "DE",
          fitTier: "A",
          email: "compliance@demo-broker.example",
          firstName: "Test",
          roleTitle: "Compliance",
          sourceUrl: "https://demo-broker.example/team",
          sourceCheckedAt: `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`,
          executionEvidence:
            "Ausschließlich synthetische Testdaten, kein tatsächlich recherchiertes Unternehmen.",
          executionEvidenceUrl: "https://demo-broker.example/services",
        },
      ],
    },
    null,
    2,
  );
};
$("import-file").onchange = () =>
  action(async () => {
    const file = $("import-file").files[0];
    if (!file) return;
    if (file.size > 900000)
      throw new Error("Bitte eine JSON-Datei unter 900 KB auswählen.");
    $("import-json").value = await file.text();
  });
$("import-form").onsubmit = (event) => {
  event.preventDefault();
  action(async () => {
    const result = await api("/v1/imports", JSON.parse($("import-json").value));
    $("import-result").textContent =
      `${result.importedCount} neu · ${result.duplicateCount} Dubletten · ${result.blockedCount} gesperrt${result.replayed ? " · bereits verarbeiteter Lauf" : ""}`;
    $("import-result").hidden = false;
    await refresh();
    note("Import abgeschlossen. Keine Versandfreigabe erteilt.");
  });
};
$("review-form").onsubmit = (event) => {
  event.preventDefault();
  action(async () => {
    await api(`/v1/contacts/${$("review-id").value}/authorize`, {
      basis: $("review-basis").value,
      evidence: $("review-reference").value,
      validUntil: new Date(
        `${$("review-expiry").value}T23:59:59`,
      ).toISOString(),
      confirmation: "VERIFY_OUTREACH_BASIS",
    });
    $("review-dialog").close();
    await refresh();
    note("Prüfung und Versandgrundlage dokumentiert.");
  });
};
function fillCategories(select, value = "general") {
  select.replaceChildren(
    ...data.categories.map((c) => {
      const option = el("option", c.name);
      option.value = c.id;
      return option;
    }),
  );
  select.value = value;
}
function fallbackNote(keys = []) {
  const names = {
    salutation: "neutrale Anrede",
    company: "neutraler Firmenbezug",
    executionIntro: "neutraler Einstieg",
    evidence: "neutraler Einstieg",
    firstName: "Vorname",
    lastName: "Nachname",
    role: "Rolle",
  };
  return keys.length
    ? `Ersatztexte verwendet: ${keys.map((k) => names[k] || k).join(", ")}`
    : "Alle verwendeten Angaben vorhanden.";
}
function renderCategories() {
  const signature=data.senderSignature;
  $('sender-signature-form').elements.signatureText.value=signature.signatureText;
  $('sender-signature-form').elements.useLogo.checked=signature.useLogo;
  pendingLogoFile=null;
  if(pendingLogoUrl) URL.revokeObjectURL(pendingLogoUrl);
  pendingLogoUrl=null;
  $('signature-logo-file').value='';
  updateSignaturePreview();
  $('sender-signature-status').textContent=signature.id?`Zentrale Signatur · Version ${signature.version} · gilt für alle neuen Entwürfe.`:'Noch keine zentrale Signatur. Nachrichtenvorbereitung bleibt gesperrt.';
  $("category-list").replaceChildren();
  for (const category of data.categories) {
    const card = el("article", undefined, "panel");
    card.append(
      el("h3", category.name),
      el("p", category.subjectTemplate),
      el(
        "small",
        `${data.contacts.filter((c) => c.categoryId === category.id).length} Kontakte · ${signature.id ? "Zentrale Signatur" : "Zentrale Signatur fehlt"}`,
      ),
      button("Standardmail bearbeiten", () => {
        $("category-id").value = category.id;
        const f = $("category-form");
        f.elements.name.value = category.name;
        f.elements.subject.value = category.subjectTemplate;
        f.elements.body.value = category.bodyTemplate;
        $("category-dialog").showModal();
      }),
    );
    $("category-list").append(card);
  }
}
function useCategory() {
  const category = data.categories.find(
    (c) => c.id === $("campaign-category").value,
  );
  const form = $("campaign-form");
  form.elements.subject.value = category.subjectTemplate;
  form.elements.body.value = category.bodyTemplate;
}
$("new-campaign").onclick = () => {
  $("campaign-form").reset();
  fillCategories($("campaign-category"));
  useCategory();
  $("campaign-dialog").showModal();
};
$("campaign-category").onchange = useCategory;
$("category-form").onsubmit = (event) => {
  event.preventDefault();
  action(async () => {
    await api(`/v1/categories/${$("category-id").value}`, {
      ...Object.fromEntries(new FormData(event.target)),
    });
    $("category-dialog").close();
    await refresh();
    note(
      "Standardmail gespeichert. Bestehende Kampagnen und Nachrichten bleiben unverändert.",
    );
  });
};
$("profile-form").onsubmit = (event) => {
  event.preventDefault();
  action(async () => {
    const fields = Object.fromEntries(new FormData(event.target));
    await api(`/v1/contacts/${$("profile-id").value}/profile`, {
      ...fields,
      language:fields.language || null,
      introVerified: event.target.elements.introVerified.checked,
      isTestData: event.target.elements.isTestData.checked,
    });
    $("profile-dialog").close();
    await refresh();
    note("Personalisierung gespeichert. Keine Versandfreigabe erteilt.");
  });
};
$("campaign-form").onsubmit = (event) => {
  event.preventDefault();
  action(async () => {
    const fields = Object.fromEntries(new FormData(event.target));
    await api("/v1/campaigns", {
      ...fields,
      countries: fields.countries
        .split(",")
        .map((x) => x.trim().toUpperCase())
        .filter(Boolean),
      initialLimit: Number(fields.initialLimit),
      totalLimit: Number(fields.totalLimit),
      confirmation: "APPROVE_TEMPLATE_ONLY",
    });
    $("campaign-dialog").close();
    event.target.reset();
    await refresh();
    note("Kampagne gespeichert. Versand bleibt aus.");
  });
};
$("approve-message").onclick = () =>
  action(async () => {
    if (!selectedMessage) return;
    await api(`/v1/messages/${selectedMessage.id}/approve`, {
      contentSha256: selectedMessage.contentSha256,
    });
    $("message-dialog").close();
    await refresh();
    note("Genauer Nachrichteninhalt freigegeben. Kein Versand ausgelöst.");
  });
action(async () => {
  try { await api("/local/session", {}); } catch { show('autopilot');note('Bitte zuerst mit dem Betreiberpasswort anmelden.');return; }
  await refresh();
});

let autopilotState=null,libraryVersion=null,exceptionOffset=0,runOffset=0,legalOffset=0;
let consoleOffset=0;
$('load-more-records').onclick=()=>action(async()=> {
  const next=await api(`/v1/console?limit=100&offset=${consoleOffset}`);consoleOffset+=100;
  for(const key of ['contacts','campaigns','messages','imports','audit']) data[key].push(...next[key]);
  renderContacts();renderCampaigns();renderMessages();
  $('load-more-records').disabled=Math.max(...['contacts','campaigns','messages','imports','audit'].map(k=>next[k].length))<100;
  note(`${data.contacts.length} von ${data.totals.contacts} Kontakten geladen. Die Suche filtert die geladenen Einträge.`);
});
const blockerNames={
  shared_signature_missing:'Die zentrale Absendersignatur fehlt',
  operator_login_not_configured:'Betreiberpasswort noch nicht eingerichtet',runtime_live_send_disabled:'Microsoft-Liveversand ist in der Laufzeit deaktiviert',
  MAILBOX_CONNECTION_ID_required:'Geprüfte Postfachverbindung noch nicht hinterlegt',autopilot_mailbox_not_bound:'Autopilot noch nicht an das geprüfte Postfach gebunden',
  certificate_auth_required:'Zertifikatanmeldung für diesen Betrieb noch nicht eingerichtet',sixteen_templates_not_approved:'Die 16 Sprach-/Sequenzvorlagen sind noch nicht vollständig freigegeben',
  previous_outreach_not_reconciled:'Frühere Anschreiben müssen zuerst abgeglichen werden',startup_reconciliation_required:'Postfachabgleich nach Start noch offen',
  mailbox_sync_incomplete_or_stale:'Postfachabgleich fehlt, läuft noch oder ist veraltet',uncertain_provider_operations:'Unklarer Microsoft-Vorgang muss geklärt werden',
  no_reviewed_country_send_rule:'Keine geprüfte länderspezifische Versandregel vorhanden',
  autopilot_campaign_not_prepared:'Der Hintergrundplaner muss zuerst die Autopilot-Kampagne vorbereiten',
  mailbox_identity_evidence_expired_or_missing:'Postfachnachweis fehlt in dieser Laufzeit oder muss erneuert werden',
  previous_outreach_status_uncertain:'Frühere Recherche/Vorbereitung – vor neuem Erstanschreiben prüfen',previously_contacted:'Bereits kontaktiert – keine neue Erstmail',
  'check_missing:shadow_day':'Ein vollständiger Schattenlauf fehlt','check_missing:own_address_threading_logo_reply_unsubscribe':'Funktionstest mit eigenen Adressen fehlt',
  'check_missing:backup_restore':'Wiederherstellungstest noch nicht bestätigt','check_missing:mailbox_scope':'Postfachbeschränkung noch nicht bestätigt','check_missing:pilot_review':'Pilotprüfung noch offen',
};
async function refreshAutopilot() {
  const [state,preflight,templates]=await Promise.all([api('/v1/autopilot'),api('/v1/autopilot/preflight'),api('/v1/templates/versions?limit=100')]);
  autopilotState=state;
  $('operator-setup').hidden=!preflight.blockers.includes('operator_login_not_configured');
  const modes={simulator:'Simulator',shadow:'Schattenbetrieb',live:'Livebetrieb'};
  $('runtime-mode').textContent=modes[state.settings.mode];$('runtime-note').textContent=state.settings.paused?'Versand pausiert. Keine automatische Wiederaufnahme.':state.settings.mode==='live'?'Versand nur nach erneuter Prüfung aller Voraussetzungen.':'Keine ausgehenden Mailoperationen.';
  const reason=state.settings.pauseReason==='Runtime startup: reconciliation required'?'Nach Start: Postfachabgleich erforderlich':state.settings.pauseReason;
  $('autopilot-state').textContent=`${modes[state.settings.mode]} · ${state.settings.paused?'pausiert':'aktiv'} · Tagesgrenze ${Math.min(state.settings.dailyTarget,state.settings.pilotLimit,50)} · ${reason}`;
  const metrics=$('autopilot-metrics');metrics.replaceChildren();
  for(const [label,value] of [['Firmen',state.coverage.companies],['Kontaktprüfung offen',state.coverage.missingContacts],['Versandgrundlage fehlt',state.coverage.missingBasis],['Klärungsfälle',state.exceptions]]) {const card=el('article');card.append(el('p',label),el('strong',value));metrics.append(card);}
  $('autopilot-blockers').replaceChildren(...[...preflight.blockers,...preflight.warnings].map(code=>el('li',blockerNames[code]||code)));
  if(preflight.ready) $('autopilot-blockers').append(el('li','Betriebsprüfung bestanden. Aktivierung bleibt eine ausdrückliche Betreiberentscheidung.'));
  const form=$('autopilot-settings');
  for(const key of ['mode','mailboxConnectionId','dailyTarget','pilotLimit']) form.elements[key].value=state.settings[key]??'';
  form.elements.researchEnabled.checked=state.settings.researchEnabled;
  $('autopilot-activate').disabled=!preflight.ready||state.settings.mode!=='live';
  const container=$('autopilot-templates');container.replaceChildren();
  const categoryNames={bank:'Banken',broker:'Broker & Wertpapierfirmen',asset_manager:'Asset Manager',general:'Allgemein'};
  for(const t of templates.items) container.append(button(`${categoryNames[t.categoryId]} · ${t.language.toUpperCase()} · ${t.step?'Nachfrage':'Erstmail'} · v${t.version} · ${labels[t.status]||t.status}`,()=> {
    libraryVersion=t;const f=$('library-form');for(const key of ['subject','body','targetingMode']) f.elements[key].value=t[key];
    $('library-signature-preview').textContent=data.senderSignature.signatureText||'Zentrale Signatur noch nicht hinterlegt.';
    $('library-title').textContent=`${t.categoryId} · ${t.language.toUpperCase()} · ${t.step?'Nachfrage':'Erstmail'}`;
    $('library-status').textContent=`Version ${t.version}: ${labels[t.status]||t.status}. Freigabe gilt ausschließlich für den gespeicherten Inhalt.`;
    $('library-approve').disabled=t.status!=='draft';$('library-dialog').showModal();
  }));
  await Promise.all([loadExceptions(true),loadRuns(true),loadLegalResearch(true)]);
}
async function loadLegalResearch(reset=false) {
  const container=$('legal-research');if(reset) {legalOffset=0;container.replaceChildren();}
  const page=await api(`/v1/autopilot/legal-research?limit=20&offset=${legalOffset}`);
  const labels={evidence_required:'Nachweis erforderlich',conditional_b2b_review:'B2B-Sonderweg · Prüfung offen',not_researched:'Noch nicht recherchiert'};
  for(const item of page.items) {
    const details=el('details'),r=item.research;
    details.append(el('summary',`${item.countryCode||'Land fehlt'} · ${item.companies} Firmen · ${item.contacts} Kontakte · ${labels[r.status]}`));
    details.append(el('p',r.summary),el('p',`${item.documentedBasis} Kontakte mit dokumentierter Länderbasis (keine Versandreife). Quellenstand: ${r.checkedOn||'offen'}.`));
    const list=el('ul');for(const requirement of r.requirements) list.append(el('li',requirement));details.append(list);
    for(const source of r.sources) {const link=el('a',source.title);link.href=source.url;link.target='_blank';link.rel='noopener noreferrer';const p=el('p');p.append(link);details.append(p);}
    container.append(details);
  }
  legalOffset+=page.items.length;$('legal-next').disabled=legalOffset>=page.total;
}
$('legal-next').onclick=()=>action(()=>loadLegalResearch());
async function loadExceptions(reset=false) {if(reset) {exceptionOffset=0;$('autopilot-exceptions').replaceChildren();}const page=await api(`/v1/exceptions?limit=50&offset=${exceptionOffset}`);for(const item of page.items) $('autopilot-exceptions').append(el('p',`${item.companyName||'Betrieb'} · ${blockerNames[item.code]||item.code} · ${new Date(item.createdAt).toLocaleDateString('de-DE')}`));exceptionOffset+=page.items.length;$('exceptions-next').disabled=page.items.length<50;}
async function loadRuns(reset=false) {if(reset) {runOffset=0;$('autopilot-runs').replaceChildren();}const page=await api(`/v1/research/runs?limit=50&offset=${runOffset}`);for(const item of page.items) $('autopilot-runs').append(el('p',`${item.kind} · ${item.status} · ${new Date(item.startedAt).toLocaleString('de-DE')}${item.error?` · ${item.error}`:''}`));runOffset+=page.items.length;$('runs-next').disabled=page.items.length<50;}
$('exceptions-next').onclick=()=>action(()=>loadExceptions());$('runs-next').onclick=()=>action(()=>loadRuns());
function updateSignaturePreview() {
  const f=$('sender-signature-form').elements;
  $('signature-text-preview').textContent=f.signatureText.value;
  $('signature-logo-preview').src=pendingLogoUrl || logoUrl(data.senderSignature.selectedLogoSha256);
  $('signature-logo-preview').hidden=!f.useLogo.checked;
  $('signature-logo-status').textContent=pendingLogoFile
    ? `${pendingLogoFile.name} · ausgewählt, noch nicht gespeichert.`
    : 'Hinterlegtes Logo. Zum Ersetzen eine PNG-Datei auswählen und die Signatur speichern.';
}
$('signature-logo-file').onchange=event=>action(async()=>{
  const file=event.target.files[0];
  if(pendingLogoUrl) URL.revokeObjectURL(pendingLogoUrl);
  pendingLogoFile=null;pendingLogoUrl=null;
  if(file && (file.size>500_000 || !file.size || (file.type!=='image/png' && !file.name.toLowerCase().endsWith('.png')))) {
    event.target.value='';updateSignaturePreview();throw new Error('Bitte eine PNG-Datei mit maximal 500 KB auswählen.');
  }
  if(file) {pendingLogoFile=file;pendingLogoUrl=URL.createObjectURL(file);$('sender-signature-form').elements.useLogo.checked=true;}
  updateSignaturePreview();
});
$('sender-signature-form').elements.signatureText.oninput=updateSignaturePreview;
$('sender-signature-form').elements.useLogo.onchange=updateSignaturePreview;
$('sender-signature-form').onsubmit=event=>{
  event.preventDefault();
  const form=event.target,submit=form.querySelector('button[type="submit"]');
  action(async()=>{
    submit.disabled=true;
    try {
      const f=form.elements;
      const payload={revision:data.senderSignature.revision,signatureText:f.signatureText.value,useLogo:f.useLogo.checked,actor:f.actor.value,confirmation:'SAVE_SHARED_SIGNATURE'};
      if(pendingLogoFile) payload.logoBase64=await new Promise((resolve,reject)=>{
        const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);
        reader.onerror=()=>reject(new Error('Logo konnte nicht gelesen werden.'));reader.readAsDataURL(pendingLogoFile);
      });
      await api('/v1/sender-signature',payload);await refresh();
      note('Signatur und Logo gespeichert. Alle neuen Entwürfe übernehmen sie; bestehende Nachrichten bleiben unverändert.');
    } finally {submit.disabled=false;}
  });
};
$('operator-login').onsubmit=event=> {event.preventDefault();action(async()=>{await api('/local/operator/login',{password:event.target.elements.password.value});event.target.reset();await refresh();note('Betreiberanmeldung erfolgreich. Versand unverändert.');});};
$('operator-setup').onsubmit=event=> {event.preventDefault();action(async()=>{const fields=event.target.elements;if(fields.password.value!==fields.repeat.value) throw new Error('Die beiden Passwörter stimmen nicht überein.');await api('/local/operator/setup',{password:fields.password.value,confirmation:'CREATE_LOCAL_OPERATOR'});event.target.reset();await refresh();note('Passwort eingerichtet. Jetzt anmelden; vor dem Schattenbetrieb den lokalen Supervisor neu starten. Keine Versandaktivierung.');});};
$('autopilot-settings').onsubmit=event=> {event.preventDefault();action(async()=>{const f=event.target.elements;await api('/v1/autopilot/configure',{version:autopilotState.settings.version,mode:f.mode.value,researchEnabled:f.researchEnabled.checked,mailboxConnectionId:f.mailboxConnectionId.value.trim()||null,dailyTarget:Number(f.dailyTarget.value),pilotLimit:Number(f.pilotLimit.value),actor:f.actor.value,confirmation:'SAVE_PAUSED_CONFIGURATION'});await refresh();note('Einstellungen gespeichert. Versand bleibt pausiert.');});};
$('autopilot-pause').onclick=()=>action(async()=>{await api('/v1/autopilot/pause',{actor:$('autopilot-settings').elements.actor.value,reason:'Manuelle Pause im Dashboard'});await refresh();});
$('autopilot-activate').onclick=()=>action(async()=>{if(!confirm('Livebetrieb ausdrücklich aktivieren? Geprüfte Nachrichten können anschließend versendet werden.')) return;await api('/v1/autopilot/activate',{version:autopilotState.settings.version,actor:$('autopilot-settings').elements.actor.value,confirmation:'ACTIVATE_LIVE_AUTOPILOT'});await refresh();});
$('library-form').onsubmit=event=> {event.preventDefault();action(async()=>{const f=event.target.elements;await api('/v1/templates/versions',{categoryId:libraryVersion.categoryId,language:libraryVersion.language,step:libraryVersion.step,subject:f.subject.value,body:f.body.value,targetingMode:f.targetingMode.value});$('library-dialog').close();await refresh();note('Neue Entwurfsversion gespeichert. Noch nicht freigegeben.');});};
$('library-approve').onclick=()=>action(async()=> {
  const f=$('library-form').elements;if(['subject','body','targetingMode'].some(k=>f[k].value!==libraryVersion[k])) throw new Error('Änderungen zuerst als neue Version speichern und anschließend öffnen.');
  if(!confirm(libraryVersion.targetingMode==='category_only'?'Neutrale Kategorievorlage freigeben? Bestätige, dass der Text keine unbelegten Pflichten oder Tätigkeiten des Empfängers behauptet. Die Versandgrundlage bleibt separat erforderlich.':'Genau diese gespeicherte Vorlage für automatische Vorbereitung freigeben?')) return;
  await api(`/v1/templates/versions/${libraryVersion.id}/approve`,{actor:$('autopilot-settings').elements.actor.value,confirmation:'APPROVE_TEMPLATE_VERSION'});$('library-dialog').close();await refresh();
});
