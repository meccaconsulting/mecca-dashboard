const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadEnvironmentFiles, parseDotEnv } = require("../src/core/env");

const {
  ANKOE_SERVICE_CONTRACT_TYPE_ID,
  ankoeRecordMatchesContractType,
  buildTedCountryFilter,
  buildTedWeeklyQuery,
  buildUspDetailUrl,
  carryOverReviews,
  countryLabel,
  extractAnkoeCpvCodes,
  extractAnkoeXsrfToken,
  extractNoeRecordsFromHtml,
  extractUspDeadlineFromApiRow,
  extractUspDetailFromHtml,
  filterExpiredRecords,
  formatCpvSearchTerm,
  getAnkoeMatchedSearchTerms,
  getNoeMatchedSearchTerms,
  getUspApiUrl,
  isExpiredDeadline,
  markRecordsUnreviewed,
  normalizeAnkoeRecord,
  normalizeFeedRecord,
  normalizeUspApiRow,
  tedNoticeMatchesAllowedCountries,
  parseDate,
  toIsoDate
} = require("../src/weeklyTenderFeed");

test("toIsoDate normalisiert TED- und USP-Datumsformate", () => {
  assert.equal(toIsoDate("2026-04-02+02:00"), "2026-04-02");
  assert.equal(toIsoDate("02.04.2026"), "2026-04-02");
});

test("parseDate gibt null für leere Werte zurück", () => {
  assert.equal(parseDate(""), null);
});

test("countryLabel übersetzt wichtige TED-Ländercodes", () => {
  assert.equal(countryLabel(["AUT", "DEU", "LIE"]), "Österreich; Deutschland; Liechtenstein");
});

test("formatCpvSearchTerm ergänzt lesbare CPV-Kurzlabels", () => {
  assert.equal(
    formatCpvSearchTerm("714100005", { "71410000-5": "Raumplanung" }),
    "CPV 71410000-5 - Raumplanung"
  );
});

test("TED-Länderfilter beschränkt die Suche auf erlaubte Käuferländer", () => {
  assert.equal(
    buildTedCountryFilter(["AUT", "DEU", "HUN"]),
    "buyer-country IN (AUT DEU HUN)"
  );

  assert.equal(
    buildTedWeeklyQuery(
      { type: "keyword", value: "Raumplanung", allowedBuyerCountries: ["AUT"] },
      new Date("2026-04-01")
    ).includes("buyer-country IN (AUT)"),
    true
  );

  assert.equal(
    tedNoticeMatchesAllowedCountries({ "buyer-country": ["HUN"] }, ["AUT", "HUN"]),
    true
  );
  assert.equal(
    tedNoticeMatchesAllowedCountries({ "buyer-country": ["FRA"] }, ["AUT", "HUN"]),
    false
  );
});

test("normalizeFeedRecord setzt Dashboard-Spalten", () => {
  const record = normalizeFeedRecord({
    portal: "TED",
    suchbegriff: "Raumplanung",
    titel: " Test ",
    auftraggeber: " Auftraggeber ",
    frist: "2026-04-30",
    link: "https://example.test",
    cpvCodes: ["71410000", "71410000"],
    beschreibung: " Beschreibung ",
    veroeffentlichungsdatum: "2026-04-02+02:00",
    organisationLand: "DEU"
  });

  assert.equal(record.titel, "Test");
  assert.deepEqual(record.cpvCodes, ["71410000"]);
  assert.equal(record.veroeffentlichungsdatum, "2026-04-02");
  assert.equal(record._recordKey, "https://example.test");
  assert.equal(record.recordKey, "https://example.test");
  assert.equal(record.reviewLabel, "ungeprueft");
});

test("abgelaufene Fristen werden serverseitig erkannt", () => {
  assert.equal(isExpiredDeadline("2026-04-01", new Date("2026-04-20T00:00:00.000Z")), true);
  assert.equal(isExpiredDeadline("2026-04-20", new Date("2026-04-20T00:00:00.000Z")), false);
  assert.equal(isExpiredDeadline("", new Date("2026-04-20T00:00:00.000Z")), false);
});

