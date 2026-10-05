const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const { createLogger } = require("./core/logger");
const { pickLocalizedText } = require("./core/normalize");
const { createStableHash, ensureDirectoryPath, normalizeWhitespace, sleep, stripHtmlTags, toArray, unique } = require("./core/utils");
const { buildTedQuery } = require("./sources/ted");


const CSV_HEADERS = [
  "recordKey",
  "portal",
  "suchbegriff",
  "titel",
  "auftraggeber",
  "frist",
  "link",
  "cpvCodes",
  "beschreibung",
  "veroeffentlichungsdatum",
  "organisationLand",
  "scrapedAt",
  "reviewLabel",
  "reviewScore",
  "reviewReason",
  "reviewProvider",
  "reviewModel",
  "reviewedAt"
];

const COUNTRY_NAMES = {
  AUT: "Österreich",
  DEU: "Deutschland",
  CHE: "Schweiz",
  LIE: "Liechtenstein",
  FRA: "Frankreich",
  ITA: "Italien",
  NLD: "Niederlande",
  BEL: "Belgien",
  ESP: "Spanien",
  POL: "Polen",
  CZE: "Tschechien",
  SVK: "Slowakei",
  SVN: "Slowenien",
  HUN: "Ungarn",
  HRV: "Kroatien",
  GBR: "Vereinigtes Königreich",
  IRL: "Irland"
};

const USP_DEFAULT_PAGE_SIZE = 25;
const USP_DEFAULT_COUNTRY = "Österreich";
const ANKOE_SERVICE_CONTRACT_TYPE_ID = 3;
const execFileAsync = promisify(execFile);

function mergeConfig(baseConfig, overrideConfig = {}) {
  const merged = { ...baseConfig };

  for (const [key, value] of Object.entries(overrideConfig)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      merged[key] &&
      typeof merged[key] === "object" &&
      !Array.isArray(merged[key])
    ) {
      merged[key] = mergeConfig(merged[key], value);
      continue;
    }

    merged[key] = value;
  }

  return merged;
}

function parseArgs(argv) {
  const options = {
    configPath: "config/weekly-dashboard.json",
    days: null,
    sample: false,
    headless: null
  };

  for (const argument of argv) {
    if (argument.startsWith("--config=")) {
      options.configPath = argument.split("=")[1];
      continue;
    }

    if (argument.startsWith("--days=")) {
      options.days = Number(argument.split("=")[1]);
      continue;
    }

    if (argument === "--sample") {
      options.sample = true;
      continue;
    }

    if (argument === "--headful") {
      options.headless = false;
      continue;
    }

    if (argument === "--headless") {
      options.headless = true;
    }
  }

  return options;
}

