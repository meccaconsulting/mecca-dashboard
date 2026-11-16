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

test("Prefilter: Auftraggeber im Ausland ohne EU-Programmbezug wird aussortiert", () => {
  const record = { ...base, titel: "Erstellung eines Flächennutzungsplans", organisationLand: "Tschechien" };
  assert.match(prefilterReason(record), /Ausland/);
});

test("Prefilter: Ausland mit Interreg oder EU-Programmbezug bleibt fuer die KI", () => {
  assert.equal(
    prefilterReason({ ...base, organisationLand: "Slowenien", titel: "Evaluierung des Interreg-Programms" }),
    null
  );
  assert.equal(
    prefilterReason({ ...base, organisationLand: "Tschechien", beschreibung: "Evaluierung des IROP" }),
    null
  );
});

test("Prefilter: mehrere Laender inklusive Oesterreich gelten nicht als Ausland", () => {
  assert.equal(prefilterReason({ ...base, organisationLand: "Irland; Österreich; Slowenien" }), null);
});

test("Prefilter: Abruf aus Rahmenvereinbarung und Direktvergabe werden aussortiert", () => {
  assert.match(prefilterReason({ ...base, titel: 'Abruf aus RV "Unterstützungsleistungen"' }), /Rahmenvereinbarung/);
  assert.match(
    prefilterReason({ ...base, beschreibung: "Verfahrensart: Verhandlungsverfahren ohne Aufruf zum Wettbewerb Direktvergabe" }),
    /Direktvergabe/
  );
  assert.match(
    prefilterReason({ ...base, beschreibung: "erneuten Aufrufes zum Wettbewerb auf Grundlage der BBG Rahmenvereinbarung" }),
    /Rahmenvereinbarung/
  );
});

test("Prefilter: offene Rahmenvereinbarung wird nicht aussortiert", () => {
  assert.equal(
    prefilterReason({ ...base, beschreibung: "Abschluss einer Rahmenvereinbarung, Einzelaufträge werden aus der Rahmenvereinbarung abgerufen." }),
    null
  );
});

test("applyPrefilter: setzt Bewertung nur fuer unpruefte Eintraege", () => {
  const now = new Date("2026-11-16T10:00:00Z");
  const records = [
    { ...base, titel: "Ortsplan", organisationLand: "Ungarn" },
    { ...base, titel: "Ortsplan", organisationLand: "Ungarn", reviewLabel: "passt gut", reviewScore: 85, reviewReason: "manuell" },
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