test("Feed kann abgelaufene Datensaetze herausfiltern", () => {
  const records = [
    normalizeFeedRecord({
      portal: "TED",
      suchbegriff: "Raumplanung",
      titel: "Aktiv",
      auftraggeber: "A",
      frist: "2026-04-22",
      link: "https://example.test/a",
      veroeffentlichungsdatum: "2026-04-10"
    }),
    normalizeFeedRecord({
      portal: "TED",
      suchbegriff: "Raumplanung",
      titel: "Alt",
      auftraggeber: "B",
      frist: "2026-04-01",
      link: "https://example.test/b",
      veroeffentlichungsdatum: "2026-04-10"
    })
  ];

  const visible = filterExpiredRecords(records, new Date("2026-04-20T00:00:00.000Z"));
  assert.equal(visible.length, 1);
  assert.equal(visible[0].link, "https://example.test/a");
});

test("USP API URL und Detail-Links werden robust gebaut", () => {
  const apiUrl = getUspApiUrl(
    {
      usp: {
        url: "https://ausschreibungen.usp.gv.at/at.gv.bmdw.eproc-p/public/tenderlist"
      }
    },
    "Projektmanagement",
    25,
    5
  );

  assert.equal(
    apiUrl.href,
    "https://ausschreibungen.usp.gv.at/at.gv.bmdw.eproc-p/public/api/tenderlist?q=Projektmanagement&start=25&length=5"
  );
  assert.equal(
    buildUspDetailUrl(
      "https://ausschreibungen.usp.gv.at/at.gv.bmdw.eproc-p/public/",
      "abc-123",
      true
    ),
    "https://ausschreibungen.usp.gv.at/at.gv.bmdw.eproc-p/public/notice-detail?object=abc-123"
  );
});

test("USP API-Zeilen werden in Feed-Records ueberfuehrt", () => {
  const row = [
    "Abruf aus Rahmenvereinbarung ITPMPE2021, Los 1, 4233873",
    "Bundesrechenzentrum GmbH",
    "2026-05-10",
    null,
    "a2c49245-23b2-46e1",
    false,
    null,
    null
  ];

  const normalized = normalizeUspApiRow(
    row,
    "Projektmanagement",
    {
      usp: {
        detailBaseUrl: "https://ausschreibungen.usp.gv.at/at.gv.bmdw.eproc-p/public/"
      }
    }
  );

  assert.equal(normalized.portal, "USP Bund");
  assert.equal(normalized.suchbegriff, "Projektmanagement");
  assert.equal(normalized.veroeffentlichungsdatum, "2026-05-10");
  assert.equal(
    normalized.link,
    "https://ausschreibungen.usp.gv.at/at.gv.bmdw.eproc-p/public/tender-detail?object=a2c49245-23b2-46e1"
  );
  assert.equal(extractUspDeadlineFromApiRow(row), "");
});

test("USP Detail-HTML liefert CPV und Beschreibung", () => {
  const detail = extractUspDetailFromHtml(`
    <html>
      <body>
        <h1>Machbarkeitsstudie</h1>
        <p>Beschreibung: Unterstützung bei Strategie und Evaluation für Regionalentwicklung.</p>
        <div>CPV 79419000-4</div>
      </body>
    </html>
  `);

  assert.deepEqual(detail.cpvCodes, ["79419000-4"]);
  assert.match(detail.beschreibung, /Strategie und Evaluation/);
});

test("ANKOE Regionalfilter laesst nur Dienstleistungsauftraege durch", () => {
  const source = { contractTypeIds: [ANKOE_SERVICE_CONTRACT_TYPE_ID] };

  assert.equal(ankoeRecordMatchesContractType({ contractTypeId: 3 }, source), true);
  assert.equal(ankoeRecordMatchesContractType({ contractTypeId: 1 }, source), false);
  assert.equal(ankoeRecordMatchesContractType({ contractTypeId: 2 }, source), false);
});