function parseDate(value) {
  if (!value) {
    return null;
  }

  const text = normalizeWhitespace(value).replace(/Z$/, "");
  const dateOnly = text.match(/\d{4}-\d{2}-\d{2}/)?.[0];

  if (dateOnly) {
    return new Date(`${dateOnly}T00:00:00.000Z`);
  }

  const germanDate = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (germanDate) {
    const [, day, month, year] = germanDate;
    return new Date(`${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T00:00:00.000Z`);
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toIsoDate(value) {
  const date = parseDate(value);
  return date ? date.toISOString().slice(0, 10) : "";
}

function formatTedDate(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

function calculateCutoffDate(maxAgeDays) {
  const cutoff = new Date();
  cutoff.setUTCHours(0, 0, 0, 0);
  cutoff.setUTCDate(cutoff.getUTCDate() - maxAgeDays);
  return cutoff;
}

function isOnOrAfter(value, cutoffDate) {
  const parsed = parseDate(value);
  return parsed ? parsed.getTime() >= cutoffDate.getTime() : false;
}

function countryLabel(codes) {
  return unique(toArray(codes).flat().map(normalizeWhitespace))
    .map((code) => COUNTRY_NAMES[code] || code)
    .join("; ");
}

function extractTedUrl(links) {
  if (!links || typeof links !== "object") {
    return "";
  }

  for (const bucket of ["html", "htmlDirect", "pdf", "xml"]) {
    const values = links[bucket];

    if (!values || typeof values !== "object") {
      continue;
    }

    if (values.DEU) {
      return values.DEU;
    }

    if (values.ENG) {
      return values.ENG;
    }

    const firstValue = Object.values(values).find(Boolean);
    if (firstValue) {
      return firstValue;
    }
  }

  return "";
}

function extractTedDeadline(notice) {
  return (
    pickLocalizedText(notice.deadline) ||
    normalizeWhitespace(
      [
        pickLocalizedText(notice["deadline-date-lot"]),
        pickLocalizedText(notice["deadline-time-lot"])
      ]
        .filter(Boolean)
        .join(" ")
    )
  );
}

function normalizeFeedRecord(record) {
  const normalized = {
    recordKey: "",
    portal: normalizeWhitespace(record.portal),
    suchbegriff: normalizeWhitespace(record.suchbegriff),
    titel: normalizeWhitespace(record.titel),
    auftraggeber: normalizeWhitespace(record.auftraggeber),
    frist: normalizeWhitespace(record.frist),
    link: normalizeWhitespace(record.link),
    cpvCodes: unique(toArray(record.cpvCodes).flat().map(normalizeWhitespace)),
    beschreibung: normalizeWhitespace(record.beschreibung),
    veroeffentlichungsdatum: toIsoDate(record.veroeffentlichungsdatum),
    organisationLand: normalizeWhitespace(record.organisationLand),
    scrapedAt: record.scrapedAt || new Date().toISOString(),
    reviewLabel: normalizeWhitespace(record.reviewLabel).toLowerCase() || "ungeprueft",
    reviewScore:
      record.reviewScore === null || record.reviewScore === undefined || record.reviewScore === ""
        ? null
        : Number.isFinite(Number(record.reviewScore))
          ? Number(record.reviewScore)
          : null,
    reviewReason: normalizeWhitespace(record.reviewReason),
    reviewProvider: normalizeWhitespace(record.reviewProvider),
    reviewModel: normalizeWhitespace(record.reviewModel),
    reviewedAt: normalizeWhitespace(record.reviewedAt)
  };

  normalized._recordKey =
    normalized.link ||
    createStableHash(
      [
        normalized.portal,
        normalized.suchbegriff,
        normalized.titel,
        normalized.auftraggeber,
        normalized.veroeffentlichungsdatum
      ].join("|")
    );
  normalized.recordKey = normalized._recordKey;

  return normalized;
}

function markRecordsUnreviewed(records) {
  return records.map((record) => ({
    ...record,
    reviewLabel: "ungeprueft",
    reviewScore: null,
    reviewReason: "",
    reviewProvider: "",
    reviewModel: "",
    reviewedAt: ""
  }));
}

/**
 * Uebernimmt vorhandene KI-Bewertungen aus dem bisherigen Datenstand fuer
 * Ausschreibungen, die im neuen Feed wieder auftauchen (gleicher recordKey).
 * Nur neue Ausschreibungen bleiben "ungeprueft". So geht eine Bewertung nicht
 * verloren, wenn der Wochenfeed nach der Review-Routine laeuft.
 */
function carryOverReviews(records, previousRecords = []) {
  const previousByKey = new Map();

  for (const previous of previousRecords) {
    const key = normalizeWhitespace(previous?.recordKey || previous?.link);
    const label = normalizeWhitespace(previous?.reviewLabel).toLowerCase();

    if (key && label && label !== "ungeprueft") {
      previousByKey.set(key, previous);
    }
  }

  return markRecordsUnreviewed(records).map((record) => {
    const previous = previousByKey.get(record.recordKey);

    if (!previous) {
      return record;
    }

    return {
      ...record,
      reviewLabel: normalizeWhitespace(previous.reviewLabel).toLowerCase(),
      reviewScore: Number.isFinite(Number(previous.reviewScore)) ? Number(previous.reviewScore) : null,
      reviewReason: normalizeWhitespace(previous.reviewReason),
      reviewProvider: normalizeWhitespace(previous.reviewProvider),
      reviewModel: normalizeWhitespace(previous.reviewModel),
      reviewedAt: normalizeWhitespace(previous.reviewedAt)
    };
  });
}

async function readPreviousRecords(jsonPath) {
  try {
    const parsed = JSON.parse(await fs.readFile(jsonPath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function startOfTodayUtc() {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return today;
}

function isExpiredDeadline(value, referenceDate = startOfTodayUtc()) {
  if (!normalizeWhitespace(value)) {
    return false;
  }

  const parsed = parseDate(value);
  if (!parsed) {
    return false;
  }

  return parsed.getTime() < referenceDate.getTime();
}

function filterExpiredRecords(records, referenceDate = startOfTodayUtc()) {
  return records.filter((record) => !isExpiredDeadline(record.frist, referenceDate));
}

function normalizeCpvCode(value) {
  const cleaned = normalizeWhitespace(value);
  const digits = cleaned.replace(/\D/g, "");

  if (digits.length === 9) {
    return `${digits.slice(0, 8)}-${digits.slice(8)}`;
  }

  return cleaned;
}

function formatCpvSearchTerm(code, labels = {}) {
  const normalizedCode = normalizeCpvCode(code);
  const baseCode = normalizedCode.replace(/-\d$/, "");
  const label =
    labels[normalizedCode] ||
    labels[baseCode] ||
    Object.entries(labels).find(([labelCode]) => normalizeCpvCode(labelCode).replace(/-\d$/, "") === baseCode)?.[1];

  return label ? `CPV ${normalizedCode} - ${label}` : `CPV ${normalizedCode}`;
}

function buildTedSearchTerms(config) {
  const keywordTerms = config.searchTerms.map((value) => ({ type: "keyword", value }));

  if (!config.includeCpvSearches) {
    return keywordTerms;
  }

  return [
    ...config.cpvCodes.map((value) => ({
      type: "cpv",
      value,
      displayValue: formatCpvSearchTerm(value, config.cpvLabels)
    })),
    ...keywordTerms
  ];
}

function buildTedWeeklyQuery(searchTerm, cutoffDate) {
  const dateFilter = `publication-date = (${formatTedDate(cutoffDate)} <> ${formatTedDate(new Date())})`;
  const countryFilter = buildTedCountryFilter(searchTerm.allowedBuyerCountries);
  return [dateFilter, countryFilter, buildTedQuery(searchTerm)].filter(Boolean).join(" AND ");
}

function normalizeCountryCodes(value) {
  return unique(toArray(value).flat().map((code) => normalizeWhitespace(code).toUpperCase()));
}

function buildTedCountryFilter(countryCodes = []) {
  const codes = normalizeCountryCodes(countryCodes);

  if (!codes.length) {
    return "";
  }

  return `buyer-country IN (${codes.join(" ")})`;
}

function tedNoticeMatchesAllowedCountries(notice, allowedBuyerCountries = []) {
  const allowed = new Set(normalizeCountryCodes(allowedBuyerCountries));

  if (!allowed.size) {
    return true;
  }

  const noticeCountries = normalizeCountryCodes(
    notice["buyer-country"] || notice["organisation-country-buyer"]
  );

  return noticeCountries.some((country) => allowed.has(country));
}

function getUspApiUrl(config, searchTerm, start = 0, length = USP_DEFAULT_PAGE_SIZE) {
  const apiBaseUrl =
    normalizeWhitespace(config.usp.apiUrl) ||
    String(config.usp.url || "").replace("/public/tenderlist", "/public/api/tenderlist");
  const url = new URL(apiBaseUrl);
  url.searchParams.set("q", searchTerm);
  url.searchParams.set("start", String(start));
  url.searchParams.set("length", String(length));
  return url;
}

function buildUspDetailUrl(detailBaseUrl, objectId, isNotice = false) {
  const normalizedObjectId = normalizeWhitespace(objectId);

  if (!normalizedObjectId) {
    return "";
  }

  return new URL(
    `${isNotice ? "notice" : "tender"}-detail?object=${encodeURIComponent(normalizedObjectId)}`,
    detailBaseUrl
  ).href;
}

function extractUspDeadlineFromApiRow(row) {
  const primaryDeadline = normalizeWhitespace(row?.[3]);
  const offerDeadline = normalizeWhitespace(row?.[6]);
  const participationDeadline = normalizeWhitespace(row?.[7]);

  return (
    [primaryDeadline, offerDeadline, participationDeadline].find((value) => parseDate(value)) ||
    primaryDeadline ||
    offerDeadline ||
    participationDeadline
  );
}

function normalizeUspApiRow(row, searchTerm, config) {
  if (!Array.isArray(row)) {
    return null;
  }

  const titel = normalizeWhitespace(row[0]);
  if (!titel) {
    return null;
  }

  return {
    portal: "USP Bund",
    suchbegriff: searchTerm,
    titel,
    auftraggeber: normalizeWhitespace(row[1]),
    veroeffentlichungsdatum: normalizeWhitespace(row[2]),
    frist: extractUspDeadlineFromApiRow(row),
    link: buildUspDetailUrl(config.usp.detailBaseUrl, row[4], Boolean(row[5])),
    beschreibung: ""
  };
}

function extractUspDetailFromHtml(html) {
  const bodyText = stripHtmlTags(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
  );
  const cpvCodes = [...new Set(bodyText.match(/\b\d{8}(?:-\d)?\b/g) || [])];
  const descriptionLabels = [
    "Beschreibung",
    "Kurzbeschreibung",
    "Bezeichnung des Auftrags",
    "Auftragsbezeichnung",
    "Gegenstand"
  ];
  const description = descriptionLabels
    .map((label) => {
      const match = bodyText.match(new RegExp(`${label}[:\\s]+(.{20,700})`, "i"));
      return normalizeWhitespace(match?.[1]);
    })
    .find(Boolean);

  return {
    cpvCodes,
    beschreibung: description || "",
    organisationLand: USP_DEFAULT_COUNTRY
  };
}

function normalizeAnkoeBaseUrl(baseUrl) {
  const normalized = normalizeWhitespace(baseUrl);
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

function getAnkoeCookieHeader(headers) {
  const setCookie = headers.get("set-cookie") || "";

  return setCookie
    .split(/,(?=[^ ;]+=)/)
    .map((cookie) => cookie.split(";")[0])
    .map(normalizeWhitespace)
    .filter(Boolean)
    .join("; ");
}

function extractAnkoeXsrfToken(html) {
  return (
    String(html || "").match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/i)?.[1] ||
    String(html || "").match(/value="([^"]+)"[^>]*name="__RequestVerificationToken"/i)?.[1] ||
    ""
  );
}

function getAnkoeContractTypeIds(source) {
  const ids = toArray(source.contractTypeIds)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);

  return ids.length ? ids : [ANKOE_SERVICE_CONTRACT_TYPE_ID];
}

function ankoeRecordMatchesContractType(row, source) {
  return getAnkoeContractTypeIds(source).includes(Number(row?.contractTypeId));
}

function extractAnkoeCpvCodes(detail = {}) {
  const texts = [
    detail.versionContent,
    detail.contractDescription,
    detail.name,
    detail.contractName
  ].filter(Boolean);

  return unique(
    texts
      .join(" ")
      .match(/\b\d{8}(?:-\d)?\b/g) || []
  );
}

function getLatestAnkoePublicationDate(detail = {}, row = {}) {
  const formDataDates = toArray(detail.formDatas)
    .map((formData) => normalizeWhitespace(formData?.publishedAt))
    .filter(Boolean)
    .sort()
    .reverse();

  return (
    formDataDates[0] ||
    normalizeWhitespace(detail.ogdCoreData?.lastModified) ||
    normalizeWhitespace(row.updatedAt) ||
    normalizeWhitespace(row.displayTo)
  );
}

function normalizeSearchValue(value) {
  return normalizeWhitespace(value).toLowerCase();
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&ouml;/gi, "ö")
    .replace(/&Ouml;/g, "Ö")
    .replace(/&auml;/gi, "ä")
    .replace(/&Auml;/g, "Ä")
    .replace(/&uuml;/gi, "ü")
    .replace(/&Uuml;/g, "Ü")
    .replace(/&szlig;/gi, "ß");
}

function cleanHtmlText(value) {
  return normalizeWhitespace(decodeHtmlEntities(stripHtmlTags(value)));
}

function extractNoeRecordsFromHtml(html, config) {
  const records = [];
  const articlePattern = /<a\s+href="([^"]+)"[^>]*>\s*<div class="article">([\s\S]*?)<\/div>\s*<\/a>/gi;
  let match;

  while ((match = articlePattern.exec(String(html || ""))) !== null) {
    const [, href, articleHtml] = match;
    const title = cleanHtmlText(articleHtml.match(/<span class="art-h">([\s\S]*?)<\/span>/i)?.[1]);
    const paragraphs = [...articleHtml.matchAll(/<p>([\s\S]*?)<\/p>/gi)].map((paragraph) =>
      cleanHtmlText(paragraph[1])
    );
    const description = paragraphs[0] || "";
    const meta = paragraphs[1] || "";
    const publicationDate = meta.match(/Veröffentlicht am:\s*(\d{1,2}\.\d{1,2}\.\d{4})/i)?.[1] || "";
    const documentNumber = meta.match(/Dokumentnummer:\s*(.+)$/i)?.[1] || "";

    if (!title) {
      continue;
    }

    records.push({
      title,
      description,
      publicationDate,
      documentNumber,
      url: href
    });
  }

  return records.filter((record) => getNoeMatchedSearchTerms(record, config).length > 0);
}

function getNoeMatchedSearchTerms(record, config) {
  const searchTerms = unique([
    ...toArray(config.searchTerms),
    ...toArray(config.noe?.searchTerms)
  ]);
  const text = normalizeSearchValue(
    [
      record.title,
      record.description,
      record.documentNumber
    ]
      .filter(Boolean)
      .join(" ")
  );

  return searchTerms.filter((term) => text.includes(normalizeSearchValue(term)));
}

async function scrapeNoe(config, logger, cutoffDate) {
  if (!config.noe?.enabled) {
    return [];
  }

  logger.info("NOE Suche", { portal: config.noe.portal, url: config.noe.url });

  let html = "";

  try {
    html = await fetchUspText(config.noe.url, config);
  } catch (error) {
    logger.warn("NOE Suche uebersprungen", { message: getErrorMessage(error) });
    return [];
  }

  return extractNoeRecordsFromHtml(html, config)
    .map((record) => {
      const matchedSearchTerms = getNoeMatchedSearchTerms(record, config);

      return normalizeFeedRecord({
        portal: config.noe.portal || "NÖ",
        suchbegriff: matchedSearchTerms.join("; "),
        titel: record.title,
        auftraggeber: config.noe.organization || "Land Niederösterreich",
        frist: "",
        link: record.url,
        cpvCodes: [],
        beschreibung: record.description,
        veroeffentlichungsdatum: record.publicationDate,
        organisationLand: USP_DEFAULT_COUNTRY
      });
    })
    .filter((record) => isOnOrAfter(record.veroeffentlichungsdatum, cutoffDate))
    .slice(0, config.runtime.maxRecordsPerPortal);
}

function getAnkoeMatchedSearchTerms(row, detail, config) {
  const cpvCodes = extractAnkoeCpvCodes(detail);
  const cpvSearchTerms = toArray(config.cpvCodes).map(normalizeCpvCode);
  const cpvSearchTermBases = cpvSearchTerms.map((code) => code.replace(/-\d$/, ""));
  const cpvMatches = cpvCodes.filter((code) => {
    const normalized = normalizeCpvCode(code);
    const baseCode = normalized.replace(/-\d$/, "");
    return cpvSearchTerms.includes(normalized) || cpvSearchTermBases.includes(baseCode);
  });
  const text = normalizeSearchValue(
    [
      row?.name,
      row?.contractName,
      row?.contractDescription,
      row?.contAuthOfficialName,
      row?.documentNumber,
      row?.publicId,
      detail?.name,
      detail?.contractName,
      detail?.contractDescription,
      stripHtmlTags(detail?.versionContent || "")
    ]
      .filter(Boolean)
      .join(" ")
  );
  const keywordMatches = toArray(config.searchTerms).filter((term) =>
    text.includes(normalizeSearchValue(term))
  );

  return unique([
    ...keywordMatches,
    ...cpvMatches.map((code) => formatCpvSearchTerm(code, config.cpvLabels))
  ]);
}

function normalizeAnkoeRecord(row, detail, source, config, matchedSearchTerms) {
  const cpvCodes = extractAnkoeCpvCodes(detail);

  return normalizeFeedRecord({
    portal: source.portal || "ANKOE Regional",
    suchbegriff: matchedSearchTerms.join("; ") || "Dienstleistungen",
    titel: detail?.name || row.name || row.contractName,
    auftraggeber: detail?.contAuthOfficialName || row.contAuthOfficialName,
    veroeffentlichungsdatum: getLatestAnkoePublicationDate(detail, row),
    frist: row.submitDeadline || detail?.submitDeadline || row.displayTo || detail?.displayTo,
    link: new URL(`Detail/${row.id}`, normalizeAnkoeBaseUrl(source.baseUrl)).href,
    cpvCodes,
    beschreibung: detail?.contractDescription || row.contractDescription,
    organisationLand: source.organisationLand || USP_DEFAULT_COUNTRY
  });
}

async function createAnkoeSession(source, config) {
  const baseUrl = normalizeAnkoeBaseUrl(source.baseUrl);
  const listResponse = await fetch(new URL("List", baseUrl), {
    headers: {
      accept: "text/html,application/xhtml+xml",
      "user-agent": config.runtime.userAgent
    }
  });

  if (!listResponse.ok) {
    throw new Error(`${source.portal} List status ${listResponse.status}`);
  }

  const html = await listResponse.text();
  const token = extractAnkoeXsrfToken(html);
  const cookieHeader = getAnkoeCookieHeader(listResponse.headers);

  return { baseUrl, token, cookieHeader };
}

async function fetchAnkoePortalJson(session, source, config, pathName, options = {}) {
  const headers = {
    accept: "application/json",
    "user-agent": config.runtime.userAgent
  };

  if (session.token) {
    headers["X-XSRF-Token"] = session.token;
  }

  if (session.cookieHeader) {
    headers.cookie = session.cookieHeader;
  }

  const response = await fetch(new URL(pathName, session.baseUrl), {
    ...options,
    headers: {
      ...headers,
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    throw new Error(`${source.portal} ${pathName} status ${response.status}`);
  }

  return response.json();
}

async function fetchAnkoeList(session, source, config) {
  const payload = await fetchAnkoePortalJson(session, source, config, "api/Procurement/Notice/Find/", {
    method: "POST"
  });

  return Array.isArray(payload.result) ? payload.result : [];
}

async function fetchAnkoeDetail(session, source, config, id) {
  const payload = await fetchAnkoePortalJson(session, source, config, `api/Procurement/Notice/Get/${id}`, {
    method: "GET"
  });

  return payload.result || {};
}

async function scrapeAnkoeRegional(config, logger, cutoffDate) {
  if (!config.ankoeRegional?.enabled) {
    return [];
  }

  const records = [];
  const seen = new Set();
  const sources = toArray(config.ankoeRegional.sources);
  const maxDetailsPerSource =
    config.ankoeRegional.maxDetailsPerSource || config.runtime.maxDetailsPerPortal || 50;

  for (const source of sources) {
    if (!normalizeWhitespace(source.baseUrl)) {
      continue;
    }

    logger.info("ANKOE Regional Suche", {
      portal: source.portal,
      contractTypeIds: getAnkoeContractTypeIds(source)
    });

    let rows = [];

    try {
      const session = await createAnkoeSession(source, config);
      rows = (await fetchAnkoeList(session, source, config)).filter((row) =>
        ankoeRecordMatchesContractType(row, source)
      );

      source._session = session;
    } catch (error) {
      logger.warn("ANKOE Regional Suche uebersprungen", {
        portal: source.portal,
        message: getErrorMessage(error)
      });
      continue;
    }

    let detailCount = 0;

    for (const row of rows) {
      let detail = {};

      if (detailCount < maxDetailsPerSource) {
        try {
          detail = await fetchAnkoeDetail(source._session, source, config, row.id);
          detailCount += 1;
        } catch (error) {
          logger.warn("ANKOE Detail konnte nicht geladen werden", {
            portal: source.portal,
            id: row.id,
            message: getErrorMessage(error)
          });
        }
      }

      const matchedSearchTerms = getAnkoeMatchedSearchTerms(row, detail, config);
      if (!matchedSearchTerms.length) {
        continue;
      }

      const record = normalizeAnkoeRecord(row, detail, source, config, matchedSearchTerms);

      if (!isOnOrAfter(record.veroeffentlichungsdatum, cutoffDate)) {
        continue;
      }

      if (seen.has(record._recordKey)) {
        continue;
      }

      seen.add(record._recordKey);
      records.push(record);

      if (records.length >= config.runtime.maxRecordsPerPortal) {
        return records;
      }
    }
  }

  return records;
}

function getErrorMessage(error) {
  if (!error) {
    return "Unbekannter Fehler";
  }

  const message = normalizeWhitespace(error.message || error);
  const causeMessage =
    error.cause && typeof error.cause === "object"
      ? normalizeWhitespace(error.cause.message || "")
      : "";

  return causeMessage && !message.includes(causeMessage)
    ? `${message} (cause: ${causeMessage})`
    : message;
}

async function fetchWithCurl(url, config, acceptHeader) {
  const curlCommand = process.platform === "win32" ? "curl.exe" : "curl";
  const args = [
    "-L",
    "--fail",
    "--silent",
    "--show-error",
    "--max-time",
    String(Math.max(5, Math.ceil(config.runtime.requestTimeoutMs / 1000))),
    "-H",
    `Accept: ${acceptHeader}`,
    "-A",
    config.runtime.userAgent
  ];

  if (process.platform === "win32") {
    args.push("--ssl-no-revoke");
  }

  args.push(String(url));

  const { stdout } = await execFileAsync(curlCommand, args, {
    maxBuffer: 10 * 1024 * 1024
  });
  return stdout;
}

async function fetchUspJson(url, config) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), config.runtime.requestTimeoutMs);

  try {
    try {
      const response = await fetch(url, {
        headers: {
          accept: "application/json",
          "user-agent": config.runtime.userAgent
        },
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`USP API status ${response.status}`);
      }

      return response.json();
    } catch {
      return JSON.parse(await fetchWithCurl(url, config, "application/json"));
    }
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function fetchUspText(url, config) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), config.runtime.requestTimeoutMs);

  try {
    try {
      const response = await fetch(url, {
        headers: {
          accept: "text/html,application/xhtml+xml",
          "user-agent": config.runtime.userAgent
        },
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`USP Detail status ${response.status}`);
      }

      return response.text();
    } catch {
      return fetchWithCurl(url, config, "text/html,application/xhtml+xml");
    }
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function fetchTedPage(config, searchTerm, page, cutoffDate) {
  const maxRetries = config.runtime.tedMaxRetries || 3;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), config.runtime.requestTimeoutMs);

    try {
      const response = await fetch(config.ted.baseUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json"
        },
        body: JSON.stringify({
          query: buildTedWeeklyQuery(
            { ...searchTerm, allowedBuyerCountries: config.ted.allowedBuyerCountries },
            cutoffDate
          ),
          fields: config.ted.fields,
          page,
          limit: config.runtime.pageSize,
          scope: config.ted.scope,
          paginationMode: "PAGE_NUMBER"
        }),
        signal: controller.signal
      });

      if (response.status === 429 && attempt < maxRetries) {
        const retryAfterSeconds = Number(response.headers.get("retry-after")) || attempt + 1;
        await sleep(retryAfterSeconds * 1500);
        continue;
      }

      if (!response.ok) {
        throw new Error(`TED API status ${response.status}`);
      }

      const payload = await response.json();
      return payload.notices || [];
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  return [];
}

