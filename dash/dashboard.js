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
let sortCol = "reviewLabel";
let sortDir = 1;

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
  const originalTitle = tedParts.length >= 3 ? tedParts.slice(2).join(" – ") : normalized.titel;
  normalized.titelDe = String(normalized.titelDe || "").trim();
  normalized.beschreibungDe = String(normalized.beschreibungDe || "").trim();
  // Uebersetzungen der KI-Pruefung haben Vorrang; der Originaltitel bleibt als Hinweis sichtbar.
  normalized.displayTitle = normalized.titelDe || originalTitle;
  normalized.originalTitle = normalized.titelDe && normalized.titelDe !== originalTitle ? originalTitle : "";
  normalized.displayDescription = normalized.beschreibungDe || String(normalized.beschreibung || "");
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

const TERM_GROUPS = [
  { className: "term-planung", terms: ["raumplanung", "stadtplanung", "stadtentwicklung", "landschaftsplanung", "umweltplanung"] },
  { className: "term-region", terms: ["regionalentwicklung", "interreg", "smart village"] },
  { className: "term-studie", terms: ["evaluierung", "evaluation", "studie", "machbarkeit", "forschung", "erhebungen", "sozialforschung"] },
  { className: "term-mobil", terms: ["mobilität", "verkehr"] },
  { className: "term-klima", terms: ["klimaschutz", "klima", "energie"] }
];

function termClass(term) {
  const value = String(term || "").toLowerCase();
  if (!value || value === "dienstleistungen") return "term-allgemein";
  if (value.startsWith("cpv")) return "term-cpv";
  const group = TERM_GROUPS.find((entry) => entry.terms.some((needle) => value.includes(needle)));
  return group ? group.className : "term-andere";
}

function countryChip(record) {
  if (!record.countryCode) return "";
  return `<span class="chip country country-${escapeHtml(record.countryCode)}" title="${escapeHtml(record.organisationLand)}">${escapeHtml(record.countryCode)}</span>`;
}

function safeUrl(value) {
  const url = String(value || "");
  return /^https?:\/\//i.test(url) ? url : "";
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
          <div class="chips">${countryChip(record)}<span class="chip">${escapeHtml(record.portal)}</span></div>
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
        record.titelDe,
        record.auftraggeber,
        record.beschreibung,
        record.beschreibungDe,
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
  return [...records].sort((left, right) => {
    if (sortCol === "frist") {
      return compareFrist(left, right) * sortDir;
    }

    if (sortCol === "reviewLabel") {
      const rankDiff = (REVIEW_RANK[left.reviewLabel] ?? 9) - (REVIEW_RANK[right.reviewLabel] ?? 9);
      return rankDiff * sortDir || compareFrist(left, right);
    }

    const leftValue = Array.isArray(left[sortCol]) ? left[sortCol].join("; ") : String(left[sortCol] || "");
    const rightValue = Array.isArray(right[sortCol]) ? right[sortCol].join("; ") : String(right[sortCol] || "");
    return leftValue.localeCompare(rightValue, "de") * sortDir;
  });
}

// Ringdiagramm als SVG: segments = [{ label, value, color, note }]
function renderDonut(svgId, legendId, segments, caption) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  const radius = 46;
  const circumference = 2 * Math.PI * radius;
  const visibleSegments = segments.filter((segment) => segment.value > 0);
  let offset = 0;

  const arcs = visibleSegments
    .map((segment) => {
      const length = total ? (segment.value / total) * circumference : 0;
      const visible = Math.max(length - (visibleSegments.length > 1 ? 1.6 : 0), 0.5);
      const arc = `<circle cx="60" cy="60" r="${radius}" fill="none" stroke-width="14"
        style="stroke:${segment.color}" stroke-dasharray="${visible} ${circumference - visible}"
        stroke-dashoffset="${-offset}" transform="rotate(-90 60 60)"><title>${escapeHtml(segment.label)}: ${segment.value}</title></circle>`;
      offset += length;
      return arc;
    })
    .join("");

  document.getElementById(svgId).innerHTML = `
    <circle cx="60" cy="60" r="${radius}" fill="none" stroke-width="14" style="stroke:var(--line)"></circle>
    ${arcs}
    <text x="60" y="62" text-anchor="middle" class="donut-total">${total}</text>
    <text x="60" y="76" text-anchor="middle" class="donut-caption">${escapeHtml(caption)}</text>`;

  document.getElementById(legendId).innerHTML = segments
    .map(
      (segment) => `
        <div class="legend-row">
          <span class="legend-dot" style="background:${segment.color}"></span>
          <span class="legend-label">${escapeHtml(segment.label)}</span>
          <span class="legend-value">${segment.value}${segment.note ? `<small>${escapeHtml(segment.note)}</small>` : ""}</span>
        </div>`
    )
    .join("");
}