test("ANKOE XSRF Token und CPV-Codes werden aus Detaildaten gelesen", () => {
  assert.equal(
    extractAnkoeXsrfToken('<input name="__RequestVerificationToken" type="hidden" value="abc123" />'),
    "abc123"
  );

  assert.deepEqual(
    extractAnkoeCpvCodes({
      versionContent: "<strong>CPV-Code Hauptteil</strong>: 71410000<br>CPV-Code Hauptteil: 79421000-1"
    }),
    ["71410000", "79421000-1"]
  );
});

test("ANKOE Treffer koennen ueber Keywords oder CPV-Codes behalten werden", () => {
  const config = {
    searchTerms: ["Raumplanung"],
    cpvCodes: ["79421000-1"],
    cpvLabels: {
      "79421000-1": "Projektmanagement"
    }
  };

  assert.deepEqual(
    getAnkoeMatchedSearchTerms(
      {
        name: "Rahmenvereinbarung externe Leistungen",
        contractDescription: "Begleitung fuer Raumplanung und Strategie"
      },
      {},
      config
    ),
    ["Raumplanung"]
  );

  assert.deepEqual(
    getAnkoeMatchedSearchTerms(
      {
        name: "Beratungsleistung"
      },
      {
        versionContent: "CPV-Code Hauptteil: 79421000-1"
      },
      config
    ),
    ["CPV 79421000-1 - Projektmanagement"]
  );

  assert.deepEqual(
    getAnkoeMatchedSearchTerms(
      {
        name: "Planungsleistung"
      },
      {
        versionContent: "CPV-Code Hauptteil: 71410000"
      },
      {
        searchTerms: [],
        cpvCodes: ["71410000-5"],
        cpvLabels: {
          "71410000-5": "Raumplanung"
        }
      }
    ),
    ["CPV 71410000 - Raumplanung"]
  );
});

test("ANKOE Records werden in Dashboard-Spalten normalisiert", () => {
  const record = normalizeAnkoeRecord(
    {
      id: 246000,
      name: "Regionalentwicklung",
      contAuthOfficialName: "Land Test",
      submitDeadline: "2026-07-01T12:00:00",
      contractDescription: "Beratungsleistung",
      contractTypeId: 3
    },
    {
      formDatas: [{ publishedAt: "2026-06-01T10:00:00" }],
      versionContent: "CPV-Code Hauptteil: 71410000"
    },
    {
      portal: "ANKOE Test",
      baseUrl: "https://example.test/"
    },
    {},
    ["Raumplanung"]
  );

  assert.equal(record.portal, "ANKOE Test");
  assert.equal(record.suchbegriff, "Raumplanung");
  assert.equal(record.titel, "Regionalentwicklung");
  assert.equal(record.auftraggeber, "Land Test");
  assert.equal(record.veroeffentlichungsdatum, "2026-06-01");
  assert.equal(record.link, "https://example.test/Detail/246000");
  assert.deepEqual(record.cpvCodes, ["71410000"]);
});

test("NOE HTML-Bekanntmachungen werden gefiltert gelesen", () => {
  const html = `
    <div class="listpage">
      <a href="https://noe.vemap.com/home/bekannt/anzeigen.html?annID=1" target="_blank">
        <div class="article">
          <span class="art-h">Rahmenvereinbarung Planungsleistungen Raumplanung</span>
          <p>Strategie und Raumplanung fuer Gemeinden.</p>
          <p>Veröffentlicht am: 09.06.2026<br />Dokumentnummer: ABC-1</p>
        </div>
      </a>
      <a href="https://noe.vemap.com/home/bekannt/anzeigen.html?annID=2" target="_blank">
        <div class="article">
          <span class="art-h">Asphaltarbeiten</span>
          <p>Fräs- und Heißmischgutarbeiten.</p>
          <p>Veröffentlicht am: 09.06.2026<br />Dokumentnummer: ABC-2</p>
        </div>
      </a>
    </div>
  `;

  const records = extractNoeRecordsFromHtml(html, {
    searchTerms: ["Raumplanung", "Strategie"]
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].title, "Rahmenvereinbarung Planungsleistungen Raumplanung");
  assert.deepEqual(getNoeMatchedSearchTerms(records[0], { searchTerms: ["Raumplanung"] }), [
    "Raumplanung"
  ]);
});

