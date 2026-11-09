#!/usr/bin/env python3
"""Woechentliche Mail mit den neu bewerteten Ausschreibungen.

Laeuft nach der Claude-Bewertung (Sonntag). Nutzt nur die Python-Standardbibliothek.

Was als "neu" zaehlt:
  --before-file <data.json>   Vorheriger Stand. Neu = jetzt "passt gut"/"pruefen",
                              vorher nicht (oder noch nicht vorhanden).
  --since-days <n>            Ohne Vorstand: Neu = reviewedAt in den letzten n Tagen.

Versand ueber SMTP (Umgebungsvariablen):
  MAIL_SERVER, MAIL_PORT (587 = STARTTLS, 465 = SSL), MAIL_USER, MAIL_PASSWORD,
  MAIL_FROM (optional, sonst MAIL_USER), MAIL_TO (kommagetrennt)

Mit --dry-run wird nichts gesendet; Betreff, Text und HTML werden nur in --out-dir geschrieben.
Mit --skip-if-empty wird bei keinem neuen Treffer keine Mail gesendet (Exit 0).
"""
from __future__ import annotations

import argparse
import html
import json
import os
import smtplib
import ssl
import sys
from datetime import date, datetime, timedelta, timezone
from email.message import EmailMessage
from pathlib import Path

DASHBOARD_URL = "https://meccaconsulting.github.io/mecca-dashboard/"
RELEVANT = ("passt gut", "pruefen")
LABEL_DISPLAY = {"passt gut": "passt gut", "pruefen": "prüfen"}
NO_DEADLINE_YEAR = 2090  # Platzhalter wie 2099-12-31 = keine Frist angegeben
MAX_GOOD = 15
MAX_CHECK = 10


def load(path: Path) -> list[dict]:
    return json.loads(path.read_text(encoding="utf-8"))


def parse_dt(value: str) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def deadline(rec: dict) -> date | None:
    dt = parse_dt(rec.get("frist", ""))
    if dt is None or dt.year >= NO_DEADLINE_YEAR:
        return None
    return dt.date()


def is_open(rec: dict, today: date) -> bool:
    d = deadline(rec)
    return d is None or d >= today


def select_new(current, before, since_days, today):
    if before is not None:
        old = {r["recordKey"]: r.get("reviewLabel") for r in before}
        return [
            r for r in current
            if r.get("reviewLabel") in RELEVANT
            and old.get(r["recordKey"]) not in RELEVANT
        ]
    limit = datetime.now(timezone.utc) - timedelta(days=since_days)
    return [
        r for r in current
        if r.get("reviewLabel") in RELEVANT
        and (parse_dt(r.get("reviewedAt", "")) or datetime.min.replace(tzinfo=timezone.utc)) >= limit
    ]


def fmt_deadline(rec: dict) -> str:
    d = deadline(rec)
    return d.strftime("%d.%m.%Y") if d else "keine Frist angegeben"


def build_recommendations(good, check, today):
    """Regelbasierte Hinweise aus den Daten (keine KI)."""
    tips = []
    soon = sorted(
        (r for r in good + check if deadline(r) and (deadline(r) - today).days <= 14),
        key=lambda r: deadline(r),
    )
    if soon:
        r = soon[0]
        days = (deadline(r) - today).days
        tips.append(
            f"Zuerst ansehen, weil die Frist knapp ist: {len(soon)} Treffer enden innerhalb von 14 Tagen, "
            f"der früheste am {fmt_deadline(r)} (in {days} Tagen): „{r['titel'][:90]}“."
        )
    if good:
        tips.append(
            f"{len(good)} Treffer sind als „passt gut“ bewertet. Sie sind die erste Wahl für eine "
            "Entscheidung über ein Angebot; die Begründung der Bewertung steht jeweils dabei."
        )
    if check:
        tips.append(
            f"{len(check)} Treffer sind „prüfen“: fachlich nur teilweise passend. Ein kurzer Blick in die "
            "Ausschreibungsunterlagen klärt, ob sich ein Angebot lohnt."
        )
    foreign = sorted({r.get("organisationLand", "") for r in good + check} - {"Österreich", ""})
    if foreign:
        tips.append(
            "Darunter sind Auftraggeber außerhalb Österreichs (" + ", ".join(foreign) + "). "
            "Bei Sprache und Teilnahmebedingungen vorab prüfen, ob ein Angebot realistisch ist."
        )
    return tips