function renderCharts(records) {
  const groups = [
    { label: "USP Bund", match: (portal) => portal === "USP Bund", color: "var(--brand)" },
    { label: "TED (EU)", match: (portal) => portal === "TED", color: "#4a78be" },
    { label: "ANKÖ Vergabeportal", match: (portal) => portal === "ANKÖ", color: "var(--sepia)" },
    {
      label: "ANKÖ Länderportale",
      match: (portal) => ["BGLD", "STMK", "OÖ", "KTN", "Tirol", "Vbg", "Burgenland"].includes(portal),
      color: "#8f6fb8"
    },
    { label: "Land NÖ", match: (portal) => portal === "NÖ", color: "#c98a3a" }
  ];
  const portalSegments = groups.map((group) => {
    const matching = records.filter((record) => group.match(record.portal));
    const relevant = matching.filter((record) => record.reviewLabel !== "eher unpassend").length;
    return { label: group.label, value: matching.length, color: group.color, note: `${relevant} relevant` };
  });
  const other = records.filter((record) => !groups.some((group) => group.match(record.portal)));
  if (other.length) {
    portalSegments.push({ label: "Sonstige", value: other.length, color: "var(--muted)" });
  }
  renderDonut("chart-portal", "legend-portal", portalSegments.filter((segment) => segment.value > 0), "gesamt");

  const buckets = { soon: 0, mid: 0, later: 0, none: 0 };
  records.forEach((record) => {
    const days = fristDays(record.frist);
    if (days === null) buckets.none += 1;
    else if (days <= 14) buckets.soon += 1;
    else if (days <= 30) buckets.mid += 1;
    else buckets.later += 1;
  });
  renderDonut(
    "chart-frist",
    "legend-frist",
    [
      { label: "Frist ≤ 14 Tage", value: buckets.soon, color: "var(--bad)" },
      { label: "Frist 15–30 Tage", value: buckets.mid, color: "var(--check)" },
      { label: "Frist > 30 Tage", value: buckets.later, color: "var(--good)" },
      { label: "Keine Frist angegeben", value: buckets.none, color: "var(--unknown)" }
    ],
    "Ausschreibungen"
  );
}

function renderReviewFilter() {
  const base = getFiltered(true);
  document.getElementById("f-review").innerHTML = REVIEW_FILTERS.map((filter) => {
    const count = base.filter((record) => filter.match(record.reviewLabel)).length;
    const active = filter.value === reviewFilter ? " is-active" : "";
    return `<button type="button" class="seg${active}" data-value="${escapeHtml(filter.value)}">${escapeHtml(filter.label)}<span class="count">${count}</span></button>`;
  }).join("");
}

function fristCell(record) {
  const days = fristDays(record.frist);
  if (days === null) {
    return '<span class="frist-none">–</span>';
  }
  const daysText = days === 0 ? "heute" : days === 1 ? "morgen" : `in ${days} Tagen`;
  return `<span class="${days <= 14 ? "frist-soon" : "frist-ok"}">${escapeHtml(formatDate(record.frist))}</span><div class="small-meta">${daysText}</div>`;
}

function tableRow(record) {
  const tone = reviewTone(record.reviewLabel);
  const url = safeUrl(record.link);
  const description = record.displayDescription.trim();
  const snippet = description.length > 200 ? `${description.slice(0, 200)} …` : description;
  const country = record.countryCode
    ? `<div class="small-meta">${countryChip(record)} ${escapeHtml(record.organisationLand)}</div>`
    : "";

  return `
    <tr class="tone-${tone}">
      <td><span class="chip">${escapeHtml(record.portal)}</span></td>
      <td class="cell-term"><span class="chip term ${termClass(record.suchbegriff)}">${escapeHtml(record.suchbegriff || "–")}</span></td>
      <td class="cell-review">
        <span class="chip ${tone}">${escapeHtml(reviewText(record.reviewLabel))}</span>
        ${record.reviewReason ? `<div class="reason">${escapeHtml(prettifyGermanText(record.reviewReason))}</div>` : ""}
      </td>
      <td class="cell-title">
        <strong>${escapeHtml(record.displayTitle)}</strong>
        ${record.originalTitle ? `<div class="original" title="Originaltitel">${escapeHtml(record.originalTitle)}</div>` : ""}
        ${record.category ? `<div class="small-meta">${escapeHtml(record.category)}</div>` : ""}
        ${snippet ? `<div class="snippet">${escapeHtml(snippet)}</div>` : ""}
        ${record.cpvCodes.length ? `<div class="small-meta">CPV ${escapeHtml(record.cpvCodes.slice(0, 4).join(", "))}${record.cpvCodes.length > 4 ? " …" : ""}</div>` : ""}
      </td>
      <td class="cell-buyer">${escapeHtml(record.auftraggeber)}${country}</td>
      <td class="cell-date">${escapeHtml(formatDate(record.veroeffentlichungsdatum)) || "–"}</td>
      <td class="cell-frist">${fristCell(record)}</td>
      <td>${url ? `<a class="open-btn" href="${escapeHtml(url)}" target="_blank" rel="noopener">Öffnen</a>` : ""}</td>
    </tr>`;
}

function renderTable() {
  const records = getSorted(getFiltered());
  renderReviewFilter();
  document.getElementById("result-count").textContent = `${records.length} Einträge`;
  document.getElementById("table-body").innerHTML = records.length
    ? records.map(tableRow).join("")
    : '<tr><td colspan="8" class="empty">Keine Einträge für diese Filter.</td></tr>';

  document.querySelectorAll("thead th[data-col]").forEach((header) => {
    const active = header.dataset.col === sortCol;
    header.classList.toggle("sorted", active);
    header.querySelector(".sort").textContent = active ? (sortDir === 1 ? "↑" : "↓") : "↕";
  });
}

function registerEvents() {
  ["f-country", "f-portal", "f-frist"].forEach((id) => {
    document.getElementById(id).addEventListener("change", renderTable);
  });
  document.getElementById("f-search").addEventListener("input", renderTable);
  document.getElementById("f-review").addEventListener("click", (event) => {
    const button = event.target.closest("button.seg");
    if (!button) return;
    reviewFilter = button.dataset.value;
    renderTable();
  });
  document.querySelectorAll("thead th[data-col]").forEach((header) => {
    header.addEventListener("click", () => {
      if (sortCol === header.dataset.col) {
        sortDir *= -1;
      } else {
        sortCol = header.dataset.col;
        sortDir = 1;
      }
      renderTable();
    });
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
  renderCharts(dataRecords);
  renderPicks(dataRecords);
  registerEvents();
  renderTable();
}

main();