async function scrapeTed(config, logger, cutoffDate) {
  const records = [];
  const seen = new Set();
  const searchTerms = buildTedSearchTerms(config);
  const maxRecordsPerSearchTerm = Math.max(
    1,
    Math.ceil(config.runtime.maxRecordsPerPortal / Math.max(1, searchTerms.length))
  );

  for (const searchTerm of searchTerms) {
    logger.info("Weekly TED Suche", { searchTerm: searchTerm.value, type: searchTerm.type });
    let recordsForSearchTerm = 0;

    for (let page = 1; page <= config.runtime.maxPagesPerSearch; page += 1) {
      const notices = await fetchTedPage(config, searchTerm, page, cutoffDate);

      if (notices.length === 0) {
        break;
      }

      for (const notice of notices) {
        if (!isOnOrAfter(notice["publication-date"], cutoffDate)) {
          continue;
        }

        if (!tedNoticeMatchesAllowedCountries(notice, config.ted.allowedBuyerCountries)) {
          continue;
        }

        const record = normalizeFeedRecord({
          portal: "TED",
          suchbegriff: searchTerm.displayValue || searchTerm.value,
          titel: pickLocalizedText(notice["notice-title"]),
          auftraggeber: pickLocalizedText(notice["buyer-name"]),
          frist: extractTedDeadline(notice),
          link: extractTedUrl(notice.links),
          cpvCodes: notice["classification-cpv"],
          beschreibung:
            pickLocalizedText(notice["description-proc"]) ||
            pickLocalizedText(notice["description-lot"]),
          veroeffentlichungsdatum: notice["publication-date"],
          organisationLand: countryLabel(
            notice["buyer-country"] || notice["organisation-country-buyer"]
          )
        });

        if (seen.has(record._recordKey)) {
          continue;
        }

        seen.add(record._recordKey);
        records.push(record);
        recordsForSearchTerm += 1;

        if (
          records.length >= config.runtime.maxRecordsPerPortal ||
          recordsForSearchTerm >= maxRecordsPerSearchTerm
        ) {
          break;
        }
      }

      if (
        records.length >= config.runtime.maxRecordsPerPortal ||
        recordsForSearchTerm >= maxRecordsPerSearchTerm
      ) {
        break;
      }

      if (notices.length < config.runtime.pageSize) {
        break;
      }
    }

    await sleep(config.runtime.tedDelayMs || 500);

    if (records.length >= config.runtime.maxRecordsPerPortal) {
          return records;
      }
  }

  return records;
}