def build_mail(new, all_records, today):
    good = sorted((r for r in new if r["reviewLabel"] == "passt gut" and is_open(r, today)),
                  key=lambda r: (deadline(r) or date.max))
    check = sorted((r for r in new if r["reviewLabel"] == "pruefen" and is_open(r, today)),
                   key=lambda r: (deadline(r) or date.max))
    open_total = sum(1 for r in all_records if r.get("reviewLabel") in RELEVANT and is_open(r, today))
    kw = today.isocalendar().week

    headline = (
        f"{len(good) + len(check)} neue relevante Ausschreibungen: "
        f"{len(good)} „passt gut“, {len(check)} „prüfen“."
        if good or check else "Diese Woche gibt es keine neuen relevanten Ausschreibungen."
    )
    overview = (
        f"Im Dashboard stehen insgesamt {open_total} offene Ausschreibungen mit der Bewertung "
        "„passt gut“ oder „prüfen“."
    )
    tips = build_recommendations(good, check, today)
    subject = f"Ausschreibungen KW {kw}: {len(good)} passt gut, {len(check)} prüfen"

    # ---- Klartext ----
    lines = [headline, overview, "", f"Dashboard: {DASHBOARD_URL}", ""]
    if tips:
        lines += ["Empfehlungen:"] + [f"- {t}" for t in tips] + [""]
    for title, items, cap in (("Passt gut", good, MAX_GOOD), ("Prüfen", check, MAX_CHECK)):
        if items:
            lines.append(f"{title} ({len(items)}):")
            for r in items[:cap]:
                lines.append(f"* {r['titel']}")
                lines.append(f"  {r['auftraggeber']} | Frist: {fmt_deadline(r)}")
                if r.get("reviewReason"):
                    lines.append(f"  Bewertung: {r['reviewReason']}")
                lines.append(f"  {r['link']}")
            if len(items) > cap:
                lines.append(f"  … und {len(items) - cap} weitere im Dashboard.")
            lines.append("")
    lines.append("Automatisch erzeugt von mecca consulting (Ausschreibungsscreening). "
                 "Die Bewertung stammt aus der KI-Vorprüfung und ersetzt keine fachliche Durchsicht.")
    text = "\n".join(lines)

    # ---- HTML ----
    e = html.escape

    def block(title, items, cap, color):
        if not items:
            return ""
        rows = []
        for r in items[:cap]:
            reason = f'<div style="color:#6b6256;font-size:13px;margin-top:2px">{e(r["reviewReason"])}</div>' \
                if r.get("reviewReason") else ""
            rows.append(
                f'<tr><td style="padding:8px 0;border-bottom:1px solid #e8dcc8">'
                f'<a href="{e(r["link"])}" style="color:#2f6b45;font-weight:600;text-decoration:none">{e(r["titel"])}</a>'
                f'<div style="font-size:13px;color:#3a3530">{e(r["auftraggeber"])} · Frist: {e(fmt_deadline(r))}</div>'
                f'{reason}</td></tr>'
            )
        more = (f'<p style="font-size:13px;color:#6b6256">… und {len(items) - cap} weitere im Dashboard.</p>'
                if len(items) > cap else "")
        return (f'<h3 style="margin:22px 0 6px;color:{color};font-size:16px">{e(title)} ({len(items)})</h3>'
                f'<table role="presentation" width="100%" cellspacing="0" cellpadding="0">{"".join(rows)}</table>{more}')

    tips_html = ""
    if tips:
        tips_html = ('<h3 style="margin:22px 0 6px;font-size:16px">Empfehlungen</h3><ul style="padding-left:18px;margin:0">'
                     + "".join(f'<li style="margin-bottom:6px">{e(t)}</li>' for t in tips) + "</ul>")

    body_html = f"""<!DOCTYPE html>
<html lang="de"><body style="margin:0;background:#f4f0e8;font-family:'Segoe UI',Arial,sans-serif;color:#3a3530">
<div style="max-width:680px;margin:0 auto;padding:20px">
<div style="background:#fffef9;border:1px solid #e8dcc8;border-radius:12px;padding:24px">
<p style="margin:0 0 4px;font-size:13px;color:#8a7e6f">Ausschreibungsscreening · KW {kw}/{today.year}</p>
<p style="margin:0 0 10px;font-size:19px;font-weight:700;line-height:1.35">{e(headline)}</p>
<p style="margin:0 0 16px">{e(overview)}</p>
<p style="margin:0 0 4px"><a href="{DASHBOARD_URL}" style="display:inline-block;background:#5ba872;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Zum mecca Dashboard</a></p>
{tips_html}
{block("Passt gut", good, MAX_GOOD, "#2f6b45")}
{block("Prüfen", check, MAX_CHECK, "#8a6d1f")}
<p style="margin:26px 0 0;font-size:12px;color:#8a7e6f">Automatisch erzeugt von mecca consulting. Die Bewertung stammt aus der KI-Vorprüfung und ersetzt keine fachliche Durchsicht.</p>
</div></div></body></html>"""
    return subject, text, body_html, len(good) + len(check)


