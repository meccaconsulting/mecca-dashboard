"use strict";

/**
 * Regel-Vorfilter vor der KI-Bewertung.
 *
 * Sortiert nur Faelle aus, die ohne fachliche Abwaegung klar nicht erreichbar oder nicht
 * relevant sind. Alles Uebrige bleibt "ungeprueft" und geht an die KI-Review-Routine.
 * Die Regeln stammen aus der Durchsicht von 72 KI-Treffern (Stand 2026-11-16).
 */

const { normalizeWhitespace } = require("./core/utils");

// Hinweise auf Programmebene der EU-Foerderung, in den Sprachen der Nachbarlaender.
// Nur wenn so etwas im Text steht, wird ein Auftraggeber im Ausland weiter beachtet.
const EU_PROGRAMM = new RegExp(
  [
    "interreg", "efre", "\\befrr\\b", "\\berfa\\b", "erdf", "\\besf\\b", "esf\\+", "\\besif\\b",
    "kohäsion", "kohaezion", "cohesion", "soudržnosti", "kohéz", "strukturfond", "strukturális",
    "\\birop\\b", "partnerschaftsvereinbarung", "dohoda o partnerství",
    "operační program", "operatív program", "operativni program", "operatívny program"
  ].join("|"),
  "i"
);

// Abrufe aus bestehenden Rahmenvereinbarungen oder Beschaffungssystemen und Vergaben ohne
// offenen Wettbewerb: dort kann sich niemand neu bewerben.
const NICHT_ERREICHBAR = new RegExp(
  [
    "abrufe? (aus )?(der |dem |einer |einem )?(rv|rahmenvereinbarung|dynamisch)",
    "erneute[rnm]? aufruf",
    "direktvergabe",
    "ohne (vorherige )?(bekanntmachung|aufruf zum wettbewerb)",
    "verhandlungsverfahren ohne"
  ].join("|"),
  "i"
);

function recordText(record) {
  return [record.titel, record.titelDe, record.beschreibung, record.beschreibungDe]
    .map(normalizeWhitespace)
    .filter(Boolean)
    .join(" ");
}

/**
 * Liefert einen kurzen Ausschlussgrund oder null, wenn die KI entscheiden soll.
 */
function prefilterReason(record) {
  const text = recordText(record);
  const land = normalizeWhitespace(record.organisationLand);

  if (land && !land.includes("Österreich") && !EU_PROGRAMM.test(text)) {
    return "Regel: Auftraggeber im Ausland ohne Interreg- oder EU-Programmbezug.";
  }

  if (NICHT_ERREICHBAR.test(text)) {
    return "Regel: Abruf aus Rahmenvereinbarung oder Direktvergabe, keine offene Bewerbung möglich.";
  }

  return null;
}

/**
 * Setzt fuer ungepruefte Eintraege, auf die eine Regel zutrifft, die Bewertung
 * "eher unpassend". Bereits bewertete Eintraege bleiben unveraendert.
 */
function applyPrefilter(records, now = new Date()) {
  const reviewedAt = now.toISOString();

  return records.map((record) => {
    if (normalizeWhitespace(record.reviewLabel).toLowerCase() !== "ungeprueft") {
      return record;
    }

    const reason = prefilterReason(record);
    if (!reason) {
      return record;
    }

    return {
      ...record,
      reviewLabel: "eher unpassend",
      reviewScore: 20,
      reviewReason: reason,
      reviewProvider: "regel",
      reviewModel: "prefilter",
      reviewedAt
    };
  });
}

module.exports = { applyPrefilter, prefilterReason, EU_PROGRAMM, NICHT_ERREICHBAR };