async function scrapeUsp(config, logger, cutoffDate) {
  const records = [];
  const seen = new Set();
  let detailCount = 0;
  const pageSize = config.usp.pageSize || USP_DEFAULT_PAGE_SIZE;

  for (const searchTerm of config.searchTerms) {
    logger.info("Weekly USP Suche", {
      searchTerm,
      searchUrl: `${config.usp.url}?q=${encodeURIComponent(searchTerm)}&loaded=true`
    });

    for (let pageNumber = 0; pageNumber < config.runtime.maxPagesPerSearch; pageNumber += 1) {
      const start = pageNumber * pageSize;
      const apiUrl = getUspApiUrl(config, searchTerm, start, pageSize);
      let rows = [];

      try {
        const payload = await fetchUspJson(apiUrl, config);
        rows = Array.isArray(payload.data) ? payload.data : [];
      } catch (error) {
        logger.warn("USP Suche übersprungen", { searchTerm, message: getErrorMessage(error) });
        break;
      }

      if (rows.length === 0) {
        break;
      }

      for (const row of rows) {
        const normalizedRow = normalizeUspApiRow(row, searchTerm, config);
        if (!normalizedRow) {
          continue;
        }

        if (!isOnOrAfter(normalizedRow.veroeffentlichungsdatum, cutoffDate)) {
          continue;
        }

        let detail = { cpvCodes: [], beschreibung: "", organisationLand: USP_DEFAULT_COUNTRY };

        if (detailCount < config.runtime.maxDetailsPerPortal && normalizedRow.link) {
          try {
            const html = await fetchUspText(normalizedRow.link, config);
            detail = extractUspDetailFromHtml(html);
            detailCount += 1;
          } catch (error) {
            logger.warn("USP Detail konnte nicht geladen werden", {
              searchTerm,
              link: normalizedRow.link,
              message: getErrorMessage(error)
            });
          }
        }

        const record = normalizeFeedRecord({
          ...normalizedRow,
          cpvCodes: detail.cpvCodes,
          beschreibung: detail.beschreibung || normalizedRow.beschreibung,
          organisationLand: detail.organisationLand
        });

        if (seen.has(record._recordKey)) {
          continue;
        }

        seen.add(record._recordKey);
        records.push(record);

        if (records.length >= config.runtime.maxRecordsPerPortal) {
          return records;
        }
      }

      if (rows.length < pageSize) {
        break;
      }
    }
  }

  return records;
}