def send(subject, text, body_html):
    server = os.environ["MAIL_SERVER"]
    port = int(os.environ.get("MAIL_PORT") or "587")
    user = os.environ["MAIL_USER"]
    password = os.environ["MAIL_PASSWORD"]
    sender = os.environ.get("MAIL_FROM") or user
    recipients = [a.strip() for a in os.environ["MAIL_TO"].split(",") if a.strip()]

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = sender
    msg["To"] = ", ".join(recipients)
    msg.set_content(text)
    msg.add_alternative(body_html, subtype="html")

    ctx = ssl.create_default_context()
    if port == 465:
        with smtplib.SMTP_SSL(server, port, context=ctx, timeout=60) as s:
            s.login(user, password)
            s.send_message(msg)
    else:
        with smtplib.SMTP(server, port, timeout=60) as s:
            s.starttls(context=ctx)
            s.login(user, password)
            s.send_message(msg)
    print(f"Mail gesendet an {len(recipients)} Empfaenger.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="dash/data.json")
    ap.add_argument("--before-file")
    ap.add_argument("--since-days", type=int, default=7)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--skip-if-empty", action="store_true")
    ap.add_argument("--out-dir", default="mail_preview")
    ap.add_argument("--today", help="JJJJ-MM-TT, nur fuer Tests")
    args = ap.parse_args()

    today = date.fromisoformat(args.today) if args.today else datetime.now(timezone.utc).date()
    current = load(Path(args.data))
    before = load(Path(args.before_file)) if args.before_file else None
    new = select_new(current, before, args.since_days, today)
    subject, text, body_html, count = build_mail(new, current, today)

    if count == 0 and args.skip_if_empty:
        print("Keine neuen relevanten Treffer, keine Mail.")
        return 0

    if args.dry_run:
        out = Path(args.out_dir)
        out.mkdir(parents=True, exist_ok=True)
        (out / "mail.txt").write_text(f"Betreff: {subject}\n\n{text}", encoding="utf-8")
        (out / "mail.html").write_text(body_html, encoding="utf-8")
        print(f"Vorschau geschrieben nach {out}/ ({count} Treffer). Betreff: {subject}")
        return 0

    send(subject, text, body_html)
    return 0


if __name__ == "__main__":
    sys.exit(main())
