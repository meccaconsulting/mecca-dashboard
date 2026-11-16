const test = require("node:test");
const assert = require("node:assert/strict");

const { applyPrefilter, prefilterReason } = require("../src/prefilter");

const base = {
  titel: "Studie zur Regionalentwicklung",
  beschreibung: "Analyse der Bevölkerungsentwicklung.",
  organisationLand: "Österreich",
  reviewLabel: "ungeprueft"
};

test("Prefilter: normaler oesterreichischer Eintrag geht an die KI", () => {
  assert.equal(prefilterReason(base), null);
});

test("Prefilter: Eintraege aus dem Ausland werden nie per Regel aussortiert", () => {
  assert.equal(
    prefilterReason({ ...base, titel: "Erstellung eines Flächennutzungsplans", organisationLand: "Tschechien" }),
    null
  );
  assert.equal(
    prefilterReason({ ...base, titel: "Evaluierung des Interreg-Programms", organisationLand: "Slowenien" }),
    null
  );
});

test("Prefilter: Abruf aus Rahmenvereinbarung und Direktvergabe werden aussortiert", () => {
  const noKern = { titel: "Wartung", beschreibung: "", organisationLand: "Österreich", reviewLabel: "ungeprueft" };
  assert.match(prefilterReason({ ...noKern, titel: 'Abruf aus RV "Unterstützungsleistungen"' }), /Rahmenvereinbarung/);
  assert.match(
    prefilterReason({ ...noKern, beschreibung: "Verfahrensart: Verhandlungsverfahren ohne Aufruf zum Wettbewerb Direktvergabe" }),
    /Direktvergabe/
  );
  assert.match(
    prefilterReason({ ...noKern, beschreibung: "erneuten Aufrufes zum Wettbewerb auf Grundlage der BBG Rahmenvereinbarung" }),
    /Rahmenvereinbarung/
  );
});

test("Prefilter: Kernthema verhindert die Regel, die KI entscheidet", () => {
  assert.equal(
    prefilterReason({ ...base, titel: "Abruf aus RV Raumplanung Gemeinde X", beschreibung: "" }),
    null
  );
  assert.equal(prefilterReason({ ...base, beschreibung: "Direktvergabe, Interreg-Projekt Österreich-Ungarn" }), null);
});

test("Prefilter: offene Rahmenvereinbarung wird nicht aussortiert", () => {
  const record = {
    titel: "Wartung",
    beschreibung: "Abschluss einer Rahmenvereinbarung, Einzelaufträge werden aus der Rahmenvereinbarung abgerufen.",
    reviewLabel: "ungeprueft"
  };
  assert.equal(prefilterReason(record), null);
});

test("applyPrefilter: setzt Bewertung nur fuer unpruefte Eintraege", () => {
  const now = new Date("2026-11-16T10:00:00Z");
  const noKern = { titel: "Abruf aus RV Reinigung", beschreibung: "", organisationLand: "Österreich" };
  const records = [
    { ...noKern, reviewLabel: "ungeprueft" },
    { ...noKern, reviewLabel: "passt gut", reviewScore: 85, reviewReason: "manuell" },
    { ...base }
  ];

  const result = applyPrefilter(records, now);

  assert.equal(result[0].reviewLabel, "eher unpassend");
  assert.equal(result[0].reviewScore, 20);
  assert.equal(result[0].reviewProvider, "regel");
  assert.equal(result[0].reviewedAt, "2026-11-16T10:00:00.000Z");
  assert.equal(result[1].reviewLabel, "passt gut");
  assert.equal(result[1].reviewReason, "manuell");
  assert.equal(result[2].reviewLabel, "ungeprueft");
});
