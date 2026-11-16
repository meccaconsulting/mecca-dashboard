"use strict";

/**
 * Regel-Vorfilter vor der KI-Bewertung.
 *
 * Grundsatz: Lieber ein unpassender Eintrag zu viel als ein sinnvoller zu wenig. Deshalb
 * sortiert der Filter nur Eintraege aus, bei denen sich niemand bewerben kann (Abruf aus
 * Rahmenvereinbarung, Direktvergabe). Alles Fachliche, auch die Frage Inland/Ausland,
 * entscheidet die KI-Review-Routine. Eintraege mit Kernthemen werden nie hart aussortiert.
 */

const { normalizeWhitespace } = require("./core/utils");

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

// Kernthemen: Steht eines davon im Text, entscheidet die KI, auch bei formalem Ausschluss.
const KERNTHEMA = new RegExp(
  [
    "raumplan", "raumordn", "raumentwickl", "regionalentwickl", "regionalmanag", "stadtentwickl",
    "ortsentwickl", "siedlungsentwickl", "demograf", "demografi", "bevölkerungsprognose",
    "standortanalyse", "standortentwickl", "interreg", "leader", "efre", "\\besf\\b", "esf\\+"
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

  if (NICHT_ERREICHBAR.test(text) && !KERNTHEMA.test(text)) {
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

module.exports = { applyPrefilter, prefilterReason, NICHT_ERREICHBAR, KERNTHEMA };