test(".env Parser liest Kommentare, Quotes und einfache Key-Value-Paare", () => {
  const parsed = parseDotEnv(`
    # Kommentar
    FEED_REGION=at
    FEED_MODE="weekly"
    FEED_ENABLED='true'
  `);

  assert.deepEqual(parsed, {
    FEED_REGION: "at",
    FEED_MODE: "weekly",
    FEED_ENABLED: "true"
  });
});

test("lokale Environment-Dateien werden geladen ohne bestehende Variablen zu ueberschreiben", () => {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mecca-env-test-"));
  const originalProvider = process.env.FEED_REGION;
  const originalModel = process.env.FEED_MODE;

  fs.writeFileSync(
    path.join(tempDirectory, ".env.local"),
    "FEED_REGION=at\nFEED_MODE=weekly\n",
    "utf8"
  );

  process.env.FEED_REGION = "manual-region";
  delete process.env.FEED_MODE;

  try {
    const loadedFiles = loadEnvironmentFiles({ cwd: tempDirectory });

    assert.equal(loadedFiles.length, 1);
    assert.equal(process.env.FEED_REGION, "manual-region");
    assert.equal(process.env.FEED_MODE, "weekly");
  } finally {
    if (originalProvider === undefined) {
      delete process.env.FEED_REGION;
    } else {
      process.env.FEED_REGION = originalProvider;
    }

    if (originalModel === undefined) {
      delete process.env.FEED_MODE;
    } else {
      process.env.FEED_MODE = originalModel;
    }

    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test("Wochenfeed setzt alte Bewertungen vollstaendig zurueck", () => {
  const records = markRecordsUnreviewed([
    {
      titel: "Bestehende Ausschreibung",
      reviewLabel: "passt gut",
      reviewScore: 85,
      reviewReason: "Alte Bewertung",
      reviewProvider: "alt",
      reviewModel: "alt-modell",
      reviewedAt: "2026-01-01T00:00:00.000Z"
    }
  ]);

  assert.deepEqual(records[0], {
    titel: "Bestehende Ausschreibung",
    reviewLabel: "ungeprueft",
    reviewScore: null,
    reviewReason: "",
    reviewProvider: "",
    reviewModel: "",
    reviewedAt: ""
  });
});

test("Wochenfeed uebernimmt vorhandene Bewertungen per recordKey, neue bleiben ungeprueft", () => {
  const records = carryOverReviews(
    [
      { recordKey: "https://example.org/a", titel: "Bekannt", reviewLabel: "ungeprueft" },
      { recordKey: "https://example.org/b", titel: "Neu", reviewLabel: "ungeprueft" }
    ],
    [
      {
        recordKey: "https://example.org/a",
        reviewLabel: "passt gut",
        reviewScore: 85,
        reviewReason: "Regionalentwicklungskonzept.",
        reviewProvider: "claude-automation",
        reviewModel: "claude-sonnet-5",
        reviewedAt: "2026-09-27T05:21:45.000Z"
      },
      { recordKey: "https://example.org/c", reviewLabel: "eher unpassend", reviewScore: 20 }
    ]
  );

  assert.equal(records.length, 2);
  assert.equal(records[0].reviewLabel, "passt gut");
  assert.equal(records[0].reviewScore, 85);
  assert.equal(records[0].reviewReason, "Regionalentwicklungskonzept.");
  assert.equal(records[0].reviewedAt, "2026-09-27T05:21:45.000Z");
  assert.equal(records[1].reviewLabel, "ungeprueft");
  assert.equal(records[1].reviewScore, null);
});