async function ensureParentDirectory(filePath) {
  await fs.mkdir(ensureDirectoryPath(filePath), { recursive: true });
}

function escapeCsvValue(value) {
  const text = Array.isArray(value) ? value.join("; ") : String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

function toCsv(records) {
  const lines = records.map((record) =>
    CSV_HEADERS.map((header) => escapeCsvValue(record[header])).join(",")
  );

  return [CSV_HEADERS.join(","), ...lines].join("\n");
}

async function writeOutputs(records, output) {
  const publicRecords = records.map(({ _recordKey, ...record }) => record);

  for (const filePath of [output.csvPath, output.jsonPath, output.dataJsPath]) {
    await ensureParentDirectory(filePath);
  }

  await fs.writeFile(output.csvPath, `\uFEFF${toCsv(publicRecords)}\n`, "utf8");
  await fs.writeFile(output.jsonPath, JSON.stringify(publicRecords, null, 2), "utf8");
  await fs.writeFile(
    output.dataJsPath,
    `const DATA = ${JSON.stringify(publicRecords, null, 2)};\n`,
    "utf8"
  );
}

async function loadWeeklyConfig(argv) {
  const options = parseArgs(argv);
  const defaultConfigPath = path.resolve(process.cwd(), "config", "default.json");
  const weeklyConfigPath = path.resolve(process.cwd(), options.configPath);
  const defaultConfig = JSON.parse(await fs.readFile(defaultConfigPath, "utf8"));
  const weeklyConfig = JSON.parse(await fs.readFile(weeklyConfigPath, "utf8"));
  const config = mergeConfig(weeklyConfig, {});

  config.cpvCodes = defaultConfig.cpvCodes || [];
  config.cpvLabels = defaultConfig.cpvLabels || {};
  config.searchTerms = unique([
    ...(config.searchTerms || []),
    ...(defaultConfig.keywords || [])
  ]);

  if (options.days) {
    config.maxAgeDays = options.days;
  }

  if (options.sample) {
    config.runtime.maxPagesPerSearch = 1;
    config.runtime.maxRecordsPerPortal = 10;
    config.runtime.maxDetailsPerPortal = 5;
    config.searchTerms = config.searchTerms.slice(0, 3);
    config.cpvCodes = config.cpvCodes.slice(0, 2);
  }

  if (typeof options.headless === "boolean") {
    config.runtime.headless = options.headless;
  }

  config.output = {
    csvPath: path.resolve(process.cwd(), config.output.csvPath),
    jsonPath: path.resolve(process.cwd(), config.output.jsonPath),
    dataJsPath: path.resolve(process.cwd(), config.output.dataJsPath)
  };

  return config;
}

async function main() {
  const logger = createLogger();
  const config = await loadWeeklyConfig(process.argv.slice(2));
  const cutoffDate = calculateCutoffDate(config.maxAgeDays);

  logger.info("Weekly Tender Feed startet", {
    cutoffDate: cutoffDate.toISOString().slice(0, 10),
    searchTerms: config.searchTerms,
    includeCpvSearches: config.includeCpvSearches
  });

  const tedRecords = await scrapeTed(config, logger, cutoffDate);
  const uspRecords = await scrapeUsp(config, logger, cutoffDate);
  const ankoeRecords = await scrapeAnkoeRegional(config, logger, cutoffDate);
  const noeRecords = await scrapeNoe(config, logger, cutoffDate);
  const records = [...tedRecords, ...uspRecords, ...ankoeRecords, ...noeRecords]
    .map((record) => normalizeFeedRecord(record))
    .filter((record, index, allRecords) => allRecords.findIndex((candidate) => candidate._recordKey === record._recordKey) === index);
  const activeRecords = filterExpiredRecords(records)
    .sort((a, b) => b.veroeffentlichungsdatum.localeCompare(a.veroeffentlichungsdatum));
  const previousRecords = await readPreviousRecords(config.output.jsonPath);
  const outputRecords = carryOverReviews(activeRecords, previousRecords);

  await writeOutputs(outputRecords, config.output);

  logger.info("Weekly Tender Feed abgeschlossen", {
    records: outputRecords.length,
    reviewsCarriedOver: outputRecords.filter((record) => record.reviewLabel !== "ungeprueft").length,
    ted: tedRecords.length,
    usp: uspRecords.length,
    ankoeRegional: ankoeRecords.length,
    noe: noeRecords.length,
    csvPath: config.output.csvPath,
    jsonPath: config.output.jsonPath,
    dataJsPath: config.output.dataJsPath
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  ANKOE_SERVICE_CONTRACT_TYPE_ID,
  ankoeRecordMatchesContractType,
  buildUspDetailUrl,
  extractAnkoeCpvCodes,
  extractAnkoeXsrfToken,
  extractNoeRecordsFromHtml,
  extractUspDeadlineFromApiRow,
  extractUspDetailFromHtml,
  calculateCutoffDate,
  carryOverReviews,
  buildTedCountryFilter,
  buildTedWeeklyQuery,
  countryLabel,
  formatCpvSearchTerm,
  getUspApiUrl,
  getAnkoeMatchedSearchTerms,
  getNoeMatchedSearchTerms,
  loadWeeklyConfig,
  markRecordsUnreviewed,
  normalizeFeedRecord,
  normalizeAnkoeRecord,
  normalizeUspApiRow,
  normalizeCpvCode,
  tedNoticeMatchesAllowedCountries,
  parseDate,
  toIsoDate,
  writeOutputs,
  isExpiredDeadline,
  filterExpiredRecords
};


