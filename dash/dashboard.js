const today = new Date();
today.setHours(0, 0, 0, 0);

const REVIEW_FILTERS = [
  { value: "relevant", label: "Relevant", match: (label) => label !== "eher unpassend" },
  { value: "passt gut", label: "Passt gut", match: (label) => label === "passt gut" },
  { value: "pruefen", label: "Prüfen", match: (label) => label === "pruefen" },
  { value: "eher unpassend", label: "Eher unpassend", match: (label) => label === "eher unpassend" },
  { value: "ungeprueft", label: "Ungeprüft", match: (label) => label === "ungeprueft" },
  { value: "", label: "Alle", match: () => true }
];

const REVIEW_RANK = { "passt gut": 0, pruefen: 1, ungeprueft: 2, "eher unpassend": 3 };

const COUNTRY_CODES = {
  "Österreich": "AT",
  Tschechien: "CZ",
  Slowakei: "SK",
  Ungarn: "HU",
  Slowenien: "SI",
  Deutschland: "DE"
};

let dataRecords = [];
let reviewFilter = "relevant";

function simpleHash(value) {
  const text = String(value || "");
  let hash = 0;

  for (let index = 0; index < text.length; index += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(index);
    hash |= 0;
  }

  return `rk-${Math.abs(hash)}`;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function repairMojibake(value) {
  return String(value || "")
    .replace(/Ã„/g, "Ä")
    .replace(/Ã¤/g, "ä")
    .replace(/Ã–/g, "Ö")
    .replace(/Ã¶/g, "ö")
    .replace(/Ãœ/g, "Ü")
    .replace(/Ã¼/g, "ü")
    .replace(/ÃŸ/g, "ß")
    .replace(/Â·/g, "·")
    .replace(/Â/g, "");
}

function prettifyGermanText(value) {
  return repairMojibake(value)
    .replace(/\bFuer\b/g, "Für")
    .replace(/\bfuer\b/g, "für")
    .replace(/\bOeffnen\b/g, "Öffnen")
    .replace(/\boeffnen\b/g, "öffnen")
    .replace(/\bnoetig\b/g, "nötig")
    .replace(/\bNoetig\b/g, "Nötig")
    .replace(/\bEintraege\b/g, "Einträge")
    .replace(/\beintraege\b/g, "einträge")
    .replace(/\bVeroeffentlicht\b/g, "Veröffentlicht")
    .replace(/\bVeroeffentlichung\b/g, "Veröffentlichung")
    .replace(/\bveroeffentlicht\b/g, "veröffentlicht")
    .replace(/\bveroeffentlichung\b/g, "veröffentlichung")
    .replace(/\bPruefen\b/g, "Prüfen")
    .replace(/\bpruefen\b/g, "prüfen")
    .replace(/\bUngeprueft\b/g, "Ungeprüft")
    .replace(/\bungeprueft\b/g, "ungeprüft")
    .replace(/\bgeprueft\b/g, "geprüft")
    .replace(/\bbestaetigen\b/g, "bestätigen")
    .replace(/\bBestaetigen\b/g, "Bestätigen")
    .replace(/\bEinschaetzung\b/g, "Einschätzung")
    .replace(/\beinschaetzung\b/g, "einschätzung");
}

function normalizeTextField(value) {
  return prettifyGermanText(value).trim();
}

function normalizeRecord(record) {
  const normalized = { ...record };

  [
    "recordKey",
    "portal",
    "suchbegriff",
    "titel",
    "auftraggeber",
    "frist",
    "link",
    "beschreibung",
    "veroeffentlichungsdatum",
    "organisationLand",
    "reviewReason",
    "reviewProvider",
    "reviewModel",
    "reviewedAt"
  ].forEach((field) => {
    if (typeof normalized[field] === "string") {
      normalized[field] = normalizeTextField(normalized[field]);
    }
  });

  normalized.recordKey =
    normalized.recordKey ||
    normalized.link ||
    simpleHash([normalized.portal, normalized.titel, normalized.auftraggeber].join("|"));
  normalized.reviewLabel = String(normalized.reviewLabel || "ungeprueft").trim().toLowerCase();
  normalized.reviewReason = String(normalized.reviewReason || "").trim();
  normalized.reviewScore = Number.isFinite(Number(normalized.reviewScore))
    ? Number(normalized.reviewScore)
    : null;
  normalized.cpvCodes = Array.isArray(normalized.cpvCodes)
    ? normalized.cpvCodes.map((value) => normalizeTextField(value)).filter(Boolean)
    : String(normalized.cpvCodes || "")
        .split(";")
        .map((value) => normalizeTextField(value))
        .filter(Boolean);

  // TED-Titel haben die Form "Land – CPV-Bezeichnung – eigentlicher Titel".
  const tedParts = normalized.portal === "TED" ? normalized.titel.split(" – ") : [];
  normalized.displayTitle = tedParts.length >= 3 ? tedParts.slice(2).join(" – ") : normalized.titel;
  normalized.category = tedParts.length >= 3 ? tedParts[1] : "";
  normalized.countryCode =
    COUNTRY_CODES[normalized.organisationLand] ||
    (normalized.organisationLand ? normalized.organisationLand.slice(0, 3).toUpperCase() : "");
  return normalized;
}

function parseDate(value) {
  if (!value || !String(value).trim()) {
    return null;
  }

  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    const parsed = new Date(text.slice(0, 10));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const dotted = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (dotted) {
    return new Date(Number(dotted[3]), Number(dotted[2]) - 1, Number(dotted[1]));
  }

  const months = { Jan: 0, Feb: 1, Mar: 2, Mär: 2, Apr: 3, Mai: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Okt: 9, Nov: 10, Dez: 11 };
  const named = text.match(/(\d+)\s+(\w+)\.?\s+(\d{4})/);
  if (named && months[named[2]] !== undefined) {
    return new Date(Number(named[3]), months[named[2]], Number(named[1]));
  }

  return null;
}

function formatDate(value) {
  const parsed = parseDate(value);
  return parsed
    ? parsed.toLocaleDateString("de-AT", { day: "2-digit", month: "2-digit", year: "numeric" })
    : "";
}

function fristDays(value) {
  const parsed = parseDate(value);
  return parsed ? Math.round((parsed - today) / 86400000) : null;
}

function reviewTone(label) {
  return { "passt gut": "good", pruefen: "check", "eher unpassend": "bad" }[label] || "unknown";
}

function reviewText(label) {
  return { "passt gut": "Passt gut", pruefen: "Prüfen", "eher unpassend": "Eher unpassend" }[label] || "Ungeprüft";
}

function safeUrl(value) {
  const url = String(value || "");
  return /^https?:\/\//i.test(url) ? url : "";
}

function deadlineBlock(record) {
  const days = fristDays(record.frist);

  if (days === null) {
    return '<div class="deadline"><div class="deadline-label">Frist</div><div class="deadline-value none">keine Angabe</div></div>';
  }

  const soon = days <= 14;
  const daysText = days === 0 ? "heute" : days === 1 ? "morgen" : `in ${days} Tagen`;
  return `
    <div class="deadline">
      <div class="deadline-label">Frist</div>
      <div class="deadline-value${soon ? " soon" : ""}">${escapeHtml(formatDate(record.frist))}</div>
      <div class="deadline-days">${daysText}</div>
    </div>`;
}

function renderStats(records) {
  const count = (label) => records.filter((record) => record.reviewLabel === label).length;
  const soon = records.filter((record) => {
    const days = fristDays(record.frist);
    return days !== null && days <= 14 && record.reviewLabel !== "eher unpassend";
  }).length;
  const latest = records
    .map((record) => record.reviewedAt || record.scrapedAt)
    .filter(Boolean)
    .sort()
    .pop();
  const latestText = latest
    ? new Date(latest).toLocaleDateString("de-AT", { day: "2-digit", month: "2-digit", year: "numeric" })
    : "–";
  const countries = new Set(records.map((record) => record.countryCode).filter(Boolean)).size;

  document.getElementById("stats").innerHTML = `
    <div class="panel stat good"><div class="stat-label">Passt gut</div><div class="stat-value">${count("passt gut")}</div><div class="stat-sub">KI-Einschätzung</div></div>
    <div class="panel stat check"><div class="stat-label">Prüfen</div><div class="stat-value">${count("pruefen")}</div><div class="stat-sub">gemischte Signale</div></div>
    <div class="panel stat urgent"><div class="stat-label">Frist &lt; 14 Tage</div><div class="stat-value">${soon}</div><div class="stat-sub">relevante Einträge</div></div>
    <div class="panel stat"><div class="stat-label">Gesamt</div><div class="stat-value">${records.length}</div><div class="stat-sub">aus ${countries} Ländern</div></div>
    <div class="panel stat"><div class="stat-label">Datenstand</div><div class="stat-value small">${escapeHtml(latestText)}</div><div class="stat-sub">letzte Aktualisierung</div></div>
  `;

  document.getElementById("data-status").innerHTML = `<strong>Stand:</strong> ${escapeHtml(latestText)} · ${records.length} aktive Ausschreibungen`;
}

function renderPicks(records) {
  const picks = records
    .filter((record) => record.reviewLabel === "passt gut")
    .sort((left, right) => {
      const leftDays = fristDays(left.frist);
      const rightDays = fristDays(right.frist);
      if (leftDays === null && rightDays === null) return 0;
      if (leftDays === null) return 1;
      if (rightDays === null) return -1;
      return leftDays - rightDays;
    })
    .slice(0, 3);

  document.getElementById("picks-section").hidden = picks.length === 0;
  document.getElementById("picks").innerHTML = picks
    .map((record) => {
      const days = fristDays(record.frist);
      const fristText = days === null ? "keine Frist angegeben" : `Frist ${formatDate(record.frist)} (${days} Tage)`;
      const url = safeUrl(record.link);
      return `
        <a class="panel pick" href="${escapeHtml(url) || "#"}" target="_blank" rel="noopener">
          <div class="chips"><span class="chip country">${escapeHtml(record.countryCode)}</span><span class="chip">${escapeHtml(record.portal)}</span></div>
          <div class="pick-title">${escapeHtml(record.displayTitle)}</div>
          <div class="pick-meta">${escapeHtml(record.auftraggeber)} · ${escapeHtml(fristText)}</div>
          <div class="pick-reason">${escapeHtml(record.reviewReason)}</div>
        </a>`;
    })
    .join("");
}

function populateSelect(id, values, labelFor = (value) => value) {
  const select = document.getElementById(id);
  const first = select.options[0];
  select.innerHTML = "";
  select.appendChild(first);
  values.forEach((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = labelFor(value);
    select.appendChild(option);
  });
}

function populateFilters(records) {
  const countries = [...new Set(records.map((record) => record.organisationLand).filter(Boolean))].sort();
  const portals = [...new Set(records.map((record) => record.portal).filter(Boolean))].sort();
  populateSelect("f-country", countries, (value) => `${COUNTRY_CODES[value] || ""} · ${value}`);
  populateSelect("f-portal", portals);
}

function getFiltered(ignoreReview = false) {
  const country = document.getElementById("f-country").value;
  const portal = document.getElementById("f-portal").value;
  const frist = document.getElementById("f-frist").value;
  const query = document.getElementById("f-search").value.trim().toLowerCase();
  const reviewMatch = REVIEW_FILTERS.find((filter) => filter.value === reviewFilter)?.match || (() => true);

  return dataRecords.filter((record) => {
    if (!ignoreReview && !reviewMatch(record.reviewLabel)) return false;
    if (country && record.organisationLand !== country) return false;
    if (portal && record.portal !== portal) return false;

    const days = fristDays(record.frist);
    if (frist === "soon" && (days === null || days > 14)) return false;
    if (frist === "yes" && days === null) return false;
    if (frist === "no" && days !== null) return false;

    if (query) {
      const haystack = [
        record.titel,
        record.auftraggeber,
        record.beschreibung,
        record.reviewReason,
        record.suchbegriff,
        record.cpvCodes.join(" ")
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(query)) return false;
    }

    return true;
  });
}

function compareFrist(left, right) {
  const leftDays = fristDays(left.frist);
  const rightDays = fristDays(right.frist);
  if (leftDays === null && rightDays === null) return 0;
  if (leftDays === null) return 1;
  if (rightDays === null) return -1;
  return leftDays - rightDays;
}

function getSorted(records) {
  const mode = document.getElementById("f-sort").value;

  return [...records].sort((left, right) => {
    if (mode === "newest") {
      return String(right.veroeffentlichungsdatum).localeCompare(String(left.veroeffentlichungsdatum));
    }

    if (mode === "frist") {
      return compareFrist(left, right);
    }

    const rankDiff = (REVIEW_RANK[left.reviewLabel] ?? 9) - (REVIEW_RANK[right.reviewLabel] ?? 9);
    return rankDiff || compareFrist(left, right);
  });
}

function renderReviewFilter() {
  const base = getFiltered(true);
  document.getElementById("f-review").innerHTML = REVIEW_FILTERS.map((filter) => {
    const count = base.filter((record) => filter.match(record.reviewLabel)).length;
    const active = filter.value === reviewFilter ? " is-active" : "";
    return `<button type="button" class="seg${active}" data-value="${escapeHtml(filter.value)}">${escapeHtml(filter.label)}<span class="count">${count}</span></button>`;
  }).join("");
}

function tenderCard(record) {
  const tone = reviewTone(record.reviewLabel);
  const url = safeUrl(record.link);
  const titleHtml = url
    ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(record.displayTitle)}</a>`
    : escapeHtml(record.displayTitle);
  const published = formatDate(record.veroeffentlichungsdatum);
  const details = [];

  if (record.beschreibung) {
    details.push(`<p>${escapeHtml(record.beschreibung)}</p>`);
  }
  if (record.category) {
    details.push(`<p><b>Kategorie:</b> ${escapeHtml(record.category)}</p>`);
  }
  if (record.cpvCodes.length) {
    details.push(`<p><b>CPV:</b> ${escapeHtml(record.cpvCodes.join(", "))}</p>`);
  }
  if (record.suchbegriff) {
    details.push(`<p><b>Gefunden über:</b> ${escapeHtml(record.suchbegriff)}</p>`);
  }

  return `
    <article class="panel tender tone-${tone}">
      <div>
        <div class="chips">
          <span class="chip ${tone}">${escapeHtml(reviewText(record.reviewLabel))}</span>
          ${record.countryCode ? `<span class="chip country" title="${escapeHtml(record.organisationLand)}">${escapeHtml(record.countryCode)}</span>` : ""}
          <span class="chip">${escapeHtml(record.portal)}</span>
          ${published ? `<span class="tender-date">veröffentlicht ${escapeHtml(published)}</span>` : ""}
        </div>
        <h3 class="tender-title">${titleHtml}</h3>
        <div class="tender-buyer">${escapeHtml(record.auftraggeber)}</div>
        ${record.reviewReason ? `<div class="tender-reason"><b>KI:</b> ${escapeHtml(prettifyGermanText(record.reviewReason))}</div>` : ""}
        ${details.length ? `<details><summary>Details</summary>${details.join("")}</details>` : ""}
      </div>
      <div class="tender-side">
        ${deadlineBlock(record)}
        ${url ? `<a class="open-btn" href="${escapeHtml(url)}" target="_blank" rel="noopener">Öffnen &#8599;</a>` : ""}
      </div>
    </article>`;
}

function renderList() {
  const records = getSorted(getFiltered());
  renderReviewFilter();
  document.getElementById("result-count").textContent = `${records.length} Einträge`;
  document.getElementById("list").innerHTML = records.length
    ? records.map(tenderCard).join("")
    : '<div class="panel empty">Keine Einträge für diese Filter.</div>';
}

function registerEvents() {
  ["f-country", "f-portal", "f-frist", "f-sort"].forEach((id) => {
    document.getElementById(id).addEventListener("change", renderList);
  });
  document.getElementById("f-search").addEventListener("input", renderList);
  document.getElementById("f-review").addEventListener("click", (event) => {
    const button = event.target.closest("button.seg");
    if (!button) return;
    reviewFilter = button.dataset.value;
    renderList();
  });
}

function main() {
  const initialData = typeof DATA !== "undefined" ? DATA : window.DATA || [];

  dataRecords = initialData
    .map((record) => normalizeRecord(record))
    .filter((record) => {
      const days = fristDays(record.frist);
      return days === null || days >= 0;
    });

  populateFilters(dataRecords);
  renderStats(dataRecords);
  renderPicks(dataRecords);
  registerEvents();
  renderList();
}

main();
